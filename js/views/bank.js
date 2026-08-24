// 銀行タブ本体。口座の登録・CSV取込・明細一覧・手動でのリンク編集をここに集約する。
// 銀行データは既存4タブ（売掛金・家賃・役員報酬・経費）のテーブルには一切書き込まない。
// あくまで裏付け専用の読み取り層であり、ここで確定した内容は bank_transaction_links にのみ保存される。
import { listBankAccounts, upsertBankAccount, archiveBankAccount } from '../db.js';
import { escapeHtml } from '../format.js';

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
    // Task 8 で実装する（CSV取込・明細一覧・リンク編集）
    const slot = container.querySelector('#account-detail-slot');
    const account = accounts.find((a) => a.id === accountId);
    slot.innerHTML = `<div class="card"><h2>${escapeHtml(account.name)}</h2><div class="card-note" style="margin:0">明細の取込はまだ実装されていません。</div></div>`;
  }
}
