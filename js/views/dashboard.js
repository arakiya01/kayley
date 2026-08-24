import {
  listClientsForMonths, computeArLedger, unpaidStreak, getRentUtilityEntry, computeUtilityPersonalTotal,
  getOfficerPayEntry, resolveOfficerDeductions, getMeta, getMonthStatus, getFoundingDate,
  listAttachments, listArEntriesForMonth, listExpenseSourceSummaries, getSectionCompletion,
} from '../db.js';
import {
  yen, yenSigned, monthLabel, escapeHtml, addMonths, todayYearMonth,
  fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading,
} from '../format.js';
import { lineChart, donutChart, emptyChart } from '../charts.js';
import { seriesColor, foldToFour } from '../colors.js';

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

// 2ヶ月以上、売上計上済みなのに入金が確認できていない得意先を抽出（滞留アラート用）
function agingSummary(clients, year, month) {
  const out = [];
  clients.forEach((c) => {
    const ledger = computeArLedger(c);
    const streak = unpaidStreak(ledger, year, month);
    if (streak < 2) return;
    const idx = ledger.findIndex((r) => r.year === year && r.month === month);
    const balance = idx >= 0 ? ledger[idx].closing : (c.opening_balance || 0);
    out.push({ name: c.name, streak, balance });
  });
  return out.sort((a, b) => b.streak - a.streak || b.balance - a.balance);
}

function deltaHtml(delta, label = '前月比') {
  if (!delta) return `<div class="delta" style="color:var(--ink-muted)">${label} ±0円</div>`;
  return `<div class="delta ${delta > 0 ? 'up' : 'down'}">${label} ${yenSigned(delta)}円</div>`;
}

