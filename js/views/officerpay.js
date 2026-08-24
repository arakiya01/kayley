import {
  getOfficerPayEntry, upsertOfficerPayEntry, resolveOfficerDeductions, prevMonth, getMeta, getFoundingDate,
} from '../db.js';
import { yen, monthLabel, monthShort, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading, todayYearMonth } from '../format.js';
import { renderMonthBar } from './monthbar.js';
import { renderFySelector } from './fyselector.js';
import { enableGridPaste } from './gridpaste.js';
import { lineChart, donutChart } from '../charts.js';
import { seriesColor } from '../colors.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';

const DEDUCTION_FIELDS = [
  { key: 'health_insurance', label: '健康保険' },
  { key: 'nursing_care_insurance', label: '介護保険' },
  { key: 'pension', label: '厚生年金' },
  { key: 'child_support_levy', label: '子ども・子育て拠出金' },
  { key: 'withholding_tax', label: '源泉所得税' },
];

const BULK_FIELDS = [{ key: 'gross_pay', label: '支給額' }, ...DEDUCTION_FIELDS];

let bulkMode = false;
let bulkFyStartYear = null;

export function render(container, ctx) {
  const { year, month } = ctx;
  const prev = prevMonth(year, month);
  const deductions = resolveOfficerDeductions(year, month);
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  if (bulkFyStartYear == null) bulkFyStartYear = fiscalYearStartOf(year, month, fyStartMonth);

  container.innerHTML = `
    <div id="month-bar-slot" style="${bulkMode ? 'display:none' : ''}"></div>
    <div class="toolbar">
      <span class="spacer"></span>
      <button class="btn ghost" id="bulk-toggle-btn">${bulkMode ? '月次入力に戻る' : '📋 一括入力（年度）'}</button>
    </div>
    <div id="bulk-slot"></div>
    <div id="single-month-slot" style="${bulkMode ? 'display:none' : ''}">
      <div class="card payslip">
        <div class="payslip-header"><h2>役員報酬明細</h2><span>${monthLabel(year, month)}</span></div>
        <div class="payslip-grid">
          <section>
            <div class="section-heading">支給</div>
            <div class="compact-field"><label for="gross_pay">支給額</label><span><input type="text" inputmode="numeric" class="currency-input" id="gross_pay"><small>円</small></span></div>
            <button class="btn ghost" id="copy-prev-btn">前月の保険料等をコピー</button>
            <div class="section-heading payslip-balance-heading">差引</div>
            <div class="computed-line"><span>控除合計</span><strong class="num" id="deduction-total">0<span class="unit">円</span></strong></div>
            <div class="net-pay-line"><span>差引支給額</span><strong class="num" id="net-pay">0<span class="unit">円</span></strong></div>
          </section>
          <section>
            <div class="section-heading">控除</div>
            ${DEDUCTION_FIELDS.map((f) => `
              <div class="compact-field"><label for="${f.key}">${f.label}</label><span><input type="text" inputmode="numeric" class="currency-input" id="${f.key}"><small>円</small></span></div>
            `).join('')}
            <label class="auto-toggle"><input type="checkbox" id="use_auto"> 家賃・光熱費の自動反映を使う</label>
            <div class="card-note payslip-note">${deductions.has_source
              ? `${monthLabel(prev.year, prev.month)}分の台帳から自動反映しています。`
              : `${monthLabel(prev.year, prev.month)}分の台帳データがないため0円です。`}</div>
            <div id="manual-fields" style="display:none">
              <div class="compact-field"><label for="manual_rent_deduction">家賃控除（手入力）</label><span><input type="text" inputmode="numeric" class="currency-input" id="manual_rent_deduction"><small>円</small></span></div>
              <div class="compact-field"><label for="manual_utility_deduction">光熱費控除（手入力）</label><span><input type="text" inputmode="numeric" class="currency-input" id="manual_utility_deduction"><small>円</small></span></div>
            </div>
            <div class="auto-deductions">
              <div class="computed-line"><span>家賃控除</span><strong class="num" id="rent-deduction-display">0<span class="unit">円</span></strong></div>
              <div class="computed-line"><span>水道光熱費控除</span><strong class="num" id="utility-deduction-display">0<span class="unit">円</span></strong></div>
            </div>
          </section>
        </div>
      </div>
      <div class="card">
        <h2>当月の内訳</h2>
        <div id="pay-breakdown-chart"></div>
      </div>
    </div>
    <div class="card">
      <h2>支給額・差引支給額の推移</h2>
      <div class="card-note">${fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate())}</div>
      <div id="pay-trend-chart"></div>
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

  const existing = getOfficerPayEntry(year, month);
  const state = existing ? { ...existing } : {
    gross_pay: 0, health_insurance: 0, nursing_care_insurance: 0, pension: 0,
    child_support_levy: 0, withholding_tax: 0, use_auto_deduction: 1,
    manual_rent_deduction: 0, manual_utility_deduction: 0,
  };

  container.querySelector('#gross_pay').value = state.gross_pay;
  DEDUCTION_FIELDS.forEach((f) => { container.querySelector(`#${f.key}`).value = state[f.key]; });
  container.querySelector('#use_auto').checked = !!state.use_auto_deduction;
  container.querySelector('#manual_rent_deduction').value = state.manual_rent_deduction;
  container.querySelector('#manual_utility_deduction').value = state.manual_utility_deduction;
  container.querySelector('#manual-fields').style.display = state.use_auto_deduction ? 'none' : 'block';
  container.querySelectorAll('#single-month-slot input.currency-input').forEach(enableCurrencyInput);

  function save() {
    const useAuto = container.querySelector('#use_auto').checked;
    const entry = {
      year, month,
      gross_pay: parseCurrencyInput(container.querySelector('#gross_pay').value),
      use_auto_deduction: useAuto,
      manual_rent_deduction: parseCurrencyInput(container.querySelector('#manual_rent_deduction').value),
      manual_utility_deduction: parseCurrencyInput(container.querySelector('#manual_utility_deduction').value),
    };
    DEDUCTION_FIELDS.forEach((f) => { entry[f.key] = parseCurrencyInput(container.querySelector(`#${f.key}`).value); });
    upsertOfficerPayEntry(entry);
    container.querySelector('#manual-fields').style.display = useAuto ? 'none' : 'block';
    recompute(entry);
  }

  function recompute(entry) {
    const d = resolveOfficerDeductions(year, month);
    container.querySelector('#rent-deduction-display').innerHTML = `${yen(d.rent_deduction)}<span class="unit">円</span>`;
    container.querySelector('#utility-deduction-display').innerHTML = `${yen(d.utility_deduction)}<span class="unit">円</span>`;
    const deductionTotal = DEDUCTION_FIELDS.reduce((a, f) => a + (entry[f.key] || 0), 0) + d.rent_deduction + d.utility_deduction;
    container.querySelector('#deduction-total').innerHTML = `${yen(deductionTotal)}<span class="unit">円</span>`;
    const net = entry.gross_pay - deductionTotal;
    container.querySelector('#net-pay').innerHTML = `${yen(net)}<span class="unit">円</span>`;

    const socialInsurance = (entry.health_insurance || 0) + (entry.nursing_care_insurance || 0)
      + (entry.pension || 0) + (entry.child_support_levy || 0);
    donutChart(container.querySelector('#pay-breakdown-chart'), {
      centerLabel: '差引支給額（手取り）',
      centerValue: net,
      segments: [
        { label: '差引支給額（手取り）', color: seriesColor(0), value: Math.max(0, net) },
        { label: '社会保険料', color: seriesColor(1), value: socialInsurance },
        { label: '源泉所得税', color: seriesColor(2), value: entry.withholding_tax || 0 },
        { label: '家賃・光熱費控除', color: seriesColor(3), value: d.rent_deduction + d.utility_deduction },
      ],
    });

    renderChart();
  }

  container.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', save);
  });

  container.querySelector('#copy-prev-btn').addEventListener('click', () => {
    const p = getOfficerPayEntry(prev.year, prev.month);
    if (!p) return;
    DEDUCTION_FIELDS.forEach((f) => { container.querySelector(`#${f.key}`).value = p[f.key]; });
    save();
  });

  recompute(state);

  function renderChart() {
    const months = fiscalYearMonths(fiscalYearStartOf(year, month, fyStartMonth), fyStartMonth);
    const highlightIndex = months.findIndex((m) => m.year === year && m.month === month);
    const xLabels = months.map((m) => `${m.month}月`);
    const today = todayYearMonth();
    const todayIdx = today.year * 12 + today.month;
    const grossSeries = [];
    const netSeries = [];
    months.forEach((m) => {
      if (m.year * 12 + m.month > todayIdx) { grossSeries.push(null); netSeries.push(null); return; }
      const e = getOfficerPayEntry(m.year, m.month);
      const d = resolveOfficerDeductions(m.year, m.month);
      const gross = e ? e.gross_pay : 0;
      const total = e ? DEDUCTION_FIELDS.reduce((a, f) => a + (e[f.key] || 0), 0) + d.rent_deduction + d.utility_deduction : 0;
      grossSeries.push(gross);
      netSeries.push(gross - total);
    });
    lineChart(container.querySelector('#pay-trend-chart'), {
      xLabels,
      highlightIndex,
      series: [
        { label: '支給額', color: seriesColor(1), values: grossSeries },
        { label: '差引支給額', color: seriesColor(0), values: netSeries },
      ],
    });
  }

  function renderBulkTable() {
    const slot = container.querySelector('#bulk-slot');
    const months = fiscalYearMonths(bulkFyStartYear, fyStartMonth);

    slot.innerHTML = `
      <div class="card">
        <div id="fy-selector-slot"></div>
        <div class="card-note">家賃控除・水道光熱費控除・差引支給額は、この一括入力からは計算されません。詳しく確認したいときは月次入力または月次レポートをご覧ください。</div>
        <div class="bulk-table-wrap">
          <table class="ledger bulk-grid">
            <thead>
              <tr>
                <th>項目</th>
                ${months.map((m) => `<th class="num">${monthShort(m.month)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${BULK_FIELDS.map((f) => `
                <tr>
                  <td>${f.label}</td>
                  ${months.map((m) => {
                    const entry = getOfficerPayEntry(m.year, m.month);
                    const value = entry ? entry[f.key] : 0;
                    return `<td class="num"><input type="text" inputmode="numeric" class="bulk-pay-input currency-input" data-key="${f.key}" data-year="${m.year}" data-month="${m.month}" value="${value}"></td>`;
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
      noteText: '1年度分の支給額・保険料等をまとめて入力できます。',
      onChange: (newFyStartYear) => {
        bulkFyStartYear = newFyStartYear;
        renderBulkTable();
      },
    });

    enableGridPaste(slot.querySelector('table.bulk-grid'), '.bulk-pay-input');
    slot.querySelectorAll('.bulk-pay-input').forEach(enableCurrencyInput);

    slot.querySelectorAll('.bulk-pay-input').forEach((input) => {
      input.addEventListener('change', () => {
        const y = Number(input.dataset.year);
        const m = Number(input.dataset.month);
        const existingEntry = getOfficerPayEntry(y, m) || {
          gross_pay: 0, health_insurance: 0, nursing_care_insurance: 0, pension: 0,
          child_support_levy: 0, withholding_tax: 0, use_auto_deduction: 1,
          manual_rent_deduction: 0, manual_utility_deduction: 0,
        };
        const updated = { ...existingEntry, year: y, month: m, [input.dataset.key]: parseCurrencyInput(input.value) };
        upsertOfficerPayEntry(updated);
        renderChart();
      });
    });
  }
}
