// カード利用明細PDFを解析して、1行ずつの明細（日付・利用店名・金額）に展開する。
// AIは使わず、各カード会社の決まったフォーマットに対して正規表現でパースする。
import { loadPdfDocument } from './pdfjs.js';

// 同じ行の文字要素を、実際の隙間の大きさで単語区切りかどうか判定しながら1つの文字列に復元する。
// pdf.jsは日本語フォントだと1文字ずつ別のテキスト要素として返すことが多く、単純に
// スペースで連結すると「三 井 住 友」のように文字間に余計な空白が入ってしまうため。
function joinRowItems(items) {
  const sorted = [...items].sort((a, b) => a.transform[4] - b.transform[4]);
  let text = '';
  let prevEndX = null;
  sorted.forEach((it) => {
    const x = it.transform[4];
    const fontSize = Math.hypot(it.transform[2], it.transform[3]) || 10;
    if (prevEndX != null && x - prevEndX > fontSize * 0.3) text += ' ';
    text += it.str;
    prevEndX = x + (it.width || 0);
  });
  return text.replace(/\s+/g, ' ').trim();
}

// PDFの各ページからテキストを抽出し、座標が近い（＝同じ行の）文字要素をまとめて
// 1行の文字列に復元する。pdf.jsのgetTextContentは行単位ではなく文字要素単位で返ってくるため。
export async function extractPdfTextRows(blob) {
  const buf = await blob.arrayBuffer();
  const doc = await loadPdfDocument(buf);
  const rows = [];
  for (let i = 1; i <= doc.numPages; i++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(i);
    // eslint-disable-next-line no-await-in-loop
    const content = await page.getTextContent();
    const items = content.items.filter((it) => it.str && it.str.trim());
    items.sort((a, b) => b.transform[5] - a.transform[5]);
    const TOL = 2.5;
    const groups = [];
    let current = null;
    items.forEach((it) => {
      const y = it.transform[5];
      if (current && Math.abs(current.y - y) <= TOL) {
        current.items.push(it);
      } else {
        if (current) groups.push(current);
        current = { y, items: [it] };
      }
    });
    if (current) groups.push(current);
    groups.forEach((g) => {
      const text = joinRowItems(g.items);
      if (text) rows.push(text);
    });
  }
  return rows;
}

