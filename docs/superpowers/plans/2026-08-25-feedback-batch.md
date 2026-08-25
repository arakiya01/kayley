# フィードバック一括対応 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ユーザーから届いた7件のフィードバック（前月比較表示・役員編集・経費完了条件と銀行照合・売掛金の誤判定2件・各タブの完了条件の可視化・銀行タブのフィルタ拡充・銀行タブのナビ格上げ）を、依存関係の順に直す。

**Architecture:** 新規テーブルは追加しない。既存の`officers`テーブルに`role`列を1つ追加するのみ。表示ロジックの直し（`changestrip.js`）、既存の銀行照合パターン（`sumLinkedBankAmount`/`compute*BackingStatus`）を経費タブにも展開、既存の完了条件判定（`getSectionCompletion`）に銀行タブ分を追加、既存のナビ構造（`TABS`/`renderProgressSpine`のsteps配列）に銀行を編入。銀行タブは`needsMonth: true`にして月バーと連動させ、選択中の月をデフォルトの期間フィルタにする。

**Tech Stack:** ビルド無しの素のES modules。sql.js（既存）。動作確認は`python3 -m http.server`＋Playwright（`chromium.launch()`）による手動駆動スクリプト。自動テストフレームワーク（jest/pytest等）はこのプロジェクトに存在しないため導入しない。

**Spec:** 無し（ユーザーからの直接フィードバック7件がそのまま要件。既存の`docs/superpowers/specs/2026-08-25-bank-reconciliation-design.md`と`2026-08-25-multi-officer-design.md`が関連する既存設計）

## Global Constraints

- 銀行データは既存4タブ（売掛金・家賃・役員報酬・経費）のテーブルに書き込まない
- npmパッケージを追加しない。ビルド無しの素のESモジュール構成を維持する
- 新規に自動テストフレームワークを導入しない。`node --check`と使い捨てのPlaywright検証スクリプトで確認する（検証スクリプトはリポジトリにコミットしない）
- 既存の`officer_pay_entries`のような`UNIQUE`制約の作り直しは今回は不要（`officers.role`は制約に関係しない単純な列追加）
- 各タスクの完了条件は「`node --check`が全対象ファイルで通ること」「Playwright検証スクリプトが期待通りの結果を出すこと（コンソールエラー0件）」
- Task 6（銀行タブのフィルタ拡充）はTask 5（銀行タブのナビ格上げ）が先に終わっていないと着手できない（`ctx.year`/`ctx.month`をbank.jsが受け取れるようになるのがTask 5のため）

---

## ファイル構成

**変更のみ（新規ファイル無し）:**
- `js/changestrip.js` — 前月比較の描画を、実額主表示＋小さい緑/赤の増減表示に作り直す（Task 1）
- `css/style.css` — `.change-cell`まわりのスタイル更新（Task 1）、`table.ledger th.desc`の追加（Task 6）
- `js/db.js` — `officers.role`列追加とCRUD対応（Task 2）、`sumLinkedBankAmount`に`category`条件追加と`computeExpenseCardBackingStatus`新設（Task 3）、`computeArBackingStatus`のnot_applicable分岐（Task 4）、`getSectionCompletion`に`bank`を追加と`computeMonthlyBankCompletion`新設（Task 5）、`updateBankTransactionDescription`新設（Task 6）
- `js/views/officerpay.js` — 役員一覧テーブルに役職列と氏名・役職の編集UIを追加（Task 2）
- `js/views/expenses.js` — 完了条件の説明文とカードごとの銀行照合バッジを追加（Task 3）
- `js/views/ar.js` — `renderTable`の取引開始月フィルタ漏れ修正、完了条件の説明文追加（Task 4）
- `js/app.js` — 銀行タブをワークフロー主要タブに編入、`needsMonth: true`化（Task 5）
- `js/views/rent.js` — 完了条件の説明文追加（Task 5）
- `js/views/report.js` — 完了条件の説明文追加（Task 5）
- `js/views/bank.js` — `ctx`受け取り対応、期間・文字列検索フィルタ追加、摘要インライン編集、ヘッダ/ボタン文言統一（Task 6）

---

## 検証方法についての共通ルール

このプロジェクトには自動テストフレームワークが存在しない。これまでの開発と同じ方式で検証する:

1. **構文チェック**: 変更した全`.js`ファイルで`node --check <file>`を実行する
2. **ブラウザ検証**: プロジェクトルートで`python3 -m http.server 8900 --directory /home/lima.guest/projects/kayley`を起動し、Playwright（`chromium.launch()`）で開いて、`page.evaluate()`内で`await import('/js/db.js')`してデータを直接投入し、DOM・コンソールエラーを確認する。検証スクリプトは作業用ディレクトリ（プロジェクト外）に置き、リポジトリにはコミットしない
3. 各タスクの最後に`git add` → `git commit`する。コミットメッセージは日本語、既存コミットと同じ粒度（1〜2行の要約＋箇条書きの本文）
4. サーバーは各タスクの検証後に`pkill -f "http.server 8900"`で止める（次のタスクの検証で`EADDRINUSE`にならないように）

---

### Task 1: 前月比較表示を実額＋小さい増減表示に作り直す

**Files:**
- Modify: `js/changestrip.js`
- Modify: `css/style.css:818-827`

**Interfaces:**
- Consumes: 無し（既存の`changeStrip(container, { xLabels, fullLabels, highlightIndex, rows })`のシグネチャは変えない。呼び出し元の`js/views/rent.js:222`・`js/views/officerpay.js:294`は無修正で動く）
- Produces: 無し（内部描画ロジックのみの変更）

- [ ] **Step 1: `changeStrip`本体を書き換える**

`js/changestrip.js`の`export function changeStrip(...)`を丸ごと以下に置き換える:

