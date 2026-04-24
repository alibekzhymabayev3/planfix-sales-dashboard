import httpx
import json
import os
import asyncio
from datetime import datetime

# Field mappings for Datatag 38590
FIELD_MATERIAL = 148108   # "Материал" (ПВХ, Алюминий: ОДС, ...)
FIELD_M2 = 148110         # "Объем, кв.м."
FIELD_SUM = 148120        # "Итого стоимость по договору, тг."
FIELD_DATE = 148122       # "Дата оплаты аванса"
FIELD_SIGNED = 144422     # "Договор подписан" (Поле задачи, тип Список)

async def get_tasks_signed_status(client, tasks_ids, headers, account):
    """
    Individual fetch of task 'Signed' status to ensure 100% reliability.
    Uses a semaphore to avoid API rate limits.
    """
    if not tasks_ids:
        return {}
    
    status_map = {}
    semaphore = asyncio.Semaphore(3) # Max 3 concurrent requests
    
    async def check_task(t_id):
        t_id_str = str(t_id)
        url = f'https://{account}.planfix.com/rest/task/{t_id_str}?fields=id,customFieldData,144422'
        async with semaphore:
            try:
                # We'll put a small delay to be safe
                await asyncio.sleep(0.05) 
                res = await client.get(url, headers=headers)
                if res.status_code == 200:
                    task_data = res.json().get('task', {})
                    is_signed = False
                    for cf in task_data.get('customFieldData', []):
                        if cf['field']['id'] == FIELD_SIGNED:
                            val = str(cf.get('stringValue') or cf.get('value') or "").strip()
                            if val == "Да":
                                is_signed = True
                            break
                    return t_id_str, is_signed
                else:
                    print(f"DEBUG: Task {t_id_str} returned {res.status_code}")
                    return t_id_str, False
            except Exception as e:
                print(f"DEBUG: Error checking task {t_id_str}: {e}")
                return t_id_str, False

    tasks_to_check = list(set(tasks_ids))
    print(f"DEBUG: Checking 'Signed' status for {len(tasks_to_check)} tasks individually...")
    
    results = await asyncio.gather(*(check_task(tid) for tid in tasks_to_check))
    for t_id, signed in results:
        status_map[t_id] = signed
        
    return status_map

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
        url_an = f'https://{account}.planfix.com/rest/datatag/38590/entry/list'
        all_entries = []
        offset = 0
        while True:
            payload_an = {
                "offset": offset,
                "pageSize": 100,
                "fields": "id,task,customFieldData,148108,148110,148120,148122"
            }
            res_an = await client.post(url_an, headers=headers, json=payload_an)
            if res_an.status_code != 200:
                print(f"ERROR: Analytic API returned {res_an.status_code}")
                break
            
            entries = res_an.json().get('dataTagEntries', [])
            if not entries: break
            all_entries.extend(entries)
            offset += 100
            if len(entries) < 100: break

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
        signed_status_map = await get_tasks_signed_status(client, list(task_ids_to_check), headers, account)
        
        # 4. Final filter and aggregation
        aggregated = {}
        for entry in relevant_entries:
            t_id = str(entry.get('task', {}).get('id'))
            if not signed_status_map.get(t_id):
                continue

            cfd = entry.get("customFieldData", [])
            material = "Прочее"
            m2 = 0.0
            total_sum = 0.0
            month = None
            
            for field in cfd:
                f_id = field['field']['id']
                if f_id == 148108:  # Материал
                    val = field.get("stringValue", "Прочее") or "Прочее"
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
    return aggregated
    
