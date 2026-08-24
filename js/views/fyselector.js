// 一括入力モード共通の「年度選択」UI（‹›の1年送り＋直接選べるプルダウン）。
import { fiscalYearMonths, fiscalYearStartOf, monthLabel, todayYearMonth } from '../format.js';

export function renderFySelector(container, {
  fyStartYear, fyStartMonth, foundingDate, noteText, onChange, maxFyStartYear = null,
}) {
  const today = todayYearMonth();
  const currentFy = fiscalYearStartOf(today.year, today.month, fyStartMonth);
  const earliestFy = foundingDate ? fiscalYearStartOf(foundingDate.year, foundingDate.month, fyStartMonth) : currentFy - 6;

  // 創業期より前を指していたら、ここで一度だけ補正して呼び出し元に伝える
  // （‹ を連打した後・設定変更後など、どんな経路で来ても必ず1期目以降に戻す）。
  if (fyStartYear < earliestFy) {
    onChange(earliestFy);
    return;
  }

  // maxFyStartYear が指定されていれば、それより先の年度には進めない
  // （月次ナビゲーションでは「まだ来ていない期」を選べないようにするため）。
  const latestFy = maxFyStartYear != null ? Math.max(maxFyStartYear, fyStartYear) : Math.max(currentFy + 1, fyStartYear);
  const options = [];
  for (let y = earliestFy; y <= latestFy; y++) options.push(y);

  const periodLabel = foundingDate ? `第${fyStartYear - earliestFy + 1}期` : '';
  const canGoPrev = fyStartYear > earliestFy;
  const canGoNext = maxFyStartYear == null || fyStartYear < maxFyStartYear;

  container.innerHTML = `
    <div class="toolbar" style="margin-bottom:10px">
      <div class="stepper">
        <button class="btn ghost step" data-dir="-1" aria-label="前年度へ" ${canGoPrev ? '' : 'disabled'}>‹</button>
        <select id="fy-select" aria-label="年度を選択" style="border:none;background:transparent;font-family:var(--font-display);font-weight:700;font-size:15px;color:var(--ink);padding:4px 8px">
          ${options.map((y) => {
            const end = fiscalYearMonths(y, fyStartMonth)[11];
            const label = foundingDate ? `第${y - earliestFy + 1}期（${monthLabel(y, fyStartMonth)} 〜 ${monthLabel(end.year, end.month)}）` : `${monthLabel(y, fyStartMonth)} 〜 ${monthLabel(end.year, end.month)}`;
            return `<option value="${y}" ${y === fyStartYear ? 'selected' : ''}>${label}</option>`;
          }).join('')}
        </select>
        <button class="btn ghost step" data-dir="1" aria-label="翌年度へ" ${canGoNext ? '' : 'disabled'}>›</button>
      </div>
      ${periodLabel ? `<span class="badge good" style="margin:0">${periodLabel}</span>` : ''}
      ${noteText ? `<span class="card-note" style="margin:0">${noteText}</span>` : ''}
    </div>
  `;

  container.querySelectorAll('.step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = fyStartYear + Number(btn.dataset.dir);
      if (next < earliestFy) return;
      if (maxFyStartYear != null && next > maxFyStartYear) return;
      onChange(next);
    });
  });
  container.querySelector('#fy-select').addEventListener('change', (e) => {
    onChange(Number(e.target.value));
  });
}
