// PDFの中身を、ブラウザ標準のPDFビューア（ツールバー・ズームUIなど）を出さずに、
// スキャンした紙のようにそのままレンダリングして埋め込むためのユーティリティ。
import { loadPdfDocument } from './pdfjs.js';

export async function renderPdfInto(containerEl, blob, { maxWidth = 760 } = {}) {
  const buf = await blob.arrayBuffer();
  const doc = await loadPdfDocument(buf);
  containerEl.innerHTML = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const unscaled = page.getViewport({ scale: 1 });
    const scale = maxWidth / unscaled.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = '100%';
    canvas.style.display = 'block';
    canvas.style.border = '1px solid var(--grid-line)';
    canvas.style.borderRadius = '3px';
    if (i < doc.numPages) canvas.style.marginBottom = '8px';
    // eslint-disable-next-line no-await-in-loop
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    containerEl.appendChild(canvas);
  }
}
