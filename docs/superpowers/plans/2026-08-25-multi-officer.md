# 複数役員対応 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 役員報酬タブが「1ヶ月につき1人分」専用だった構造を、複数の役員（代表者・お母様など）をそれぞれ独立して登録・月次入力・銀行照合できるように拡張する。

**Architecture:** 新規`officers`テーブルを`clients`と同じ設計パターンで追加し、`officer_pay_entries`に`officer_id`列を追加して役員ごとの給与データにする。社会保険料合計（`employer_insurance_total`）は会社全体で1本の値という実態に合わせて`rent_utility_entries`に移す。役員報酬タブ（`officerpay.js`）に役員一覧・切り替えUIを追加し、既存の給与明細セクションは選択中の役員に対して動作させる。ダッシュボード・月次レポートは全役員の合計値を表示する。

**Tech Stack:** ビルド無しの素のES modules。sql.js（既存）。動作確認はPlaywright（`chromium.launch()`）による手動駆動スクリプト。自動テストフレームワーク（jest/pytest等）はこのプロジェクトに存在しないため導入しない。

**Spec:** `docs/superpowers/specs/2026-08-25-multi-officer-design.md`

## Global Constraints

- 銀行データは既存4タブのテーブルに書き込まない（`bank_transaction_links`への`officer_id`追加は裏付けリンクの拡張であり、この原則には反しない）
- npmパッケージを追加しない。ビルド無しの素のESモジュール構成を維持する
- 社会保険料合計（`employer_insurance_total`）・源泉所得税の半期納付は会社全体で1つの月次数値のまま（役員ごとに分けない）。給与本体（総支給・控除・手取り）だけを役員ごとに分ける
- `officer_pay_entries`のSQLite `UNIQUE(year, month)`制約はALTERで変更しない。一意性（1役員1ヶ月1行）はアプリケーション層（`upsertOfficerPayEntry`）で担保する
- 既存ユーザーのDBへの影響は`migrateColumns()`経由の列追加＋新設`migrateOfficers()`の一度きりのデータ移行のみで吸収する。新規インストール（既存データが無い）では「代表者」を自動作成しない
- 各タスクの完了条件は「`node --check`が全対象ファイルで通ること」「Playwrightによる検証スクリプトが期待通りの結果を出すこと（コンソールエラー0件）」

---

## ファイル構成

**変更のみ（新規ファイル無し）:**
- `js/db.js` — `officers`テーブル追加、`officer_pay_entries`/`rent_utility_entries`/`bank_transaction_links`への列追加、CRUD関数の追加・シグネチャ変更、裏付け判定ロジックの更新、移行処理
- `js/views/bank.js` — 分類フォームの`officer_net`選択時に役員選択プルダウンを表示、`linkSummaryHtml`の役員名表示
- `js/views/officerpay.js` — 役員一覧・切り替えUIの追加、給与明細セクションの役員スコープ化、`employer_insurance_total`の参照先変更
- `js/views/dashboard.js` — 手取り額表示を全役員合計に変更
- `js/views/report.js` — 役員報酬関連の表示・累計を全役員合計に変更

---

## 検証方法についての共通ルール

このプロジェクトには自動テストフレームワークが存在しない。これまでの開発と同じ方式で検証する:

1. **構文チェック**: 変更した全`.js`ファイルで`node --check <file>`を実行する
2. **ブラウザ検証**: プロジェクトルートで`python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley`を起動し、Playwright（`chromium.launch()`）で開いて、`page.evaluate()`内で`await import('/js/db.js')`してデータを直接投入し、DOM・コンソールエラーを確認する。検証スクリプトは作業用ディレクトリに置き、リポジトリにはコミットしない
3. `migrateOfficers()`の「既存データがある場合の移行」分岐（`legacyCount > 0`）は、既存の`ensureColumn`/`migrateColumns`と同じ理由で専用の単体テストを書かない — この関数群はDB内部の生SQLで直接状態を作らないと再現できず、公開APIの外側の話になるため。新規インストール（`legacyCount === 0`で即returnする分岐）は各タスクのPlaywright検証で毎回自然にカバーされる
4. 各タスクの最後に`git add` → `git commit`する。コミットメッセージは日本語、既存コミットと同じ粒度（1〜2行の要約＋箇条書きの本文）
5. **既知の過渡的な状態**: Task 2〜6の間は、`officerpay.js`/`dashboard.js`/`report.js`がまだ新しい`getOfficerPayEntry(officerId, year, month)`シグネチャに追随していない（Task 5〜7で対応する）。これらのファイル自身のタブ（役員報酬・ダッシュボード・月次レポート）を開くと、コンソールに`Wrong API use : tried to bind a value of an unknown type (undefined).`という警告が出る。これは既知・想定内の過渡的な症状であり、Task 2〜6の検証スクリプトで`errors`をチェックする際はこの特定のメッセージだけは許容する（他の新しいエラーが混ざっていないかだけ確認する）。Task 7完了後の全体回帰検証（Task 8）では、この警告も含めて`errors`が`[]`になっていることを確認する。

   **Task 4実行中に追加で発覚した重要な点**: `db.js`内の`getSectionCompletion()`（`app.js`の`renderProgressSpine()`から**どのタブに遷移しても必ず呼ばれる**）も`getOfficerPayEntry(year, month)`を旧シグネチャのまま呼んでいた。これはTask 2のインターフェース一覧に載せ忘れていた呼び出し箇所で、`renderProgressSpine()`はどのタブの`render()`よりも先に実行されるため、これを直さない限り**銀行タブを含む全タブが真っ白になる**（見た目上の警告どころか、そのタブ自身は無関係でもレンダリングが止まる）。Task 3完了時点でこれに気づき、`officerDone`を「登録済みの全役員が当月分の入力を持っているか」で判定するように直接修正済み（コミット`f12cd76`に含まれる）。次にこの計画を最初から実行する人は、Task 2の完了条件に「`db.js`内で`getOfficerPayEntry`/`resolveOfficerDeductions`を呼んでいる箇所を`grep -rn`で全て洗い出し、`getSectionCompletion()`も含めて全て新シグネチャに追随させる」を追加しておくとよい。

---

### Task 1: `officers`テーブル・CRUD・移行処理

**Files:**
- Modify: `js/db.js`

**Interfaces:**
- Produces:
  - `export function listOfficers({ includeArchived = false } = {})` → 配列
  - `export function getOfficer(id)` → 行または`null`
  - `export function upsertOfficer(officer)` → id（`officer`は`{ id?, name, sort_order?, home_office_deduction }`）
  - `export function archiveOfficer(id, archived = 1)`
  - `officers`テーブル（列: `id, name, sort_order, archived, home_office_deduction`）
  - `officer_pay_entries.officer_id`列（`ensureColumn`経由）
  - `rent_utility_entries.employer_insurance_total`列（`ensureColumn`経由）
  - `bank_transaction_links.officer_id`列（`ensureColumn`経由）

- [ ] **Step 1: スキーマに`officers`テーブルを追加する**

`js/db.js`の`SCHEMA`定数内、`CREATE TABLE IF NOT EXISTS officer_pay_entries`の直前（`rent_utility_entries`の直後）に追加する:

```sql
CREATE TABLE IF NOT EXISTS officers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  home_office_deduction INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 2: `migrateColumns()`に列追加を足す**

`js/db.js`の`migrateColumns()`関数内、`ensureColumn('officer_pay_entries', 'employer_insurance_total', 'INTEGER');`の直後に追加する:

```js
  ensureColumn('officer_pay_entries', 'officer_id', 'INTEGER');
  ensureColumn('rent_utility_entries', 'employer_insurance_total', 'INTEGER');
  ensureColumn('bank_transaction_links', 'officer_id', 'INTEGER REFERENCES officers(id)');
```

- [ ] **Step 3: `migrateOfficers()`を追加する**

`migrateColumns()`関数の直後（`export async function openDatabase()`の直前）に追加する:

```js
// 既存の officer_pay_entries（officer_id が無かった旧データ）を「代表者」役員に紐づけ、
// employer_insurance_total（会社全体の値）を rent_utility_entries へ複製する。
// 一度移行が終われば legacyCount は常に0になるので、毎回呼んでも安全（ensureColumnと同じ設計）。
// 新規インストール（officer_pay_entries が空）では「代表者」を自動作成しない。
function migrateOfficers() {
  const legacyCount = one('SELECT COUNT(*) AS n FROM officer_pay_entries WHERE officer_id IS NULL').n;
  if (legacyCount === 0) return;

  const officerCount = one('SELECT COUNT(*) AS n FROM officers').n;
  let primaryId;
  if (officerCount === 0) {
    run('INSERT INTO officers (name, sort_order, archived, home_office_deduction) VALUES (?, 0, 0, 1)', ['代表者']);
    primaryId = one('SELECT last_insert_rowid() AS id').id;
  } else {
    primaryId = one('SELECT id FROM officers ORDER BY sort_order, id LIMIT 1').id;
  }

  run('UPDATE officer_pay_entries SET officer_id=? WHERE officer_id IS NULL', [primaryId]);

  all(
    'SELECT year, month, employer_insurance_total FROM officer_pay_entries WHERE officer_id=? AND employer_insurance_total IS NOT NULL AND employer_insurance_total != 0',
    [primaryId]
  ).forEach((row) => {
    const existing = getRentUtilityEntry(row.year, row.month);
    if (existing) {
      run('UPDATE rent_utility_entries SET employer_insurance_total=? WHERE year=? AND month=?', [row.employer_insurance_total, row.year, row.month]);
    } else {
      run('INSERT INTO rent_utility_entries (year, month, employer_insurance_total) VALUES (?, ?, ?)', [row.year, row.month, row.employer_insurance_total]);
    }
  });
}
```

`run`/`one`/`all`は`js/db.js`内でこの位置より後で定義されているが、関数宣言のホイスティングによりこの位置から呼び出して問題ない（同ファイル内の他の箇所も同じ前提で書かれている）。`getRentUtilityEntry`も同様に後方で定義済みの関数。

- [ ] **Step 4: `openDatabase()`と`importBytes()`の両方から`migrateOfficers()`を呼ぶ**

`js/db.js`内、`migrateColumns();`という行が2箇所ある（`openDatabase()`内と`importBytes()`内）。両方とも、その直後に`migrateOfficers();`を追加する。

- [ ] **Step 5: `officers`のCRUD関数を追加する**

`export function archiveClient`の直後など、`clients`のCRUD関数群の近くに追加する:

```js
export function listOfficers({ includeArchived = false } = {}) {
  return includeArchived
    ? all('SELECT * FROM officers ORDER BY sort_order, id')
    : all('SELECT * FROM officers WHERE archived=0 ORDER BY sort_order, id');
}

