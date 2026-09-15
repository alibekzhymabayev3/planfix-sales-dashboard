document.addEventListener('DOMContentLoaded', () => {
    loadData();
    loadFunnel();

    document.getElementById('btn-sync').addEventListener('click', () => {
        const btn = document.getElementById('btn-sync');
        btn.disabled = true;
        btn.innerText = 'Обновление… (~20 сек)';
        const before = window.lastSyncValue || null;
        fetch('api/sync', { method: 'POST' })
            .then(res => res.json())
            .then(() => pollUpdate(before, 0))
            .catch(err => { console.error(err); pollUpdate(before, 0); });
    });

    document.getElementById('btn-funnel-sync').addEventListener('click', () => {
        const btn = document.getElementById('btn-funnel-sync');
        btn.disabled = true;
        btn.innerText = 'Обновление…';
        const before = window.funnelLastSync || null;
        fetch('api/funnel/sync', { method: 'POST' })
            .then(res => res.json())
            .then(() => pollFunnelUpdate(before, 0))
            .catch(err => { console.error(err); pollFunnelUpdate(before, 0); });
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const tabName = btn.getAttribute('data-tab');
            document.getElementById(`tab-content-${tabName}`).classList.add('active');
        });
    });
});

function loadData() {
    fetch('api/data')
        .then(res => res.json())
        .then(data => {
            window.PF_DETAILS = data.planfix_details || {};
            window.PF_ACCOUNT = data.account || window.PF_ACCOUNT || 'tehnovid';
            renderDashboard(data.excel_sheet, data.planfix_fact);
            window.lastSyncValue = data.last_sync || null;
            if (data.last_sync) {
                document.getElementById('last-sync-time').innerText = 'Обновлено из Планфикса: ' + data.last_sync;
            } else {
                document.getElementById('last-sync-time').innerText = data.refreshing ? 'Загрузка данных…' : 'Загружено';
            }
        })
        .catch(err => {
            console.error("Error fetching data:", err);
            document.getElementById('last-sync-time').innerText = 'Ошибка загрузки';
        });
}

function pollUpdate(before, tries) {
    const btn = document.getElementById('btn-sync');
    fetch('api/data')
        .then(r => r.json())
        .then(data => {
            const updated = data.last_sync && data.last_sync !== before;
            if (updated) {
                window.PF_DETAILS = data.planfix_details || {};
                window.PF_ACCOUNT = data.account || window.PF_ACCOUNT || 'tehnovid';
                renderDashboard(data.excel_sheet, data.planfix_fact);
                window.lastSyncValue = data.last_sync;
                document.getElementById('last-sync-time').innerText = 'Обновлено из Планфикса: ' + data.last_sync;
                btn.disabled = false; btn.innerText = '🔄 Обновить данные';
            } else if (tries >= 25) {
                document.getElementById('last-sync-time').innerText = 'Обновление идёт дольше обычного — данные появятся автоматически';
                btn.disabled = false; btn.innerText = '🔄 Обновить данные';
            } else {
                setTimeout(() => pollUpdate(before, tries + 1), 3000);
            }
        })
        .catch(() => setTimeout(() => pollUpdate(before, tries + 1), 3000));
}

// ============================================================
// ВКЛАДКА V4 — ВОРОНКА ВЕРОЯТНОСТИ
// ============================================================
function loadFunnel() {
    fetch('api/funnel')
        .then(res => res.json())
        .then(data => {
            window.funnelLastSync = data.last_sync || null;
            window.PF_ACCOUNT = data.account || window.PF_ACCOUNT || 'tehnovid';
            renderFunnel(data.entries || []);
            const statusEl = document.getElementById('funnel-status');
            const isEmpty = !(data.entries && data.entries.length);
            if (data.last_sync) {
                statusEl.innerText = 'Обновлено: ' + data.last_sync;
            } else if (data.refreshing || isEmpty) {
                // Холодный кэш (первый заход после старта сервера) — не оставляем
                // пользователя с надписью «Загрузка…» навсегда, а сами опрашиваем
                // до появления данных, как при ручном клике «Обновить воронку».
                statusEl.innerText = 'Загрузка данных из Planfix…';
                pollFunnelUpdate(data.last_sync || null, 0);
            } else {
                statusEl.innerText = 'Нет данных';
            }
        })
        .catch(err => {
            console.error("Error fetching funnel:", err);
            document.getElementById('funnel-status').innerText = 'Ошибка загрузки';
        });
}

function pollFunnelUpdate(before, tries) {
    const btn = document.getElementById('btn-funnel-sync');
    fetch('api/funnel')
        .then(r => r.json())
        .then(data => {
            const updated = data.last_sync && data.last_sync !== before;
            if (updated) {
                window.funnelLastSync = data.last_sync;
                window.PF_ACCOUNT = data.account || window.PF_ACCOUNT || 'tehnovid';
                renderFunnel(data.entries || []);
                document.getElementById('funnel-status').innerText = 'Обновлено: ' + data.last_sync;
                btn.disabled = false; btn.innerText = '🔄 Обновить воронку';
            } else if (tries >= 25) {
                document.getElementById('funnel-status').innerText = 'Обновление идёт дольше обычного — данные появятся автоматически';
                btn.disabled = false; btn.innerText = '🔄 Обновить воронку';
            } else {
                setTimeout(() => pollFunnelUpdate(before, tries + 1), 3000);
            }
        })
        .catch(() => setTimeout(() => pollFunnelUpdate(before, tries + 1), 3000));
}

