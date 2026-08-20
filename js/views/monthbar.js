import { monthLabel, addMonths } from '../format.js';
import { getMonthStatus, setMonthFinalized, isMonthAllowed } from '../db.js';

let outsideClickBound = false;
function closeAllPopovers(except) {
  document.querySelectorAll('.month-popover.open').forEach((p) => {
    if (p !== except) p.classList.remove('open');
  });
}
function bindOutsideClickOnce() {
  if (outsideClickBound) return;
  outsideClickBound = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest('.month-picker-wrap')) return;
    closeAllPopovers(null);
  });
}

export function renderMonthBar(container, { year, month, onChange, showFinalize = true }) {
  bindOutsideClickOnce();
  const status = getMonthStatus(year, month);
  const finalized = !!(status && status.finalized);
  const prevMonthPoint = addMonths(year, month, -1);
  const canGoPrev = isMonthAllowed(prevMonthPoint.year, prevMonthPoint.month);

  container.innerHTML = `
    <div class="month-bar">
      <div class="stepper month-picker-wrap" style="position:relative">
        <button class="step" data-dir="-1" aria-label="前月へ" ${canGoPrev ? '' : 'disabled'}>&#8249;</button>
        <button class="current-month" id="month-picker-toggle" type="button" style="background:none;border:none;cursor:pointer;font-family:inherit">${monthLabel(year, month)}</button>
        <button class="step" data-dir="1" aria-label="翌月へ">&#8250;</button>
        <div class="month-popover" id="month-popover"></div>
      </div>
      ${showFinalize ? `
        <div class="finalize-badge">
          <button class="stamp ${finalized ? 'stamped' : ''}" id="stamp-btn" title="${finalized ? 'この月は確定済みです。もう一度押すと解除します' : 'この月のデータを確定します'}">確定</button>
          <span class="stamp-status-text">${finalized ? `<strong>確定済</strong>` : '未確定（入力中）'}</span>
        </div>
      ` : ''}
    </div>
  `;

  container.querySelectorAll('.step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = Number(btn.dataset.dir);
      const next = addMonths(year, month, dir);
      onChange(next.year, next.month);
    });
  });

  const stampBtn = container.querySelector('#stamp-btn');
  if (stampBtn) {
    stampBtn.addEventListener('click', () => {
      setMonthFinalized(year, month, !finalized);
      onChange(year, month);
    });
  }

  // ---- 年月ピッカー（ポップオーバー） ----
  let popoverYear = year;
  const popover = container.querySelector('#month-popover');

  function renderPopover() {
    const monthNames = Array.from({ length: 12 }, (_, i) => i + 1);
    popover.innerHTML = `
      <div class="popover-year-row">
        <button class="btn ghost year-step" data-dir="-1" aria-label="前年へ">&#8249;</button>
        <div class="popover-year-label">${popoverYear}年</div>
        <button class="btn ghost year-step" data-dir="1" aria-label="翌年へ">&#8250;</button>
      </div>
      <div class="popover-month-grid">
        ${monthNames.map((m) => {
          const allowed = isMonthAllowed(popoverYear, m);
          const isSelected = popoverYear === year && m === month;
          return `<button class="popover-month-btn ${isSelected ? 'selected' : ''}" data-year="${popoverYear}" data-month="${m}" ${allowed ? '' : 'disabled'}>${m}月</button>`;
        }).join('')}
      </div>
    `;
    popover.querySelectorAll('.year-step').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        popoverYear += Number(btn.dataset.dir);
        renderPopover();
      });
    });
    popover.querySelectorAll('.popover-month-btn:not(:disabled)').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.classList.remove('open');
        onChange(Number(btn.dataset.year), Number(btn.dataset.month));
      });
    });
  }

  renderPopover();

  container.querySelector('#month-picker-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !popover.classList.contains('open');
    closeAllPopovers(popover);
    popoverYear = year;
    renderPopover();
    popover.classList.toggle('open', willOpen);
  });

  popover.addEventListener('click', (e) => e.stopPropagation());
}
