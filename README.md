# Planfix Sales Dashboard

Веб-дашборд продаж компании Техновид — план/факт по материалам (Алюм, ПВХ, СП, НВФ) с данными из Planfix.

**Репозиторий:** `github.com/alibekzhymabayev3/planfix-sales-dashboard`
**Продакшн URL:** `http://188.0.147.247/dashboard/`

---

## Что показывает

Дашборд сравнивает плановые продажи с фактическими по 4 категориям материалов (Алюминий, ПВХ, Стеклопакеты, НВФ) в разрезе месяцев.

**Секции:**
1. **Сводные карточки** — общие итоги: План Оптимист (м²), План Реалист (м²), Факт (м²)
2. **План продаж "Оптимист"** — помесячный план по категориям + деньги
3. **План продаж "Реалист"** — помесячный план по категориям + деньги
4. **Факт Техновид** — реальные продажи из Planfix
5. **Отклонение от плана "Оптимист"** — разница фактa и плана
6. **Отклонение от плана "Реалист"** — разница факта и плана

**Кнопка "🔄 Обновить данные"** — запускает обновление из Planfix **в фоне** и
сразу отвечает (не держит браузер); свежие данные подтягиваются за ~20с, фронт
их опрашивает. Плюс кэш автообновляется раз в 10 минут.

---

## ⚠️ Важно: развёртывание под подпутём (/dashboard/)

Дашборд опубликован за nginx по пути **`/dashboard/`**. Поэтому в `static/script.js`
запросы к API должны быть **относительными** (`api/data`, `api/sync`), а НЕ от корня
(`/api/data`). Абсолютные пути дают `188.0.147.247/api/...` → **404**, таблицы не
заполняются, «Обновить» → «Ошибка сети». При запуске из корня (`:8000/`) обе формы
работают, но под `/dashboard/` — только относительные.

Также `app.py` запускается с `host='0.0.0.0'` (доступ по сети) и `debug=False`,
и отдаёт статику с `Cache-Control: no-store` (браузер всегда грузит свежий JS).

## Производительность синхронизации

`planfix_api.py` тянет данные параллельно (пагинация datatag 38590 — волнами,
проверка статуса задач — до 25 одновременно). Полная синхронизация ~15с вместо ~42с.
Само обновление выполняется в фоновом потоке (`app.py`), чтобы прокси/браузер не
рвал долгий запрос по таймауту.

---

## Архитектура

```
Браузер
    ↓ GET/POST /dashboard/...
nginx (188.0.147.247:80)
    ↓ proxy_pass /dashboard/ → localhost:8000/
Flask app.py (localhost:8000)
    ├─ GET  /          → static/index.html
    ├─ GET  /api/data  → JSON: {excel_sheet, planfix_fact, last_sync}
    └─ POST /api/sync  → пересинхронизация из Planfix
           ↓
Planfix REST API (tehnovid.planfix.com)
    ↓ DataTag 38590 "Продажи"
    ├─ Поле 148108 — Материал (ПВХ, Алюминий, СП, НВФ)
    ├─ Поле 148110 — Объём, м²
    ├─ Поле 148120 — Итого стоимость, тг
    └─ Поле 148122 — Дата оплаты аванса
    ↓ Поле задачи 144422 — "Договор подписан" (Да/Нет)
    ↓ Агрегация по месяцам 2026
planfix_api.py → {1: {"Алюм": {m2, sum}}, 2: {...}, ...}
```

---

## Структура проекта

```
planfix-sales-dashboard/
├── app.py                    # Flask сервер (порт 8000)
├── planfix_api.py            # Загрузка и агрегация данных из Planfix
├── start_tunnel.py           # Ngrok туннель (альтернатива nginx, не используется у нас)
├── config.json               # Токен API (не в git)
├── excel_structure.json      # Планы продаж из исходного Excel
├── requirements.txt          # Flask, httpx, pandas, openpyxl, pyngrok
├── planfix-dashboard.service # Systemd unit
├── static/                   # Фронтенд
│   ├── index.html            # Структура страницы
│   ├── script.js             # Логика рендера таблиц
│   └── style.css             # Стили
└── .gitignore                # config.json, __pycache__
```

### app.py
Flask-приложение на порту 8000.

