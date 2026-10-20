// ─────────────────────────────────────────────────────────────────────────────
// 函数图像 + 滑块：拖动时点沿曲线走、虚线跟着伸缩，全在本地重画，
// 不产生模型调用（与 Slider 同理）。
//
// 表达式交给 ../expr.js 的白名单求值器 —— 模型写的 "x + 1" 是字符串数据、
// 不是代码，而组件跑在宿主页面上（不在沙箱里，lockdown 保护不到这里），
// 所以那里没有 eval / new Function，认不出的一律报错。
// ─────────────────────────────────────────────────────────────────────────────

import { defineComponent, str, num } from '../define.js';
import { el, svgEl } from '../dom.js';
import { compileExpr } from '../expr.js';

// ── 绘图 ─────────────────────────────────────────────────────────────────────
const W = 620;
const H = 340;
const PAD = { l: 46, r: 26, t: 22, b: 40 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;
const SAMPLES = 400;

const mk = (tag, attrs, text) => {
  const n = svgEl(tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
};

/** 刻度步长取 1 / 2 / 5 × 10^n */
function niceStep(span, target) {
  const raw = span / target;
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

function ticksFor(lo, hi, target) {
  const step = niceStep(hi - lo, target);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : Number(v.toFixed(10)));
  }
  return out;
}

const fmtTick = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));

/** 纵轴范围：取 2%~98% 分位挡住 1/x 这类爆点，再尽量把 0 纳进来 */
function yRange(ys) {
  const fin = ys.filter(Number.isFinite).sort((a, b) => a - b);
  if (!fin.length) return [-1, 1];
  const at = (q) => fin[Math.min(fin.length - 1, Math.max(0, Math.round((fin.length - 1) * q)))];
  let lo = fin.length >= 20 ? at(0.02) : fin[0];
  let hi = fin.length >= 20 ? at(0.98) : fin[fin.length - 1];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  const span = hi - lo;
  if (lo > 0 && lo <= span * 3) lo = 0;
  if (hi < 0 && -hi <= span * 3) hi = 0;
  return [lo, hi];
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round2 = (v) => (Number.isFinite(v) ? String(Number(v.toFixed(3))) : '—');

let uid = 0;

function create(p) {
  const wrap = el('div', 'fn-plot');
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fn-plot-svg', role: 'img' });
  svg.appendChild(mk('title', {}, '函数图像'));
  const clipId = `fn-clip-${++uid}`;
  const defs = mk('defs');
  const clip = mk('clipPath', { id: clipId });
  clip.appendChild(mk('rect', { x: PAD.l, y: PAD.t, width: PLOT_W, height: PLOT_H }));
  defs.appendChild(clip);
  svg.appendChild(defs);
  const statics = mk('g', { 'clip-path': `url(#${clipId})` });
  const dyn = mk('g');
  svg.append(statics, dyn);
  wrap.appendChild(svg);

  const bar = el('div', 'fn-plot-bar');
  const range = el('input', 'fn-plot-range');
  range.type = 'range';
  range.setAttribute('aria-label', '拖动改变 x');
  const readout = el('span', 'fn-plot-readout');
  bar.append(range, readout);
  wrap.appendChild(bar);

  wrap.__statics = statics;
  wrap.__dyn = dyn;
  wrap.__range = range;
  wrap.__readout = readout;
  wrap.__svg = svg;

  // 拖滑块：必须把新值读回内部状态再重画 —— 否则 paint 会拿旧的 __at 写回 r.value，
  // 滑块一动就被弹回原位，看起来就是「拖不动」
  range.addEventListener('input', () => {
    wrap.__touched = true;
    wrap.__at = Number(range.value);
    paint(wrap, wrap.__props);
  });

  // 直接拖图上的点：按指针位置反算 x
  let dragging = false;
  const setFromPointer = (e) => {
    const x = xFromPointer(wrap, e);
    if (x == null) return;
    wrap.__touched = true;
    wrap.__at = x;
    paint(wrap, wrap.__props);
  };
  svg.addEventListener('pointerdown', (e) => {
    if (wrap.__range.disabled) return;
    e.preventDefault();
    dragging = true;
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    setFromPointer(e);
  });
  svg.addEventListener('pointermove', (e) => {
    if (dragging) setFromPointer(e);
  });
  const stopDrag = (e) => {
    dragging = false;
    if (svg.releasePointerCapture) {
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* 没捕获过就算了 */ }
    }
  };
  svg.addEventListener('pointerup', stopDrag);
  svg.addEventListener('pointercancel', stopDrag);

  paint(wrap, p);
  return wrap;
}

