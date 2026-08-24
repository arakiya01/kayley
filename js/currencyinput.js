export function parseCurrencyInput(value) {
  const parsed = Number(String(value).replace(/[,\s¥円]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatCurrencyInput(value) {
  return parseCurrencyInput(value).toLocaleString('ja-JP');
}

export function enableCurrencyInput(el) {
  el.value = formatCurrencyInput(el.value);
  el.addEventListener('focus', () => { el.value = String(parseCurrencyInput(el.value)); });
  el.addEventListener('blur', () => { el.value = formatCurrencyInput(el.value); });
}
