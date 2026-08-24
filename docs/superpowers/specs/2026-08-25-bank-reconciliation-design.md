# 銀行明細による裏付け機能 — 設計

## 背景・目的

社長は毎月、ネットバンキングや通帳を見て売掛金の入金があったかを目で突合し、Kayley に手で金額を打ち込んでいる。さらに毎月、税理士へ通帳のコピーを提出している。この「帳簿と通帳を突き合わせる」作業を、Kayley の中で先取りしたい。

1年後に真であってほしいこと（ユーザーが明示的に選んだゴール）: **「入金されたかを Kayley だけで確認できる」**。これは「自動入力される」ではなく「確認できる」であることに注意する。この違いが設計全体を決める。

## 大原則

銀行明細は、既存4タブ（売掛金・家賃・役員報酬・経費）の**裏付け役に徹する**。銀行データは `ar_entries` / `rent_utility_entries` / `officer_pay_entries` / `statement_transactions` のいずれにも書き込まない。これらのテーブルは今まで通り人間が入力する場所のままであり、銀行明細タブは読むだけの照合層として存在する。

この原則により、初期の検討で挙がっていた危険（二重計上、`upsertArEntry()` による上書き消失、再取込での消込破壊、`unpaidStreak()` の破綻など）は、書き込みが発生しないことでほぼすべて回避される。

## スコープ外（v1でやらないこと）

- 社会保険料率の計算式による自動算出（標準報酬月額の等級・都道府県別料率・年齢による介護保険有無などは Kayley が持つには不安定すぎる。手入力に徹する）
- 外貨（`clients.currency` は存在するが、口座・売掛金とも当面 JPY のみを前提とする）
- 現金の銀行照合（現金はそもそも銀行に痕跡がない）
- AI・外部通信を使った名寄せ（既存の `accountMatchKey()` / `account_rules` と同じ、ローカルの文字列正規化のみ）
- 4タブへの自動書き込み・自動入力（前述の大原則）
- 月次レポート（`report.js`）への反映（このタブ自体が固まってからの拡張候補として保留）
- カード会社別・銀行別の固定パーサー（`statementparsers.js` のカード方式を銀行CSVに持ち込まない。理由は後述）

## データモデル

新規テーブル4つ、既存テーブルへの列追加1つ。既存の `SCHEMA` / `migrateColumns()` の書き方に合わせる。

```sql
CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  csv_encoding TEXT,        -- 学習済みの文字コード（初回取込時に決まる。'utf-8' | 'shift_jis' など）
  csv_mapping_json TEXT,    -- 学習済みの列対応（JSON: 日付/摘要/振込名義/入金額/出金額/残高の列インデックス）
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  txn_date TEXT NOT NULL,       -- YYYY-MM-DD
  description TEXT NOT NULL,   -- 摘要・振込名義（原文のまま。表示時にエスケープする）
  amount INTEGER NOT NULL,     -- 符号付き。入金は正、出金は負
  balance_after INTEGER,       -- CSVに残高列があれば。無ければ NULL
  fingerprint TEXT NOT NULL,   -- 再取込時の重複検出キー
  raw_row TEXT,                -- 元のCSV行（トラブル時の確認用）
  UNIQUE(bank_account_id, fingerprint)
);

-- 「この銀行取引が何を裏付けているか」を1件ずつ記録する薄いリンク。
-- 配分・分割ロジックは持たない。1銀行取引は1つの裏付け先にのみ紐づく。
CREATE TABLE IF NOT EXISTS bank_transaction_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions(id),
  kind TEXT NOT NULL,          -- 'rent' | 'ar' | 'officer_net' | 'officer_insurance' | 'officer_withholding' | 'irregular'
  client_id INTEGER REFERENCES clients(id),   -- kind='ar' のときのみ使用
  category TEXT,               -- kind='irregular' のときのみ使用（後述の固定リストか自由入力）
  period_start_year INTEGER, period_start_month INTEGER,
  period_end_year INTEGER, period_end_month INTEGER,
  -- 単月の裏付け（rent/officer_net/officer_insurance）は period_start = period_end = その月。
  -- officer_withholding の半年集計や、irregular の年度更新などは複数月にまたがる。
  note TEXT,
  confirmed_at TEXT NOT NULL
);

-- 摘要・振込名義 → 裏付け先の学習。account_rules と同じ設計（正規化キーは
-- accountMatchKey() をそのまま再利用し、数字や日付は落とさない）。
CREATE TABLE IF NOT EXISTS bank_payee_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  category TEXT,
  updated_at TEXT NOT NULL
);
```

