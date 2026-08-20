import {
  listClients, upsertClient, getArEntry, upsertArEntry, computeArLedger,
} from '../db.js';
import { yen, monthLabel, last12Months, escapeHtml } from '../format.js';
import { renderMonthBar } from './monthbar.js';
import { lineChart, emptyChart } from '../charts.js';
import { seriesColor, foldSeriesArrays } from '../colors.js';

function unpaidStreak(ledger, year, month) {
  const idx = ledger.findIndex((r) => r.year === year && r.month === month);
  if (idx === -1) return 0;
  let streak = 0;
  for (let i = idx; i >= 0; i--) {
    const row = ledger[i];
    if (row.opening > 0 && row.payment === 0) streak++;
    else break;
  }
  return streak;
}

function agingBadge(streak) {
  if (streak >= 3) return `<span class="badge critical">滞留 ${streak}ヶ月</span>`;
  if (streak >= 2) return `<span class="badge warning">滞留 ${streak}ヶ月</span>`;
  return '';
}

export function render(container, ctx) {
  const { year, month } = ctx;
  const clients = listClients();

  container.innerHTML = `
    <div id="month-bar-slot"></div>
    <div class="card">
      <h2>売掛金台帳</h2>
      <div class="card-note">得意先ごとの当月売上・入金を記録します。残高は自動で繰り越し計算されます。</div>
      <div class="toolbar">
        <span class="spacer"></span>
        <button class="btn ghost" id="add-client-btn">＋ 得意先を追加</button>
      </div>
      <div id="ar-table-slot"></div>
    </div>
    <div class="card">
      <h2>売上推移（直近12ヶ月）</h2>
      <div id="ar-sales-chart"></div>
    </div>
    <div id="add-client-form-slot"></div>
  `;

  renderMonthBar(container.querySelector('#month-bar-slot'), {
    year, month, onChange: ctx.setMonth, showFinalize: true,
  });

  renderTable();
  renderCharts();

  container.querySelector('#add-client-btn').addEventListener('click', () => {
    const slot = container.querySelector('#add-client-form-slot');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <div class="card">
        <h2>得意先を追加</h2>
        <div class="field-row">
          <div class="field-label">得意先名</div>
          <input type="text" id="new-client-name" placeholder="例: 株式会社サンプル">
        </div>
        <div class="field-row">
          <div class="field-label">通貨<span class="hint">海外送金の得意先はメモ欄に為替レートなど</span></div>
          <input type="text" id="new-client-currency" value="JPY">
          <input type="text" id="new-client-fx" placeholder="為替メモ（任意）">
        </div>
        <div class="field-row">
          <div class="field-label">開始時点の残高<span class="hint">このアプリで記録を始める時点の未回収残高</span></div>
          <input type="number" id="new-client-balance" value="0">
        </div>
        <div class="toolbar">
          <span class="spacer"></span>
          <button class="btn primary" id="save-client-btn">追加する</button>
        </div>
      </div>
    `;
    slot.querySelector('#save-client-btn').addEventListener('click', () => {
      const name = slot.querySelector('#new-client-name').value.trim();
      if (!name) return;
      upsertClient({
        name,
        currency: slot.querySelector('#new-client-currency').value.trim() || 'JPY',
        fx_note: slot.querySelector('#new-client-fx').value.trim(),
        opening_balance: Number(slot.querySelector('#new-client-balance').value) || 0,
        opening_year: year,
        opening_month: month,
      });
      slot.innerHTML = '';
      renderTable();
      renderCharts();
    });
  });

  function renderTable() {
    const slot = container.querySelector('#ar-table-slot');
    const activeClients = listClients();
    if (activeClients.length === 0) {
      emptyChart(slot, 'まだ得意先が登録されていません。「＋ 得意先を追加」から始めましょう。');
      return;
    }
    const rows = activeClients.map((c) => {
      const ledger = computeArLedger(c);
      const entry = getArEntry(c.id, year, month) || { sales: 0, payment: 0 };
      const priorIdx = ledger.findIndex((r) => r.year === year && r.month === month);
      const opening = priorIdx >= 0 ? ledger[priorIdx].opening
        : (() => {
            // まだ当月データが無い場合、直前までの残高を開始残高とする
            let bal = c.opening_balance || 0;
            for (const r of ledger) {
              if (r.year * 12 + r.month >= year * 12 + month) break;
              bal = r.closing;
            }
            return bal;
          })();
      const closing = opening + (entry.sales || 0) - (entry.payment || 0);
      const streak = unpaidStreak(computeArLedger(c), year, month);
      return { client: c, opening, entry, closing, streak };
    });

    slot.innerHTML = `
      <table class="ledger">
        <thead>
          <tr>
            <th>得意先</th>
            <th class="num">前月繰越</th>
            <th class="num">売上</th>
            <th class="num">入金</th>
            <th class="num">当月残高</th>
            <th>状況</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(({ client, opening, entry, closing, streak }) => `
            <tr data-client-id="${client.id}">
              <td>${escapeHtml(client.name)}${client.fx_note ? `<div class="card-note" style="margin:0">${escapeHtml(client.fx_note)}</div>` : ''}</td>
              <td class="num">${yen(opening)}</td>
              <td class="num"><input type="number" class="sales-input" value="${entry.sales || 0}" data-client="${client.id}"></td>
              <td class="num"><input type="number" class="payment-input" value="${entry.payment || 0}" data-client="${client.id}"></td>
              <td class="num closing-cell">${yen(closing)}</td>
              <td>${agingBadge(streak)}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td>合計</td>
            <td class="num">${yen(rows.reduce((a, r) => a + r.opening, 0))}</td>
            <td class="num">${yen(rows.reduce((a, r) => a + (r.entry.sales || 0), 0))}</td>
            <td class="num">${yen(rows.reduce((a, r) => a + (r.entry.payment || 0), 0))}</td>
            <td class="num">${yen(rows.reduce((a, r) => a + r.closing, 0))}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    `;

    slot.querySelectorAll('.sales-input, .payment-input').forEach((input) => {
      input.addEventListener('change', () => {
        const clientId = Number(input.dataset.client);
        const tr = input.closest('tr');
        const sales = Number(tr.querySelector('.sales-input').value) || 0;
        const payment = Number(tr.querySelector('.payment-input').value) || 0;
        upsertArEntry({ client_id: clientId, year, month, sales, payment });
        renderTable();
        renderCharts();
      });
    });
  }

  function renderCharts() {
    const activeClients = listClients();
    const months = last12Months(year, month);
    const xLabels = months.map((m) => monthLabel(m.year, m.month).replace(/^\d+年/, ''));

    const salesSeriesRaw = activeClients.map((c) => {
      const ledger = computeArLedger(c);
      const byKey = {};
      ledger.forEach((r) => { byKey[`${r.year}-${r.month}`] = r.sales; });
      return {
        key: String(c.id), label: c.name,
        values: months.map((m) => byKey[`${m.year}-${m.month}`] || 0),
      };
    });

    const salesChartEl = container.querySelector('#ar-sales-chart');

    if (activeClients.length === 0) {
      emptyChart(salesChartEl, 'データがまだありません');
      return;
    }

    const salesFolded = foldSeriesArrays(salesSeriesRaw);

    lineChart(salesChartEl, {
      xLabels,
      series: salesFolded.map((s, i) => ({ label: s.label, color: seriesColor(i), values: s.values })),
    });
  }
}
