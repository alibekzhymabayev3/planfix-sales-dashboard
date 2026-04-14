from flask import Flask, jsonify, request
import json
import os
import asyncio
import datetime
from planfix_api import fetch_planfix_fact

app = Flask(__name__, static_folder='static', static_url_path='')

DATA_CACHE = {
    "planfix_fact": None,
    "last_sync": None
}

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
        
        # Pull facts from cache, or fetch if it's empty
        if DATA_CACHE["planfix_fact"] is None:
            DATA_CACHE["planfix_fact"] = asyncio.run(fetch_planfix_fact())
            DATA_CACHE["last_sync"] = datetime.datetime.now().strftime("%d.%m.%Y %H:%M:%S")
        
        response = {
            "excel_sheet": sheet_data,
            "planfix_fact": DATA_CACHE["planfix_fact"],
            "last_sync": DATA_CACHE["last_sync"]
        }
        return jsonify(response)
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/sync', methods=['POST'])
def sync_data():
    try:
        DATA_CACHE["planfix_fact"] = asyncio.run(fetch_planfix_fact())
        DATA_CACHE["last_sync"] = datetime.datetime.now().strftime("%d.%m.%Y %H:%M:%S")
        return jsonify({"status": "success", "last_sync": DATA_CACHE["last_sync"]})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=8000)
