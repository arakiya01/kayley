// 経費タブ：
// 1) カード（楽天・SMBC）の利用明細PDFをアップロードすると、1行ずつの取引に自動展開する
// 2) 現金の利用は手入力で1件ずつ追加できる
// 3) 各取引に領収書を個別に紐づけられる
// 4) それ以外の、取引に紐づかない領収書は下部の「経費の領収書」にまとめて置ける
import {
  getMeta, listAttachments, addAttachment, removeAttachment,
  listPaymentSources, upsertPaymentSource, archivePaymentSource,
  listStatementTransactions, addStatementTransaction, removeStatementTransaction, clearStatementTransactions,
} from '../db.js';
import { yen, escapeHtml, monthLabel } from '../format.js';
import { renderMonthBar } from './monthbar.js';
import * as gdrive from '../gdrive.js';
import { extractPdfTextRows, detectAndParse } from '../statementparsers.js';
import { fileChipHtml } from '../fileicon.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';

let showAddSourceForm = false;
const cashFormOpenFor = new Set();

export function render(container, ctx) {
  const { year, month } = ctx;
  const gdriveConfigured = !!getMeta('gdrive_client_id');
  const sources = listPaymentSources();

  container.innerHTML = `
    <div id="month-bar-slot"></div>

    <div class="card">
      <h2>支払元（カード・現金）</h2>
      <div class="card-note">
        カードの利用明細（PDF）をアップロードすると、1件ずつの取引に自動で展開します。
        現金の利用はまれだと思うので、手入力で追加できます。
      </div>
      <div class="card-grid" style="margin-bottom:16px">
        <div class="stat-tile">
          <div class="label">当月の経費合計</div>
          <div class="value num" id="expense-month-total">0<span class="unit">円</span></div>
        </div>
      </div>
      <div class="toolbar">
        <span class="spacer"></span>
        <button class="btn ghost" id="add-source-btn">＋ 支払元を追加</button>
      </div>
      <div id="add-source-form-slot"></div>
      ${sources.length === 0 ? `<div class="card-note" style="margin:0">まだ支払元が登録されていません。「＋ 支払元を追加」から、使っているカードや現金を登録してください。</div>` : ''}
    </div>

    <div id="sources-slot"></div>

    <div class="card">
      <h2>経費の領収書</h2>
      <div class="card-note">
        上のカード・現金の明細に紐づかない領収書は、ここにまとめてアップロードしておけます
        （科目の振り分けは税理士さんにお任せする前提の機能です）。
      </div>
      <div class="toolbar">
        <label class="btn primary" style="cursor:${gdriveConfigured ? 'pointer' : 'not-allowed'};${gdriveConfigured ? '' : 'opacity:0.45'}">
          ＋ 領収書を追加
          <input type="file" id="expense-receipt-input" multiple style="display:none" ${gdriveConfigured ? '' : 'disabled'}>
        </label>
        <span id="expense-upload-status" class="card-note" style="margin:0"></span>
        <span class="spacer"></span>
        <span class="card-note" style="margin:0" id="expense-receipt-count"></span>
      </div>
      ${gdriveConfigured ? '' : '<div class="card-note">Google Driveが未設定です。「設定」タブから連携すると、ここでアップロードできるようになります。</div>'}
      <div id="expense-receipt-list"></div>
    </div>
  `;

  renderMonthBar(container.querySelector('#month-bar-slot'), {
    year, month, onChange: ctx.setMonth, showFinalize: true,
  });

  renderAddSourceForm();
  renderSources();
  renderGeneralReceiptList();

  container.querySelector('#add-source-btn').addEventListener('click', () => {
    showAddSourceForm = !showAddSourceForm;
    renderAddSourceForm();
  });

  function renderAddSourceForm() {
    const slot = container.querySelector('#add-source-form-slot');
    if (!showAddSourceForm) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <div class="field-row">
        <div class="field-label">名前<span class="hint">例: 楽天カード、SMBC、現金</span></div>
        <div class="field-value"><input type="text" id="new-source-name" placeholder="例: 楽天カード"></div>
      </div>
      <div class="field-row">
        <div class="field-label">種類</div>
        <div class="field-value">
          <select id="new-source-kind">
            <option value="card">カード（明細PDFをアップロード）</option>
            <option value="cash">現金（手入力）</option>
          </select>
        </div>
      </div>
      <div class="toolbar">
        <span class="spacer"></span>
        <button class="btn primary" id="save-source-btn">追加する</button>
      </div>
    `;
    slot.querySelector('#save-source-btn').addEventListener('click', () => {
      const name = slot.querySelector('#new-source-name').value.trim();
      if (!name) return;
      const kind = slot.querySelector('#new-source-kind').value;
      upsertPaymentSource({ name, kind });
      showAddSourceForm = false;
      render(container, ctx);
    });
  }

  function renderSources() {
    const slot = container.querySelector('#sources-slot');
    const sourceRows = sources.map((source) => ({ source, txns: listStatementTransactions(source.id, year, month) }));
    const populated = sourceRows.filter((row) => row.txns.length > 0);
    const empty = sourceRows.filter((row) => row.txns.length === 0);
    const sourceActions = (s) => `
      ${s.kind === 'card' ? `
        <label class="btn ghost" style="cursor:pointer">
          明細をアップロード
          <input type="file" class="statement-file-input" data-source-id="${s.id}" accept="application/pdf" style="display:none">
        </label>
      ` : `<button class="btn ghost add-cash-txn-btn" data-source-id="${s.id}">＋ 明細を追加</button>`}
      <button class="btn ghost archive-source-btn" data-id="${s.id}">この支払元を休止</button>
    `;
    slot.innerHTML = populated.map(({ source: s }) => `
      <div class="card" data-source-id="${s.id}">
        <div class="toolbar">
          <h2 style="margin:0">${escapeHtml(s.name)}</h2>
          <span class="badge good" style="margin-left:8px">${s.kind === 'cash' ? '現金' : 'カード'}</span>
          <span class="spacer"></span>
          ${sourceActions(s)}
        </div>
        <div class="card-note statement-status" data-source-id="${s.id}"></div>
        <div class="cash-txn-form-slot" data-source-id="${s.id}"></div>
        <div id="txn-table-slot-${s.id}"></div>
      </div>
    `).join('') + (empty.length ? `
      <div class="card compact-sources">
        <div class="card-note">${monthLabel(year, month)}分の明細がない支払元</div>
        ${empty.map(({ source: s }) => `
          <div class="compact-source-row" data-source-id="${s.id}">
            <strong>${escapeHtml(s.name)}</strong>
            <span class="badge good">${s.kind === 'cash' ? '現金' : 'カード'}</span>
            <span class="spacer"></span>
            ${sourceActions(s)}
            <div class="statement-status" data-source-id="${s.id}"></div>
            <div class="cash-txn-form-slot" data-source-id="${s.id}"></div>
            <div id="txn-table-slot-${s.id}" style="display:none"></div>
          </div>
        `).join('')}
      </div>
    ` : '');

    const monthTotal = sourceRows.flatMap((row) => row.txns).reduce((sum, txn) => sum + txn.amount, 0);
    container.querySelector('#expense-month-total').innerHTML = `${yen(monthTotal)}<span class="unit">円</span>`;

    sources.forEach((s) => renderTransactionTable(s));

    slot.querySelectorAll('.archive-source-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!confirm('この支払元を休止します。過去の明細データはそのまま残ります。よろしいですか？')) return;
        archivePaymentSource(Number(btn.dataset.id), 1);
        render(container, ctx);
      });
    });

    slot.querySelectorAll('.statement-file-input').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const sourceId = Number(input.dataset.sourceId);
        const source = sources.find((s) => s.id === sourceId);
        await handleStatementUpload(source, file);
        input.value = '';
      });
    });

    slot.querySelectorAll('.add-cash-txn-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sourceId = Number(btn.dataset.sourceId);
        if (cashFormOpenFor.has(sourceId)) cashFormOpenFor.delete(sourceId); else cashFormOpenFor.add(sourceId);
        renderCashForm(sourceId);
      });
    });

    sources.forEach((s) => renderCashForm(s.id));
  }

  function renderCashForm(sourceId) {
    const formSlot = slot0(sourceId);
    if (!formSlot) return;
    if (!cashFormOpenFor.has(sourceId)) { formSlot.innerHTML = ''; return; }
    formSlot.innerHTML = `
      <div class="field-row">
        <div class="field-label">日付</div>
        <div class="field-value"><input type="date" id="cash-date-${sourceId}"></div>
      </div>
      <div class="field-row">
        <div class="field-label">利用先・内容</div>
        <div class="field-value"><input type="text" id="cash-desc-${sourceId}" placeholder="例: 文具店"></div>
      </div>
      <div class="field-row">
        <div class="field-label">金額</div>
        <div class="field-value">
          <input type="text" inputmode="numeric" class="currency-input" id="cash-amount-${sourceId}" value="0">
          <span class="field-suffix">円</span>
        </div>
      </div>
      <div class="toolbar">
        <span class="spacer"></span>
        <button class="btn primary" id="save-cash-${sourceId}">追加する</button>
      </div>
    `;
    enableCurrencyInput(formSlot.querySelector(`#cash-amount-${sourceId}`));
    formSlot.querySelector(`#save-cash-${sourceId}`).addEventListener('click', () => {
      const dateVal = formSlot.querySelector(`#cash-date-${sourceId}`).value;
      const desc = formSlot.querySelector(`#cash-desc-${sourceId}`).value.trim();
      const amount = parseCurrencyInput(formSlot.querySelector(`#cash-amount-${sourceId}`).value);
      if (!desc) return;
      addStatementTransaction({
        source_id: sourceId, year, month, txn_date: dateVal || null, description: desc, amount,
      });
      cashFormOpenFor.delete(sourceId);
      renderSources();
    });
  }

  function slot0(sourceId) {
    return container.querySelector(`.cash-txn-form-slot[data-source-id="${sourceId}"]`);
  }

  async function handleStatementUpload(source, file) {
    const statusEl = container.querySelector(`.statement-status[data-source-id="${source.id}"]`);
    statusEl.textContent = 'PDFを解析しています…';
    let parsed;
    try {
      const rows = await extractPdfTextRows(file);
      parsed = detectAndParse(rows);
    } catch (err) {
      statusEl.textContent = `PDFの解析に失敗しました: ${err.message}`;
      return;
    }
    if (!parsed.format) {
      statusEl.textContent = '対応していない明細フォーマットです（現在、楽天カード・三井住友カードに対応しています）。';
      return;
    }

    clearStatementTransactions(source.id, year, month);
    parsed.transactions.forEach((t) => addStatementTransaction({ source_id: source.id, year, month, ...t }));

    let note = `${parsed.label}の明細として${parsed.transactions.length}件を読み込みました。`;
    if (parsed.unmatched.length > 0) note += `（認識できなかった行が${parsed.unmatched.length}件あります。合計金額を突き合わせて確認してください）`;

    if (getMeta('gdrive_client_id')) {
      statusEl.textContent = `${note} 元のPDFを保存中…`;
      try {
        const uploaded = await gdrive.uploadFile(file, { year, month, category: 'receipt', namePrefix: `${source.name}_明細` });
        addAttachment({
          year, month, drive_file_id: uploaded.id, name: file.name, mime_type: uploaded.mimeType,
          web_view_link: uploaded.webViewLink, category: 'statement', source_id: source.id,
        });
      } catch (err) {
        note += `（元のPDFの保存には失敗しました: ${err.message}）`;
      }
    }

    statusEl.textContent = note;
    renderSources();
  }

  function renderTransactionTable(source) {
    const slot = container.querySelector(`#txn-table-slot-${source.id}`);
    if (!slot) return;
    const txns = listStatementTransactions(source.id, year, month);
    const monthAttachments = listAttachments(year, month);
    const receiptsFor = (txnId) => monthAttachments.filter((a) => a.statement_transaction_id === txnId);
    const gdriveConfigured2 = !!getMeta('gdrive_client_id');

    if (txns.length === 0) {
      slot.innerHTML = `<div class="card-note" style="margin:0">${monthLabel(year, month)}分の明細はまだありません。</div>`;
      return;
    }

    const total = txns.reduce((a, t) => a + t.amount, 0);

    slot.innerHTML = `
      <div class="bulk-table-wrap">
        <table class="ledger">
          <thead>
            <tr><th>日付</th><th>利用店名・内容</th><th class="num">金額</th><th class="no-print">領収書</th><th class="no-print"></th></tr>
          </thead>
          <tbody>
            ${txns.map((t) => `
              <tr data-txn-id="${t.id}">
                <td>${escapeHtml(t.txn_date || '—')}</td>
                <td class="desc">${escapeHtml(t.description)}</td>
                <td class="num">${yen(t.amount)}</td>
                <td class="no-print receipt-cell" data-txn-id="${t.id}" style="max-width:200px">
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <label class="btn ghost" style="cursor:${gdriveConfigured2 ? 'pointer' : 'not-allowed'};${gdriveConfigured2 ? '' : 'opacity:0.45'};font-size:11px;padding:4px 8px;white-space:nowrap;display:inline-block">
                      ＋領収書
                      <input type="file" class="txn-receipt-input" data-txn-id="${t.id}" style="display:none" ${gdriveConfigured2 ? '' : 'disabled'}>
                    </label>
                    ${gdriveConfigured2 ? '' : '<span class="upload-disabled-hint">Google Drive未接続。「設定」タブで接続してください。</span>'}
                    ${receiptsFor(t.id).map((it) => `
                      <span style="display:inline-flex;align-items:center;gap:2px">
                        ${fileChipHtml({ name: it.name, webViewLink: it.web_view_link })}
                        <button class="btn ghost delete-txn-receipt-btn" data-id="${it.id}" data-drive-id="${escapeHtml(it.drive_file_id)}" style="padding:1px 5px;font-size:10px">×</button>
                      </span>
                    `).join('')}
                  </div>
                  <span class="txn-receipt-status card-note" style="margin:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" data-txn-id="${t.id}"></span>
                </td>
                <td class="no-print"><button class="btn ghost delete-txn-btn" data-id="${t.id}">削除</button></td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr><td colspan="2">合計</td><td class="num">${yen(total)}</td><td class="no-print"></td><td class="no-print"></td></tr>
          </tfoot>
        </table>
      </div>
    `;

    slot.querySelectorAll('.delete-txn-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!confirm('この明細行を削除します。よろしいですか？')) return;
        removeStatementTransaction(Number(btn.dataset.id));
        renderSources();
      });
    });

    slot.querySelectorAll('.txn-receipt-input').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const txnId = Number(input.dataset.txnId);
        const statusEl = slot.querySelector(`.txn-receipt-status[data-txn-id="${txnId}"]`);
        statusEl.textContent = 'アップロード中…';
        try {
          const uploaded = await gdrive.uploadFile(file, { year, month, category: 'receipt', namePrefix: source.name });
          addAttachment({
            year, month, drive_file_id: uploaded.id, name: file.name, mime_type: uploaded.mimeType,
            web_view_link: uploaded.webViewLink, category: 'receipt', statement_transaction_id: txnId,
          });
          renderTransactionTable(source);
        } catch (err) {
          statusEl.textContent = err.message;
        }
      });
    });

    slot.querySelectorAll('.delete-txn-receipt-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この領収書を削除します。よろしいですか？（Googleドライブ上のファイルも削除されます）')) return;
        btn.disabled = true;
        try {
          if (gdrive.isConnected()) await gdrive.deleteFile(btn.dataset.driveId);
          removeAttachment(Number(btn.dataset.id));
          renderTransactionTable(source);
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  function renderGeneralReceiptList() {
    const items = listAttachments(year, month).filter((a) => a.category !== 'invoice' && a.category !== 'statement' && !a.statement_transaction_id);
    container.querySelector('#expense-receipt-count').textContent = `${monthLabel(year, month)}：${items.length}件`;
    const listEl = container.querySelector('#expense-receipt-list');
    if (items.length === 0) {
      listEl.innerHTML = `<div class="card-note">まだ領収書がアップロードされていません。</div>`;
      return;
    }
    listEl.innerHTML = `
      <table class="ledger">
        <tbody>
          ${items.map((it) => `
            <tr>
              <td>${fileChipHtml({ name: it.name, webViewLink: it.web_view_link })}</td>
              <td class="num"><button class="btn ghost delete-expense-receipt-btn" data-id="${it.id}" data-drive-id="${escapeHtml(it.drive_file_id)}">削除</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    listEl.querySelectorAll('.delete-expense-receipt-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この領収書を削除します。よろしいですか？（Googleドライブ上のファイルも削除されます）')) return;
        btn.disabled = true;
        try {
          if (gdrive.isConnected()) await gdrive.deleteFile(btn.dataset.driveId);
          removeAttachment(Number(btn.dataset.id));
          renderGeneralReceiptList();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  const fileInput = container.querySelector('#expense-receipt-input');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      const statusEl = container.querySelector('#expense-upload-status');
      for (const file of files) {
        statusEl.textContent = `アップロード中… ${file.name}`;
        try {
          const uploaded = await gdrive.uploadFile(file, { year, month, category: 'receipt' });
          addAttachment({
            year, month,
            drive_file_id: uploaded.id,
            name: file.name,
            mime_type: uploaded.mimeType,
            web_view_link: uploaded.webViewLink,
            category: 'receipt',
          });
        } catch (err) {
          statusEl.textContent = `失敗: ${file.name}（${err.message}）`;
          return;
        }
      }
      statusEl.textContent = '';
      fileInput.value = '';
      renderGeneralReceiptList();
    });
  }
}
