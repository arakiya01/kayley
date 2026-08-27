// 銀行タブ本体。口座の登録・CSV取込・明細一覧・手動でのリンク編集をここに集約する。
// 銀行データは既存4タブ（売掛金・家賃・役員報酬・経費）のテーブルには一切書き込まない。
// あくまで裏付け専用の読み取り層であり、ここで確定した内容は bank_transaction_links にのみ保存される。
import {
  listBankAccounts, upsertBankAccount, archiveBankAccount, importBankTransactions,
  listBankTransactions, listBankTransactionLinks, linkBankTransaction, unlinkBankTransaction,
  officerWithholdingPeriodFor, derivePeriodForKind, IRREGULAR_CATEGORIES, listClients, listOfficers, listPaymentSources,
  accountMatchKey, updateBankTransactionDescription, getMeta, getFoundingDate,
} from '../db.js';
import { escapeHtml, yen, fiscalYearStartOf, fiscalYearMonths } from '../format.js';
import { decodeCsvBytes, parseCsvText, mapCsvRow, assignOccurrenceIndex, verifyRunningBalance, splitHeaderAndRows } from '../bankcsv.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';

let openAccountId = null;
let transactionFilter = 'all'; // 'all' | 'unlinked' | 'linked'
let selectedCategories = new Set();
let rangeFrom = '';
let rangeTo = '';
let searchText = '';
let lastCtxKey = null;