既存テーブルへの追加（`migrateColumns()` 経由）:

```sql
ALTER TABLE officer_pay_entries ADD COLUMN employer_insurance_total INTEGER;
```

`employer_insurance_total` は「会社負担込みの社会保険料（月額・年金事務所への実際の引き落とし額）」。役員報酬タブの**手取り計算（`netPayFor` / 控除合計）には一切関与しない**。銀行照合専用の参考値であり、既存の `health_insurance` / `nursing_care_insurance` / `pension`（本人負担分）とは独立して持つ。Round C で実装した前月引き継ぎ（`findPreviousOfficerPayEntry`）の対象フィールドに追加し、家賃と同じ「めったに変わらない固定額」として扱う。

## 不定型支出のカテゴリ（固定リスト・自由入力可）

`bank_transaction_links.category`（`kind='irregular'` のとき）の初期候補:

```js
export const IRREGULAR_CATEGORIES = [
  '源泉所得税（納期の特例）', '住民税特別徴収', '法人税等予定納税',
  '消費税中間納付', '労働保険年度更新', 'その他',
];
```

`account_rules` の `ACCOUNT_TITLES` と同じ位置づけ。一致するものが無ければ「その他」に寄せ、税理士側での確認を前提とする。

## タブごとの照合の中身

| タブ | 対応する銀行取引 | 照合の粒度 | 備考 |
|---|---|---|---|
| 家賃 | 大家さんへの1本の振込 | 単月・ほぼ1:1 | 一番簡単。名義を一度学習すれば高確度で自動照合できる |
| 売掛金 | 得意先からの入金（複数月にまたがりうる） | 期間累計の比較 | 月ごとの完全一致は強制しない。学習した振込名義からの入金累計と `ar_entries.payment` の累計を、直近の期間で突き合わせて差額を示す |
| 役員報酬（手取り） | 役員個人口座への振込 | 単月・ほぼ1:1 | `officer_net` |
| 役員報酬（社会保険料） | 年金事務所への引き落とし | 単月 | `officer_insurance`。比較対象は新設の `employer_insurance_total`（本人負担分ではない） |
| 役員報酬（源泉所得税） | 税務署への納付（納期の特例のため年2回） | **半年集計** | `officer_withholding`。1月・7月の納付のみ、直前6ヶ月分の `officer_pay_entries.withholding_tax` の合計と突き合わせる。それ以外の月は「次の納期まで判定なし」と表示し、未照合扱いにはしない |
| 経費 | カード発行会社の引き落とし（1本、締め日のズレあり） | 参考情報のみ | 締め日と支払日が暦月とズレるのが前提（Kayley は明細を利用日の暦月で束ねている）。合否判定はせず、月の利用合計に対して前後の妥当な時期の引き落としを候補として見せるだけに留める |
| （上記に当たらない支出） | 不定型 | タグ付けのみ | `irregular`。源泉所得税・住民税・予定納税など。カテゴリと期間を付けて記録するが、自動の合否判定は行わない（源泉所得税の半年集計を除く） |

## CSV取込の仕組み

### なぜカード明細PDFと同じ「銀行別固定パーサー」にしないか

`js/statementparsers.js` はカード会社ごとに正規表現パーサーを書き、認識件数が最大のものを採用する方式（`parseRakuten` / `parseSmbc` / `parseSmbcWeb` / `detectAndParse`）。カードは枚数が少ないため成立するが、日本の銀行は列構成も文字コードもバラバラで、銀行を変えるたびにコードを書く羽目になる。**銀行ごとにコードを書くのではなく、口座ごとに列対応を一度だけ覚える方式**にする。

### 処理の流れ

