import {
  openDatabase, getMeta, getFoundingDate, exportBytes, getSectionCompletion, isMonthAllowed,
} from './db.js';
import { todayYearMonth, escapeHtml, monthLabel, addMonths } from './format.js';
import { applyTheme } from './theme.js';
import * as gdrive from './gdrive.js';
import * as dashboard from './views/dashboard.js';
import * as ar from './views/ar.js';
import * as rent from './views/rent.js';
import * as officerpay from './views/officerpay.js';
import * as expenses from './views/expenses.js';
import * as report from './views/report.js';
import * as settings from './views/settings.js';
import { renderMonthBar } from './views/monthbar.js';

const TABS = [
  { key: 'dashboard', label: 'ダッシュボード', mod: dashboard, needsMonth: true },
  { key: 'ar', label: '売掛金', mod: ar, needsMonth: true },
  { key: 'rent', label: '家賃・光熱費', mod: rent, needsMonth: true },
  { key: 'officer', label: '役員報酬', mod: officerpay, needsMonth: true },
  { key: 'expenses', label: '経費', mod: expenses, needsMonth: true },
  { key: 'report', label: '月次レポート', mod: report, needsMonth: true },
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
  ];
  const remaining = steps.filter((step) => !step.done).length;
  document.getElementById('spine-top-slot').innerHTML = `
    <div class="spine-top">
      <div class="wordmark-link">
        <a href="#/dashboard" class="display">Kayley</a>
        ${companyName ? `<small>${escapeHtml(companyName)}</small>` : '<small><a href="#/settings">会社名を設定する</a></small>'}
      </div>
      <span class="spine-divider"></span>
      <a class="utility-link ${state.tab === 'settings' ? 'active' : ''}" href="#/settings">設定</a>
    </div>
  `;
  document.getElementById('workflow-tabs-slot').innerHTML = `
    ${steps.map((step) => `<a href="#/${step.key}" class="workflow-step ${state.tab === step.key ? 'active' : ''}"><span class="completion-seal ${step.done ? 'done' : ''}"></span>${step.label}</a>`).join('')}
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
    if (![completion.ar, completion.rent, completion.officer, completion.expenses, completion.report].every(Boolean)) {
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
  if (!getMeta('gdrive_client_id') && state.tab !== 'settings') {
    notices.push(`
      <div class="notice-row info">
        <span class="notice-dot"></span>
        <span class="notice-text">Google Drive未連携のため、請求書・領収書を保存できません</span>
        <a class="notice-action" href="#/settings">設定を開く</a>
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

  // すでにGoogle Driveに接続済み（同じタブ内で維持されているセッション）で、自動バックアップが
  // オンなら、前回から12時間以上経っていた場合だけ静かにバックアップする。新規にログイン画面は開かない。
  gdrive.maybeAutoBackup(exportBytes);
}

main();
