import httpx
import json
import os
import time
import asyncio
from datetime import datetime

# Field mappings for Datatag 38590
FIELD_MATERIAL = 148108   # "Материал" (ПВХ, Алюминий: ОДС, ...)
FIELD_M2 = 148110         # "Объем, кв.м."
FIELD_SUM = 148120        # "Итого стоимость по договору, тг."
FIELD_DATE = 148122       # "Дата оплаты аванса"
FIELD_SIGNED = 144422     # "Договор подписан" (Поле задачи, тип Список)
FIELD_PROBABILITY = 148320  # "Вероятность заключения (%)" (Datatag 38590, тип Number)
FIELD_ADVANCE_PCT = 148116  # "Размер аванса, %" (Datatag 38590, тип Number)
FIELD_ADVANCE_SUM = 148118  # "Размер аванса, тг" (Datatag 38590, тип Calc)

# Процессы, входящие в отчёт «Воронка вероятности» 764900
FUNNEL_PROCESS_IDS = {268814, 268846, 268960, 268958}

MONTHS_RU = [
    "", "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
]

# Светофор вероятности: (нижняя_граница, ключ, подпись, порядок сортировки)
PROBABILITY_BUCKETS = [
    (80, "b1", "80–100%", 0),
    (60, "b2", "60–79%", 1),
    (40, "b3", "40–59%", 2),
    (20, "b4", "20–39%", 3),
    (0,  "b5", "0–19%", 4),
]
NO_PROBABILITY_BUCKET = ("b0", "Без вероятности", 5)


def probability_bucket(probability):
    """Возвращает (key, label, order) для числа вероятности (или None)."""
    if probability is None:
        return NO_PROBABILITY_BUCKET
    for lower, key, label, order in PROBABILITY_BUCKETS:
        if probability >= lower:
            return (key, label, order)
    return NO_PROBABILITY_BUCKET

# Поля задачи, которых нет в аналитике 38590. Один набор на оба отчёта (факт + воронка),
# чтобы не ходить за одной и той же задачей дважды за цикл обновления.
TASK_INFO_FIELDS = "id,name,project,counterparty,processId,144422"

# Факт и воронка обновляются подряд (см. app.py:_refresh_fact_then_funnel), поэтому
# результаты тяжёлых чтений переиспользуются в пределах одного цикла.
CYCLE_TTL = 300.0
_entries_cache = {"ts": 0.0, "entries": None}
_task_info_cache = {"ts": 0.0, "info": {}}


def _cache_fresh(cache):
    return cache["ts"] and (time.monotonic() - cache["ts"]) < CYCLE_TTL


async def get_tasks_info(client, tasks_ids, headers, account):
    """
    Данные уровня задачи, которых нет в аналитике: статус «Договор подписан» (144422),
    контрагент, проект, процесс. Возвращает
    {t_id_str: {"signed","customer","project","processId"}}.

    Один запрос на задачу на ОБА отчёта: раньше факт и воронка тянули одну и ту же
    задачу по отдельности (две выборки полей) — это удваивало расход лимита API.
    """
    if not tasks_ids:
        return {}

    wanted = {str(t) for t in tasks_ids}
    if _cache_fresh(_task_info_cache):
        cached = _task_info_cache["info"]
        if wanted <= set(cached):
            print(f"DEBUG: task info for {len(wanted)} tasks taken from cycle cache")
            return {t: cached[t] for t in wanted}

    info_map = {}
    semaphore = asyncio.Semaphore(25)

    async def check_task(t_id_str):
        url = f'https://{account}.planfix.com/rest/task/{t_id_str}?fields={TASK_INFO_FIELDS}'
        empty = {"signed": False, "customer": "", "project": "", "processId": None}
        async with semaphore:
            try:
                res = await client.get(url, headers=headers)
                if res.status_code != 200:
                    print(f"DEBUG: Task {t_id_str} returned {res.status_code}")
                    return t_id_str, empty
                task_data = res.json().get('task', {})
                signed = False
                for cf in task_data.get('customFieldData', []):
                    if cf['field']['id'] == FIELD_SIGNED:
                        val = str(cf.get('stringValue') or cf.get('value') or "").strip()
                        signed = (val == "Да")
                        break
                raw_pid = task_data.get('processId')
                try:
                    process_id = int(raw_pid) if raw_pid is not None else None
                except (TypeError, ValueError):
                    process_id = None
                return t_id_str, {
                    "signed": signed,
                    "customer": (task_data.get('counterparty') or {}).get('name', "") or "",
                    "project": (task_data.get('project') or {}).get('name', "") or "",
                    "processId": process_id,
                }
            except Exception as e:
                print(f"DEBUG: Error checking task {t_id_str}: {e}")
                return t_id_str, empty

    print(f"DEBUG: Fetching task info for {len(wanted)} tasks...")
    results = await asyncio.gather(*(check_task(t) for t in wanted))
    for t_id, info in results:
        info_map[t_id] = info

    _task_info_cache["info"] = dict(info_map)
    _task_info_cache["ts"] = time.monotonic()
    return info_map


