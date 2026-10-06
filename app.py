from flask import Flask, jsonify
import json
import os
import time
import asyncio
import datetime
import threading
from planfix_api import fetch_planfix_fact, fetch_probability_funnel, load_config

app = Flask(__name__, static_folder='static', static_url_path='')

# Аккаунт Planfix для построения ссылок на задачи на фронте (вместо хардкода домена).
PLANFIX_ACCOUNT = load_config().get("planfix_account", "tehnovid")

DATA_CACHE = {
    "planfix_fact": None,
    "planfix_details": None,
    "last_sync": None
}

# Отдельный кэш для вкладки v4 «Воронка вероятности» — не пересекается с planfix_fact
FUNNEL_CACHE = {
    "entries": None,
    "last_sync": None
}

# Обновление Planfix-факта вынесено в фон, чтобы браузер не держал долгий запрос
# (внешние/корпоративные прокси рвут соединение на ~15с). Кнопка «Обновить» отвечает
# мгновенно, данные подтягиваются в фоне, фронт опрашивает /api/data.
_refresh_lock = threading.Lock()
_refreshing = {"active": False}

_funnel_refresh_lock = threading.Lock()
_funnel_refreshing = {"active": False}


def _do_refresh():
    try:
        result = asyncio.run(fetch_planfix_fact())
        # обратная совместимость: раньше возвращался просто aggregated-словарь
        if isinstance(result, dict) and "aggregated" in result and "details" in result:
            DATA_CACHE["planfix_fact"] = result["aggregated"]
            DATA_CACHE["planfix_details"] = result["details"]
        else:
            DATA_CACHE["planfix_fact"] = result
            DATA_CACHE["planfix_details"] = {}
        DATA_CACHE["last_sync"] = datetime.datetime.now().strftime("%d.%m.%Y %H:%M:%S")
    except Exception as e:
        print(f"Refresh failed: {e}")
    finally:
        _refreshing["active"] = False


def start_refresh():
    """Запускает фоновое обновление, если оно ещё не идёт. True — запущено сейчас."""
    with _refresh_lock:
        if _refreshing["active"]:
            return False
        _refreshing["active"] = True
    threading.Thread(target=_do_refresh, daemon=True).start()
    return True


def _do_funnel_refresh():
    try:
        FUNNEL_CACHE["entries"] = asyncio.run(fetch_probability_funnel())
        FUNNEL_CACHE["last_sync"] = datetime.datetime.now().strftime("%d.%m.%Y %H:%M:%S")
    except Exception as e:
        print(f"Funnel refresh failed: {e}")
    finally:
        _funnel_refreshing["active"] = False


def start_funnel_refresh():
    """Запускает фоновое обновление воронки, если оно ещё не идёт. True — запущено сейчас."""
    with _funnel_refresh_lock:
        if _funnel_refreshing["active"]:
            return False
        _funnel_refreshing["active"] = True
    threading.Thread(target=_do_funnel_refresh, daemon=True).start()
    return True


def _refresh_fact_then_funnel():
    """Запускает факт и воронку ПОСЛЕДОВАТЕЛЬНО, чтобы не создавать пиковую нагрузку
    на Planfix API двумя параллельными полными сканами + 2×25 per-task запросов разом."""
    start_refresh()
    while _refreshing["active"]:
        time.sleep(0.5)
    start_funnel_refresh()


# Автообновление — только в рабочее время (сервер живёт в Asia/Almaty): ночью и в
# воскресенье данные всё равно никто не смотрит, а каждый цикл стоит ~170 запросов
# к Planfix. Кнопка «Обновить» работает всегда.
REFRESH_HOUR_FROM = int(os.environ.get("REFRESH_HOUR_FROM", "7"))
REFRESH_HOUR_TO = int(os.environ.get("REFRESH_HOUR_TO", "20"))
REFRESH_WEEKDAYS = {0, 1, 2, 3, 4, 5}      # пн–сб


def _in_working_hours(now=None):
    now = now or datetime.datetime.now()
    return (now.weekday() in REFRESH_WEEKDAYS
            and REFRESH_HOUR_FROM <= now.hour < REFRESH_HOUR_TO)


def _periodic_refresh():
    while True:
        time.sleep(1800)  # шаг автообновления — 30 минут
        if _in_working_hours():
            _refresh_fact_then_funnel()


@app.after_request
def _no_cache(resp):
    resp.headers["Cache-Control"] = "no-store, must-revalidate"
    return resp


@app.route('/')
def serve_index():
    return app.send_static_file('index.html')


@app.route('/api/data')
def get_data():
    try:
        root_path = os.path.dirname(__file__)
        json_path = os.path.join(root_path, 'excel_structure.json')
        with open(json_path, 'r', encoding='utf-8') as f:
            excel_data = json.load(f)

        import math

        def sanitize_data(val):
            if isinstance(val, float) and math.isnan(val):
                return None
            elif isinstance(val, list):
                return [sanitize_data(v) for v in val]
            elif isinstance(val, dict):
                return {k: sanitize_data(v) for k, v in val.items()}
            return val

        sheet_data = sanitize_data(excel_data.get('Расчет объема по месяцам', []))

        # если факт ещё не загружен — запускаем фоновую загрузку (не блокируем ответ)
        if DATA_CACHE["planfix_fact"] is None:
            start_refresh()

        return jsonify({
            "excel_sheet": sheet_data,
            "planfix_fact": DATA_CACHE["planfix_fact"] or {},
            "planfix_details": DATA_CACHE["planfix_details"] or {},
            "last_sync": DATA_CACHE["last_sync"],
            "refreshing": _refreshing["active"],
            "account": PLANFIX_ACCOUNT
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/sync', methods=['POST'])
def sync_data():
    started = start_refresh()
    return jsonify({
        "status": "started" if started else "in_progress",
        "last_sync": DATA_CACHE["last_sync"]
    })


@app.route('/api/funnel')
def get_funnel():
    if FUNNEL_CACHE["entries"] is None:
        start_funnel_refresh()

    return jsonify({
        "entries": FUNNEL_CACHE["entries"] or [],
        "last_sync": FUNNEL_CACHE["last_sync"],
        "refreshing": _funnel_refreshing["active"],
        "account": PLANFIX_ACCOUNT
    })


@app.route('/api/funnel/sync', methods=['POST'])
def sync_funnel():
    started = start_funnel_refresh()
    return jsonify({
        "status": "started" if started else "in_progress",
        "last_sync": FUNNEL_CACHE["last_sync"]
    })


threading.Thread(target=_refresh_fact_then_funnel, daemon=True).start()  # прогреть кэш при старте
threading.Thread(target=_periodic_refresh, daemon=True).start()

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=8000)
