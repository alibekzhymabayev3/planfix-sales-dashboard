from flask import Flask, jsonify
import json
import os
import time
import asyncio
import datetime
import threading
from planfix_api import fetch_planfix_fact

app = Flask(__name__, static_folder='static', static_url_path='')

DATA_CACHE = {
    "planfix_fact": None,
    "last_sync": None
}

# Обновление Planfix-факта вынесено в фон, чтобы браузер не держал долгий запрос
# (внешние/корпоративные прокси рвут соединение на ~15с). Кнопка «Обновить» отвечает
# мгновенно, данные подтягиваются в фоне, фронт опрашивает /api/data.
_refresh_lock = threading.Lock()
_refreshing = {"active": False}


def _do_refresh():
    try:
        fact = asyncio.run(fetch_planfix_fact())
        DATA_CACHE["planfix_fact"] = fact
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


def _periodic_refresh():
    while True:
        time.sleep(600)   # автообновление раз в 10 минут
        start_refresh()


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
            "last_sync": DATA_CACHE["last_sync"],
            "refreshing": _refreshing["active"]
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


start_refresh()  # прогреть кэш при старте
threading.Thread(target=_periodic_refresh, daemon=True).start()

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=8000)
