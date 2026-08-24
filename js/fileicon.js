// 添付ファイル（領収書・請求書・明細）をファイル名の文字列リンクではなく、
// 小さなアイコン＋ホバーでファイル名という形で表示するための共通部品。
// 一覧に複数ファイルが並ぶ画面（売掛金の請求書欄・経費の領収書欄など）でのごちゃつきを減らすため。
import { escapeHtml } from './format.js';

const FILE_SVG = `
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
  </svg>
`;

export function fileChipHtml({ name, webViewLink }) {
  const title = escapeHtml(name || '');
  if (webViewLink) {
    return `<a href="${escapeHtml(webViewLink)}" target="_blank" rel="noopener" class="file-chip" title="${title}" aria-label="${title}">${FILE_SVG}</a>`;
  }
  return `<span class="file-chip" title="${title}" aria-label="${title}">${FILE_SVG}</span>`;
}
