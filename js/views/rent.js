import { getRentUtilityEntry, upsertRentUtilityEntry, computeUtilityPersonalTotal, getMeta, getFoundingDate } from '../db.js';
import {
  yen, monthShort, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading, todayYearMonth,
} from '../format.js';
import { renderMonthBar } from './monthbar.js';
import { renderFySelector } from './fyselector.js';
import { enableGridPaste } from './gridpaste.js';
import { lineChart } from '../charts.js';
import { seriesColor } from '../colors.js';

const FIELDS = [
  { key: 'water', label: '水道', totalKey: 'water_total', pctKey: 'water_personal_pct' },
  { key: 'gas', label: 'ガス', totalKey: 'gas_total', pctKey: 'gas_personal_pct' },
  { key: 'electricity', label: '電気', totalKey: 'electricity_total', pctKey: 'electricity_personal_pct' },
];

const BULK_ROWS = [
  { key: 'rent_total', label: '家賃（全体）' },
  { key: 'rent_personal_fixed', label: '家賃（個人固定）' },
  { key: 'water_total', label: '水道（全体）' },
  { key: 'water_personal_pct', label: '水道（％）' },
  { key: 'gas_total', label: 'ガス（全体）' },
  { key: 'gas_personal_pct', label: 'ガス（％）' },
  { key: 'electricity_total', label: '電気（全体）' },
  { key: 'electricity_personal_pct', label: '電気（％）' },
];

let bulkMode = false;
let bulkFyStartYear = null;