export function render(container, ctx) {
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  function formatDate(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const today = new Date();
  const todayStr = formatDate(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const ctxKey = `${ctx.year}-${ctx.month}`;
  if (ctxKey !== lastCtxKey) {
    ({ from: rangeFrom, to: rangeTo } = monthRange());
    searchText = '';
    lastCtxKey = ctxKey;
  }
  const accounts = listBankAccounts({ includeArchived: true });

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>口座</h2>
        <div class="toolbar"><button class="btn ghost" id="add-account-btn">＋ 口座を追加</button></div>
      </div>
      <div class="card-note">銀行のCSV明細を取り込んで、売掛金・家賃・役員報酬の入力値と照合します。銀行データはここに保存されるだけで、他のタブの数字を書き換えることはありません。完了印は、この月の明細が1件以上あり、すべて分類済みになると付きます。</div>
      <div id="account-list-slot"></div>
    </div>
    <div id="add-account-form-slot"></div>
    <div id="account-detail-slot"></div>
  `;

  if (openAccountId == null && accounts.length > 0) openAccountId = accounts[0].id;
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
      render(container, ctx);
    });
  });

  function monthRange() {
    const end = formatDate(ctx.year, ctx.month, new Date(ctx.year, ctx.month, 0).getDate());
    return {
      from: formatDate(ctx.year, ctx.month, 1),
      to: end > todayStr ? todayStr : end,
    };
  }

  function fiscalYearRange() {
    const fyStart = fiscalYearStartOf(ctx.year, ctx.month, fyStartMonth);
    const months = fiscalYearMonths(fyStart, fyStartMonth);
    const first = months[0];
    const last = months[11];
    const end = formatDate(last.year, last.month, new Date(last.year, last.month, 0).getDate());
    return {
      from: formatDate(first.year, first.month, 1),
      to: end > todayStr ? todayStr : end,
    };
  }

  function fullRange() {
    const founding = getFoundingDate();
    return {
      from: founding ? formatDate(founding.year, founding.month, 1) : '',
      to: todayStr,
    };
  }

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
        render(container, ctx);
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

    renderTransactionList(accountId);

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
    const { header, dataRows: previewSource } = splitHeaderAndRows(table);
    const previewRows = previewSource.slice(0, 4);
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
    const { dataRows } = splitHeaderAndRows(table);
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

    const parts = [`${imported}件を取り込みました`];
    if (skipped > 0) parts.push(`${skipped}件は既に取込済みのためスキップ`);
    if (invalidCount > 0) parts.push(`${invalidCount}件は日付・金額を読み取れず取り込めませんでした`);
    if (balanceMismatches.length > 0) parts.push(`${balanceMismatches.length}件で残高の整合が取れませんでした（取込は完了しています）`);
    container.querySelector('#import-status').textContent = parts.join('／');
    container.querySelector('#mapping-slot').innerHTML = '';
    renderTransactionList(accountId);
  }

  function renderTransactionList(accountId) {
    const slot = container.querySelector('#transaction-list-slot');
    const all = listBankTransactions(accountId);
    const linksByTxn = new Map(all.map((t) => [t.id, listBankTransactionLinks(t.id)]));
    const from = rangeFrom || null;
    const to = rangeTo || null;
    const clients = listClients({ includeArchived: true });
    const officers = listOfficers({ includeArchived: true });
    const searchKeys = searchText.trim().split(/\s+/).filter(Boolean).map(accountMatchKey).filter(Boolean);
    const candidates = all.filter((t) => {
      const links = linksByTxn.get(t.id);
      if (from && t.txn_date < from) return false;
      if (to && t.txn_date > to) return false;
      const amount = Math.abs(t.amount);
      const category = links.length > 0 ? kindLabel(links[0], clients, officers) : '未分類';
      const haystack = accountMatchKey([
        t.description, t.txn_date, String(amount), yen(amount), category,
      ].join(' '));
      if (!searchKeys.every((key) => haystack.includes(key))) return false;
      return true;
    });
    const categoryLabelToGroup = new Map();
    candidates.forEach((t) => {
      const links = linksByTxn.get(t.id);
      if (links.length === 0) return;
      const label = kindLabel(links[0], clients, officers);
      if (!categoryLabelToGroup.has(label)) categoryLabelToGroup.set(label, kindGroupLabel(links[0]));
    });
    const categoryOptions = [...categoryLabelToGroup.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
    const groupOrder = ['家賃', '売掛金', '役員報酬（手取り）', '役員報酬（社会保険料）', '役員報酬（源泉所得税）', '経費', '不定型'];
    const categoryGroups = groupOrder
      .map((group) => ({ group, items: categoryOptions.filter((label) => categoryLabelToGroup.get(label) === group) }))
      .filter(({ items }) => items.length > 0);
    const categoryShortLabel = (label, group) => (label === group
      ? group
      : label.startsWith(`${group}・`) ? label.slice(group.length + 1) : label);
    const basicFilters = ['all', 'unlinked', 'linked'];
    if (!basicFilters.includes(transactionFilter)) transactionFilter = 'all';
    selectedCategories = new Set([...selectedCategories].filter((category) => categoryOptions.includes(category)));
    const rows = candidates.filter((t) => {
      const links = linksByTxn.get(t.id);
      if (transactionFilter === 'unlinked') return links.length === 0;
      if (transactionFilter === 'linked') {
        return links.length > 0 && selectedCategories.has(kindLabel(links[0], clients, officers));
      }
      if (transactionFilter === 'all') return true;
      return false;
    });
    const presets = [
      { key: 'month', label: '選択月', range: monthRange() },
      { key: 'fy', label: '選択期', range: fiscalYearRange() },
      { key: 'all', label: '全期間', range: fullRange() },
    ];
    const isActiveRange = (range) => rangeFrom === range.from && rangeTo === range.to;

    slot.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>明細</h2>
          <div class="toolbar bank-toolbar">
            <div class="bank-filter-group period-filter-group">
              <input type="date" id="range-from" aria-label="明細の開始日" value="${rangeFrom}" max="${todayStr}">
              <span>〜</span>
              <input type="date" id="range-to" aria-label="明細の終了日" value="${rangeTo}" max="${todayStr}">
              ${presets.map(({ key, label, range }) => `<button class="btn ghost bank-filter-btn ${isActiveRange(range) ? 'active' : ''}" type="button" data-period-preset="${key}">${label}</button>`).join('')}
            </div>
            <input type="text" id="desc-search" class="transaction-search-input" placeholder="検索（摘要・金額・日付・分類）" value="${escapeHtml(searchText)}">
            <div class="bank-filter-group category-filter-group">
              ${[
                ['all', '全件'], ['unlinked', '未分類'], ['linked', '分類済'],
              ].map(([value, label]) => `<button class="btn ghost bank-filter-btn ${transactionFilter === value ? 'active' : ''}" type="button" data-txn-filter="${escapeHtml(value)}">${escapeHtml(label)}</button>`).join('')}
            </div>
            ${transactionFilter === 'linked' && categoryGroups.length > 0 ? `
              <div class="category-groups">
                ${categoryGroups.map(({ group, items }) => `
                  <div class="category-group">
                    <span class="category-group-label">${escapeHtml(group)}</span>
                    ${items.map((category) => `
                      <label class="category-checkbox-item">
                        <input type="checkbox" class="category-checkbox" value="${escapeHtml(category)}" ${selectedCategories.has(category) ? 'checked' : ''}>
                        <span>${escapeHtml(categoryShortLabel(category, group))}</span>
                      </label>
                    `).join('')}
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
        </div>
        ${rows.length === 0 ? '<div class="card-note" style="margin:0">明細がありません。</div>' : `
        <table class="ledger">
          <thead><tr><th>日付</th><th class="desc">摘要</th><th class="num">金額</th><th>分類</th></tr></thead>
          <tbody>
            ${rows.map((t) => {
              const links = linksByTxn.get(t.id);
              return `
                <tr data-txn-id="${t.id}">
                  <td>${escapeHtml(t.txn_date)}</td>
                  <td class="desc"><input type="text" class="desc-edit-input" data-id="${t.id}" value="${escapeHtml(t.description)}"></td>
                  <td class="num ${t.amount >= 0 ? 'txn-amount-in' : 'txn-amount-out'}">${t.amount >= 0 ? yen(t.amount) : `−${yen(Math.abs(t.amount))}`}</td>
                  <td>${links.length > 0 ? linkSummaryHtml(links[0], clients, officers) : `<button class="btn ghost link-btn" data-id="${t.id}">分類する</button>`}</td>
                </tr>
                <tr class="link-editor-row" data-editor-for="${t.id}" style="display:none"><td colspan="4"></td></tr>
              `;
            }).join('')}
          </tbody>
        </table>
        `}
      </div>
    `;

    slot.querySelectorAll('[data-period-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = presets.find(({ key }) => key === btn.dataset.periodPreset);
        ({ from: rangeFrom, to: rangeTo } = preset.range);
        renderTransactionList(accountId);
      });
    });
    const fromInput = slot.querySelector('#range-from');
    fromInput.addEventListener('change', (e) => { rangeFrom = e.target.value; renderTransactionList(accountId); });
    const toInput = slot.querySelector('#range-to');
    toInput.addEventListener('change', (e) => { rangeTo = e.target.value; renderTransactionList(accountId); });
    const searchInput = slot.querySelector('#desc-search');
    searchInput.addEventListener('input', (e) => {
      searchText = e.target.value;
      const cursorPos = e.target.selectionStart;
      renderTransactionList(accountId);
      const newInput = container.querySelector('#desc-search');
      if (newInput) { newInput.focus(); newInput.setSelectionRange(cursorPos, cursorPos); }
    });
    slot.querySelectorAll('[data-txn-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextFilter = btn.dataset.txnFilter;
        // 分類済に切り替えた瞬間のチェック状態は、直前がどのボタンだったかで決める。
        // 全件から来た場合は「今まで通り全部表示」を維持するため全チェック、
        // 未分類から来た場合は「何も選んでいない」を維持するため全部チェックなしにする。
        if (nextFilter === 'linked' && transactionFilter !== 'linked') {
          selectedCategories = transactionFilter === 'unlinked' ? new Set() : new Set(categoryOptions);
        }
        transactionFilter = nextFilter;
        renderTransactionList(accountId);
      });
    });
    slot.querySelectorAll('.category-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        selectedCategories = new Set(Array.from(slot.querySelectorAll('.category-checkbox:checked')).map((el) => el.value));
        renderTransactionList(accountId);
      });
    });

    slot.querySelectorAll('.desc-edit-input').forEach((input) => {
      input.addEventListener('change', () => {
        const val = input.value.trim();
        const original = all.find((t) => t.id === Number(input.dataset.id));
        if (!val) { input.value = original.description; return; }
        updateBankTransactionDescription(Number(input.dataset.id), val);
        renderTransactionList(accountId);
      });
    });

    slot.querySelectorAll('.link-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const txnId = Number(btn.dataset.id);
        openLinkEditor(accountId, txnId, rows.find((r) => r.id === txnId), clients, officers);
      });
    });

    slot.querySelectorAll('.unlink-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        unlinkBankTransaction(Number(btn.dataset.linkId));
        renderTransactionList(accountId);
      });
    });
  }

  function kindGroupLabel(link) {
    return {
      rent: '家賃', ar: '売掛金', officer_net: '役員報酬（手取り）',
      officer_insurance: '役員報酬（社会保険料）', officer_withholding: '役員報酬（源泉所得税）',
      expense_card: '経費',
    }[link.kind] || '不定型';
  }

  function kindLabel(link, clients, officers) {
    const label = {
      rent: '家賃', ar: '売掛金', officer_net: '役員報酬（手取り）',
      officer_insurance: '役員報酬（社会保険料）', officer_withholding: '役員報酬（源泉所得税）',
      expense_card: link.category ? `経費（${link.category}の引落）` : '経費（カード引落）',
    }[link.kind] || (link.category || '不定型');
    const clientName = link.kind === 'ar' && link.client_id ? (clients.find((c) => c.id === link.client_id)?.name || '') : '';
    const officerName = link.kind === 'officer_net' && link.officer_id ? (officers.find((o) => o.id === link.officer_id)?.name || '') : '';
    const subLabel = clientName || officerName;
    return `${label}${subLabel ? `・${subLabel}` : ''}`;
  }

  function linkSummaryHtml(link, clients, officers) {
    return `<span class="badge good">${escapeHtml(kindLabel(link, clients, officers))}</span> <button class="btn ghost unlink-btn" data-link-id="${link.id}">解除する</button>`;
  }

  function openLinkEditor(accountId, txnId, txn, clients, officers) {
    const editorRow = container.querySelector(`tr[data-editor-for="${txnId}"]`);
    if (!editorRow) return;
    const cell = editorRow.querySelector('td');
    const cards = listPaymentSources({ includeArchived: true }).filter((s) => s.kind === 'card');
    // 同じ摘要（正規化した振込名義）を持つ取引をまとめて候補にする。分類済みのものも含める
    // （前後の月で先に分類済みだと未分類だけでは候補から消え、常に後ろの日付しか残らないため。
    // 含めることで、間違えて分類したものをここからまとめて分類し直せるようにもなる）。
    // 摘要だけで自動確定はせず、未分類のものだけ既定でチェックし、それ以外は必ず手動で
    // チェックを入れさせる（役員個人の口座が立替精算など別目的の振込も同じ摘要で受け取るケースがあるため）。
    const matchKey = accountMatchKey(txn.description);
    const candidates = listBankTransactions(accountId)
      .filter((t) => accountMatchKey(t.description) === matchKey)
      .map((t) => ({ txn: t, links: listBankTransactionLinks(t.id) }))
      .sort((a, b) => (a.txn.txn_date < b.txn.txn_date ? -1 : a.txn.txn_date > b.txn.txn_date ? 1 : 0));
    cell.innerHTML = `
      <div class="field-row">
        <div class="field-label">分類</div>
        <div class="field-value">
          <select id="link-kind-${txnId}">
            <option value="rent">家賃</option>
            <option value="ar">売掛金</option>
            <option value="officer_net">役員報酬（手取り）</option>
            <option value="officer_insurance">役員報酬（社会保険料）</option>
            <option value="officer_withholding">役員報酬（源泉所得税）</option>
            <option value="expense_card">経費（カードの引落）</option>
            <option value="irregular">不定型</option>
          </select>
        </div>
      </div>
      <div class="field-row" id="link-client-row-${txnId}" style="display:none">
        <div class="field-label">得意先</div>
        <div class="field-value">
          <select id="link-client-${txnId}">${clients.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field-row" id="link-officer-row-${txnId}" style="display:none">
        <div class="field-label">役員</div>
        <div class="field-value">
          <select id="link-officer-${txnId}">${officers.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field-row" id="link-category-row-${txnId}" style="display:none">
        <div class="field-label">カテゴリ</div>
        <div class="field-value">
          <select id="link-category-${txnId}">${IRREGULAR_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field-row" id="link-card-row-${txnId}" style="display:none">
        <div class="field-label">カード</div>
        <div class="field-value">
          <select id="link-card-${txnId}">${cards.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('')}</select>
        </div>
        <div class="card-note" style="margin:0">経費タブは合否判定をしません。どのカードの引落か記録するだけの参考情報です。</div>
      </div>
      <div class="field-row" id="link-employer-share-row-${txnId}" style="display:none">
        <div class="field-label">会社負担分</div>
        <div class="field-value">
          <input type="text" inputmode="numeric" class="currency-input" id="link-employer-share-${txnId}" value="0">
          <span class="field-suffix">円</span>
        </div>
        <div class="card-note" style="margin:0">
          社会保険料は労使折半で、この引落額には役員の給与から天引き済みの分（自動集計）と会社負担分の両方が含まれます。
          会社が上乗せする分だけをここに入力してください。
        </div>
      </div>
      <div class="field-row">
        <div class="field-label">同じ摘要の取引（${candidates.length}件）</div>
        <div class="field-value">
          <div class="candidate-list">
            ${candidates.map(({ txn: c, links: cLinks }) => `
              <label class="candidate-item">
                <input type="checkbox" class="candidate-checkbox" data-id="${c.id}" ${cLinks.length === 0 ? 'checked' : ''}>
                <span>${escapeHtml(c.txn_date)}</span>
                <span class="num">${c.amount >= 0 ? yen(c.amount) : `−${yen(Math.abs(c.amount))}`}円</span>
                <span class="desc">${escapeHtml(c.description)}</span>
                ${cLinks.length > 0 ? `<span class="badge muted">現在: ${escapeHtml(kindLabel(cLinks[0], clients, officers))}</span>` : ''}
              </label>
            `).join('')}
          </div>
          <div class="card-note" style="margin:4px 0 0">違うものはチェックを外してください。分類済みのものにチェックを入れると、上で選んだ分類に変更されます。</div>
        </div>
      </div>
      <div class="toolbar">
        <span class="spacer"></span>
        <button class="btn ghost" id="link-cancel-${txnId}">キャンセル</button>
        <button class="btn primary" id="link-confirm-${txnId}">確定する</button>
      </div>
    `;
    editorRow.style.display = '';

    const kindSelect = cell.querySelector(`#link-kind-${txnId}`);
    const updateVisibility = () => {
      cell.querySelector(`#link-client-row-${txnId}`).style.display = kindSelect.value === 'ar' ? '' : 'none';
      cell.querySelector(`#link-officer-row-${txnId}`).style.display = kindSelect.value === 'officer_net' ? '' : 'none';
      cell.querySelector(`#link-category-row-${txnId}`).style.display = kindSelect.value === 'irregular' ? '' : 'none';
      cell.querySelector(`#link-card-row-${txnId}`).style.display = kindSelect.value === 'expense_card' ? '' : 'none';
      cell.querySelector(`#link-employer-share-row-${txnId}`).style.display = kindSelect.value === 'officer_insurance' ? '' : 'none';
    };
    kindSelect.addEventListener('change', updateVisibility);
    updateVisibility();
    enableCurrencyInput(cell.querySelector(`#link-employer-share-${txnId}`));

    cell.querySelector(`#link-cancel-${txnId}`).addEventListener('click', () => { editorRow.style.display = 'none'; });

    cell.querySelector(`#link-confirm-${txnId}`).addEventListener('click', () => {
      const kind = kindSelect.value;
      const clientId = kind === 'ar' ? Number(cell.querySelector(`#link-client-${txnId}`).value) : null;
      const officerId = kind === 'officer_net' ? Number(cell.querySelector(`#link-officer-${txnId}`).value) : null;
      // category列は irregular のカテゴリ名と expense_card のカード名の両方の置き場として使う
      // （新しい列を増やさず、既存の bank_transaction_links.category をそのまま再利用する）。
      let category = null;
      if (kind === 'irregular') category = cell.querySelector(`#link-category-${txnId}`).value;
      if (kind === 'expense_card') category = cell.querySelector(`#link-card-${txnId}`)?.value || null;
      const employerInsuranceShare = kind === 'officer_insurance'
        ? parseCurrencyInput(cell.querySelector(`#link-employer-share-${txnId}`).value)
        : null;
      const checkedIds = Array.from(cell.querySelectorAll('.candidate-checkbox:checked')).map((cb) => Number(cb.dataset.id));
      if (checkedIds.length === 0) return;
      checkedIds.forEach((id) => {
        const found = candidates.find((c) => c.txn.id === id);
        // 既に分類済みなら、先に解除してから新しい分類で作り直す（分類し直し）。
        found.links.forEach((existing) => unlinkBankTransaction(existing.id));
        const [cy, cm] = found.txn.txn_date.split('-').map(Number);
        const period = derivePeriodForKind(kind, cy, cm);
        linkBankTransaction({
          bank_transaction_id: id, kind, client_id: clientId, officer_id: officerId, category,
          employer_insurance_share: employerInsuranceShare, ...period,
        });
      });
      container.querySelector('#import-status').textContent = `${checkedIds.length}件を分類しました`;
      renderTransactionList(accountId);
    });
  }
}
