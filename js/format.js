export function yen(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('ja-JP');
}

export function yenSigned(n) {
  const v = Math.round(Number(n) || 0);
  const s = v.toLocaleString('ja-JP');
  return v > 0 ? `+${s}` : s;
}

export function monthLabel(year, month) {
  return `${year}年${month}月`;
}

export function monthShort(month) {
  return `${month}月`;
}

export function todayYearMonth() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function addMonths(year, month, delta) {
  const idx = (year * 12 + (month - 1)) + delta;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return { year: y, month: m };
}

export function last12Months(year, month) {
  const out = [];
  for (let i = 11; i >= 0; i--) out.push(addMonths(year, month, -i));
  return out;
}

// 会計年度の開始月を基準に、指定した年月を含む年度の開始年を求める
export function fiscalYearStartOf(year, month, fyStartMonth) {
  return month >= fyStartMonth ? year : year - 1;
}

// 会計年度の開始年から、その年度に含まれる12ヶ月分を返す
export function fiscalYearMonths(fyStartYear, fyStartMonth) {
  return Array.from({ length: 12 }, (_, i) => addMonths(fyStartYear, fyStartMonth, i));
}

// グラフの見出し用: 「第2期（2026年8月〜2027年7月）」（創業年月が未設定なら期番号なしで期間だけ）
export function fiscalPeriodHeading(year, month, fyStartMonth, foundingDate) {
  const fyStartYear = fiscalYearStartOf(year, month, fyStartMonth);
  const months = fiscalYearMonths(fyStartYear, fyStartMonth);
  const range = `${monthLabel(months[0].year, months[0].month)} 〜 ${monthLabel(months[11].year, months[11].month)}`;
  if (!foundingDate) return range;
  const foundingFyYear = fiscalYearStartOf(foundingDate.year, foundingDate.month, fyStartMonth);
  const periodNumber = fyStartYear - foundingFyYear + 1;
  return `第${periodNumber}期（${range}）`;
}

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
