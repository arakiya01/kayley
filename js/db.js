import { Storage } from './storage.js';

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
  opening_month INTEGER
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
  uploaded_at TEXT NOT NULL
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
  theme_bg_color: '#FBF8F1',
  theme_card_color: '#F7F1E3',
  theme_ink_color: '#22344A',
  theme_pattern: 'grid',
  theme_bg_image: '',
  theme_bg_image_target: 'background',
};

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

export async function openDatabase() {
  await initSqlJs();
  const existing = await Storage.load();
  if (existing) {
    db = new SQL.Database(existing);
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
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

export function listClients({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM clients ORDER BY sort_order, id'
    : 'SELECT * FROM clients WHERE archived = 0 ORDER BY sort_order, id';
  return all(sql);
}

export function upsertClient(client) {
  if (client.id) {
    run(
      `UPDATE clients SET name=?, currency=?, fx_note=?, sort_order=?, opening_balance=?, opening_year=?, opening_month=? WHERE id=?`,
      [client.name, client.currency || 'JPY', client.fx_note || null, client.sort_order || 0,
       client.opening_balance || 0, client.opening_year || null, client.opening_month || null, client.id]
    );
    return client.id;
  }
  const maxOrder = one('SELECT COALESCE(MAX(sort_order), -1) AS m FROM clients').m;
  run(
    `INSERT INTO clients (name, currency, fx_note, sort_order, opening_balance, opening_year, opening_month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [client.name, client.currency || 'JPY', client.fx_note || null, maxOrder + 1,
     client.opening_balance || 0, client.opening_year || null, client.opening_month || null]
  );
  return one('SELECT last_insert_rowid() AS id').id;
}

export function archiveClient(id, archived = 1) {
  run('UPDATE clients SET archived=? WHERE id=?', [archived, id]);
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

/* ---------------- month status (finalize / hanko stamp) ---------------- */

export function getMonthStatus(year, month) {
  return one('SELECT * FROM month_status WHERE year=? AND month=?', [year, month]);
}

export function setMonthFinalized(year, month, finalized) {
  run(
    `INSERT INTO month_status (year, month, finalized, finalized_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET finalized=excluded.finalized, finalized_at=excluded.finalized_at`,
    [year, month, finalized ? 1 : 0, finalized ? new Date().toISOString() : null]
  );
}

/* ---------------- attachments (証憑: 領収書・請求書) ---------------- */

export function listAttachments(year, month) {
  return all('SELECT * FROM attachments WHERE year=? AND month=? ORDER BY id', [year, month]);
}

export function addAttachment({ year, month, drive_file_id, name, mime_type, web_view_link }) {
  run(
    `INSERT INTO attachments (year, month, drive_file_id, name, mime_type, web_view_link, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [year, month, drive_file_id, name, mime_type || null, web_view_link || null, new Date().toISOString()]
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
  for (const [k, v] of Object.entries(DEFAULT_META)) {
    db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', [k, v]);
  }
  await persist();
}
