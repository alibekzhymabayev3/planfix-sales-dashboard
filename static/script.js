document.addEventListener('DOMContentLoaded', () => {
    loadData();

    // Синхронизация данных — фоновая: кнопка не держит долгий запрос,
    // запускаем обновление и опрашиваем /api/data до появления свежих данных.
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

    // Обработчик вкладок
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

// Опрос результата фонового обновления: ждём, пока last_sync изменится.
function pollUpdate(before, tries) {
    const btn = document.getElementById('btn-sync');
    fetch('api/data')
        .then(r => r.json())
        .then(data => {
            const updated = data.last_sync && data.last_sync !== before;
            if (updated) {
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

function parseValue(val) {
    if (val === null || val === undefined || isNaN(val) || val === "") return 0;
    if (typeof val === 'string') {
        val = val.replace(/\s/g, ''); // remove spaces if any
    }
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

function renderDashboard(sheetData, planfixData) {
    if(!sheetData || !planfixData) return;
    
    renderDashboardV2(sheetData, planfixData);
    renderDashboardV1(sheetData, planfixData);
}

// ================= ОТРИСОВКА ВКЛАДКИ V2 (ОСНОВНОЙ ФОКУС) =================
function renderDashboardV2(sheetData, planfixData) {
    const categories = [
        {name: "Алюм, м2", optRow: 3, planfixName: "Алюм"},
        {name: "ПВХ, м2", optRow: 4, planfixName: "ПВХ"},
        {name: "СП, м2", optRow: 5, planfixName: "СП"},
        {name: "НВФ, м2", optRow: 6, planfixName: "НВФ"}
    ];

    const months = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь", "Итого за 12 мес"];
    
    const tbodyFact = document.querySelector('#v2-table-fact tbody');
    const tbodyOpt = document.querySelector('#v2-table-opt tbody');
    const tbodyCumFact = document.querySelector('#v2-table-cumulative-fact tbody');
    const tbodyCumOpt = document.querySelector('#v2-table-cumulative-opt tbody');

    tbodyFact.innerHTML = '';
    tbodyOpt.innerHTML = '';
    tbodyCumFact.innerHTML = '';
    tbodyCumOpt.innerHTML = '';

    let totalOpt = 0;
    let totalFact = 0;
    let dataMap = { opt: {}, fact: {} };

    // Расчет сумм по факту в тенге
    let factMoneyByMonth = {};
    for (let m = 1; m <= 12; m++) {
        factMoneyByMonth[m] = 0;
        categories.forEach(cat => {
            if (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName]) {
                factMoneyByMonth[m] += planfixData[m.toString()][cat.planfixName].sum || 0;
            }
        });
    }

    // 1. Таблица ФАКТ (v2)
    categories.forEach(cat => {
        dataMap.fact[cat.name] = [];
        let rFact = document.createElement('tr');
        rFact.innerHTML = `<td>${cat.name}</td>`;
        let factYearTotal = 0;

        for(let m = 1; m <= 12; m++) {
            let factVal = 0;
            if (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName]) {
                factVal = planfixData[m.toString()][cat.planfixName].m2;
            }
            dataMap.fact[cat.name][m] = factVal;
            factYearTotal += factVal;
            rFact.innerHTML += `<td>${formatNumber(factVal)}</td>`;
        }

        rFact.innerHTML += `<td><strong>${formatNumber(factYearTotal)}</strong></td>`;
        tbodyFact.appendChild(rFact);
        totalFact += factYearTotal;
    });

    // Строка денег вверху для факта
    let moneyRowFact = document.createElement('tr');
    moneyRowFact.style.background = '#fce4d6';
    moneyRowFact.innerHTML = `<td><strong>Факт Техновид, в тенге</strong></td>`;
    let moneyFactYear = 0;
    for(let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m];
        moneyFactYear += fM;
        moneyRowFact.innerHTML += `<td><strong>${formatNumber(fM)}</strong></td>`;
    }
    moneyRowFact.innerHTML += `<td><strong>${formatNumber(moneyFactYear)}</strong></td>`;
    tbodyFact.insertBefore(moneyRowFact, tbodyFact.firstChild);

    // 2. Таблица ПЛАН ОПТИМИСТ (v2)
    let moneyOptByMonth = {};
    categories.forEach(cat => {
        dataMap.opt[cat.name] = [];
        let rOpt = document.createElement('tr');
        rOpt.innerHTML = `<td>${cat.name}</td>`;
        let optYearTotal = 0;

        for(let m = 1; m <= 12; m++) {
            let optVal = parseValue(sheetData[cat.optRow][m + 1]);
            dataMap.opt[cat.name][m] = optVal;
            optYearTotal += optVal;
            rOpt.innerHTML += `<td>${formatNumber(optVal)}</td>`;
        }

        rOpt.innerHTML += `<td><strong>${formatNumber(optYearTotal)}</strong></td>`;
        tbodyOpt.appendChild(rOpt);
        totalOpt += optYearTotal;
    });

    // Строка денег внизу для плана Оптимист
    let moneyRowOpt = document.createElement('tr');
    moneyRowOpt.style.background = '#e6f4ea';
    moneyRowOpt.innerHTML = `<td><strong>План, в тенге</strong></td>`;
    let moneyOptYear = 0;
    for(let m = 1; m <= 12; m++) {
        let valO = parseValue(sheetData[7][m + 1]);
        moneyOptByMonth[m] = valO;
        moneyOptYear += valO;
        moneyRowOpt.innerHTML += `<td><strong>${formatNumber(valO)}</strong></td>`;
    }
    moneyRowOpt.innerHTML += `<td><strong>${formatNumber(moneyOptYear)}</strong></td>`;
    tbodyOpt.appendChild(moneyRowOpt);

    // 3. Таблица ФАКТ НАКОПИТЕЛЬНЫЙ (v2)
    let cumFactRow = document.createElement('tr');
    cumFactRow.style.background = '#fce4d6';
    cumFactRow.innerHTML = `<td><strong>Факт Техновид, в тенге</strong></td>`;
    let cumFact = 0;
    let lastFactMonth = 0;
    for(let m = 1; m <= 12; m++) {
        if (!!planfixData[m.toString()]) {
            lastFactMonth = m;
        }
    }

    for(let m = 1; m <= 12; m++) {
        if (m <= lastFactMonth) {
            cumFact += factMoneyByMonth[m] || 0;
            cumFactRow.innerHTML += `<td><strong>${formatNumber(cumFact)}</strong></td>`;
        } else {
            cumFactRow.innerHTML += `<td>-</td>`;
        }
    }
    if (lastFactMonth > 0) {
        cumFactRow.innerHTML += `<td><strong>${formatNumber(cumFact)}</strong></td>`;
    } else {
        cumFactRow.innerHTML += `<td>-</td>`;
    }
    tbodyCumFact.appendChild(cumFactRow);

    // 4. Таблица ПЛАН НАКОПИТЕЛЬНЫЙ ОПТИМИСТ (v2)
    let cumOptRow = document.createElement('tr');
    cumOptRow.style.background = '#e2efda';
    cumOptRow.innerHTML = `<td><strong>План Оптимист, в тенге</strong></td>`;
    let cumOpt = 0;
    for(let m = 1; m <= 12; m++) {
        cumOpt += moneyOptByMonth[m] || 0;
        cumOptRow.innerHTML += `<td><strong>${formatNumber(cumOpt)}</strong></td>`;
    }
    cumOptRow.innerHTML += `<td><strong>${formatNumber(cumOpt)}</strong></td>`;
    tbodyCumOpt.appendChild(cumOptRow);

    // Сводные карточки v2
    document.getElementById('v2-val-opt-m2').innerText = formatNumber(totalOpt);
    document.getElementById('v2-val-fact-m2').innerText = formatNumber(totalFact);
    const pct = totalOpt > 0 ? Math.round((totalFact / totalOpt) * 100) : 0;
    document.getElementById('v2-val-pct-opt').innerText = pct > 0 ? pct + "%" : "--";
}

// ================= ОТРИСОВКА ВКЛАДКИ V1 (ПОЛНАЯ АНАЛИТИКА) =================
function renderDashboardV1(sheetData, planfixData) {
    const categories = [
        {name: "Алюм, м2", optRow: 3, realRow: 12, planfixName: "Алюм"},
        {name: "ПВХ, м2", optRow: 4, realRow: 13, planfixName: "ПВХ"},
        {name: "СП, м2", optRow: 5, realRow: 14, planfixName: "СП"},
        {name: "НВФ, м2", optRow: 6, realRow: 15, planfixName: "НВФ"}
    ];

    let totalOpt = 0;
    let totalReal = 0;
    let totalFact = 0;

    const tbodyOpt = document.querySelector('#v1-table-opt tbody');
    const tbodyReal = document.querySelector('#v1-table-real tbody');
    const tbodyFact = document.querySelector('#v1-table-fact tbody');
    const tbodyDiffOpt = document.querySelector('#v1-table-diff-opt tbody');
    const tbodyDiffReal = document.querySelector('#v1-table-diff-real tbody');
    const tbodyCumulative = document.querySelector('#v1-table-cumulative tbody');

    tbodyOpt.innerHTML = '';
    tbodyReal.innerHTML = '';
    tbodyFact.innerHTML = '';
    tbodyDiffOpt.innerHTML = '';
    tbodyDiffReal.innerHTML = '';
    if (tbodyCumulative) tbodyCumulative.innerHTML = '';

    let dataMap = { opt: {}, real: {}, fact: {} };

    // Расчет сумм по факту в тенге
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
        dataMap.opt[cat.name] = [];
        dataMap.real[cat.name] = [];
        dataMap.fact[cat.name] = [];

        let rOpt = document.createElement('tr');
        rOpt.innerHTML = `<td>${cat.name}</td>`;
        let optYearTotal = 0;

        let rReal = document.createElement('tr');
        rReal.innerHTML = `<td>${cat.name}</td>`;
        let realYearTotal = 0;

        let rFact = document.createElement('tr');
        rFact.innerHTML = `<td>${cat.name}</td>`;
        let factYearTotal = 0;

        for(let m = 1; m <= 12; m++) {
            let optVal = parseValue(sheetData[cat.optRow][m + 1]);
            dataMap.opt[cat.name][m] = optVal;
            optYearTotal += optVal;
            rOpt.innerHTML += `<td>${formatNumber(optVal)}</td>`;

            let realVal = parseValue(sheetData[cat.realRow][m + 1]);
            dataMap.real[cat.name][m] = realVal;
            realYearTotal += realVal;
            rReal.innerHTML += `<td>${formatNumber(realVal)}</td>`;

            let factVal = 0;
            if (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName]) {
                factVal = planfixData[m.toString()][cat.planfixName].m2;
            }
            dataMap.fact[cat.name][m] = factVal;
            factYearTotal += factVal;
            rFact.innerHTML += `<td>${formatNumber(factVal)}</td>`;
        }

        rOpt.innerHTML += `<td><strong>${formatNumber(optYearTotal)}</strong></td>`;
        rReal.innerHTML += `<td><strong>${formatNumber(realYearTotal)}</strong></td>`;
        rFact.innerHTML += `<td><strong>${formatNumber(factYearTotal)}</strong></td>`;

        tbodyOpt.appendChild(rOpt);
        tbodyReal.appendChild(rReal);
        tbodyFact.appendChild(rFact);

        totalOpt += optYearTotal;
        totalReal += realYearTotal;
        totalFact += factYearTotal;
    });

    // ПЛАН ДЕНЬГИ ОПТИМИСТ
    let moneyRowOpt = document.createElement('tr');
    moneyRowOpt.style.background = '#e6f4ea';
    moneyRowOpt.innerHTML = `<td><strong>План, в тенге</strong></td>`;
    let moneyOptYear = 0;
    
    // ПЛАН ДЕНЬГИ РЕАЛИСТ
    let moneyRowReal = document.createElement('tr');
    moneyRowReal.style.background = '#e6f4ea';
    moneyRowReal.innerHTML = `<td><strong>План, в тенге</strong></td>`;
    let moneyRealYear = 0;

    let moneyOptByMonth = {};
    let moneyRealByMonth = {};

    for(let m = 1; m <= 12; m++) {
        let valO = parseValue(sheetData[7][m + 1]);
        moneyOptByMonth[m] = valO;
        moneyOptYear += valO;
        moneyRowOpt.innerHTML += `<td><strong>${formatNumber(valO)}</strong></td>`;

        let valR = parseValue(sheetData[16][m + 1]);
        moneyRealByMonth[m] = valR;
        moneyRealYear += valR;
        moneyRowReal.innerHTML += `<td><strong>${formatNumber(valR)}</strong></td>`;
    }
    moneyRowOpt.innerHTML += `<td><strong>${formatNumber(moneyOptYear)}</strong></td>`;
    moneyRowReal.innerHTML += `<td><strong>${formatNumber(moneyRealYear)}</strong></td>`;

    tbodyOpt.appendChild(moneyRowOpt);
    tbodyReal.appendChild(moneyRowReal);

    // ФАКТ ДЕНЬГИ (Вставляет вверх таблицы факта)
    let moneyRowFact = document.createElement('tr');
    moneyRowFact.style.background = '#fce4d6';
    moneyRowFact.innerHTML = `<td><strong>Факт Техновид, в тенге</strong></td>`;
    let moneyFactYear = 0;
    for(let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m];
        moneyFactYear += fM;
        moneyRowFact.innerHTML += `<td><strong>${formatNumber(fM)}</strong></td>`;
    }
    moneyRowFact.innerHTML += `<td><strong>${formatNumber(moneyFactYear)}</strong></td>`;
    tbodyFact.insertBefore(moneyRowFact, tbodyFact.firstChild);

    // ОТКЛОНЕНИЯ ОПТИМИСТ
    let diffMoneyOptRow = document.createElement('tr');
    diffMoneyOptRow.style.background = '#ddebf7';
    diffMoneyOptRow.innerHTML = `<td><strong>Договора, в тенге</strong></td>`;
    let diffMoneyOptYear = 0;
    for(let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m];
        let oM = moneyOptByMonth[m];
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
        
        for(let m = 1; m <= 12; m++) {
            let f = dataMap.fact[cat.name][m];
            let o = dataMap.opt[cat.name][m];
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

    // ОТКЛОНЕНИЯ РЕАЛИСТ
    let diffMoneyRealRow = document.createElement('tr');
    diffMoneyRealRow.style.background = '#ddebf7';
    diffMoneyRealRow.innerHTML = `<td><strong>Договора, в тенге</strong></td>`;
    let diffMoneyRealYear = 0;
    for(let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m];
        let rM = moneyRealByMonth[m];
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

        for(let m = 1; m <= 12; m++) {
            let f = dataMap.fact[cat.name][m];
            let r = dataMap.real[cat.name][m];
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

    // НАКОПИТЕЛЬНЫЕ ИТОГИ v1
    if (tbodyCumulative) {
        // Cumulative Opt
        let cumOptRow = document.createElement('tr');
        cumOptRow.style.background = '#e2efda';
        cumOptRow.innerHTML = `<td><strong>План Оптимист, в тенге</strong></td>`;
        let cumOpt = 0;
        for(let m = 1; m <= 12; m++) {
            cumOpt += moneyOptByMonth[m] || 0;
            cumOptRow.innerHTML += `<td><strong>${formatNumber(cumOpt)}</strong></td>`;
        }
        cumOptRow.innerHTML += `<td><strong>${formatNumber(cumOpt)}</strong></td>`;
        tbodyCumulative.appendChild(cumOptRow);

        // Cumulative Real
        let cumRealRow = document.createElement('tr');
        cumRealRow.style.background = '#ddebf7';
        cumRealRow.innerHTML = `<td><strong>План Реалист, в тенге</strong></td>`;
        let cumReal = 0;
        for(let m = 1; m <= 12; m++) {
            cumReal += moneyRealByMonth[m] || 0;
            cumRealRow.innerHTML += `<td><strong>${formatNumber(cumReal)}</strong></td>`;
        }
        cumRealRow.innerHTML += `<td><strong>${formatNumber(cumReal)}</strong></td>`;
        tbodyCumulative.appendChild(cumRealRow);

        // Cumulative Fact
        let cumFactRow = document.createElement('tr');
        cumFactRow.style.background = '#fce4d6';
        cumFactRow.innerHTML = `<td><strong>Факт Техновид, в тенге</strong></td>`;
        let cumFact = 0;
        let lastFactMonth = 0;
        for(let m = 1; m <= 12; m++) {
            if (!!planfixData[m.toString()]) {
                lastFactMonth = m;
            }
        }

        for(let m = 1; m <= 12; m++) {
            if (m <= lastFactMonth) {
                cumFact += factMoneyByMonth[m] || 0;
                cumFactRow.innerHTML += `<td><strong>${formatNumber(cumFact)}</strong></td>`;
            } else {
                cumFactRow.innerHTML += `<td>-</td>`;
            }
        }
        if (lastFactMonth > 0) {
            cumFactRow.innerHTML += `<td><strong>${formatNumber(cumFact)}</strong></td>`;
        } else {
            cumFactRow.innerHTML += `<td>-</td>`;
        }
        tbodyCumulative.appendChild(cumFactRow);
    }

    // Сводные карточки v1
    document.getElementById('v1-val-opt-m2').innerText = formatNumber(totalOpt);
    document.getElementById('v1-val-real-m2').innerText = formatNumber(totalReal);
    document.getElementById('v1-val-fact-m2').innerText = formatNumber(totalFact);
}