async def fetch_all_analytic_entries(client, account, headers, fields, datatag_id=38590, log_prefix=""):
    """
    Общий helper для волновой (параллельной по 10 страниц) пагинации
    /rest/datatag/{datatag_id}/entry/list. Возвращает плоский список всех entries.
    Список полей (fields) и вся дальнейшая обработка — на совести вызывающей стороны.
    """
    url = f'https://{account}.planfix.com/rest/datatag/{datatag_id}/entry/list'

    async def fetch_page(off):
        res = await client.post(url, headers=headers,
                                json={"offset": off, "pageSize": 100, "fields": fields})
        if res.status_code != 200:
            print(f"ERROR: {log_prefix}Analytic API returned {res.status_code}")
            return []
        return res.json().get('dataTagEntries', [])

    all_entries = []
    page = 0
    WAVE = 5          # меньше волна — меньше холостых страниц после конца данных
    while True:
        offsets = [(page + i) * 100 for i in range(WAVE)]
        pages = await asyncio.gather(*(fetch_page(o) for o in offsets))
        for entries in pages:
            all_entries.extend(entries)
        if any(len(entries) < 100 for entries in pages):
            break          # достигли конца (есть неполная/пустая страница)
        page += WAVE
    return all_entries


# Объединённый набор полей аналитики: факт и воронка берут из 38590 разные колонки,
# но сам справочник один — читаем его за один проход на цикл, а не дважды.
ANALYTIC_FIELDS = ("id,task,customFieldData,"
                   "148108,148110,148120,148122,148320,148116,148118")


async def get_analytic_entries(client, account, headers, log_prefix=""):
    """Строки аналитики 38590 с кэшем на цикл обновления (см. CYCLE_TTL)."""
    if _cache_fresh(_entries_cache) and _entries_cache["entries"] is not None:
        print(f"DEBUG: {log_prefix}analytic entries taken from cycle cache "
              f"({len(_entries_cache['entries'])})")
        return _entries_cache["entries"]
    entries = await fetch_all_analytic_entries(client, account, headers,
                                               ANALYTIC_FIELDS, log_prefix=log_prefix)
    _entries_cache["entries"] = entries
    _entries_cache["ts"] = time.monotonic()
    return entries


def load_config():
    root_path = os.path.dirname(__file__)
    config_path = os.path.join(root_path, 'config.json')
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)

