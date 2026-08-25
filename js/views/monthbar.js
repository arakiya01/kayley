// 各画面共通の年月ナビゲーション。年度は前後の矢印かプルダウンで選び、
// 月は各セクションの完了状況を示す帯から直接クリックして選ぶ。
import { monthLabel, monthShort, fiscalYearStartOf, fiscalYearMonths, todayYearMonth, fiscalPeriodHeading } from '../format.js';
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
  const currentFyEarliest = foundingDate ? fiscalYearStartOf(foundingDate.year, foundingDate.month, fyStartMonth) : currentFy - 6;
  const periodLabel = foundingDate ? `第${fyStartYear - currentFyEarliest + 1}期` : `${monthLabel(fyStartYear, fyStartMonth)}〜`;
  const periodTitle = fiscalPeriodHeading(year, month, fyStartMonth, foundingDate);
  const canGoPrevFy = fyStartYear > currentFyEarliest;
  const canGoNextFy = fyStartYear < currentFy;

  // 期を切り替えて、前の期なら最終月、次の期なら初月に着地する
  // （期セレクタのプルダウン・ステッパー・月バー両端の矢印すべてで共通の挙動）
  function goToFy(newFyStartYear) {
    const newMonths = fiscalYearMonths(newFyStartYear, fyStartMonth);
    const target = newFyStartYear < fyStartYear ? newMonths[11]
      : newFyStartYear > fyStartYear ? newMonths[0]
      : newMonths[currentIndex >= 0 ? currentIndex : 0];
    onChange(target.year, target.month);
  }

  container.innerHTML = `
    <div class="month-bar">
      <button type="button" class="fy-toggle" id="fy-toggle" aria-expanded="false" title="${periodTitle}">
        <span>${periodLabel}</span>
        <span class="fy-toggle-caret">▾</span>
      </button>
      <button type="button" class="fy-nav-btn" id="fy-prev" aria-label="前期へ" title="前期へ" ${canGoPrevFy ? '' : 'disabled'}>‹</button>
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
            const sectionValues = Object.values(completion);
            const doneCount = sectionValues.filter(Boolean).length;
            cls = doneCount === 0 ? 'critical' : doneCount === sectionValues.length ? 'good' : 'warning';
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
      <button type="button" class="fy-nav-btn" id="fy-next" aria-label="翌期へ" title="翌期へ" ${canGoNextFy ? '' : 'disabled'}>›</button>
    </div>
    <div class="fy-panel" id="fy-panel">
      <div class="fy-panel-inner">
        <div id="fy-selector-slot"></div>
      </div>
    </div>
  `;

  renderFySelector(container.querySelector('#fy-selector-slot'), {
    fyStartYear,
    fyStartMonth,
    foundingDate,
    noteText: '',
    maxFyStartYear: currentFy,
    showBadge: false,
    onChange: goToFy,
  });

  const fyToggle = container.querySelector('#fy-toggle');
  const fyPanel = container.querySelector('#fy-panel');
  fyToggle.addEventListener('click', () => {
    const open = fyPanel.classList.toggle('open');
    fyToggle.setAttribute('aria-expanded', String(open));
  });

  if (canGoPrevFy) container.querySelector('#fy-prev').addEventListener('click', () => goToFy(fyStartYear - 1));
  if (canGoNextFy) container.querySelector('#fy-next').addEventListener('click', () => goToFy(fyStartYear + 1));

  container.querySelectorAll('.status-strip .pill:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => onChange(Number(btn.dataset.year), Number(btn.dataset.month)));
  });
}
