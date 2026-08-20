// 外観のカスタマイズ（背景色・カードの色・パターン・カスタム背景画像）を
// CSS変数 + 動的<style>タグとして適用する。
import { getMeta } from './db.js';

const STYLE_ID = 'theme-overrides';
const MAX_DIMENSION = 1600;

function relativeLuminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 1;
  const c = m[1];
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const r = lin(parseInt(c.slice(0, 2), 16) / 255);
  const g = lin(parseInt(c.slice(2, 4), 16) / 255);
  const b = lin(parseInt(c.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// 構造色（罫線・入力欄の下地）は、ユーザーが選ぶ文字色とは独立に、
// カードの明るさだけを見て自動調整する（罫線が背景に埋もれないように）。
function applySurfaceScheme(root, cardColor) {
  const isDark = relativeLuminance(cardColor) < 0.45;
  if (isDark) {
    root.style.setProperty('--hairline', 'rgba(255,255,255,0.16)');
    root.style.setProperty('--grid-line', 'rgba(255,255,255,0.32)');
    root.style.setProperty('--card-raised', 'color-mix(in srgb, var(--card) 80%, white 20%)');
  } else {
    root.style.setProperty('--hairline', '#DAD1B8');
    root.style.setProperty('--grid-line', '#C9BFA6');
    root.style.setProperty('--card-raised', '#FFFFFF');
  }
}

// 文字色はユーザーの指定をそのまま採用し、控えめ・より控えめの2段階は
// カードの色に向けて混ぜることで作る（色相はそのまま、階層だけ作る）。
function applyInk(root, inkColor) {
  root.style.setProperty('--ink', inkColor);
  root.style.setProperty('--ink-soft', `color-mix(in srgb, ${inkColor} 78%, var(--card))`);
  root.style.setProperty('--ink-muted', `color-mix(in srgb, ${inkColor} 55%, var(--card))`);
  root.style.setProperty('--btn-primary-text', relativeLuminance(inkColor) < 0.5 ? '#FFFFFF' : '#1A1A1A');
}

export function applyTheme() {
  const bgColor = getMeta('theme_bg_color') || '#FBF8F1';
  const cardColor = getMeta('theme_card_color') || '#F7F1E3';
  const inkColor = getMeta('theme_ink_color') || '#22344A';
  const pattern = getMeta('theme_pattern') || 'grid';
  const bgImage = getMeta('theme_bg_image') || '';
  const target = getMeta('theme_bg_image_target') || 'background';

  const root = document.documentElement;
  root.style.setProperty('--paper', bgColor);
  root.style.setProperty('--card', cardColor);
  applySurfaceScheme(root, cardColor);
  applyInk(root, inkColor);

  document.body.classList.remove('pattern-grid', 'pattern-dots', 'pattern-none');
  document.body.classList.add(`pattern-${pattern}`);

  const useForBg = !!bgImage && (target === 'background' || target === 'both');
  const useForCards = !!bgImage && (target === 'cards' || target === 'both');
  document.body.classList.toggle('has-bg-image', useForBg);

  let css = '';
  if (useForBg) {
    css += `body.has-bg-image { background-image: url("${bgImage}"); background-size: cover; background-position: center; background-attachment: fixed; }\n`;
  }
  if (useForCards) {
    css += `.card { background-image: linear-gradient(color-mix(in srgb, var(--card) 85%, transparent), color-mix(in srgb, var(--card) 85%, transparent)), url("${bgImage}"); background-size: cover; background-position: center; }\n`;
  }

  let styleEl = document.getElementById(STYLE_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

// アップロードされた画像を縮小・再エンコードしてから data URL として返す
// （そのまま保存するとスマホ写真などでDBファイルが肥大化するため）
export function fileToResizedDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    reader.onload = () => {
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
