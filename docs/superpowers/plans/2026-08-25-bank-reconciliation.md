# 銀行明細による裏付け機能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 銀行のCSV明細を取り込み、売掛金・家賃・役員報酬の入力値と突き合わせて「入金/支払が銀行明細と一致しているか」を確認できるようにする。銀行データは既存4タブのテーブルに一切書き込まない、読み取り専用の裏付け層として実装する。

**Architecture:** 新規「銀行」タブ（`js/views/bank.js`）に口座管理・CSV取込・明細一覧・手動リンク編集を集約する。db.js に4つの新規テーブル（`bank_accounts` / `bank_transactions` / `bank_transaction_links` / `bank_payee_aliases`）と1つの新規列（`officer_pay_entries.employer_insurance_total`）を追加する。既存4タブ（家賃・役員報酬・売掛金）には、該当する数字の近くに小さな照合バッジを追加するだけで、既存のデータ入力ロジックには一切手を入れない。

**Tech Stack:** ビルド無しの素のES modules。sql.js（既存）。CSVパース・文字コード判定は自前実装（`TextDecoder('shift_jis')` はNode/ブラウザ双方の標準機能。追加パッケージなし）。動作確認は Playwright（`chromium.launch()`）による手動駆動スクリプト。自動テストフレームワーク（jest/pytest等）はこのプロジェクトに存在しないため導入しない。

**Spec:** `docs/superpowers/specs/2026-08-25-bank-reconciliation-design.md`

## Global Constraints

- 銀行データは `ar_entries` / `rent_utility_entries` / `officer_pay_entries` / `statement_transactions` のいずれにも書き込まない（`officer_pay_entries.employer_insurance_total` は例外的に新設する列だが、これは役員報酬の手取り計算には一切関与しない、銀行照合専用の参考値）
- npm パッケージを追加しない。ビルド無しの素の ES モジュール構成を維持する
- 外部通信・AIを使った名寄せをしない。ローカルの文字列正規化（既存の `accountMatchKey()`）のみで名寄せする
- 外貨・現金の銀行照合は対象外（JPY口座のみを前提とする）
- 経費タブは v1 ではバッジを置かない（合否判定をしない「参考情報のみ」の位置づけのため）
- 月次レポート（`report.js`）への反映は今回のスコープに含めない
- 既存ユーザーのDBへの影響は `migrateColumns()` 経由の列追加のみで吸収する（`CREATE TABLE IF NOT EXISTS` は既存テーブルを壊さない）
- 各タスックの完了条件は「`node --check` が全対象ファイルで通ること」「Playwright（または該当タスクではplain Node）による検証スクリプトが期待通りの結果を出すこと」「全7＋1タブでコンソールエラーが0件であること（Task 10で最終確認）」

---

## ファイル構成

**新規作成:**
- `js/bankcsv.js` — CSVの文字コード判定・構文解析・列マッピング適用・重複検出キー生成・残高検算（DOM・sql.js に依存しない純粋関数）
- `js/bankbadge.js` — 銀行照合バッジの共通レンダリング（`rent.js` / `officerpay.js` / `ar.js` から共通で使う）
- `js/views/bank.js` — 銀行タブ本体（口座管理・CSV取込・明細一覧・手動リンク編集）

**変更:**
- `js/db.js` — スキーマ4テーブル追加、`officer_pay_entries` に1列追加、CRUD関数、裏付け判定ロジック
- `js/app.js` — `TABS` 配列に `bank` タブを追加
- `js/views/rent.js` — 家賃の照合バッジを1箇所追加
- `js/views/officerpay.js` — `employer_insurance_total` 入力欄（前月引き継ぎ含む）＋ 3つの照合バッジ追加
- `js/views/ar.js` — 得意先ごとの照合バッジを既存の「状況」列に追加
- `css/style.css` — バッジの `muted` バリアント、カードヘッダー内のタイトル+バッジ用の小さなラッパー、役員報酬の新フィールド用のブロックスタイル

---

## 検証方法についての共通ルール

このプロジェクトには自動テストフレームワークが存在しない（`package.json` は Electron ビルド用のスクリプトのみ）。これまでの開発と同じ方式で検証する:

1. **構文チェック**: 変更した全 `.js` ファイルで `node --check <file>` を実行する
2. **ブラウザ検証（DOM・sql.js に依存する変更）**: プロジェクトルートで `python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley` を起動し、Playwright（`chromium.launch()`）で開いて、`page.evaluate()` 内で `await import('/js/db.js')` してデータを直接投入し、DOM・computed style・コンソールエラーを確認する。検証スクリプトはプロジェクト外の作業用ディレクトリ（自分のスクラッチディレクトリ）に置き、リポジトリにはコミットしない
3. **Playwright が使えるか確認**: 作業用ディレクトリで `node -e "import('playwright')"` を実行し、失敗したら同ディレクトリで `npm install playwright` を実行する（ブラウザ本体は `~/.cache/ms-playwright` に既にインストールされていることが多いので、パッケージのインストールだけで動くことが多い）
4. **DOM・sql.jsに依存しない純粋関数（Task 2）**: プレーンな `node script.mjs` で直接 `import` して assert する（ブラウザ不要）
5. 各タスクの最後に `git add` → `git commit` する。コミットメッセージは日本語、既存コミットと同じ粒度（1〜2行の要約＋箇条書きの本文）

---

### Task 1: スキーマ追加・基本CRUD（銀行口座・銀行取引・リンク・エイリアス）

**Files:**
- Modify: `js/db.js`

**Interfaces:**
- Produces:
  - `export const IRREGULAR_CATEGORIES` (配列)
  - `export function listBankAccounts({ includeArchived = false } = {})` → 配列
  - `export function upsertBankAccount(account)` → id（`account.id` があれば更新、無ければ新規。`account` は `{ id?, name, csv_encoding?, csv_mapping_json? }`。既存の `upsertClient` と同じく、更新時は呼び出し側が完全なオブジェクトを渡す前提）
  - `export function archiveBankAccount(id, archived = 1)`
  - `export function bankTransactionFingerprint({ txn_date, amount, description, balance_after, occurrence })` → 文字列
  - `export function importBankTransactions(bankAccountId, rows)` → `{ imported, skipped }`（`rows` は `{ txn_date, amount, description, balance_after, occurrence, raw_row }` の配列）
  - `export function listBankTransactions(bankAccountId, { onlyUnlinked = false } = {})` → 配列
  - `export function listAllBankTransactions()` → 配列（`account_name` 付き、口座横断）
  - `export function linkBankTransaction({ bank_transaction_id, kind, client_id, category, period_start_year, period_start_month, period_end_year, period_end_month, note })` → id
  - `export function unlinkBankTransaction(linkId)`
  - `export function listBankTransactionLinks(bankTransactionId)` → 配列
  - `export function learnBankPayeeAlias(description, { kind, client_id, category })`
  - `export function getBankPayeeAlias(description)` → `{ kind, client_id, category }` または `null`
  - `officer_pay_entries` テーブルに `employer_insurance_total INTEGER` 列（`migrateColumns()` 経由）

- [ ] **Step 1: スキーマにテーブルを追加する**

`js/db.js` の `SCHEMA` 定数（`theme_presets` テーブルの手前、`account_rules` テーブルの直後）に以下を追加する:

```sql
CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  csv_encoding TEXT,
  csv_mapping_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER,
  fingerprint TEXT NOT NULL,
  raw_row TEXT,
  UNIQUE(bank_account_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS bank_transaction_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions(id),
  kind TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  category TEXT,
  period_start_year INTEGER,
  period_start_month INTEGER,
  period_end_year INTEGER,
  period_end_month INTEGER,
  note TEXT,
  confirmed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_payee_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  category TEXT,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 2: `migrateColumns()` に列追加を足す**

`js/db.js` の `migrateColumns()` 関数内、既存の `ensureColumn('statement_transactions', 'account_title', 'TEXT');` の直後に追加する:

```js
  ensureColumn('officer_pay_entries', 'employer_insurance_total', 'INTEGER');
```

- [ ] **Step 3: 不定型カテゴリの定数を追加する**

`js/db.js` の `ACCOUNT_TITLES` 定数の直後に追加する:

```js
// 4タブのどれにも当たらない、不定型だが正体のはっきりした出金（源泉所得税の半年納付など）を
// 分類するための固定リスト。一致するものが無ければ「その他」に寄せ、税理士側での確認を前提とする。
export const IRREGULAR_CATEGORIES = [
  '源泉所得税（納期の特例）', '住民税特別徴収', '法人税等予定納税',
  '消費税中間納付', '労働保険年度更新', 'その他',
];
```

- [ ] **Step 4: 口座のCRUDを追加する**

ファイル末尾（`importBytes` 関数の直前）に追加する:

```js
/* ---------------- 銀行口座・銀行取引（裏付け専用。既存4タブへは書き込まない） ---------------- */

