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

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
