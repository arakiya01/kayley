import {
  openDatabase, getMeta, getFoundingDate, exportBytes, listArEntriesForMonth,
  getRentUtilityEntry, getOfficerPayEntry, listExpenseSourceSummaries, listAttachments,
} from './db.js';
import { todayYearMonth, escapeHtml } from './format.js';
import { applyTheme } from './theme.js';
import * as gdrive from './gdrive.js';
import * as dashboard from './views/dashboard.js';
import * as ar from './views/ar.js';
import * as rent from './views/rent.js';
import * as officerpay from './views/officerpay.js';
import * as expenses from './views/expenses.js';
import * as report from './views/report.js';
import * as settings from './views/settings.js';

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
    <header class="progress-spine" id="progress-spine"></header>
    <div id="view-root"></div>
  `;
}

function renderProgressSpine() {
  const companyName = getMeta('company_name') || '';
  const attachments = listAttachments(state.year, state.month);
  const expenseRows = listExpenseSourceSummaries([{ year: state.year, month: state.month }]);
  const steps = [
    { key: 'ar', label: '売掛金', done: listArEntriesForMonth(state.year, state.month).length > 0 },
    { key: 'rent', label: '家賃・光熱費', done: !!getRentUtilityEntry(state.year, state.month) },
    { key: 'officer', label: '役員報酬', done: !!getOfficerPayEntry(state.year, state.month) },
    { key: 'expenses', label: '経費', done: expenseRows.length > 0 || attachments.some((a) => a.category !== 'invoice' && a.category !== 'statement') },
  ];
  const remaining = steps.filter((step) => !step.done).length;
  document.getElementById('progress-spine').innerHTML = `
    <div class="spine-top">
      <a class="wordmark-link" href="#/dashboard"><span class="display">Kayley</span><small>SOLO BOOKKEEPING</small></a>
      <span class="spine-company">${companyName ? escapeHtml(companyName) : '<a href="#/settings">会社名を設定する</a>'}</span>
      <span class="spine-divider"></span>
      <a class="utility-link ${state.tab === 'dashboard' ? 'active' : ''}" href="#/dashboard">概況</a>
      <a class="utility-link ${state.tab === 'settings' ? 'active' : ''}" href="#/settings">設定</a>
    </div>
    <nav class="workflow-tabs">
      ${steps.map((step) => `<a href="#/${step.key}" class="workflow-step ${state.tab === step.key ? 'active' : ''}"><span class="completion-seal ${step.done ? 'done' : ''}"></span>${step.label}</a>`).join('')}
      ${remaining > 0 ? `<span class="workflow-hint">あと${remaining}つで締められます</span>` : ''}
      <span class="workflow-spacer"></span>
      <a class="report-link ${state.tab === 'report' ? 'active' : ''}" href="#/report">レポートを渡す</a>
    </nav>
  `;
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
  // オンなら、前回から24時間以上経っていた場合だけ静かにバックアップする。新規にログイン画面は開かない。
  gdrive.maybeAutoBackup(exportBytes);
}

main();