export function listBankAccounts({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM bank_accounts ORDER BY sort_order, id'
    : 'SELECT * FROM bank_accounts WHERE archived = 0 ORDER BY sort_order, id';
  return all(sql);
}

export function upsertBankAccount(account) {
  if (account.id) {
    run(
      'UPDATE bank_accounts SET name=?, csv_encoding=?, csv_mapping_json=? WHERE id=?',
      [account.name, account.csv_encoding || null, account.csv_mapping_json || null, account.id]
    );
    return account.id;
  }
  const maxOrder = one('SELECT COALESCE(MAX(sort_order), -1) AS m FROM bank_accounts').m;
  run(
    'INSERT INTO bank_accounts (name, csv_encoding, csv_mapping_json, sort_order) VALUES (?, ?, ?, ?)',
    [account.name, account.csv_encoding || null, account.csv_mapping_json || null, maxOrder + 1]
  );
  return one('SELECT last_insert_rowid() AS id').id;
}

export function archiveBankAccount(id, archived = 1) {
  run('UPDATE bank_accounts SET archived=? WHERE id=?', [archived, id]);
}

// 銀行取引の重複検出キー。口座・日付・金額・摘要・残高・同一内容行の出現順から作る。
// 同日同額同摘要の正当な複数取引を区別するため、出現順（occurrence）を材料に含める。
export function bankTransactionFingerprint({ txn_date, amount, description, balance_after, occurrence }) {
  return [txn_date, amount, description, balance_after ?? '', occurrence ?? 0].join('|');
}

// 取込確定。既存の指紋と一致する行はスキップする（再取込での重複を防ぐ）。
export function importBankTransactions(bankAccountId, rows) {
  let imported = 0;
  let skipped = 0;
  rows.forEach((row) => {
    const fingerprint = bankTransactionFingerprint(row);
    const existing = one(
      'SELECT id FROM bank_transactions WHERE bank_account_id=? AND fingerprint=?',
      [bankAccountId, fingerprint]
    );
    if (existing) { skipped += 1; return; }
    run(
      `INSERT INTO bank_transactions (bank_account_id, txn_date, description, amount, balance_after, fingerprint, raw_row)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [bankAccountId, row.txn_date, row.description, row.amount, row.balance_after ?? null, fingerprint, row.raw_row || null]
    );
    imported += 1;
  });
  return { imported, skipped };
}

export function listBankTransactions(bankAccountId, { onlyUnlinked = false } = {}) {
  const sql = onlyUnlinked
    ? `SELECT t.* FROM bank_transactions t
       WHERE t.bank_account_id=? AND NOT EXISTS (SELECT 1 FROM bank_transaction_links l WHERE l.bank_transaction_id = t.id)
       ORDER BY t.txn_date, t.id`
    : 'SELECT * FROM bank_transactions WHERE bank_account_id=? ORDER BY txn_date, id';
  return all(sql, [bankAccountId]);
}

export function listAllBankTransactions() {
  return all(
    `SELECT t.*, a.name AS account_name FROM bank_transactions t
     JOIN bank_accounts a ON a.id = t.bank_account_id
     ORDER BY t.txn_date DESC, t.id DESC`
  );
}

/* ---------------- 銀行取引のリンク（裏付け先の記録） ---------------- */

export function linkBankTransaction({
  bank_transaction_id, kind, client_id, category,
  period_start_year, period_start_month, period_end_year, period_end_month, note,
}) {
  run(
    `INSERT INTO bank_transaction_links
       (bank_transaction_id, kind, client_id, category, period_start_year, period_start_month, period_end_year, period_end_month, note, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bank_transaction_id, kind, client_id || null, category || null,
     period_start_year || null, period_start_month || null, period_end_year || null, period_end_month || null,
     note || null, new Date().toISOString()]
  );
  return one('SELECT last_insert_rowid() AS id').id;
}

export function unlinkBankTransaction(linkId) {
  run('DELETE FROM bank_transaction_links WHERE id=?', [linkId]);
}

export function listBankTransactionLinks(bankTransactionId) {
  return all('SELECT * FROM bank_transaction_links WHERE bank_transaction_id=? ORDER BY id', [bankTransactionId]);
}

/* ---------------- 振込名義の学習（account_rules と同じ設計。accountMatchKey()を再利用） ---------------- */

export function learnBankPayeeAlias(description, { kind, client_id, category }) {
  if (!kind) return;
  const matchKey = accountMatchKey(description);
  if (!matchKey) return;
  run(
    `INSERT INTO bank_payee_aliases (match_key, kind, client_id, category, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(match_key) DO UPDATE SET kind=excluded.kind, client_id=excluded.client_id, category=excluded.category, updated_at=excluded.updated_at`,
    [matchKey, kind, client_id || null, category || null, new Date().toISOString()]
  );
}

export function getBankPayeeAlias(description) {
  const matchKey = accountMatchKey(description);
  if (!matchKey) return null;
  return one('SELECT kind, client_id, category FROM bank_payee_aliases WHERE match_key=?', [matchKey]);
}
```

- [ ] **Step 5: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js`
Expected: エラーなく終了する

- [ ] **Step 6: 検証スクリプトを書いて実行する**

作業用ディレクトリに以下を保存する（例: `verify_task1.mjs`）:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const result = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  const rows = [
    { txn_date: '2026-08-01', amount: -148000, description: '家主タロウ', balance_after: 500000, occurrence: 0 },
    { txn_date: '2026-08-01', amount: -148000, description: '家主タロウ', balance_after: 352000, occurrence: 1 },
  ];
  const first = db.importBankTransactions(accountId, rows);
  const second = db.importBankTransactions(accountId, rows); // 同じ行を再取込 → 全件スキップされるはず
  const listed = db.listBankTransactions(accountId);
  const linkId = db.linkBankTransaction({ bank_transaction_id: listed[0].id, kind: 'rent', period_start_year: 2026, period_start_month: 8, period_end_year: 2026, period_end_month: 8 });
  const links = db.listBankTransactionLinks(listed[0].id);
  db.learnBankPayeeAlias('家主タロウ', { kind: 'rent' });
  const alias = db.getBankPayeeAlias('家主タロウ');
  db.unlinkBankTransaction(linkId);
  const afterUnlink = db.listBankTransactionLinks(listed[0].id);
  return {
    firstImport: first, secondImport: second, listedCount: listed.length,
    links, alias, afterUnlinkCount: afterUnlink.length,
    accountsCount: db.listBankAccounts().length,
  };
});
console.log(JSON.stringify(result, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```

サーバーを起動してから実行する:

```bash
nohup python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley > /tmp/http8900.log 2>&1 &
sleep 1
node verify_task1.mjs
```

Expected:
- `firstImport` は `{"imported":2,"skipped":0}`
- `secondImport` は `{"imported":0,"skipped":2}`（重複がスキップされる）
- `listedCount` は `2`
- `links` の配列が1件（`kind: "rent"`, `period_start_year: 2026`, `period_start_month: 8`）
- `alias` が `{"kind":"rent","client_id":null,"category":null}`
- `afterUnlinkCount` は `0`
- `accountsCount` は `1`
- `errors` は `[]`

- [ ] **Step 7: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js
git commit -m "$(cat <<'EOF'
銀行明細機能: スキーマ・基本CRUDを追加

bank_accounts / bank_transactions / bank_transaction_links / bank_payee_aliases
の4テーブルと、officer_pay_entries.employer_insurance_total 列を追加。
既存4タブのテーブルには一切書き込まない、裏付け専用のデータ層。
振込名義の学習は account_rules と同じ設計（accountMatchKey を再利用）。
EOF
)"
```

---

### Task 2: `bankcsv.js` — 文字コード判定・CSV解析・列マッピング・残高検算

**Files:**
- Create: `js/bankcsv.js`

**Interfaces:**
- Consumes: なし（DOM・sql.js に依存しない純粋関数）
- Produces:
  - `export function decodeCsvBytes(bytes)` → `{ text, encoding }`
  - `export function parseCsvText(text)` → 行×列の二次元配列（空行は除外）
  - `export function parseSignedAmount(raw)` → 数値 または `null`
  - `export function parseCsvDate(raw)` → `'YYYY-MM-DD'` 文字列 または `null`
  - `export function mapCsvRow(cells, mapping)` → `{ txn_date, description, amount, balance_after, valid, raw_row }`
  - `export function assignOccurrenceIndex(rows)` → `occurrence` フィールドを追加した配列
  - `export function verifyRunningBalance(rows, openingBalance)` → `[{ index, expected, actual }]`（不整合行のみ）

- [ ] **Step 1: `js/bankcsv.js` を作成する**

```js
// 銀行CSVの文字コード判定・構文解析・列マッピング適用・重複検出用データ整形をまとめたユーティリティ。
// js/statementparsers.js（カード明細PDF）と異なり、銀行ごとの固定パーサーは書かない。
// 列の対応は口座ごとに一度だけユーザーに選んでもらい、bank_accounts.csv_mapping_json に保存する
// （js/views/bank.js 側の責務）。ここでは純粋なデータ変換だけを行い、DOM・sql.js に依存しない。

// バイト列から文字コードを判定してデコードする。
// BOM付きUTF-8を最優先、次にUTF-8として厳密デコードを試み、失敗したらShift_JISとして再デコードする。
export function decodeCsvBytes(bytes) {
  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  const body = hasUtf8Bom ? bytes.subarray(3) : bytes;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { text, encoding: 'utf-8' };
  } catch (e) {
    const text = new TextDecoder('shift_jis').decode(body);
    return { text, encoding: 'shift_jis' };
  }
}

// 引用符・引用符内のカンマ・改行を正しく扱う最小限のCSVパーサー。
// split(',') は使わない（摘要にカンマが含まれる銀行が実在するため）。
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < normalized.length) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += 1; continue;
    }
    field += ch; i += 1;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function toHalfWidthDigits(s) {
  return String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// 日本の銀行CSVでよくある金額表記（カンマ区切り、△・▲・()によるマイナス、空欄）を数値に変換する。
// 解析できない場合は null を返す（0円として黙って取り込まないため）。
export function parseSignedAmount(raw) {
  if (raw == null) return null;
  const s = toHalfWidthDigits(String(raw)).trim();
  if (s === '' || s === '-') return null;
  const negative = /^[△▲(]/.test(s) || s.startsWith('-');
  const cleaned = s.replace(/[△▲()￥¥,\s-]/g, '');
  if (cleaned === '' || !/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return negative ? -value : value;
}

// YYYY/MM/DD, YYYY-MM-DD, YYYY年MM月DD日 の表記を YYYY-MM-DD に正規化する。解析できなければ null。
export function parseCsvDate(raw) {
  if (raw == null) return null;
  const s = toHalfWidthDigits(String(raw)).trim();
  const m = s.match(/^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 列マッピングを1行分のセル配列に適用し、bank_transactions への取込候補に変換する。
// mapping: { dateCol, descCol, payerCol, amountCol, depositCol, withdrawalCol, balanceCol }（列インデックス。使わない列は null）
// amountCol が指定されていれば符号付き1列として扱い、無ければ depositCol/withdrawalCol の2列から符号を作る。
export function mapCsvRow(cells, mapping) {
  const txn_date = parseCsvDate(cells[mapping.dateCol]);
  const descParts = [mapping.descCol, mapping.payerCol]
    .filter((c) => c != null)
    .map((c) => cells[c])
    .filter(Boolean);
  const description = descParts.join(' ').trim();

  let amount = null;
  if (mapping.amountCol != null) {
    amount = parseSignedAmount(cells[mapping.amountCol]);
  } else {
    const deposit = mapping.depositCol != null ? parseSignedAmount(cells[mapping.depositCol]) : null;
    const withdrawal = mapping.withdrawalCol != null ? parseSignedAmount(cells[mapping.withdrawalCol]) : null;
    if (deposit != null && deposit !== 0) amount = Math.abs(deposit);
    else if (withdrawal != null && withdrawal !== 0) amount = -Math.abs(withdrawal);
    else if (deposit === 0 || withdrawal === 0) amount = 0;
  }

  const balance_after = mapping.balanceCol != null ? parseSignedAmount(cells[mapping.balanceCol]) : null;
  const valid = !!txn_date && !!description && amount != null;
  return { txn_date, description, amount, balance_after, valid, raw_row: JSON.stringify(cells) };
}

// マッピング済みの行配列に、口座内の連番（同一日・同一金額・同一摘要の出現順）を振る。
// 重複検出のフィンガープリント材料に使う。
export function assignOccurrenceIndex(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const key = `${row.txn_date}|${row.amount}|${row.description}`;
    const occurrence = seen.get(key) || 0;
    seen.set(key, occurrence + 1);
    return { ...row, occurrence };
  });
}

// 残高列がある場合の検算: 前行残高 + 入出金 = 当該行残高。
// rows は txn_date 昇順（同日内は元の並び順を維持）にソート済みであることを前提とする
// （呼び出し側で並び替えてから渡すこと。CSVの行順は銀行によって新しい順・古い順どちらもあるため）。
// 合わない行があってもその行の実残高から計算を続け、誤差が後続行すべてに連鎖しないようにする。
export function verifyRunningBalance(rows, openingBalance) {
  const mismatches = [];
  let running = openingBalance;
  rows.forEach((row, index) => {
    if (row.balance_after == null) return;
    running += row.amount;
    if (running !== row.balance_after) {
      mismatches.push({ index, expected: running, actual: row.balance_after });
      running = row.balance_after;
    }
  });
  return mismatches;
}
```

- [ ] **Step 2: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/bankcsv.js`
Expected: エラーなく終了する

- [ ] **Step 3: プレーンなNodeスクリプトで検証する（ブラウザ不要）**

このファイルはDOM・sql.jsに依存しない純粋関数のみなので、`node` で直接 `import` して確認できる。作業用ディレクトリに `verify_task2.mjs` として保存する:

```js
import assert from 'node:assert/strict';
import {
  decodeCsvBytes, parseCsvText, parseSignedAmount, parseCsvDate,
  mapCsvRow, assignOccurrenceIndex, verifyRunningBalance,
} from '/home/lima.guest/projects/kayley/js/bankcsv.js';

// 文字コード判定
// NodeのBuffer.from()は 'shift_jis' というエンコーディング名に対応していないため
// （'Unknown encoding' で例外になる）、既知のバイト値で代用する（'あ' = 0x82 0xA0）
const known = new Uint8Array([0x82, 0xA0]);
const decoded = decodeCsvBytes(known);
assert.equal(decoded.text, 'あ');
assert.equal(decoded.encoding, 'shift_jis');

const utf8Bytes = new TextEncoder().encode('こんにちは');
const decodedUtf8 = decodeCsvBytes(utf8Bytes);
assert.equal(decodedUtf8.text, 'こんにちは');
assert.equal(decodedUtf8.encoding, 'utf-8');

// CSV構文解析（引用符内のカンマ・改行を含む）
const csvText = '日付,摘要,金額\n2026/08/01,"振込, 家主タロウ",-148000\n2026/08/02,"改行\nあり",1000\n';
const table = parseCsvText(csvText);
assert.equal(table.length, 3);
assert.deepEqual(table[1], ['2026/08/01', '振込, 家主タロウ', '-148000']);
assert.equal(table[2][1], '改行\nあり');

// 金額解析
assert.equal(parseSignedAmount('148,000'), 148000);
assert.equal(parseSignedAmount('△1,000'), -1000);
assert.equal(parseSignedAmount('▲500'), -500);
assert.equal(parseSignedAmount('(2,000)'), -2000);
assert.equal(parseSignedAmount(''), null);
assert.equal(parseSignedAmount('abc'), null);

// 日付解析
assert.equal(parseCsvDate('2026/08/01'), '2026-08-01');
assert.equal(parseCsvDate('2026年8月1日'), '2026-08-01');
assert.equal(parseCsvDate('not a date'), null);

// 列マッピング（符号付き1列）
const mapping1 = { dateCol: 0, descCol: 1, payerCol: null, amountCol: 2, depositCol: null, withdrawalCol: null, balanceCol: null };
const mapped1 = mapCsvRow(['2026/08/01', '家主タロウ', '-148000'], mapping1);
assert.equal(mapped1.txn_date, '2026-08-01');
assert.equal(mapped1.amount, -148000);
assert.equal(mapped1.valid, true);

// 列マッピング（入金/出金が別列）
const mapping2 = { dateCol: 0, descCol: 1, payerCol: null, amountCol: null, depositCol: 2, withdrawalCol: 3, balanceCol: null };
const mappedDeposit = mapCsvRow(['2026/08/05', 'ノースゲート', '500000', ''], mapping2);
assert.equal(mappedDeposit.amount, 500000);
const mappedWithdrawal = mapCsvRow(['2026/08/06', '家主タロウ', '', '148000'], mapping2);
assert.equal(mappedWithdrawal.amount, -148000);

// 出現順の付与
const withOcc = assignOccurrenceIndex([
  { txn_date: '2026-08-01', amount: -1000, description: 'A' },
  { txn_date: '2026-08-01', amount: -1000, description: 'A' },
  { txn_date: '2026-08-01', amount: -1000, description: 'B' },
]);
assert.deepEqual(withOcc.map((r) => r.occurrence), [0, 1, 0]);

// 残高検算
const balanceRows = [
  { amount: -1000, balance_after: 9000 },
  { amount: -2000, balance_after: 6999 }, // わざと1円ズレさせる
  { amount: 500, balance_after: 7499 },
];
const mismatches = verifyRunningBalance(balanceRows, 10000);
assert.equal(mismatches.length, 1);
assert.equal(mismatches[0].index, 1);
assert.equal(mismatches[0].expected, 7000);
assert.equal(mismatches[0].actual, 6999);

console.log('OK: すべてのアサーションを通過しました');
```

Run: `node verify_task2.mjs`
Expected: `OK: すべてのアサーションを通過しました` と表示され、例外なく終了する（`AssertionError` が出た場合は該当関数を修正する）

- [ ] **Step 4: コミットする**

```bash
cd /home/lima.guest/projects/kayley
git add js/bankcsv.js
git commit -m "$(cat <<'EOF'
銀行明細機能: CSV解析ユーティリティを追加

文字コード判定（BOM→UTF-8厳密→Shift_JIS）、引用符・改行を正しく扱う
CSV構文解析、日本の銀行CSVでよくある金額表記（△▲()）の解析、列マッピング
の適用、重複検出用の出現順付与、残高列による検算をまとめた。
DOM・sql.jsに依存しない純粋関数のみで構成し、plain Nodeで検証済み。
EOF
)"
```

---

### Task 3: 裏付け判定ロジック（家賃・役員報酬3種・売掛金）

**Files:**
- Modify: `js/db.js`

**Interfaces:**
- Consumes: Task 1 の `bank_transaction_links` / `bank_transactions` テーブル構造（SQLで直接参照する）、Task 1 の `listBankTransactions` / `getBankPayeeAlias` / `linkBankTransaction`、既存の `getRentUtilityEntry` / `getOfficerPayEntry` / `resolveOfficerDeductions` / `computeArLedger` / `getClient`
- Produces:
  - `export function officerWithholdingPeriodFor(year, month)` → `{ start: {year, month}, end: {year, month} }` または `null`（1月・7月以外は `null`）
  - `export function derivePeriodForKind(kind, year, month)` → `{ period_start_year, period_start_month, period_end_year, period_end_month }`
  - `export function sumLinkedBankAmount({ kind, client_id, year, month })` → `{ total, count }`
  - `export function sumLinkedBankAmountForPeriod({ kind, periodStartYear, periodStartMonth, periodEndYear, periodEndMonth })` → `{ total, count }`
  - `export function computeRentBackingStatus(year, month)` → `{ status: 'none'|'matched'|'mismatch', bankAmount, expectedTotal, count }`
  - `export function computeOfficerNetBackingStatus(year, month)` → 同上の形
  - `export function computeOfficerInsuranceBackingStatus(year, month)` → 同上の形
  - `export function computeOfficerWithholdingBackingStatus(year, month)` → `{ status: 'not_applicable'|'none'|'matched'|'mismatch', bankAmount, expectedTotal, count }`
  - `export function computeArBackingStatus(clientId)` → 同上の形（月ではなく得意先の全期間累計）
  - `export function applyBankPayeeAliasesToAccount(bankAccountId)` → 適用件数（数値）

- [ ] **Step 1: `js/db.js` に判定ロジックを追加する**

ファイル末尾（Task 1で追加した銀行関連コードの直後、`importBytes` の手前）に追加する:

```js
/* ---------------- 裏付け判定（家賃・役員報酬・売掛金） ---------------- */

// 源泉所得税は納期の特例のため、1月・7月の納付でだけ判定する。
// 1月納付 → 前年7月〜12月分、7月納付 → 当年1月〜6月分。それ以外の月は null（判定なし）。
export function officerWithholdingPeriodFor(year, month) {
  if (month === 1) return { start: { year: year - 1, month: 7 }, end: { year: year - 1, month: 12 } };
  if (month === 7) return { start: { year, month: 1 }, end: { year, month: 6 } };
  return null;
}

// リンクを作るときの期間を、種類に応じて決める共通ヘルパー。
// officer_withholding は該当半年期間、それ以外は取引自身の年月をそのまま単月として使う。
export function derivePeriodForKind(kind, year, month) {
  if (kind === 'officer_withholding') {
    const derived = officerWithholdingPeriodFor(year, month);
    if (derived) {
      return {
        period_start_year: derived.start.year, period_start_month: derived.start.month,
        period_end_year: derived.end.year, period_end_month: derived.end.month,
      };
    }
  }
  return { period_start_year: year, period_start_month: month, period_end_year: year, period_end_month: month };
}

// 指定した種類・年月に対して、単月でリンクされている銀行取引の合計金額と件数。
export function sumLinkedBankAmount({ kind, client_id, year, month }) {
  const conditions = ['l.kind=?', 'l.period_start_year=?', 'l.period_start_month=?'];
  const params = [kind, year, month];
  if (client_id != null) { conditions.push('l.client_id=?'); params.push(client_id); }
  const row = one(
    `SELECT COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS count
     FROM bank_transaction_links l JOIN bank_transactions t ON t.id = l.bank_transaction_id
     WHERE ${conditions.join(' AND ')}`,
    params
  );
  return { total: row.total, count: row.count };
}

// 半年集計など、期間の開始〜終了が完全一致するリンクの合計金額と件数（源泉所得税用）。
export function sumLinkedBankAmountForPeriod({ kind, periodStartYear, periodStartMonth, periodEndYear, periodEndMonth }) {
  const row = one(
    `SELECT COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS count
     FROM bank_transaction_links l JOIN bank_transactions t ON t.id = l.bank_transaction_id
     WHERE l.kind=? AND l.period_start_year=? AND l.period_start_month=? AND l.period_end_year=? AND l.period_end_month=?`,
    [kind, periodStartYear, periodStartMonth, periodEndYear, periodEndMonth]
  );
  return { total: row.total, count: row.count };
}

export function computeRentBackingStatus(year, month) {
  const entry = getRentUtilityEntry(year, month);
  const expectedTotal = entry ? entry.rent_total : 0;
  const { total: bankTotal, count } = sumLinkedBankAmount({ kind: 'rent', year, month });
  if (count === 0) return { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
  const bankAmount = Math.abs(bankTotal);
  return { status: bankAmount === expectedTotal ? 'matched' : 'mismatch', bankAmount, expectedTotal, count };
}

export function computeOfficerNetBackingStatus(year, month) {
  const entry = getOfficerPayEntry(year, month);
  if (!entry) return { status: 'none', bankAmount: 0, expectedTotal: 0, count: 0 };
  const deductions = resolveOfficerDeductions(year, month);
  const deductionTotal = ['health_insurance', 'nursing_care_insurance', 'pension', 'child_support_levy', 'withholding_tax']
    .reduce((a, k) => a + (entry[k] || 0), 0) + deductions.rent_deduction + deductions.utility_deduction;
  const expectedTotal = entry.gross_pay - deductionTotal;
  const { total: bankTotal, count } = sumLinkedBankAmount({ kind: 'officer_net', year, month });
  if (count === 0) return { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
  const bankAmount = Math.abs(bankTotal);
  return { status: bankAmount === expectedTotal ? 'matched' : 'mismatch', bankAmount, expectedTotal, count };
}

export function computeOfficerInsuranceBackingStatus(year, month) {
  const entry = getOfficerPayEntry(year, month);
  const expectedTotal = entry ? (entry.employer_insurance_total || 0) : 0;
  const { total: bankTotal, count } = sumLinkedBankAmount({ kind: 'officer_insurance', year, month });
  if (count === 0) return { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
  const bankAmount = Math.abs(bankTotal);
  return { status: bankAmount === expectedTotal ? 'matched' : 'mismatch', bankAmount, expectedTotal, count };
}

export function computeOfficerWithholdingBackingStatus(year, month) {
  const period = officerWithholdingPeriodFor(year, month);
  if (!period) return { status: 'not_applicable', bankAmount: 0, expectedTotal: 0, count: 0 };
  let expectedTotal = 0;
  let cursor = { ...period.start };
  while (cursor.year * 12 + cursor.month <= period.end.year * 12 + period.end.month) {
    const e = getOfficerPayEntry(cursor.year, cursor.month);
    if (e) expectedTotal += e.withholding_tax || 0;
    cursor = cursor.month === 12 ? { year: cursor.year + 1, month: 1 } : { year: cursor.year, month: cursor.month + 1 };
  }
  const { total: bankTotal, count } = sumLinkedBankAmountForPeriod({
    kind: 'officer_withholding',
    periodStartYear: period.start.year, periodStartMonth: period.start.month,
    periodEndYear: period.end.year, periodEndMonth: period.end.month,
  });
  if (count === 0) return { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
  const bankAmount = Math.abs(bankTotal);
  return { status: bankAmount === expectedTotal ? 'matched' : 'mismatch', bankAmount, expectedTotal, count };
}

// 得意先の入金累計 vs 学習済み振込名義からの入金累計を、全期間で比較する
// （複数月にまたがる入金があるため、月ごとの完全一致は強制しない）。
export function computeArBackingStatus(clientId) {
  const client = getClient(clientId);
  const ledger = computeArLedger(client);
  const expectedTotal = ledger.reduce((a, r) => a + r.payment, 0);
  const row = one(
    `SELECT COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS count
     FROM bank_transaction_links l JOIN bank_transactions t ON t.id = l.bank_transaction_id
     WHERE l.kind='ar' AND l.client_id=?`,
    [clientId]
  );
  if (row.count === 0) return { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
  return { status: row.total === expectedTotal ? 'matched' : 'mismatch', bankAmount: row.total, expectedTotal, count: row.count };
}

// 未分類の銀行取引に、学習済みの振込名義ルールを適用する。適用件数を返す。
// 既にリンク済みの取引は対象にしない（applyAccountRulesToMonthと同じ非破壊の原則）。
export function applyBankPayeeAliasesToAccount(bankAccountId) {
  const unlinked = listBankTransactions(bankAccountId, { onlyUnlinked: true });
  let applied = 0;
  unlinked.forEach((t) => {
    const alias = getBankPayeeAlias(t.description);
    if (!alias) return;
    const [y, m] = t.txn_date.split('-').map(Number);
    const period = derivePeriodForKind(alias.kind, y, m);
    linkBankTransaction({ bank_transaction_id: t.id, kind: alias.kind, client_id: alias.client_id, category: alias.category, ...period });
    applied += 1;
  });
  return applied;
}
```

- [ ] **Step 2: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js`
Expected: エラーなく終了する

- [ ] **Step 3: 検証スクリプトを書いて実行する**

`verify_task3.mjs` として保存する（サーバーは Task 1 と同じ手順で起動）:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const result = await page.evaluate(async () => {
  const db = await import('/js/db.js');

  // 家賃: 一致するケース
  db.upsertRentUtilityEntry({ year: 2026, month: 8, rent_total: 148000, rent_personal_fixed: 44400, water_total: 0, water_personal_pct: 40, gas_total: 0, gas_personal_pct: 40, electricity_total: 0, electricity_personal_pct: 40 });
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  const imp = db.importBankTransactions(accountId, [{ txn_date: '2026-08-27', amount: -148000, description: '家主タロウ', occurrence: 0 }]);
  const txn = db.listBankTransactions(accountId)[0];
  db.linkBankTransaction({ bank_transaction_id: txn.id, kind: 'rent', ...db.derivePeriodForKind('rent', 2026, 8) });
  const rentMatched = db.computeRentBackingStatus(2026, 8);

  // 家賃: 未照合（銀行データなし）のケース
  const rentNone = db.computeRentBackingStatus(2026, 9);

  // 家賃: 差額があるケース
  db.upsertRentUtilityEntry({ year: 2026, month: 9, rent_total: 150000, rent_personal_fixed: 44400, water_total: 0, water_personal_pct: 40, gas_total: 0, gas_personal_pct: 40, electricity_total: 0, electricity_personal_pct: 40 });
  const imp2 = db.importBankTransactions(accountId, [{ txn_date: '2026-09-27', amount: -148000, description: '家主タロウ', occurrence: 0 }]);
  const txn2 = db.listBankTransactions(accountId).find((t) => t.txn_date === '2026-09-27');
  db.linkBankTransaction({ bank_transaction_id: txn2.id, kind: 'rent', ...db.derivePeriodForKind('rent', 2026, 9) });
  const rentMismatch = db.computeRentBackingStatus(2026, 9);

  // 源泉所得税: 1月・7月以外は not_applicable
  const withholdingNA = db.computeOfficerWithholdingBackingStatus(2026, 8);
  // 7月は半年集計対象（2026/1〜2026/6のwithholding_taxを合算）
  for (let m = 1; m <= 6; m++) {
    db.upsertOfficerPayEntry({ year: 2026, month: m, gross_pay: 600000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 10000, use_auto_deduction: 1 });
  }
  const period = db.officerWithholdingPeriodFor(2026, 7);
  const imp3 = db.importBankTransactions(accountId, [{ txn_date: '2026-07-10', amount: -60000, description: '国税', occurrence: 0 }]);
  const txn3 = db.listBankTransactions(accountId).find((t) => t.txn_date === '2026-07-10');
  db.linkBankTransaction({ bank_transaction_id: txn3.id, kind: 'officer_withholding', ...db.derivePeriodForKind('officer_withholding', 2026, 7) });
  const withholdingMatched = db.computeOfficerWithholdingBackingStatus(2026, 7);

  // 学習ルールの自動適用
  db.learnBankPayeeAlias('家主タロウ', { kind: 'rent' });
  const imp4 = db.importBankTransactions(accountId, [{ txn_date: '2026-10-27', amount: -148000, description: '家主タロウ', occurrence: 0 }]);
  const appliedCount = db.applyBankPayeeAliasesToAccount(accountId);
  const linksForOct = db.listBankTransactionLinks(db.listBankTransactions(accountId).find((t) => t.txn_date === '2026-10-27').id);

  return {
    period, rentMatched, rentNone, rentMismatch, withholdingNA, withholdingMatched,
    appliedCount, linksForOctKind: linksForOct[0]?.kind,
  };
});
console.log(JSON.stringify(result, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```

Expected:
- `period` は `{"start":{"year":2026,"month":1},"end":{"year":2026,"month":6}}`
- `rentMatched` は `{"status":"matched","bankAmount":148000,"expectedTotal":148000,"count":1}`
- `rentNone` は `{"status":"none","bankAmount":0,"expectedTotal":0,"count":0}`
- `rentMismatch` は `{"status":"mismatch","bankAmount":148000,"expectedTotal":150000,"count":1}`
- `withholdingNA` は `{"status":"not_applicable","bankAmount":0,"expectedTotal":0,"count":0}`
- `withholdingMatched` は `{"status":"matched","bankAmount":60000,"expectedTotal":60000,"count":1}`（1月分〜6月分、各10,000円×6ヶ月＝60,000円）
- `appliedCount` は `1`
- `linksForOctKind` は `"rent"`（学習したルールが新規取込にも自動で当たっている）
- `errors` は `[]`

- [ ] **Step 4: コミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js
git commit -m "$(cat <<'EOF'
銀行明細機能: 裏付け判定ロジックを追加

家賃・役員報酬（手取り/社会保険料/源泉所得税）・売掛金それぞれの
「銀行明細と一致しているか」を判定する関数を追加。源泉所得税は
納期の特例のため1月・7月のみ、直前半年分の累計で判定する。
振込名義の学習ルールを未分類の取引へ自動適用する仕組みも追加。
EOF
)"
```

---

### Task 4: `bankbadge.js` 共通バッジ ＋ 家賃タブへの表示

**Files:**
- Create: `js/bankbadge.js`
- Modify: `js/views/rent.js`
- Modify: `css/style.css`

**Interfaces:**
- Consumes: Task 3 の `computeRentBackingStatus(year, month)` の戻り値の形（`{status, bankAmount, expectedTotal, count}`）
- Produces: `export function bankBadgeHtml(status)` → HTML文字列（`js/bankbadge.js`）。以降 Task 5・6 でも同じ関数を使う

- [ ] **Step 1: `js/bankbadge.js` を作成する**

```js
// 銀行照合バッジの見た目を1箇所にまとめる。rent.js / officerpay.js / ar.js から共通で使う。
import { yen } from './format.js';

export function bankBadgeHtml(status) {
  if (status.status === 'not_applicable') return '';
  if (status.status === 'none') {
    return `<a href="#/bank" class="badge muted bank-badge" title="銀行明細と照合する取引がまだありません">銀行未照合</a>`;
  }
  if (status.status === 'matched') {
    return `<a href="#/bank" class="badge good bank-badge" title="銀行明細（${yen(status.bankAmount)}円）と一致">銀行照合済み</a>`;
  }
  const diff = status.bankAmount - status.expectedTotal;
  const sign = diff > 0 ? '+' : '';
  return `<a href="#/bank" class="badge warning bank-badge" title="入力値 ${yen(status.expectedTotal)}円 / 銀行 ${yen(status.bankAmount)}円">差額 ${sign}${yen(diff)}円</a>`;
}
```

- [ ] **Step 2: CSSを追加する**

`css/style.css` の `.badge.good { ... }` の直後に追加する:

```css
.badge.muted { background: rgba(124,135,148,0.12); color: var(--ink-muted); }
.bank-badge { text-decoration: none; cursor: pointer; }
.bank-badge-slot { margin-top: 6px; }
.card-header-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
```

- [ ] **Step 3: `js/views/rent.js` に組み込む**

import 文を変更する（既存の1行目〜13行目付近）:

```js
import {
  getRentUtilityEntry, findPreviousRentUtilityEntry, upsertRentUtilityEntry,
  computeUtilityPersonalTotal, computeRentBackingStatus, getMeta, getFoundingDate,
} from '../db.js';
import {
  yen, monthLabel, monthShort, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading, todayYearMonth,
} from '../format.js';
import { renderFySelector } from './fyselector.js';
import { enableGridPaste } from './gridpaste.js';
import { lineChart } from '../charts.js';
import { changeStrip } from '../changestrip.js';
import { bankBadgeHtml } from '../bankbadge.js';
import { seriesColor } from '../colors.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';
```

家賃カードの `card-header` を変更する（既存の該当箇所を置き換える）:

```html
        <div class="card-header">
          <div class="card-header-title"><h2>家賃</h2><span id="rent-bank-badge"></span></div>
          <div class="toolbar"><button class="btn ghost bulk-toggle-btn">📋 一括入力（年度）</button></div>
        </div>
```

`updateDisplay(entry)` 関数の最後にバッジ更新を追加する（既存関数の末尾、`}` の直前に1行追加）:

```js
  function updateDisplay(entry) {
    FIELDS.forEach((f) => {
      const personal = Math.round(entry[f.totalKey] * entry[f.pctKey] / 100);
      container.querySelector(`#${f.key}-personal`).textContent = yen(personal);
    });
    const utilityPersonalTotal = computeUtilityPersonalTotal(entry);
    container.querySelector('#utility-personal-total').innerHTML = `${yen(utilityPersonalTotal)}<span class="unit">円</span>`;
    container.querySelector('#grand-personal-total').innerHTML = `${yen(utilityPersonalTotal + entry.rent_personal_fixed)}<span class="unit">円</span>`;
    container.querySelector('#rent-bank-badge').innerHTML = bankBadgeHtml(computeRentBackingStatus(year, month));
  }
```

- [ ] **Step 4: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/bankbadge.js && node --check js/views/rent.js`
Expected: エラーなく終了する

- [ ] **Step 5: 検証スクリプトを書いて実行する**

サーバー起動後、`verify_task4.mjs`:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.setMeta('founding_year', 2024); db.setMeta('founding_month', 4);
  db.upsertRentUtilityEntry({ year: 2026, month: 8, rent_total: 148000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40 });
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [{ txn_date: '2026-08-27', amount: -148000, description: '家主タロウ', occurrence: 0 }]);
  const txn = db.listBankTransactions(accountId)[0];
  db.linkBankTransaction({ bank_transaction_id: txn.id, kind: 'rent', ...db.derivePeriodForKind('rent', 2026, 8) });
  await db.persist();
});
await page.reload({ waitUntil: 'networkidle' });
await page.goto(`${BASE}#/rent`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const badge = await page.evaluate(() => {
  const el = document.querySelector('#rent-bank-badge .bank-badge');
  return { text: el?.textContent.trim(), cls: el?.className };
});
console.log('badge (matched期待):', JSON.stringify(badge));

// 未照合の月（9月）でも壊れずに「未照合」と出ることを確認
await page.goto(`${BASE}#/rent`, { waitUntil: 'networkidle' });
await page.evaluate(() => { document.querySelectorAll('.status-strip .pill')[5].click(); }); // 9月へ
await page.waitForTimeout(500);
const badgeNone = await page.evaluate(() => {
  const el = document.querySelector('#rent-bank-badge .bank-badge');
  return { text: el?.textContent.trim(), cls: el?.className };
});
console.log('badge (未照合期待):', JSON.stringify(badgeNone));

console.log('errors:', JSON.stringify(errors));
await browser.close();
```

Expected:
- 1つ目の `badge` は `{"text":"銀行照合済み","cls":"badge good bank-badge"}`
- 2つ目の `badgeNone` は `{"text":"銀行未照合","cls":"badge muted bank-badge"}`
- `errors` は `[]`

- [ ] **Step 6: コミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/bankbadge.js js/views/rent.js css/style.css
git commit -m "$(cat <<'EOF'
銀行明細機能: 共通照合バッジを追加し、家賃タブに表示

済/差額あり/未照合の3状態を1箇所（bankbadge.js）にまとめ、家賃タブの
「家賃」カードタイトル横に表示する。押すと銀行タブへ移動する。
このバッジはTask 5（役員報酬）・Task 6（売掛金）でも共通で使う。
EOF
)"
```

---

### Task 5: 役員報酬タブ — `employer_insurance_total` 入力欄（前月引き継ぎ含む）＋ 3バッジ

**Files:**
- Modify: `js/db.js`（`upsertOfficerPayEntry` のSQLに列を追加）
- Modify: `js/views/officerpay.js`
- Modify: `css/style.css`

**Interfaces:**
- Consumes: Task 3 の `computeOfficerNetBackingStatus` / `computeOfficerInsuranceBackingStatus` / `computeOfficerWithholdingBackingStatus` / `officerWithholdingPeriodFor`、Task 4 の `bankBadgeHtml`
- Produces: `officer_pay_entries.employer_insurance_total` が `upsertOfficerPayEntry` で保存・更新されるようになる

- [ ] **Step 1: `upsertOfficerPayEntry` に列を追加する**

`js/db.js` の既存の `upsertOfficerPayEntry` 関数を、以下の内容に置き換える:

```js
export function upsertOfficerPayEntry(e) {
  run(
    `INSERT INTO officer_pay_entries
       (year, month, gross_pay, health_insurance, nursing_care_insurance, pension,
        child_support_levy, withholding_tax, use_auto_deduction, manual_rent_deduction,
        manual_utility_deduction, employer_insurance_total, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       employer_insurance_total=excluded.employer_insurance_total,
       note=excluded.note`,
    [e.year, e.month, e.gross_pay || 0, e.health_insurance || 0, e.nursing_care_insurance || 0,
     e.pension || 0, e.child_support_levy || 0, e.withholding_tax || 0,
     e.use_auto_deduction ? 1 : 0, e.manual_rent_deduction || 0, e.manual_utility_deduction || 0,
     e.employer_insurance_total || 0, e.note || null]
  );
}
```

- [ ] **Step 2: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js`
Expected: エラーなく終了する

- [ ] **Step 3: `js/views/officerpay.js` を変更する**

import 文を変更する:

```js
import {
  getOfficerPayEntry, findPreviousOfficerPayEntry, upsertOfficerPayEntry, resolveOfficerDeductions,
  computeOfficerNetBackingStatus, computeOfficerInsuranceBackingStatus, computeOfficerWithholdingBackingStatus,
  officerWithholdingPeriodFor, prevMonth, getMeta, getFoundingDate,
} from '../db.js';
import { yen, monthLabel, monthShort, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading, todayYearMonth } from '../format.js';
import { renderFySelector } from './fyselector.js';
import { enableGridPaste } from './gridpaste.js';
import { donutChart } from '../charts.js';
import { changeStrip } from '../changestrip.js';
import { bankBadgeHtml } from '../bankbadge.js';
import { seriesColor } from '../colors.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';
```

`BULK_FIELDS` 定数を変更する（`employer_insurance_total` を末尾に追加する）:

```js
const BULK_FIELDS = [{ key: 'gross_pay', label: '支給額' }, ...DEDUCTION_FIELDS, { key: 'employer_insurance_total', label: '社会保険料（会社負担込み）' }];
```

`payslip-grid` の直後、`当月の内訳` の `h2` の手前に新しいブロックを追加する（既存の `</div>`＝`payslip-grid` の閉じタグの直後）:

```html
        <div class="employer-insurance-block">
          <div class="compact-field">
            <label for="employer_insurance_total">社会保険料（会社負担込み・銀行引落額）</label>
            <span><input type="text" inputmode="numeric" class="currency-input" id="employer_insurance_total"><small>円</small></span>
          </div>
          <div id="officer-insurance-badge-slot" class="bank-badge-slot"></div>
          <div class="card-note" style="margin:0">手取り計算には使いません。年金事務所への実際の引き落とし額をそのまま入力し、銀行明細との照合にのみ使います。</div>
        </div>
        <h2>当月の内訳</h2>
```

`差引支給額` の行の直後にバッジスロットを追加する（既存の `.net-pay-line` の直後）:

```html
            <div class="net-pay-line"><span>差引支給額</span><strong class="num" id="net-pay">0<span class="unit">円</span></strong></div>
            <div id="officer-net-badge-slot" class="bank-badge-slot"></div>
```

`DEDUCTION_FIELDS.map(...)` のループの直後（`use_auto` のラベルの手前）に源泉所得税バッジのスロットを追加する:

```html
            ${DEDUCTION_FIELDS.map((f) => `
              <div class="compact-field"><label for="${f.key}">${f.label}</label><span><input type="text" inputmode="numeric" class="currency-input" id="${f.key}"><small>円</small></span></div>
            `).join('')}
            <div id="officer-withholding-badge-slot" class="bank-badge-slot"></div>
            <label class="auto-toggle"><input type="checkbox" id="use_auto"> 家賃・光熱費の自動反映を使う</label>
```

`state` の3つの初期値オブジェクトすべてに `employer_insurance_total` を追加する（既存の3箇所）:

```js
  const existing = getOfficerPayEntry(year, month);
  const previousEntry = existing ? null : findPreviousOfficerPayEntry(year, month);
  let carriedFrom = previousEntry ? { year: previousEntry.year, month: previousEntry.month } : null;
  const state = existing ? { ...existing } : previousEntry ? {
    gross_pay: previousEntry.entry.gross_pay,
    health_insurance: previousEntry.entry.health_insurance,
    nursing_care_insurance: previousEntry.entry.nursing_care_insurance,
    pension: previousEntry.entry.pension,
    child_support_levy: previousEntry.entry.child_support_levy,
    withholding_tax: previousEntry.entry.withholding_tax,
    employer_insurance_total: previousEntry.entry.employer_insurance_total,
    use_auto_deduction: 1, manual_rent_deduction: 0, manual_utility_deduction: 0,
  } : {
    gross_pay: 0, health_insurance: 0, nursing_care_insurance: 0, pension: 0,
    child_support_levy: 0, withholding_tax: 0, employer_insurance_total: 0, use_auto_deduction: 1,
    manual_rent_deduction: 0, manual_utility_deduction: 0,
  };
```

引き継ぎ対象フィールドのリストに追加する（既存の `carriedFrom` の直後）:

```js
  if (carriedFrom) {
    container.querySelector('#carry-notice-slot').innerHTML = `
      <div class="carry-notice" id="carry-notice">
        <span class="carry-notice-text">${monthLabel(carriedFrom.year, carriedFrom.month)}の内容を引き継いで表示しています。金額を確認してください。</span>
        <button class="btn primary" id="carry-confirm-btn">この内容で確定する</button>
      </div>`;
    ['gross_pay', ...DEDUCTION_FIELDS.map((f) => f.key), 'employer_insurance_total'].forEach((id) => container.querySelector(`#${id}`).classList.add('carried'));
  }
```

値のセットに1行追加する（既存の `container.querySelector('#gross_pay').value = state.gross_pay;` の直後）:

```js
  container.querySelector('#gross_pay').value = state.gross_pay;
  container.querySelector('#employer_insurance_total').value = state.employer_insurance_total;
  DEDUCTION_FIELDS.forEach((f) => { container.querySelector(`#${f.key}`).value = state[f.key]; });
```

`save()` 内の `entry` 構築に1行追加する:

```js
  function save() {
    const useAuto = container.querySelector('#use_auto').checked;
    const entry = {
      year, month,
      gross_pay: parseCurrencyInput(container.querySelector('#gross_pay').value),
      employer_insurance_total: parseCurrencyInput(container.querySelector('#employer_insurance_total').value),
      use_auto_deduction: useAuto,
      manual_rent_deduction: parseCurrencyInput(container.querySelector('#manual_rent_deduction').value),
      manual_utility_deduction: parseCurrencyInput(container.querySelector('#manual_utility_deduction').value),
    };
```

`recompute(entry)` 関数の末尾（`renderChart();` の直前）にバッジ更新を追加する:

```js
  function recompute(entry) {
    const d = resolveOfficerDeductions(year, month);
    container.querySelector('#rent-deduction-display').innerHTML = `${yen(d.rent_deduction)}<span class="unit">円</span>`;
    container.querySelector('#utility-deduction-display').innerHTML = `${yen(d.utility_deduction)}<span class="unit">円</span>`;
    const deductionTotal = DEDUCTION_FIELDS.reduce((a, f) => a + (entry[f.key] || 0), 0) + d.rent_deduction + d.utility_deduction;
    container.querySelector('#deduction-total').innerHTML = `−${yen(deductionTotal)}<span class="unit">円</span>`;
    const net = entry.gross_pay - deductionTotal;
    container.querySelector('#net-pay').innerHTML = `${yen(net)}<span class="unit">円</span>`;

    const socialInsurance = (entry.health_insurance || 0) + (entry.nursing_care_insurance || 0)
      + (entry.pension || 0) + (entry.child_support_levy || 0);
    donutChart(container.querySelector('#pay-breakdown-chart'), {
      centerLabel: '差引支給額（手取り）',
      centerValue: net,
      segments: [
        { label: '差引支給額（手取り）', color: seriesColor(0), value: Math.max(0, net) },
        { label: '社会保険料', color: seriesColor(1), value: socialInsurance },
        { label: '源泉所得税', color: seriesColor(2), value: entry.withholding_tax || 0 },
        { label: '家賃・光熱費控除', color: seriesColor(3), value: d.rent_deduction + d.utility_deduction },
      ],
    });

    container.querySelector('#officer-net-badge-slot').innerHTML = bankBadgeHtml(computeOfficerNetBackingStatus(year, month));
    container.querySelector('#officer-insurance-badge-slot').innerHTML = bankBadgeHtml(computeOfficerInsuranceBackingStatus(year, month));
    const withholdingSlot = container.querySelector('#officer-withholding-badge-slot');
    withholdingSlot.innerHTML = officerWithholdingPeriodFor(year, month)
      ? bankBadgeHtml(computeOfficerWithholdingBackingStatus(year, month))
      : '';

    renderChart();
  }
```

`renderBulkTable()` 内の `existingEntry` フォールバックオブジェクトに1行追加する:

```js
        const existingEntry = getOfficerPayEntry(y, m) || {
          gross_pay: 0, health_insurance: 0, nursing_care_insurance: 0, pension: 0,
          child_support_levy: 0, withholding_tax: 0, employer_insurance_total: 0, use_auto_deduction: 1,
          manual_rent_deduction: 0, manual_utility_deduction: 0,
        };
```

- [ ] **Step 4: CSSを追加する**

`css/style.css` の `.bank-badge-slot { margin-top: 6px; }` の直後に追加する（このセレクタは Task 4 で追加済み）:

```css
.employer-insurance-block { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--hairline); }
```

- [ ] **Step 5: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/officerpay.js`
Expected: エラーなく終了する

- [ ] **Step 6: 検証スクリプトを書いて実行する**

サーバー起動後、`verify_task5.mjs`:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.setMeta('founding_year', 2024); db.setMeta('founding_month', 4);
  db.upsertOfficerPayEntry({ year: 2026, month: 7, gross_pay: 600000, health_insurance: 29520, nursing_care_insurance: 5340, pension: 54900, child_support_levy: 2196, withholding_tax: 42400, employer_insurance_total: 217722, use_auto_deduction: 1 });
  await db.persist();
});
await page.reload({ waitUntil: 'networkidle' });
await page.goto(`${BASE}#/officer`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// 8月（データなし）は7月の内容を引き継ぐはず。employer_insurance_totalも引き継ぎ対象。
const carried = await page.evaluate(() => ({
  gross: document.querySelector('#gross_pay').value,
  employerInsurance: document.querySelector('#employer_insurance_total').value,
  isCarried: document.querySelector('#employer_insurance_total').classList.contains('carried'),
  noticeText: document.querySelector('.carry-notice-text')?.textContent,
}));
console.log('8月・引き継ぎ表示:', JSON.stringify(carried));

// 確定する
await page.click('#carry-confirm-btn');
await page.waitForTimeout(400);
const savedNow = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const e = db.getOfficerPayEntry(2026, 8);
  return { employer_insurance_total: e?.employer_insurance_total };
});
console.log('確定後のDB保存値(217722期待):', JSON.stringify(savedNow));

// 銀行データを紐付けて一致バッジを確認
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [{ txn_date: '2026-08-28', amount: -217722, description: '社会保険料', occurrence: 0 }]);
  const txn = db.listBankTransactions(accountId)[0];
  db.linkBankTransaction({ bank_transaction_id: txn.id, kind: 'officer_insurance', ...db.derivePeriodForKind('officer_insurance', 2026, 8) });
  await db.persist();
});
await page.reload({ waitUntil: 'networkidle' });
await page.goto(`${BASE}#/officer`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const badges = await page.evaluate(() => ({
  net: document.querySelector('#officer-net-badge-slot .bank-badge')?.textContent.trim(),
  insurance: document.querySelector('#officer-insurance-badge-slot .bank-badge')?.textContent.trim(),
  withholdingSlotEmpty: document.querySelector('#officer-withholding-badge-slot').innerHTML.trim() === '',
}));
console.log('8月のバッジ（insuranceはmatched期待、netは未照合、withholdingは空欄期待）:', JSON.stringify(badges));

console.log('errors:', JSON.stringify(errors));
await browser.close();
```

Expected:
- `carried` の `employerInsurance` は `"217,722"`、`isCarried` は `true`
- `savedNow` は `{"employer_insurance_total":217722}`
- `badges.insurance` は `"銀行照合済み"`、`badges.net` は `"銀行未照合"`（手取りの銀行取引を紐付けていないため）、`badges.withholdingSlotEmpty` は `true`（8月は1月・7月ではないため源泉所得税バッジは表示しない）
- `errors` は `[]`

- [ ] **Step 7: コミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js js/views/officerpay.js css/style.css
git commit -m "$(cat <<'EOF'
銀行明細機能: 役員報酬タブに会社負担分社会保険料の記録と3つの照合バッジを追加

新規フィールド employer_insurance_total（会社負担込みの社会保険料・
銀行引落額）を追加。手取り計算には関与させず、銀行照合専用の参考値と
して扱う。保険料率の計算式による算出は行わず、前月引き継ぎの対象に
加えるだけに留めた（Round Cの前月引き継ぎの仕組みをそのまま再利用）。

差引支給額（officer_net）・会社負担社会保険料（officer_insurance）・
源泉所得税（officer_withholding、納期の特例のため1月・7月のみ表示）
の3箇所にバッジを表示する。
EOF
)"
```

---

### Task 6: 売掛金タブへのバッジ表示

**Files:**
- Modify: `js/views/ar.js`

**Interfaces:**
- Consumes: Task 3 の `computeArBackingStatus(clientId)`、Task 4 の `bankBadgeHtml`

- [ ] **Step 1: import 文を変更する**

```js
import {
  listClientsForMonth, listClientsForMonths,
  listClients, upsertClient, archiveClient, getArEntry, upsertArEntry, computeArLedger, unpaidStreak,
  computeArBackingStatus, getMeta, getFoundingDate,
  listAttachments, addAttachment, removeAttachment, clientTradeAllowsMonth,
} from '../db.js';
import {
  yen, monthShort, escapeHtml, fiscalYearStartOf, fiscalYearMonths, fiscalPeriodHeading, todayYearMonth,
} from '../format.js';
import { renderFySelector } from './fyselector.js';
import { enableGridPaste } from './gridpaste.js';
import { lineChart, emptyChart } from '../charts.js';
import { seriesColor, foldSeriesArrays } from '../colors.js';
import { bankBadgeHtml } from '../bankbadge.js';
import * as gdrive from '../gdrive.js';
import { fileChipHtml } from '../fileicon.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';
```

- [ ] **Step 2: 「状況」列にバッジを追加する**

既存の `<td>${agingBadge(streak)}</td>` を以下に置き換える（`renderTable()` 内、行テンプレートの中）:

```html
              <td>${agingBadge(streak)} ${bankBadgeHtml(computeArBackingStatus(client.id))}</td>
```

- [ ] **Step 3: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/ar.js`
Expected: エラーなく終了する

- [ ] **Step 4: 検証スクリプトを書いて実行する**

サーバー起動後、`verify_task6.mjs`:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.setMeta('founding_year', 2024); db.setMeta('founding_month', 4);
  const clientId = db.upsertClient({ name: 'ノースゲート' });
  db.upsertArEntry({ client_id: clientId, year: 2026, month: 8, sales: 500000, payment: 480000 });
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [{ txn_date: '2026-08-20', amount: 480000, description: 'ノースゲート', occurrence: 0 }]);
  const txn = db.listBankTransactions(accountId)[0];
  db.linkBankTransaction({ bank_transaction_id: txn.id, kind: 'ar', client_id: clientId, ...db.derivePeriodForKind('ar', 2026, 8) });
  await db.persist();
});
await page.reload({ waitUntil: 'networkidle' });
await page.goto(`${BASE}#/ar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const badge = await page.evaluate(() => {
  const el = document.querySelector('#ar-table-slot .bank-badge');
  return { text: el?.textContent.trim(), cls: el?.className };
});
console.log('売掛金バッジ(matched期待):', JSON.stringify(badge));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```

Expected: `badge` は `{"text":"銀行照合済み","cls":"badge good bank-badge"}`。`errors` は `[]`

- [ ] **Step 5: コミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/views/ar.js
git commit -m "$(cat <<'EOF'
銀行明細機能: 売掛金タブに得意先ごとの照合バッジを追加

既存の滞留バッジ（状況列）の隣に表示する。得意先の入金累計と、
学習済み振込名義からの入金累計を全期間で比較する（複数月にまたがる
入金があるため、月ごとの完全一致は強制しない）。
EOF
)"
```

