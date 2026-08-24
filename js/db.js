import { Storage } from './storage.js';
import { todayYearMonth } from './format.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  fx_note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  opening_balance INTEGER NOT NULL DEFAULT 0,
  opening_year INTEGER,
  opening_month INTEGER,
  trade_start_year INTEGER,
  trade_start_month INTEGER,
  trade_end_year INTEGER,
  trade_end_month INTEGER
);

CREATE TABLE IF NOT EXISTS ar_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  sales INTEGER NOT NULL DEFAULT 0,
  payment INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE(client_id, year, month)
);

CREATE TABLE IF NOT EXISTS rent_utility_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  rent_total INTEGER NOT NULL DEFAULT 0,
  rent_personal_fixed INTEGER NOT NULL DEFAULT 0,
  water_total INTEGER NOT NULL DEFAULT 0,
  water_personal_pct REAL NOT NULL DEFAULT 40,
  gas_total INTEGER NOT NULL DEFAULT 0,
  gas_personal_pct REAL NOT NULL DEFAULT 40,
  electricity_total INTEGER NOT NULL DEFAULT 0,
  electricity_personal_pct REAL NOT NULL DEFAULT 40,
  note TEXT,
  UNIQUE(year, month)
);

CREATE TABLE IF NOT EXISTS officer_pay_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  gross_pay INTEGER NOT NULL DEFAULT 0,
  health_insurance INTEGER NOT NULL DEFAULT 0,
  nursing_care_insurance INTEGER NOT NULL DEFAULT 0,
  pension INTEGER NOT NULL DEFAULT 0,
  child_support_levy INTEGER NOT NULL DEFAULT 0,
  withholding_tax INTEGER NOT NULL DEFAULT 0,
  use_auto_deduction INTEGER NOT NULL DEFAULT 1,
  manual_rent_deduction INTEGER NOT NULL DEFAULT 0,
  manual_utility_deduction INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE(year, month)
);