export function render(container, ctx) {
  const { year, month } = ctx;
  const defaultPct = Number(getMeta('default_utility_personal_pct') || 40);
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  if (bulkFyStartYear == null) bulkFyStartYear = fiscalYearStartOf(year, month, fyStartMonth);

  container.innerHTML = `
    <div id="month-bar-slot" style="${bulkMode ? 'display:none' : ''}"></div>
    <div class="toolbar">
      <span class="spacer"></span>
      <button class="btn ghost" id="bulk-toggle-btn">${bulkMode ? '月次入力に戻る' : '📋 一括入力（年度）'}</button>
    </div>
    <div id="single-month-slot" style="${bulkMode ? 'display:none' : ''}">
      <div class="card">
        <h2>家賃</h2>
        <div class="card-note">全体の家賃実額と、個人負担分（固定額）を入力します。</div>
        <div class="field-row">
          <div class="field-label">家賃（全体・実額）</div>
          <div class="field-value">
            <input type="number" id="rent_total" step="1">
            <span class="field-suffix">円</span>
          </div>
        </div>
        <div class="field-row">
          <div class="field-label">家賃（個人負担・固定）<span class="hint">按分契約上の固定額</span></div>
          <div class="field-value">
            <input type="number" id="rent_personal_fixed" step="1">
            <span class="field-suffix">円</span>
          </div>
        </div>
      </div>
      <div class="card">
        <h2>光熱費</h2>
        <div class="card-note">全体の請求額と、個人負担割合（％）から個人負担額を自動計算します。</div>
        ${FIELDS.map((f) => `
          <div class="field-row">
            <div class="field-label">${f.label}（全体）</div>
            <div class="field-value">
              <input type="number" id="${f.totalKey}" step="1">
              <span class="field-suffix">円</span>
              <input type="number" id="${f.pctKey}" step="1" style="flex:0 1 70px">
              <span class="field-suffix">％負担 → <span class="num" id="${f.key}-personal">0</span>円</span>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="card">
        <h2>当月の個人負担まとめ</h2>
        <div class="card-note">この金額は、翌月の役員報酬明細で自動的に控除項目として反映されます（実績確定が翌月になるため）。</div>
        <div class="card-grid">
          <div class="stat-tile">
            <div class="label">光熱費 個人負担計</div>
            <div class="value num" id="utility-personal-total">0<span class="unit">円</span></div>
          </div>
          <div class="stat-tile">
            <div class="label">家賃・光熱費 個人負担合計</div>
            <div class="value num" id="grand-personal-total">0<span class="unit">円</span></div>
          </div>
        </div>
      </div>
    </div>
    <div id="bulk-slot"></div>
    <div class="card">
      <h2>個人負担額の推移</h2>
      <div class="card-note">${fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate())}</div>
      <div id="rent-trend-chart"></div>
    </div>
    <div class="card">
      <h2>光熱費の推移</h2>
      <div class="card-note">水道・ガス・電気の個人負担額（円）・${fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate())}</div>
      <div id="utility-trend-chart"></div>
    </div>
  `;

  renderMonthBar(container.querySelector('#month-bar-slot'), {
    year, month, onChange: ctx.setMonth, showFinalize: true,
  });

  container.querySelector('#bulk-toggle-btn').addEventListener('click', () => {
    bulkMode = !bulkMode;
    render(container, ctx);
  });

  if (bulkMode) {
    renderBulkTable();
    renderChart();
    return;
  }

  const existing = getRentUtilityEntry(year, month);
  const state = existing ? { ...existing } : {
    rent_total: 0, rent_personal_fixed: 0,
    water_total: 0, water_personal_pct: defaultPct,
    gas_total: 0, gas_personal_pct: defaultPct,
    electricity_total: 0, electricity_personal_pct: defaultPct,
  };

  container.querySelector('#rent_total').value = state.rent_total;
  container.querySelector('#rent_personal_fixed').value = state.rent_personal_fixed;
  FIELDS.forEach((f) => {
    container.querySelector(`#${f.totalKey}`).value = state[f.totalKey];
    container.querySelector(`#${f.pctKey}`).value = state[f.pctKey];
  });

  function recomputeAndSave() {
    const entry = {
      year, month,
      rent_total: Number(container.querySelector('#rent_total').value) || 0,
      rent_personal_fixed: Number(container.querySelector('#rent_personal_fixed').value) || 0,
    };
    FIELDS.forEach((f) => {
      entry[f.totalKey] = Number(container.querySelector(`#${f.totalKey}`).value) || 0;
      entry[f.pctKey] = Number(container.querySelector(`#${f.pctKey}`).value) || 0;
    });
    upsertRentUtilityEntry(entry);

    FIELDS.forEach((f) => {
      const personal = Math.round(entry[f.totalKey] * entry[f.pctKey] / 100);
      container.querySelector(`#${f.key}-personal`).textContent = yen(personal);
    });
    const utilityPersonalTotal = computeUtilityPersonalTotal(entry);
    container.querySelector('#utility-personal-total').innerHTML = `${yen(utilityPersonalTotal)}<span class="unit">円</span>`;
    container.querySelector('#grand-personal-total').innerHTML = `${yen(utilityPersonalTotal + entry.rent_personal_fixed)}<span class="unit">円</span>`;
    renderChart();
  }

  container.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', recomputeAndSave);
  });
  recomputeAndSave();

  function renderChart() {
    const months = fiscalYearMonths(fiscalYearStartOf(year, month, fyStartMonth), fyStartMonth);
    const highlightIndex = months.findIndex((m) => m.year === year && m.month === month);
    const xLabels = months.map((m) => `${m.month}月`);
    const today = todayYearMonth();
    const todayIdx = today.year * 12 + today.month;
    const isFuture = (m) => m.year * 12 + m.month > todayIdx;
    const rentSeries = [];
    const utilitySeries = [];
    months.forEach((m) => {
      if (isFuture(m)) { rentSeries.push(null); utilitySeries.push(null); return; }
      const e = getRentUtilityEntry(m.year, m.month);
      rentSeries.push(e ? e.rent_personal_fixed : 0);
      utilitySeries.push(e ? computeUtilityPersonalTotal(e) : 0);
    });
    lineChart(container.querySelector('#rent-trend-chart'), {
      xLabels,
      highlightIndex,
      series: [
        { label: '家賃個人負担', color: seriesColor(0), values: rentSeries },
        { label: '光熱費個人負担', color: seriesColor(1), values: utilitySeries },
      ],
    });

    const waterSeries = [], gasSeries = [], elecSeries = [];
    months.forEach((m) => {
      if (isFuture(m)) { waterSeries.push(null); gasSeries.push(null); elecSeries.push(null); return; }
      const e = getRentUtilityEntry(m.year, m.month);
      waterSeries.push(e ? Math.round(e.water_total * e.water_personal_pct / 100) : 0);
      gasSeries.push(e ? Math.round(e.gas_total * e.gas_personal_pct / 100) : 0);
      elecSeries.push(e ? Math.round(e.electricity_total * e.electricity_personal_pct / 100) : 0);
    });
    lineChart(container.querySelector('#utility-trend-chart'), {
      xLabels,
      highlightIndex,
      series: [
        { label: '水道（個人負担）', color: seriesColor(1), values: waterSeries },
        { label: 'ガス（個人負担）', color: seriesColor(2), values: gasSeries },
        { label: '電気（個人負担）', color: seriesColor(0), values: elecSeries },
      ],
    });
  }

  function renderBulkTable() {
    const slot = container.querySelector('#bulk-slot');
    const months = fiscalYearMonths(bulkFyStartYear, fyStartMonth);

    slot.innerHTML = `
      <div class="card">
        <div id="fy-selector-slot"></div>
        <div class="bulk-table-wrap">
          <table class="ledger bulk-grid">
            <thead>
              <tr>
                <th>項目</th>
                ${months.map((m) => `<th class="num">${monthShort(m.month)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${BULK_ROWS.map((row) => `
                <tr>
                  <td>${row.label}</td>
                  ${months.map((m) => {
                    const entry = getRentUtilityEntry(m.year, m.month);
                    const isPct = row.key.endsWith('_personal_pct');
                    const value = entry ? entry[row.key] : (isPct ? defaultPct : 0);
                    return `<td class="num"><input type="number" class="bulk-rent-input" data-key="${row.key}" data-year="${m.year}" data-month="${m.month}" value="${value}"></td>`;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    renderFySelector(slot.querySelector('#fy-selector-slot'), {
      fyStartYear: bulkFyStartYear,
      fyStartMonth,
      foundingDate: getFoundingDate(),
      noteText: `1年度分の家賃・光熱費をまとめて入力できます。％欄は未入力ならデフォルト（${defaultPct}%）になります。`,
      onChange: (newFyStartYear) => {
        bulkFyStartYear = newFyStartYear;
        renderBulkTable();
      },
    });

    enableGridPaste(slot.querySelector('table.bulk-grid'), '.bulk-rent-input');

    slot.querySelectorAll('.bulk-rent-input').forEach((input) => {
      input.addEventListener('change', () => {
        const y = Number(input.dataset.year);
        const m = Number(input.dataset.month);
        const existingEntry = getRentUtilityEntry(y, m) || {
          rent_total: 0, rent_personal_fixed: 0,
          water_total: 0, water_personal_pct: defaultPct,
          gas_total: 0, gas_personal_pct: defaultPct,
          electricity_total: 0, electricity_personal_pct: defaultPct,
        };
        const updated = { ...existingEntry, year: y, month: m, [input.dataset.key]: Number(input.value) || 0 };
        upsertRentUtilityEntry(updated);
        renderChart();
      });
    });
  }
}