1. **文字コード判定**: BOM（UTF-8 BOMあり/なし）の有無をまず見る。無ければ UTF-8 として厳密デコードを試み、失敗するか文字化けの兆候があれば Shift_JIS で再デコードする。`TextDecoder('shift_jis')` はモダンブラウザの標準機能であり、追加ライブラリは不要（既存の「npmパッケージを追加しない」制約に合致）。
2. **CSV構文解析**: 単純な `split(',')` ではなく、引用符・引用符内のカンマ・改行を正しく扱う最小限のパーサーを自前で書く（Codexの指摘通り、既存の `toNumber()` のような「失敗したら0」という扱いは金額・日付の解析では絶対にしない。解析できなかった行はエラー行として別途ユーザーに見せる）。
3. **列マッピング**: その口座で初めての取込のときだけ、プレビュー行を見ながら「どの列が日付/摘要/振込名義/入金額(または符号付き金額)/出金額/残高か」を選ぶ簡単なUIを出す。選んだ内容は `bank_accounts.csv_mapping_json` に保存し、次回以降は自動適用する。銀行がフォーマットを変えたときだけ再マッピングすればよい。
4. **残高検算**: CSVに残高列があれば、「前行残高＋入金−出金＝当該行残高」を検算する。合わなければ警告を出すが、取込自体は止めない（銀行明細は月ごとに分けてダウンロードすることが多く、期間の欠けは正常にありうるため）。
5. **重複排除**: `fingerprint`（日付＋金額＋摘要＋残高などから生成）で `UNIQUE(bank_account_id, fingerprint)` により再取込時の重複を防ぐ。同一日・同一金額・同一摘要の正当な複数取引を区別するため、同一内容行の出現順もフィンガープリントの材料に含める。

## 画面の形

新規「銀行」タブを追加する（`js/app.js` の `TABS` 配列に、既存の5タブと並ぶ形で追加。`needsMonth` は false — 銀行タブ自体は口座横断・全期間の明細一覧であり、月選択に依存しない）。

- 口座一覧＋口座ごとの取込ボタン
- 明細一覧（フィルタ: 未分類 / 裏付け済み / 不定型）
- 各明細に「内訳」アクション: 家賃／売掛金（得意先を選択）／役員報酬・手取り／役員報酬・社会保険料／役員報酬・源泉所得税／不定型（カテゴリ選択）／その他
- 一度紐付けると `bank_payee_aliases` に学習され、同じ振込名義の次の取引は自動で提案される（経費タブの科目学習と同じ挙動。既存の未確定分のみへの自動適用、確定済みの上書きはしない、という既存の `applyAccountRulesToMonth` のルールをそのまま踏襲する）

既存4タブ側には、該当する数字の近くに小さな照合バッジ（済／未／差額あり）を置く:

- 家賃タブ: 家賃実額の入力欄の近く
- 役員報酬タブ: 差引支給額の近く（`officer_net`）、新設の `employer_insurance_total` 入力欄の近く（`officer_insurance`）、源泉所得税欄の近く（`officer_withholding`、1月・7月のみ判定あり、それ以外は非表示）
- 売掛金タブ: 各得意先の入金列の近く

経費タブには v1 ではバッジを置かない（「参考情報のみ」で合否判定をしないため、済/未のバッジ語彙とは相性が悪い）。カードの引き落とし候補は銀行タブ側の明細詳細でのみ確認できればよい。

バッジを押すと銀行タブの該当明細にフィルタ済みで飛ぶ。

## 実装の参照点（既存コードとの対応）

- 摘要の正規化: `accountMatchKey()`（`js/db.js`）をそのまま流用。数字・日付は落とさない方針を維持する
- 学習の非破壊原則: `learnAccountRule()` / `applyAccountRulesToMonth()` と同じパターンで `bank_payee_aliases` への学習・自動適用を実装する。空の分類ではルールを作らない、既存の確定済みリンクは上書きしないという2点を踏襲する
- 前月引き継ぎ: `findPreviousOfficerPayEntry()` の引き継ぎ対象フィールドに `employer_insurance_total` を追加する（Round C で実装済みの機構にそのまま乗せる）
- 完了判定・通知への影響: `getSectionCompletion()` は変更しない（銀行照合は裏付けであり、4タブの完了判定はこれまで通り4タブ自身のデータで決まる）。ただし銀行タブ自体に「未照合が◯件」を出す独自の状態表示は持ってよい
- データ変更通知: `onDataChange()`（`js/db.js`）は銀行明細の取込・リンク確定でも呼ばれるようにする（他の書き込みと同じ扱い）

## 未解決・実装時に詰める点

- CSV列マッピングUIの具体的なコンポーネント設計（プレビュー行数、列選択のUI）は実装計画側で詳細化する
- 売掛金の「期間累計比較」で、どの範囲（今期のみ／直近12ヶ月など）をデフォルトの比較窓とするかは実装時に決める
- 経費タブの「参考情報」表示の具体的な文言・見せ方は実装時に決める
