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
// 西暦4桁が無ければ、令和の元号年（例: 「08-06-26」＝令和8年6月26日）として解釈する
// （信用金庫のWeb照会CSV等で、元号の文字を付けずに数字だけの2桁で年を表すことがあるため）。
// 令和1年=2019年なので、西暦 = 令和年 + 2018。
export function parseCsvDate(raw) {
  if (raw == null) return null;
  const s = toHalfWidthDigits(String(raw)).trim();
  const seireki = s.match(/^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?$/);
  if (seireki) {
    const [, y, mo, d] = seireki;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const reiwa = s.match(/^(\d{1,2})[/\-年](\d{1,2})[/\-月](\d{1,2})日?$/);
  if (reiwa) {
    const [, ry, mo, d] = reiwa;
    const year = Number(ry) + 2018;
    return `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

// 列マッピングを1行分のセル配列に適用し、bank_transactions への取込候補に変換する。
// mapping: { dateCol, descCol, payerCol, amountCol, depositCol, withdrawalCol, balanceCol }（列インデックス。使わない列は null）
// amountCol が指定されていれば符号付き1列として扱い、無ければ depositCol/withdrawalCol の2列から符号を作る。
export function mapCsvRow(cells, mapping) {
  const txn_date = parseCsvDate(cells[mapping.dateCol]);

  let amount = null;
  // 一部の銀行（信用金庫のWeb照会CSV等）は、支払/預り金額のうち使わない側の列に
  // 「摘要」ではなく相手先名を入れてくる（出金なら預り金額欄に、入金なら支払金額欄に）。
  // 数値として読めなかった側の生の文字列を、相手先名の手がかりとして拾っておく。
  let counterpartyFromAmountCol = null;
  if (mapping.amountCol != null) {
    amount = parseSignedAmount(cells[mapping.amountCol]);
  } else {
    const depositRaw = mapping.depositCol != null ? cells[mapping.depositCol] : undefined;
    const withdrawalRaw = mapping.withdrawalCol != null ? cells[mapping.withdrawalCol] : undefined;
    const deposit = depositRaw != null ? parseSignedAmount(depositRaw) : null;
    const withdrawal = withdrawalRaw != null ? parseSignedAmount(withdrawalRaw) : null;
    if (deposit != null && deposit !== 0) {
      amount = Math.abs(deposit);
      if (withdrawalRaw && withdrawal == null && withdrawalRaw.trim() !== '') counterpartyFromAmountCol = withdrawalRaw.trim();
    } else if (withdrawal != null && withdrawal !== 0) {
      amount = -Math.abs(withdrawal);
      if (depositRaw && deposit == null && depositRaw.trim() !== '') counterpartyFromAmountCol = depositRaw.trim();
    } else if (deposit === 0 || withdrawal === 0) {
      amount = 0;
    }
  }

  const descParts = [mapping.descCol, mapping.payerCol]
    .filter((c) => c != null)
    .map((c) => cells[c])
    .filter(Boolean);
  if (counterpartyFromAmountCol) descParts.push(counterpartyFromAmountCol);
  const description = descParts.join(' ').trim();

  const balance_after = mapping.balanceCol != null ? parseSignedAmount(cells[mapping.balanceCol]) : null;
  const valid = !!txn_date && !!description && amount != null;
  return { txn_date, description, amount, balance_after, valid, raw_row: JSON.stringify(cells) };
}

// 一部の銀行のCSVは、本題の明細表の前に「口座情報」など列数の異なる別表が
// 入っていることがある（例: 信用金庫のWeb照会CSVで、お取引店・科目・口座番号・
// 口座名義人の4列の表→空行→年月日・摘要・…の5列の明細表、という2段構成になっている）。
// 本題の表を機械的に見つけるため、全行の列数のうち最も多く出現する列数
// （＝明細行の列数）を求め、その列数を持つ最初の行を見出し行とみなす。
// 前置きの別表はそれより前にあるので自動的に無視される。
export function splitHeaderAndRows(table) {
  if (table.length === 0) return { header: [], dataRows: [] };
  const counts = new Map();
  table.forEach((row) => counts.set(row.length, (counts.get(row.length) || 0) + 1));
  let modalLength = table[0].length;
  let modalCount = 0;
  counts.forEach((count, length) => {
    if (count > modalCount) { modalCount = count; modalLength = length; }
  });
  const headerIndex = table.findIndex((row) => row.length === modalLength);
  return { header: table[headerIndex] || [], dataRows: table.slice(headerIndex + 1) };
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
