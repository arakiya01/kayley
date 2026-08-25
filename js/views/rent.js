import {
  getRentUtilityEntry, findPreviousRentUtilityEntry, upsertRentUtilityEntry,
  computeUtilityPersonalTotal, computeRentBackingStatus, getMeta, getFoundingDate,
} from '../db.js';
import {
  yen, monthLabel, monthShort, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading, todayYearMonth,
} from '../format.js';
import { renderFySelector } from './fyselector.js';
import { enableGridPaste } from './gridpaste.js';
import { lineChart } from '../charts.js';
import { changeStrip } from '../changestrip.js';
import { bankBadgeHtml } from '../bankbadge.js';
import { seriesColor } from '../colors.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';

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
    <div id="single-month-slot" style="${bulkMode ? 'display:none' : ''}">
      <div class="rent-document-grid">
      <div class="card rent-card">
        <div class="card-header">
          <div class="card-header-title"><h2>家賃</h2><span id="rent-bank-badge"></span></div>
          <div class="toolbar"><button class="btn ghost bulk-toggle-btn">📋 一括入力（年度）</button></div>
        </div>
        <div id="carry-notice-slot"></div>
        <div class="card-note">全体の家賃実額と、個人負担分（固定額）を入力します。完了印は、この月の家賃・水道光熱費が入力されると付きます。</div>
        <div class="field-row">
          <div class="field-label">家賃（全体・実額）</div>
          <div class="field-value">
            <input type="text" inputmode="numeric" class="currency-input" id="rent_total">
            <span class="field-suffix">円</span>
          </div>
        </div>
        <div class="field-row">
          <div class="field-label">家賃（個人負担・固定）<span class="hint">按分契約上の固定額</span></div>
          <div class="field-value">
            <input type="text" inputmode="numeric" class="currency-input" id="rent_personal_fixed">
            <span class="field-suffix">円</span>
          </div>
        </div>
      </div>
      <div class="card utility-card">
        <h2>光熱費</h2>
        <div class="card-note">全体の請求額と、個人負担割合（％）から個人負担額を自動計算します。</div>
        ${FIELDS.map((f) => `
          <div class="field-row">
            <div class="field-label">${f.label}（全体）</div>
            <div class="field-value">
              <input type="text" inputmode="numeric" class="currency-input" id="${f.totalKey}">
              <span class="field-suffix">円</span>
              <input type="number" id="${f.pctKey}" step="1" style="flex:0 1 70px">
              <span class="field-suffix">％負担 → <span class="num" id="${f.key}-personal">0</span>円</span>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="card rent-summary-card">
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
    </div>
    ${bulkMode ? `<div class="toolbar"><span class="spacer"></span><button class="btn ghost bulk-toggle-btn">月次入力に戻る</button></div>` : ''}
    <div id="bulk-slot"></div>
    <div class="card">
      <h2>光熱費の推移</h2>
      <div class="card-note">水道・ガス・電気の個人負担額（円）・${fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate())}</div>
      <div id="utility-trend-chart"></div>
    </div>
    <div class="card">
      <h2>家賃の変化</h2>
      <div class="card-note" style="margin-bottom:2px">${fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate())}</div>
      <div class="card-note">家賃は契約で固定のため、前月と同じ月は＝で示し、変わった月だけ差額を出しています。</div>
      <div id="rent-trend-chart"></div>
    </div>
  `;

  container.querySelectorAll('.bulk-toggle-btn').forEach((btn) => btn.addEventListener('click', () => {
    bulkMode = !bulkMode;
    render(container, ctx);
  }));

  if (bulkMode) {
    renderBulkTable();
    renderChart();
    return;
  }

  const existing = getRentUtilityEntry(year, month);
  const previousEntry = existing ? null : findPreviousRentUtilityEntry(year, month);
  let carriedFrom = previousEntry ? { year: previousEntry.year, month: previousEntry.month } : null;
  const state = existing ? { ...existing } : previousEntry ? {
    rent_total: previousEntry.entry.rent_total,
    rent_personal_fixed: previousEntry.entry.rent_personal_fixed,
    water_total: 0, water_personal_pct: previousEntry.entry.water_personal_pct,
    gas_total: 0, gas_personal_pct: previousEntry.entry.gas_personal_pct,
    electricity_total: 0, electricity_personal_pct: previousEntry.entry.electricity_personal_pct,
  } : {
    rent_total: 0, rent_personal_fixed: 0,
    water_total: 0, water_personal_pct: defaultPct,
    gas_total: 0, gas_personal_pct: defaultPct,
    electricity_total: 0, electricity_personal_pct: defaultPct,
  };

  if (carriedFrom) {
    container.querySelector('#carry-notice-slot').innerHTML = `
      <div class="carry-notice" id="carry-notice">
        <span class="carry-notice-text">${monthLabel(carriedFrom.year, carriedFrom.month)}の家賃と按分率を引き継いでいます。光熱費の請求額は毎月変わるので入力してください。</span>
        <button class="btn primary" id="carry-confirm-btn">この内容で確定する</button>
      </div>`;
    ['rent_total', 'rent_personal_fixed', ...FIELDS.map((f) => f.pctKey)]
      .forEach((id) => container.querySelector(`#${id}`).classList.add('carried'));
  }

  container.querySelector('#rent_total').value = state.rent_total;
  container.querySelector('#rent_personal_fixed').value = state.rent_personal_fixed;
  FIELDS.forEach((f) => {
    container.querySelector(`#${f.totalKey}`).value = state[f.totalKey];
    container.querySelector(`#${f.pctKey}`).value = state[f.pctKey];
  });
  container.querySelectorAll('#rent_total, #rent_personal_fixed, input[id$="_total"]').forEach(enableCurrencyInput);

  function readEntry() {
    const entry = {
      year, month,
      rent_total: parseCurrencyInput(container.querySelector('#rent_total').value),
      rent_personal_fixed: parseCurrencyInput(container.querySelector('#rent_personal_fixed').value),
    };
    FIELDS.forEach((f) => {
      entry[f.totalKey] = parseCurrencyInput(container.querySelector(`#${f.totalKey}`).value);
      entry[f.pctKey] = Number(container.querySelector(`#${f.pctKey}`).value) || 0;
    });
    return entry;
  }

  function updateDisplay(entry) {
    FIELDS.forEach((f) => {
      const personal = Math.round(entry[f.totalKey] * entry[f.pctKey] / 100);
      container.querySelector(`#${f.key}-personal`).textContent = yen(personal);
    });
    const utilityPersonalTotal = computeUtilityPersonalTotal(entry);
    container.querySelector('#utility-personal-total').innerHTML = `${yen(utilityPersonalTotal)}<span class="unit">円</span>`;
    container.querySelector('#grand-personal-total').innerHTML = `${yen(utilityPersonalTotal + entry.rent_personal_fixed)}<span class="unit">円</span>`;
    container.querySelector('#rent-bank-badge').innerHTML = bankBadgeHtml(computeRentBackingStatus(year, month));
  }

  // タブを開いただけ（未入力）では保存しない。実際に値を変更したときだけ upsert する
  // （そうしないと「済」チェックリストが未入力でも済扱いになってしまうため）。
  function recomputeAndSave() {
    const entry = readEntry();
    upsertRentUtilityEntry(entry);
    if (carriedFrom) {
      carriedFrom = null;
      // 引き継ぎ状態が解けたので案内と薄字表示を消す（入力欄の値とフォーカスはそのまま）
      container.querySelector('#carry-notice')?.remove();
      container.querySelectorAll('.carried').forEach((el) => el.classList.remove('carried'));
    }
    updateDisplay(entry);
    renderChart();
  }

  container.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', recomputeAndSave);
  });
  container.querySelector('#carry-confirm-btn')?.addEventListener('click', recomputeAndSave);
  updateDisplay(readEntry());
  renderChart();

  function renderChart() {
    const months = fiscalYearMonths(fiscalYearStartOf(year, month, fyStartMonth), fyStartMonth);
    const highlightIndex = months.findIndex((m) => m.year === year && m.month === month);
    const xLabels = months.map((m) => monthShort(m.month));
    const changeLabels = months.map((m) => monthLabel(m.year, m.month));
    const today = todayYearMonth();
    const todayIdx = today.year * 12 + today.month;
    const isFuture = (m) => m.year * 12 + m.month > todayIdx;
    const rentTotalSeries = [];
    const rentPersonalSeries = [];
    months.forEach((m) => {
      if (isFuture(m)) { rentTotalSeries.push(null); rentPersonalSeries.push(null); return; }
      const e = getRentUtilityEntry(m.year, m.month);
      // 未入力の月は0ではなくデータなしとして扱う。0を入れてしまうと、
      // 最初に実績が入った月が「0からの変化」として拾われてしまうため。
      rentTotalSeries.push(e ? e.rent_total : null);
      rentPersonalSeries.push(e ? e.rent_personal_fixed : null);
    });
    changeStrip(container.querySelector('#rent-trend-chart'), {
      xLabels,
      fullLabels: changeLabels,
      highlightIndex,
      rows: [
        { label: '家賃（全体）', values: rentTotalSeries },
        { label: '家賃（個人負担）', values: rentPersonalSeries },
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
                    return `<td class="num"><input type="${isPct ? 'number' : 'text'}" ${isPct ? '' : 'inputmode="numeric"'} class="bulk-rent-input${isPct ? '' : ' currency-input'}" data-key="${row.key}" data-year="${m.year}" data-month="${m.month}" value="${value}"></td>`;
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
    slot.querySelectorAll('.bulk-rent-input.currency-input').forEach(enableCurrencyInput);

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
        const value = input.dataset.key.endsWith('_personal_pct') ? Number(input.value) || 0 : parseCurrencyInput(input.value);
        const updated = { ...existingEntry, year: y, month: m, [input.dataset.key]: value };
        upsertRentUtilityEntry(updated);
        renderChart();
      });
    });
  }
}
