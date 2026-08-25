import { yen } from './format.js';

// 「前月からどれだけ変わったか」を見せる帯。
// 主表示は実額（yen(value)）にし、前月からの増減はセルの下に小さく緑（増）/赤（減）で添える。
// 変わらない月は増減欄を「±0」で示す（緑にも赤にもしない）。
// 定期同額給与の役員報酬や、契約で固定の家賃のように「変わらないのが正常」なものでも、
// 実額そのものは常に見えるようにしたいというフィードバックを反映している。
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
      let valueDisplay = '—';
      let delta = '';
      if (value == null) {
        classes.push('none');
      } else if (previous == null) {
        classes.push('base');
        valueDisplay = `${yen(value)}円`;
        base = value;
        previous = value;
      } else if (value === previous) {
        classes.push('same');
        valueDisplay = `${yen(value)}円`;
        delta = `<span class="d same">±0</span>`;
        previous = value;
      } else {
        const difference = value - previous;
        const up = difference > 0;
        classes.push(up ? 'up' : 'down');
        valueDisplay = `${yen(value)}円`;
        const differenceDisplay = up ? `+${yen(difference)}` : `−${yen(Math.abs(difference))}`;
        delta = `<span class="d ${up ? 'up' : 'down'}">${differenceDisplay}円</span>`;
        differences.push({ label: longLabels[index], display: differenceDisplay });
        previous = value;
      }
      const title = value == null ? `${longLabels[index]}：データなし` : `${longLabels[index]}：${yen(value)}円`;
      return `<div class="${classes.join(' ')}" title="${title}"><span class="m">${xLabels[index]}</span><span class="v">${valueDisplay}</span>${delta}</div>`;
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