---

### Task 7: 銀行タブの土台（口座管理）＋ app.js への組み込み

**Files:**
- Create: `js/views/bank.js`
- Modify: `js/app.js`

**Interfaces:**
- Consumes: Task 1 の `listBankAccounts` / `upsertBankAccount` / `archiveBankAccount`
- Produces: `export function render(container)`（`js/views/bank.js`。`TABS` から `mod.render(viewRoot, ctx)` として呼ばれるが、口座管理段階では `ctx` は使わない）。この時点では `openAccountDetail` は空の関数（Task 8で実装する）

- [ ] **Step 1: `js/views/bank.js` を作成する**

```js
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
```

- [ ] **Step 2: `js/app.js` の `TABS` に追加する**

import 文に追加する（既存の `import * as settings from './views/settings.js';` の手前）:

```js
import * as bank from './views/bank.js';
```

`TABS` 配列を変更する（`settings` の手前に `bank` を挿入する）:

```js
const TABS = [
  { key: 'dashboard', label: 'ダッシュボード', mod: dashboard, needsMonth: true },
  { key: 'ar', label: '売掛金', mod: ar, needsMonth: true },
  { key: 'rent', label: '家賃・光熱費', mod: rent, needsMonth: true },
  { key: 'officer', label: '役員報酬', mod: officerpay, needsMonth: true },
  { key: 'expenses', label: '経費', mod: expenses, needsMonth: true },
  { key: 'report', label: '月次レポート', mod: report, needsMonth: true },
  { key: 'bank', label: '銀行', mod: bank, needsMonth: false },
  { key: 'settings', label: '設定', mod: settings, needsMonth: false },
];
```