**Endpoints:**
| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/` | index.html |
| GET | `/api/data` | Текущие данные (из кэша, или загружает если пусто) |
| POST | `/api/sync` | Принудительная пересинхронизация |

**Кэш:** `DATA_CACHE` хранит последние загруженные данные из Planfix в памяти процесса. Сбрасывается при рестарте сервиса.

### planfix_api.py
Логика загрузки данных из Planfix:

1. **Загрузка всех записей DataTag 38590** (постранично по 100)
2. **Фильтрация по году 2026** (по полю 148122 "Дата оплаты аванса")
3. **Проверка "Договор подписан"** (поле задачи 144422 = "Да") — делается асинхронно с семафором 3 запроса
4. **Агрегация** по (месяц, материал) → `{m2, sum}`

**Маппинг материалов** (normalize из поля 148108):
- "алюминий" / "алюм" → `"Алюм"`
- "венти" / "нвф" → `"НВФ"`
- "стеклопакет" / "сп" → `"СП"`
- "пвх" → `"ПВХ"`
- иначе → `"Прочее"`

**Расчёт СП (коммит 8dfee73):**
После агрегации значение "СП" (м²) пересчитывается по формуле:
```
СП.m2 = (Алюм.m2 + ПВХ.m2) × 0.8
```
Это перезаписывает любое значение СП из Planfix. Сумма (sum) СП сохраняется как есть.

### static/script.js
- `loadData()` — GET `api/data`, рендерит таблицы
- Кнопка "Обновить" — POST `api/sync`, потом `loadData()`
- Пути к API относительные (`api/data`, не `/api/data`) — работает под `/dashboard/`
- **Индексы строк "План, в тенге":** строка 7 (Оптимист) и 16 (Реалист) в `excel_structure.json` — коммит 27a3809

### start_tunnel.py
Альтернативный способ публикации через ngrok-туннель (вместо nginx). **У нас не используется** — продакшн идёт через nginx. Требует `pyngrok` и настроенный ngrok auth token.

```python
from pyngrok import ngrok
public_url = ngrok.connect(8000)
```

### config.json
```json
{
    "planfix_api_token": "...",
    "planfix_account": "tehnovid",
    "signed_field_id": 144422
}
```
Не хранится в git (`.gitignore`).

### excel_structure.json
Исходные планы продаж, выгруженные из Excel. Содержит листы с планами Оптимист/Реалист и расчётные строки.

---

## Ключевые ID в Planfix

| Тип | ID | Название |
|-----|----|----------|
| DataTag | 38590 | Продажи |
| Field | 148108 | Материал |
| Field | 148110 | Объём, м² |
| Field | 148120 | Итого стоимость, тг |
| Field | 148122 | Дата оплаты аванса |
| Field (task) | 144422 | Договор подписан |

---

## Инфраструктура

### Systemd сервис
**Файл:** `/etc/systemd/system/planfix-dashboard.service`

```ini
[Unit]
Description=Planfix Sales Dashboard
After=network.target

[Service]
Type=simple
User=a.lobanov
WorkingDirectory=/data/home/a.lobanov/planfix-sales-dashboard
ExecStart=/usr/bin/python3 /data/home/a.lobanov/planfix-sales-dashboard/app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Управление:**
```bash
sudo systemctl status planfix-dashboard
sudo systemctl restart planfix-dashboard
journalctl -u planfix-dashboard -f
```

### Nginx
**Файл:** `/etc/nginx/sites-available/inventory`
```nginx
location /dashboard/ {
    proxy_pass http://127.0.0.1:8000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
    proxy_connect_timeout 30s;
}
```

Таймаут 120с — т.к. синхронизация из Planfix занимает ~20 секунд.

---

## Установка

```bash
# 1. Клонировать
git clone https://github.com/alibekzhymabayev3/planfix-sales-dashboard.git
cd planfix-sales-dashboard

# 2. Зависимости
pip install --user --break-system-packages -r requirements.txt
# Или минимальный набор (без ngrok/pandas/openpyxl):
# pip install --user --break-system-packages flask httpx

# 3. Создать config.json
cat > config.json <<EOF
{
    "planfix_api_token": "<токен>",
    "planfix_account": "tehnovid",
    "signed_field_id": 144422
}
EOF

# 4. Тестовый запуск
python3 app.py  # слушает 0.0.0.0:8000

# 5. Systemd
sudo cp planfix-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now planfix-dashboard

# 6. Nginx (добавить location /dashboard/ в inventory)
sudo nginx -t && sudo systemctl reload nginx
```

---

## Известные ограничения

- **Только 2026 год** — фильтр хардкоден в `planfix_api.py` (ищется `entry_year == 2026`)
- **Только подписанные договоры** — фильтрация по полю "Договор подписан" = "Да"
- **Кэш в памяти** — сбрасывается при рестарте сервиса
- **Синхронизация ~20 сек** — из-за индивидуальных запросов к задачам для проверки "Договор подписан"
- **Нет авторизации** — дашборд открыт всем, у кого есть URL

---

## Обновление с git

```bash
cd /data/home/a.lobanov/planfix-sales-dashboard
git stash push -m "local changes" -- app.py static/script.js  # сохранить локальные правки
git pull
git stash pop                                                   # вернуть локальные правки

# Перезапустить сервис
sudo systemctl restart planfix-dashboard
```

**Локальные правки, которые нужно сохранять при обновлении:**
- `app.py`: `app.run(..., host='0.0.0.0', ...)` — чтобы слушать на всех интерфейсах
- `static/script.js`: `fetch('api/data')` и `fetch('api/sync')` — относительные пути для работы под `/dashboard/`

## TODO

- [ ] Параметризовать год (сейчас хардкод 2026)
- [ ] Добавить авторизацию
- [ ] Автоматическое обновление данных по расписанию (cron)
- [ ] Экспорт в Excel
- [ ] HTTPS
