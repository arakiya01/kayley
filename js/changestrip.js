import { yen } from './format.js';

// 「前月と同じかどうか」だけを見せる帯。
// 定期同額給与の役員報酬や、契約で固定の家賃のように「変わらないのが正常」なものは、
// 折れ線グラフにすると必ず平坦になって情報を持たない。
// ここでは同じ月は静かに＝で示し、変わった月だけ差額を出して異常として拾えるようにする。
// xLabels はセルに出す短いラベル（「4月」）。fullLabels は要約とツールチップに使う
// 年つきのラベル（「2026年4月」）で、省略すると xLabels をそのまま使う。
export function changeStrip(container, { xLabels, fullLabels, highlightIndex, rows }) {
  const longLabels = fullLabels || xLabels;
  container.innerHTML = `<div class="change-strip">${rows.map((row) => {
    let previous = null;
    let base = null;
    const differences = [];
    const cells = row.values.map((value, index) => {
      const classes = ['change-cell'];
      if (index === highlightIndex) classes.push('current');
      let display = '—';
      if (value == null) {
        classes.push('none');
      } else if (previous == null) {
        classes.push('base');
        display = yen(value);
        base = value;
        previous = value;
      } else if (value === previous) {
        classes.push('same');
        display = '＝';
        previous = value;
      } else {
        classes.push('diff');
        const difference = value - previous;
        display = difference > 0 ? `+${yen(difference)}` : `−${yen(Math.abs(difference))}`;
        differences.push({ label: longLabels[index], display });
        previous = value;
      }
      const title = value == null ? `${longLabels[index]}：データなし` : `${longLabels[index]}：${yen(value)}円`;
      return `<div class="${classes.join(' ')}" title="${title}"><span class="m">${xLabels[index]}</span><span class="v">${display}</span></div>`;
    }).join('');
    let summary = base == null ? 'データなし' : `変化なし・${yen(base)}円`;
    if (differences.length) {
      const first = differences[0];
      summary = differences.length === 1
        ? `${first.label}に ${first.display}円`
        : `${first.label}ほか${differences.length - 1}件`;
    }
    return `<div class="change-row"><div class="change-row-head"><span class="change-label">${row.label}</span><span class="change-summary">${summary}</span></div><div class="change-cells">${cells}</div></div>`;
  }).join('')}</div>`;
}
