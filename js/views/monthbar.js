import { monthLabel, addMonths } from '../format.js';
import { getMonthStatus, setMonthFinalized } from '../db.js';

export function renderMonthBar(container, { year, month, onChange, showFinalize = true }) {
  const status = getMonthStatus(year, month);
  const finalized = !!(status && status.finalized);

  container.innerHTML = `
    <div class="month-bar">
      <div class="stepper">
        <button class="step" data-dir="-1" aria-label="前月へ">&#8249;</button>
        <div class="current-month">${monthLabel(year, month)}</div>
        <button class="step" data-dir="1" aria-label="翌月へ">&#8250;</button>
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
}