```js
import { yen } from './format.js';

// 「前月からどれだけ変わったか」を見せる帯。
// 主表示は実額（yen(value)）にし、前月からの増減はセルの下に小さく緑（増）/赤（減）で添える。
// 変わらない月は増減欄を「±0」で示す（緑にも赤にもしない）。
// 定期同額給与の役員報酬や、契約で固定の家賃のように「変わらないのが正常」なものでも、
// 実額そのものは常に見えるようにしたいというフィードバックを反映している。
// xLabels はセルに出す短いラベル（「4月」）。fullLabels は要約とツールチップに使う
// 年つきのラベル（「2026年4月」）で、省略すると xLabels をそのまま使う。
export function changeStrip(container, { xLabels, fullLabels, highlightIndex, rows }) {
  const longLabels = fullLabels || xLabels;
  container.innerHTML = `<div class="change-strip">${rows.map((row) => {
    let previous = null;
    let base = null;
    const differences = [];
    const cells = row.values.map((value, index) => {
      const classes = ['change-cell'];
      if (index === highlightIndex) classes.push('current');
      let valueDisplay = '—';
      let delta = '';
      if (value == null) {
        classes.push('none');
      } else if (previous == null) {
        classes.push('base');
        valueDisplay = `${yen(value)}円`;
        base = value;
        previous = value;
      } else if (value === previous) {
        classes.push('same');
        valueDisplay = `${yen(value)}円`;
        delta = `<span class="d same">±0</span>`;
        previous = value;
      } else {
        const difference = value - previous;
        const up = difference > 0;
        classes.push(up ? 'up' : 'down');
        valueDisplay = `${yen(value)}円`;
        const differenceDisplay = up ? `+${yen(difference)}` : `−${yen(Math.abs(difference))}`;
        delta = `<span class="d ${up ? 'up' : 'down'}">${differenceDisplay}円</span>`;
        differences.push({ label: longLabels[index], display: differenceDisplay });
        previous = value;
      }
      const title = value == null ? `${longLabels[index]}：データなし` : `${longLabels[index]}：${yen(value)}円`;
      return `<div class="${classes.join(' ')}" title="${title}"><span class="m">${xLabels[index]}</span><span class="v">${valueDisplay}</span>${delta}</div>`;
    }).join('');
    let summary = base == null ? 'データなし' : `変化なし・${yen(base)}円`;
    if (differences.length) {
      const first = differences[0];
      summary = differences.length === 1
        ? `${first.label}に ${first.display}円`
        : `${first.label}ほか${differences.length - 1}件`;
    }
    return `<div class="change-row"><div class="change-row-head"><span class="change-label">${row.label}</span><span class="change-summary">${summary}</span></div><div class="change-cells">${cells}</div></div>`;
  }).join('')}</div>`;
}
```

- [ ] **Step 2: CSSを更新する**

`css/style.css`の818〜827行目（`.change-cell { ... }`から`.change-cell.current { ... }`まで）を丸ごと以下に置き換える:

```css
.change-cell { flex: 1 1 62px; min-width: 62px; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 4px; border: 1px solid var(--grid-line); border-radius: var(--radius); background: var(--card-raised); }
.change-cell .m { font-size: 10.5px; color: var(--ink-muted); }
.change-cell .v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 700; color: var(--ink); }
.change-cell .d { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 10px; }
.change-cell .d.up { color: var(--status-good); }
.change-cell .d.down { color: var(--status-critical); }
.change-cell .d.same { color: var(--ink-muted); }
.change-cell.none { opacity: 0.4; }
.change-cell.none .v { color: var(--ink-muted); }
.change-cell.current { box-shadow: 0 0 0 1.5px var(--hanko) inset; }
```

- [ ] **Step 3: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/changestrip.js`
Expected: エラーなく終了する

- [ ] **Step 4: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task1.mjs`として保存する:

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
  db.upsertRentUtilityEntry({ year: 2026, month: 5, rent_total: 148000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40 });
  db.upsertRentUtilityEntry({ year: 2026, month: 6, rent_total: 148000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40 });
  db.upsertRentUtilityEntry({ year: 2026, month: 7, rent_total: 150000, rent_personal_fixed: 44400, water_total: 5000, water_personal_pct: 40, gas_total: 4000, gas_personal_pct: 40, electricity_total: 10000, electricity_personal_pct: 40 });
  await db.persist();
});
await page.goto(`${BASE}#/rent`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const cellsInfo = await page.$$eval('#rent-trend-chart .change-row:first-child .change-cell', (cells) => cells.map((c) => ({
  classes: c.className,
  value: c.querySelector('.v')?.textContent,
  delta: c.querySelector('.d')?.textContent || null,
  deltaClass: c.querySelector('.d')?.className || null,
})));
console.log(JSON.stringify(cellsInfo.slice(-4), null, 1));
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
- 6月分のセル: `value`が`148,000円`、`delta`が`"±0"`、`deltaClass`に`same`が含まれる（5月と同額のため）
- 7月分のセル: `value`が`150,000円`、`delta`が`"+2,000円"`、`deltaClass`に`up`が含まれる
- すべてのセルで`value`が常に実額を表示している（「＝」という表示は無くなっている）
- `errors`は`[]`

- [ ] **Step 5: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/changestrip.js css/style.css
git commit -m "$(cat <<'EOF'
前月比較の表示を実額主表示＋小さい増減表示に作り直す

「前月と同じなら＝、違えば差額だけ」という表示だと金額そのものが
埋もれて見づらいというフィードバックを受けて、常に実額を主表示にし、
前月からの増減はセルの下に小さく緑（増）/赤（減）で添えるようにした。
家賃タブ・役員報酬タブの両方に共通のchangeStrip()を直したので1箇所で済む。
EOF
)"
```

---

### Task 2: 役員の氏名・役職を編集できるようにする

**Files:**
- Modify: `js/db.js`
- Modify: `js/views/officerpay.js`

**Interfaces:**
- Consumes: 無し
- Produces: `officers.role`列（`ensureColumn`経由）。`upsertOfficer(officer)`の`officer`引数に`role`（省略可）が追加される

- [ ] **Step 1: `role`列を追加する**

`js/db.js`の`migrateColumns()`関数内、`ensureColumn('bank_transaction_links', 'officer_id', 'INTEGER REFERENCES officers(id)');`の直後に追加する:

```js
  ensureColumn('officers', 'role', 'TEXT');
```

- [ ] **Step 2: `upsertOfficer`に`role`を追加する**

既存の`export function upsertOfficer(officer)`を丸ごと以下に置き換える:

```js
export function upsertOfficer(officer) {
  if (officer.id) {
    run(
      'UPDATE officers SET name=?, role=?, home_office_deduction=? WHERE id=?',
      [officer.name, officer.role || null, officer.home_office_deduction ? 1 : 0, officer.id]
    );
    return officer.id;
  }
  run(
    'INSERT INTO officers (name, role, sort_order, archived, home_office_deduction) VALUES (?, ?, ?, 0, ?)',
    [officer.name, officer.role || null, officer.sort_order || 0, officer.home_office_deduction ? 1 : 0]
  );
  return one('SELECT last_insert_rowid() AS id').id;
}
```

- [ ] **Step 3: 役員追加フォームに役職欄を足す**

`js/views/officerpay.js`の`#add-officer-btn`クリックハンドラ内、`slot.innerHTML`の以下の部分:

```html
        <div class="field-row">
          <div class="field-label">氏名</div>
          <div class="field-value"><input type="text" id="new-officer-name" placeholder="例: 荒木道子"></div>
        </div>
```

の直後に追加する:

```html
        <div class="field-row">
          <div class="field-label">役職</div>
          <div class="field-value"><input type="text" id="new-officer-role" placeholder="例: 取締役"></div>
        </div>
```

`slot.querySelector('#save-officer-btn').addEventListener('click', () => { ... })`内を以下に置き換える:

```js
    slot.querySelector('#save-officer-btn').addEventListener('click', () => {
      const name = slot.querySelector('#new-officer-name').value.trim();
      if (!name) return;
      const role = slot.querySelector('#new-officer-role').value.trim();
      const homeDeduction = slot.querySelector('#new-officer-home-deduction').checked;
      const id = upsertOfficer({ name, role, home_office_deduction: homeDeduction });
      slot.innerHTML = '';
      selectedOfficerId = id;
      render(container, ctx);
    });
```

- [ ] **Step 4: 役員一覧カードに完了条件の説明文を足す**

`js/views/officerpay.js`の`export function render(container, ctx)`内、`container.innerHTML`テンプレートの以下の部分:

```html
    <div class="card">
      <div class="card-header">
        <h2>役員</h2>
        <div class="toolbar"><button class="btn ghost" id="add-officer-btn">＋ 役員を追加</button></div>
      </div>
      <div id="officer-list-slot"></div>
    </div>
```

を以下に置き換える:

```html
    <div class="card">
      <div class="card-header">
        <h2>役員</h2>
        <div class="toolbar"><button class="btn ghost" id="add-officer-btn">＋ 役員を追加</button></div>
      </div>
      <div class="card-note">完了印は、在籍中の役員全員分の給与明細がこの月に入力されると付きます。</div>
      <div id="officer-list-slot"></div>
    </div>
```

- [ ] **Step 5: 役員一覧テーブルに役職列と編集用inputを追加する**

`function renderOfficerList()`内の`slot.innerHTML`を丸ごと以下に置き換える:

```js
    slot.innerHTML = `
      <table class="ledger">
        <thead><tr><th>氏名</th><th>役職</th><th>状態</th><th>自宅の家賃・光熱費を天引き</th><th></th><th></th></tr></thead>
        <tbody>
          ${officers.map((o) => `
            <tr data-officer-id="${o.id}" class="${o.id === selectedOfficerId ? 'selected-row' : ''}">
              <td><input type="text" class="officer-name-input" data-id="${o.id}" value="${escapeHtml(o.name)}"></td>
              <td><input type="text" class="officer-role-input" data-id="${o.id}" value="${escapeHtml(o.role || '')}" placeholder="役職"></td>
              <td>${o.archived ? '休止中' : '有効'}</td>
              <td><input type="checkbox" class="officer-home-deduction" data-id="${o.id}" ${o.home_office_deduction ? 'checked' : ''}></td>
              <td><button class="btn ghost select-officer-btn" data-id="${o.id}">選ぶ</button></td>
              <td><button class="btn ghost archive-officer-btn" data-id="${o.id}" data-archived="${o.archived}">${o.archived ? '再開する' : '休止する'}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
```

同じ関数内の末尾（`slot.querySelectorAll('.officer-home-deduction')...`ブロックの直後）に追加する:

```js
    slot.querySelectorAll('.officer-name-input').forEach((input) => {
      input.addEventListener('change', () => {
        const officer = officers.find((o) => o.id === Number(input.dataset.id));
        const name = input.value.trim();
        if (!name) { input.value = officer.name; return; }
        upsertOfficer({ ...officer, name });
        render(container, ctx);
      });
    });
    slot.querySelectorAll('.officer-role-input').forEach((input) => {
      input.addEventListener('change', () => {
        const officer = officers.find((o) => o.id === Number(input.dataset.id));
        upsertOfficer({ ...officer, role: input.value.trim() });
        render(container, ctx);
      });
    });
```

- [ ] **Step 6: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js && node --check js/views/officerpay.js`
Expected: エラーなく終了する

- [ ] **Step 7: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task2.mjs`として保存する:

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
const officerId = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const id = db.upsertOfficer({ name: '荒木大地', role: '代表取締役', home_office_deduction: true });
  await db.persist();
  return id;
});
await page.goto(`${BASE}#/officer`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const completionNote = await page.$eval('#officer-list-slot', (el) => el.parentElement.querySelector('.card-note')?.textContent || null);
const roleBefore = await page.inputValue(`.officer-role-input[data-id="${officerId}"]`);
await page.fill(`.officer-name-input[data-id="${officerId}"]`, '荒木大地（改名）');
await page.locator(`.officer-name-input[data-id="${officerId}"]`).blur();
await page.waitForTimeout(300);
await page.fill(`.officer-role-input[data-id="${officerId}"]`, '取締役会長');
await page.locator(`.officer-role-input[data-id="${officerId}"]`).blur();
await page.waitForTimeout(300);

const after = await page.evaluate(async (id) => {
  const db = await import('/js/db.js');
  return db.getOfficer(id);
}, officerId);

console.log(JSON.stringify({ completionNote, roleBefore, after }, null, 1));
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
- `completionNote`は`"完了印は、在籍中の役員全員分の給与明細がこの月に入力されると付きます。"`
- `roleBefore`は`"代表取締役"`
- `after.name`は`"荒木大地（改名）"`、`after.role`は`"取締役会長"`
- `errors`は`[]`

- [ ] **Step 8: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js js/views/officerpay.js
git commit -m "$(cat <<'EOF'
役員報酬タブ: 役員の氏名・役職を編集できるようにする

officers に role 列を追加し、役員一覧テーブルの氏名・役職をinput化して
その場で編集・保存できるようにした（休止/再開・天引き切替と同じ、
即時保存パターン）。追加フォームにも役職欄を足した。
EOF
)"
```

---

### Task 3: 経費タブの完了条件表示とカード裏付けバッジ

**Files:**
- Modify: `js/db.js`
- Modify: `js/views/expenses.js`

**Interfaces:**
- Consumes: 無し
- Produces:
  - `export function sumLinkedBankAmount({ kind, client_id, officer_id, category, year, month })`（シグネチャ変更: `category`条件を追加）
  - `export function computeExpenseCardBackingStatus(source, year, month)` → `{ status, bankAmount, expectedTotal, count }`

- [ ] **Step 1: `sumLinkedBankAmount`に`category`条件を追加する**

既存の`export function sumLinkedBankAmount({ kind, client_id, officer_id, year, month })`を丸ごと以下に置き換える:

```js
export function sumLinkedBankAmount({ kind, client_id, officer_id, category, year, month }) {
  const conditions = ['l.kind=?', 'l.period_start_year=?', 'l.period_start_month=?'];
  const params = [kind, year, month];
  if (client_id != null) { conditions.push('l.client_id=?'); params.push(client_id); }
  if (officer_id != null) { conditions.push('l.officer_id=?'); params.push(officer_id); }
  if (category != null) { conditions.push('l.category=?'); params.push(category); }
  const row = one(
    `SELECT COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS count
     FROM bank_transaction_links l JOIN bank_transactions t ON t.id = l.bank_transaction_id
     WHERE ${conditions.join(' AND ')}`,
    params
  );
  return { total: row.total, count: row.count };
}
```

- [ ] **Step 2: `computeExpenseCardBackingStatus`を追加する**

`export function computeArBackingStatus(clientId) { ... }`の直後に追加する:

```js
// 経費タブのカード引落と銀行の突き合わせ。カード名（bank_transaction_links.category）で、
// その月にカードで計上した経費合計と、銀行側で expense_card としてそのカード名に
// リンクされた引落合計を比較する。まだ何も無い月（経費も銀行リンクも無い）は
// not_applicable にして、他の裏付けバッジと同じくバッジ自体を出さない。
export function computeExpenseCardBackingStatus(source, year, month) {
  const expectedTotal = listStatementTransactions(source.id, year, month).reduce((sum, t) => sum + t.amount, 0);
  const { total: bankTotal, count } = sumLinkedBankAmount({ kind: 'expense_card', category: source.name, year, month });
  if (count === 0) return { status: expectedTotal === 0 ? 'not_applicable' : 'none', bankAmount: 0, expectedTotal, count: 0 };
  const bankAmount = Math.abs(bankTotal);
  return { status: bankAmount === expectedTotal ? 'matched' : 'mismatch', bankAmount, expectedTotal, count };
}
```

- [ ] **Step 3: 完了条件の説明文を足す**

`js/views/expenses.js`の`export function render(container, ctx)`内、`container.innerHTML`テンプレートの以下の部分:

```html
      <div class="card-note">
        カードの利用明細（PDF）をアップロードすると、1件ずつの取引に自動で展開します。
        現金の利用はまれだと思うので、手入力で追加できます。
      </div>