`renderProgressSpine()` 内の `steps`（ワークフロータブ＝完了印の付く5科目）には追加しない。銀行タブは締めの5科目に含まれない裏付け専用のタブであり、完了印の対象にしないため、この配列は変更しない。

**重要な補足（セルフレビューで発見した欠落）**: `steps` 配列に追加しないだけだと、銀行タブへの恒常的なナビゲーション導線がヘッダーのどこにも無くなる。現状ヘッダー右上には「設定」への `.utility-link` が1つあるだけで、これでは銀行タブは Task 4/5/6 のバッジ経由でしか辿り着けず、CSVを能動的に取り込みに行く動線が無い。これを避けるため、`renderProgressSpine()` 内の `spine-top-slot` のHTML（既存）:

```js
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
```

を次に変更し、「設定」の手前に「銀行」への `.utility-link` を追加する:

```js
  document.getElementById('spine-top-slot').innerHTML = `
    <div class="spine-top">
      <div class="wordmark-link">
        <a href="#/dashboard" class="display">Kayley</a>
        ${companyName ? `<small>${escapeHtml(companyName)}</small>` : '<small><a href="#/settings">会社名を設定する</a></small>'}
      </div>
      <span class="spine-divider"></span>
      <a class="utility-link ${state.tab === 'bank' ? 'active' : ''}" href="#/bank">銀行</a>
      <a class="utility-link ${state.tab === 'settings' ? 'active' : ''}" href="#/settings">設定</a>
    </div>
  `;
```

