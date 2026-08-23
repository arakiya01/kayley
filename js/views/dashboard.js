import {
  listClientsForMonths, computeArLedger, getRentUtilityEntry, computeUtilityPersonalTotal,
  getOfficerPayEntry, resolveOfficerDeductions, getMeta, getMonthStatus, getFoundingDate,
} from '../db.js';
import {
  yen, monthLabel, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading,
} from '../format.js';
import { renderMonthBar } from './monthbar.js';
import { lineChart, emptyChart } from '../charts.js';
import { seriesColor } from '../colors.js';

const DEDUCTION_KEYS = ['health_insurance', 'nursing_care_insurance', 'pension', 'child_support_levy', 'withholding_tax'];

function monthSalesAndPayment(clients, year, month) {
  let sales = 0, payment = 0, balance = 0;
  clients.forEach((c) => {
    const ledger = computeArLedger(c);
    const row = ledger.find((r) => r.year === year && r.month === month);
    if (row) { sales += row.sales; payment += row.payment; }
    let bal = c.opening_balance || 0;
    for (const r of ledger) {
      if (r.year * 12 + r.month > year * 12 + month) break;
      bal = r.closing;
    }
    balance += bal;
  });
  return { sales, payment, balance };
}

function netPayFor(year, month) {
  const e = getOfficerPayEntry(year, month);
  if (!e) return null;
  const d = resolveOfficerDeductions(year, month);
  const total = DEDUCTION_KEYS.reduce((a, k) => a + (e[k] || 0), 0) + d.rent_deduction + d.utility_deduction;
  return e.gross_pay - total;
}

export function render(container, ctx) {
  const { year, month } = ctx;
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  const fyStartYear = fiscalYearStartOf(year, month, fyStartMonth);
  const months = fiscalYearMonths(fyStartYear, fyStartMonth);
  const highlightIndex = months.findIndex((m) => m.year === year && m.month === month);
  const clients = listClientsForMonths(months);
  const companyName = getMeta('company_name') || '(会社名未設定)';

  const thisMonth = monthSalesAndPayment(clients, year, month);
  const rentEntry = getRentUtilityEntry(year, month);
  const personalBurden = rentEntry ? (rentEntry.rent_personal_fixed + computeUtilityPersonalTotal(rentEntry)) : null;
  const netPay = netPayFor(year, month);
  const status = getMonthStatus(year, month);

  // 今期の売上累計（今期の各月の実績を合算。まだ来ていない月は実績0なので自然に足されない）
  const monthKeys = new Set(months.map((m) => `${m.year}-${m.month}`));
  let fySum = 0;
  clients.forEach((c) => {
    computeArLedger(c).forEach((r) => {
      if (monthKeys.has(`${r.year}-${r.month}`)) fySum += r.sales;
    });
  });

  const periodHeading = fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate());

  container.innerHTML = `
    <div id="month-bar-slot"></div>
    <div class="card">
      <h2>${companyName}</h2>
      <div class="card-note">${monthLabel(year, month)} 時点のスナップショット</div>
      <div class="card-grid">
        <div class="stat-tile">
          <div class="label">当月売上</div>
          <div class="value num">${yen(thisMonth.sales)}<span class="unit">円</span></div>
        </div>
        <div class="stat-tile">
          <div class="label">当月入金</div>
          <div class="value num">${yen(thisMonth.payment)}<span class="unit">円</span></div>
        </div>
        <div class="stat-tile">
          <div class="label">売掛金残高合計</div>
          <div class="value num">${yen(thisMonth.balance)}<span class="unit">円</span></div>
        </div>
        <div class="stat-tile">
          <div class="label">家賃・光熱費 個人負担</div>
          <div class="value num">${personalBurden == null ? '—' : yen(personalBurden)}<span class="unit">円</span></div>
        </div>
        <div class="stat-tile">
          <div class="label">役員報酬 差引支給額</div>
          <div class="value num">${netPay == null ? '—' : yen(netPay)}<span class="unit">円</span></div>
        </div>
        <div class="stat-tile">
          <div class="label">今期の売上累計</div>
          <div class="value num">${yen(fySum)}<span class="unit">円</span></div>
        </div>
      </div>
      <div style="margin-top:16px">
        ${status && status.finalized
          ? `<span class="badge good">この月は確定済みです</span>`
          : `<span class="badge warning">この月は未確定です</span>`}
      </div>
    </div>
    <div class="card">
      <h2>売上推移</h2>
      <div class="card-note">${periodHeading}</div>
      <div id="sales-trend"></div>
    </div>
  `;

  renderMonthBar(container.querySelector('#month-bar-slot'), {
    year, month, onChange: ctx.setMonth, showFinalize: false,
  });

  const xLabels = months.map((m) => `${m.month}月`);

  if (clients.length === 0) {
    emptyChart(container.querySelector('#sales-trend'), '得意先が登録されるとここに表示されます');
  } else {
    const salesTotals = months.map((m) => monthSalesAndPayment(clients, m.year, m.month).sales);

    lineChart(container.querySelector('#sales-trend'), {
      xLabels,
      highlightIndex,
      series: [{ label: '売上合計', color: seriesColor(1), values: salesTotals }],
    });
  }
}
