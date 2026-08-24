// 各画面共通の年月ナビゲーション。年度は前後の矢印かプルダウンで選び、
// 月は各セクションの完了状況を示す帯から直接クリックして選ぶ。
import { monthLabel, monthShort, fiscalYearStartOf, fiscalYearMonths, todayYearMonth } from '../format.js';
import { getSectionCompletion, isMonthAllowed, getMeta, getFoundingDate } from '../db.js';
import { renderFySelector } from './fyselector.js';

export function renderMonthBar(container, { year, month, onChange }) {
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  const foundingDate = getFoundingDate();
  const fyStartYear = fiscalYearStartOf(year, month, fyStartMonth);
  const months = fiscalYearMonths(fyStartYear, fyStartMonth);
  const currentIndex = months.findIndex((m) => m.year === year && m.month === month);
  const today = todayYearMonth();
  const todayIdx = today.year * 12 + today.month;
  const currentFy = fiscalYearStartOf(today.year, today.month, fyStartMonth);

  container.innerHTML = `
    <div class="month-bar">
      <div class="month-bar-main">
        <div id="fy-selector-slot"></div>
        <div class="status-strip">
          ${months.map((m, i) => {
            const allowed = isMonthAllowed(m.year, m.month);
            const isFuture = m.year * 12 + m.month > todayIdx;
            let cls = 'critical';
            let title = `${monthLabel(m.year, m.month)}：0件完了`;
            if (!allowed) { cls = 'disabled'; title = `${monthLabel(m.year, m.month)}：創業前`; }
            else if (isFuture) { cls = 'future'; title = `${monthLabel(m.year, m.month)}：未来`; }
            else {
              const completion = getSectionCompletion(m.year, m.month);
              const doneCount = Object.values(completion).filter(Boolean).length;
              cls = doneCount === 0 ? 'critical' : doneCount === 5 ? 'good' : 'warning';
              title = `${monthLabel(m.year, m.month)}：${doneCount}件完了`;
            }
            return `
              <button class="pill ${cls} ${i === currentIndex ? 'current' : ''}" title="${title}"
                data-year="${m.year}" data-month="${m.month}" ${(!allowed || isFuture) ? 'disabled' : ''}>
                <span class="dot"></span>
                <span>${monthShort(m.month)}</span>
              </button>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;

  renderFySelector(container.querySelector('#fy-selector-slot'), {
    fyStartYear,
    fyStartMonth,
    foundingDate,
    noteText: '',
    maxFyStartYear: currentFy,
    onChange: (newFyStartYear) => {
      const newMonths = fiscalYearMonths(newFyStartYear, fyStartMonth);
      // 前の期に移動したら最終月、次の期に移動したら初月を選択する
      const target = newFyStartYear < fyStartYear ? newMonths[11]
        : newFyStartYear > fyStartYear ? newMonths[0]
        : newMonths[currentIndex >= 0 ? currentIndex : 0];
      onChange(target.year, target.month);
    },
  });

  container.querySelectorAll('.status-strip .pill:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => onChange(Number(btn.dataset.year), Number(btn.dataset.month)));
  });
}
