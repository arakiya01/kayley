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