- [ ] **Step 3: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/bank.js && node --check js/app.js`
Expected: エラーなく終了する

- [ ] **Step 4: 検証スクリプトを書いて実行する**

サーバー起動後、`verify_task7.mjs`:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.goto(`${BASE}#/bank`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const hasTab = await page.evaluate(() => !!document.querySelector('.utility-link[href="#/bank"]'));
console.log('銀行タブがナビに存在する:', hasTab);

// 口座を追加する
await page.click('#add-account-btn');
await page.fill('#new-account-name', 'みずほ銀行 普通');
await page.click('#save-account-btn');
await page.waitForTimeout(400);
const afterAdd = await page.evaluate(() => ({
  rows: document.querySelectorAll('#account-list-slot tbody tr').length,
  state: document.querySelector('#account-list-slot tbody tr td:nth-child(2)')?.textContent.trim(),
}));
console.log('追加後(1件・有効期待):', JSON.stringify(afterAdd));

// 休止する
await page.click('.archive-account-btn');
await page.waitForTimeout(400);
const afterArchive = await page.evaluate(() => document.querySelector('#account-list-slot tbody tr td:nth-child(2)')?.textContent.trim());
console.log('休止後(休止中期待):', afterArchive);

console.log('errors:', JSON.stringify(errors));
await browser.close();
```

Expected:
- `hasTab` は `true`
- `afterAdd` は `{"rows":1,"state":"有効"}`
- `afterArchive` は `"休止中"`
- `errors` は `[]`

- [ ] **Step 5: コミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/views/bank.js js/app.js
git commit -m "$(cat <<'EOF'
銀行明細機能: 銀行タブの土台（口座管理）を追加

口座の追加・休止・再開ができる最小限の画面。TABSに追加し、
締めの5科目（ワークフロータブ）には含めない（裏付け専用のため）。
CSV取込・明細一覧・リンク編集はTask 8以降で実装する。
EOF
)"
```