// entries: плоский список {task_id, task_name, customer, material, m2, sum, date,
//   month, month_label, probability, bucket, bucket_label, bucket_order}
function renderFunnel(entries) {
    const container = document.getElementById('funnel-tree');
    if (!entries || !entries.length) {
        container.innerHTML = '<p class="drill-empty">Нет данных за 2026 год.</p>';
        return;
    }

    // Группировка: месяц -> бакет вероятности -> строки
    const months = new Map();
    entries.forEach(e => {
        if (!months.has(e.month)) months.set(e.month, { label: e.month_label, buckets: new Map() });
        const monthObj = months.get(e.month);
        if (!monthObj.buckets.has(e.bucket)) {
            monthObj.buckets.set(e.bucket, { label: e.bucket_label, order: e.bucket_order, rows: [] });
        }
        monthObj.buckets.get(e.bucket).rows.push(e);
    });

    const sortedMonths = [...months.keys()].sort((a, b) => a - b);
    let html = '';

    sortedMonths.forEach(m => {
        const monthObj = months.get(m);
        const buckets = [...monthObj.buckets.entries()].sort((a, b) => a[1].order - b[1].order);

        let monthSum = 0, monthM2 = 0;
        const monthTaskIds = new Set();
        let bucketsHtml = '';

        buckets.forEach(([bucketKey, b]) => {
            let bucketSum = 0, bucketM2 = 0;
            const bucketTaskIds = new Set();
            const rowsHtml = b.rows.map(r => {
                bucketSum += r.sum; bucketM2 += r.m2;
                bucketTaskIds.add(r.task_id); monthTaskIds.add(r.task_id);
                const probText = (r.probability === null || r.probability === undefined)
                    ? '—' : (Math.round(r.probability) + '%');
                return `<tr>
                    <td><a href="${taskUrl(r.task_id)}" target="_blank" rel="noopener">${escapeHtml(r.task_name)}</a></td>
                    <td>${escapeHtml(r.customer || '')}</td>
                    <td>${escapeHtml(r.material || '')}${r.material ? ' · ' : ''}${formatNumber(r.m2)} м²</td>
                    <td style="text-align:right">${formatNumber(r.sum)} тг</td>
                    <td class="funnel-bucket-${bucketKey}"><span class="funnel-dot"></span>${probText}</td>
                </tr>`;
            }).join('');

            monthSum += bucketSum; monthM2 += bucketM2;
            // Счётчик — уникальные задачи (договоры), а не строки аналитики (одна задача
            // может дать несколько строк по разным материалам).
            const bucketMeta = bucketTaskIds.size === b.rows.length
                ? `${bucketTaskIds.size} задач`
                : `${bucketTaskIds.size} задач · строк: ${b.rows.length}`;

            bucketsHtml += `
                <div class="funnel-node funnel-bucket-node funnel-bucket-${bucketKey}">
                    <div class="funnel-node-header" data-funnel-toggle>
                        <span class="funnel-arrow">▶</span>
                        <span class="funnel-dot"></span>
                        <span class="funnel-node-title">${escapeHtml(b.label)}</span>
                        <span class="funnel-node-meta">${bucketMeta} · ${formatNumber(bucketSum)} тг · ${formatNumber(bucketM2)} м²</span>
                    </div>
                    <div class="funnel-node-body">
                        <table class="drill-table funnel-table">
                            <thead><tr>
                                <th>Задача</th><th>Контрагент</th><th>Материал / Объём</th>
                                <th>Сумма договора</th><th>Вероятность</th>
                            </tr></thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>
                </div>`;
        });

        const monthRowCount = buckets.reduce((acc, [, b]) => acc + b.rows.length, 0);
        const monthMeta = monthTaskIds.size === monthRowCount
            ? `${monthTaskIds.size} задач`
            : `${monthTaskIds.size} задач · строк: ${monthRowCount}`;

        html += `
            <div class="funnel-node funnel-month-node">
                <div class="funnel-node-header funnel-month-header" data-funnel-toggle>
                    <span class="funnel-arrow">▶</span>
                    <span class="funnel-node-title">${escapeHtml(monthObj.label)}</span>
                    <span class="funnel-node-meta">${monthMeta} · ${formatNumber(monthSum)} тг · ${formatNumber(monthM2)} м²</span>
                </div>
                <div class="funnel-node-body">${bucketsHtml}</div>
            </div>`;
    });

    container.innerHTML = html;

    container.querySelectorAll('[data-funnel-toggle]').forEach(header => {
        header.addEventListener('click', () => {
            header.classList.toggle('open');
            header.nextElementSibling.classList.toggle('open');
        });
    });
}

function parseValue(val) {
    if (val === null || val === undefined || isNaN(val) || val === "") return 0;
    if (typeof val === 'string') val = val.replace(/\s/g, '');
    const num = parseFloat(val);
    return isNaN(num) ? 0 : num;
}

function formatNumber(num) {
    if (num === 0) return "-";
    return new Intl.NumberFormat('ru-RU').format(Math.round(num));
}

function formatDiff(val) {
    if (val === 0) return "-";
    let str = new Intl.NumberFormat('ru-RU').format(Math.round(val));
    if (val > 0) return "+" + str;
    return str;
}