```

を以下に置き換える:

```html
      <div class="card-note">
        カードの利用明細（PDF）をアップロードすると、1件ずつの取引に自動で展開します。
        現金の利用はまれだと思うので、手入力で追加できます。
        完了印は、当月の経費データが1件以上あり、すべての明細に勘定科目が選ばれると付きます。
      </div>
```

- [ ] **Step 4: カードごとの銀行照合バッジを表示する**

`js/views/expenses.js`冒頭のimport文に`computeExpenseCardBackingStatus`（`../db.js`から）と`bankBadgeHtml`（`../bankbadge.js`から）を追加する:

```js
import {
  getMeta, listAttachments, addAttachment, removeAttachment,
  listPaymentSources, upsertPaymentSource, archivePaymentSource,
  listStatementTransactions, addStatementTransaction, removeStatementTransaction, clearStatementTransactions,
  ACCOUNT_TITLES, setTransactionAccountTitle, learnAccountRule, applyAccountRulesToMonth,
  listAllStatementTransactions, computeExpenseCardBackingStatus,
} from '../db.js';
import { yen, escapeHtml, monthLabel } from '../format.js';
import * as gdrive from '../gdrive.js';
import { extractPdfTextRows, detectAndParse } from '../statementparsers.js';
import { fileChipHtml } from '../fileicon.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';
import { bankBadgeHtml } from '../bankbadge.js';
```

`function renderSources()`内、`const sourceActions = (s) => ...`の直前に追加する:

```js
    const cardBadge = (s) => s.kind === 'card' ? bankBadgeHtml(computeExpenseCardBackingStatus(s, year, month)) : '';
```

同じ関数内、以下の2箇所の`<span class="badge good" style="margin-left:8px">${s.kind === 'cash' ? '現金' : 'カード'}</span>`（populated側、1箇所）と`<span class="badge good">${s.kind === 'cash' ? '現金' : 'カード'}</span>`（empty側、1箇所）を、それぞれ直後に`${cardBadge(s)}`を足す形に変える:

populated側（`<div class="toolbar">`内）:
```html
          <span class="badge good" style="margin-left:8px">${s.kind === 'cash' ? '現金' : 'カード'}</span>
          ${cardBadge(s)}
```

empty側（`<div class="compact-source-row" ...>`内）:
```html
            <span class="badge good">${s.kind === 'cash' ? '現金' : 'カード'}</span>
            ${cardBadge(s)}
```

- [ ] **Step 5: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js && node --check js/views/expenses.js`
Expected: エラーなく終了する

- [ ] **Step 6: 検証スクリプトを書いて実行する**

作業用ディレクトリに`verify_task3.mjs`として保存する:

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

const setup = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const cardId = db.upsertPaymentSource({ name: '楽天カード', kind: 'card' });
  db.addStatementTransaction({ source_id: cardId, year: 2026, month: 8, txn_date: '2026-08-05', description: '文具店', amount: 3000 });
  db.addStatementTransaction({ source_id: cardId, year: 2026, month: 8, txn_date: '2026-08-10', description: 'サーバー代', amount: 5000 });
  const noneStatus = db.computeExpenseCardBackingStatus({ id: cardId, name: '楽天カード' }, 2026, 8);

  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [
    { txn_date: '2026-08-27', amount: -8000, description: '楽天カード引落', occurrence: 0 },
  ]);
  const txns = db.listBankTransactions(accountId);
  db.linkBankTransaction({ bank_transaction_id: txns[0].id, kind: 'expense_card', category: '楽天カード', period_start_year: 2026, period_start_month: 8, period_end_year: 2026, period_end_month: 8 });
  const matchedStatus = db.computeExpenseCardBackingStatus({ id: cardId, name: '楽天カード' }, 2026, 8);

  await db.persist();
  return { cardId, noneStatus, matchedStatus };
});

await page.goto(`${BASE}#/expenses`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const badgeText = await page.evaluate(() => document.querySelector('.bank-badge')?.textContent || null);

console.log(JSON.stringify({ ...setup, badgeText }, null, 1));
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
- `noneStatus`は`{"status":"none","bankAmount":0,"expectedTotal":8000,"count":0}`（銀行リンクがまだ無い）
- `matchedStatus`は`{"status":"matched","bankAmount":8000,"expectedTotal":8000,"count":1}`
- `badgeText`は`"銀行照合済み"`
- `errors`は`[]`

- [ ] **Step 7: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js js/views/expenses.js
git commit -m "$(cat <<'EOF'
経費タブ: 完了条件を説明し、カードごとの銀行照合バッジを追加

カード明細を経費タブに入れても、銀行タブ側で分類済みかどうかが
経費タブから見えず困るというフィードバックを受けて、
sumLinkedBankAmount に category 条件を足し、カードごとに
その月の利用合計と銀行の引落合計を突き合わせるバッジを表示するようにした。
完了印の条件（経費データが1件以上あり、全明細に科目が付いていること）も
案内文として明記した。
EOF
)"
```

---

### Task 4: 売掛金タブの誤判定2件を直す

**Files:**
- Modify: `js/db.js`
- Modify: `js/views/ar.js`

**Interfaces:**
- Consumes: 無し
- Produces: `computeArBackingStatus(clientId)`が、入金実績が無い得意先には`status: 'not_applicable'`を返すようになる（バッジが出なくなる）

- [ ] **Step 1: `renderTable`で取引開始月フィルタを適用する**

`js/views/ar.js`の`function renderTable()`内、以下の行:

```js
    const activeClients = listClientsForMonth(year, month);