---

### Task 8: CSV取込（列マッピング・重複スキップ・残高検算）

**Files:**
- Modify: `js/views/bank.js`

**Interfaces:**
- Consumes: Task 2 の `decodeCsvBytes` / `parseCsvText` / `mapCsvRow` / `assignOccurrenceIndex` / `verifyRunningBalance`、Task 1 の `importBankTransactions`
- Produces: `openAccountDetail(accountId)` が実際にCSV取込UIを表示するようになる。`commitImport(accountId, table, mapping, encoding)`（`bank.js` 内のローカル関数、外部からは呼ばれない）

- [ ] **Step 1: import 文を追加する**

`js/views/bank.js` の先頭に追加する:

```js
import { listBankAccounts, upsertBankAccount, archiveBankAccount, importBankTransactions, applyBankPayeeAliasesToAccount } from '../db.js';
import { escapeHtml } from '../format.js';
import { decodeCsvBytes, parseCsvText, mapCsvRow, assignOccurrenceIndex, verifyRunningBalance } from '../bankcsv.js';
```

（既存の `import { listBankAccounts, upsertBankAccount, archiveBankAccount } from '../db.js';` を上記1行目に置き換える）

- [ ] **Step 2: `openAccountDetail` を実装する**

`js/views/bank.js` 内の `openAccountDetail` 関数を、以下に置き換える:

```js
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
    const header = table[0];
    const previewRows = table.slice(0, 4);
    // allowEmpty=true の項目は「（使わない）」を既定選択にする。末尾に追加するだけだと
    // ブラウザの既定動作で先頭の列（日付列など）が誤って選択されたままになってしまうため
    // （実装後の検証で発見。ユーザーが「金額の列」を使わず入金/出金の別列だけ使う場合、
    // 未操作のセレクトが日付列を金額として誤認識し、全行が取込不能になるバグがあった）。
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
    const dataRows = table.slice(1);
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
    const aliasApplied = applyBankPayeeAliasesToAccount(accountId);

    const parts = [`${imported}件を取り込みました`];
    if (skipped > 0) parts.push(`${skipped}件は既に取込済みのためスキップ`);
    if (invalidCount > 0) parts.push(`${invalidCount}件は日付・金額を読み取れず取り込めませんでした`);
    if (balanceMismatches.length > 0) parts.push(`${balanceMismatches.length}件で残高の整合が取れませんでした（取込は完了しています）`);
    if (aliasApplied > 0) parts.push(`${aliasApplied}件は学習済みの振込名義から自動で分類しました`);
    container.querySelector('#import-status').textContent = parts.join('／');
    container.querySelector('#mapping-slot').innerHTML = '';
    renderTransactionList(accountId);
  }

  function renderTransactionList(accountId) {
    // Task 9 で実装する
  }
```

（`render()` 関数内の `openAccountDetail` のスコープに `slot.innerHTML = ...`（明細取込前の仮表示）を含む古い定義があるので、それを丸ごと今回の内容で置き換えること。`renderTransactionList` は Task 9 まで空の関数のままでよい）

- [ ] **Step 3: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/bank.js`
Expected: エラーなく終了する

- [ ] **Step 4: 検証スクリプトを書いて実行する**

まず、作業用ディレクトリに実際のCSVファイルを用意する（Shift_JISで保存し、入金/出金が別列・残高列ありのパターン）:

```bash
cat > /tmp/test_bank.csv.tmp << 'EOF'
日付,摘要,お支払金額,お預り金額,残高
2026/08/01,家主タロウ,148000,,352000
2026/08/05,ノースゲート,,500000,852000
EOF
iconv -f UTF-8 -t SHIFT-JIS /tmp/test_bank.csv.tmp > /tmp/test_bank.csv
rm /tmp/test_bank.csv.tmp
```

`verify_task8.mjs`:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.upsertBankAccount({ name: 'みずほ銀行 普通' });
  await db.persist();
});
await page.reload({ waitUntil: 'networkidle' });
await page.goto(`${BASE}#/bank`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.click('.open-account-btn');
await page.waitForTimeout(300);

await page.setInputFiles('#csv-file-input', '/tmp/test_bank.csv');
await page.waitForTimeout(500);

// 初回なので列マッピングフォームが出るはず
const mappingVisible = await page.evaluate(() => !!document.querySelector('#confirm-mapping-btn'));
console.log('マッピングフォーム表示(true期待):', mappingVisible);

await page.selectOption('#map-date', '0');
await page.selectOption('#map-desc', '1');
await page.selectOption('#map-withdrawal', '2');
await page.selectOption('#map-deposit', '3');
await page.selectOption('#map-balance', '4');
await page.click('#confirm-mapping-btn');
await page.waitForTimeout(500);

const status = await page.evaluate(() => document.querySelector('#import-status')?.textContent);
console.log('取込結果(2件取り込みました、を含む期待):', status);

const stored = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const accounts = db.listBankAccounts();
  return db.listBankTransactions(accounts[0].id);
});
console.log('保存された取引:', JSON.stringify(stored.map((t) => ({ date: t.txn_date, desc: t.description, amount: t.amount, balance: t.balance_after }))));

// 同じファイルを再取込 → 全件スキップされるはず
await page.setInputFiles('#csv-file-input', '/tmp/test_bank.csv');
await page.waitForTimeout(500);
const status2 = await page.evaluate(() => document.querySelector('#import-status')?.textContent);
console.log('再取込結果(0件を取り込みました・2件は既に取込済み、を含む期待):', status2);

console.log('errors:', JSON.stringify(errors));
await browser.close();
```

Expected:
- `mappingVisible` は `true`
- `status` に `"2件を取り込みました"` を含む
- `stored` は2件、1件目 `{"date":"2026-08-01","desc":"家主タロウ","amount":-148000,"balance":352000}`、2件目 `{"date":"2026-08-05","desc":"ノースゲート","amount":500000,"balance":852000}`（Shift_JISが正しくデコードされ、日本語の摘要が文字化けしていないこと）
- `status2` に `"0件を取り込みました"` と `"2件は既に取込済みのためスキップ"` を含む
- `errors` は `[]`

- [ ] **Step 5: コミットする**

```bash
pkill -f "http.server 8900"
rm -f /tmp/test_bank.csv
cd /home/lima.guest/projects/kayley
git add js/views/bank.js
git commit -m "$(cat <<'EOF'
銀行明細機能: CSV取込（列マッピング・重複スキップ・残高検算）を実装

