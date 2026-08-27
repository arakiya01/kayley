import {
  openDatabase, getMeta, getFoundingDate, getSectionCompletion, isMonthAllowed, onDataChange,
} from './db.js';
import { todayYearMonth, escapeHtml, monthLabel, addMonths } from './format.js';
import { applyTheme } from './theme.js';
import * as dashboard from './views/dashboard.js';
import * as ar from './views/ar.js';
import * as rent from './views/rent.js';
import * as officerpay from './views/officerpay.js';
import * as expenses from './views/expenses.js';
import * as report from './views/report.js';
import * as bank from './views/bank.js';
import * as settings from './views/settings.js';
import { renderMonthBar } from './views/monthbar.js';

const TABS = [
  { key: 'dashboard', label: 'ダッシュボード', mod: dashboard, needsMonth: true },
  { key: 'ar', label: '売掛金', mod: ar, needsMonth: true },
  { key: 'rent', label: '家賃・光熱費', mod: rent, needsMonth: true },
  { key: 'officer', label: '役員報酬', mod: officerpay, needsMonth: true },
  { key: 'expenses', label: '経費', mod: expenses, needsMonth: true },
  { key: 'report', label: '月次レポート', mod: report, needsMonth: true },
  { key: 'bank', label: '銀行', mod: bank, needsMonth: true },
  { key: 'settings', label: '設定', mod: settings, needsMonth: false },
];

const STATE_KEY = 'kayley-ui-state';

function loadUiState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  const t = todayYearMonth();
  return { tab: 'dashboard', year: t.year, month: t.month };
}

