import {
  getMeta, setMeta, listClients, upsertClient, archiveClient, exportBytes, importBytes,
  listThemePresets, addThemePreset, removeThemePreset,
} from '../db.js';
import { Storage } from '../storage.js';
import { escapeHtml } from '../format.js';
import * as gdrive from '../gdrive.js';
import { applyTheme, fileToResizedDataUrl, contrastRatio, deriveInkVariants } from '../theme.js';

let showClientIdOverride = false;
let showSavePresetForm = false;

function randomHex() {
  return `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

export function render(container) {
  const companyName = getMeta('company_name') || '';
  const fyStart = getMeta('fiscal_year_start_month') || '4';
  const defaultPct = getMeta('default_utility_personal_pct') || '40';
  const foundingYear = getMeta('founding_year') || '';
  const foundingMonth = getMeta('founding_month') || '';
  const thisYear = new Date().getFullYear();
  const clients = listClients({ includeArchived: true });
  const gdriveClientId = getMeta('gdrive_client_id') || '';
  const gdriveConnected = gdrive.isConnected();
  const showClientIdField = showClientIdOverride || !gdriveClientId;

  const bgColor = getMeta('theme_bg_color') || '#FBF8F1';
  const cardColor = getMeta('theme_card_color') || '#F7F1E3';
  const inkColor = getMeta('theme_ink_color') || '#22344A';
  const pattern = getMeta('theme_pattern') || 'grid';
  const bgImage = getMeta('theme_bg_image') || '';
  const bgImageTarget = getMeta('theme_bg_image_target') || 'background';

  const savedPresets = listThemePresets();

  const contrastCard = contrastRatio(inkColor, cardColor);
  const contrastBg = contrastRatio(inkColor, bgColor);
  const contrastBadge = (ratio) => {
    if (ratio >= 7) return `<span class="badge good">${ratio.toFixed(1)}:1 ・ 十分読みやすい</span>`;
    if (ratio >= 4.5) return `<span class="badge good">${ratio.toFixed(1)}:1 ・ 通常の文字にOK</span>`;
    if (ratio >= 3) return `<span class="badge warning">${ratio.toFixed(1)}:1 ・ 大きい文字のみ</span>`;
    return `<span class="badge critical">${ratio.toFixed(1)}:1 ・ 読みにくい</span>`;
  };

  container.innerHTML = `
    <div class="card">
      <h2>会社情報</h2>
      <div class="field-row">
        <div class="field-label">会社名</div>
        <input type="text" id="company_name" value="${escapeHtml(companyName)}">
      </div>
      <div class="field-row">
        <div class="field-label">創業年月<span class="hint">この年月より前は記帳できないようにします（未設定なら制限なし）</span></div>
        <input type="number" id="founding_year" placeholder="例: 2024" value="${escapeHtml(foundingYear)}" min="1990" max="${thisYear + 1}">
        <select id="founding_month">
          <option value="">月を選択</option>
          ${Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}" ${String(m) === String(foundingMonth) ? 'selected' : ''}>${m}月</option>`).join('')}
        </select>
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

    <div class="card">
      <h2>Google Drive連携（証憑の保存）</h2>
      <div class="card-note">
        領収書・請求書などのファイルを、あなた自身のGoogleドライブ内の専用フォルダ（「Kayley - 証憑」）に保存できるようにします。
        このアプリにサーバーは無く、ブラウザから直接Googleへ送信します。使用する権限は <strong>drive.file</strong>（このアプリが作成したファイルにしか触れない、最も限定的な権限）のみで、ドライブ内の他のファイルは一切見えません。
      </div>
      ${showClientIdField ? `
        <div class="field-row">
          <div class="field-label">OAuthクライアントID<span class="hint">Google Cloud ConsoleでOAuthクライアント（種類: ウェブアプリケーション）を作成し、承認済みのJavaScript生成元にこのアプリのURLを登録してから、クライアントIDを貼り付けてください</span></div>
          <input type="text" id="gdrive_client_id" placeholder="xxxxxxxxxx.apps.googleusercontent.com" value="${escapeHtml(gdriveClientId)}">
        </div>
      ` : `
        <div class="field-row">
          <div class="field-label">OAuthクライアントID</div>
          <span class="card-note" style="margin:0">設定済み</span>
          <button class="btn ghost" id="gdrive-edit-client-id-btn" style="justify-self:start">変更する</button>
        </div>
      `}
      <div class="toolbar">
        <span class="badge ${gdriveConnected ? 'good' : 'warning'}">${gdriveConnected ? '接続済み' : (gdriveClientId ? '未接続（アップロード時に自動で繋ぎ直します）' : '未接続')}</span>
        <span class="spacer"></span>
        <button class="btn primary" id="gdrive-connect-btn">接続する</button>
        <button class="btn ghost" id="gdrive-disconnect-btn" ${gdriveConnected ? '' : 'disabled'}>切断する</button>
      </div>
      <div id="gdrive-status-note" class="card-note"></div>
    </div>

    <div class="card">
      <h2>外観</h2>
      <div class="card-note">背景・カードの色やパターンを好みに変更できます。</div>
      <div class="field-row">
        <div class="field-label">背景色</div>
        <input type="color" id="theme_bg_color" value="${bgColor}" style="max-width:70px;padding:2px">
      </div>
      <div class="field-row">
        <div class="field-label">カードの色</div>
        <input type="color" id="theme_card_color" value="${cardColor}" style="max-width:70px;padding:2px">
      </div>
      <div class="field-row">
        <div class="field-label">文字色</div>
        <input type="color" id="theme_ink_color" value="${inkColor}" style="max-width:70px;padding:2px">
      </div>
      <div class="field-row">
        <div class="field-label">背景パターン</div>
        <select id="theme_pattern">
          <option value="grid" ${pattern === 'grid' ? 'selected' : ''}>方眼（デフォルト）</option>
          <option value="dots" ${pattern === 'dots' ? 'selected' : ''}>ドット</option>
          <option value="none" ${pattern === 'none' ? 'selected' : ''}>なし（単色）</option>
        </select>
      </div>

      <div class="card-note" style="margin-top:14px">
        文字色とのコントラスト（
        <a href="https://colorable.jxnblk.com/" target="_blank" rel="noopener">colorable</a>
        と同じ考え方の簡易チェックです）
      </div>
      <div id="contrast-check" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
        <span>文字 × カード: ${contrastBadge(contrastCard)}</span>
        <span>文字 × 背景: ${contrastBadge(contrastBg)}</span>
      </div>

      <div class="card-note" style="margin-top:16px">配色プリセット</div>
      <div class="toolbar" style="flex-wrap:wrap">
        <button class="btn ghost preset-btn" data-bg="#FBF8F1" data-card="#F7F1E3" data-ink="#22344A">帳簿（デフォルト）</button>
        <button class="btn ghost preset-btn" data-bg="#FDF6E3" data-card="#FBB936" data-ink="#1249CC">山吹×藍</button>
        <button class="btn ghost preset-btn" data-bg="#0F1720" data-card="#1B2836" data-ink="#E7ECF2">夜間モード</button>
        <button class="btn ghost" id="theme-random-btn">🎲 ランダムに試す</button>
        <button class="btn ghost" id="theme-random-readable-btn">🎲 読みやすいものだけ</button>
      </div>
      <div class="card-note" style="margin:0">「ランダムに試す」は読みにくい組み合わせも出ます。「読みやすいものだけ」は文字×カード・文字×背景の両方が「十分読みやすい」（7:1以上）になるまで振り直します。</div>

      <div class="card-note" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--hairline)">お気に入り</div>
      <div class="toolbar">
        <button class="btn ghost" id="theme-save-preset-btn">＋ 今の配色を保存</button>
        <span class="spacer"></span>
      </div>
      ${showSavePresetForm ? `
        <div class="field-row">
          <div class="field-label">名前<span class="hint">空欄でも保存できます</span></div>
          <input type="text" id="new-preset-name" placeholder="例: 秋っぽいやつ">
          <button class="btn primary" id="save-preset-confirm-btn">保存する</button>
        </div>
      ` : ''}
      ${savedPresets.length === 0 ? `
        <div class="card-note" style="margin:0">保存された配色はまだありません。気に入った組み合わせが見つかったら「＋ 今の配色を保存」で残せます。</div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
          ${savedPresets.map((p) => `
            <div style="display:flex;align-items:center;gap:10px">
              <div style="display:flex;gap:2px;flex-shrink:0">
                <span style="width:18px;height:18px;background:${p.bg_color};border:1px solid var(--grid-line);display:inline-block"></span>
                <span style="width:18px;height:18px;background:${p.card_color};border:1px solid var(--grid-line);display:inline-block"></span>
                <span style="width:18px;height:18px;background:${p.ink_color};border:1px solid var(--grid-line);display:inline-block"></span>
              </div>
              <span style="flex:1;font-size:13.5px">${escapeHtml(p.name || '（名前なし）')}</span>
              <button class="btn ghost apply-preset-btn" data-id="${p.id}">使う</button>
              <button class="btn ghost delete-preset-btn" data-id="${p.id}">削除</button>
            </div>
          `).join('')}
        </div>
      `}

      <div class="toolbar">
        <span class="spacer"></span>
        <button class="btn ghost" id="theme-reset-btn">色をリセット</button>
      </div>

      <div class="card-note" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--hairline)">
        画像をアップロードして、背景やカードに使うこともできます。
      </div>
      <div class="toolbar">
        <label class="btn ghost" style="cursor:pointer">
          ＋ 画像をアップロード
          <input type="file" id="theme-bg-image-input" accept="image/*" style="display:none">
        </label>
        ${bgImage ? `<button class="btn ghost" id="theme-remove-image-btn">画像を削除</button>` : ''}
        <span id="theme-image-status" class="card-note" style="margin:0"></span>
      </div>
      ${bgImage ? `
        <div class="field-row">
          <div class="field-label">画像の使い道</div>
          <select id="theme_bg_image_target">
            <option value="background" ${bgImageTarget === 'background' ? 'selected' : ''}>背景に使う</option>
            <option value="cards" ${bgImageTarget === 'cards' ? 'selected' : ''}>カードに使う</option>
            <option value="both" ${bgImageTarget === 'both' ? 'selected' : ''}>両方に使う</option>
          </select>
        </div>
        <img src="${bgImage}" alt="アップロードした背景画像" style="max-width:200px;border-radius:3px;border:1px solid var(--grid-line);margin-top:10px">
      ` : ''}
    </div>
  `;

  container.querySelector('#company_name').addEventListener('change', (e) => setMeta('company_name', e.target.value));
  container.querySelector('#founding_year').addEventListener('change', (e) => setMeta('founding_year', e.target.value));
  container.querySelector('#founding_month').addEventListener('change', (e) => setMeta('founding_month', e.target.value));
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

  const clientIdInput = container.querySelector('#gdrive_client_id');
  if (clientIdInput) {
    clientIdInput.addEventListener('change', (e) => {
      setMeta('gdrive_client_id', e.target.value.trim());
    });
  }

  const editClientIdBtn = container.querySelector('#gdrive-edit-client-id-btn');
  if (editClientIdBtn) {
    editClientIdBtn.addEventListener('click', () => {
      showClientIdOverride = true;
      render(container);
    });
  }

  const statusNote = container.querySelector('#gdrive-status-note');
  container.querySelector('#gdrive-connect-btn').addEventListener('click', async () => {
    const clientId = (clientIdInput ? clientIdInput.value.trim() : getMeta('gdrive_client_id') || '');
    if (!clientId) {
      statusNote.textContent = 'まずOAuthクライアントIDを入力してください。';
      return;
    }
    setMeta('gdrive_client_id', clientId);
    statusNote.textContent = 'Googleの認証画面を確認してください…';
    try {
      await gdrive.connect(clientId);
      showClientIdOverride = false;
      render(container);
    } catch (err) {
      statusNote.textContent = `接続に失敗しました: ${err.message}`;
    }
  });

  container.querySelector('#gdrive-disconnect-btn').addEventListener('click', () => {
    gdrive.disconnect();
    render(container);
  });

  function updateContrastDisplay() {
    const bg = container.querySelector('#theme_bg_color').value;
    const card = container.querySelector('#theme_card_color').value;
    const ink = container.querySelector('#theme_ink_color').value;
    container.querySelector('#contrast-check').innerHTML = `
      <span>文字 × カード: ${contrastBadge(contrastRatio(ink, card))}</span>
      <span>文字 × 背景: ${contrastBadge(contrastRatio(ink, bg))}</span>
    `;
  }

  container.querySelector('#theme_bg_color').addEventListener('input', (e) => {
    setMeta('theme_bg_color', e.target.value);
    applyTheme();
    updateContrastDisplay();
  });
  container.querySelector('#theme_card_color').addEventListener('input', (e) => {
    setMeta('theme_card_color', e.target.value);
    applyTheme();
    updateContrastDisplay();
  });
  container.querySelector('#theme_ink_color').addEventListener('input', (e) => {
    setMeta('theme_ink_color', e.target.value);
    applyTheme();
    updateContrastDisplay();
  });
  container.querySelector('#theme_pattern').addEventListener('change', (e) => {
    setMeta('theme_pattern', e.target.value);
    applyTheme();
  });
  container.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setMeta('theme_bg_color', btn.dataset.bg);
      setMeta('theme_card_color', btn.dataset.card);
      setMeta('theme_ink_color', btn.dataset.ink);
      applyTheme();
      render(container);
    });
  });
  container.querySelector('#theme-random-btn').addEventListener('click', () => {
    setMeta('theme_bg_color', randomHex());
    setMeta('theme_card_color', randomHex());
    setMeta('theme_ink_color', randomHex());
    applyTheme();
    render(container);
  });
  container.querySelector('#theme-random-readable-btn').addEventListener('click', () => {
    // 5つの条件を同時に満たす完全ランダムな組は稀（実測で約1200回に1回程度）なので、
    // 単純に上限回数で打ち切ると「見つからないまま一番最後に試した候補」＝読みにくい
    // 組み合わせがそのまま採用されてしまうバグがあった。ここまでで最良の候補を覚えておき、
    // 上限に達しても必ずそれを使うようにする。
    let best = null;
    let bestScore = -Infinity;
    let found = false;
    for (let tries = 0; tries < 20000 && !found; tries++) {
      const bg = randomHex();
      const card = randomHex();
      const ink = randomHex();
      const { soft, muted } = deriveInkVariants(ink, card);
      const c1 = contrastRatio(ink, card);
      const c2 = contrastRatio(ink, bg);
      const c3 = contrastRatio(soft, card);
      const c4 = contrastRatio(muted, card);
      const c5 = contrastRatio(muted, bg);
      const score = Math.min(c1 - 7, c2 - 7, c3 - 4.5, c4 - 3.5, c5 - 3.5);
      if (score > bestScore) {
        bestScore = score;
        best = { bg, card, ink };
      }
      if (score >= 0) found = true;
    }
    const { bg, card, ink } = best;
    setMeta('theme_bg_color', bg);
    setMeta('theme_card_color', card);
    setMeta('theme_ink_color', ink);
    applyTheme();
    render(container);
  });

  container.querySelector('#theme-save-preset-btn').addEventListener('click', () => {
    showSavePresetForm = !showSavePresetForm;
    render(container);
  });
  const savePresetConfirmBtn = container.querySelector('#save-preset-confirm-btn');
  if (savePresetConfirmBtn) {
    savePresetConfirmBtn.addEventListener('click', () => {
      const name = container.querySelector('#new-preset-name').value.trim();
      addThemePreset({
        name,
        bg_color: getMeta('theme_bg_color') || '#FBF8F1',
        card_color: getMeta('theme_card_color') || '#F7F1E3',
        ink_color: getMeta('theme_ink_color') || '#22344A',
      });
      showSavePresetForm = false;
      render(container);
    });
  }
  container.querySelectorAll('.apply-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = savedPresets.find((p) => p.id === Number(btn.dataset.id));
      if (!preset) return;
      setMeta('theme_bg_color', preset.bg_color);
      setMeta('theme_card_color', preset.card_color);
      setMeta('theme_ink_color', preset.ink_color);
      applyTheme();
      render(container);
    });
  });
  container.querySelectorAll('.delete-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      removeThemePreset(Number(btn.dataset.id));
      render(container);
    });
  });

  container.querySelector('#theme-reset-btn').addEventListener('click', () => {
    setMeta('theme_bg_color', '#FBF8F1');
    setMeta('theme_card_color', '#F7F1E3');
    setMeta('theme_ink_color', '#22344A');
    setMeta('theme_pattern', 'grid');
    applyTheme();
    render(container);
  });

  const imageTargetSelect = container.querySelector('#theme_bg_image_target');
  if (imageTargetSelect) {
    imageTargetSelect.addEventListener('change', (e) => {
      setMeta('theme_bg_image_target', e.target.value);
      applyTheme();
    });
  }

  const removeImageBtn = container.querySelector('#theme-remove-image-btn');
  if (removeImageBtn) {
    removeImageBtn.addEventListener('click', () => {
      setMeta('theme_bg_image', '');
      applyTheme();
      render(container);
    });
  }

  const imageStatus = container.querySelector('#theme-image-status');
  container.querySelector('#theme-bg-image-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    imageStatus.textContent = '画像を処理しています…';
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      setMeta('theme_bg_image', dataUrl);
      applyTheme();
      render(container);
    } catch (err) {
      imageStatus.textContent = err.message;
    }
  });
}
