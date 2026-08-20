// 一括入力モード共通の「年度選択」UI（‹›の1年送り＋直接選べるプルダウン）。
import { fiscalYearMonths, fiscalYearStartOf, monthLabel, todayYearMonth } from '../format.js';

export function renderFySelector(container, { fyStartYear, fyStartMonth, foundingDate, noteText, onChange }) {
  const today = todayYearMonth();
  const currentFy = fiscalYearStartOf(today.year, today.month, fyStartMonth);
  const earliestFy = foundingDate ? fiscalYearStartOf(foundingDate.year, foundingDate.month, fyStartMonth) : currentFy - 6;
  const latestFy = Math.max(currentFy + 1, fyStartYear);

  const options = [];
  for (let y = Math.min(earliestFy, fyStartYear); y <= latestFy; y++) options.push(y);

  container.innerHTML = `
    <div class="toolbar" style="margin-bottom:10px">
      <div class="stepper">
        <button class="btn ghost step" data-dir="-1" aria-label="前年度へ">‹</button>
        <select id="fy-select" aria-label="年度を選択" style="border:none;background:transparent;font-family:var(--font-display);font-weight:700;font-size:15px;color:var(--ink);padding:4px 8px">
          ${options.map((y) => {
            const end = fiscalYearMonths(y, fyStartMonth)[11];
            return `<option value="${y}" ${y === fyStartYear ? 'selected' : ''}>${monthLabel(y, fyStartMonth)} 〜 ${monthLabel(end.year, end.month)}</option>`;
          }).join('')}
        </select>
        <button class="btn ghost step" data-dir="1" aria-label="翌年度へ">›</button>
      </div>
      ${noteText ? `<span class="card-note" style="margin:0">${noteText}</span>` : ''}
    </div>
  `;

  container.querySelectorAll('.step').forEach((btn) => {
    btn.addEventListener('click', () => onChange(fyStartYear + Number(btn.dataset.dir)));
  });
  container.querySelector('#fy-select').addEventListener('change', (e) => {
    onChange(Number(e.target.value));
  });
}
