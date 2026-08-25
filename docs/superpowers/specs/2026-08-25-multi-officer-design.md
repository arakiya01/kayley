# 複数役員対応 設計スペック

## 背景・目的

現在Kayleyの役員報酬（`officer_pay_entries`）は「1ヶ月につき1人分」の構造（`UNIQUE(year, month)`）で、代表者本人の給与しか記録できない。母を役員にして毎月給与を支払っている実態に対応するため、役員を複数登録できるようにする。

あわせて、銀行タブの自動分類（アラキダイチ/officer_net）に実在する問題を1件修正する：役員個人の銀行口座は、役員報酬の手取り振込だけでなく、個人が会社経費を立て替えた際の精算振込も同じ摘要（振込名義）で受け取る。摘要だけに基づく自動分類は、この2つの目的を区別できず誤爆する。この問題は役員が複数になっても本質的に同じなので、本スペックの一部として扱う（`officer_net`は自動学習・自動適用の対象から常に除外する。既にこの対応は実装済み — 本スペックの対象は複数役員対応のみで、以下ではその前提の上に設計する）。

## 大原則（既存の設計思想を維持）

- 銀行データは裏付け専用。役員報酬タブの数値を銀行データが書き換えることは無い（既存の「backing, not writing」原則を維持）。
- 役員は`clients`（得意先）と同じ設計パターンで扱う。既存パターンの流用を優先し、役員専用の特殊な仕組みは作らない。
- 社会保険料合計（`employer_insurance_total`）・源泉所得税の半期納付は、実際の銀行引落としが全役員分まとめて1本であることに合わせ、会社全体で1つの月次数値として管理する（役員ごとには分けない）。給与本体（総支給・控除・手取り）だけを役員ごとに分ける。

## データモデル

### 新規テーブル `officers`

```sql
CREATE TABLE IF NOT EXISTS officers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  home_office_deduction INTEGER NOT NULL DEFAULT 0
);
```

`home_office_deduction`: この役員の給与から、自宅兼事務所の家賃・水道光熱費の個人負担分を天引きするかどうか。既存の代表者はこのフラグが立つ（自宅を事務所として使っているため）。新規追加する役員（母など）はデフォルトでOFF。

### `officer_pay_entries` の変更

`ensureColumn`で`officer_id INTEGER`を追加する。SQLiteの既存UNIQUE制約（`UNIQUE(year, month)`）をALTERで変更するのはリスクが高いため、テーブル自体は作り直さない。一意性（1人の役員につき1ヶ月1行）は、DBのUNIQUE制約ではなく`upsertOfficerPayEntry`のアプリケーションロジックで担保する（`officer_id + year + month`で既存行を検索し、あればUPDATE、無ければINSERT）。

`employer_insurance_total`列は`officer_pay_entries`から削除しない（既存の列はそのまま残すが、以後は使わない・書き込まない）。新しい値は`rent_utility_entries`に持たせる。

### `rent_utility_entries` の変更

`ensureColumn`で`employer_insurance_total INTEGER`を追加する（`UNIQUE(year, month)`はそのまま維持。会社全体で月1件のテーブルという性質は変わらないため）。

### `bank_transaction_links` の変更

`ensureColumn`で`officer_id INTEGER`を追加する（`client_id`と同じ位置づけ。`kind='officer_net'`の時だけ使う）。

## 移行（既存データの引き継ぎ）

`migrateColumns()`実行直後に、新しい`migrateOfficers()`を呼ぶ（`importBytes`・初期化パスの両方、既存の`migrateColumns()`呼び出し箇所2ヶ所に追加）。

```js
function migrateOfficers() {
  const legacyCount = one('SELECT COUNT(*) AS n FROM officer_pay_entries WHERE officer_id IS NULL').n;
  if (legacyCount === 0) return; // 初回移行は完了済み、または元々データが無い新規インストール

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

`legacyCount`が0になった後（＝移行済み後）は毎回の起動で即return するため、何度呼んでも安全（既存の`migrateColumns`と同じ「毎回呼んでも副作用が起きない」設計に合わせる）。

新規インストール（`officer_pay_entries`が空）の場合は「代表者」を自動作成しない。既存の得意先タブ・銀行タブと同じ空状態（「まだ役員が登録されていません。＋役員を追加から始めましょう。」）を役員報酬タブにも表示し、ユーザーが明示的に追加する。

## db.js API変更

### CRUD（`officers`用、`clients`のCRUD関数と同型）

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

### `officer_pay_entries`まわりの変更（既存関数のシグネチャ変更）

```js
export function getOfficerPayEntry(officerId, year, month) {
  return one('SELECT * FROM officer_pay_entries WHERE officer_id=? AND year=? AND month=?', [officerId, year, month]);
}

