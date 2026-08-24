// pdf.js の共通セットアップ（ワーカー・CMap・標準フォントの初期化を1箇所にまとめる）。
// CMap/標準フォントが無いと、一部のカード明細PDFのように埋め込みフォントの
// エンコーディングによってはテキストが1文字も抽出できないことがあるため必須。
import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const CMAP_URL = new URL('../vendor/cmaps/', import.meta.url).href;
const STANDARD_FONT_DATA_URL = new URL('../vendor/standard_fonts/', import.meta.url).href;

export function loadPdfDocument(data) {
  return pdfjsLib.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
}

export { pdfjsLib };
