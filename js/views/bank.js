// 銀行タブ本体。口座の登録・CSV取込・明細一覧・手動でのリンク編集をここに集約する。
// 銀行データは既存4タブ（売掛金・家賃・役員報酬・経費）のテーブルには一切書き込まない。
// あくまで裏付け専用の読み取り層であり、ここで確定した内容は bank_transaction_links にのみ保存される。
import { listBankAccounts, upsertBankAccount, archiveBankAccount, importBankTransactions, applyBankPayeeAliasesToAccount } from '../db.js';
import { escapeHtml } from '../format.js';
import { decodeCsvBytes, parseCsvText, mapCsvRow, assignOccurrenceIndex, verifyRunningBalance } from '../bankcsv.js';

let openAccountId = null;

export function render(container) {
  const accounts = listBankAccounts({ includeArchived: true });

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>口座</h2>
        <div class="toolbar"><button class="btn ghost" id="add-account-btn">＋ 口座を追加</button></div>
      </div>
      <div class="card-note">銀行のCSV明細を取り込んで、売掛金・家賃・役員報酬の入力値と照合します。銀行データはここに保存されるだけで、他のタブの数字を書き換えることはありません。</div>
      <div id="account-list-slot"></div>
    </div>
    <div id="add-account-form-slot"></div>
    <div id="account-detail-slot"></div>
  `;

  renderAccountList();
  if (openAccountId != null && accounts.some((a) => a.id === openAccountId)) {
    openAccountDetail(openAccountId);
  }

  container.querySelector('#add-account-btn').addEventListener('click', () => {
    const slot = container.querySelector('#add-account-form-slot');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <div class="card">
        <h2>口座を追加</h2>
        <div class="field-row">
          <div class="field-label">口座名</div>
          <div class="field-value"><input type="text" id="new-account-name" placeholder="例: ○○銀行 普通"></div>
        </div>
        <div class="toolbar">
          <span class="spacer"></span>
          <button class="btn primary" id="save-account-btn">追加する</button>
        </div>
      </div>
    `;
    slot.querySelector('#save-account-btn').addEventListener('click', () => {
      const name = slot.querySelector('#new-account-name').value.trim();
      if (!name) return;
      const id = upsertBankAccount({ name });
      slot.innerHTML = '';
      openAccountId = id;
      render(container);
    });
  });

  function renderAccountList() {
    const slot = container.querySelector('#account-list-slot');
    if (accounts.length === 0) {
      slot.innerHTML = '<div class="card-note" style="margin:0">まだ口座が登録されていません。「＋ 口座を追加」から始めましょう。</div>';
      return;
    }
    slot.innerHTML = `
      <table class="ledger">
        <thead><tr><th>口座名</th><th>状態</th><th></th><th></th></tr></thead>
        <tbody>
          ${accounts.map((a) => `
            <tr data-account-id="${a.id}">
              <td>${escapeHtml(a.name)}</td>
              <td>${a.archived ? '休止中' : '有効'}</td>
              <td><button class="btn ghost open-account-btn" data-id="${a.id}">明細を見る</button></td>
              <td><button class="btn ghost archive-account-btn" data-id="${a.id}" data-archived="${a.archived}">${a.archived ? '再開する' : '休止する'}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    slot.querySelectorAll('.archive-account-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        archiveBankAccount(Number(btn.dataset.id), btn.dataset.archived === '1' ? 0 : 1);
        render(container);
      });
    });
    slot.querySelectorAll('.open-account-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openAccountId = Number(btn.dataset.id);
        openAccountDetail(openAccountId);
      });
    });
  }

  function openAccountDetail(accountId) {
    const slot = container.querySelector('#account-detail-slot');
    const account = accounts.find((a) => a.id === accountId);
    slot.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>${escapeHtml(account.name)}</h2>
          <div class="toolbar">
            <label class="btn ghost">CSVを取り込む<input type="file" id="csv-file-input" accept=".csv" style="display:none"></label>
          </div>
        </div>
        <div id="import-status" class="card-note"></div>
        <div id="mapping-slot"></div>
      </div>
      <div id="transaction-list-slot"></div>
    `;

    slot.querySelector('#csv-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text, encoding } = decodeCsvBytes(bytes);
      const table = parseCsvText(text);
      if (table.length === 0) {
        slot.querySelector('#import-status').textContent = 'CSVから行を読み取れませんでした。';
        return;
      }
      const savedMapping = account.csv_mapping_json ? JSON.parse(account.csv_mapping_json) : null;
      if (savedMapping) {
        commitImport(accountId, account, table, savedMapping, encoding);
      } else {
        showMappingForm(accountId, account, table, encoding);
      }
    });
  }

  function showMappingForm(accountId, account, table, encoding) {
    const slot = container.querySelector('#mapping-slot');
    const header = table[0];
    const previewRows = table.slice(0, 4);
    // allowEmpty=true の項目は「（使わない）」を既定選択にする。末尾に追加するだけだと
    // ブラウザの既定動作で先頭の列（日付列など）が誤って選択されたままになってしまうため。
    const colOptions = (allowEmpty) => header.map((_, i) => `<option value="${i}">列${i + 1}: ${escapeHtml(header[i] || '')}</option>`).join('')
      + (allowEmpty ? '<option value="" selected>（使わない）</option>' : '');

    slot.innerHTML = `
      <div class="card-note">この口座は初めての取込です。どの列が何を表すか選んでください（次回から自動で使われます）。</div>
      <div class="bulk-table-wrap">
        <table class="ledger">
          <tbody>
            ${previewRows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="field-row"><div class="field-label">日付の列</div><div class="field-value"><select id="map-date">${colOptions(false)}</select></div></div>
      <div class="field-row"><div class="field-label">摘要・振込名義の列</div><div class="field-value"><select id="map-desc">${colOptions(false)}</select></div></div>
      <div class="field-row"><div class="field-label">金額の列（符号付き1列の場合）</div><div class="field-value"><select id="map-amount">${colOptions(true)}</select></div></div>
      <div class="field-row"><div class="field-label">入金額の列（別列の場合）</div><div class="field-value"><select id="map-deposit">${colOptions(true)}</select></div></div>
      <div class="field-row"><div class="field-label">出金額の列（別列の場合）</div><div class="field-value"><select id="map-withdrawal">${colOptions(true)}</select></div></div>
      <div class="field-row"><div class="field-label">残高の列（あれば）</div><div class="field-value"><select id="map-balance">${colOptions(true)}</select></div></div>
      <div class="toolbar"><span class="spacer"></span><button class="btn primary" id="confirm-mapping-btn">この対応で取り込む</button></div>
    `;

    slot.querySelector('#confirm-mapping-btn').addEventListener('click', () => {
      const val = (id) => { const v = slot.querySelector(id).value; return v === '' ? null : Number(v); };
      const mapping = {
        dateCol: val('#map-date'), descCol: val('#map-desc'), payerCol: null,
        amountCol: val('#map-amount'), depositCol: val('#map-deposit'), withdrawalCol: val('#map-withdrawal'),
        balanceCol: val('#map-balance'),
      };
      upsertBankAccount({ ...account, csv_mapping_json: JSON.stringify(mapping), csv_encoding: encoding });
      account.csv_mapping_json = JSON.stringify(mapping);
      commitImport(accountId, account, table, mapping, encoding);
    });
  }

  function commitImport(accountId, account, table, mapping, encoding) {
    const dataRows = table.slice(1);
    const mapped = dataRows.map((cells) => mapCsvRow(cells, mapping));
    const invalidCount = mapped.filter((r) => !r.valid).length;
    const validRows = mapped.filter((r) => r.valid);
    const sorted = validRows.slice().sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : 0));
    const withOccurrence = assignOccurrenceIndex(sorted);
    const openingBalance = withOccurrence.length && withOccurrence[0].balance_after != null
      ? withOccurrence[0].balance_after - withOccurrence[0].amount
      : 0;
    const balanceMismatches = verifyRunningBalance(withOccurrence, openingBalance);
    const { imported, skipped } = importBankTransactions(accountId, withOccurrence);
    const aliasApplied = applyBankPayeeAliasesToAccount(accountId);

    const parts = [`${imported}件を取り込みました`];
    if (skipped > 0) parts.push(`${skipped}件は既に取込済みのためスキップ`);
    if (invalidCount > 0) parts.push(`${invalidCount}件は日付・金額を読み取れず取り込めませんでした`);
    if (balanceMismatches.length > 0) parts.push(`${balanceMismatches.length}件で残高の整合が取れませんでした（取込は完了しています）`);
    if (aliasApplied > 0) parts.push(`${aliasApplied}件は学習済みの振込名義から自動で分類しました`);
    container.querySelector('#import-status').textContent = parts.join('／');
    container.querySelector('#mapping-slot').innerHTML = '';
    renderTransactionList(accountId);
  }

  function renderTransactionList(accountId) {
    // Task 9 で実装する
  }
}
