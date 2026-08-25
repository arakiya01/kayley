import {
  getOfficerPayEntry, findPreviousOfficerPayEntry, upsertOfficerPayEntry, resolveOfficerDeductions,
  computeOfficerNetBackingStatus, computeOfficerWithholdingBackingStatus,
  officerWithholdingPeriodFor, prevMonth, getMeta, getFoundingDate, listOfficers, upsertOfficer, archiveOfficer,
} from '../db.js';
import { yen, monthLabel, monthShort, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading, todayYearMonth, escapeHtml } from '../format.js';
import { renderFySelector } from './fyselector.js';
import { enableGridPaste } from './gridpaste.js';
import { donutChart } from '../charts.js';
import { changeStrip } from '../changestrip.js';
import { bankBadgeHtml } from '../bankbadge.js';
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
let selectedOfficerId = null;
let bulkFyStartYear = null;

export function render(container, ctx) {
  const { year, month } = ctx;
  const officers = listOfficers({ includeArchived: true });
  const activeOfficers = officers.filter((o) => !o.archived);
  if (selectedOfficerId == null || !activeOfficers.some((o) => o.id === selectedOfficerId)) {
    selectedOfficerId = activeOfficers.length ? activeOfficers[0].id : null;
  }
  const selectedOfficer = activeOfficers.find((o) => o.id === selectedOfficerId);
  const prev = prevMonth(year, month);
  const deductions = resolveOfficerDeductions(selectedOfficerId, year, month);
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  if (bulkFyStartYear == null) bulkFyStartYear = fiscalYearStartOf(year, month, fyStartMonth);

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>役員</h2>
        <div class="toolbar"><button class="btn ghost" id="add-officer-btn">＋ 役員を追加</button></div>
      </div>
      <div class="card-note">完了印は、在籍中の役員全員分の給与明細がこの月に入力されると付きます。</div>
      <div id="officer-list-slot"></div>
    </div>
    <div id="add-officer-form-slot"></div>
    ${bulkMode ? `<div class="toolbar"><span class="spacer"></span><button class="btn ghost bulk-toggle-btn">月次入力に戻る</button></div>` : ''}
    <div id="bulk-slot"></div>
    ${activeOfficers.length === 0 ? '' : `
    <div id="single-month-slot" style="${bulkMode ? 'display:none' : ''}">
      <div class="card payslip">
        <div class="payslip-header">
          <h2>役員報酬明細</h2>
          <div class="toolbar">
            <span>${monthLabel(year, month)}</span>
            <button class="btn ghost bulk-toggle-btn">📋 一括入力（年度）</button>
          </div>
        </div>
        <div id="carry-notice-slot"></div>
        <div class="payslip-grid">
          <section>
            <div class="section-heading">支給</div>
            <div class="compact-field"><label for="gross_pay">支給額</label><span><input type="text" inputmode="numeric" class="currency-input" id="gross_pay"><small>円</small></span></div>
            <button class="btn ghost" id="copy-prev-btn">前月の保険料等をコピー</button>
            <div class="section-heading payslip-balance-heading">差引</div>
            <div class="computed-line"><span>控除合計</span><strong class="num" id="deduction-total">0<span class="unit">円</span></strong></div>
            <div class="net-pay-line"><span>差引支給額</span><strong class="num" id="net-pay">0<span class="unit">円</span></strong></div>
            <div id="officer-net-badge-slot" class="bank-badge-slot"></div>
          </section>
          <section>
            <div class="section-heading">控除</div>
            ${DEDUCTION_FIELDS.map((f) => `
              <div class="compact-field"><label for="${f.key}">${f.label}</label><span><input type="text" inputmode="numeric" class="currency-input" id="${f.key}"><small>円</small></span></div>
            `).join('')}
            <div id="officer-withholding-badge-slot" class="bank-badge-slot"></div>
            ${selectedOfficer.home_office_deduction ? `
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
            ` : ''}
          </section>
        </div>
        <h2>当月の内訳</h2>
        <div id="pay-breakdown-chart"></div>
      </div>
    </div>
    `}
    <div class="card">
      <h2>支給額の変化</h2>
      <div class="card-note" style="margin-bottom:2px">${fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate())}</div>
      <div class="card-note">役員報酬は定期同額給与のため、期の途中で支給額が変わるのは算定基礎届や改定のときだけです。前月と同じ月は＝で示し、変わった月だけ差額を出しています。</div>
      <div id="pay-trend-chart"></div>
    </div>
  `;

  renderOfficerList();
  container.querySelector('#add-officer-btn').addEventListener('click', () => {
    const slot = container.querySelector('#add-officer-form-slot');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <div class="card">
        <h2>役員を追加</h2>
        <div class="field-row">
          <div class="field-label">氏名</div>
          <div class="field-value"><input type="text" id="new-officer-name" placeholder="例: 荒木道子"></div>
        </div>
        <div class="field-row">
          <div class="field-label">役職</div>
          <div class="field-value"><input type="text" id="new-officer-role" placeholder="例: 取締役"></div>
        </div>
        <div class="field-row">
          <div class="field-label">自宅の家賃・水道光熱費を天引きする</div>
          <div class="field-value"><input type="checkbox" id="new-officer-home-deduction"></div>
        </div>
        <div class="toolbar">
          <span class="spacer"></span>
          <button class="btn primary" id="save-officer-btn">追加する</button>
        </div>
      </div>
    `;
    slot.querySelector('#save-officer-btn').addEventListener('click', () => {
      const name = slot.querySelector('#new-officer-name').value.trim();
      if (!name) return;
      const role = slot.querySelector('#new-officer-role').value.trim();
      const homeDeduction = slot.querySelector('#new-officer-home-deduction').checked;
      const id = upsertOfficer({ name, role, home_office_deduction: homeDeduction });
      slot.innerHTML = '';
      selectedOfficerId = id;
      render(container, ctx);
    });
  });
  container.querySelectorAll('.bulk-toggle-btn').forEach((btn) => btn.addEventListener('click', () => {
    bulkMode = !bulkMode;
    render(container, ctx);
  }));

  if (activeOfficers.length === 0) return;

  if (bulkMode) {
    renderBulkTable();
    renderChart();
    return;
  }

  const existing = getOfficerPayEntry(selectedOfficerId, year, month);
  const previousEntry = existing ? null : findPreviousOfficerPayEntry(selectedOfficerId, year, month);
  let carriedFrom = previousEntry ? { year: previousEntry.year, month: previousEntry.month } : null;
  const state = existing ? { ...existing } : previousEntry ? {
    gross_pay: previousEntry.entry.gross_pay,
    health_insurance: previousEntry.entry.health_insurance,
    nursing_care_insurance: previousEntry.entry.nursing_care_insurance,
    pension: previousEntry.entry.pension,
    child_support_levy: previousEntry.entry.child_support_levy,
    withholding_tax: previousEntry.entry.withholding_tax,
    use_auto_deduction: 1, manual_rent_deduction: 0, manual_utility_deduction: 0,
  } : {
    gross_pay: 0, health_insurance: 0, nursing_care_insurance: 0, pension: 0,
    child_support_levy: 0, withholding_tax: 0, use_auto_deduction: 1,
    manual_rent_deduction: 0, manual_utility_deduction: 0,
  };

  if (carriedFrom) {
    container.querySelector('#carry-notice-slot').innerHTML = `
      <div class="carry-notice" id="carry-notice">
        <span class="carry-notice-text">${monthLabel(carriedFrom.year, carriedFrom.month)}の内容を引き継いで表示しています。金額を確認してください。</span>
        <button class="btn primary" id="carry-confirm-btn">この内容で確定する</button>
      </div>`;
    ['gross_pay', ...DEDUCTION_FIELDS.map((f) => f.key)].forEach((id) => container.querySelector(`#${id}`).classList.add('carried'));
  }

  container.querySelector('#gross_pay').value = state.gross_pay;
  DEDUCTION_FIELDS.forEach((f) => { container.querySelector(`#${f.key}`).value = state[f.key]; });
  if (selectedOfficer.home_office_deduction) {
    container.querySelector('#use_auto').checked = !!state.use_auto_deduction;
    container.querySelector('#manual_rent_deduction').value = state.manual_rent_deduction;
    container.querySelector('#manual_utility_deduction').value = state.manual_utility_deduction;
    container.querySelector('#manual-fields').style.display = state.use_auto_deduction ? 'none' : 'block';
  }
  container.querySelectorAll('#single-month-slot input.currency-input').forEach(enableCurrencyInput);

  function save() {
    const useAuto = selectedOfficer.home_office_deduction ? container.querySelector('#use_auto').checked : false;
    const entry = {
      officer_id: selectedOfficerId, year, month,
      gross_pay: parseCurrencyInput(container.querySelector('#gross_pay').value),
      use_auto_deduction: useAuto,
      manual_rent_deduction: selectedOfficer.home_office_deduction ? parseCurrencyInput(container.querySelector('#manual_rent_deduction').value) : 0,
      manual_utility_deduction: selectedOfficer.home_office_deduction ? parseCurrencyInput(container.querySelector('#manual_utility_deduction').value) : 0,
    };
    DEDUCTION_FIELDS.forEach((f) => { entry[f.key] = parseCurrencyInput(container.querySelector(`#${f.key}`).value); });
    upsertOfficerPayEntry(entry);
    if (selectedOfficer.home_office_deduction) {
      container.querySelector('#manual-fields').style.display = useAuto ? 'none' : 'block';
    }
    if (carriedFrom) {
      carriedFrom = null;
      // 引き継ぎ状態が解けたので案内と薄字表示を消す（入力欄の値とフォーカスはそのまま）
      container.querySelector('#carry-notice')?.remove();
      container.querySelectorAll('.carried').forEach((el) => el.classList.remove('carried'));
    }
    recompute(entry);
  }

  function recompute(entry) {
    const d = resolveOfficerDeductions(selectedOfficerId, year, month);
    if (selectedOfficer.home_office_deduction) {
      container.querySelector('#rent-deduction-display').innerHTML = `${yen(d.rent_deduction)}<span class="unit">円</span>`;
      container.querySelector('#utility-deduction-display').innerHTML = `${yen(d.utility_deduction)}<span class="unit">円</span>`;
    }
    const deductionTotal = DEDUCTION_FIELDS.reduce((a, f) => a + (entry[f.key] || 0), 0) + d.rent_deduction + d.utility_deduction;
    container.querySelector('#deduction-total').innerHTML = `−${yen(deductionTotal)}<span class="unit">円</span>`;
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

    container.querySelector('#officer-net-badge-slot').innerHTML = bankBadgeHtml(computeOfficerNetBackingStatus(selectedOfficerId, year, month));
    const withholdingSlot = container.querySelector('#officer-withholding-badge-slot');
    withholdingSlot.innerHTML = officerWithholdingPeriodFor(year, month)
      ? bankBadgeHtml(computeOfficerWithholdingBackingStatus(year, month))
      : '';

    renderChart();
  }

  container.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', save);
  });
  container.querySelector('#carry-confirm-btn')?.addEventListener('click', save);

  container.querySelector('#copy-prev-btn').addEventListener('click', () => {
    const p = getOfficerPayEntry(selectedOfficerId, prev.year, prev.month);
    if (!p) return;
    DEDUCTION_FIELDS.forEach((f) => { container.querySelector(`#${f.key}`).value = p[f.key]; });
    save();
  });

  recompute(state);

  function renderChart() {
    const months = fiscalYearMonths(fiscalYearStartOf(year, month, fyStartMonth), fyStartMonth);
    const highlightIndex = months.findIndex((m) => m.year === year && m.month === month);
    const xLabels = months.map((m) => monthShort(m.month));
    const changeLabels = months.map((m) => monthLabel(m.year, m.month));
    const today = todayYearMonth();
    const todayIdx = today.year * 12 + today.month;
    const grossSeries = [];
    const netSeries = [];
    months.forEach((m) => {
      if (m.year * 12 + m.month > todayIdx) { grossSeries.push(null); netSeries.push(null); return; }
      const e = getOfficerPayEntry(selectedOfficerId, m.year, m.month);
      // 未入力の月は0ではなくデータなしとして扱う。0を入れてしまうと、
      // 最初に実績が入った月が「0からの変化」として拾われてしまうため。
      if (!e) { grossSeries.push(null); netSeries.push(null); return; }
      const d = resolveOfficerDeductions(selectedOfficerId, m.year, m.month);
      const gross = e.gross_pay;
      const total = DEDUCTION_FIELDS.reduce((a, f) => a + (e[f.key] || 0), 0) + d.rent_deduction + d.utility_deduction;
      grossSeries.push(gross);
      netSeries.push(gross - total);
    });
    changeStrip(container.querySelector('#pay-trend-chart'), {
      xLabels,
      fullLabels: changeLabels,
      highlightIndex,
      rows: [
        { label: '支給額', values: grossSeries },
        { label: '差引支給額', values: netSeries },
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
                    const entry = getOfficerPayEntry(selectedOfficerId, m.year, m.month);
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
        const existingEntry = getOfficerPayEntry(selectedOfficerId, y, m) || {
          gross_pay: 0, health_insurance: 0, nursing_care_insurance: 0, pension: 0,
          child_support_levy: 0, withholding_tax: 0, use_auto_deduction: 1,
          manual_rent_deduction: 0, manual_utility_deduction: 0,
        };
        const updated = { ...existingEntry, officer_id: selectedOfficerId, year: y, month: m, [input.dataset.key]: parseCurrencyInput(input.value) };
        upsertOfficerPayEntry(updated);
        renderChart();
      });
    });
  }

  function renderOfficerList() {
    const slot = container.querySelector('#officer-list-slot');
    if (officers.length === 0) {
      slot.innerHTML = '<div class="card-note" style="margin:0">まだ役員が登録されていません。「＋ 役員を追加」から始めましょう。</div>';
      return;
    }
    slot.innerHTML = `
      <table class="ledger">
        <thead><tr><th>氏名</th><th>役職</th><th>状態</th><th>自宅の家賃・光熱費を天引き</th><th></th><th></th></tr></thead>
        <tbody>
          ${officers.map((o) => `
            <tr data-officer-id="${o.id}" class="${o.id === selectedOfficerId ? 'selected-row' : ''}">
              <td><input type="text" class="officer-name-input" data-id="${o.id}" value="${escapeHtml(o.name)}"></td>
              <td><input type="text" class="officer-role-input" data-id="${o.id}" value="${escapeHtml(o.role || '')}" placeholder="役職"></td>
              <td>${o.archived ? '休止中' : '有効'}</td>
              <td><input type="checkbox" class="officer-home-deduction" data-id="${o.id}" ${o.home_office_deduction ? 'checked' : ''}></td>
              <td><button class="btn ghost select-officer-btn" data-id="${o.id}">選ぶ</button></td>
              <td><button class="btn ghost archive-officer-btn" data-id="${o.id}" data-archived="${o.archived}">${o.archived ? '再開する' : '休止する'}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    slot.querySelectorAll('.select-officer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedOfficerId = Number(btn.dataset.id);
        render(container, ctx);
      });
    });
    slot.querySelectorAll('.archive-officer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        archiveOfficer(Number(btn.dataset.id), btn.dataset.archived === '1' ? 0 : 1);
        render(container, ctx);
      });
    });
    slot.querySelectorAll('.officer-home-deduction').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const officer = officers.find((o) => o.id === Number(checkbox.dataset.id));
        upsertOfficer({ ...officer, home_office_deduction: checkbox.checked });
        render(container, ctx);
      });
    });
    slot.querySelectorAll('.officer-name-input').forEach((input) => {
      input.addEventListener('change', () => {
        const officer = officers.find((o) => o.id === Number(input.dataset.id));
        const name = input.value.trim();
        if (!name) { input.value = officer.name; return; }
        upsertOfficer({ ...officer, name });
        render(container, ctx);
      });
    });
    slot.querySelectorAll('.officer-role-input').forEach((input) => {
      input.addEventListener('change', () => {
        const officer = officers.find((o) => o.id === Number(input.dataset.id));
        upsertOfficer({ ...officer, role: input.value.trim() });
        render(container, ctx);
      });
    });
  }
}