```

を以下に置き換える:

```js
    const activeClients = listClientsForMonth(year, month).filter((c) => clientTradeAllowsMonth(c, year, month));
```

（`renderCharts()`側は既に同じ判定を使っており、`renderBulkTable()`は年度をまたぐ一括入力グリッドで単月の表示とは性質が異なるため、今回は対象外とする）

- [ ] **Step 2: `computeArBackingStatus`にnot_applicable分岐を足す**

既存の`export function computeArBackingStatus(clientId)`内の以下の行:

```js
  if (row.count === 0) return { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
```

を以下に置き換える:

```js
  // 入金実績（expectedTotal）がまだゼロなら、銀行リンクが無いのは「まだ入金されていない」
  // だけで異常ではない。売上は立ったが未入金という状態を「銀行未整合」と混同しないよう、
  // バッジ自体を出さない not_applicable にする。
  if (row.count === 0) {
    return expectedTotal === 0
      ? { status: 'not_applicable', bankAmount: 0, expectedTotal, count: 0 }
      : { status: 'none', bankAmount: 0, expectedTotal, count: 0 };
  }
```

- [ ] **Step 3: 完了条件の説明文を足す**

`js/views/ar.js`の以下の行:

```html
      <div class="card-note">得意先ごとの当月売上・入金を記録します。残高は自動で繰り越し計算されます。</div>
```

を以下に置き換える:

```html
      <div class="card-note">得意先ごとの当月売上・入金を記録します。残高は自動で繰り越し計算されます。完了印は、この月の売上・入金が1件でも入力されると付きます。</div>
```

- [ ] **Step 4: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js && node --check js/views/ar.js`
Expected: エラーなく終了する

- [ ] **Step 5: 検証スクリプトを書いて実行する**

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

const setup = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  // 2026年8月から取引開始の得意先。2026年6月時点ではまだ表示されないはず。
  const laterClientId = db.upsertClient({ name: '後発クライアント', trade_start_year: 2026, trade_start_month: 8 });
  // 売上は立てたが入金はまだの得意先
  const unpaidClientId = db.upsertClient({ name: '未入金クライアント' });
  db.upsertArEntry({ client_id: unpaidClientId, year: 2026, month: 8, sales: 100000, payment: 0 });
  const unpaidStatus = db.computeArBackingStatus(unpaidClientId);
  await db.persist();
  return { laterClientId, unpaidClientId, unpaidStatus };
});

await page.goto(`${BASE}#/ar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const juneNames = await page.evaluate(() => Array.from(document.querySelectorAll('table.ledger tbody tr td:first-child')).map((td) => td.textContent));

// 8月に移動して、後発クライアントがちゃんと出ることも確認する
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  localStorage.setItem('kayley-ui-state', JSON.stringify({ tab: 'ar', year: 2026, month: 8 }));
});
await page.goto(`${BASE}#/ar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const augNames = await page.evaluate(() => Array.from(document.querySelectorAll('table.ledger tbody tr td:first-child')).map((td) => td.textContent));

console.log(JSON.stringify({ juneNames, augNames, unpaidStatus: setup.unpaidStatus }, null, 1));
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
- `juneNames`（2026年6月時点の得意先一覧）に`"後発クライアント"`が**含まれていない**（取引開始が8月のため）
- `augNames`（2026年8月時点）には`"後発クライアント"`と`"未入金クライアント"`の両方が含まれる
- `unpaidStatus`は`{"status":"not_applicable","bankAmount":0,"expectedTotal":0,"count":0}`
- `errors`は`[]`

- [ ] **Step 6: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js js/views/ar.js
git commit -m "$(cat <<'EOF'
売掛金タブ: 取引開始前の表示と未入金の誤判定を直す

取引開始月より前の月にも得意先が表示され続け、しかも銀行未整合と
出てしまっていた（renderCharts側は clientTradeAllowsMonth で
絞っていたが、renderTable 側で呼び忘れていた）。あわせて、
売上は立てたがまだ入金が無いだけのケースを、本来の「銀行未整合」と
区別するため not_applicable（バッジ非表示）にした。
EOF
)"
```

---

### Task 5: 銀行タブをワークフロー主要タブへ格上げし、各タブの完了条件を明示する

**Files:**
- Modify: `js/db.js`
- Modify: `js/app.js`
- Modify: `js/views/rent.js`
- Modify: `js/views/report.js`

**Interfaces:**
- Consumes: 無し
- Produces:
  - `export function computeMonthlyBankCompletion(year, month)` → `{ total, linked }`
  - `getSectionCompletion(year, month)`の戻り値に`bank`が追加される
  - `js/views/bank.js`の`render`が`(container, ctx)`で呼ばれるようになる（Task 6で対応。Task 5完了直後は`bank.js`側が未対応のため、銀行タブを開くとコンソールに`ctx is not defined`は出ない——`render(container)`のまま`ctx`が渡されても単に無視されるだけで、月バーは表示されるが銀行タブの中身自体はまだ選択月に連動しない。これはTask 6で解消される、想定内の過渡的な状態）

- [ ] **Step 1: `computeMonthlyBankCompletion`を追加する**

`js/db.js`の`export function listAllBankTransactions() { ... }`の直後に追加する:

```js
// 選択中の月の明細が1件以上あり、全部分類済みかどうか（銀行タブの完了条件）。
// 明細が1件も無い月は「完了」ではなく「対象外」として扱う（total===0）。
export function computeMonthlyBankCompletion(year, month) {
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const row = one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM bank_transaction_links l WHERE l.bank_transaction_id = t.id) THEN 1 ELSE 0 END) AS linked
     FROM bank_transactions t
     WHERE substr(t.txn_date, 1, 7) = ?`,
    [ym]
  );
  return { total: row.total, linked: row.linked || 0 };
}
```

- [ ] **Step 2: `getSectionCompletion`に`bank`を追加する**

既存の`export function getSectionCompletion(year, month) { ... }`内、以下の行:

```js
  return { ar: arDone, rent: rentDone, officer: officerDone, expenses: expensesDone, report: reportDone };
```

の直前に追加する:

```js
  const bankCompletion = computeMonthlyBankCompletion(year, month);
  const bankDone = bankCompletion.total > 0 && bankCompletion.linked === bankCompletion.total;
```

そして戻り値の行を以下に置き換える:

```js
  return { ar: arDone, rent: rentDone, officer: officerDone, expenses: expensesDone, report: reportDone, bank: bankDone };
```

- [ ] **Step 3: 銀行タブをワークフロー主要タブに編入する**

`js/app.js`の`TABS`配列内、以下の行:

