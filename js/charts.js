// 依存なしの軽量 SVG チャート。線グラフ（複数系列 + ホバー）と棒グラフ（グループ化 + ホバー）。
import { yen } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function niceMax(max) {
  if (max <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / magnitude;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * magnitude;
}

function ensureTooltip(container) {
  let tip = container.querySelector('.viz-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tooltip';
    tip.style.display = 'none';
    container.style.position = 'relative';
    container.appendChild(tip);
  }
  return tip;
}

function legendHtml(series) {
  return `<div class="chart-legend">${series.map(s =>
    `<div class="item"><span class="swatch" style="background:${s.color}"></span>${s.label}</div>`
  ).join('')}</div>`;
}

/**
 * lineChart: 複数系列の折れ線グラフ。
 * opts: { xLabels: string[], series: [{label,color,values:number[]}], yFormat, height }
 */
export function lineChart(container, opts) {
  const { xLabels, series, yFormat = yen, height = 220 } = opts;
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  container.appendChild(wrap);

  const width = Math.max(480, xLabels.length * 64);
  const padL = 56, padR = 16, padT = 16, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxVal = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
  const minVal = Math.min(0, ...series.flatMap(s => s.values));

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });

  const x = (i) => padL + (xLabels.length === 1 ? plotW / 2 : (i / (xLabels.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - minVal) / (maxVal - minVal || 1)) * plotH;

  // gridlines + y labels
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const v = minVal + ((maxVal - minVal) * i) / gridSteps;
    const gy = y(v);
    svg.appendChild(el('line', { x1: padL, x2: width - padR, y1: gy, y2: gy, stroke: 'var(--hairline, #DAD1B8)', 'stroke-width': 1 }));
    const label = el('text', { x: padL - 8, y: gy + 4, 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--ink-muted, #7C8794)' });
    label.textContent = yFormat(v);
    svg.appendChild(label);
  }
  // baseline
  svg.appendChild(el('line', { x1: padL, x2: width - padR, y1: y(0), y2: y(0), stroke: 'var(--grid-line, #C9BFA6)', 'stroke-width': 1.2 }));

  // x labels
  xLabels.forEach((lbl, i) => {
    const t = el('text', { x: x(i), y: height - 8, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--ink-muted, #7C8794)' });
    t.textContent = lbl;
    svg.appendChild(t);
  });

  const pointGroups = [];
  series.forEach((s) => {
    const pts = s.values.map((v, i) => [x(i), y(v)]);
    const d = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ');
    svg.appendChild(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linecap': 'round' }));
    pts.forEach(([px, py]) => {
      svg.appendChild(el('circle', { cx: px, cy: py, r: 3.4, fill: 'var(--card, #F7F1E3)', stroke: s.color, 'stroke-width': 2 }));
    });
    pointGroups.push(pts);
  });

  // hover overlay
  const tip = ensureTooltip(wrap);
  const hoverLine = el('line', { x1: padL, x2: padL, y1: padT, y2: padT + plotH, stroke: 'var(--ink-soft, #4C5C70)', 'stroke-width': 1, 'stroke-dasharray': '3,3', opacity: 0 });
  svg.appendChild(hoverLine);

  const hitArea = el('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  hitArea.style.cursor = 'crosshair';
  svg.appendChild(hitArea);

  function showAt(i) {
    hoverLine.setAttribute('x1', x(i));
    hoverLine.setAttribute('x2', x(i));
    hoverLine.setAttribute('opacity', 1);
    const rows = series.map((s, si) =>
      `<div class="t-row"><span><span class="t-swatch" style="background:${s.color}"></span>${s.label}</span><span class="num">${yFormat(s.values[i])}</span></div>`
    ).join('');
    tip.innerHTML = `<div style="margin-bottom:4px;font-weight:600">${xLabels[i]}</div>${rows}`;
    tip.style.display = 'block';
    const cx = x(i);
    const bounds = wrap.getBoundingClientRect();
    const svgBounds = svg.getBoundingClientRect();
    const scale = svgBounds.width / width;
    let left = cx * scale + 12;
    if (left + 170 > bounds.width) left = cx * scale - 170;
    tip.style.left = `${left}px`;
    tip.style.top = `${padT * scale}px`;
  }

  hitArea.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    let idx = 0, best = Infinity;
    xLabels.forEach((_, i) => {
      const d = Math.abs(x(i) - relX);
      if (d < best) { best = d; idx = i; }
    });
    showAt(idx);
  });
  hitArea.addEventListener('mouseleave', () => {
    hoverLine.setAttribute('opacity', 0);
    tip.style.display = 'none';
  });

  wrap.appendChild(svg);
  if (series.length >= 2) {
    const legend = document.createElement('div');
    legend.innerHTML = legendHtml(series);
    container.appendChild(legend.firstChild);
  }
}

/**
 * barChart: カテゴリごとにグループ化した棒グラフ。
 * opts: { categories: string[], series: [{label,color,values:number[]}], yFormat, height }
 */
export function barChart(container, opts) {
  const { categories, series, yFormat = yen, height = 240 } = opts;
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  container.appendChild(wrap);

  const width = Math.max(480, categories.length * (series.length > 1 ? 90 : 56));
  const padL = 56, padR = 16, padT = 16, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxVal = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });

  const groupW = plotW / categories.length;
  const barGap = 3;
  const barW = Math.min(28, (groupW - barGap * (series.length + 1)) / series.length);

  const y = (v) => padT + plotH - (v / maxVal) * plotH;

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const v = (maxVal * i) / gridSteps;
    const gy = y(v);
    svg.appendChild(el('line', { x1: padL, x2: width - padR, y1: gy, y2: gy, stroke: 'var(--hairline, #DAD1B8)', 'stroke-width': 1 }));
    const label = el('text', { x: padL - 8, y: gy + 4, 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--ink-muted, #7C8794)' });
    label.textContent = yFormat(v);
    svg.appendChild(label);
  }
  svg.appendChild(el('line', { x1: padL, x2: width - padR, y1: y(0), y2: y(0), stroke: 'var(--grid-line, #C9BFA6)', 'stroke-width': 1.2 }));

  const tip = ensureTooltip(wrap);
  const bars = [];

  categories.forEach((cat, ci) => {
    const groupX = padL + ci * groupW;
    series.forEach((s, si) => {
      const v = s.values[ci] || 0;
      const bx = groupX + barGap + si * (barW + barGap);
      const by = y(v);
      const bh = padT + plotH - by;
      const rect = el('rect', {
        x: bx, y: by, width: barW, height: Math.max(0, bh),
        fill: s.color, rx: 3, ry: 3,
      });
      svg.appendChild(rect);
      bars.push({ rect, cat, label: s.label, color: s.color, value: v, cx: bx + barW / 2 });
    });
    const t = el('text', { x: groupX + groupW / 2, y: height - 8, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--ink-muted, #7C8794)' });
    t.textContent = cat;
    svg.appendChild(t);
  });

  bars.forEach((b) => {
    b.rect.style.cursor = 'pointer';
    b.rect.addEventListener('mousemove', (e) => {
      tip.innerHTML = `<div style="margin-bottom:4px;font-weight:600">${b.cat}</div>
        <div class="t-row"><span><span class="t-swatch" style="background:${b.color}"></span>${b.label}</span><span class="num">${yFormat(b.value)}</span></div>`;
      tip.style.display = 'block';
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / width;
      let left = b.cx * scale + 12;
      const bounds = wrap.getBoundingClientRect();
      if (left + 170 > bounds.width) left = b.cx * scale - 170;
      tip.style.left = `${left}px`;
      tip.style.top = `${padT * scale}px`;
    });
    b.rect.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });

  wrap.appendChild(svg);
  if (series.length >= 2) {
    const legend = document.createElement('div');
    legend.innerHTML = legendHtml(series);
    container.appendChild(legend.firstChild);
  }
}

/**
 * donutChart: 内訳を円環グラフで表示。
 * opts: { segments: [{label,color,value}], centerLabel, centerValue, yFormat, size }
 */
export function donutChart(container, opts) {
  const { segments, centerLabel, centerValue, yFormat = yen, size = 220 } = opts;
  container.innerHTML = '';
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) {
    emptyChart(container, 'データがまだありません');
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '28px';
  wrap.style.flexWrap = 'wrap';
  container.appendChild(wrap);

  const thickness = size * 0.16;
  const r = size / 2 - thickness / 2 - 4;
  const cx = size / 2, cy = size / 2;
  const gap = segments.length > 1 ? 1.4 : 0;

  const svgWrap = document.createElement('div');
  svgWrap.style.position = 'relative';
  svgWrap.style.width = `${size}px`;
  svgWrap.style.flexShrink = '0';

  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img' });
  const track = el('circle', {
    cx, cy, r, fill: 'none', stroke: 'var(--hairline, #DAD1B8)', 'stroke-width': thickness,
  });
  svg.appendChild(track);

  let cumulative = 0;
  const arcs = [];
  segments.forEach((s) => {
    const pct = (Math.max(0, s.value) / total) * 100;
    const circle = el('circle', {
      cx, cy, r, fill: 'none', stroke: s.color, 'stroke-width': thickness,
      'stroke-linecap': pct > 0.5 ? 'round' : 'butt',
      'stroke-dasharray': `${Math.max(0, pct - gap)} ${100 - Math.max(0, pct - gap)}`,
      'stroke-dashoffset': -cumulative,
      'pathLength': 100,
      transform: `rotate(-90 ${cx} ${cy})`,
    });
    svg.appendChild(circle);
    arcs.push({ circle, s, pct });
    cumulative += pct;
  });

  const centerDiv = document.createElement('div');
  centerDiv.style.position = 'absolute';
  centerDiv.style.inset = '0';
  centerDiv.style.display = 'flex';
  centerDiv.style.flexDirection = 'column';
  centerDiv.style.alignItems = 'center';
  centerDiv.style.justifyContent = 'center';
  centerDiv.style.textAlign = 'center';
  centerDiv.innerHTML = `
    <div style="font-size:11px;color:var(--ink-muted);margin-bottom:4px">${centerLabel}</div>
    <div class="num" style="font-size:22px;font-weight:700;color:var(--ink)">${yFormat(centerValue)}</div>
  `;

  svgWrap.appendChild(svg);
  svgWrap.appendChild(centerDiv);
  wrap.appendChild(svgWrap);

  const legend = document.createElement('div');
  legend.style.display = 'flex';
  legend.style.flexDirection = 'column';
  legend.style.gap = '8px';
  legend.style.fontSize = '13px';
  legend.innerHTML = segments.map((s) => {
    const pct = ((Math.max(0, s.value) / total) * 100).toFixed(1);
    return `
      <div style="display:flex;align-items:center;gap:8px">
        <span class="swatch" style="background:${s.color};width:10px;height:10px;border-radius:2px;flex-shrink:0"></span>
        <span style="color:var(--ink-soft)">${s.label}</span>
        <span class="num" style="margin-left:auto;padding-left:14px">${yFormat(s.value)}<span style="color:var(--ink-muted);font-size:11px"> (${pct}%)</span></span>
      </div>
    `;
  }).join('');
  wrap.appendChild(legend);

  const tip = ensureTooltip(container);
  arcs.forEach(({ circle, s, pct }) => {
    circle.style.cursor = 'pointer';
    circle.addEventListener('mousemove', (e) => {
      tip.innerHTML = `<div class="t-row"><span><span class="t-swatch" style="background:${s.color}"></span>${s.label}</span><span class="num">${yFormat(s.value)} (${pct.toFixed(1)}%)</span></div>`;
      tip.style.display = 'block';
      const bounds = container.getBoundingClientRect();
      tip.style.left = `${e.clientX - bounds.left + 14}px`;
      tip.style.top = `${e.clientY - bounds.top + 10}px`;
    });
    circle.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

export function emptyChart(container, message) {
  container.innerHTML = `<div class="empty-state"><div class="display">${message}</div></div>`;
}