function saveUiState(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

let state = loadUiState();
let updateInfo = null;
let updateStatus = null; // null | 'downloading' | エラーメッセージ文字列

function currentTabFromHash() {
  const hash = location.hash.replace('#/', '');
  return TABS.find((t) => t.key === hash) ? hash : state.tab;
}

function renderShell() {
  const root = document.getElementById('app-shell');
  root.innerHTML = `
    <header class="progress-spine" id="progress-spine">
      <div id="spine-top-slot"></div>
      <div id="month-bar-slot"></div>
      <nav class="workflow-tabs" id="workflow-tabs-slot"></nav>
      <div id="notice-slot"></div>
    </header>
    <div id="view-root"></div>
  `;
}

function renderProgressSpine() {
  const companyName = getMeta('company_name') || '';
  const completion = getSectionCompletion(state.year, state.month);
  const steps = [
    { key: 'ar', label: '売掛金', done: completion.ar },
    { key: 'rent', label: '家賃・光熱費', done: completion.rent },
    { key: 'officer', label: '役員報酬', done: completion.officer },
    { key: 'expenses', label: '経費', done: completion.expenses },
    { key: 'report', label: '月次レポート', done: completion.report },
    { key: 'bank', label: '銀行', done: completion.bank },
  ];
  const remaining = steps.filter((step) => !step.done).length;
  const appVersion = window.kayleyBridge?.appVersion;
  document.getElementById('spine-top-slot').innerHTML = `
    <div class="spine-top">
      <div class="wordmark-link">
        <a href="#/dashboard" class="brand-mark">
          <img class="brand-logo" src="assets/kayley-logo.png" alt="Kayley">
        </a>
        ${appVersion ? `<span class="version-badge">v${escapeHtml(appVersion)}</span>` : ''}
        ${companyName ? `<small>${escapeHtml(companyName)}</small>` : '<small><a href="#/settings">会社名を設定する</a></small>'}
      </div>
      <span class="spine-divider"></span>
      <a class="utility-link ${state.tab === 'settings' ? 'active' : ''}" href="#/settings">設定</a>
    </div>
  `;
  const stepHints = {
    ar: '完了印は、この月の売上・入金が1件でも入力されると付きます',
    rent: '完了印は、この月の家賃・水道光熱費が入力されると付きます',
    officer: '完了印は、在籍中の役員全員分の給与明細がこの月に入力されると付きます',
    expenses: '完了印は、この月の経費データが1件以上あり、すべての明細に勘定科目が選ばれると付きます',
    report: '完了印は、この月のレポートを一度でも出力すると付きます',
    bank: '完了印は、この月の明細が1件以上あり、すべて分類済みになると付きます',
  };
  document.getElementById('workflow-tabs-slot').innerHTML = `
    ${steps.map((step) => `<a href="#/${step.key}" class="workflow-step ${state.tab === step.key ? 'active' : ''}" title="${stepHints[step.key]}"><span class="completion-seal ${step.done ? 'done' : ''}"></span>${step.label}</a>`).join('')}
    ${remaining > 0 ? `<span class="workflow-hint">あと${remaining}つで締められます</span>` : ''}
  `;
  renderNotices();
}

function renderNotices() {
  const notices = [];
  const today = todayYearMonth();
  let unclosedMonth = null;
  for (let offset = -1; offset >= -24; offset--) {
    const candidate = addMonths(today.year, today.month, offset);
    if (!isMonthAllowed(candidate.year, candidate.month)) continue;
    const completion = getSectionCompletion(candidate.year, candidate.month);
    if (![completion.ar, completion.rent, completion.officer, completion.expenses, completion.report, completion.bank].every(Boolean)) {
      unclosedMonth = candidate;
      break;
    }
  }
  if (unclosedMonth && (unclosedMonth.year !== state.year || unclosedMonth.month !== state.month)) {
    notices.push(`
      <div class="notice-row warning">
        <span class="notice-dot"></span>
        <span class="notice-text">${monthLabel(unclosedMonth.year, unclosedMonth.month)}がまだ締まっていません</span>
        <button class="notice-action" id="notice-open-month">その月を開く</button>
      </div>
    `);
  }
  if (updateInfo && updateInfo.available) {
    const label = updateStatus === 'downloading'
      ? 'ダウンロード中…（完了するとKayleyが自動的に再起動します）'
      : updateStatus
        ? updateStatus
        : `新しいバージョン（v${updateInfo.latestVersion}）があります`;
    notices.push(`
      <div class="notice-row info">
        <span class="notice-dot"></span>
        <span class="notice-text">${escapeHtml(label)}</span>
        ${updateStatus === 'downloading' ? '' : '<button class="notice-action" id="notice-apply-update">更新する</button>'}
      </div>
    `);
  }
  const slot = document.getElementById('notice-slot');
  slot.innerHTML = notices.join('');
  const openMonthButton = slot.querySelector('#notice-open-month');
  if (openMonthButton) {
    openMonthButton.addEventListener('click', () => {
      state.year = unclosedMonth.year;
      state.month = unclosedMonth.month;
      saveUiState(state);
      renderView();
    });
  }
  const applyUpdateButton = slot.querySelector('#notice-apply-update');
  if (applyUpdateButton) {
    applyUpdateButton.addEventListener('click', async () => {
      if (!confirm('新しいバージョンをダウンロードして更新します。Kayleyが一度終了し、自動的に再起動します。よろしいですか？')) return;
      updateStatus = 'downloading';
      renderNotices();
      try {
        await window.kayleyBridge.applyUpdate(updateInfo.assetUrl);
      } catch (err) {
        updateStatus = `更新に失敗しました: ${err.message}`;
        renderNotices();
      }
    });
  }
}

function clampToFoundingDate() {
  const founding = getFoundingDate();
  if (!founding) return;
  if (state.year * 12 + state.month < founding.year * 12 + founding.month) {
    state.year = founding.year;
    state.month = founding.month;
  }
}

function renderView() {
  state.tab = currentTabFromHash();
  clampToFoundingDate();
  saveUiState(state);

  renderProgressSpine();

  const tab = TABS.find((t) => t.key === state.tab);
  const viewRoot = document.getElementById('view-root');

  const ctx = {
    year: state.year,
    month: state.month,
    setMonth(y, m) {
      state.year = y;
      state.month = m;
      saveUiState(state);
      renderView();
    },
  };
  const monthBarSlot = document.getElementById('month-bar-slot');
  if (tab.needsMonth) {
    renderMonthBar(monthBarSlot, { year: state.year, month: state.month, onChange: ctx.setMonth });
  } else {
    monthBarSlot.innerHTML = '';
  }
  tab.mod.render(viewRoot, ctx);
}

window.addEventListener('hashchange', renderView);

async function main() {
  await openDatabase();
  applyTheme();
  if (!location.hash) location.hash = `#/${state.tab}`;
  renderShell();
  renderView();

  // どの画面で入力しても、完了印・締めの残り件数・通知がその場で追いつくようにする。
  // ヘッダだけを描き直すので、入力中のフォームからフォーカスが外れることはない。
  onDataChange(() => {
    if (document.getElementById('spine-top-slot')) renderProgressSpine();
  });

  if (window.kayleyBridge?.checkForUpdate) {
    window.kayleyBridge.checkForUpdate().then((result) => {
      if (result && result.available) {
        updateInfo = result;
        if (document.getElementById('spine-top-slot')) renderProgressSpine();
      }
    }).catch(() => { /* オフライン等は無視。次回起動時に再チェックされる */ });
  }
}

main();
