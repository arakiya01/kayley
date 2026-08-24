// 各画面共通の年月ナビゲーション。年度は前後の矢印かプルダウンで選び、
// 月は「月次確定状況」と同じ形の帯から直接クリックして選ぶ（ダッシュボードと統一）。
import { monthLabel, monthShort, fiscalYearStartOf, fiscalYearMonths, todayYearMonth } from '../format.js';
import { getMonthStatus, setMonthFinalized, isMonthAllowed, getMeta, getFoundingDate } from '../db.js';
import { renderFySelector } from './fyselector.js';

export function renderMonthBar(container, { year, month, onChange, showFinalize = true }) {
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  const foundingDate = getFoundingDate();
  const fyStartYear = fiscalYearStartOf(year, month, fyStartMonth);
  const months = fiscalYearMonths(fyStartYear, fyStartMonth);
  const currentIndex = months.findIndex((m) => m.year === year && m.month === month);
  const today = todayYearMonth();
  const todayIdx = today.year * 12 + today.month;
  const currentFy = fiscalYearStartOf(today.year, today.month, fyStartMonth);

  const status = getMonthStatus(year, month);
  const finalized = !!(status && status.finalized);

  container.innerHTML = `
    <div class="month-bar">
      <div class="month-bar-main">
        <div id="fy-selector-slot"></div>
        <div class="status-strip">
          ${months.map((m, i) => {
            const allowed = isMonthAllowed(m.year, m.month);
            const isFuture = m.year * 12 + m.month > todayIdx;
            let cls = 'warning';
            let title = `${monthLabel(m.year, m.month)}：未確定`;
            if (!allowed) { cls = 'disabled'; title = `${monthLabel(m.year, m.month)}：創業前`; }
            else if (isFuture) { cls = 'future'; title = `${monthLabel(m.year, m.month)}：未来`; }
            else {
              const st = getMonthStatus(m.year, m.month);
              if (st && st.finalized) { cls = 'good'; title = `${monthLabel(m.year, m.month)}：確定済み`; }
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
      ${showFinalize ? `
        <div class="finalize-badge">
          <button class="stamp ${finalized ? 'stamped' : ''}" id="stamp-btn" title="${finalized ? 'この月は確定済みです。もう一度押すと解除します' : 'この月のデータを確定します'}">確定</button>
          <span class="stamp-status-text">${finalized ? `<strong>確定済</strong>` : '未確定（入力中）'}</span>
        </div>
      ` : ''}
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

  const stampBtn = container.querySelector('#stamp-btn');
  if (stampBtn) {
    stampBtn.addEventListener('click', () => {
      setMonthFinalized(year, month, !finalized);
      onChange(year, month);
    });
  }
}