/** 指针位置 → 数据坐标 x（viewBox 与 CSS 尺寸按比例换算） */
function xFromPointer(wrap, e) {
  const svg = wrap.__svg;
  if (!svg || !svg.getBoundingClientRect) return null;
  const box = svg.getBoundingClientRect();
  if (!box.width) return null;
  const px = ((e.clientX - box.left) / box.width) * W;
  const { x0, x1 } = wrap;
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
  return clamp(x0 + ((px - PAD.l) / PLOT_W) * (x1 - x0), x0, x1);
}

function paint(wrap, p) {
  const props = p || {};
  wrap.__props = props;

  const x0 = Number(props.x0);
  const x1 = Number(props.x1);
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 - x0 < 1e-9) {
    return bad(wrap, 'x 的范围要写成两个数字，且终点大于起点');
  }
  const parsed = compileExpr(props.expr);
  if (!parsed.ok) return bad(wrap, `函数读不出来：${parsed.message}`);
  const fn = parsed.fn;

  // 表达式 / 范围变了才重画静态层；拖动只动点、虚线和数值
  const sig = `${props.expr}|${x0}|${x1}|${props.label ?? ''}`;
  if (wrap.__sig !== sig) {
    wrap.__sig = sig;
    drawStatic(wrap, fn, x0, x1, props);
  }

  const at = wrap.__touched
    ? clamp(Number.isFinite(wrap.__at) ? wrap.__at : (x0 + x1) / 2, x0, x1)
    : clamp(Number.isFinite(Number(props.at)) ? Number(props.at) : (x0 + x1) / 2, x0, x1);
  wrap.__at = at;
  wrap.x0 = x0;
  wrap.x1 = x1;

  drawDynamic(wrap, fn, x0, x1);

  const r = wrap.__range;
  r.disabled = false;
  r.min = x0;
  r.max = x1;
  r.step = (x1 - x0) / 200;
  // 只在真的不一样时才写，免得跟正在拖的指针抢
  if (Number(r.value) !== at) r.value = at;
  wrap.__readout.textContent = `x = ${round2(at)}  ·  y = ${round2(fn(at))}`;
}

/** 表达式读不出来：清掉图，错误直接画上去。补全后 drawStatic / drawDynamic 会覆盖它 */
function bad(wrap, msg) {
  wrap.__statics.textContent = '';
  wrap.__dyn.textContent = '';
  wrap.__range.disabled = true;
  wrap.__readout.textContent = '—';
  wrap.__dyn.appendChild(mk('text', { x: W / 2, y: H / 2, class: 'fn-plot-bad-text', 'text-anchor': 'middle' }, msg));
}