```js
  { key: 'bank', label: '銀行', mod: bank, needsMonth: false },
```

を以下に置き換える:

```js
  { key: 'bank', label: '銀行', mod: bank, needsMonth: true },
```

`renderProgressSpine()`内の`steps`配列を以下に置き換える:

```js
  const steps = [
    { key: 'ar', label: '売掛金', done: completion.ar },
    { key: 'rent', label: '家賃・光熱費', done: completion.rent },
    { key: 'officer', label: '役員報酬', done: completion.officer },
    { key: 'expenses', label: '経費', done: completion.expenses },
    { key: 'report', label: '月次レポート', done: completion.report },
    { key: 'bank', label: '銀行', done: completion.bank },
  ];
```

同じ関数内、`spine-top`のテンプレートから銀行への`utility-link`を削除する。以下の行:

```html
      <a class="utility-link ${state.tab === 'bank' ? 'active' : ''}" href="#/bank">銀行</a>
      <a class="utility-link ${state.tab === 'settings' ? 'active' : ''}" href="#/settings">設定</a>
```

を以下に置き換える（銀行へのリンクを削除し、設定だけ残す）:

```html
      <a class="utility-link ${state.tab === 'settings' ? 'active' : ''}" href="#/settings">設定</a>
```

`renderNotices()`内、以下の行:

```js
    if (![completion.ar, completion.rent, completion.officer, completion.expenses, completion.report].every(Boolean)) {
```

を以下に置き換える:

```js
    if (![completion.ar, completion.rent, completion.officer, completion.expenses, completion.report, completion.bank].every(Boolean)) {
```

- [ ] **Step 4: 完了条件のツールチップを足す**

`js/app.js`の`renderProgressSpine()`内、以下の行:

```js
  document.getElementById('workflow-tabs-slot').innerHTML = `
    ${steps.map((step) => `<a href="#/${step.key}" class="workflow-step ${state.tab === step.key ? 'active' : ''}"><span class="completion-seal ${step.done ? 'done' : ''}"></span>${step.label}</a>`).join('')}
    ${remaining > 0 ? `<span class="workflow-hint">あと${remaining}つで締められます</span>` : ''}
  `;
```

を以下に置き換える:

```js
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
```

- [ ] **Step 5: 家賃タブと月次レポートタブにも完了条件の説明文を足す**

`js/views/rent.js`の以下の行:

```html
        <div class="card-note">全体の家賃実額と、個人負担分（固定額）を入力します。</div>
```

を以下に置き換える:

```html
        <div class="card-note">全体の家賃実額と、個人負担分（固定額）を入力します。完了印は、この月の家賃・水道光熱費が入力されると付きます。</div>
```

`js/views/report.js`の以下の行:

```html
        <div class="card-note">作成日: ${new Date().toLocaleDateString('ja-JP')}</div>
```

の直後に追加する:

```html
        <div class="card-note no-print">完了印は、この月のレポートを一度でも出力すると付きます。</div>
```

- [ ] **Step 6: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js && node --check js/app.js && node --check js/views/rent.js && node --check js/views/report.js`
Expected: エラーなく終了する

- [ ] **Step 7: 検証スクリプトを書いて実行する**

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

const dbState = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const before = db.getSectionCompletion(2026, 8).bank;
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [{ txn_date: '2026-08-05', amount: -1000, description: 'テスト', occurrence: 0 }]);
  const withUnlinked = db.getSectionCompletion(2026, 8).bank;
  const txns = db.listBankTransactions(accountId);
  db.linkBankTransaction({ bank_transaction_id: txns[0].id, kind: 'irregular', category: 'その他', period_start_year: 2026, period_start_month: 8, period_end_year: 2026, period_end_month: 8 });
  const afterLinked = db.getSectionCompletion(2026, 8).bank;
  await db.persist();
  return { before, withUnlinked, afterLinked };
});

// ヘッダに銀行タブが主要ナビとして出ているか、月バーが表示されるか
await page.goto(`${BASE}#/bank`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const workflowStepKeys = await page.$$eval('.workflow-step', (els) => els.map((el) => el.getAttribute('href')));
const utilityLinkTexts = await page.$$eval('.utility-link', (els) => els.map((el) => el.textContent.trim()));
const monthBarPresent = await page.evaluate(() => document.getElementById('month-bar-slot').innerHTML.trim().length > 0);
const bankStepTitle = await page.evaluate(() => document.querySelector('.workflow-step[href="#/bank"]')?.title || null);

console.log(JSON.stringify({ dbState, workflowStepKeys, utilityLinkTexts, monthBarPresent, bankStepTitle }, null, 1));
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
- `dbState.before`は`false`（明細が無い）
- `dbState.withUnlinked`は`false`（1件あるが未分類）
- `dbState.afterLinked`は`true`（1件あり分類済み）
- `workflowStepKeys`が`["#/ar", "#/rent", "#/officer", "#/expenses", "#/report", "#/bank"]`
- `utilityLinkTexts`が`["設定"]`（銀行が消えている）
- `monthBarPresent`は`true`
- `bankStepTitle`は`"完了印は、この月の明細が1件以上あり、すべて分類済みになると付きます"`
- `errors`は`[]`（銀行タブの中身自体はこの時点ではctxを使わないので、開いてもエラーは出ないはず。Task 6でctx対応する）

- [ ] **Step 8: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js js/app.js js/views/rent.js js/views/report.js
git commit -m "$(cat <<'EOF'
銀行タブをワークフロー主要タブへ格上げ、各タブの完了条件を明示

銀行タブが設定ボタンの隣というutility-link扱いだったのを、
売掛金・家賃光熱費・役員報酬・経費・月次レポートと同列の
ワークフロータブに編入し、月バーとも連動させた（needsMonth: true）。
銀行タブ自身の完了条件（この月の明細が1件以上あり全部分類済み）を
getSectionCompletion に追加し、各タブの見出し下の案内文とヘッダの
タブにツールチップで、それぞれの完了条件を明示した。
EOF
)"
```

---

### Task 6: 銀行タブのフィルタ拡充・摘要編集・表記統一

**Files:**
- Modify: `js/db.js`
- Modify: `js/views/bank.js`
- Modify: `css/style.css`

**Interfaces:**
- Consumes: Task 5の`bank.js`が`ctx`を受け取れる状態（`needsMonth: true`化済み）
- Produces: `export function updateBankTransactionDescription(id, description)`

- [ ] **Step 1: `updateBankTransactionDescription`を追加する**

`js/db.js`の`export function listBankTransactions(...) { ... }`の直後に追加する:

```js
// 摘要の手直し（OCR転記と銀行CSVでの表記差など）を手で直せるようにする。
// fingerprint は元の取込内容のまま変えない — 変えると、同じCSVを再取込したときに
// 重複としてスキップされず二重に取り込まれてしまう（importBankTransactionsの重複判定を参照）。
export function updateBankTransactionDescription(id, description) {
  run('UPDATE bank_transactions SET description=? WHERE id=?', [description, id]);
}
```

- [ ] **Step 2: importとモジュール状態を更新する**

`js/views/bank.js`冒頭のimportを以下に置き換える:

```js
import {
  listBankAccounts, upsertBankAccount, archiveBankAccount, importBankTransactions,
  listBankTransactions, listBankTransactionLinks, linkBankTransaction, unlinkBankTransaction,
  officerWithholdingPeriodFor, derivePeriodForKind, IRREGULAR_CATEGORIES, listClients, listOfficers, listPaymentSources,
  accountMatchKey, updateBankTransactionDescription, getMeta,
} from '../db.js';
import { escapeHtml, yen, fiscalYearStartOf, fiscalYearMonths } from '../format.js';
import { decodeCsvBytes, parseCsvText, mapCsvRow, assignOccurrenceIndex, verifyRunningBalance, splitHeaderAndRows } from '../bankcsv.js';