口座ごとに初回だけ列対応を選ぶ方式（銀行別の固定パーサーは書かない）。
文字コード判定・引用符対応のCSV解析・入出金の符号処理・残高列による
検算・フィンガープリントによる再取込時の重複スキップまでを実装した。
Shift_JISのCSVで日本語の摘要が正しく取り込まれることを確認済み。
EOF
)"
```

---

### Task 9: 明細一覧・フィルタ・手動リンク編集・エイリアス自動適用

**Files:**
- Modify: `js/views/bank.js`
- Modify: `css/style.css`

**Interfaces:**
- Consumes: Task 1 の `listBankTransactions` / `listBankTransactionLinks` / `linkBankTransaction` / `unlinkBankTransaction` / `learnBankPayeeAlias`、Task 3 の `officerWithholdingPeriodFor` / `derivePeriodForKind`、既存の `listClients` / `listPaymentSources`（`db.js`）、Task 1 の `IRREGULAR_CATEGORIES`

- [ ] **Step 1: import 文を変更する**

`js/views/bank.js` 先頭の import 文を以下に置き換える。`listPaymentSources` は経費（カード引落）の分類先候補として使う（既存の `js/views/expenses.js` が使っているものと同じ関数。新規のimport追加のみで、`payment_sources` テーブル自体には手を加えない）:

```js
import {
  listBankAccounts, upsertBankAccount, archiveBankAccount, importBankTransactions, applyBankPayeeAliasesToAccount,
  listBankTransactions, listBankTransactionLinks, linkBankTransaction, unlinkBankTransaction, learnBankPayeeAlias,
  officerWithholdingPeriodFor, derivePeriodForKind, IRREGULAR_CATEGORIES, listClients, listPaymentSources,
} from '../db.js';
import { escapeHtml, yen } from '../format.js';
import { decodeCsvBytes, parseCsvText, mapCsvRow, assignOccurrenceIndex, verifyRunningBalance } from '../bankcsv.js';
```

- [ ] **Step 2: モジュール冒頭にフィルタ状態を追加する**

`let openAccountId = null;` の直後に追加する:

```js
let transactionFilter = 'all'; // 'all' | 'unlinked' | 'linked'
```

- [ ] **Step 3: `renderTransactionList` を実装する**

`js/views/bank.js` 内の（Task 8 で空のまま残した）`renderTransactionList` 関数を、以下に置き換える:

```js
  function renderTransactionList(accountId) {
    const slot = container.querySelector('#transaction-list-slot');
    const all = listBankTransactions(accountId);
    const linksByTxn = new Map(all.map((t) => [t.id, listBankTransactionLinks(t.id)]));
    const rows = all.filter((t) => {
      const links = linksByTxn.get(t.id);
      if (transactionFilter === 'unlinked') return links.length === 0;
      if (transactionFilter === 'linked') return links.length > 0;
      return true;
    });
    const clients = listClients({ includeArchived: true });

    slot.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>明細</h2>
          <div class="toolbar">
            <select id="txn-filter">
              <option value="all" ${transactionFilter === 'all' ? 'selected' : ''}>すべて</option>
              <option value="unlinked" ${transactionFilter === 'unlinked' ? 'selected' : ''}>未分類</option>
              <option value="linked" ${transactionFilter === 'linked' ? 'selected' : ''}>裏付け済み</option>
            </select>
          </div>
        </div>
        ${rows.length === 0 ? '<div class="card-note" style="margin:0">明細がありません。</div>' : `
        <table class="ledger">
          <thead><tr><th>日付</th><th>摘要</th><th class="num">金額</th><th>内訳</th></tr></thead>
          <tbody>
            ${rows.map((t) => {
              const links = linksByTxn.get(t.id);
              return `
                <tr data-txn-id="${t.id}">
                  <td>${escapeHtml(t.txn_date)}</td>
                  <td class="desc">${escapeHtml(t.description)}</td>
                  <td class="num">${t.amount >= 0 ? yen(t.amount) : `−${yen(Math.abs(t.amount))}`}</td>
                  <td>${links.length > 0 ? linkSummaryHtml(links[0], clients) : `<button class="btn ghost link-btn" data-id="${t.id}">分類する</button>`}</td>
                </tr>
                <tr class="link-editor-row" data-editor-for="${t.id}" style="display:none"><td colspan="4"></td></tr>
              `;
            }).join('')}
          </tbody>
        </table>
        `}
      </div>
    `;

    slot.querySelector('#txn-filter').addEventListener('change', (e) => {
      transactionFilter = e.target.value;
      renderTransactionList(accountId);
    });

    slot.querySelectorAll('.link-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const txnId = Number(btn.dataset.id);
        openLinkEditor(accountId, txnId, rows.find((r) => r.id === txnId), clients);
      });
    });

    slot.querySelectorAll('.unlink-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        unlinkBankTransaction(Number(btn.dataset.linkId));
        renderTransactionList(accountId);
      });
    });
  }

  function linkSummaryHtml(link, clients) {
    const kindLabel = {
      rent: '家賃', ar: '売掛金', officer_net: '役員報酬（手取り）',
      officer_insurance: '役員報酬（社会保険料）', officer_withholding: '役員報酬（源泉所得税）',
      expense_card: link.category ? `経費（${link.category}の引落）` : '経費（カード引落）',
    }[link.kind] || (link.category || '不定型');
    const clientName = link.kind === 'ar' && link.client_id ? (clients.find((c) => c.id === link.client_id)?.name || '') : '';
    return `<span class="badge good">${escapeHtml(kindLabel)}${clientName ? `・${escapeHtml(clientName)}` : ''}</span> <button class="btn ghost unlink-btn" data-link-id="${link.id}">解除</button>`;
  }

  function openLinkEditor(accountId, txnId, txn, clients) {
    const editorRow = container.querySelector(`tr[data-editor-for="${txnId}"]`);
    if (!editorRow) return;
    const [ty, tm] = txn.txn_date.split('-').map(Number);
    const cell = editorRow.querySelector('td');
    const cards = listPaymentSources({ includeArchived: true }).filter((s) => s.kind === 'card');
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
      cell.querySelector(`#link-category-row-${txnId}`).style.display = kindSelect.value === 'irregular' ? '' : 'none';
      cell.querySelector(`#link-card-row-${txnId}`).style.display = kindSelect.value === 'expense_card' ? '' : 'none';
    };
    kindSelect.addEventListener('change', updateVisibility);
    updateVisibility();

    cell.querySelector(`#link-cancel-${txnId}`).addEventListener('click', () => { editorRow.style.display = 'none'; });

    cell.querySelector(`#link-confirm-${txnId}`).addEventListener('click', () => {
      const kind = kindSelect.value;
      const clientId = kind === 'ar' ? Number(cell.querySelector(`#link-client-${txnId}`).value) : null;
      // category列は irregular のカテゴリ名と expense_card のカード名の両方の置き場として使う
      // （新しい列を増やさず、既存の bank_transaction_links.category をそのまま再利用する）。
      let category = null;
      if (kind === 'irregular') category = cell.querySelector(`#link-category-${txnId}`).value;
      if (kind === 'expense_card') category = cell.querySelector(`#link-card-${txnId}`)?.value || null;
      const period = derivePeriodForKind(kind, ty, tm);
      linkBankTransaction({ bank_transaction_id: txnId, kind, client_id: clientId, category, ...period });
      learnBankPayeeAlias(txn.description, { kind, client_id: clientId, category });
      renderTransactionList(accountId);
    });
  }
```

- [ ] **Step 4: CSSを追加する**

`css/style.css` の `.employer-insurance-block { ... }`（Task 5で追加済み）の直後に追加する:

```css
tr.link-editor-row td { padding: 12px 8px; background: var(--card-raised); }
```

- [ ] **Step 5: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/bank.js`
Expected: エラーなく終了する

- [ ] **Step 6: 検証スクリプトを書いて実行する**

サーバー起動後、`verify_task9.mjs`:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.setMeta('founding_year', 2024); db.setMeta('founding_month', 4);
  const clientId = db.upsertClient({ name: 'ノースゲート' });
  db.upsertArEntry({ client_id: clientId, year: 2026, month: 8, sales: 500000, payment: 480000 });
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [
    { txn_date: '2026-08-20', amount: 480000, description: 'ノースゲート', occurrence: 0 },
    { txn_date: '2026-09-20', amount: 480000, description: 'ノースゲート', occurrence: 0 },
  ]);
  await db.persist();
});
await page.reload({ waitUntil: 'networkidle' });
await page.goto(`${BASE}#/bank`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.click('.open-account-btn');
await page.waitForTimeout(400);

// フィルタ確認
const initialRows = await page.evaluate(() => document.querySelectorAll('#transaction-list-slot tbody tr[data-txn-id]').length);
console.log('取引行数(2件期待):', initialRows);

// 1件目を手動でリンク
await page.click('.link-btn');
await page.waitForTimeout(200);
const firstTxnId = await page.evaluate(() => document.querySelector('tr[data-txn-id]').dataset.txnId);
await page.selectOption(`#link-kind-${firstTxnId}`, 'ar');
const clientRowVisible = await page.evaluate((id) => document.getElementById(`link-client-row-${id}`).style.display !== 'none', firstTxnId);
console.log('得意先選択欄が表示される(true期待):', clientRowVisible);
await page.selectOption(`#link-client-${firstTxnId}`, { index: 0 });
await page.click(`#link-confirm-${firstTxnId}`);
await page.waitForTimeout(400);

const afterLink = await page.evaluate(() => document.querySelector('#transaction-list-slot .badge.good')?.textContent.trim());
console.log('紐付け後のバッジ(売掛金・ノースゲート 期待):', afterLink);

// フィルタ「未分類」→ 残り1件だけ表示されるはず
await page.selectOption('#txn-filter', 'unlinked');
await page.waitForTimeout(300);
const unlinkedRows = await page.evaluate(() => document.querySelectorAll('#transaction-list-slot tbody tr[data-txn-id]').length);
console.log('未分類フィルタ後(1件期待):', unlinkedRows);

// 解除して未分類に戻す
await page.selectOption('#txn-filter', 'all');
await page.waitForTimeout(300);
await page.click('.unlink-btn');
await page.waitForTimeout(300);
const afterUnlink = await page.evaluate(() => document.querySelectorAll('#transaction-list-slot .link-btn').length);
console.log('解除後の未分類ボタン数(2件期待):', afterUnlink);

// 売掛金タブのバッジも更新されているか（unlinkしたので未照合寄りに戻る）
await page.goto(`${BASE}#/ar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const arBadge = await page.evaluate(() => document.querySelector('#ar-table-slot .bank-badge')?.textContent.trim());
console.log('売掛金タブのバッジ(銀行未照合期待):', arBadge);

console.log('errors:', JSON.stringify(errors));
await browser.close();
```

Expected:
- `initialRows` は `2`
- `clientRowVisible` は `true`
- `afterLink` に `"売掛金"` と `"ノースゲート"` を含む
- `unlinkedRows` は `1`
- `afterUnlink` は `2`
- `arBadge` は `"銀行未照合"`
- `errors` は `[]`

- [ ] **Step 7: コミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/views/bank.js css/style.css
git commit -m "$(cat <<'EOF'
銀行明細機能: 明細一覧・フィルタ・手動リンク編集を実装

明細ごとに「分類する」から裏付け先（家賃/売掛金/役員報酬3種/不定型）を
選んで確定できるようにした。確定すると振込名義を学習し、次回の取込・
既存の未分類取引に自動で適用される。フィルタ（すべて/未分類/裏付け済み）
と解除も実装。これで銀行明細機能の主要な操作が一通り揃った。
EOF
)"
```

---

### Task 10: 全体回帰検証

**Files:** なし（検証のみ）

**Interfaces:** Consumes: Task 1〜9 で実装した全機能

- [ ] **Step 1: 全ファイルの構文チェックを一括で行う**

```bash
cd /home/lima.guest/projects/kayley
for f in js/db.js js/bankcsv.js js/bankbadge.js js/views/bank.js js/app.js js/views/rent.js js/views/officerpay.js js/views/ar.js; do
  node --check "$f" && echo "OK $f"
done
```

Expected: 8ファイル全てで `OK` と表示される

- [ ] **Step 2: 全8タブの回帰検証スクリプトを書いて実行する**

サーバー起動後、`verify_task10.mjs`:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.setMeta('company_name', '株式会社あららんど');
  db.setMeta('founding_year', 2024); db.setMeta('founding_month', 4);
  const clientId = db.upsertClient({ name: 'ノースゲート' });
  db.upsertArEntry({ client_id: clientId, year: 2026, month: 8, sales: 500000, payment: 480000 });
  db.upsertRentUtilityEntry({ year: 2026, month: 8, rent_total: 148000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40 });
  db.upsertOfficerPayEntry({ year: 2026, month: 8, gross_pay: 600000, health_insurance: 29520, nursing_care_insurance: 5340, pension: 54900, child_support_levy: 2196, withholding_tax: 42400, employer_insurance_total: 217722, use_auto_deduction: 1 });
  const cardId = db.upsertPaymentSource({ name: 'カードA', kind: 'card' });
  db.addStatementTransaction({ source_id: cardId, year: 2026, month: 8, txn_date: '2026-08-01', description: 'テスト', amount: 1000, account_title: '通信費' });
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [
    { txn_date: '2026-08-20', amount: 480000, description: 'ノースゲート', occurrence: 0 },
    { txn_date: '2026-08-27', amount: -148000, description: '家主タロウ', occurrence: 0 },
  ]);
  await db.persist();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const tabs = ['dashboard', 'ar', 'rent', 'officer', 'expenses', 'report', 'bank', 'settings'];
for (const t of tabs) {
  await page.goto(`${BASE}#/${t}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const hasContent = await page.evaluate(() => document.getElementById('view-root').children.length > 0);
  console.log(t, 'レンダリングされた:', hasContent);
}

// Drive未接続でも銀行タブが壊れないか
await page.goto(`${BASE}#/bank`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const bankOk = await page.evaluate(() => !!document.querySelector('#account-list-slot'));
console.log('銀行タブ(Drive未接続):', bankOk);

console.log('errors:', JSON.stringify(errors));
await browser.close();
```

Expected:
- 8タブすべてで `レンダリングされた: true`
- `bankOk` は `true`
- `errors` は `[]`

- [ ] **Step 3: エラーがあれば該当タスクに戻って修正し、無ければ完了**

このタスクはコード変更を含まないため、コミットは不要（Task 1〜9 のコミットで完結している）。

```bash
pkill -f "http.server 8900"
```