function drawStatic(wrap, fn, x0, x1, props) {
  const g = wrap.__statics;
  g.textContent = '';

  const xs = [];
  const ys = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const x = x0 + ((x1 - x0) * i) / SAMPLES;
    xs.push(x);
    ys.push(fn(x));
  }
  const [y0, y1] = yRange(ys);

  const X = (x) => PAD.l + ((x - x0) / (x1 - x0)) * PLOT_W;
  const Y = (y) => PAD.t + ((y1 - y) / (y1 - y0)) * PLOT_H;
  wrap.__X = X;
  wrap.__Y = Y;
  wrap.__yr = [y0, y1];

  const axisY = Y(clamp(0, y0, y1));
  const axisX = X(clamp(0, x0, x1));

  for (const t of ticksFor(x0, x1, 8)) {
    g.appendChild(mk('line', { x1: X(t), y1: PAD.t, x2: X(t), y2: PAD.t + PLOT_H, class: 'fn-plot-grid' }));
  }
  for (const t of ticksFor(y0, y1, 6)) {
    g.appendChild(mk('line', { x1: PAD.l, y1: Y(t), x2: PAD.l + PLOT_W, y2: Y(t), class: 'fn-plot-grid' }));
  }

  g.appendChild(mk('line', { x1: PAD.l, y1: axisY, x2: PAD.l + PLOT_W, y2: axisY, class: 'fn-plot-axis' }));
  g.appendChild(mk('line', { x1: axisX, y1: PAD.t, x2: axisX, y2: PAD.t + PLOT_H, class: 'fn-plot-axis' }));
  g.appendChild(mk('path', { d: `M${PAD.l + PLOT_W - 9} ${axisY - 4.5}l9 4.5-9 4.5z`, class: 'fn-plot-head' }));
  g.appendChild(mk('path', { d: `M${axisX - 4.5} ${PAD.t + 9}l4.5-9 4.5 9z`, class: 'fn-plot-head' }));
  g.appendChild(mk('text', { x: PAD.l + PLOT_W - 2, y: axisY - 9, class: 'fn-plot-axis-name', 'text-anchor': 'end' }, 'x'));
  g.appendChild(mk('text', { x: axisX + 9, y: PAD.t + 10, class: 'fn-plot-axis-name' }, 'y'));

  for (const t of ticksFor(x0, x1, 8)) {
    if (Math.abs(t) < 1e-9) continue;
    g.appendChild(mk('line', { x1: X(t), y1: axisY, x2: X(t), y2: axisY + 4, class: 'fn-plot-tick' }));
    g.appendChild(mk('text', { x: X(t), y: axisY + 17, class: 'fn-plot-tick-label', 'text-anchor': 'middle' }, fmtTick(t)));
  }
  for (const t of ticksFor(y0, y1, 6)) {
    if (Math.abs(t) < 1e-9) continue;
    g.appendChild(mk('line', { x1: axisX - 4, y1: Y(t), x2: axisX, y2: Y(t), class: 'fn-plot-tick' }));
    g.appendChild(mk('text', { x: axisX - 8, y: Y(t) + 4, class: 'fn-plot-tick-label', 'text-anchor': 'end' }, fmtTick(t)));
  }
  g.appendChild(mk('text', { x: axisX - 8, y: axisY + 17, class: 'fn-plot-tick-label', 'text-anchor': 'end' }, '0'));

  // 曲线：不连续处（NaN / 溢出）断开，不留竖直长线
  let d = '';
  let pen = false;
  for (let i = 0; i <= SAMPLES; i++) {
    const y = ys[i];
    if (!Number.isFinite(y)) { pen = false; continue; }
    const py = Y(y);
    if (py < PAD.t - PLOT_H || py > PAD.t + PLOT_H * 2) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${X(xs[i]).toFixed(1)} ${py.toFixed(1)}`;
    pen = true;
  }
  if (d) g.appendChild(mk('path', { d, class: 'fn-plot-curve' }));

  const label = props.label || `y = ${props.expr}`;
  const lastY = [...ys].reverse().find(Number.isFinite);
  if (label && Number.isFinite(lastY)) {
    const ly = clamp(Y(lastY) - 12, PAD.t + 12, PAD.t + PLOT_H - 4);
    g.appendChild(mk('text', { x: PAD.l + PLOT_W - 8, y: ly, class: 'fn-plot-curve-label', 'text-anchor': 'end' }, label));
  }
}

function drawDynamic(wrap, fn, x0, x1) {
  const g = wrap.__dyn;
  g.textContent = '';
  const X = wrap.__X;
  const Y = wrap.__Y;
  const yr = wrap.__yr;
  if (!X || !Y || !yr) return;

  const at = clamp(wrap.__at ?? (x0 + x1) / 2, x0, x1);
  const yv = fn(at);
  if (!Number.isFinite(yv)) return;

  const px = X(at);
  const py = clamp(Y(yv), PAD.t, PAD.t + PLOT_H);
  const axisY = Y(clamp(0, yr[0], yr[1]));
  const axisX = X(clamp(0, x0, x1));

  g.appendChild(mk('line', { x1: px, y1: py, x2: px, y2: axisY, class: 'fn-plot-guide' }));
  g.appendChild(mk('line', { x1: px, y1: py, x2: axisX, y2: py, class: 'fn-plot-guide' }));
  g.appendChild(mk('circle', { cx: px, cy: py, r: 7, class: 'fn-plot-dot' }));

  const right = px < PAD.l + PLOT_W * 0.62;
  g.appendChild(
    mk(
      'text',
      { x: right ? px + 14 : px - 14, y: py - 12, class: 'fn-plot-value', 'text-anchor': right ? 'start' : 'end' },
      `(${round2(at)}, ${round2(yv)})`
    )
  );
}

function update(wrap, p) {
  paint(wrap, p);
}

export default defineComponent({
  name: 'FunctionPlot',
  group: 'Charts',
  description:
    '函数图像：expr 是函数表达式（如 "x + 1"、"sin(x)"、"x^2"、"1/x"），x0 / x1 是横轴范围，at 是初始位置（不写取中点），label 是曲线标签。可用：+ - * / ^、括号、pi / e，以及 sin cos tan exp ln log sqrt abs 等。图上的点和底部滑块都能拖，只在本地重画，不产生模型调用',
  skeleton: { h: 410 },
  params: [
    str('expr', { required: true }),
    num('x0', { required: true }),
    num('x1', { required: true }),
    num('at'),
    str('label'),
  ],
  render: { create, updates: ['expr', 'x0', 'x1', 'at', 'label'], update },
  markdown: (p) => `（函数图像：${p.label || `y = ${p.expr}`}，x 从 ${p.x0} 到 ${p.x1}）`,
  css: `
.fn-plot { display: flex; flex-direction: column; gap: 10px; }
.fn-plot-svg { display: block; width: 100%; height: auto; touch-action: none; cursor: crosshair; }
.fn-plot-grid { stroke: var(--ui-line, rgba(17,24,39,.06)); stroke-width: 1; }
.fn-plot-axis { stroke: var(--muted); stroke-width: 1.4; }
.fn-plot-head { fill: var(--muted); }
.fn-plot-tick { stroke: var(--ui-line-strong, rgba(17,24,39,.1)); stroke-width: 1; }
.fn-plot-tick-label { font: 11px var(--sans); fill: var(--subtle); }
.fn-plot-axis-name { font: 12px var(--sans); font-weight: 600; fill: var(--muted); font-style: italic; }
.fn-plot-curve { fill: none; stroke: var(--accent); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.fn-plot-curve-label { font: 12px var(--sans); font-weight: 600; fill: var(--accent); }
.fn-plot-guide { stroke: #f59e0b; stroke-width: 1.6; stroke-dasharray: 5 5; }
.fn-plot-dot { fill: #f59e0b; stroke: var(--card); stroke-width: 3; }
.fn-plot-value { font: 12px var(--mono); fill: var(--text); }
.fn-plot-bar { display: flex; align-items: center; gap: 12px; }
.fn-plot-range { -webkit-appearance: none; appearance: none; flex: 1; height: 5px; border-radius: 999px; background: var(--ui-band-strong, rgba(17,24,39,.07)); outline: none; }
.fn-plot-range::-webkit-slider-thumb { -webkit-appearance: none; width: 17px; height: 17px; border-radius: 999px; background: var(--accent); border: 3px solid #ffffff; box-shadow: 0 0 0 1px var(--ui-line-strong, rgba(17,24,39,.1)); cursor: pointer; }
.fn-plot-readout { font: 12px var(--mono); color: var(--text); min-width: 108px; text-align: right; }
.fn-plot-bad-text { font: 12px var(--sans); fill: var(--danger); }
`,
});