async def fetch_planfix_fact():
    config = load_config()
    token = config["planfix_api_token"]
    account = config["planfix_account"]
    signed_field_id = config.get("signed_field_id", FIELD_SIGNED)
    
    headers = {
        'Authorization': f'Bearer {token}',
        'Account': account,
        'Content-Type': 'application/json'
    }
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        # 1. Fetch ALL analytic entries for 38590
        print("DEBUG: Fetching all analytic entries from datatag 38590...")
        all_entries = await get_analytic_entries(client, account, headers)

        print(f"DEBUG: Found {len(all_entries)} analytic entries total.")

        # 2. CASCADE: Filter entries by Year 2026 FIRST to reduce tasks-to-check
        relevant_entries = []
        task_ids_to_check = set()
        
        for entry in all_entries:
            # Extract month/year to see if it's relevant for 2026
            entry_year = None
            for cf in entry.get('customFieldData', []):
                if cf['field']['id'] == 148122:  # Дата
                    ds = cf.get("stringValue")
                    if ds:
                        sep = "-" if "-" in ds else "."
                        parts = ds.split(sep)
                        if len(parts) == 3:
                            try:
                                if len(parts[0]) == 4: entry_year = int(parts[0])
                                else: entry_year = int(parts[2])
                            except: pass
            
            if entry_year == 2026:
                relevant_entries.append(entry)
                t_id = entry.get('task', {}).get('id')
                if t_id:
                    task_ids_to_check.add(t_id)

        print(f"DEBUG: CASCADE: {len(relevant_entries)} entries in 2026 referring to {len(task_ids_to_check)} unique tasks.")

        # 3. Targeted check of "Signed" status ONLY for tasks in 2026
        signed_status_map = await get_tasks_info(client, list(task_ids_to_check), headers, account)
        
        # 4. Final filter and aggregation
        aggregated = {}
        # details[month][material] = [ {task_id, task_name, m2, sum, date}, ... ]
        # — построчная детализация, из которой складывается каждая ячейка факта (для drill-down)
        details = {}
        for entry in relevant_entries:
            t_id = str(entry.get('task', {}).get('id'))
            info = signed_status_map.get(t_id)
            if not (info and info.get("signed")):
                continue

            t_name = entry.get('task', {}).get('name') or f"Задача {t_id}"
            customer = info.get("customer", "") if info else ""

            cfd = entry.get("customFieldData", [])
            material = "Прочее"
            material_raw = ""
            m2 = 0.0
            total_sum = 0.0
            month = None
            date_str = ""

            for field in cfd:
                f_id = field['field']['id']
                if f_id == 148108:  # Материал
                    val = field.get("stringValue", "Прочее") or "Прочее"
                    material_raw = val
                    m_lower = val.lower()
                    if "алюминий" in m_lower or "алюм" in m_lower: material = "Алюм"
                    elif "венти" in m_lower or "нвф" in m_lower: material = "НВФ"
                    elif "стеклопакет" in m_lower or "сп" in m_lower: material = "СП"
                    elif "пвх" in m_lower: material = "ПВХ"
                elif f_id == 148110:  # Объем
                    try: m2 = float(field.get("value") or 0.0)
                    except: m2 = 0.0
                elif f_id == 148120:  # Сумма
                    try: total_sum = float(field.get("value") or 0.0)
                    except: total_sum = 0.0
                elif f_id == 148122:  # Дата
                    ds = field.get("stringValue")
                    if ds:
                        date_str = ds
                        sep = "-" if "-" in ds else "."
                        parts = ds.split(sep)
                        if len(parts) == 3:
                            try:
                                month = int(parts[1])
                            except: pass

            if month:
                if month not in aggregated: aggregated[month] = {}
                if material not in aggregated[month]: aggregated[month][material] = {"m2": 0.0, "sum": 0.0}
                aggregated[month][material]["m2"] += m2
                aggregated[month][material]["sum"] += total_sum

                mkey = str(month)
                details.setdefault(mkey, {}).setdefault(material, []).append({
                    "task_id": t_id,
                    "task_name": t_name,
                    "customer": customer,
                    "material_raw": material_raw,
                    "m2": m2,
                    "sum": total_sum,
                    "date": date_str,
                })

        # 5. Calculate derived СП (m2) based on formula: (Алюм + ПВХ) * 0.8
        for month in aggregated:
            m_data = aggregated[month]
            alum_m2 = m_data.get("Алюм", {}).get("m2", 0.0)
            pvc_m2 = m_data.get("ПВХ", {}).get("m2", 0.0)
            
            derived_sp_m2 = (alum_m2 + pvc_m2) * 0.8
            
            if "СП" not in m_data:
                m_data["СП"] = {"m2": 0.0, "sum": 0.0}
            
            # We overwrite the m2 with the derived value, but keep the sum if any
            m_data["СП"]["m2"] = derived_sp_m2

    print(f"DEBUG: Final CASCADE Aggregation: {aggregated}")
    return {"aggregated": aggregated, "details": details}