const MONTHS_RU = ["Январь","Февраль","Март","Апрель","Май","Июнь",
                   "Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

// ── Drill-down ──────────────────────────────────────────────
// Формирует <td>. Если задан drillMat и значение != 0 — ячейка кликабельна
// (открывает модалку с задачами, из которых сложилось число).
function cellHtml(innerHtml, value, month, drillMat) {
    if (drillMat && value && Math.round(value) !== 0) {
        return `<td class="drillable" data-month="${month}" data-mat="${drillMat}" `
             + `style="text-align:right">${innerHtml}</td>`;
    }
    return `<td style="text-align:right">${innerHtml}</td>`;
}

const PF_CATS = ["Алюм", "ПВХ", "СП", "НВФ"];

// Собирает строки детализации для (month, material). month: '1'..'12' или 'year'.
// material: конкретный материал или 'ALL' (тогда только 4 основные категории — как в деньгах факта).
function collectDrillRows(month, material) {
    const details = window.PF_DETAILS || {};
    const months = (month === 'year') ? Array.from({length: 12}, (_, i) => String(i + 1)) : [String(month)];
    const mats = (material === 'ALL') ? PF_CATS : [material];
    const rows = [];
    months.forEach(mk => {
        const md = details[mk];
        if (!md) return;
        mats.forEach(mat => {
            (md[mat] || []).forEach(r => rows.push(Object.assign({month: mk, mat: mat}, r)));
        });
    });
    return rows;
}

function openDrill(month, material) {
    const rows = collectDrillRows(month, material);
    const monthLabel = (month === 'year') ? 'Итого за год' : (MONTHS_RU[parseInt(month, 10) - 1] || month);
    const matLabel = (material === 'ALL') ? 'Все материалы' : material;

    rows.sort((a, b) => (b.sum || 0) - (a.sum || 0));

    let totM2 = 0, totSum = 0;
    rows.forEach(r => { totM2 += (r.m2 || 0); totSum += (r.sum || 0); });

    const body = document.getElementById('drill-body');
    const title = document.getElementById('drill-title');
    title.innerText = `Факт · ${matLabel} · ${monthLabel} 2026`;

    // Квадратура СП в ячейке факта — производная величина (Алюм+ПВХ)*0.8, а не сумма
    // построчных м² договоров со стеклопакетами — эти два числа расходятся, поэтому
    // построчную/итоговую сумму м² для СП не показываем, только явную пометку.
    const isSp = (material === 'СП');
    let note = '';
    if (isSp) {
        note = `<p class="drill-note">⚠️ Квадратура СП в таблице рассчитывается по формуле (Алюм + ПВХ) × 0,8 `
             + `и НЕ равна сумме м² по строкам ниже — колонка «Объём, м²» здесь скрыта во избежание путаницы. `
             + `Договоры со стеклопакетами показаны для сверки суммы в тенге.</p>`;
    }

    if (!rows.length) {
        body.innerHTML = note + `<p class="drill-empty">Нет договоров за этот период (данные ещё не загружены или ячейка пустая).</p>`;
    } else {
        const showMatCol = (material === 'ALL');
        // Счётчик — уникальные задачи (договоры), а не строки детализации (одна задача
        // может дать несколько строк по разным материалам).
        const uniqueTaskCount = new Set(rows.map(r => r.task_id)).size;
        const countLabel = uniqueTaskCount === rows.length
            ? `${uniqueTaskCount}`
            : `${uniqueTaskCount} · строк: ${rows.length}`;
        let html = note + `<div class="drill-count">Договоров: <strong>${countLabel}</strong></div>`;
        html += `<table class="drill-table"><thead><tr>`
              + `<th style="text-align:left">Задача</th>`
              + `<th style="text-align:left">Заказчик</th>`
              + (showMatCol ? `<th style="text-align:left">Материал</th>` : ``)
              + (isSp ? `` : `<th style="text-align:right">Объём, м²</th>`)
              + `<th style="text-align:right">Сумма, тг</th>`
              + `<th style="text-align:right">Мес.</th>`
              + `<th style="text-align:left">Дата аванса</th>`
              + `</tr></thead><tbody>`;
        rows.forEach(r => {
            const url = taskUrl(r.task_id);
            html += `<tr>`
                  + `<td style="text-align:left"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(r.task_name)}</a></td>`
                  + `<td style="text-align:left">${escapeHtml(r.customer || '—')}</td>`
                  + (showMatCol ? `<td style="text-align:left">${escapeHtml(r.material_raw || r.mat)}</td>` : ``)
                  + (isSp ? `` : `<td style="text-align:right">${formatNumber(r.m2 || 0)}</td>`)
                  + `<td style="text-align:right">${formatNumber(r.sum || 0)}</td>`
                  + `<td style="text-align:right">${(MONTHS_RU[parseInt(r.month,10)-1]||'').slice(0,3)}</td>`
                  + `<td style="text-align:left">${escapeHtml(r.date || '')}</td>`
                  + `</tr>`;
        });
        html += `</tbody><tfoot><tr>`
              + `<td style="text-align:left"><strong>Итого</strong></td>`
              + `<td></td>`
              + (showMatCol ? `<td></td>` : ``)
              + (isSp ? `` : `<td style="text-align:right"><strong>${formatNumber(totM2)}</strong></td>`)
              + `<td style="text-align:right"><strong>${formatNumber(totSum)}</strong></td>`
              + `<td colspan="2"></td>`
              + `</tr></tfoot></table>`;
        body.innerHTML = html;
    }

    document.getElementById('drill-overlay').classList.add('open');
}

function closeDrill() {
    document.getElementById('drill-overlay').classList.remove('open');
}

// Строит ссылку на задачу Planfix из аккаунта, полученного от /api/data или /api/funnel
// (фикс хардкода домена tehnovid.planfix.com). Фолбэк — 'tehnovid', если account не пришёл.
function taskUrl(taskId) {
    const account = window.PF_ACCOUNT || 'tehnovid';
    return `https://${account}.planfix.com/task/${encodeURIComponent(taskId)}`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Делегирование кликов по кликабельным ячейкам + закрытие модалки
document.addEventListener('click', (e) => {
    const cell = e.target.closest('.drillable');
    if (cell) {
        openDrill(cell.getAttribute('data-month'), cell.getAttribute('data-mat'));
        return;
    }
    if (e.target.id === 'drill-overlay' || e.target.closest('#drill-close')) {
        closeDrill();
    }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrill(); });

function renderDashboard(sheetData, planfixData) {
    if (!sheetData || !planfixData) return;
    renderDashboardV2(sheetData, planfixData);
    renderDashboardV1(sheetData, planfixData);
    renderDashboardV3(sheetData, planfixData);
}

// ============================================================
// ВКЛАДКА V2 — ОСНОВНОЙ ФОКУС
// ============================================================
function renderDashboardV2(sheetData, planfixData) {
    const categories = [
        {name: "Алюм, м2", optRow: 3, planfixName: "Алюм"},
        {name: "ПВХ, м2",  optRow: 4, planfixName: "ПВХ"},
        {name: "СП, м2",   optRow: 5, planfixName: "СП"},
        {name: "НВФ, м2",  optRow: 6, planfixName: "НВФ"}
    ];

    const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь",
                    "Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

    // Вспомогательная функция: записать заголовок месяцев в thead
    function fillHeader(tableId) {
        const tr = document.querySelector(`#${tableId} thead tr.months-header`);
        if (!tr) return;
        tr.innerHTML =
            `<th style="min-width:180px;text-align:left;white-space:nowrap;">Показатель</th>` +
            MONTHS.map(m => `<th style="min-width:115px;text-align:right;white-space:nowrap;">${m}</th>`).join('') +
            `<th style="min-width:115px;text-align:right;white-space:nowrap;font-weight:700;">Итого</th>`;
    }

    fillHeader('v2-table-fact');
    fillHeader('v2-table-opt');
    fillHeader('v2-table-cumulative-fact');
    fillHeader('v2-table-cumulative-opt');

    const tbodyFact    = document.querySelector('#v2-table-fact tbody');
    const tbodyOpt     = document.querySelector('#v2-table-opt tbody');
    const tbodyCumFact = document.querySelector('#v2-table-cumulative-fact tbody');
    const tbodyCumOpt  = document.querySelector('#v2-table-cumulative-opt tbody');

    tbodyFact.innerHTML    = '';
    tbodyOpt.innerHTML     = '';
    tbodyCumFact.innerHTML = '';
    tbodyCumOpt.innerHTML  = '';

    // --- предрасчёт денег ---
    let factMoneyByMonth = {};
    let optMoneyByMonth  = {};
    let totalFactMoney   = 0;
    let totalOptMoney    = 0;

    for (let m = 1; m <= 12; m++) {
        factMoneyByMonth[m] = 0;
        categories.forEach(cat => {
            if (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName]) {
                factMoneyByMonth[m] += planfixData[m.toString()][cat.planfixName].sum || 0;
            }
        });
        optMoneyByMonth[m] = parseValue(sheetData[7][m + 1]);
        totalFactMoney += factMoneyByMonth[m];
        totalOptMoney  += optMoneyByMonth[m];
    }

    // helper: строим <tr> с числами по месяцам.
    // drillMat: материал ('Алюм'/'ПВХ'/'СП'/'НВФ'/'ALL') → ячейки факта кликабельны (drill-down);
    //           null → обычная строка (план), без drill.
    function makeRow(label, valFn, style, bold, drillMat) {
        const tr = document.createElement('tr');
        if (style) tr.style.background = style;
        let yearTotal = 0;
        const wrap = bold ? (s) => `<strong>${s}</strong>` : (s) => s;
        tr.innerHTML = `<td>${wrap(label)}</td>`;
        for (let m = 1; m <= 12; m++) {
            const v = valFn(m);
            yearTotal += v;
            tr.innerHTML += cellHtml(wrap(formatNumber(v)), v, m, drillMat);
        }
        tr.innerHTML += cellHtml(`<strong>${formatNumber(yearTotal)}</strong>`, yearTotal, 'year', drillMat);
        return tr;
    }

    // ── ФАКТ: деньги сверху, потом м2 ──
    tbodyFact.appendChild(makeRow(
        'Факт Техновид, в тенге',
        m => factMoneyByMonth[m],
        '#fce4d6', true, 'ALL'
    ));
    categories.forEach(cat => {
        tbodyFact.appendChild(makeRow(
            cat.name,
            m => (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName])
                   ? planfixData[m.toString()][cat.planfixName].m2
                   : 0,
            null, false, cat.planfixName
        ));
    });

    // ── ПЛАН ОПТИМИСТ: деньги сверху, потом м2 ──
    tbodyOpt.appendChild(makeRow(
        'План, в тенге',
        m => optMoneyByMonth[m],
        '#e6f4ea', true
    ));
    categories.forEach(cat => {
        tbodyOpt.appendChild(makeRow(
            cat.name,
            m => parseValue(sheetData[cat.optRow][m + 1]),
            null, false
        ));
    });

    // ── ФАКТ НАКОПИТЕЛЬНЫЙ ──
    {
        let lastFactMonth = 0;
        for (let m = 1; m <= 12; m++) {
            if (planfixData[m.toString()]) lastFactMonth = m;
        }
        const tr = document.createElement('tr');
        tr.style.background = '#fce4d6';
        tr.innerHTML = `<td><strong>Факт Техновид, в тенге</strong></td>`;
        let cum = 0;
        for (let m = 1; m <= 12; m++) {
            if (m <= lastFactMonth) {
                cum += factMoneyByMonth[m] || 0;
                tr.innerHTML += `<td style="text-align:right"><strong>${formatNumber(cum)}</strong></td>`;
            } else {
                tr.innerHTML += `<td style="text-align:right">-</td>`;
            }
        }
        tr.innerHTML += lastFactMonth > 0
            ? `<td style="text-align:right"><strong>${formatNumber(cum)}</strong></td>`
            : `<td style="text-align:right">-</td>`;
        tbodyCumFact.appendChild(tr);
    }

    // ── ПЛАН НАКОПИТЕЛЬНЫЙ ОПТИМИСТ ──
    {
        const tr = document.createElement('tr');
        tr.style.background = '#e2efda';
        tr.innerHTML = `<td><strong>План Оптимист, в тенге</strong></td>`;
        let cum = 0;
        for (let m = 1; m <= 12; m++) {
            cum += optMoneyByMonth[m] || 0;
            tr.innerHTML += `<td style="text-align:right"><strong>${formatNumber(cum)}</strong></td>`;
        }
        tr.innerHTML += `<td style="text-align:right"><strong>${formatNumber(cum)}</strong></td>`;
        tbodyCumOpt.appendChild(tr);
    }

    // ── Сводные карточки (деньги) ──
    const pct = totalOptMoney > 0 ? Math.round((totalFactMoney / totalOptMoney) * 100) : 0;
    const optEl  = document.getElementById('v2-val-opt-money');
    const factEl = document.getElementById('v2-val-fact-money');
    if (optEl)  optEl.innerText  = formatNumber(totalOptMoney);
    if (factEl) factEl.innerText = formatNumber(totalFactMoney);
    document.getElementById('v2-val-pct-opt').innerText = pct > 0 ? pct + "%" : "--";
}