function toHalfWidthDigits(s) {
  return String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function toNumber(s) {
  return Number(toHalfWidthDigits(s).replace(/[,，]/g, '')) || 0;
}

// 楽天カード「ご利用代金請求明細書」形式:
// 2026/06/28 イデミツ（アポロステーション） 本人* 1回払い 10,118 0 10,118 10,118 10,118 0
// 末尾の列（利用金額/手数料/支払総額/当月支払額/当月請求額/翌月繰越残高）は月によって5個・6個と変動する。
// 「利用金額」ではなくキャンセル等が反映された「当月請求額」を取りたいので、末尾から2番目の数値を使う
// （翌月繰越残高が省略される月でも、当月請求額は常に末尾から2番目に来る）。
// 実例: キャンセル済みの明細は 2,064 0 2,064 2,064 0 0 のように当月請求額(末尾から2番目)が0になる。
const RAKUTEN_ROW_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(.+?)\s+(\S+\*)\s+(\S+)\s+((?:-?[\d,]+\s*)+)$/;
const RAKUTEN_DATE_ONLY_RE = /^\d{4}\/\d{2}\/\d{2}/;

export function parseRakuten(rows) {
  const transactions = [];
  const unmatched = [];
  rows.forEach((row) => {
    const m = row.match(RAKUTEN_ROW_RE);
    if (m) {
      const [, y, mo, d, merchant, , , numsStr] = m;
      const nums = numsStr.trim().split(/\s+/);
      const billed = nums.length >= 2 ? nums[nums.length - 2] : nums[nums.length - 1];
      transactions.push({ txn_date: `${y}-${mo}-${d}`, description: merchant.trim(), amount: toNumber(billed) });
    } else if (RAKUTEN_DATE_ONLY_RE.test(row)) {
      unmatched.push(row);
    }
  });
  return { transactions, unmatched };
}

// 三井住友カード「お支払い明細」形式（確定後・紙／PDF版）:
// B# 26/06/09 モバイルＰＡＳＭＯチャージ 1,000 １ １ 1,000
// # 26/05/15 ＡＭＡＺＯＮ．ＣＯ．ＪＰ 820 １ １ 820 ◎          ← 先頭が「B#」「#」（文字なし）のどちらもある
// # 26/01/02 ＡＰＰＬＥ．ＣＯＭ／ＪＰ -28,000 １ １ -28,000 返品 ◎ ← 返品はマイナス金額＋末尾に「返品」も付く
const SMBC_ROW_RE = /^(?:\S*#\s+)?(\d{2})\/(\d{2})\/(\d{2})\s+(.+?)\s+(-?[\d,]+)\s+(\S+)\s+(\S+)\s+(-?[\d,]+)(?:\s+\S+)*$/;
const SMBC_DATE_ONLY_RE = /^(?:\S*#\s+)?\d{2}\/\d{2}\/\d{2}/;

export function parseSmbc(rows) {
  const transactions = [];
  const unmatched = [];
  rows.forEach((row) => {
    const m = row.match(SMBC_ROW_RE);
    if (m) {
      const [, yy, mo, d, merchant, amount] = m;
      const year = 2000 + Number(yy);
      transactions.push({ txn_date: `${year}-${mo}-${d}`, description: merchant.trim(), amount: toNumber(amount) });
    } else if (SMBC_DATE_ONLY_RE.test(row)) {
      unmatched.push(row);
    }
  });
  return { transactions, unmatched };
}

// 三井住友カード「WEB明細書（お支払い予定分のご利用明細）」形式（確定前のプレビュー版で、上とは列構成が異なる）:
// 25/12/29 オネスト ご本⼈ 1回払い 26/01 1,980
// ※「本⼈」の⼈がKangxi Radical（⼈ U+2F08）でエンコードされていて標準の「人」と一致しないPDFがあるため、
// 　カード会員区分の文字面には依存せず「○回払い」と「予定月（YY/MM）」という並びだけで判定する。
const SMBC_WEB_ROW_RE = /^(?:\S*#\s+)?(\d{2})\/(\d{2})\/(\d{2})\s+(.+?)\s+\S+\s+\S+払い\s+\d{2}\/\d{2}\s+(-?[\d,]+)(?:\s+\S+)*$/;
const SMBC_WEB_DATE_ONLY_RE = /^(?:\S*#\s+)?\d{2}\/\d{2}\/\d{2}/;

export function parseSmbcWeb(rows) {
  const transactions = [];
  const unmatched = [];
  rows.forEach((row) => {
    const m = row.match(SMBC_WEB_ROW_RE);
    if (m) {
      const [, yy, mo, d, merchant, amount] = m;
      const year = 2000 + Number(yy);
      transactions.push({ txn_date: `${year}-${mo}-${d}`, description: merchant.trim(), amount: toNumber(amount) });
    } else if (SMBC_WEB_DATE_ONLY_RE.test(row)) {
      unmatched.push(row);
    }
  });
  return { transactions, unmatched };
}

const PARSERS = [
  { format: 'rakuten', label: '楽天カード', parse: parseRakuten },
  { format: 'smbc', label: '三井住友カード（SMBC）', parse: parseSmbc },
  { format: 'smbc-web', label: '三井住友カード（SMBC・WEB明細）', parse: parseSmbcWeb },
];

// 発行元のロゴ文字列などをあてにした判定は、フォントのエンコーディング崩れ（例:
// 「三井住友カード」が文字化けして検出できない等）に弱いため使わない。代わりに全パーサーを
// 試し、最も多くの行を取引として認識できたものを採用する（フォーマットが変わっても壊れにくい）。
export function detectAndParse(rows) {
  let best = { format: null, label: null, transactions: [], unmatched: rows };
  PARSERS.forEach((p) => {
    const result = p.parse(rows);
    if (result.transactions.length > best.transactions.length) {
      best = { format: p.format, label: p.label, transactions: result.transactions, unmatched: result.unmatched };
    }
  });
  return best;
}