async def fetch_probability_funnel():
    """
    Данные для вкладки «Воронка вероятности» (реконструкция отчёта 764900):
    строки аналитики 38590, отфильтрованные по объёму>0, году оплаты аванса==2026
    и принадлежности задачи к процессам FUNNEL_PROCESS_IDS.

    REST-генерация самого отчёта 764900 заблокирована тарифом (report/generate ->
    9001 Report billing error), поэтому данные собираются вручную из аналитики +
    добора полей задачи (project/counterparty/processId), которых нет в аналитике.

    Возвращает плоский список записей — группировка месяц->цвет->задачи делается
    на фронтенде (одна задача может дать несколько строк по разным материалам).
    """
    config = load_config()
    token = config["planfix_api_token"]
    account = config["planfix_account"]

    headers = {
        'Authorization': f'Bearer {token}',
        'Account': account,
        'Content-Type': 'application/json'
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        # 1. Fetch all analytic entries for 38590 (поля перечислены явно — иначе
        #    customFieldData у этого dataTag приходит пустым).
        print("DEBUG: [funnel] Fetching all analytic entries from datatag 38590...")
        all_entries = await get_analytic_entries(client, account, headers, log_prefix="[funnel] ")

        print(f"DEBUG: [funnel] Found {len(all_entries)} analytic entries total.")

        # 2. Parse each entry, keep only m2>0 and year(148122)==2026.
        parsed_entries = []
        task_ids_to_check = set()

        for entry in all_entries:
            t_id = entry.get('task', {}).get('id')
            if not t_id:
                continue
            t_name = entry.get('task', {}).get('name') or f"Задача {t_id}"

            cfd = entry.get("customFieldData", [])
            material_raw = ""
            m2 = 0.0
            total_sum = 0.0
            month = None
            year = None
            date_str = ""
            probability = None
            advance_pct = None
            advance_sum = 0.0

            for field in cfd:
                f_id = field['field']['id']
                if f_id == FIELD_MATERIAL:
                    material_raw = field.get("stringValue") or ""
                elif f_id == FIELD_M2:
                    try: m2 = float(field.get("value") or 0.0)
                    except (TypeError, ValueError): m2 = 0.0
                elif f_id == FIELD_SUM:
                    val = field.get("value")
                    if val is None:
                        val = field.get("stringValue")
                    try: total_sum = float(val) if val not in (None, "") else 0.0
                    except (TypeError, ValueError): total_sum = 0.0
                elif f_id == FIELD_DATE:
                    ds = field.get("stringValue")
                    if ds:
                        date_str = ds
                        sep = "-" if "-" in ds else "."
                        parts = ds.split(sep)
                        if len(parts) == 3:
                            try:
                                if len(parts[0]) == 4:
                                    year = int(parts[0]); month = int(parts[1])
                                else:
                                    month = int(parts[1]); year = int(parts[2])
                            except (TypeError, ValueError):
                                pass
                elif f_id == FIELD_PROBABILITY:
                    val = field.get("value")
                    if val is None:
                        val = field.get("stringValue")
                    try:
                        probability = float(val) if val not in (None, "") else None
                    except (TypeError, ValueError):
                        probability = None
                elif f_id == FIELD_ADVANCE_PCT:
                    val = field.get("value")
                    if val is None:
                        val = field.get("stringValue")
                    try:
                        advance_pct = float(val) if val not in (None, "") else None
                    except (TypeError, ValueError):
                        advance_pct = None
                elif f_id == FIELD_ADVANCE_SUM:
                    val = field.get("value")
                    if val is None:
                        val = field.get("stringValue")
                    try:
                        advance_sum = float(val) if val not in (None, "") else 0.0
                    except (TypeError, ValueError):
                        advance_sum = 0.0

            if m2 > 0 and year == 2026:
                parsed_entries.append({
                    "task_id": str(t_id),
                    "task_name": t_name,
                    "material": material_raw,
                    "m2": m2,
                    "sum": total_sum,
                    "date": date_str,
                    "month": month,
                    "probability": probability,
                    "advance_pct": advance_pct,
                    "advance_sum": advance_sum,
                })
                task_ids_to_check.add(t_id)

        print(f"DEBUG: [funnel] {len(parsed_entries)} entries with m2>0 in 2026, "
              f"{len(task_ids_to_check)} unique tasks to check.")

        # 3. Add task-level fields (project/counterparty/processId) not in the analytic.
        task_info_map = await get_tasks_info(client, list(task_ids_to_check), headers, account)

        # 4. Final filter by process (as report 764900) + assemble output rows.
        result = []
        for e in parsed_entries:
            info = task_info_map.get(e["task_id"], {})
            process_id = info.get("processId")
            if process_id not in FUNNEL_PROCESS_IDS:
                continue
            if not e["month"]:
                continue

            bucket_key, bucket_label, bucket_order = probability_bucket(e["probability"])

            result.append({
                "task_id": e["task_id"],
                "task_name": e["task_name"],
                "customer": info.get("customer", ""),
                "project": info.get("project", ""),
                "material": e["material"],
                "m2": e["m2"],
                "sum": e["sum"],
                "advance_pct": e["advance_pct"],
                "advance_sum": e["advance_sum"],
                "date": e["date"],
                "month": e["month"],
                "month_label": f"{MONTHS_RU[e['month']]} 2026",
                "probability": e["probability"],
                "bucket": bucket_key,
                "bucket_label": bucket_label,
                "bucket_order": bucket_order,
            })

    print(f"DEBUG: [funnel] Final result: {len(result)} rows.")
    return result
    