// ============================================================
// ВКЛАДКА V1 — ПОЛНАЯ АНАЛИТИКА
// ============================================================
function renderDashboardV1(sheetData, planfixData) {
    const categories = [
        {name: "Алюм, м2", optRow: 3, realRow: 12, planfixName: "Алюм"},
        {name: "ПВХ, м2",  optRow: 4, realRow: 13, planfixName: "ПВХ"},
        {name: "СП, м2",   optRow: 5, realRow: 14, planfixName: "СП"},
        {name: "НВФ, м2",  optRow: 6, realRow: 15, planfixName: "НВФ"}
    ];

    let totalOpt = 0, totalReal = 0, totalFact = 0;

    const tbodyOpt       = document.querySelector('#v1-table-opt tbody');
    const tbodyReal      = document.querySelector('#v1-table-real tbody');
    const tbodyFact      = document.querySelector('#v1-table-fact tbody');
    const tbodyDiffOpt   = document.querySelector('#v1-table-diff-opt tbody');
    const tbodyDiffReal  = document.querySelector('#v1-table-diff-real tbody');
    const tbodyCumulative= document.querySelector('#v1-table-cumulative tbody');

    tbodyOpt.innerHTML = '';
    tbodyReal.innerHTML = '';
    tbodyFact.innerHTML = '';
    tbodyDiffOpt.innerHTML = '';
    tbodyDiffReal.innerHTML = '';
    if (tbodyCumulative) tbodyCumulative.innerHTML = '';

    let dataMap = { opt: {}, real: {}, fact: {} };

    let factMoneyByMonth = {};
    for (let m = 1; m <= 12; m++) {
        factMoneyByMonth[m] = 0;
        categories.forEach(cat => {
            if (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName]) {
                factMoneyByMonth[m] += planfixData[m.toString()][cat.planfixName].sum || 0;
            }
        });
    }

    categories.forEach(cat => {
        dataMap.opt[cat.name]  = [];
        dataMap.real[cat.name] = [];
        dataMap.fact[cat.name] = [];

        let rOpt  = document.createElement('tr');
        let rReal = document.createElement('tr');
        let rFact = document.createElement('tr');
        rOpt.innerHTML  = `<td>${cat.name}</td>`;
        rReal.innerHTML = `<td>${cat.name}</td>`;
        rFact.innerHTML = `<td>${cat.name}</td>`;
        let optYearTotal = 0, realYearTotal = 0, factYearTotal = 0;

        for (let m = 1; m <= 12; m++) {
            let optVal  = parseValue(sheetData[cat.optRow][m + 1]);
            let realVal = parseValue(sheetData[cat.realRow][m + 1]);
            let factVal = (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName])
                            ? planfixData[m.toString()][cat.planfixName].m2 : 0;

            dataMap.opt[cat.name][m]  = optVal;
            dataMap.real[cat.name][m] = realVal;
            dataMap.fact[cat.name][m] = factVal;

            optYearTotal  += optVal;
            realYearTotal += realVal;
            factYearTotal += factVal;

            rOpt.innerHTML  += `<td>${formatNumber(optVal)}</td>`;
            rReal.innerHTML += `<td>${formatNumber(realVal)}</td>`;
            rFact.innerHTML += (factVal && Math.round(factVal) !== 0)
                ? `<td class="drillable" data-month="${m}" data-mat="${cat.planfixName}">${formatNumber(factVal)}</td>`
                : `<td>${formatNumber(factVal)}</td>`;
        }

        rOpt.innerHTML  += `<td><strong>${formatNumber(optYearTotal)}</strong></td>`;
        rReal.innerHTML += `<td><strong>${formatNumber(realYearTotal)}</strong></td>`;
        rFact.innerHTML += (factYearTotal && Math.round(factYearTotal) !== 0)
            ? `<td class="drillable" data-month="year" data-mat="${cat.planfixName}"><strong>${formatNumber(factYearTotal)}</strong></td>`
            : `<td><strong>${formatNumber(factYearTotal)}</strong></td>`;

        tbodyOpt.appendChild(rOpt);
        tbodyReal.appendChild(rReal);
        tbodyFact.appendChild(rFact);

        totalOpt  += optYearTotal;
        totalReal += realYearTotal;
        totalFact += factYearTotal;
    });

    // Деньги — план оптимист
    let moneyRowOpt = document.createElement('tr');
    moneyRowOpt.style.background = '#e6f4ea';
    moneyRowOpt.innerHTML = `<td><strong>План, в тенге</strong></td>`;
    let moneyOptByMonth = {}, moneyOptYear = 0;

    let moneyRowReal = document.createElement('tr');
    moneyRowReal.style.background = '#e6f4ea';
    moneyRowReal.innerHTML = `<td><strong>План, в тенге</strong></td>`;
    let moneyRealByMonth = {}, moneyRealYear = 0;

    for (let m = 1; m <= 12; m++) {
        let valO = parseValue(sheetData[7][m + 1]);
        let valR = parseValue(sheetData[16][m + 1]);
        moneyOptByMonth[m]  = valO; moneyOptYear  += valO;
        moneyRealByMonth[m] = valR; moneyRealYear += valR;
        moneyRowOpt.innerHTML  += `<td><strong>${formatNumber(valO)}</strong></td>`;
        moneyRowReal.innerHTML += `<td><strong>${formatNumber(valR)}</strong></td>`;
    }
    moneyRowOpt.innerHTML  += `<td><strong>${formatNumber(moneyOptYear)}</strong></td>`;
    moneyRowReal.innerHTML += `<td><strong>${formatNumber(moneyRealYear)}</strong></td>`;
    tbodyOpt.appendChild(moneyRowOpt);
    tbodyReal.appendChild(moneyRowReal);

    // Деньги — факт (вверх)
    let moneyRowFact = document.createElement('tr');
    moneyRowFact.style.background = '#fce4d6';
    moneyRowFact.innerHTML = `<td><strong>Факт Техновид, в тенге</strong></td>`;
    let moneyFactYear = 0;
    for (let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m];
        moneyFactYear += fM;
        moneyRowFact.innerHTML += (fM && Math.round(fM) !== 0)
            ? `<td class="drillable" data-month="${m}" data-mat="ALL"><strong>${formatNumber(fM)}</strong></td>`
            : `<td><strong>${formatNumber(fM)}</strong></td>`;
    }
    moneyRowFact.innerHTML += (moneyFactYear && Math.round(moneyFactYear) !== 0)
        ? `<td class="drillable" data-month="year" data-mat="ALL"><strong>${formatNumber(moneyFactYear)}</strong></td>`
        : `<td><strong>${formatNumber(moneyFactYear)}</strong></td>`;
    tbodyFact.insertBefore(moneyRowFact, tbodyFact.firstChild);

    // Отклонения — Оптимист
    let diffMoneyOptRow = document.createElement('tr');
    diffMoneyOptRow.style.background = '#ddebf7';
    diffMoneyOptRow.innerHTML = `<td><strong>Договора, в тенге</strong></td>`;
    let diffMoneyOptYear = 0;
    for (let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m], oM = moneyOptByMonth[m];
        let hasFact = !!planfixData[m.toString()];
        if (hasFact) {
            let d = fM !== 0 || oM !== 0 ? fM - oM : 0;
            diffMoneyOptYear += d;
            diffMoneyOptRow.innerHTML += `<td class="${d < 0 ? 'val-negative' : (d > 0 ? 'val-positive' : '')}"><strong>${formatDiff(d)}</strong></td>`;
        } else {
            diffMoneyOptRow.innerHTML += `<td>-</td>`;
        }
    }
    diffMoneyOptRow.innerHTML += `<td class="${diffMoneyOptYear < 0 ? 'val-negative' : ''}"><strong>${formatDiff(diffMoneyOptYear)}</strong></td>`;
    tbodyDiffOpt.appendChild(diffMoneyOptRow);

    categories.forEach(cat => {
        let rDiffOpt = document.createElement('tr');
        rDiffOpt.innerHTML = `<td>${cat.name}</td>`;
        let diffOptYear = 0;
        for (let m = 1; m <= 12; m++) {
            let f = dataMap.fact[cat.name][m], o = dataMap.opt[cat.name][m];
            let hasFact = !!planfixData[m.toString()];
            if (hasFact) {
                let doVal = f !== 0 || o !== 0 ? f - o : 0;
                diffOptYear += doVal;
                rDiffOpt.innerHTML += `<td class="${doVal < 0 ? 'val-negative' : (doVal > 0 ? 'val-positive' : '')}">${formatDiff(doVal)}</td>`;
            } else {
                rDiffOpt.innerHTML += `<td>-</td>`;
            }
        }
        rDiffOpt.innerHTML += `<td class="${diffOptYear < 0 ? 'val-negative' : ''}"><strong>${formatDiff(diffOptYear)}</strong></td>`;
        tbodyDiffOpt.appendChild(rDiffOpt);
    });

    // Отклонения — Реалист
    let diffMoneyRealRow = document.createElement('tr');
    diffMoneyRealRow.style.background = '#ddebf7';
    diffMoneyRealRow.innerHTML = `<td><strong>Договора, в тенге</strong></td>`;
    let diffMoneyRealYear = 0;
    for (let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m], rM = moneyRealByMonth[m];
        let hasFact = !!planfixData[m.toString()];
        if (hasFact) {
            let d = fM !== 0 || rM !== 0 ? fM - rM : 0;
            diffMoneyRealYear += d;
            diffMoneyRealRow.innerHTML += `<td class="${d < 0 ? 'val-negative' : (d > 0 ? 'val-positive' : '')}"><strong>${formatDiff(d)}</strong></td>`;
        } else {
            diffMoneyRealRow.innerHTML += `<td>-</td>`;
        }
    }
    diffMoneyRealRow.innerHTML += `<td class="${diffMoneyRealYear < 0 ? 'val-negative' : ''}"><strong>${formatDiff(diffMoneyRealYear)}</strong></td>`;
    tbodyDiffReal.appendChild(diffMoneyRealRow);

    categories.forEach(cat => {
        let rDiffReal = document.createElement('tr');
        rDiffReal.innerHTML = `<td>${cat.name}</td>`;
        let diffRealYear = 0;
        for (let m = 1; m <= 12; m++) {
            let f = dataMap.fact[cat.name][m], r = dataMap.real[cat.name][m];
            let hasFact = !!planfixData[m.toString()];
            if (hasFact) {
                let drVal = f !== 0 || r !== 0 ? f - r : 0;
                diffRealYear += drVal;
                rDiffReal.innerHTML += `<td class="${drVal < 0 ? 'val-negative' : (drVal > 0 ? 'val-positive' : '')}">${formatDiff(drVal)}</td>`;
            } else {
                rDiffReal.innerHTML += `<td>-</td>`;
            }
        }
        rDiffReal.innerHTML += `<td class="${diffRealYear < 0 ? 'val-negative' : ''}"><strong>${formatDiff(diffRealYear)}</strong></td>`;
        tbodyDiffReal.appendChild(rDiffReal);
    });

    // Накопительные итоги v1
    if (tbodyCumulative) {
        let cumOptRow = document.createElement('tr');
        cumOptRow.style.background = '#e2efda';
        cumOptRow.innerHTML = `<td><strong>План Оптимист, в тенге</strong></td>`;
        let cumOpt = 0;
        for (let m = 1; m <= 12; m++) {
            cumOpt += moneyOptByMonth[m] || 0;
            cumOptRow.innerHTML += `<td><strong>${formatNumber(cumOpt)}</strong></td>`;
        }
        cumOptRow.innerHTML += `<td><strong>${formatNumber(cumOpt)}</strong></td>`;
        tbodyCumulative.appendChild(cumOptRow);

        let cumRealRow = document.createElement('tr');
        cumRealRow.style.background = '#ddebf7';
        cumRealRow.innerHTML = `<td><strong>План Реалист, в тенге</strong></td>`;
        let cumReal = 0;
        for (let m = 1; m <= 12; m++) {
            cumReal += moneyRealByMonth[m] || 0;
            cumRealRow.innerHTML += `<td><strong>${formatNumber(cumReal)}</strong></td>`;
        }
        cumRealRow.innerHTML += `<td><strong>${formatNumber(cumReal)}</strong></td>`;
        tbodyCumulative.appendChild(cumRealRow);

        let cumFactRow = document.createElement('tr');
        cumFactRow.style.background = '#fce4d6';
        cumFactRow.innerHTML = `<td><strong>Факт Техновид, в тенге</strong></td>`;
        let cumFact = 0, lastFactMonth = 0;
        for (let m = 1; m <= 12; m++) {
            if (planfixData[m.toString()]) lastFactMonth = m;
        }
        for (let m = 1; m <= 12; m++) {
            if (m <= lastFactMonth) {
                cumFact += factMoneyByMonth[m] || 0;
                cumFactRow.innerHTML += `<td><strong>${formatNumber(cumFact)}</strong></td>`;
            } else {
                cumFactRow.innerHTML += `<td>-</td>`;
            }
        }
        cumFactRow.innerHTML += lastFactMonth > 0
            ? `<td><strong>${formatNumber(cumFact)}</strong></td>`
            : `<td>-</td>`;
        tbodyCumulative.appendChild(cumFactRow);
    }

    document.getElementById('v1-val-opt-m2').innerText  = formatNumber(totalOpt);
    document.getElementById('v1-val-real-m2').innerText = formatNumber(totalReal);
    document.getElementById('v1-val-fact-m2').innerText = formatNumber(totalFact);
}