export function getOfficer(id) {
  return one('SELECT * FROM officers WHERE id=?', [id]);
}

export function upsertOfficer(officer) {
  if (officer.id) {
    run(
      'UPDATE officers SET name=?, home_office_deduction=? WHERE id=?',
      [officer.name, officer.home_office_deduction ? 1 : 0, officer.id]
    );
    return officer.id;
  }
  run(
    'INSERT INTO officers (name, sort_order, archived, home_office_deduction) VALUES (?, ?, 0, ?)',
    [officer.name, officer.sort_order || 0, officer.home_office_deduction ? 1 : 0]
  );
  return one('SELECT last_insert_rowid() AS id').id;
}

export function archiveOfficer(id, archived = 1) {
  run('UPDATE officers SET archived=? WHERE id=?', [archived ? 1 : 0, id]);
}
```

- [ ] **【実行時に発覚し追加された】Step 5.5: `officer_pay_entries`の旧UNIQUE制約を作り直す**

実行中、Step 2の`ensureColumn`だけでは不十分なことが判明した: 旧スキーマの`officer_pay_entries`は`UNIQUE(year, month)`制約を持っており、これが残っていると`officer_id`の値に関わらず「同じ年月の行は1件だけ」という制約が効いてしまい、複数役員分の行を同じ月に insert できない（`upsertOfficerPayEntry`をアプリケーション層で書き換えただけでは、SQLite側の古い制約が先に弾く）。`ALTER TABLE`では既存のUNIQUE制約を外せないため、テーブルを作り直して移す必要がある。

`SCHEMA`定数内の`officer_pay_entries`テーブル定義を以下に置き換える（`officer_id`列を追加し、`UNIQUE(year, month)`を`UNIQUE(officer_id, year, month)`に変える。新規インストールはこれで正しく作られる）:

```sql
CREATE TABLE IF NOT EXISTS officer_pay_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  officer_id INTEGER,
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
  employer_insurance_total INTEGER,
  note TEXT,
  UNIQUE(officer_id, year, month)
);
```

既存ユーザーのDB（テーブルが既に古い制約で作られている）向けに、`migrateColumns()`の直後・`migrateOfficers()`の直前に呼ぶ新しい移行関数を追加する:

```js
// 旧スキーマの officer_pay_entries は UNIQUE(year, month) 制約を持っており、
// これが残っていると officer_id の値に関わらず「同じ年月の行は1件だけ」という
// 制約が効いてしまい、複数役員分の行を同じ月に insert できない。
// ALTER TABLE では既存のUNIQUE制約を外せないため、テーブルを作り直して移す。
// 既に新しい制約（UNIQUE(officer_id, year, month)）になっていれば何もしない
// （sqlite_master の定義文を見て判定するので、何度呼んでも安全）。
function migrateOfficerPayEntriesConstraint() {
  const row = one("SELECT sql FROM sqlite_master WHERE type='table' AND name='officer_pay_entries'");
  if (!row || !row.sql || !row.sql.includes('UNIQUE(year, month)')) return;
  run('ALTER TABLE officer_pay_entries RENAME TO officer_pay_entries_old');
  run(`CREATE TABLE officer_pay_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    officer_id INTEGER,
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
    employer_insurance_total INTEGER,
    note TEXT,
    UNIQUE(officer_id, year, month)
  )`);
  run(`INSERT INTO officer_pay_entries
         (id, officer_id, year, month, gross_pay, health_insurance, nursing_care_insurance, pension,
          child_support_levy, withholding_tax, use_auto_deduction, manual_rent_deduction,
          manual_utility_deduction, employer_insurance_total, note)
       SELECT id, officer_id, year, month, gross_pay, health_insurance, nursing_care_insurance, pension,
              child_support_levy, withholding_tax, use_auto_deduction, manual_rent_deduction,
              manual_utility_deduction, employer_insurance_total, note
       FROM officer_pay_entries_old`);
  run('DROP TABLE officer_pay_entries_old');
}
```

（すでに`062b036`のコミットで適用済み。次にこのタスクを実行する人は、この修正が反映された状態から始める。）

- [ ] **Step 6: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js`
Expected: エラーなく終了する

- [ ] **Step 7: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task1.mjs`として保存する:

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
  const before = db.listOfficers({ includeArchived: true });
  const daichiId = db.upsertOfficer({ name: '荒木大地', home_office_deduction: true });
  const michikoId = db.upsertOfficer({ name: '荒木道子', home_office_deduction: false });
  const listed = db.listOfficers();
  db.upsertOfficer({ id: michikoId, name: '荒木道子（改姓）', home_office_deduction: false });
  const afterRename = db.getOfficer(michikoId);
  db.archiveOfficer(michikoId, 1);
  const afterArchive = db.listOfficers();
  const withArchived = db.listOfficers({ includeArchived: true });
  return {
    beforeCount: before.length,
    listedCount: listed.length,
    daichiHomeOffice: db.getOfficer(daichiId).home_office_deduction,
    afterRenameName: afterRename.name,
    afterArchiveCount: afterArchive.length,
    withArchivedCount: withArchived.length,
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
- `beforeCount`は`0`（新規インストールでは「代表者」を自動作成しないため）
- `listedCount`は`2`
- `daichiHomeOffice`は`1`
- `afterRenameName`は`"荒木道子（改姓）"`
- `afterArchiveCount`は`1`（道子を休止したので大地のみ）
- `withArchivedCount`は`2`
- `errors`は`[]`

- [ ] **Step 8: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js
git commit -m "$(cat <<'EOF'
複数役員対応: officersテーブル・CRUD・移行処理を追加

役員報酬タブが1ヶ月1人分専用だった構造を複数役員対応にするための土台。
officer_pay_entries/rent_utility_entries/bank_transaction_links に
officer_id・employer_insurance_total 列を追加し、既存データは
「代表者」役員へ自動的に紐づける移行処理を用意した。
EOF
)"
```

---

### Task 2: `officer_pay_entries`関連関数の役員スコープ化

**Files:**
- Modify: `js/db.js`

**Interfaces:**
- Consumes: Task 1の`getOfficer`
- Produces:
  - `export function getOfficerPayEntry(officerId, year, month)`（シグネチャ変更: 第1引数`officerId`を追加）
  - `export function listOfficerPayEntries(year, month)` → 配列（新規、全役員分）
  - `export function findPreviousOfficerPayEntry(officerId, year, month)`（シグネチャ変更）
  - `export function upsertOfficerPayEntry(e)`（`e`に`officer_id`が必須。`employer_insurance_total`は扱わなくなる）
  - `export function resolveOfficerDeductions(officerId, year, month)`（シグネチャ変更）

- [ ] **Step 1: `getOfficerPayEntry`・`listOfficerPayEntries`・`findPreviousOfficerPayEntry`を書き換える**

既存の`export function getOfficerPayEntry(year, month)`を丸ごと以下に置き換える:

```js
export function getOfficerPayEntry(officerId, year, month) {
  return one('SELECT * FROM officer_pay_entries WHERE officer_id=? AND year=? AND month=?', [officerId, year, month]);
}

// 指定月に存在する全役員分のエントリ（ダッシュボード・月次レポートの合計表示、
// 源泉所得税の全役員合算に使う）。
export function listOfficerPayEntries(year, month) {
  return all('SELECT * FROM officer_pay_entries WHERE year=? AND month=?', [year, month]);
}
```

既存の`export function findPreviousOfficerPayEntry(year, month)`を丸ごと以下に置き換える:

```js
export function findPreviousOfficerPayEntry(officerId, year, month) {
  let target = { year, month };
  for (let i = 0; i < 24; i++) {
    target = prevMonth(target.year, target.month);
    const entry = getOfficerPayEntry(officerId, target.year, target.month);
    if (entry) return { entry, year: target.year, month: target.month };
  }
  return null;
}
```

- [ ] **Step 2: `upsertOfficerPayEntry`を書き換える**

既存の`export function upsertOfficerPayEntry(e)`（`ON CONFLICT(year, month)`を使うINSERT文）を丸ごと以下に置き換える:

