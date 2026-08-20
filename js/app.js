import { openDatabase, getMeta, getFoundingDate } from './db.js';
import { todayYearMonth } from './format.js';
import { applyTheme } from './theme.js';
import * as dashboard from './views/dashboard.js';
import * as ar from './views/ar.js';
import * as rent from './views/rent.js';
import * as officerpay from './views/officerpay.js';
import * as report from './views/report.js';
import * as settings from './views/settings.js';

const TABS = [
  { key: 'dashboard', label: 'ダッシュボード', mod: dashboard, needsMonth: true },
  { key: 'ar', label: '売掛金', mod: ar, needsMonth: true },
  { key: 'rent', label: '家賃・光熱費', mod: rent, needsMonth: true },
  { key: 'officer', label: '役員報酬', mod: officerpay, needsMonth: true },
  { key: 'report', label: '月次レポート', mod: report, needsMonth: true },
  { key: 'settings', label: '設定', mod: settings, needsMonth: false },
];

const STATE_KEY = 'geppyo-ui-state';

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
  const companyName = getMeta('company_name') || '';
  root.innerHTML = `
    <div class="masthead">
      <div class="wordmark">
        <h1 class="display">月次伝票</h1>
        <div class="sub">GEPPYO — MONTHLY LEDGER</div>
      </div>
      <div class="company">${companyName ? companyName : '<a href="#/settings">会社名を設定する</a>'}</div>
    </div>
    <nav class="tabs">
      ${TABS.map((t) => `<a href="#/${t.key}" data-key="${t.key}">${t.label}</a>`).join('')}
    </nav>
    <div id="view-root"></div>
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

  document.querySelectorAll('nav.tabs a').forEach((a) => {
    a.classList.toggle('active', a.dataset.key === state.tab);
  });

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
}

main();