// 指定月に存在する全役員分のエントリ（ダッシュボード・月次レポートの合計表示、源泉所得税の全役員合算に使う）
export function listOfficerPayEntries(year, month) {
  return all('SELECT * FROM officer_pay_entries WHERE year=? AND month=?', [year, month]);
}

export function findPreviousOfficerPayEntry(officerId, year, month) {
  let target = { year, month };
  for (let i = 0; i < 24; i++) {
    target = prevMonth(target.year, target.month);
    const entry = getOfficerPayEntry(officerId, target.year, target.month);
    if (entry) return { entry, year: target.year, month: target.month };
  }
  return null;
}

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

`employer_insurance_total`はこの関数群の入出力から完全に削除する（呼び出し側は`upsertRentUtilityEntry`経由で書き込む）。

### `rent_utility_entries`まわり

`upsertRentUtilityEntry`のINSERT/UPDATE列・パラメータに`employer_insurance_total`を追加する（他の列と同じ扱い、`e.employer_insurance_total || 0`）。

### `resolveOfficerDeductions`

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

`home_office_deduction`が立っていない役員は、常にゼロを返す（UIもこの役員では家賃・光熱費セクション自体を表示しない）。

### 裏付け判定（`compute*BackingStatus`）

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

export function computeOfficerInsuranceBackingStatus(year, month) {
  const entry = getRentUtilityEntry(year, month);
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
    listOfficerPayEntries(cursor.year, cursor.month).forEach((e) => { expectedTotal += e.withholding_tax || 0; });
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
```

変更点まとめ:
- `computeOfficerNetBackingStatus`: `officerId`引数を追加。`sumLinkedBankAmount`に`officer_id`条件を渡す。
- `computeOfficerInsuranceBackingStatus`: `officerId`引数は無し（会社全体の値）。参照元を`getOfficerPayEntry`から`getRentUtilityEntry`に変更。
- `computeOfficerWithholdingBackingStatus`: `officerId`引数は無し（会社全体の合算）。`getOfficerPayEntry`単発呼び出しを`listOfficerPayEntries`の合算に変更。

### `sumLinkedBankAmount`

`officer_id`条件を追加する：

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

### `linkBankTransaction`

`officer_id`をINSERTの列・パラメータに追加する（`client_id`と同じ扱い）:

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

## 銀行タブ（`js/views/bank.js`）の変更

`openLinkEditor`の`kind='officer_net'`選択時、`client`と同様に役員選択プルダウンを表示する：

```html
<div class="field-row" id="link-officer-row-${txnId}" style="display:none">
  <div class="field-label">役員</div>
  <div class="field-value">
    <select id="link-officer-${txnId}">${officers.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select>
  </div>
</div>
```

`updateVisibility()`に`officer_net`の分岐を追加（`link-officer-row`の表示切替）。確認ボタンのハンドラで`officerId = kind === 'officer_net' ? Number(cell.querySelector(`#link-officer-${txnId}`).value) : null`を取り、`linkBankTransaction`に渡す。`learnBankPayeeAlias`は既存の方針通り`kind==='officer_net'`のときは呼ばない（変更なし、既に対応済み）。

`renderTransactionList`は`listOfficers({ includeArchived: true })`を取得し、`clients`と同様に`linkSummaryHtml`・`openLinkEditor`へ渡す（両関数のシグネチャに`officers`引数を追加）。`linkSummaryHtml`は`ar`の得意先名表示と同じ形で役員名を追加する:

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

## 役員報酬タブ（`js/views/officerpay.js`）の変更

- `ctx`に加えて役員一覧・選択中の役員IDを扱うモジュールレベルの状態（`selectedOfficerId`）を追加。得意先タブ・銀行タブと同じ「＋ 役員を追加」ボタン＋一覧UIをタブ上部に追加する。役員が0人の間は空状態（「まだ役員が登録されていません。」）を表示し、給与入力セクション自体を出さない。
- 役員一覧UIは以下の形（`bank.js`の口座一覧と同型）:
  ```html
  <div class="card">
    <div class="card-header">
      <h2>役員</h2>
      <div class="toolbar"><button class="btn ghost" id="add-officer-btn">＋ 役員を追加</button></div>
    </div>
    <div id="officer-list-slot"></div>
  </div>
  ```
  役員追加フォームには氏名の入力と「自宅の家賃・水道光熱費を天引きする」チェックボックスを持たせる（`home_office_deduction`）。役員名自体の事後リネームUIは作らない（`clients`も同様に作成後の名称変更UIを持たないため、既存の慣習に合わせる）。役員一覧の各行には`bank.js`の口座一覧と同様「休止する／再開する」ボタン（`archiveOfficer`）を置く。`home_office_deduction`は行内に直接チェックボックスを置き、`change`イベントで`upsertOfficer({ ...officer, home_office_deduction: checkbox.checked })`を呼んで即時反映する（`ar.js`の得意先一覧にある`client-trade-start`/`client-trade-end`の行内入力と同じパターン）。
- 既存の給与明細セクション（`payslip`カード以下）は、選択中の役員（`selectedOfficerId`）に対して今まで通り表示・保存する。`getOfficerPayEntry`/`upsertOfficerPayEntry`/`resolveOfficerDeductions`/`findPreviousOfficerPayEntry`/`computeOfficerNetBackingStatus`の呼び出しに`selectedOfficerId`を渡すよう変更する。
- 家賃・水道光熱費天引きセクション（`compact-field`の`manual_rent_deduction`/`manual_utility_deduction`、`auto-deductions`のブロック、「家賃・光熱費の自動反映を使う」チェックボックス）は、選択中の役員が`home_office_deduction`を持つ場合のみ表示する。
- `employer-insurance-block`（社会保険料合計の入力・バッジ）と`officer-withholding-badge-slot`は役員に依存しない（会社全体の値）。表示位置は今まで通り給与明細カード内に残すが、`employer_insurance_total`の読み書きは`getRentUtilityEntry`/`upsertRentUtilityEntry`経由に変更する。`computeOfficerWithholdingBackingStatus`は引数無しの呼び出しのまま（会社全体合算）。
- `BULK_FIELDS`から`employer_insurance_total`を外し、一括入力表は選択中の役員の給与項目だけを扱う（社会保険料合計は会社全体の値であり役員ごとに変わらないため、役員切り替えでの一括表に出すと混乱するため除外する）。
- `renderChart`（推移グラフ）・`renderBulkTable`は選択中の役員のデータのみを対象にする（`getOfficerPayEntry(selectedOfficerId, m.year, m.month)`）。

## ダッシュボード・月次レポートの変更

`js/views/dashboard.js`の`netPayFor(year, month)`と`js/views/report.js`の`payEntry`関連処理を、全役員の合計に変更する。

```js
// dashboard.js
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

`report.js`は`payEntry`（単一役員のエントリ）を複数箇所で参照している（50〜54行目の`deductionRows`/`deductionTotal`/`netPay`の算出、74〜76行目の`statutoryThisMonth`、136行目・196行目の表示テーブルでの`payEntry.gross_pay`参照）。これらすべてを`officerEntries`（全役員の配列）ベースの集計に置き換える:

```js
// report.js: 50〜54行目を置き換え
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

```js
// report.js: 74〜76行目を置き換え
const statutoryThisMonth = officerEntries.reduce((a, e) =>
  a + (e.health_insurance || 0) + (e.nursing_care_insurance || 0) + (e.pension || 0) + (e.child_support_levy || 0), 0);
```

136行目・196行目の`payEntry ? payEntry.gross_pay : 0`は、いずれも`grossPayTotal`に置き換える。

`officerFy`/`statutoryFy`の累計ループ（`monthsToDate.forEach`内、現在は`getOfficerPayEntry(m.year, m.month)`を単発呼び出し）も、`listOfficerPayEntries(m.year, m.month)`で取得した全役員分を合算するよう変更する:

```js
let officerFy = 0, statutoryFy = 0;
monthsToDate.forEach((m) => {
  listOfficerPayEntries(m.year, m.month).forEach((e) => {
    officerFy += e.gross_pay || 0;
    statutoryFy += (e.health_insurance || 0) + (e.nursing_care_insurance || 0) + (e.pension || 0) + (e.child_support_levy || 0);
  });
});
```

`report.js`・`dashboard.js`の冒頭のimport文はどちらも`getOfficerPayEntry`を`listOfficerPayEntries`に差し替える（`report.js`は`getOfficerPayEntry`の呼び出しが無くなるため削除、`dashboard.js`は`netPayFor`内で使うため追加）。

## 非対応（スコープ外）

- 役員ごとの個別ダッシュボード・個別月次レポートは作らない（会社全体の合計値のみ）。
- 役員の並び替えUI（ドラッグ&ドロップ等）は作らない。追加順で表示する。
- `home_office_deduction`を後から役員一覧の編集から切り替えるUIは作るが、切り替えた瞬間に過去月の遡及再計算は行わない（`resolveOfficerDeductions`はその都度の設定値を見るので、表示だけがその場で変わる。過去の確定データを書き換えることはしない）。