```js
export function upsertOfficerPayEntry(e) {
  const existing = getOfficerPayEntry(e.officer_id, e.year, e.month);
  if (existing) {
    run(
      `UPDATE officer_pay_entries SET
         gross_pay=?, health_insurance=?, nursing_care_insurance=?, pension=?,
         child_support_levy=?, withholding_tax=?, use_auto_deduction=?,
         manual_rent_deduction=?, manual_utility_deduction=?, note=?
       WHERE id=?`,
      [e.gross_pay || 0, e.health_insurance || 0, e.nursing_care_insurance || 0,
       e.pension || 0, e.child_support_levy || 0, e.withholding_tax || 0,
       e.use_auto_deduction ? 1 : 0, e.manual_rent_deduction || 0, e.manual_utility_deduction || 0,
       e.note || null, existing.id]
    );
    return existing.id;
  }
  run(
    `INSERT INTO officer_pay_entries
       (officer_id, year, month, gross_pay, health_insurance, nursing_care_insurance, pension,
        child_support_levy, withholding_tax, use_auto_deduction, manual_rent_deduction,
        manual_utility_deduction, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.officer_id, e.year, e.month, e.gross_pay || 0, e.health_insurance || 0, e.nursing_care_insurance || 0,
     e.pension || 0, e.child_support_levy || 0, e.withholding_tax || 0,
     e.use_auto_deduction ? 1 : 0, e.manual_rent_deduction || 0, e.manual_utility_deduction || 0, e.note || null]
  );
  return one('SELECT last_insert_rowid() AS id').id;
}
```

`employer_insurance_total`はこの関数の入出力から完全に削除する。

- [ ] **Step 3: `resolveOfficerDeductions`を書き換える**

既存の`export function resolveOfficerDeductions(year, month)`を丸ごと以下に置き換える:

```js
export function resolveOfficerDeductions(officerId, year, month) {
  const officer = getOfficer(officerId);
  if (!officer || !officer.home_office_deduction) {
    return { rent_deduction: 0, utility_deduction: 0, auto_rent: 0, auto_utility: 0, source_year: null, source_month: null, has_source: false };
  }
  const entry = getOfficerPayEntry(officerId, year, month);
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
```

- [ ] **Step 4: `upsertRentUtilityEntry`に`employer_insurance_total`を追加する**

既存の`export function upsertRentUtilityEntry(e)`を丸ごと以下に置き換える:

```js
export function upsertRentUtilityEntry(e) {
  run(
    `INSERT INTO rent_utility_entries
       (year, month, rent_total, rent_personal_fixed, water_total, water_personal_pct,
        gas_total, gas_personal_pct, electricity_total, electricity_personal_pct, employer_insurance_total, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET
       rent_total=excluded.rent_total,
       rent_personal_fixed=excluded.rent_personal_fixed,
       water_total=excluded.water_total,
       water_personal_pct=excluded.water_personal_pct,
       gas_total=excluded.gas_total,
       gas_personal_pct=excluded.gas_personal_pct,
       electricity_total=excluded.electricity_total,
       electricity_personal_pct=excluded.electricity_personal_pct,
       employer_insurance_total=excluded.employer_insurance_total,
       note=excluded.note`,
    [e.year, e.month, e.rent_total || 0, e.rent_personal_fixed || 0,
     e.water_total || 0, e.water_personal_pct ?? 40,
     e.gas_total || 0, e.gas_personal_pct ?? 40,
     e.electricity_total || 0, e.electricity_personal_pct ?? 40,
     e.employer_insurance_total || 0, e.note || null]
  );
}
```

- [ ] **Step 5: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js`
Expected: エラーなく終了する

- [ ] **Step 6: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task2.mjs`として保存する:

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
  const daichiId = db.upsertOfficer({ name: '荒木大地', home_office_deduction: true });
  const michikoId = db.upsertOfficer({ name: '荒木道子', home_office_deduction: false });

  db.upsertRentUtilityEntry({ year: 2026, month: 7, rent_total: 148000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40 });

  db.upsertOfficerPayEntry({ officer_id: daichiId, year: 2026, month: 8, gross_pay: 600000, health_insurance: 29520, nursing_care_insurance: 5340, pension: 54900, child_support_levy: 2196, withholding_tax: 42400, use_auto_deduction: 1 });
  db.upsertOfficerPayEntry({ officer_id: michikoId, year: 2026, month: 8, gross_pay: 100000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 3063, use_auto_deduction: 0, manual_rent_deduction: 0, manual_utility_deduction: 0 });

  const daichiEntry = db.getOfficerPayEntry(daichiId, 2026, 8);
  const michikoEntry = db.getOfficerPayEntry(michikoId, 2026, 8);
  const both = db.listOfficerPayEntries(2026, 8);

  const daichiDeductions = db.resolveOfficerDeductions(daichiId, 2026, 8);
  const michikoDeductions = db.resolveOfficerDeductions(michikoId, 2026, 8);

  db.upsertRentUtilityEntry({ year: 2026, month: 8, rent_total: 148000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40, employer_insurance_total: 217722 });
  const rentEntry = db.getRentUtilityEntry(2026, 8);

  // 同じ役員・同じ月への2回目のupsertはUPDATEになり、行数が増えないことを確認
  db.upsertOfficerPayEntry({ officer_id: daichiId, year: 2026, month: 8, gross_pay: 610000, health_insurance: 29520, nursing_care_insurance: 5340, pension: 54900, child_support_levy: 2196, withholding_tax: 42400, use_auto_deduction: 1 });
  const afterUpdate = db.listOfficerPayEntries(2026, 8);

  return {
    daichiGross: daichiEntry.gross_pay,
    michikoGross: michikoEntry.gross_pay,
    bothCount: both.length,
    daichiRentDeduction: daichiDeductions.rent_deduction,
    michikoRentDeduction: michikoDeductions.rent_deduction,
    rentEmployerInsurance: rentEntry.employer_insurance_total,
    afterUpdateCount: afterUpdate.length,
    afterUpdateDaichiGross: afterUpdate.find((e) => e.officer_id === daichiId).gross_pay,
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
node verify_task2.mjs
```

Expected:
- `daichiGross`は`600000`、`michikoGross`は`100000`
- `bothCount`は`2`
- `daichiRentDeduction`は`44400`（前月分の`rent_personal_fixed`が自動反映、`home_office_deduction`がtrueなので）
- `michikoRentDeduction`は`0`（`home_office_deduction`がfalseなので常にゼロ）
- `rentEmployerInsurance`は`217722`
- `afterUpdateCount`は`2`（UPDATEされただけで行数は増えない）
- `afterUpdateDaichiGross`は`610000`
- `errors`は`[]`

- [ ] **Step 7: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js
git commit -m "$(cat <<'EOF'
複数役員対応: officer_pay_entries関連関数を役員スコープ化

getOfficerPayEntry/findPreviousOfficerPayEntry/upsertOfficerPayEntry/
resolveOfficerDeductions に officerId を追加し、1役員1ヶ月1行を
アプリケーション層で担保するようにした。employer_insurance_total は
upsertOfficerPayEntry から外し、rent_utility_entries 側に統一。
resolveOfficerDeductions は home_office_deduction が無い役員には
常にゼロを返す（自宅事務所の家賃按分は役員によって要不要が分かれるため）。
EOF
)"
```

---

### Task 3: 裏付け判定ロジックの更新

**Files:**
- Modify: `js/db.js`

**Interfaces:**
- Consumes: Task 1の`officers`テーブル、Task 2の`getOfficerPayEntry`/`listOfficerPayEntries`/`resolveOfficerDeductions`
- Produces:
  - `export function sumLinkedBankAmount({ kind, client_id, officer_id, year, month })`（シグネチャ変更: `officer_id`条件を追加）
  - `export function linkBankTransaction({ bank_transaction_id, kind, client_id, officer_id, category, period_start_year, period_start_month, period_end_year, period_end_month, note })`（シグネチャ変更: `officer_id`を追加）
  - `export function computeOfficerNetBackingStatus(officerId, year, month)`（シグネチャ変更）
  - `export function computeOfficerInsuranceBackingStatus(year, month)`（シグネチャ変更なし。参照元だけ変わる）
  - `export function computeOfficerWithholdingBackingStatus(year, month)`（シグネチャ変更なし。参照元だけ変わる）

- [ ] **Step 1: `sumLinkedBankAmount`に`officer_id`条件を追加する**

既存の`export function sumLinkedBankAmount({ kind, client_id, year, month })`を丸ごと以下に置き換える:

```js
export function sumLinkedBankAmount({ kind, client_id, officer_id, year, month }) {
  const conditions = ['l.kind=?', 'l.period_start_year=?', 'l.period_start_month=?'];
  const params = [kind, year, month];
  if (client_id != null) { conditions.push('l.client_id=?'); params.push(client_id); }
  if (officer_id != null) { conditions.push('l.officer_id=?'); params.push(officer_id); }
  const row = one(
    `SELECT COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS count
     FROM bank_transaction_links l JOIN bank_transactions t ON t.id = l.bank_transaction_id
     WHERE ${conditions.join(' AND ')}`,
    params
  );
  return { total: row.total, count: row.count };
}
```

- [ ] **Step 2: `linkBankTransaction`に`officer_id`を追加する**

既存の`export function linkBankTransaction({...})`を丸ごと以下に置き換える:

```js
export function linkBankTransaction({
  bank_transaction_id, kind, client_id, officer_id, category,
  period_start_year, period_start_month, period_end_year, period_end_month, note,
}) {
  run(
    `INSERT INTO bank_transaction_links
       (bank_transaction_id, kind, client_id, officer_id, category, period_start_year, period_start_month, period_end_year, period_end_month, note, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bank_transaction_id, kind, client_id || null, officer_id || null, category || null,
     period_start_year || null, period_start_month || null, period_end_year || null, period_end_month || null,
     note || null, new Date().toISOString()]
  );
  return one('SELECT last_insert_rowid() AS id').id;
}
```

- [ ] **Step 3: `computeOfficerNetBackingStatus`に`officerId`を追加する**

既存の`export function computeOfficerNetBackingStatus(year, month)`を丸ごと以下に置き換える:

```js
export function computeOfficerNetBackingStatus(officerId, year, month) {
  const entry = getOfficerPayEntry(officerId, year, month);
  if (!entry) return { status: 'none', bankAmount: 0, expectedTotal: 0, count: 0 };
  const deductions = resolveOfficerDeductions(officerId, year, month);
  const deductionTotal = ['health_insurance', 'nursing_care_insurance', 'pension', 'child_support_levy', 'withholding_tax']
    .reduce((a, k) => a + (entry[k] || 0), 0) + deductions.rent_deduction + deductions.utility_deduction;
  const expectedTotal = entry.gross_pay - deductionTotal;
  const { total: bankTotal, count } = sumLinkedBankAmount({ kind: 'officer_net', officer_id: officerId, year, month });
  if (count === 0) return { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
  const bankAmount = Math.abs(bankTotal);
  return { status: bankAmount === expectedTotal ? 'matched' : 'mismatch', bankAmount, expectedTotal, count };
}
```

- [ ] **Step 4: `computeOfficerInsuranceBackingStatus`の参照元を`rent_utility_entries`に変える**

既存の`export function computeOfficerInsuranceBackingStatus(year, month)`を丸ごと以下に置き換える:

```js
export function computeOfficerInsuranceBackingStatus(year, month) {
  const entry = getRentUtilityEntry(year, month);
  const expectedTotal = entry ? (entry.employer_insurance_total || 0) : 0;
  const { total: bankTotal, count } = sumLinkedBankAmount({ kind: 'officer_insurance', year, month });
  if (count === 0) return { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
  const bankAmount = Math.abs(bankTotal);
  return { status: bankAmount === expectedTotal ? 'matched' : 'mismatch', bankAmount, expectedTotal, count };
}
```

- [ ] **Step 5: `computeOfficerWithholdingBackingStatus`を全役員合算に変える**

既存の`export function computeOfficerWithholdingBackingStatus(year, month)`内の以下の行:

```js
    const e = getOfficerPayEntry(cursor.year, cursor.month);
    if (e) expectedTotal += e.withholding_tax || 0;
```

を、以下に置き換える:

```js
    listOfficerPayEntries(cursor.year, cursor.month).forEach((e) => { expectedTotal += e.withholding_tax || 0; });
```

- [ ] **Step 6: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js`
Expected: エラーなく終了する

- [ ] **Step 7: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task3.mjs`として保存する:

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
  const daichiId = db.upsertOfficer({ name: '荒木大地', home_office_deduction: true });
  const michikoId = db.upsertOfficer({ name: '荒木道子', home_office_deduction: false });

  db.upsertOfficerPayEntry({ officer_id: daichiId, year: 2026, month: 8, gross_pay: 600000, health_insurance: 29520, nursing_care_insurance: 5340, pension: 54900, child_support_levy: 2196, withholding_tax: 42400, use_auto_deduction: 1 });
  db.upsertOfficerPayEntry({ officer_id: michikoId, year: 2026, month: 8, gross_pay: 100000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 3063, use_auto_deduction: 1 });

  const daichiNetExpected = 600000 - (29520 + 5340 + 54900 + 2196 + 42400);
  const michikoNetExpected = 100000 - 3063;

  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [
    { txn_date: '2026-08-20', amount: -daichiNetExpected, description: 'インターネット アラキ ダイチ', occurrence: 0 },
    { txn_date: '2026-08-21', amount: -michikoNetExpected, description: 'インターネット アラキ ミチコ', occurrence: 0 },
  ]);
  const txns = db.listBankTransactions(accountId);
  db.linkBankTransaction({ bank_transaction_id: txns[0].id, kind: 'officer_net', officer_id: daichiId, period_start_year: 2026, period_start_month: 8, period_end_year: 2026, period_end_month: 8 });
  db.linkBankTransaction({ bank_transaction_id: txns[1].id, kind: 'officer_net', officer_id: michikoId, period_start_year: 2026, period_start_month: 8, period_end_year: 2026, period_end_month: 8 });

  const daichiStatus = db.computeOfficerNetBackingStatus(daichiId, 2026, 8);
  const michikoStatus = db.computeOfficerNetBackingStatus(michikoId, 2026, 8);

  db.upsertRentUtilityEntry({ year: 2026, month: 8, rent_total: 148000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40, employer_insurance_total: 217722 });
  const insuranceStatusNone = db.computeOfficerInsuranceBackingStatus(2026, 8);

  // 源泉所得税: 1月・7月にだけ判定がある。2026-07は両役員分を合算した額と一致させる
  db.upsertOfficerPayEntry({ officer_id: daichiId, year: 2026, month: 1, gross_pay: 600000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 42400, use_auto_deduction: 1 });
  db.upsertOfficerPayEntry({ officer_id: michikoId, year: 2026, month: 1, gross_pay: 100000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 3063, use_auto_deduction: 1 });
  for (let m = 2; m <= 6; m++) {
    db.upsertOfficerPayEntry({ officer_id: daichiId, year: 2026, month: m, gross_pay: 600000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 42400, use_auto_deduction: 1 });
    db.upsertOfficerPayEntry({ officer_id: michikoId, year: 2026, month: m, gross_pay: 100000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 3063, use_auto_deduction: 1 });
  }
  const withholdingStatus = db.computeOfficerWithholdingBackingStatus(2026, 7);

  return {
    daichiStatus, michikoStatus, insuranceStatusNone,
    withholdingExpected: withholdingStatus.expectedTotal,
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
node verify_task3.mjs
```

Expected:
- `daichiStatus`は`{"status":"matched","bankAmount":475644,"expectedTotal":475644,"count":1}`
- `michikoStatus`は`{"status":"matched","bankAmount":96937,"expectedTotal":96937,"count":1}`（2人がそれぞれ独立して照合され、互いの金額と混同されないこと）
- `insuranceStatusNone`は`{"status":"none","bankAmount":0,"expectedTotal":217722,"count":0}`（銀行リンクを作っていないので`none`。会社全体の期待値`217722`は正しく取れている）
- `withholdingExpected`は`(42400+3063)*6`＝`272778`（2026年1〜6月の6ヶ月分、両役員の源泉所得税を合算）

- [ ] **Step 8: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js
git commit -m "$(cat <<'EOF'
複数役員対応: 裏付け判定ロジックを役員スコープ化

computeOfficerNetBackingStatus に officerId を追加し、役員ごとに
独立して手取りの銀行照合ができるようにした。社会保険料・源泉所得税は
会社全体の値のままとし、源泉所得税は全役員分を合算して判定する。
sumLinkedBankAmount/linkBankTransaction に officer_id 条件を追加。
EOF
)"
```

---

### Task 4: 銀行タブ — 分類フォームに役員選択を追加

**Files:**
- Modify: `js/views/bank.js`

**Interfaces:**
- Consumes: Task 1の`listOfficers`、Task 3の`linkBankTransaction`（`officer_id`引数）
- Produces: `openLinkEditor`・`linkSummaryHtml`が役員を扱えるようになる（他タスクへの新規インターフェースは無し）

- [ ] **Step 1: `listOfficers`をインポートする**

`js/views/bank.js`冒頭のimport文（`db.js`から取り込んでいる箇所）に`listOfficers`を追加する。

- [ ] **Step 2: `renderTransactionList`で役員一覧を取得し、`linkSummaryHtml`・`openLinkEditor`に渡す**

`function renderTransactionList(accountId)`内、`const clients = listClients({ includeArchived: true });`の直後に以下を追加する:

```js
    const officers = listOfficers({ includeArchived: true });
```

同じ関数内の`links.length > 0 ? linkSummaryHtml(link, clients) : ...`を`links.length > 0 ? linkSummaryHtml(link, clients, officers) : ...`に変える。

`openLinkEditor(accountId, txnId, rows.find((r) => r.id === txnId), clients)`の呼び出しを`openLinkEditor(accountId, txnId, rows.find((r) => r.id === txnId), clients, officers)`に変える。

- [ ] **Step 3: `linkSummaryHtml`に役員名表示を追加する**

既存の`function linkSummaryHtml(link, clients)`を丸ごと以下に置き換える:

```js
  function linkSummaryHtml(link, clients, officers) {
    const kindLabel = {
      rent: '家賃', ar: '売掛金', officer_net: '役員報酬（手取り）',
      officer_insurance: '役員報酬（社会保険料）', officer_withholding: '役員報酬（源泉所得税）',
      expense_card: link.category ? `経費（${link.category}の引落）` : '経費（カード引落）',
    }[link.kind] || (link.category || '不定型');
    const clientName = link.kind === 'ar' && link.client_id ? (clients.find((c) => c.id === link.client_id)?.name || '') : '';
    const officerName = link.kind === 'officer_net' && link.officer_id ? (officers.find((o) => o.id === link.officer_id)?.name || '') : '';
    const subLabel = clientName || officerName;
    return `<span class="badge good">${escapeHtml(kindLabel)}${subLabel ? `・${escapeHtml(subLabel)}` : ''}</span> <button class="btn ghost unlink-btn" data-link-id="${link.id}">解除</button>`;
  }
```

- [ ] **Step 4: `openLinkEditor`に役員選択プルダウンを追加する**

`function openLinkEditor(accountId, txnId, txn, clients)`の引数に`officers`を追加する（`function openLinkEditor(accountId, txnId, txn, clients, officers)`）。

`cell.innerHTML`内、`<div class="field-row" id="link-client-row-${txnId}" ...>`のブロックの直後に以下を追加する:

```html
      <div class="field-row" id="link-officer-row-${txnId}" style="display:none">
        <div class="field-label">役員</div>
        <div class="field-value">
          <select id="link-officer-${txnId}">${officers.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select>
        </div>
      </div>
```

`updateVisibility`関数内に以下の行を追加する:

```js
      cell.querySelector(`#link-officer-row-${txnId}`).style.display = kindSelect.value === 'officer_net' ? '' : 'none';
```

確認ボタンのクリックハンドラ内、`const clientId = kind === 'ar' ? Number(cell.querySelector(...)) : null;`の直後に以下を追加する:

```js
      const officerId = kind === 'officer_net' ? Number(cell.querySelector(`#link-officer-${txnId}`).value) : null;
```

`linkBankTransaction({ bank_transaction_id: txnId, kind, client_id: clientId, category, ...period });`を`linkBankTransaction({ bank_transaction_id: txnId, kind, client_id: clientId, officer_id: officerId, category, ...period });`に変える。

- [ ] **Step 5: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/bank.js`
Expected: エラーなく終了する

- [ ] **Step 6: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task4.mjs`として保存する:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.upsertOfficer({ name: '荒木大地', home_office_deduction: true });
  db.upsertOfficer({ name: '荒木道子', home_office_deduction: false });
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [
    { txn_date: '2026-08-20', amount: -475644, description: 'インターネット アラキ ダイチ', occurrence: 0 },
  ]);
  await db.persist();
});
await page.goto(`${BASE}#/bank`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.click('.open-account-btn');
await page.waitForTimeout(500);

const txnId = await page.$eval('tr[data-txn-id]', (tr) => tr.dataset.txnId);
await page.click(`tr[data-txn-id="${txnId}"] .link-btn`);
await page.waitForTimeout(200);
const officerRowHiddenBefore = await page.evaluate((id) => document.querySelector(`#link-officer-row-${id}`).style.display, txnId);
await page.selectOption(`#link-kind-${txnId}`, 'officer_net');
await page.waitForTimeout(100);
const officerRowVisibleAfter = await page.evaluate((id) => document.querySelector(`#link-officer-row-${id}`).style.display, txnId);
const officerOptions = await page.$$eval(`#link-officer-${txnId} option`, (opts) => opts.map((o) => o.textContent));
await page.selectOption(`#link-officer-${txnId}`, { label: '荒木大地' });
await page.click(`#link-confirm-${txnId}`);
await page.waitForTimeout(300);

const summaryText = await page.evaluate((id) => document.querySelector(`tr[data-txn-id="${id}"]`).textContent.replace(/\s+/g, ' '), txnId);

console.log(JSON.stringify({ officerRowHiddenBefore, officerRowVisibleAfter, officerOptions, summaryText }, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```

サーバーを起動してから実行する:

```bash
nohup python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley > /tmp/http8900.log 2>&1 &
sleep 1
node verify_task4.mjs
```

Expected:
- `officerRowHiddenBefore`は`"none"`（初期選択の`rent`では役員選択は非表示）
- `officerRowVisibleAfter`は`""`（`officer_net`を選ぶと表示される）
- `officerOptions`は`["荒木大地", "荒木道子"]`
- `summaryText`に`"役員報酬（手取り）・荒木大地"`という文字列が含まれる
- `errors`は`[]`

- [ ] **Step 7: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/views/bank.js
git commit -m "$(cat <<'EOF'
複数役員対応: 銀行タブの分類フォームに役員選択を追加

kind=officer_net を選んだ時に、どの役員への手取り振込かを選べるように
プルダウンを追加した。分類済みの明細にも役員名を表示する。
EOF
)"
```

---

### Task 5: 役員報酬タブ — 役員一覧・追加・休止UI

**Files:**
- Modify: `js/views/officerpay.js`

**Interfaces:**
- Consumes: Task 1の`listOfficers`/`upsertOfficer`/`archiveOfficer`
- Produces: モジュールレベルの`selectedOfficerId`状態（Task 6が使う）

- [ ] **Step 1: importに役員CRUD関数を追加する**

`js/views/officerpay.js`冒頭のimport文（`../db.js`から取り込んでいる箇所）に`listOfficers, upsertOfficer, archiveOfficer`を追加する。

- [ ] **Step 2: モジュールレベルの状態を追加する**

`let bulkMode = false;`の直後に以下を追加する:

```js
let selectedOfficerId = null;
```

- [ ] **Step 3: `render`関数の先頭に役員一覧UIを追加する**

`export function render(container, ctx)`内、`const { year, month } = ctx;`の直後に以下を追加する:

```js
  const officers = listOfficers({ includeArchived: true });
  const activeOfficers = officers.filter((o) => !o.archived);
  if (selectedOfficerId == null || !activeOfficers.some((o) => o.id === selectedOfficerId)) {
    selectedOfficerId = activeOfficers.length ? activeOfficers[0].id : null;
  }
```

`container.innerHTML`の一番外側（現在は`${bulkMode ? ... : ''}<div id="bulk-slot">...`から始まる）の直前に、役員一覧カードのHTMLを追加する。具体的には、`container.innerHTML = \`` の中身の先頭に以下を挿入する:

```html
    <div class="card">
      <div class="card-header">
        <h2>役員</h2>
        <div class="toolbar"><button class="btn ghost" id="add-officer-btn">＋ 役員を追加</button></div>
      </div>
      <div id="officer-list-slot"></div>
    </div>
    <div id="add-officer-form-slot"></div>
```

（この2つの`div`を、既存の`${bulkMode ? ...}` `<div id="bulk-slot"></div>` より前に置く）

- [ ] **Step 4: 役員一覧・追加フォームのレンダリング関数を追加する**

`export function render(container, ctx)`関数の中、`container.querySelectorAll('.bulk-toggle-btn')...`より前に以下の呼び出しと関数定義を追加する:

呼び出し（`container.innerHTML = ...`の直後、既存の`.bulk-toggle-btn`イベント登録より前）:

```js
  renderOfficerList();
```

関数定義（`render`関数の末尾、既存の`renderBulkTable`関数の直後）:

```js
  function renderOfficerList() {
    const slot = container.querySelector('#officer-list-slot');
    if (officers.length === 0) {
      slot.innerHTML = '<div class="card-note" style="margin:0">まだ役員が登録されていません。「＋ 役員を追加」から始めましょう。</div>';
      return;
    }
    slot.innerHTML = `
      <table class="ledger">
        <thead><tr><th>氏名</th><th>状態</th><th>自宅の家賃・光熱費を天引き</th><th></th><th></th></tr></thead>
        <tbody>
          ${officers.map((o) => `
            <tr data-officer-id="${o.id}" class="${o.id === selectedOfficerId ? 'selected-row' : ''}">
              <td>${escapeHtml(o.name)}</td>
              <td>${o.archived ? '休止中' : '有効'}</td>
              <td><input type="checkbox" class="officer-home-deduction" data-id="${o.id}" ${o.home_office_deduction ? 'checked' : ''}></td>
              <td><button class="btn ghost select-officer-btn" data-id="${o.id}">選ぶ</button></td>
              <td><button class="btn ghost archive-officer-btn" data-id="${o.id}" data-archived="${o.archived}">${o.archived ? '再開する' : '休止する'}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    slot.querySelectorAll('.select-officer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedOfficerId = Number(btn.dataset.id);
        render(container, ctx);
      });
    });
    slot.querySelectorAll('.archive-officer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        archiveOfficer(Number(btn.dataset.id), btn.dataset.archived === '1' ? 0 : 1);
        render(container, ctx);
      });
    });
    slot.querySelectorAll('.officer-home-deduction').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const officer = officers.find((o) => o.id === Number(checkbox.dataset.id));
        upsertOfficer({ ...officer, home_office_deduction: checkbox.checked });
        render(container, ctx);
      });
    });
  }
```

`escapeHtml`は既にこのファイルでは未使用なので、`js/views/officerpay.js`冒頭のimport文に`import { escapeHtml } from '../format.js';`の形で追加する（`yen, monthLabel, ...`を取り込んでいる既存の`../format.js`からのimportに`escapeHtml`を足す）。

- [ ] **Step 5: 追加フォームのトグルを追加する**

`container.querySelector('#add-officer-btn').addEventListener(...)`を、`renderOfficerList();`の直後に追加する:

```js
  container.querySelector('#add-officer-btn').addEventListener('click', () => {
    const slot = container.querySelector('#add-officer-form-slot');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <div class="card">
        <h2>役員を追加</h2>
        <div class="field-row">
          <div class="field-label">氏名</div>
          <div class="field-value"><input type="text" id="new-officer-name" placeholder="例: 荒木道子"></div>
        </div>
        <div class="field-row">
          <div class="field-label">自宅の家賃・水道光熱費を天引きする</div>
          <div class="field-value"><input type="checkbox" id="new-officer-home-deduction"></div>
        </div>
        <div class="toolbar">
          <span class="spacer"></span>
          <button class="btn primary" id="save-officer-btn">追加する</button>
        </div>
      </div>
    `;
    slot.querySelector('#save-officer-btn').addEventListener('click', () => {
      const name = slot.querySelector('#new-officer-name').value.trim();
      if (!name) return;
      const homeDeduction = slot.querySelector('#new-officer-home-deduction').checked;
      const id = upsertOfficer({ name, home_office_deduction: homeDeduction });
      slot.innerHTML = '';
      selectedOfficerId = id;
      render(container, ctx);
    });
  });
```

- [ ] **Step 6: 役員が0人の間は給与明細セクションを出さない**

`<div id="single-month-slot" style="${bulkMode ? 'display:none' : ''}">`で始まる給与明細カード全体を、`activeOfficers.length === 0`のときは表示しない。`container.innerHTML`のテンプレート内で、`<div id="single-month-slot" style="${bulkMode ? 'display:none' : ''}">`という行の直前に`${activeOfficers.length === 0 ? '' : \``を追加し、そのdivに対応する閉じタグ`</div>`（`single-month-slot`を閉じるもの。その直後には既存のコードで`<div class="card">`が続く「支給額の変化」カードが始まる）の直後に`` `}``を追加する（この2つの追加だけで、`single-month-slot`の中身は一切変更しない）。

`render`関数内、`container.querySelectorAll('.bulk-toggle-btn').forEach(...)`の直後、`if (bulkMode) { ... }`ブロックより**前**に、以下を追加する（`bulkMode`かどうかに関わらず、役員が1人もいなければ常に早期`return`する）:

```js
  if (activeOfficers.length === 0) return;
```

- [ ] **Step 7: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/officerpay.js`
Expected: エラーなく終了する

- [ ] **Step 8: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task5.mjs`として保存する:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

// 役員が0人の状態でタブを開く
await page.goto(`${BASE}#/officer`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const emptyStateText = await page.evaluate(() => document.getElementById('view-root').textContent);
const hasPayslipWhenEmpty = await page.evaluate(() => !!document.querySelector('.payslip'));

// 役員を2人追加する
await page.click('#add-officer-btn');
await page.waitForTimeout(150);
await page.fill('#new-officer-name', '荒木大地');
await page.check('#new-officer-home-deduction');
await page.click('#save-officer-btn');
await page.waitForTimeout(200);

await page.click('#add-officer-btn');
await page.waitForTimeout(150);
await page.fill('#new-officer-name', '荒木道子');
await page.click('#save-officer-btn');
await page.waitForTimeout(200);

const rowCount = await page.$$eval('tr[data-officer-id]', (trs) => trs.length);
const hasPayslipAfterAdd = await page.evaluate(() => !!document.querySelector('.payslip'));

// 道子を休止する
const michikoRow = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('tr[data-officer-id]'));
  const row = rows.find((r) => r.textContent.includes('荒木道子'));
  return row ? row.dataset.officerId : null;
});
await page.click(`tr[data-officer-id="${michikoRow}"] .archive-officer-btn`);
await page.waitForTimeout(200);
const activeRowCount = await page.$$eval('tr[data-officer-id]', (trs) =>
  trs.filter((tr) => tr.querySelector('td').closest('tr').children[1].textContent === '有効').length);

console.log(JSON.stringify({
  emptyStateHasMessage: emptyStateText.includes('まだ役員が登録されていません'),
  hasPayslipWhenEmpty, rowCount, hasPayslipAfterAdd, activeRowCount,
}, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```

サーバーを起動してから実行する:

```bash
nohup python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley > /tmp/http8900.log 2>&1 &
sleep 1
node verify_task5.mjs
```

Expected:
- `emptyStateHasMessage`は`true`
- `hasPayslipWhenEmpty`は`false`
- `rowCount`は`2`
- `hasPayslipAfterAdd`は`true`
- `activeRowCount`は`1`（道子を休止したので大地のみ有効）
- `errors`は`[]`

- [ ] **Step 9: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/views/officerpay.js
git commit -m "$(cat <<'EOF'
複数役員対応: 役員報酬タブに役員一覧・追加・休止UIを追加

得意先タブ・銀行タブと同じ「＋ 追加」パターンで役員を管理できるように
した。自宅の家賃・光熱費を天引きするかどうかは役員ごとにチェックボックス
で切り替えられる。役員が0人の間は給与明細セクションを表示しない。
EOF
)"
```

---

### Task 6: 役員報酬タブ — 給与明細セクションの役員スコープ化

**Files:**
- Modify: `js/views/officerpay.js`

**Interfaces:**
- Consumes: Task 2の`getOfficerPayEntry`/`findPreviousOfficerPayEntry`/`upsertOfficerPayEntry`/`resolveOfficerDeductions`（すべて`officerId`引数あり）、Task 3の`computeOfficerNetBackingStatus`（`officerId`引数あり）、Task 5の`selectedOfficerId`
- Produces: なし（このタスクで機能は完結する）

- [ ] **Step 1: `BULK_FIELDS`から`employer_insurance_total`を外す**

既存の`const BULK_FIELDS = [{ key: 'gross_pay', label: '支給額' }, ...DEDUCTION_FIELDS, { key: 'employer_insurance_total', label: '社会保険料（会社負担込み）' }];`を以下に置き換える:

```js
const BULK_FIELDS = [{ key: 'gross_pay', label: '支給額' }, ...DEDUCTION_FIELDS];
```

- [ ] **Step 2: `employer_insurance_total`の入力欄をrent_utility_entries経由にする**

`js/views/officerpay.js`冒頭のimport文に`getRentUtilityEntry, upsertRentUtilityEntry`を追加する（`../db.js`から）。

`.employer-insurance-block`のHTML自体（入力欄・バッジスロット・注記）は変更しない。表示位置・選択中の役員に関わらず常に同じ会社全体の値を表示する。

- [ ] **Step 3: `render`関数内で`selectedOfficer`を取得する**

`export function render(container, ctx)`内、Task 5で追加した`activeOfficers`の行の直後に以下を追加する（この時点で`activeOfficers.length === 0`ならTask 5のStep 6で既に`return`済みなので、`selectedOfficer`は必ず見つかる）:

```js
  const selectedOfficer = activeOfficers.find((o) => o.id === selectedOfficerId);
```

既存の`const deductions = resolveOfficerDeductions(year, month);`を`const deductions = resolveOfficerDeductions(selectedOfficerId, year, month);`に変える。

- [ ] **Step 4: 家賃・光熱費天引きセクションを`home_office_deduction`で条件表示する**

給与明細カード内の、以下の既存のHTMLブロック（`<div class="section-heading">控除</div>`の直後、`DEDUCTION_FIELDS`のループの後に続く部分）:

```html
            <div id="officer-withholding-badge-slot" class="bank-badge-slot"></div>
            <label class="auto-toggle"><input type="checkbox" id="use_auto"> 家賃・光熱費の自動反映を使う</label>
            <div class="card-note payslip-note">${deductions.has_source
              ? `${monthLabel(prev.year, prev.month)}分の台帳から自動反映しています。`
              : `${monthLabel(prev.year, prev.month)}分の台帳データがないため0円です。`}</div>
            <div id="manual-fields" style="display:none">
              <div class="compact-field"><label for="manual_rent_deduction">家賃控除（手入力）</label><span><input type="text" inputmode="numeric" class="currency-input" id="manual_rent_deduction"><small>円</small></span></div>
              <div class="compact-field"><label for="manual_utility_deduction">光熱費控除（手入力）</label><span><input type="text" inputmode="numeric" class="currency-input" id="manual_utility_deduction"><small>円</small></span></div>
            </div>
            <div class="auto-deductions">
              <div class="computed-line"><span>家賃控除</span><strong class="num" id="rent-deduction-display">0<span class="unit">円</span></strong></div>
              <div class="computed-line"><span>水道光熱費控除</span><strong class="num" id="utility-deduction-display">0<span class="unit">円</span></strong></div>
            </div>
```

を、以下に置き換える（`officer-withholding-badge-slot`は会社全体の値なので条件の外側に残し、家賃・光熱費に関する部分だけを`selectedOfficer.home_office_deduction`で囲む）:

```html
            <div id="officer-withholding-badge-slot" class="bank-badge-slot"></div>
            ${selectedOfficer.home_office_deduction ? `
            <label class="auto-toggle"><input type="checkbox" id="use_auto"> 家賃・光熱費の自動反映を使う</label>
            <div class="card-note payslip-note">${deductions.has_source
              ? `${monthLabel(prev.year, prev.month)}分の台帳から自動反映しています。`
              : `${monthLabel(prev.year, prev.month)}分の台帳データがないため0円です。`}</div>
            <div id="manual-fields" style="display:none">
              <div class="compact-field"><label for="manual_rent_deduction">家賃控除（手入力）</label><span><input type="text" inputmode="numeric" class="currency-input" id="manual_rent_deduction"><small>円</small></span></div>
              <div class="compact-field"><label for="manual_utility_deduction">光熱費控除（手入力）</label><span><input type="text" inputmode="numeric" class="currency-input" id="manual_utility_deduction"><small>円</small></span></div>
            </div>
            <div class="auto-deductions">
              <div class="computed-line"><span>家賃控除</span><strong class="num" id="rent-deduction-display">0<span class="unit">円</span></strong></div>
              <div class="computed-line"><span>水道光熱費控除</span><strong class="num" id="utility-deduction-display">0<span class="unit">円</span></strong></div>
            </div>
            ` : ''}
```

このテンプレートは既存コード内で`\``（バッククォート）を使ったJSテンプレートリテラルの中に置かれているため、上記のネストしたテンプレートリテラルはそのまま埋め込んで問題ない（既存の`carry-notice`等、このファイル内の他の箇所でも同様のネストしたテンプレートリテラルが使われている）。

`container.querySelectorAll('#single-month-slot input.currency-input').forEach(enableCurrencyInput);`や`container.querySelector('#manual-fields').style.display = ...`など、`manual-fields`・`manual_rent_deduction`・`manual_utility_deduction`・`use_auto`要素を参照している既存コードは、`selectedOfficer.home_office_deduction`が偽のときはこれらの要素がDOMに存在しないため、該当要素への参照はすべて`container.querySelector('#use_auto')`のようにオプショナルチェイニング（`?.`）を使う形に変える（例: `container.querySelector('#use_auto').checked = !!state.use_auto_deduction;` → `container.querySelector('#use_auto')?.checked` を読む前に存在確認する、または`if (selectedOfficer.home_office_deduction) { ... }`で全体を囲む）。具体的には、`render`関数内の以下の既存行:

```js
  container.querySelector('#use_auto').checked = !!state.use_auto_deduction;
  container.querySelector('#manual_rent_deduction').value = state.manual_rent_deduction;
  container.querySelector('#manual_utility_deduction').value = state.manual_utility_deduction;
  container.querySelector('#manual-fields').style.display = state.use_auto_deduction ? 'none' : 'block';
```

を、以下に置き換える:

```js
  if (selectedOfficer.home_office_deduction) {
    container.querySelector('#use_auto').checked = !!state.use_auto_deduction;
    container.querySelector('#manual_rent_deduction').value = state.manual_rent_deduction;
    container.querySelector('#manual_utility_deduction').value = state.manual_utility_deduction;
    container.querySelector('#manual-fields').style.display = state.use_auto_deduction ? 'none' : 'block';
  }
```

`save()`関数内の以下の既存行:

```js
    const useAuto = container.querySelector('#use_auto').checked;
```

を、以下に置き換える:

```js
    const useAuto = selectedOfficer.home_office_deduction ? container.querySelector('#use_auto').checked : false;
```

`save()`関数内の以下の既存行:

```js
    container.querySelector('#manual-fields').style.display = useAuto ? 'none' : 'block';
```

を、以下に置き換える:

```js
    if (selectedOfficer.home_office_deduction) {
      container.querySelector('#manual-fields').style.display = useAuto ? 'none' : 'block';
    }
```

- [ ] **Step 5: 残りの呼び出し箇所すべてに`selectedOfficerId`を渡す**

以下の既存呼び出し箇所を、示した通りに書き換える:

- `render`関数内、`const existing = getOfficerPayEntry(year, month);` → `const existing = getOfficerPayEntry(selectedOfficerId, year, month);`
- `render`関数内、`const previousEntry = existing ? null : findPreviousOfficerPayEntry(year, month);` → `const previousEntry = existing ? null : findPreviousOfficerPayEntry(selectedOfficerId, year, month);`
- `copy-prev-btn`のクリックハンドラ内、`const p = getOfficerPayEntry(prev.year, prev.month);` → `const p = getOfficerPayEntry(selectedOfficerId, prev.year, prev.month);`
- `recompute(entry)`関数内、`const d = resolveOfficerDeductions(year, month);` → `const d = resolveOfficerDeductions(selectedOfficerId, year, month);`
- `recompute(entry)`関数内、`container.querySelector('#officer-net-badge-slot').innerHTML = bankBadgeHtml(computeOfficerNetBackingStatus(year, month));` → `container.querySelector('#officer-net-badge-slot').innerHTML = bankBadgeHtml(computeOfficerNetBackingStatus(selectedOfficerId, year, month));`
- `renderChart`関数内、月ごとのループ内にある`const e = getOfficerPayEntry(m.year, m.month);` → `const e = getOfficerPayEntry(selectedOfficerId, m.year, m.month);`
- `renderChart`関数内、同じループ内の`const d = resolveOfficerDeductions(m.year, m.month);` → `const d = resolveOfficerDeductions(selectedOfficerId, m.year, m.month);`
- `renderBulkTable`関数内、`const entry = getOfficerPayEntry(m.year, m.month);` → `const entry = getOfficerPayEntry(selectedOfficerId, m.year, m.month);`
- `renderBulkTable`関数内の`change`イベントハンドラ内、`const existingEntry = getOfficerPayEntry(y, m) || {...};` → `const existingEntry = getOfficerPayEntry(selectedOfficerId, y, m) || {...};`
- `save()`関数内の`entry`オブジェクトリテラル（`year, month,`で始まる部分）に`officer_id: selectedOfficerId,`を追加する
- `renderBulkTable`関数内の`change`イベントハンドラ内、`const updated = { ...existingEntry, year: y, month: m, [input.dataset.key]: ... };`を`const updated = { ...existingEntry, officer_id: selectedOfficerId, year: y, month: m, [input.dataset.key]: ... };`に変える

`state`の3つの初期化分岐（`existing`/`previousEntry`/新規）のオブジェクトリテラルから`employer_insurance_total`を削除する（もう`officer_pay_entries`側の項目ではないため）。`container.querySelector('#employer_insurance_total').value = state.employer_insurance_total;`の行を削除し、代わりに`render`関数内で以下を追加する:

```js
  const rentEntry = getRentUtilityEntry(year, month);
  container.querySelector('#employer_insurance_total').value = rentEntry ? rentEntry.employer_insurance_total || 0 : 0;
```

`save()`関数内、`employer_insurance_total: parseCurrencyInput(...)`を`entry`オブジェクトから削除し、代わりに以下を`save()`の先頭に追加する:

```js
    const rentEntry = getRentUtilityEntry(year, month) || { year, month, rent_total: 0, rent_personal_fixed: 0, water_total: 0, water_personal_pct: 40, gas_total: 0, gas_personal_pct: 40, electricity_total: 0, electricity_personal_pct: 40 };
    upsertRentUtilityEntry({ ...rentEntry, year, month, employer_insurance_total: parseCurrencyInput(container.querySelector('#employer_insurance_total').value) });
```

`renderBulkTable`内、`existingEntry`のフォールバックオブジェクトからも`employer_insurance_total: 0`を削除する。

`carriedFrom`が真のときに「引き継ぎ中」の薄字表示（`carried`クラス）を付ける既存の行:

```js
    ['gross_pay', ...DEDUCTION_FIELDS.map((f) => f.key), 'employer_insurance_total'].forEach((id) => container.querySelector(`#${id}`).classList.add('carried'));
```

からも`'employer_insurance_total'`を外す（`employer_insurance_total`はもう`previousEntry`から引き継ぐ項目ではなく、`rent_utility_entries`側の独立した値のため）:

```js
    ['gross_pay', ...DEDUCTION_FIELDS.map((f) => f.key)].forEach((id) => container.querySelector(`#${id}`).classList.add('carried'));
```

- [ ] **Step 6: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/officerpay.js`
Expected: エラーなく終了する

- [ ] **Step 7: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task6.mjs`として保存する:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.upsertOfficer({ name: '荒木大地', home_office_deduction: true });
  db.upsertOfficer({ name: '荒木道子', home_office_deduction: false });
  await db.persist();
});
await page.goto(`${BASE}#/officer`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// 大地（家賃天引きあり）が選択されている状態で、家賃セクションが見えることを確認
const daichiHasRentSection = await page.evaluate(() => !!document.querySelector('.auto-deductions'));

await page.fill('#gross_pay', '600000');
await page.waitForTimeout(300);

// 道子に切り替え、家賃セクションが消えることを確認
const michikoRow = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('tr[data-officer-id]'));
  const row = rows.find((r) => r.textContent.includes('荒木道子'));
  return row ? row.dataset.officerId : null;
});
await page.click(`tr[data-officer-id="${michikoRow}"] .select-officer-btn`);
await page.waitForTimeout(300);
const michikoHasRentSection = await page.evaluate(() => !!document.querySelector('.auto-deductions'));
await page.fill('#gross_pay', '100000');
await page.waitForTimeout(300);

// 大地に戻して、600000が保持されていることを確認（道子の入力と混ざっていないか）
const daichiRow = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('tr[data-officer-id]'));
  const row = rows.find((r) => r.textContent.includes('荒木大地'));
  return row ? row.dataset.officerId : null;
});
await page.click(`tr[data-officer-id="${daichiRow}"] .select-officer-btn`);
await page.waitForTimeout(300);
const daichiGrossAfterSwitch = await page.evaluate(() => document.querySelector('#gross_pay').value);

