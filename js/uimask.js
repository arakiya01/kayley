// 出力など、途中で他の操作をされると困る処理の間だけ画面全体を覆って操作をブロックする。
let maskEl = null;

export function showMask(message) {
  if (!maskEl) {
    maskEl = document.createElement('div');
    maskEl.className = 'io-mask';
    maskEl.innerHTML = '<div class="io-mask-box"></div>';
    document.body.appendChild(maskEl);
  }
  maskEl.querySelector('.io-mask-box').textContent = message;
}

export function updateMask(message) {
  if (maskEl) maskEl.querySelector('.io-mask-box').textContent = message;
}

export function hideMask() {
  if (maskEl) {
    maskEl.remove();
    maskEl = null;
  }
}
