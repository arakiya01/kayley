// カテゴリ配色は固定順・固定割当（dataviz skill の検証済み4色）。5件目以降は「その他」に畳む。
export const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
export const OTHER_COLOR = 'var(--ink-muted)';

export function seriesColor(index) {
  return SERIES_COLORS[index] ?? OTHER_COLOR;
}

// items: [{key,label,value}] を先頭4件 + 残りを「その他」に集約
export function foldToFour(items, otherLabel = 'その他') {
  if (items.length <= SERIES_COLORS.length) return items;
  const head = items.slice(0, SERIES_COLORS.length - 1);
  const restSum = items.slice(SERIES_COLORS.length - 1).reduce((a, b) => a + b.value, 0);
  head.push({ key: '__other', label: otherLabel, value: restSum });
  return head;
}

// items: [{label, values:number[]}] を先頭3件 + 残りを要素ごとに合算した「その他」に畳む
export function foldSeriesArrays(items, otherLabel = 'その他') {
  if (items.length <= SERIES_COLORS.length) return items;
  const head = items.slice(0, SERIES_COLORS.length - 1);
  const rest = items.slice(SERIES_COLORS.length - 1);
  const len = rest[0]?.values.length || 0;
  const otherValues = Array.from({ length: len }, (_, i) => rest.reduce((a, s) => a + (s.values[i] || 0), 0));
  head.push({ label: otherLabel, values: otherValues });
  return head;
}