CREATE TABLE IF NOT EXISTS month_status (
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0,
  finalized_at TEXT,
  report_exported_at TEXT,
  PRIMARY KEY(year, month)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  web_view_link TEXT,
  uploaded_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'receipt',
  client_id INTEGER REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS payment_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'card',
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS statement_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES payment_sources(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  txn_date TEXT,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  account_title TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS account_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_key TEXT NOT NULL UNIQUE,
  account_title TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS theme_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  bg_color TEXT NOT NULL,
  card_color TEXT NOT NULL,
  ink_color TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const DEFAULT_META = {
  company_name: '',
  fiscal_year_start_month: '4',
  default_utility_personal_pct: '40',
  founding_year: '',
  founding_month: '',
  gdrive_client_id: '',
  gdrive_folder_id: '',
  gdrive_auto_backup: '0',
  gdrive_last_backup_at: '',
  theme_bg_color: '#FBF8F1',
  theme_card_color: '#F7F1E3',
  theme_ink_color: '#22344A',
  theme_pattern: 'grid',
  theme_bg_image: '',
  theme_bg_image_target: 'background',
};

// 小規模法人でよく使う科目。ここに無いものは税理士側で振り替えてもらう前提で「雑費」に寄せる。
export const ACCOUNT_TITLES = [
  '通信費', '旅費交通費', '消耗品費', '新聞図書費', '会議費', '接待交際費',
  '広告宣伝費', '支払手数料', '外注費', '水道光熱費', '荷造運賃', '修繕費',
  '租税公課', '保険料', '諸会費', '雑費',
];

// 摘要から対応ルールのキーを作る。全角/半角ゆれと空白ゆれだけ吸収し、
// 数字や日付は落とさない（落とすと別の店を同一視して誤爆する危険があるため）。
export function accountMatchKey(description) {
  return String(description || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

let SQL = null;
let db = null;

async function initSqlJs() {
  if (SQL) return SQL;
  // sql.js の UMD ローダーは vendor/sql-wasm.js が読み込まれ、
  // グローバル関数 initSqlJs() を公開する。
  SQL = await window.initSqlJs({
    locateFile: (file) => `vendor/${file}`,
  });
  return SQL;
}

// CREATE TABLE IF NOT EXISTS は既存テーブルへの列追加はしないため、
// 既存ユーザーのDBにも後から追加した列を反映するための簡易マイグレーション。
function migrateColumns() {
  const ensureColumn = (table, column, definition) => {
    const cols = db.exec(`PRAGMA table_info(${table})`);
    const existingNames = cols.length ? cols[0].values.map((row) => row[1]) : [];
    if (!existingNames.includes(column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  ensureColumn('attachments', 'category', "TEXT NOT NULL DEFAULT 'receipt'");
  ensureColumn('attachments', 'client_id', 'INTEGER REFERENCES clients(id)');
  ensureColumn('attachments', 'source_id', 'INTEGER REFERENCES payment_sources(id)');
  ensureColumn('attachments', 'statement_transaction_id', 'INTEGER REFERENCES statement_transactions(id)');
  ensureColumn('clients', 'trade_start_year', 'INTEGER');
  ensureColumn('clients', 'trade_start_month', 'INTEGER');
  ensureColumn('clients', 'trade_end_year', 'INTEGER');
  ensureColumn('clients', 'trade_end_month', 'INTEGER');
  ensureColumn('month_status', 'report_exported_at', 'TEXT');
  ensureColumn('statement_transactions', 'account_title', 'TEXT');
}

export async function openDatabase() {
  await initSqlJs();
  const existing = await Storage.load();
  if (existing) {
    db = new SQL.Database(existing);
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  migrateColumns();
  for (const [k, v] of Object.entries(DEFAULT_META)) {
    db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', [k, v]);
  }
  await persist();
  return db;
}

let saveTimer = null;
export async function persist() {
  const bytes = db.export();
  await Storage.save(bytes);
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persist(); }, 250);
}

// データが変わったことを画面側へ知らせる仕組み。
// 完了印・締め残りの件数・通知はどの画面からの入力でも変わりうるが、
// これまでは画面遷移するまで更新されなかったため、書き込みのたびに通知する。
// 1回の操作で run() が何度も走ることがあるので、まとめて1回だけ呼ぶ。
let changeListener = null;
let notifyTimer = null;
export function onDataChange(fn) {
  changeListener = fn;
}
function scheduleNotify() {
  if (!changeListener) return;
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => { changeListener(); }, 120);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function one(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  schedulePersist();
  scheduleNotify();
}

export const Q = { all, one, run };

/* ---------------- meta ---------------- */

export function getMeta(key) {
  const row = one('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

// 創業年月（設定されていれば、それより前の年月は選べないようにする）
export function getFoundingDate() {
  const y = Number(getMeta('founding_year'));
  const m = Number(getMeta('founding_month'));
  if (!y || !m) return null;
  return { year: y, month: m };
}

export function isMonthAllowed(year, month) {
  const founding = getFoundingDate();
  if (!founding) return true;
  return year * 12 + month >= founding.year * 12 + founding.month;
}

/* ---------------- clients ---------------- */

// 取引終了年月を設定した得意先は、その月を過ぎたら自動で休止扱いにする（手動の休止・再開ボタンの代わり）。
// 終了年月を先の日付に直せば自動で再開扱いに戻る。終了年月を設定していない得意先は今まで通り手動管理。
function syncArchivedFromTradeEnd() {
  const today = todayYearMonth();
  const todayIdx = today.year * 12 + today.month;
  const rows = all(
    'SELECT id, archived, trade_end_year, trade_end_month FROM clients WHERE trade_end_year IS NOT NULL AND trade_end_month IS NOT NULL'
  );
  rows.forEach((r) => {
    const endIdx = r.trade_end_year * 12 + r.trade_end_month;
    const shouldBeArchived = todayIdx > endIdx ? 1 : 0;
    if (r.archived !== shouldBeArchived) {
      run('UPDATE clients SET archived=? WHERE id=?', [shouldBeArchived, r.id]);
    }
  });
}

export function listClients({ includeArchived = false } = {}) {
  syncArchivedFromTradeEnd();
  const sql = includeArchived
    ? 'SELECT * FROM clients ORDER BY sort_order, id'
    : 'SELECT * FROM clients WHERE archived = 0 ORDER BY sort_order, id';
  return all(sql);
}

function mergeClientLists(active, extra) {
  const seen = new Set(active.map((c) => c.id));
  const merged = [...active];
  extra.forEach((c) => {
    if (!seen.has(c.id)) { merged.push(c); seen.add(c.id); }
  });
  return merged.sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
}

function archivedClientsWithActivity(monthPairs) {
  if (monthPairs.length === 0) return [];
  const placeholders = monthPairs.map(() => '(a.year=? AND a.month=?)').join(' OR ');
  const params = monthPairs.flatMap((m) => [m.year, m.month]);
  return all(
    `SELECT DISTINCT c.* FROM clients c
     JOIN ar_entries a ON a.client_id = c.id
     WHERE c.archived = 1 AND (a.sales != 0 OR a.payment != 0) AND (${placeholders})`,
    params
  );
}

// 休止済みの得意先でも、その月に売上・入金の実績があれば表示に含める
// （最新の入力画面には出てこないが、過去の実績があった月では見えるようにするため）。
export function listClientsForMonth(year, month) {
  return mergeClientLists(listClients(), archivedClientsWithActivity([{ year, month }]));
}

export function listClientsForMonths(months) {
  return mergeClientLists(listClients(), archivedClientsWithActivity(months));
}

export function getClient(id) {
  return one('SELECT * FROM clients WHERE id=?', [id]);
}

// 取引開始年月より前・取引終了年月より後の月かどうか（グラフでその月を0円ではなく
// 「データなし」として扱うために使う）。開始・終了が未設定ならどの月も許可する。
export function clientTradeAllowsMonth(client, year, month) {
  const idx = year * 12 + month;
  if (client.trade_start_year && client.trade_start_month) {
    if (idx < client.trade_start_year * 12 + client.trade_start_month) return false;
  }
  if (client.trade_end_year && client.trade_end_month) {
    if (idx > client.trade_end_year * 12 + client.trade_end_month) return false;
  }
  return true;
}

export function upsertClient(client) {
  if (client.id) {
    run(
      `UPDATE clients SET name=?, currency=?, fx_note=?, sort_order=?, opening_balance=?, opening_year=?, opening_month=?,
         trade_start_year=?, trade_start_month=?, trade_end_year=?, trade_end_month=?
       WHERE id=?`,
      [client.name, client.currency || 'JPY', client.fx_note || null, client.sort_order || 0,
       client.opening_balance || 0, client.opening_year || null, client.opening_month || null,
       client.trade_start_year || null, client.trade_start_month || null,
       client.trade_end_year || null, client.trade_end_month || null, client.id]
    );
    syncArchivedFromTradeEnd();
    return client.id;
  }
  const maxOrder = one('SELECT COALESCE(MAX(sort_order), -1) AS m FROM clients').m;
  run(
    `INSERT INTO clients (name, currency, fx_note, sort_order, opening_balance, opening_year, opening_month,
       trade_start_year, trade_start_month, trade_end_year, trade_end_month)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [client.name, client.currency || 'JPY', client.fx_note || null, maxOrder + 1,
     client.opening_balance || 0, client.opening_year || null, client.opening_month || null,
     client.trade_start_year || null, client.trade_start_month || null,
     client.trade_end_year || null, client.trade_end_month || null]
  );
  const newId = one('SELECT last_insert_rowid() AS id').id;
  syncArchivedFromTradeEnd();
  return newId;
}

export function archiveClient(id, archived = 1) {
  run('UPDATE clients SET archived=? WHERE id=?', [archived, id]);
}

/* ---------------- payment sources (カード・現金) ---------------- */

export function listPaymentSources({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM payment_sources ORDER BY sort_order, id'
    : 'SELECT * FROM payment_sources WHERE archived = 0 ORDER BY sort_order, id';
  return all(sql);
}

export function upsertPaymentSource(source) {
  if (source.id) {
    run('UPDATE payment_sources SET name=?, kind=? WHERE id=?', [source.name, source.kind || 'card', source.id]);
    return source.id;
  }
  const maxOrder = one('SELECT COALESCE(MAX(sort_order), -1) AS m FROM payment_sources').m;
  run('INSERT INTO payment_sources (name, kind, sort_order) VALUES (?, ?, ?)', [source.name, source.kind || 'card', maxOrder + 1]);
  return one('SELECT last_insert_rowid() AS id').id;
}

export function archivePaymentSource(id, archived = 1) {
  run('UPDATE payment_sources SET archived=? WHERE id=?', [archived, id]);
}

/* ---------------- statement transactions (カード明細の1行ずつの取引) ---------------- */

export function listStatementTransactions(sourceId, year, month) {
  return all(
    'SELECT * FROM statement_transactions WHERE source_id=? AND year=? AND month=? ORDER BY txn_date, id',
    [sourceId, year, month]
  );
}

export function listExpenseSourceSummaries(months) {
  if (months.length === 0) return [];
  const conditions = months.map(() => '(t.year=? AND t.month=?)').join(' OR ');
  const params = months.flatMap((m) => [m.year, m.month]);
  return all(
    `SELECT p.id, p.name, p.kind, t.year, t.month,
            COUNT(t.id) AS transaction_count, COALESCE(SUM(t.amount), 0) AS total
     FROM payment_sources p
     JOIN statement_transactions t ON t.source_id = p.id
     WHERE ${conditions}
     GROUP BY p.id, p.name, p.kind, t.year, t.month
     ORDER BY p.sort_order, p.id, t.year, t.month`,
    params
  );
}

export function setTransactionAccountTitle(id, accountTitle) {
  run('UPDATE statement_transactions SET account_title=? WHERE id=?', [accountTitle || null, id]);
}

export function learnAccountRule(description, accountTitle) {
  if (!accountTitle) return;
  const matchKey = accountMatchKey(description);
  if (!matchKey) return;
  run(
    `INSERT INTO account_rules (match_key, account_title, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(match_key) DO UPDATE SET account_title=excluded.account_title, updated_at=excluded.updated_at`,
    [matchKey, accountTitle, new Date().toISOString()]
  );
}

export function getAccountRule(description) {
  const matchKey = accountMatchKey(description);
  if (!matchKey) return null;
  const rule = one('SELECT account_title FROM account_rules WHERE match_key=?', [matchKey]);
  return rule ? rule.account_title : null;
}

export function listAccountRules() {
  return all('SELECT id, match_key, account_title, updated_at FROM account_rules ORDER BY updated_at DESC, id DESC');
}

export function removeAccountRule(id) {
  run('DELETE FROM account_rules WHERE id=?', [id]);
}

export function applyAccountRulesToMonth(year, month) {
  const rules = new Map(listAccountRules().map((r) => [r.match_key, r.account_title]));
  const txns = all(
    `SELECT id, description FROM statement_transactions
     WHERE year=? AND month=? AND (account_title IS NULL OR account_title='')`,
    [year, month]
  );
  let appliedCount = 0;
  txns.forEach((txn) => {
    const accountTitle = rules.get(accountMatchKey(txn.description));
    if (!accountTitle) return;
    setTransactionAccountTitle(txn.id, accountTitle);
    appliedCount += 1;
  });
  return appliedCount;
}

export function listAllStatementTransactions(year, month) {
  return all(
    `SELECT t.*, p.name AS source_name, p.kind AS source_kind
     FROM statement_transactions t
     JOIN payment_sources p ON p.id=t.source_id
     WHERE t.year=? AND t.month=?
     ORDER BY p.sort_order, p.id, t.txn_date, t.id`,
    [year, month]
  );
}

export function listExpenseAccountSummaries(months) {
  if (months.length === 0) return [];
  const conditions = months.map(() => '(year=? AND month=?)').join(' OR ');
  const params = months.flatMap((m) => [m.year, m.month]);
  return all(
    `SELECT COALESCE(NULLIF(account_title, ''), '未分類') AS account_title, year, month,
            COUNT(id) AS transaction_count, COALESCE(SUM(amount), 0) AS total
     FROM statement_transactions
     WHERE ${conditions}
     GROUP BY COALESCE(NULLIF(account_title, ''), '未分類'), year, month
     ORDER BY year, month, account_title`,
    params
  );
}

export function addStatementTransaction(transaction) {
  const { source_id, year, month, txn_date, description, amount, note } = transaction;
  const accountTitle = Object.prototype.hasOwnProperty.call(transaction, 'account_title')
    ? transaction.account_title
    : getAccountRule(description);
  run(
    `INSERT INTO statement_transactions (source_id, year, month, txn_date, description, amount, account_title, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [source_id, year, month, txn_date || null, description, amount || 0, accountTitle || null, note || null]
  );
  return one('SELECT last_insert_rowid() AS id').id;
}

export function removeStatementTransaction(id) {
  run('DELETE FROM statement_transactions WHERE id=?', [id]);
}

// 同じ明細を再アップロードした時に、前回分の取引を消してから入れ直すための一括削除。
// 紐づいていた領収書は削除せず、紐づけだけ外す（受け皿が消えても添付ファイル自体は残す）。
export function clearStatementTransactions(sourceId, year, month) {
  const rows = all('SELECT id FROM statement_transactions WHERE source_id=? AND year=? AND month=?', [sourceId, year, month]);
  rows.forEach((r) => run('UPDATE attachments SET statement_transaction_id=NULL WHERE statement_transaction_id=?', [r.id]));
  run('DELETE FROM statement_transactions WHERE source_id=? AND year=? AND month=?', [sourceId, year, month]);
}

/* ---------------- AR entries ---------------- */

export function getArEntry(clientId, year, month) {
  return one('SELECT * FROM ar_entries WHERE client_id=? AND year=? AND month=?', [clientId, year, month]);
}

export function upsertArEntry({ client_id, year, month, sales, payment, note }) {
  run(
    `INSERT INTO ar_entries (client_id, year, month, sales, payment, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id, year, month) DO UPDATE SET
       sales=excluded.sales, payment=excluded.payment, note=excluded.note`,
    [client_id, year, month, sales || 0, payment || 0, note || null]
  );
}

// client の全取引を時系列で取得（残高計算用）
export function listArHistoryForClient(clientId) {
  return all('SELECT * FROM ar_entries WHERE client_id=? ORDER BY year, month', [clientId]);
}

export function listArEntriesForMonth(year, month) {
  return all('SELECT * FROM ar_entries WHERE year=? AND month=?', [year, month]);
}

// client の残高推移を通し計算する（開始残高 + 各月の 売上-振込 の累計）。
// 戻り値: [{year, month, sales, payment, opening, closing}] を古い順に。
export function computeArLedger(client) {
  const history = listArHistoryForClient(client.id);
  let running = client.opening_balance || 0;
  return history.map((h) => {
    const opening = running;
    const closing = opening + h.sales - h.payment;
    running = closing;
    return { year: h.year, month: h.month, sales: h.sales, payment: h.payment, opening, closing };
  });
}

// 「開始残高が0より大きいのに入金が無い」月が、指定した年月から遡って何ヶ月連続しているか（滞留検知用）
export function unpaidStreak(ledger, year, month) {
  const idx = ledger.findIndex((r) => r.year === year && r.month === month);
  if (idx === -1) return 0;
  let streak = 0;
  for (let i = idx; i >= 0; i--) {
    const row = ledger[i];
    if (row.opening > 0 && row.payment === 0) streak++;
    else break;
  }
  return streak;
}

// 指定の年月時点での残高（その月を含む）。データが無い月は直前の残高を引き継ぐ。
export function balanceAt(client, year, month) {
  const ledger = computeArLedger(client);
  const target = year * 12 + month;
  let bal = client.opening_balance || 0;
  for (const row of ledger) {
    if (row.year * 12 + row.month > target) break;
    bal = row.closing;
  }
  return bal;
}

/* ---------------- rent / utility ---------------- */

export function getRentUtilityEntry(year, month) {
  return one('SELECT * FROM rent_utility_entries WHERE year=? AND month=?', [year, month]);
}

// 指定月より前で、直近のデータがある月のエントリを探す（最大24ヶ月遡る）。
// 見つからなければ null。戻り値は { entry, year, month }。
export function findPreviousRentUtilityEntry(year, month) {
  let target = { year, month };
  for (let i = 0; i < 24; i++) {
    target = prevMonth(target.year, target.month);
    const entry = getRentUtilityEntry(target.year, target.month);
    if (entry) return { entry, year: target.year, month: target.month };
  }
  return null;
}

export function upsertRentUtilityEntry(e) {
  run(
    `INSERT INTO rent_utility_entries
       (year, month, rent_total, rent_personal_fixed, water_total, water_personal_pct,
        gas_total, gas_personal_pct, electricity_total, electricity_personal_pct, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET
       rent_total=excluded.rent_total,
       rent_personal_fixed=excluded.rent_personal_fixed,
       water_total=excluded.water_total,
       water_personal_pct=excluded.water_personal_pct,
       gas_total=excluded.gas_total,
       gas_personal_pct=excluded.gas_personal_pct,
       electricity_total=excluded.electricity_total,
       electricity_personal_pct=excluded.electricity_personal_pct,
       note=excluded.note`,
    [e.year, e.month, e.rent_total || 0, e.rent_personal_fixed || 0,
     e.water_total || 0, e.water_personal_pct ?? 40,
     e.gas_total || 0, e.gas_personal_pct ?? 40,
     e.electricity_total || 0, e.electricity_personal_pct ?? 40,
     e.note || null]
  );
}

export function computeUtilityPersonalTotal(e) {
  if (!e) return 0;
  const water = Math.round(e.water_total * e.water_personal_pct / 100);
  const gas = Math.round(e.gas_total * e.gas_personal_pct / 100);
  const elec = Math.round(e.electricity_total * e.electricity_personal_pct / 100);
  return water + gas + elec;
}

/* ---------------- officer pay ---------------- */

export function getOfficerPayEntry(year, month) {
  return one('SELECT * FROM officer_pay_entries WHERE year=? AND month=?', [year, month]);
}

// 指定月より前で、直近のデータがある月のエントリを探す（最大24ヶ月遡る）。
// 見つからなければ null。戻り値は { entry, year, month }。
export function findPreviousOfficerPayEntry(year, month) {
  let target = { year, month };
  for (let i = 0; i < 24; i++) {
    target = prevMonth(target.year, target.month);
    const entry = getOfficerPayEntry(target.year, target.month);
    if (entry) return { entry, year: target.year, month: target.month };
  }
  return null;
}

export function upsertOfficerPayEntry(e) {
  run(
    `INSERT INTO officer_pay_entries
       (year, month, gross_pay, health_insurance, nursing_care_insurance, pension,
        child_support_levy, withholding_tax, use_auto_deduction, manual_rent_deduction,
        manual_utility_deduction, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET
       gross_pay=excluded.gross_pay,
       health_insurance=excluded.health_insurance,
       nursing_care_insurance=excluded.nursing_care_insurance,
       pension=excluded.pension,
       child_support_levy=excluded.child_support_levy,
       withholding_tax=excluded.withholding_tax,
       use_auto_deduction=excluded.use_auto_deduction,
       manual_rent_deduction=excluded.manual_rent_deduction,
       manual_utility_deduction=excluded.manual_utility_deduction,
       note=excluded.note`,
    [e.year, e.month, e.gross_pay || 0, e.health_insurance || 0, e.nursing_care_insurance || 0,
     e.pension || 0, e.child_support_levy || 0, e.withholding_tax || 0,
     e.use_auto_deduction ? 1 : 0, e.manual_rent_deduction || 0, e.manual_utility_deduction || 0,
     e.note || null]
  );
}

// 家賃・光熱費の個人負担は「前月分」が当月の役員報酬から控除される（実績確定が翌月になるため）
export function prevMonth(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function resolveOfficerDeductions(year, month) {
  const entry = getOfficerPayEntry(year, month);
  const prev = prevMonth(year, month);
  const prevRent = getRentUtilityEntry(prev.year, prev.month);
  const autoRent = prevRent ? prevRent.rent_personal_fixed : 0;
  const autoUtility = prevRent ? computeUtilityPersonalTotal(prevRent) : 0;
  const useAuto = entry ? !!entry.use_auto_deduction : true;
  return {
    rent_deduction: useAuto ? autoRent : (entry ? entry.manual_rent_deduction : 0),
    utility_deduction: useAuto ? autoUtility : (entry ? entry.manual_utility_deduction : 0),
    auto_rent: autoRent,
    auto_utility: autoUtility,
    source_year: prev.year,
    source_month: prev.month,
    has_source: !!prevRent,
  };
}

/* ---------------- month status / section completion ---------------- */

export function getMonthStatus(year, month) {
  return one('SELECT * FROM month_status WHERE year=? AND month=?', [year, month]);
}

export function getSectionCompletion(year, month) {
  const arDone = listArEntriesForMonth(year, month).length > 0;
  const rentDone = !!getRentUtilityEntry(year, month);
  const officerDone = !!getOfficerPayEntry(year, month);
  const attachments = listAttachments(year, month);
  const expenseRows = listExpenseSourceSummaries([{ year, month }]);
  const monthTxns = listAllStatementTransactions(year, month);
  const hasUncategorized = monthTxns.some((t) => !t.account_title);
  const hasExpenseData = expenseRows.length > 0 || attachments.some((a) => a.category !== 'invoice' && a.category !== 'statement');
  // 完了印は入力済みではなく、科目まで決まり税理士に渡せる状態になったことを表す。
  const expensesDone = hasExpenseData && !hasUncategorized;
  const status = getMonthStatus(year, month);
  const reportDone = !!(status && status.report_exported_at);
  return { ar: arDone, rent: rentDone, officer: officerDone, expenses: expensesDone, report: reportDone };
}

export function markReportExported(year, month) {
  run(
    `INSERT INTO month_status (year, month, report_exported_at) VALUES (?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET report_exported_at=excluded.report_exported_at`,
    [year, month, new Date().toISOString()]
  );
}

/* ---------------- attachments (証憑: 領収書・請求書) ---------------- */

export function listAttachments(year, month) {
  return all('SELECT * FROM attachments WHERE year=? AND month=? ORDER BY id', [year, month]);
}

export function addAttachment({
  year, month, drive_file_id, name, mime_type, web_view_link, category, client_id, source_id, statement_transaction_id,
}) {
  run(
    `INSERT INTO attachments (year, month, drive_file_id, name, mime_type, web_view_link, uploaded_at, category, client_id, source_id, statement_transaction_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [year, month, drive_file_id, name, mime_type || null, web_view_link || null, new Date().toISOString(),
     category || 'receipt', client_id || null, source_id || null, statement_transaction_id || null]
  );
}

export function removeAttachment(id) {
  run('DELETE FROM attachments WHERE id=?', [id]);
}

export function getAttachment(id) {
  return one('SELECT * FROM attachments WHERE id=?', [id]);
}

/* ---------------- theme presets（お気に入りの配色） ---------------- */

export function listThemePresets() {
  return all('SELECT * FROM theme_presets ORDER BY id');
}

export function addThemePreset({ name, bg_color, card_color, ink_color }) {
  run(
    'INSERT INTO theme_presets (name, bg_color, card_color, ink_color, created_at) VALUES (?, ?, ?, ?, ?)',
    [name || null, bg_color, card_color, ink_color, new Date().toISOString()]
  );
}

export function removeThemePreset(id) {
  run('DELETE FROM theme_presets WHERE id=?', [id]);
}

export function exportBytes() {
  return db.export();
}

export async function importBytes(bytes) {
  db = new SQL.Database(bytes);
  db.run(SCHEMA);
  migrateColumns();
  for (const [k, v] of Object.entries(DEFAULT_META)) {
    db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', [k, v]);
  }
  await persist();
}
