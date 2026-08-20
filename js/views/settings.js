import { getMeta, setMeta, listClients, upsertClient, archiveClient, exportBytes, importBytes } from '../db.js';
import { Storage } from '../storage.js';
import { escapeHtml } from '../format.js';

export function render(container) {
  const companyName = getMeta('company_name') || '';
  const fyStart = getMeta('fiscal_year_start_month') || '4';
  const defaultPct = getMeta('default_utility_personal_pct') || '40';
  const clients = listClients({ includeArchived: true });

  container.innerHTML = `
    <div class="card">
      <h2>会社情報</h2>
      <div class="field-row">
        <div class="field-label">会社名</div>
        <input type="text" id="company_name" value="${escapeHtml(companyName)}">
      </div>
      <div class="field-row">
        <div class="field-label">会計年度の開始月<span class="hint">ダッシュボードの年度累計に使用</span></div>
        <select id="fy_start">
          ${Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}" ${String(m) === String(fyStart) ? 'selected' : ''}>${m}月</option>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <div class="field-label">光熱費 個人負担率のデフォルト<span class="hint">新規の月を入力する際の初期値</span></div>
        <input type="number" id="default_pct" value="${escapeHtml(defaultPct)}">
        <span class="field-suffix">％</span>
      </div>
    </div>

    <div class="card">
      <h2>得意先の管理</h2>
      <table class="ledger">
        <thead><tr><th>得意先</th><th class="num">開始残高</th><th>状態</th><th></th></tr></thead>
        <tbody>
          ${clients.map((c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td class="num">${c.opening_balance}</td>
              <td>${c.archived ? '休止中' : '有効'}</td>
              <td><button class="btn ghost archive-btn" data-id="${c.id}" data-archived="${c.archived}">${c.archived ? '再開する' : '休止する'}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>バックアップ</h2>
      <div class="card-note">データはこのブラウザにのみ保存されています（保存先: ${Storage.backend === 'opfs' ? 'OPFS' : 'IndexedDB'}）。他のPCへ移す・万一に備える場合は下記からファイルとして書き出してください。</div>
      <div class="toolbar">
        <button class="btn primary" id="export-btn">.sqliteをエクスポート</button>
        <label class="btn ghost" style="cursor:pointer">
          .sqliteをインポート
          <input type="file" id="import-file" accept=".sqlite,.db" style="display:none">
        </label>
      </div>
    </div>
  `;

  container.querySelector('#company_name').addEventListener('change', (e) => setMeta('company_name', e.target.value));
  container.querySelector('#fy_start').addEventListener('change', (e) => setMeta('fiscal_year_start_month', e.target.value));
  container.querySelector('#default_pct').addEventListener('change', (e) => setMeta('default_utility_personal_pct', e.target.value));

  container.querySelectorAll('.archive-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const archived = btn.dataset.archived === '1' ? 0 : 1;
      archiveClient(Number(btn.dataset.id), archived);
      render(container);
    });
  });

  container.querySelector('#export-btn').addEventListener('click', () => {
    Storage.downloadBackup(exportBytes());
  });

  container.querySelector('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('現在のデータを上書きしてインポートします。よろしいですか？')) return;
    const bytes = await Storage.readFile(file);
    await importBytes(bytes);
    location.reload();
  });
}