// ============================================================
// ВКЛАДКА V3 — СВОДНАЯ
// ============================================================
function renderDashboardV3(sheetData, planfixData) {
    const categories = [
        {name: "Алюм, м2", optRow: 3, planfixName: "Алюм"},
        {name: "ПВХ, м2",  optRow: 4, planfixName: "ПВХ"},
        {name: "СП, м2",   optRow: 5, planfixName: "СП"},
        {name: "НВФ, м2",  optRow: 6, planfixName: "НВФ"}
    ];

    const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь",
                    "Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

    // заголовок месяцев для сводной таблицы
    const trHead = document.querySelector('#v3-table-summary thead tr.months-header');
    if (trHead) {
        trHead.innerHTML =
            `<th style="min-width:180px;text-align:left;white-space:nowrap;">Показатель</th>` +
            MONTHS.map(m => `<th style="min-width:115px;text-align:right;white-space:nowrap;">${m}</th>`).join('') +
            `<th style="min-width:115px;text-align:right;white-space:nowrap;font-weight:700;">Итого</th>`;
    }

    // предрасчёт денег по месяцам
    let factMoneyByMonth = {};
    let optMoneyByMonth  = {};
    let lastFactMonth = 0;
    for (let m = 1; m <= 12; m++) {
        factMoneyByMonth[m] = 0;
        categories.forEach(cat => {
            if (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName]) {
                factMoneyByMonth[m] += planfixData[m.toString()][cat.planfixName].sum || 0;
            }
        });
        optMoneyByMonth[m] = parseValue(sheetData[7][m + 1]);
        if (planfixData[m.toString()]) lastFactMonth = m;
    }

    // ── ТАБЛИЦА 1: 4 строки (факт / план / факт накопит. / план накопит.) ──
    const tbody = document.querySelector('#v3-table-summary tbody');
    tbody.innerHTML = '';

    function makeMoneyRow(label, valFn, bg, drillMat) {
        const tr = document.createElement('tr');
        tr.style.background = bg;
        let total = 0;
        tr.innerHTML = `<td><strong>${label}</strong></td>`;
        for (let m = 1; m <= 12; m++) {
            const v = valFn(m);
            total += v;
            tr.innerHTML += cellHtml(`<strong>${formatNumber(v)}</strong>`, v, m, drillMat);
        }
        tr.innerHTML += cellHtml(`<strong>${formatNumber(total)}</strong>`, total, 'year', drillMat);
        return tr;
    }

    tbody.appendChild(makeMoneyRow('Факт Техновид, в тенге', m => factMoneyByMonth[m], '#fce4d6', 'ALL'));
    tbody.appendChild(makeMoneyRow('План, в тенге', m => optMoneyByMonth[m], '#e6f4ea'));

    // факт накопительный (только до последнего месяца с фактом)
    {
        const tr = document.createElement('tr');
        tr.style.background = '#fce4d6';
        tr.innerHTML = `<td><strong>Факт накопительный, в тенге</strong></td>`;
        let cum = 0;
        for (let m = 1; m <= 12; m++) {
            if (m <= lastFactMonth) {
                cum += factMoneyByMonth[m] || 0;
                tr.innerHTML += `<td style="text-align:right"><strong>${formatNumber(cum)}</strong></td>`;
            } else {
                tr.innerHTML += `<td style="text-align:right">-</td>`;
            }
        }
        tr.innerHTML += lastFactMonth > 0
            ? `<td style="text-align:right"><strong>${formatNumber(cum)}</strong></td>`
            : `<td style="text-align:right">-</td>`;
        tbody.appendChild(tr);
    }

    // план накопительный
    {
        const tr = document.createElement('tr');
        tr.style.background = '#e2efda';
        tr.innerHTML = `<td><strong>План накопительный, в тенге</strong></td>`;
        let cum = 0;
        for (let m = 1; m <= 12; m++) {
            cum += optMoneyByMonth[m] || 0;
            tr.innerHTML += `<td style="text-align:right"><strong>${formatNumber(cum)}</strong></td>`;
        }
        tr.innerHTML += `<td style="text-align:right"><strong>${formatNumber(cum)}</strong></td>`;
        tbody.appendChild(tr);
    }

    // ── ТАБЛИЦА 2: годовая квадратура — факт / план / разница ──
    const tbodyYear = document.querySelector('#v3-table-year-m2 tbody');
    tbodyYear.innerHTML = '';

    let grandFact = 0, grandPlan = 0;

    categories.forEach(cat => {
        let factYear = 0, planYear = 0;
        for (let m = 1; m <= 12; m++) {
            if (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName]) {
                factYear += planfixData[m.toString()][cat.planfixName].m2 || 0;
            }
            planYear += parseValue(sheetData[cat.optRow][m + 1]);
        }
        grandFact += factYear;
        grandPlan += planYear;

        const diff = factYear - planYear;
        const pct  = planYear > 0 ? Math.round((factYear / planYear) * 100) : 0;
        const tr = document.createElement('tr');
        tr.innerHTML =
            `<td>${cat.name}</td>` +
            cellHtml(formatNumber(factYear), factYear, 'year', cat.planfixName) +
            `<td style="text-align:right">${formatNumber(planYear)}</td>` +
            `<td style="text-align:right; color:${diff < 0 ? '#c0392b' : '#1e7e34'}">${formatDiff(diff)}</td>` +
            `<td style="text-align:right">${pct > 0 ? pct + '%' : '-'}</td>`;
        tbodyYear.appendChild(tr);
    });

    // итоговая строка
    {
        const diff = grandFact - grandPlan;
        const pct  = grandPlan > 0 ? Math.round((grandFact / grandPlan) * 100) : 0;
        const tr = document.createElement('tr');
        tr.style.background = '#dce6f1';
        tr.innerHTML =
            `<td><strong>Итого за год</strong></td>` +
            cellHtml(`<strong>${formatNumber(grandFact)}</strong>`, grandFact, 'year', 'ALL') +
            `<td style="text-align:right"><strong>${formatNumber(grandPlan)}</strong></td>` +
            `<td style="text-align:right; color:${diff < 0 ? '#c0392b' : '#1e7e34'}"><strong>${formatDiff(diff)}</strong></td>` +
            `<td style="text-align:right"><strong>${pct > 0 ? pct + '%' : '-'}</strong></td>`;
        tbodyYear.appendChild(tr);
    }
}