export function render(container, ctx) {
  const { year, month } = ctx;
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  const fyStartYear = fiscalYearStartOf(year, month, fyStartMonth);
  const months = fiscalYearMonths(fyStartYear, fyStartMonth);
  const highlightIndex = months.findIndex((m) => m.year === year && m.month === month);
  const clients = listClientsForMonths(months);
  const periodHeading = fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate());
  const today = todayYearMonth();

  const thisMonth = monthSalesAndPayment(clients, year, month);
  const prevYM = addMonths(year, month, -1);
  const prevMonthData = monthSalesAndPayment(clients, prevYM.year, prevYM.month);
  const rentEntry = getRentUtilityEntry(year, month);
  const personalBurden = rentEntry ? (rentEntry.rent_personal_fixed + computeUtilityPersonalTotal(rentEntry)) : null;
  const netPay = netPayFor(year, month);
  const status = getMonthStatus(year, month);
  const completion = getSectionCompletion(year, month);

  // 今期の売上・入金累計（今期の各月の実績を合算。まだ来ていない月は実績0なので自然に足されない）
  const monthKeys = new Set(months.map((m) => `${m.year}-${m.month}`));
  let fySalesSum = 0, fyPaymentSum = 0;
  clients.forEach((c) => {
    computeArLedger(c).forEach((r) => {
      if (monthKeys.has(`${r.year}-${r.month}`)) { fySalesSum += r.sales; fyPaymentSum += r.payment; }
    });
  });

  const aging = agingSummary(clients, year, month);

  const todayIdx = today.year * 12 + today.month;
  const monthAttachments = listAttachments(year, month);
  const arEntries = listArEntriesForMonth(year, month);
  const expenseRows = listExpenseSourceSummaries([{ year, month }]);
  const expenseTxnCount = expenseRows.reduce((sum, row) => sum + row.transaction_count, 0);
  const expenseReceiptCount = monthAttachments.filter((a) => a.category !== 'invoice' && a.category !== 'statement').length;
  const sections = [
    { name: '売掛金', tab: 'ar', done: completion.ar, value: `${arEntries.length}件 / ${yen(thisMonth.sales)}円` },
    { name: '家賃・光熱費', tab: 'rent', done: completion.rent, value: `個人負担 ${personalBurden == null ? '—' : `${yen(personalBurden)}円`}` },
    { name: '役員報酬', tab: 'officer', done: completion.officer, value: `差引 ${netPay == null ? '—' : `${yen(netPay)}円`}` },
    { name: '経費', tab: 'expenses', done: completion.expenses, value: `明細${expenseTxnCount}件 ・ 領収書${expenseReceiptCount}件` },
    { name: '月次レポート', tab: 'report', done: completion.report, value: status && status.report_exported_at ? '出力済み' : '未出力', ctaLabel: '月次レポートを開く' },
  ];
  const incomplete = sections.filter((section) => !section.done);
  const nextSection = incomplete[0];
  const closingStatus = incomplete.length === 0 ? 'すべて完了' : `残り${incomplete.length}項目`;

  container.innerHTML = `
    <div class="card closing-panel">
      <div class="closing-grid">
        <section>
          <div class="closing-month">${monthLabel(year, month)}</div>
          <div class="closing-status">${closingStatus}</div>
          <div class="closing-checklist">
            ${sections.map((section) => `
              <a href="#/${section.tab}" class="closing-row"><span class="completion-seal ${section.done ? 'done' : ''}"></span><span>${section.name}</span><strong class="num">${section.value}</strong></a>
            `).join('')}
          </div>
          <div class="closing-actions">
            ${nextSection
              ? `<a class="btn primary" href="#/${nextSection.tab}">${nextSection.ctaLabel || `${nextSection.name}の入力を続ける`}</a>`
              : '<span class="badge good">この月はすべて完了しています</span>'}
          </div>
        </section>
        <section class="closing-figures">
          <div class="stat-tile lead-figure"><div class="label">当月売上</div><div class="value num">${yen(thisMonth.sales)}<span class="unit">円</span></div>${deltaHtml(thisMonth.sales - prevMonthData.sales)}</div>
          <div class="closing-figure-pair">
            <div class="stat-tile"><div class="label">当月入金</div><div class="value num">${yen(thisMonth.payment)}<span class="unit">円</span></div></div>
            <div class="stat-tile"><div class="label">売掛金残高合計</div><div class="value num">${yen(thisMonth.balance)}<span class="unit">円</span></div></div>
          </div>
          <div class="stat-tile"><div class="label">今期の売上累計</div><div class="value num">${yen(fySalesSum)}<span class="unit">円</span></div><div class="delta">入金累計 ${yen(fyPaymentSum)}円</div></div>
        </section>
      </div>
      ${aging.length > 0 ? `<a href="#/ar" class="aging-strip"><span class="badge ${aging.some((a) => a.streak >= 3) ? 'critical' : 'warning'}">滞留中の売掛金 ${aging.length}件</span></a>` : ''}
    </div>

    <div class="two-col">
      <div class="card">
        <h2>売上推移</h2>
        <div class="card-note">${periodHeading}</div>
        <div id="sales-trend"></div>
      </div>
      <div class="card">
        <h2>得意先別の売上構成</h2>
        <div class="card-note">${periodHeading}</div>
        <div id="client-breakdown-chart"></div>
      </div>
    </div>

    <div class="card">
      <h2>未回収の滞留</h2>
      <div class="card-note">2ヶ月以上、売上計上済みで入金が確認できていない得意先です。</div>
      ${aging.length === 0 ? `
        <div class="card-note" style="margin:0">現在、滞留している得意先はありません。</div>
      ` : `
        <div style="display:flex;flex-direction:column">
          ${aging.map((a) => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--hairline)">
              <span style="flex:1">${escapeHtml(a.name)}</span>
              <span class="badge ${a.streak >= 3 ? 'critical' : 'warning'}">滞留 ${a.streak}ヶ月</span>
              <span class="num" style="min-width:100px;text-align:right">${yen(a.balance)}<span style="font-size:11px;color:var(--ink-muted)">円</span></span>
            </div>
          `).join('')}
        </div>
      `}
      <div class="toolbar" style="margin-top:10px">
        <span class="spacer"></span>
        <a class="btn ghost" href="#/ar">売掛金台帳を開く</a>
      </div>
    </div>
  `;

  const xLabels = months.map((m) => `${m.month}月`);

  if (clients.length === 0) {
    emptyChart(container.querySelector('#sales-trend'), '得意先が登録されるとここに表示されます');
    emptyChart(container.querySelector('#client-breakdown-chart'), '得意先が登録されるとここに表示されます');
  } else {
    const salesTotals = months.map((m) => (m.year * 12 + m.month > todayIdx ? null : monthSalesAndPayment(clients, m.year, m.month).sales));
    lineChart(container.querySelector('#sales-trend'), {
      xLabels,
      highlightIndex,
      series: [{ label: '売上合計', color: seriesColor(1), values: salesTotals }],
    });

    const clientTotals = clients
      .map((c) => {
        const total = computeArLedger(c).reduce((a, r) => (monthKeys.has(`${r.year}-${r.month}`) ? a + r.sales : a), 0);
        return { key: String(c.id), label: c.name, value: total };
      })
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value);

    if (clientTotals.length === 0) {
      emptyChart(container.querySelector('#client-breakdown-chart'), 'データがまだありません');
    } else {
      const folded = foldToFour(clientTotals);
      donutChart(container.querySelector('#client-breakdown-chart'), {
        centerLabel: '今期売上',
        centerValue: fySalesSum,
        size: 168,
        segments: folded.map((s, i) => ({ label: s.label, color: seriesColor(i), value: s.value })),
      });
    }
  }
}