let openAccountId = null;
let transactionFilter = 'all'; // 'all' | 'unlinked' | 'linked'
let periodFilter = 'month'; // 'month' | 'fy' | 'range' | 'all'
let rangeFrom = '';
let rangeTo = '';
let searchText = '';
```

（元の`let openAccountId = null; let transactionFilter = 'all';`の2行を上記の6行に置き換える）

- [ ] **Step 3: `render`が`ctx`を受け取るようにする**

以下の行:

```js
export function render(container) {
  const accounts = listBankAccounts({ includeArchived: true });
```

を以下に置き換える:

```js
export function render(container, ctx) {
  const accounts = listBankAccounts({ includeArchived: true });
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
```

同じ関数内の`render(container);`という自己再帰呼び出しが3箇所ある（口座追加後・休止/再開後）。それぞれ`render(container, ctx);`に置き換える。

- [ ] **Step 4: 完了条件の説明文を足す**

`export function render(container, ctx) { ... }`内、`container.innerHTML`テンプレートの以下の行:

```html
      <div class="card-note">銀行のCSV明細を取り込んで、売掛金・家賃・役員報酬の入力値と照合します。銀行データはここに保存されるだけで、他のタブの数字を書き換えることはありません。</div>
```

を以下に置き換える:

```html
      <div class="card-note">銀行のCSV明細を取り込んで、売掛金・家賃・役員報酬の入力値と照合します。銀行データはここに保存されるだけで、他のタブの数字を書き換えることはありません。完了印は、この月の明細が1件以上あり、すべて分類済みになると付きます。</div>
```

- [ ] **Step 5: 期間フィルタのレンジ計算関数を追加する**

`export function render(container, ctx) { ... }`の中、`function renderAccountList() { ... }`の直前に追加する:

```js
  function periodRange() {
    if (periodFilter === 'month') {
      const mm = String(ctx.month).padStart(2, '0');
      return { from: `${ctx.year}-${mm}-01`, to: `${ctx.year}-${mm}-31` };
    }
    if (periodFilter === 'fy') {
      const fyStart = fiscalYearStartOf(ctx.year, ctx.month, fyStartMonth);
      const months = fiscalYearMonths(fyStart, fyStartMonth);
      const first = months[0];
      const last = months[11];
      return {
        from: `${first.year}-${String(first.month).padStart(2, '0')}-01`,
        to: `${last.year}-${String(last.month).padStart(2, '0')}-31`,
      };
    }
    if (periodFilter === 'range') {
      return { from: rangeFrom || null, to: rangeTo || null };
    }
    return { from: null, to: null };
  }
```

- [ ] **Step 6: フィルタバーを拡充する**

`function renderTransactionList(accountId) { ... }`内、以下の行:

```js
    const rows = all.filter((t) => {
      const links = linksByTxn.get(t.id);
      if (transactionFilter === 'unlinked') return links.length === 0;
      if (transactionFilter === 'linked') return links.length > 0;
      return true;
    });
```

を以下に置き換える:

```js
    const { from, to } = periodRange();
    const searchKey = searchText ? accountMatchKey(searchText) : '';
    const rows = all.filter((t) => {
      const links = linksByTxn.get(t.id);
      if (transactionFilter === 'unlinked' && links.length !== 0) return false;
      if (transactionFilter === 'linked' && links.length === 0) return false;
      if (from && t.txn_date < from) return false;
      if (to && t.txn_date > to) return false;
      if (searchKey && !accountMatchKey(t.description).includes(searchKey)) return false;
      return true;
    });
```

同じ関数内、以下の部分:

```html
          <div class="toolbar">
            <select id="txn-filter">
              <option value="all" ${transactionFilter === 'all' ? 'selected' : ''}>すべて</option>
              <option value="unlinked" ${transactionFilter === 'unlinked' ? 'selected' : ''}>未分類</option>
              <option value="linked" ${transactionFilter === 'linked' ? 'selected' : ''}>裏付け済み</option>
            </select>
          </div>
```

を以下に置き換える:

```html
          <div class="toolbar">
            <select id="period-filter">
              <option value="month" ${periodFilter === 'month' ? 'selected' : ''}>選択中の月</option>
              <option value="fy" ${periodFilter === 'fy' ? 'selected' : ''}>選択中の期</option>
              <option value="range" ${periodFilter === 'range' ? 'selected' : ''}>期間を指定</option>
              <option value="all" ${periodFilter === 'all' ? 'selected' : ''}>すべての期間</option>
            </select>
            ${periodFilter === 'range' ? `
              <input type="date" id="range-from" value="${rangeFrom}">
              <span>〜</span>
              <input type="date" id="range-to" value="${rangeTo}">
            ` : ''}
            <input type="text" id="desc-search" placeholder="摘要を検索" value="${escapeHtml(searchText)}" style="width:140px">
            <select id="txn-filter">
              <option value="all" ${transactionFilter === 'all' ? 'selected' : ''}>すべて</option>
              <option value="unlinked" ${transactionFilter === 'unlinked' ? 'selected' : ''}>未分類</option>
              <option value="linked" ${transactionFilter === 'linked' ? 'selected' : ''}>裏付け済み</option>
            </select>
          </div>
```

同じ関数内、以下の行:

```js
    slot.querySelector('#txn-filter').addEventListener('change', (e) => {
      transactionFilter = e.target.value;
      renderTransactionList(accountId);
    });
```

を以下に置き換える:

```js
    slot.querySelector('#period-filter').addEventListener('change', (e) => {
      periodFilter = e.target.value;
      renderTransactionList(accountId);
    });
    const fromInput = slot.querySelector('#range-from');
    if (fromInput) fromInput.addEventListener('change', (e) => { rangeFrom = e.target.value; renderTransactionList(accountId); });
    const toInput = slot.querySelector('#range-to');
    if (toInput) toInput.addEventListener('change', (e) => { rangeTo = e.target.value; renderTransactionList(accountId); });
    const searchInput = slot.querySelector('#desc-search');
    searchInput.addEventListener('input', (e) => {
      searchText = e.target.value;
      const cursorPos = e.target.selectionStart;
      renderTransactionList(accountId);
      const newInput = container.querySelector('#desc-search');
      if (newInput) { newInput.focus(); newInput.setSelectionRange(cursorPos, cursorPos); }
    });
    slot.querySelector('#txn-filter').addEventListener('change', (e) => {
      transactionFilter = e.target.value;
      renderTransactionList(accountId);
    });
```

- [ ] **Step 7: 摘要をインライン編集できるようにする**

同じ関数内、テーブルヘッダの以下の行:

```html
          <thead><tr><th>日付</th><th>摘要</th><th class="num">金額</th><th>内訳</th></tr></thead>
```

を以下に置き換える（左右寄せのズレ修正と、列名変更）:

```html
          <thead><tr><th>日付</th><th class="desc">摘要</th><th class="num">金額</th><th>分類</th></tr></thead>
```

明細行の摘要セルの以下の行:

```html
                  <td class="desc">${escapeHtml(t.description)}</td>
```

を以下に置き換える:

```html
                  <td class="desc"><input type="text" class="desc-edit-input" data-id="${t.id}" value="${escapeHtml(t.description)}"></td>
```

同じ関数内、`slot.querySelector('#txn-filter')...`ブロックの直後（`slot.querySelectorAll('.link-btn')`の前）に追加する:

```js
    slot.querySelectorAll('.desc-edit-input').forEach((input) => {
      input.addEventListener('change', () => {
        const val = input.value.trim();
        const original = all.find((t) => t.id === Number(input.dataset.id));
        if (!val) { input.value = original.description; return; }
        updateBankTransactionDescription(Number(input.dataset.id), val);
        renderTransactionList(accountId);
      });
    });
```

- [ ] **Step 8: ボタン文言を統一する**

`function linkSummaryHtml(link, clients, officers) { ... }`内の以下の行:

```js
    return `<span class="badge good">${escapeHtml(kindLabel(link, clients, officers))}</span> <button class="btn ghost unlink-btn" data-link-id="${link.id}">解除</button>`;
```

を以下に置き換える:

```js
    return `<span class="badge good">${escapeHtml(kindLabel(link, clients, officers))}</span> <button class="btn ghost unlink-btn" data-link-id="${link.id}">解除する</button>`;
```

- [ ] **Step 9: 構文チェック**

Run: `cd /home/lima.guest/projects/kayley && node --check js/db.js && node --check js/views/bank.js`
Expected: エラーなく終了する

- [ ] **Step 10: 検証スクリプトを書いて実行する**

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

const accountId = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const accountId = db.upsertBankAccount({ name: 'テスト銀行' });
  db.importBankTransactions(accountId, [
    { txn_date: '2026-07-15', amount: -1000, description: '7月ぶん', occurrence: 0 },
    { txn_date: '2026-08-05', amount: -2000, description: '振込 顧問料', occurrence: 0 },
    { txn_date: '2026-08-20', amount: -3000, description: '別の摘要', occurrence: 0 },
  ]);
  localStorage.setItem('kayley-ui-state', JSON.stringify({ tab: 'bank', year: 2026, month: 8 }));
  await db.persist();
  return accountId;
});

await page.goto(`${BASE}#/bank`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.click('.open-account-btn');
await page.waitForTimeout(500);

// デフォルトは「選択中の月」（8月）なので、7月分は出ないはず
const monthDefaultDates = await page.$$eval('table.ledger tbody tr[data-txn-id] td:first-child', (tds) => tds.map((td) => td.textContent));

// 「すべての期間」に切り替えると7月分も出る
await page.selectOption('#period-filter', 'all');
await page.waitForTimeout(200);
const allPeriodDates = await page.$$eval('table.ledger tbody tr[data-txn-id] td:first-child', (tds) => tds.map((td) => td.textContent));

// 文字列曖昧検索
await page.fill('#desc-search', '顧問料');
await page.waitForTimeout(200);
const searchDates = await page.$$eval('table.ledger tbody tr[data-txn-id] td:first-child', (tds) => tds.map((td) => td.textContent));
await page.fill('#desc-search', '');
await page.waitForTimeout(200);

// 摘要のインライン編集
const firstTxnId = await page.$eval('table.ledger tbody tr[data-txn-id]', (tr) => tr.dataset.txnId);
await page.fill(`.desc-edit-input[data-id="${firstTxnId}"]`, '編集後の摘要');
await page.locator(`.desc-edit-input[data-id="${firstTxnId}"]`).blur();
await page.waitForTimeout(300);
const editedDescription = await page.evaluate(async (id) => {
  const db = await import('/js/db.js');
  return db.listBankTransactions(1)[0] && db.listAllBankTransactions().find((t) => t.id === id)?.description;
}, Number(firstTxnId));

// ヘッダの左右寄せ・列名・ボタン文言
const headerAlign = await page.$eval('table.ledger thead th:nth-child(2)', (th) => getComputedStyle(th).textAlign);
const headerText = await page.$eval('table.ledger thead th:nth-child(4)', (th) => th.textContent);

console.log(JSON.stringify({ monthDefaultDates, allPeriodDates, searchDates, editedDescription, headerAlign, headerText }, null, 1));
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
- `monthDefaultDates`は`["2026-08-05", "2026-08-20"]`（7月分は出ない。デフォルトが「選択中の月」＝8月になっている）
- `allPeriodDates`は`["2026-07-15", "2026-08-05", "2026-08-20"]`（3件とも出る）
- `searchDates`は`["2026-08-05"]`（「顧問料」で絞ると1件だけ）
- `editedDescription`は`"編集後の摘要"`
- `headerAlign`は`"left"`（摘要ヘッダが本文と同じ左寄せになっている）
- `headerText`は`"分類"`（「内訳」から変わっている）
- `errors`は`[]`

- [ ] **Step 11: サーバーを止めてコミットする**

```bash
pkill -f "http.server 8900"
cd /home/lima.guest/projects/kayley
git add js/db.js js/views/bank.js css/style.css
git commit -m "$(cat <<'EOF'
銀行タブ: フィルタ拡充・摘要編集・表記統一

選択中の月をデフォルトの期間フィルタにしつつ、選択中の期・日付範囲・
すべての期間にも切り替えられるようにし、摘要の文字列曖昧検索も足した。
摘要はOCR転記と銀行CSVでの表記差を直せるようインライン編集可能にした
（fingerprintは変えないので再取込の重複判定には影響しない）。
ヘッダの左右寄せのズレを直し、列名「内訳」を「分類」に、
ボタン文言「解除」を「解除する」に統一した。
EOF
)"
```
