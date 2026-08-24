// 銀行照合バッジの見た目を1箇所にまとめる。rent.js / officerpay.js / ar.js から共通で使う。
import { yen } from './format.js';

export function bankBadgeHtml(status) {
  if (status.status === 'not_applicable') return '';
  if (status.status === 'none') {
    return `<a href="#/bank" class="badge muted bank-badge" title="銀行明細と照合する取引がまだありません">銀行未照合</a>`;
  }
  if (status.status === 'matched') {
    return `<a href="#/bank" class="badge good bank-badge" title="銀行明細（${yen(status.bankAmount)}円）と一致">銀行照合済み</a>`;
  }
  const diff = status.bankAmount - status.expectedTotal;
  const sign = diff > 0 ? '+' : '';
  return `<a href="#/bank" class="badge warning bank-badge" title="入力値 ${yen(status.expectedTotal)}円 / 銀行 ${yen(status.bankAmount)}円">差額 ${sign}${yen(diff)}円</a>`;
}