const dbState = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const officers = db.listOfficers();
  const daichi = officers.find((o) => o.name === '荒木大地');
  const michiko = officers.find((o) => o.name === '荒木道子');
  return {
    daichiEntry: db.getOfficerPayEntry(daichi.id, new Date().getFullYear(), new Date().getMonth() + 1),
    michikoEntry: db.getOfficerPayEntry(michiko.id, new Date().getFullYear(), new Date().getMonth() + 1),
  };
});

console.log(JSON.stringify({ daichiHasRentSection, michikoHasRentSection, daichiGrossAfterSwitch, dbState }, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```

サーバーを起動してから実行する:

```bash
nohup python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley > /tmp/http8900.log 2>&1 &
sleep 1
node verify_task6.mjs
```

Expected:
- `daichiHasRentSection`は`true`
- `michikoHasRentSection`は`false`
- `daichiGrossAfterSwitch`は`"600,000"`（通貨入力の表示形式。大地の値が道子の入力によって上書きされていないこと）
- `dbState.daichiEntry.gross_pay`は`600000`、`dbState.michikoEntry.gross_pay`は`100000`（それぞれ別の行に保存されていること）
- `errors`は`[]`

このタスクの実装スクリプトは今日の年月を使っているため、月初の`getOfficerPayEntry`呼び出しに前月データが無くても構わない（`previousEntry`が`null`の初期状態からの入力を確認するテストのため）。

- [ ] **Step 8: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/views/officerpay.js
git commit -m "$(cat <<'EOF'
複数役員対応: 役員報酬タブの給与明細を役員スコープ化

選択中の役員に対して給与明細の表示・保存・グラフ・一括入力が動くように
した。家賃・光熱費の天引きセクションは home_office_deduction を持つ
役員でのみ表示する。社会保険料合計は rent_utility_entries 経由の
会社全体の値として扱う。
EOF
)"
```

---

### Task 7: ダッシュボード・月次レポートの全役員合計化

**Files:**
- Modify: `js/views/dashboard.js`
- Modify: `js/views/report.js`

**Interfaces:**
- Consumes: Task 2の`listOfficerPayEntries`/`resolveOfficerDeductions`
- Produces: なし（このタスクで機能は完結する）

- [ ] **Step 1: `dashboard.js`のimportを更新する**

`js/views/dashboard.js`冒頭のimport文の`getOfficerPayEntry, resolveOfficerDeductions,`を`listOfficerPayEntries, resolveOfficerDeductions,`に変える。

- [ ] **Step 2: `dashboard.js`の`netPayFor`を全役員合計に変える**

既存の`function netPayFor(year, month) { const e = getOfficerPayEntry(year, month); ... }`を丸ごと以下に置き換える:

```js
function netPayFor(year, month) {
  const entries = listOfficerPayEntries(year, month);
  if (entries.length === 0) return null;
  return entries.reduce((sum, e) => {
    const d = resolveOfficerDeductions(e.officer_id, year, month);
    const total = DEDUCTION_KEYS.reduce((a, k) => a + (e[k] || 0), 0) + d.rent_deduction + d.utility_deduction;
    return sum + (e.gross_pay - total);
  }, 0);
}
```

- [ ] **Step 3: `report.js`のimportを更新する**

`js/views/report.js`冒頭のimport文の`getOfficerPayEntry, resolveOfficerDeductions,`を`listOfficerPayEntries, resolveOfficerDeductions,`に変える。

- [ ] **Step 4: `report.js`の月次サマリー算出を全役員合計に変える**

既存の以下のブロック:

```js
  const payEntry = getOfficerPayEntry(year, month);
  const deductions = resolveOfficerDeductions(year, month);
  const deductionRows = payEntry ? DEDUCTION_FIELDS.map((f) => ({ label: f.label, value: payEntry[f.key] || 0 })) : [];
  const deductionTotal = (payEntry ? deductionRows.reduce((a, r) => a + r.value, 0) : 0) + deductions.rent_deduction + deductions.utility_deduction;
  const netPay = payEntry ? payEntry.gross_pay - deductionTotal : 0;
```

を丸ごと以下に置き換える:

```js
  const officerEntries = listOfficerPayEntries(year, month);
  const grossPayTotal = officerEntries.reduce((a, e) => a + (e.gross_pay || 0), 0);
  const deductionRows = officerEntries.length ? DEDUCTION_FIELDS.map((f) => ({
    label: f.label,
    value: officerEntries.reduce((a, e) => a + (e[f.key] || 0), 0),
  })) : [];
  const rentUtilityDeductionTotal = officerEntries.reduce((a, e) => {
    const d = resolveOfficerDeductions(e.officer_id, year, month);
    return a + d.rent_deduction + d.utility_deduction;
  }, 0);
  const deductionTotal = deductionRows.reduce((a, r) => a + r.value, 0) + rentUtilityDeductionTotal;
  const netPay = grossPayTotal - deductionTotal;
```

- [ ] **Step 5: `statutoryThisMonth`を全役員合計に変える**

既存の以下のブロック:

```js
  const statutoryThisMonth = payEntry
    ? (payEntry.health_insurance || 0) + (payEntry.nursing_care_insurance || 0)
      + (payEntry.pension || 0) + (payEntry.child_support_levy || 0)
    : 0;
```

を丸ごと以下に置き換える:

```js
  const statutoryThisMonth = officerEntries.reduce((a, e) =>
    a + (e.health_insurance || 0) + (e.nursing_care_insurance || 0) + (e.pension || 0) + (e.child_support_levy || 0), 0);
```

- [ ] **Step 6: `officerFy`/`statutoryFy`の累計ループを全役員合計に変える**

既存の以下のブロック:

```js
  let officerFy = 0, statutoryFy = 0;
  monthsToDate.forEach((m) => {
    const e = getOfficerPayEntry(m.year, m.month);
    if (!e) return;
    officerFy += e.gross_pay || 0;
    statutoryFy += (e.health_insurance || 0) + (e.nursing_care_insurance || 0) + (e.pension || 0) + (e.child_support_levy || 0);
  });
```

を丸ごと以下に置き換える:

```js
  let officerFy = 0, statutoryFy = 0;
  monthsToDate.forEach((m) => {
    listOfficerPayEntries(m.year, m.month).forEach((e) => {
      officerFy += e.gross_pay || 0;
      statutoryFy += (e.health_insurance || 0) + (e.nursing_care_insurance || 0) + (e.pension || 0) + (e.child_support_levy || 0);
    });
  });
```

- [ ] **Step 7: 表示テーブルの`payEntry.gross_pay`参照を`grossPayTotal`に変える**

`js/views/report.js`内、`${yen(payEntry ? payEntry.gross_pay : 0)}`という文字列が2箇所ある（136行目付近・196行目付近）。どちらも`${yen(grossPayTotal)}`に置き換える。

- [ ] **Step 8: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/views/dashboard.js && node --check js/views/report.js`
Expected: エラーなく終了する

- [ ] **Step 9: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task7.mjs`として保存する:

```js
import { chromium } from 'playwright';
const BASE = 'http://localhost:8900/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  db.setMeta('company_name', '株式会社あららんど');
  db.setMeta('founding_year', 2024); db.setMeta('founding_month', 4);
  const daichiId = db.upsertOfficer({ name: '荒木大地', home_office_deduction: true });
  const michikoId = db.upsertOfficer({ name: '荒木道子', home_office_deduction: false });
  db.upsertOfficerPayEntry({ officer_id: daichiId, year: 2026, month: 8, gross_pay: 600000, health_insurance: 29520, nursing_care_insurance: 5340, pension: 54900, child_support_levy: 2196, withholding_tax: 42400, use_auto_deduction: 1 });
  db.upsertOfficerPayEntry({ officer_id: michikoId, year: 2026, month: 8, gross_pay: 100000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 3063, use_auto_deduction: 1 });
  await db.persist();
});

await page.goto(`${BASE}#/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const dashboardHasError = await page.evaluate(() => document.getElementById('view-root').children.length === 0);

await page.goto(`${BASE}#/report`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const reportText = await page.evaluate(() => document.getElementById('view-root').textContent.replace(/\s+/g, ' '));
const reportHasGrossTotal = reportText.includes('700,000'); // 600,000 + 100,000

console.log(JSON.stringify({ dashboardHasError, reportHasGrossTotal }, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```

サーバーを起動してから実行する:

```bash
nohup python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley > /tmp/http8900.log 2>&1 &
sleep 1
node verify_task7.mjs
```

Expected:
- `dashboardHasError`は`false`
- `reportHasGrossTotal`は`true`（大地60万＋道子10万＝70万が合計として表示されている）
- `errors`は`[]`

- [ ] **Step 10: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/views/dashboard.js js/views/report.js
git commit -m "$(cat <<'EOF'
複数役員対応: ダッシュボード・月次レポートを全役員合計に変更

役員報酬の手取り・総支給額・法定福利費の表示を、単一役員前提から
全役員の合計値に変更した。役員ごとの内訳は役員報酬タブ側で確認する。
EOF
)"
```

---

### Task 8: 全体回帰検証

**Files:** なし（既存ファイルの検証のみ）

**Interfaces:**
- Consumes: Task 1〜7のすべて

- [ ] **Step 1: 全対象ファイルの構文チェック**

Run:
```bash
cd /home/lima.guest/projects/kayley
for f in js/db.js js/views/bank.js js/views/officerpay.js js/views/dashboard.js js/views/report.js; do
  echo "== $f =="; node --check "$f" && echo OK;
done
```
Expected: 5ファイル全てで`OK`と表示される

- [ ] **Step 2: 全タブが崩れずレンダリングされることを確認する**

作業用ディレクトリに`verify_task8.mjs`として保存する:

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
  db.upsertRentUtilityEntry({ year: 2026, month: 8, rent_total: 148000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40, employer_insurance_total: 217722 });
  const daichiId = db.upsertOfficer({ name: '荒木大地', home_office_deduction: true });
  const michikoId = db.upsertOfficer({ name: '荒木道子', home_office_deduction: false });
  db.upsertOfficerPayEntry({ officer_id: daichiId, year: 2026, month: 8, gross_pay: 600000, health_insurance: 29520, nursing_care_insurance: 5340, pension: 54900, child_support_levy: 2196, withholding_tax: 42400, use_auto_deduction: 1 });
  db.upsertOfficerPayEntry({ officer_id: michikoId, year: 2026, month: 8, gross_pay: 100000, health_insurance: 0, nursing_care_insurance: 0, pension: 0, child_support_levy: 0, withholding_tax: 3063, use_auto_deduction: 1 });
  const cardId = db.upsertPaymentSource({ name: 'カードA', kind: 'card' });
  db.addStatementTransaction({ source_id: cardId, year: 2026, month: 8, txn_date: '2026-08-01', description: 'テスト', amount: 1000, account_title: '通信費' });
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [
    { txn_date: '2026-08-20', amount: 480000, description: 'ノースゲート', occurrence: 0 },
    { txn_date: '2026-08-21', amount: -475644, description: 'インターネット アラキ ダイチ', occurrence: 0 },
  ]);
  await db.persist();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const tabs = ['dashboard', 'ar', 'rent', 'officer', 'expenses', 'report', 'bank', 'settings'];
const results = {};
for (const t of tabs) {
  await page.goto(`${BASE}#/${t}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  results[t] = await page.evaluate(() => document.getElementById('view-root').children.length > 0);
}

console.log('レンダリング結果:', JSON.stringify(results, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```

サーバーを起動してから実行する:

```bash
nohup python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley > /tmp/http8900.log 2>&1 &
sleep 1
node verify_task8.mjs
pkill -f "http.server 8900"
```

Expected:
- `results`の8タブすべてが`true`
- `errors`は`[]`

このタスクではコミットするコード変更は無い（検証のみ）。
