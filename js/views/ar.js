import {
  listClientsForMonth, listClientsForMonths,
  listClients, upsertClient, archiveClient, getArEntry, upsertArEntry, computeArLedger, unpaidStreak,
  computeArBackingStatus, getMeta, getFoundingDate,
  listAttachments, addAttachment, removeAttachment, clientTradeAllowsMonth,
} from '../db.js';
import {
  yen, monthShort, escapeHtml, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading, todayYearMonth,
} from '../format.js';
import { renderFySelector } from './fyselector.js';
import { enableGridPaste } from './gridpaste.js';
import { lineChart, emptyChart } from '../charts.js';
import { seriesColor, foldSeriesArrays } from '../colors.js';
import { bankBadgeHtml } from '../bankbadge.js';
import * as localfiles from '../localfiles.js';
import { fileChipHtml } from '../fileicon.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';

let bulkMode = false;
let bulkFyStartYear = null;

function agingBadge(streak) {
  if (streak >= 3) return `<span class="badge critical">滞留 ${streak}ヶ月</span>`;
  if (streak >= 2) return `<span class="badge warning">滞留 ${streak}ヶ月</span>`;
  return '';
}

export function render(container, ctx) {
  const { year, month } = ctx;
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  if (bulkFyStartYear == null) bulkFyStartYear = fiscalYearStartOf(year, month, fyStartMonth);

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>売掛金台帳</h2>
        <div class="toolbar">
          <button class="btn ghost" id="add-client-btn">＋ 得意先を追加</button>
          <button class="btn ghost" id="bulk-toggle-btn">${bulkMode ? '月次入力に戻る' : '📋 一括入力（年度）'}</button>
        </div>
      </div>
      <div class="card-note">得意先ごとの当月売上・入金を記録します。残高は自動で繰り越し計算されます。完了印は、この月の売上・入金が1件でも入力されると付きます。</div>
      <div id="ar-table-slot"></div>
    </div>
    <details class="card settings-fold">
      <summary><h2>得意先の設定</h2><span class="card-note" style="margin:0">取引終了年月を設定すると、その月を過ぎた時点で自動的に休止扱いになります（グラフでも、取引開始前・終了後の月は0円ではなく「データなし」として扱われます）。未設定の場合は今まで通り手動で休止・再開できます。</span></summary>
      <div id="client-settings-slot"></div>
    </details>
    <div class="card">
      <h2>売上推移</h2>
      <div class="card-note">${fiscalPeriodHeading(year, month, fyStartMonth, getFoundingDate())}</div>
      <div id="ar-sales-chart"></div>
    </div>
    <div id="add-client-form-slot"></div>
  `;

  container.querySelector('#bulk-toggle-btn').addEventListener('click', () => {
    bulkMode = !bulkMode;
    render(container, ctx);
  });

  renderTable();
  renderClientSettings();
  renderCharts();

  container.querySelector('#add-client-btn').addEventListener('click', () => {
    const slot = container.querySelector('#add-client-form-slot');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <div class="card">
        <h2>得意先を追加</h2>
        <div class="field-row">
          <div class="field-label">得意先名</div>
          <div class="field-value"><input type="text" id="new-client-name" placeholder="例: 株式会社サンプル"></div>
        </div>
        <div class="field-row">
          <div class="field-label">通貨<span class="hint">海外送金の得意先はメモ欄に為替レートなど</span></div>
          <div class="field-value">
            <input type="text" id="new-client-currency" value="JPY" style="flex:0 1 80px">
            <input type="text" id="new-client-fx" placeholder="為替メモ（任意）">
          </div>
        </div>
        <div class="field-row">
          <div class="field-label">開始時点の残高<span class="hint">このアプリで記録を始める時点の未回収残高</span></div>
          <div class="field-value"><input type="text" inputmode="numeric" class="currency-input" id="new-client-balance" value="0"></div>
        </div>
        <div class="toolbar">
          <span class="spacer"></span>
          <button class="btn primary" id="save-client-btn">追加する</button>
        </div>
      </div>
    `;
    enableCurrencyInput(slot.querySelector('#new-client-balance'));
    slot.querySelector('#save-client-btn').addEventListener('click', () => {
      const name = slot.querySelector('#new-client-name').value.trim();
      if (!name) return;
      upsertClient({
        name,
        currency: slot.querySelector('#new-client-currency').value.trim() || 'JPY',
        fx_note: slot.querySelector('#new-client-fx').value.trim(),
        opening_balance: parseCurrencyInput(slot.querySelector('#new-client-balance').value),
        opening_year: year,
        opening_month: month,
      });
      slot.innerHTML = '';
      renderTable();
      renderClientSettings();
      renderCharts();
    });
  });

  function renderClientSettings() {
    const slot = container.querySelector('#client-settings-slot');
    const clients = listClients({ includeArchived: true });
    slot.innerHTML = `
      <table class="ledger">
        <thead><tr><th>得意先</th><th class="num">開始残高</th><th>取引開始年月</th><th>取引終了年月</th><th>状態</th><th></th></tr></thead>
        <tbody>
          ${clients.map((c) => {
            const startVal = c.trade_start_year && c.trade_start_month ? `${c.trade_start_year}-${String(c.trade_start_month).padStart(2, '0')}` : '';
            const endVal = c.trade_end_year && c.trade_end_month ? `${c.trade_end_year}-${String(c.trade_end_month).padStart(2, '0')}` : '';
            const autoManaged = !!(c.trade_end_year && c.trade_end_month);
            return `
              <tr>
                <td>${escapeHtml(c.name)}</td>
                <td class="num">${c.opening_balance}</td>
                <td><input type="month" class="client-trade-start" data-id="${c.id}" value="${startVal}" style="font-size:12px;padding:4px 6px"></td>
                <td><input type="month" class="client-trade-end" data-id="${c.id}" value="${endVal}" style="font-size:12px;padding:4px 6px"></td>
                <td>${c.archived ? '休止中' : '有効'}${autoManaged ? '<span class="card-note" style="margin:0">終了年月により自動</span>' : ''}</td>
                <td>${autoManaged ? '' : `<button class="btn ghost archive-btn" data-id="${c.id}" data-archived="${c.archived}">${c.archived ? '再開する' : '休止する'}</button>`}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
    slot.querySelectorAll('.archive-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        archiveClient(Number(btn.dataset.id), btn.dataset.archived === '1' ? 0 : 1);
        renderClientSettings();
        renderTable();
        renderCharts();
      });
    });
    slot.querySelectorAll('.client-trade-start, .client-trade-end').forEach((input) => {
      input.addEventListener('change', () => {
        const client = clients.find((c) => c.id === Number(input.dataset.id));
        const [valueYear, valueMonth] = input.value ? input.value.split('-').map(Number) : [null, null];
        const isStart = input.classList.contains('client-trade-start');
        upsertClient({
          ...client,
          ...(isStart
            ? { trade_start_year: valueYear, trade_start_month: valueMonth }
            : { trade_end_year: valueYear, trade_end_month: valueMonth }),
        });
        renderClientSettings();
        renderTable();
        renderCharts();
      });
    });
  }

  function renderTable() {
    if (bulkMode) { renderBulkTable(); return; }
    const slot = container.querySelector('#ar-table-slot');
    const activeClients = listClientsForMonth(year, month).filter((c) => clientTradeAllowsMonth(c, year, month));
    const monthAttachments = listAttachments(year, month);
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

    const invoicesFor = (clientId) => monthAttachments.filter((a) => a.category === 'invoice' && a.client_id === clientId);
    const showInvoiceColumn = true;

    slot.innerHTML = `
      <div class="bulk-table-wrap">
      <table class="ledger">
        <thead>
          <tr>
            <th>得意先</th>
            <th class="num">前月繰越（円）</th>
            <th class="num">売上（円）</th>
            <th class="num">入金（円）</th>
            <th class="num">当月残高（円）</th>
            <th>状況</th>
            ${showInvoiceColumn ? '<th class="no-print">請求書</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${rows.map(({ client, opening, entry, closing, streak }) => `
            <tr data-client-id="${client.id}">
              <td>${escapeHtml(client.name)}${client.fx_note ? `<div class="card-note" style="margin:0">${escapeHtml(client.fx_note)}</div>` : ''}</td>
              <td class="num">${yen(opening)}</td>
              <td class="num"><input type="text" inputmode="numeric" class="sales-input currency-input" value="${entry.sales || 0}" data-client="${client.id}"></td>
              <td class="num"><input type="text" inputmode="numeric" class="payment-input currency-input" value="${entry.payment || 0}" data-client="${client.id}"></td>
              <td class="num closing-cell">${yen(closing)}</td>
              <td>${agingBadge(streak)} ${bankBadgeHtml(computeArBackingStatus(client.id))}</td>
              ${showInvoiceColumn ? `<td class="no-print invoice-cell" data-client="${client.id}" style="max-width:200px">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                  <label class="btn ghost" style="cursor:pointer;font-size:11px;padding:4px 8px;white-space:nowrap;display:inline-block">
                    ＋請求書
                    <input type="file" class="invoice-file-input" data-client="${client.id}" style="display:none">
                  </label>
                  ${invoicesFor(client.id).map((it) => `
                    <span style="display:inline-flex;align-items:center;gap:2px">
                      ${fileChipHtml({ name: it.name, webViewLink: it.web_view_link })}
                      <button class="btn ghost delete-invoice-btn" data-id="${it.id}" data-drive-id="${escapeHtml(it.drive_file_id)}" style="padding:1px 5px;font-size:10px">×</button>
                    </span>
                  `).join('')}
                </div>
                <span class="invoice-status card-note" style="margin:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" data-client="${client.id}"></span>
              </td>` : ''}
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
            ${showInvoiceColumn ? '<td class="no-print"></td>' : ''}
          </tr>
        </tfoot>
      </table>
      </div>
    `;

    slot.querySelectorAll('.sales-input, .payment-input').forEach(enableCurrencyInput);

    slot.querySelectorAll('.sales-input, .payment-input').forEach((input) => {
      input.addEventListener('change', () => {
        const clientId = Number(input.dataset.client);
        const tr = input.closest('tr');
        const sales = parseCurrencyInput(tr.querySelector('.sales-input').value);
        const payment = parseCurrencyInput(tr.querySelector('.payment-input').value);
        upsertArEntry({ client_id: clientId, year, month, sales, payment });
        renderTable();
        renderCharts();
      });
    });

    slot.querySelectorAll('.invoice-file-input').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const clientId = Number(input.dataset.client);
        const client = activeClients.find((c) => c.id === clientId);
        const statusEl = slot.querySelector(`.invoice-status[data-client="${clientId}"]`);
        statusEl.textContent = 'アップロード中…';
        try {
          const uploaded = await localfiles.uploadFile(file, { namePrefix: client.name });
          addAttachment({
            year, month,
            drive_file_id: uploaded.id,
            name: file.name,
            mime_type: uploaded.mimeType,
            web_view_link: localfiles.previewUrl(uploaded.id),
            category: 'invoice',
            client_id: clientId,
          });
          renderTable();
        } catch (err) {
          statusEl.textContent = err.message;
        }
      });
    });

    slot.querySelectorAll('.delete-invoice-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この請求書を削除します。よろしいですか？')) return;
        btn.disabled = true;
        let fileError = null;
        try { await localfiles.deleteFile(btn.dataset.driveId); } catch (err) { fileError = err; }
        removeAttachment(Number(btn.dataset.id));
        renderTable();
        if (fileError) alert(`Kayley側の記録からは削除しましたが、ファイルの削除に失敗しました: ${fileError.message}`);
      });
    });
  }

  function renderBulkTable() {
    const slot = container.querySelector('#ar-table-slot');
    const months = fiscalYearMonths(bulkFyStartYear, fyStartMonth);
    const activeClients = listClientsForMonths(months);

    if (activeClients.length === 0) {
      slot.innerHTML = '';
      emptyChart(slot, 'まだ得意先が登録されていません。「＋ 得意先を追加」から始めましょう。');
      return;
    }

    slot.innerHTML = `
      <div id="fy-selector-slot"></div>
      <div class="bulk-table-wrap">
        <table class="ledger bulk-grid">
          <thead>
            <tr>
              <th rowspan="2">得意先</th>
              ${months.map((m) => `<th colspan="2" style="text-align:center">${monthShort(m.month)}</th>`).join('')}
            </tr>
            <tr>
              ${months.map(() => `<th class="num">売上</th><th class="num">入金</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${activeClients.map((c) => `
              <tr data-client-id="${c.id}">
                <td>${escapeHtml(c.name)}</td>
                ${months.map((m) => {
                  const entry = getArEntry(c.id, m.year, m.month) || { sales: 0, payment: 0 };
                  return `
                    <td class="num"><input type="text" inputmode="numeric" class="bulk-sales currency-input" data-client="${c.id}" data-year="${m.year}" data-month="${m.month}" value="${entry.sales || 0}"></td>
                    <td class="num"><input type="text" inputmode="numeric" class="bulk-payment currency-input" data-client="${c.id}" data-year="${m.year}" data-month="${m.month}" value="${entry.payment || 0}"></td>
                  `;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    renderFySelector(slot.querySelector('#fy-selector-slot'), {
      fyStartYear: bulkFyStartYear,
      fyStartMonth,
      foundingDate: getFoundingDate(),
      noteText: '1年度分の売上・入金をまとめて入力できます（金額は円単位です）。',
      onChange: (newFyStartYear) => {
        bulkFyStartYear = newFyStartYear;
        renderBulkTable();
      },
    });

    enableGridPaste(slot.querySelector('table.bulk-grid'), '.bulk-sales, .bulk-payment');
    slot.querySelectorAll('.bulk-sales, .bulk-payment').forEach(enableCurrencyInput);

    slot.querySelectorAll('.bulk-sales, .bulk-payment').forEach((input) => {
      input.addEventListener('change', () => {
        const clientId = Number(input.dataset.client);
        const y = Number(input.dataset.year);
        const m = Number(input.dataset.month);
        const row = input.closest('tr');
        const salesInput = row.querySelector(`.bulk-sales[data-year="${y}"][data-month="${m}"]`);
        const paymentInput = row.querySelector(`.bulk-payment[data-year="${y}"][data-month="${m}"]`);
        upsertArEntry({
          client_id: clientId, year: y, month: m,
          sales: parseCurrencyInput(salesInput.value),
          payment: parseCurrencyInput(paymentInput.value),
        });
        renderCharts();
      });
    });
  }

  function renderCharts() {
    const months = fiscalYearMonths(fiscalYearStartOf(year, month, fyStartMonth), fyStartMonth);
    const highlightIndex = months.findIndex((m) => m.year === year && m.month === month);
    const activeClients = listClientsForMonths(months);
    const xLabels = months.map((m) => `${m.month}月`);
    const today = todayYearMonth();
    const todayIdx = today.year * 12 + today.month;

    const salesSeriesRaw = activeClients.map((c) => {
      const ledger = computeArLedger(c);
      const byKey = {};
      ledger.forEach((r) => { byKey[`${r.year}-${r.month}`] = r.sales; });
      return {
        key: String(c.id), label: c.name,
        values: months.map((m) => {
          if (m.year * 12 + m.month > todayIdx) return null;
          if (!clientTradeAllowsMonth(c, m.year, m.month)) return null;
          return byKey[`${m.year}-${m.month}`] || 0;
        }),
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
      highlightIndex,
      series: salesFolded.map((s, i) => ({ label: s.label, color: seriesColor(i), values: s.values })),
    });
  }
}
