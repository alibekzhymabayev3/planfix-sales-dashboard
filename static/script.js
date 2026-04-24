document.addEventListener('DOMContentLoaded', () => {
    loadData();

    document.getElementById('btn-sync').addEventListener('click', () => {
        const btn = document.getElementById('btn-sync');
        btn.disabled = true;
        btn.innerText = 'Обновление... (может занять 10-15 сек)';
        
        fetch('/api/sync', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    loadData(); // re-fetch and re-render
                } else {
                    alert('Ошибка при обновлении: ' + data.error);
                }
            })
            .catch(err => {
                alert('Ошибка сети при обновлении');
                console.error(err);
            })
            .finally(() => {
                btn.disabled = false;
                btn.innerText = '🔄 Обновить данные';
            });
    });
});

function loadData() {
    fetch('/api/data')
        .then(res => res.json())
        .then(data => {
            renderDashboard(data.excel_sheet, data.planfix_fact);
            
            if (data.last_sync) {
                document.getElementById('last-sync-time').innerText = 'Обновлено из Планфикса: ' + data.last_sync;
            } else {
                document.getElementById('last-sync-time').innerText = 'Загружено';
            }
        })
        .catch(err => {
            console.error("Error fetching data:", err);
            document.getElementById('last-sync-time').innerText = 'Ошибка загрузки';
        });
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

function renderDashboard(sheetData, planfixData) {
    if(!sheetData || !planfixData) return;
    
    const categories = [
        {name: "Алюм, м2", optRow: 3, realRow: 12, planfixName: "Алюм"},
        {name: "ПВХ, м2", optRow: 4, realRow: 13, planfixName: "ПВХ"},
        {name: "СП, м2", optRow: 5, realRow: 14, planfixName: "СП"},
        {name: "НВФ, м2", optRow: 6, realRow: 15, planfixName: "НВФ"}
    ];

    const months = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь", "Итого за 12 мес"];
    
    // Fill headers
    document.querySelectorAll('.months-header').forEach(headerRow => {
        headerRow.innerHTML = `<th>Показатель</th>` + months.map(m => `<th>${m}</th>`).join('');
    });

    let totalOpt = 0;
    let totalReal = 0;
    let totalFact = 0;

    // Format diff utility
    function formatDiff(val) {
        if (val === 0) return "-";
        let str = new Intl.NumberFormat('ru-RU').format(Math.round(val));
        if (val > 0) return "+" + str;
        return str;
    }

    const tbodyOpt = document.querySelector('#table-opt tbody');
    const tbodyReal = document.querySelector('#table-real tbody');
    const tbodyFact = document.querySelector('#table-fact tbody');
    const tbodyDiffOpt = document.querySelector('#table-diff-opt tbody');
    const tbodyDiffReal = document.querySelector('#table-diff-real tbody');

    // Clear existing rows to prevent duplication on re-fetch
    tbodyOpt.innerHTML = '';
    tbodyReal.innerHTML = '';
    tbodyFact.innerHTML = '';
    tbodyDiffOpt.innerHTML = '';
    tbodyDiffReal.innerHTML = '';

    let dataMap = {
        opt: {}, real: {}, fact: {}
    };

    // Calculate facts totals including MONEY
    let factMoneyByMonth = {};
    for (let m = 1; m <= 12; m++) {
        factMoneyByMonth[m] = 0;
        categories.forEach(cat => {
            if (planfixData[m.toString()] && planfixData[m.toString()][cat.planfixName]) {
                factMoneyByMonth[m] += planfixData[m.toString()][cat.planfixName].sum || 0;
            }
        });
    }

    // Render Money Rows first (optional, or after categories)
    // Excel usually shows Money row at the bottom of the section. We'll do it before categories for Fact, and after for Plans. Actually, in excel screenshot:
    // Plans: bottom of section
    // Fact: TOP of section
    // Analysis: TOP of section

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

    // PLAN MONEY ROW
    let moneyRowOpt = document.createElement('tr');
    moneyRowOpt.style.background = '#e6f4ea';
    moneyRowOpt.innerHTML = `<td><strong>План, в тенге</strong></td>`;
    let moneyOptYear = 0;
    
    let moneyRowReal = document.createElement('tr');
    moneyRowReal.style.background = '#e6f4ea';
    moneyRowReal.innerHTML = `<td><strong>План, в тенге</strong></td>`;
    let moneyRealYear = 0;

    let moneyOptByMonth = {};
    let moneyRealByMonth = {};

    for(let m = 1; m <= 12; m++) {
        let valO = parseValue(sheetData[7][m + 1]); // Row 7 is money (Optimist)
        moneyOptByMonth[m] = valO;
        moneyOptYear += valO;
        moneyRowOpt.innerHTML += `<td><strong>${formatNumber(valO)}</strong></td>`;

        let valR = parseValue(sheetData[16][m + 1]); // Row 16 is money (Realist)
        moneyRealByMonth[m] = valR;
        moneyRealYear += valR;
        moneyRowReal.innerHTML += `<td><strong>${formatNumber(valR)}</strong></td>`;
    }
    moneyRowOpt.innerHTML += `<td><strong>${formatNumber(moneyOptYear)}</strong></td>`;
    moneyRowReal.innerHTML += `<td><strong>${formatNumber(moneyRealYear)}</strong></td>`;

    tbodyOpt.appendChild(moneyRowOpt);
    tbodyReal.appendChild(moneyRowReal);

    // FACT MONEY ROW (Insert at top of tbodyFact)
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

    // ANALYSIS TABLES

    // Analysis Money Opt
    let diffMoneyOptRow = document.createElement('tr');
    diffMoneyOptRow.style.background = '#ddebf7';
    diffMoneyOptRow.innerHTML = `<td><strong>Договора, в тенге</strong></td>`;
    let diffMoneyOptYear = 0;
    for(let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m];
        let oM = moneyOptByMonth[m];
        let d = fM !== 0 || oM !== 0 ? fM - oM : 0;
        diffMoneyOptYear += d;
        diffMoneyOptRow.innerHTML += `<td class="${d < 0 ? 'val-negative' : (d > 0 ? 'val-positive' : '')}"><strong>${formatDiff(d)}</strong></td>`;
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
            let doVal = f !== 0 || o !== 0 ? f - o : 0;
            diffOptYear += doVal;
            rDiffOpt.innerHTML += `<td class="${doVal < 0 ? 'val-negative' : (doVal > 0 ? 'val-positive' : '')}">${formatDiff(doVal)}</td>`;
        }
        rDiffOpt.innerHTML += `<td class="${diffOptYear < 0 ? 'val-negative' : ''}"><strong>${formatDiff(diffOptYear)}</strong></td>`;
        tbodyDiffOpt.appendChild(rDiffOpt);
    });

    // Analysis Money Real
    let diffMoneyRealRow = document.createElement('tr');
    diffMoneyRealRow.style.background = '#ddebf7';
    diffMoneyRealRow.innerHTML = `<td><strong>Договора, в тенге</strong></td>`;
    let diffMoneyRealYear = 0;
    for(let m = 1; m <= 12; m++) {
        let fM = factMoneyByMonth[m];
        let rM = moneyRealByMonth[m];
        let d = fM !== 0 || rM !== 0 ? fM - rM : 0;
        diffMoneyRealYear += d;
        diffMoneyRealRow.innerHTML += `<td class="${d < 0 ? 'val-negative' : (d > 0 ? 'val-positive' : '')}"><strong>${formatDiff(d)}</strong></td>`;
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
            let drVal = f !== 0 || r !== 0 ? f - r : 0;
            diffRealYear += drVal;
            rDiffReal.innerHTML += `<td class="${drVal < 0 ? 'val-negative' : (drVal > 0 ? 'val-positive' : '')}">${formatDiff(drVal)}</td>`;
        }
        rDiffReal.innerHTML += `<td class="${diffRealYear < 0 ? 'val-negative' : ''}"><strong>${formatDiff(diffRealYear)}</strong></td>`;
        tbodyDiffReal.appendChild(rDiffReal);
    });

    document.getElementById('val-opt-m2').innerText = formatNumber(totalOpt);
    document.getElementById('val-real-m2').innerText = formatNumber(totalReal);
    document.getElementById('val-fact-m2').innerText = formatNumber(totalFact);
}
