// ─────────────────────────────────────────────────────────────────────────────
// 图表组件共用的 ECharts 底座：按需加载、统一视觉、尺寸自适应、卸载回收。
//
// 视觉基调：浅色、通透、少线条。
//   · 没有网格线、没有轴线、没有刻度 —— 只剩数据本身和一行浅灰标签
//   · 柱子是圆头胶囊 + 竖向渐变（顶实底淡），不是方块
//   · 折线是柔和曲线 + 白心圆点 + 渐隐面积
//   · 纵轴只在给了单位（yAxisLabel）时才画，且颜色很浅
//
// 配色与渐变工具在 palette.js；不用 ECharts 的图表（仪表盘 / 刻度环 / 分段进度）
// 直接取 palette.js，不必经过这里。
//
// echarts 只在浏览器里 import（页面 import map 指到 /vendor/echarts.js），
// 服务端 import 目录生成提示词时不会加载它。
// 浮层是 HTML 字符串，模型给的文字一律先转义再拼，写不进任意 markup。
// ─────────────────────────────────────────────────────────────────────────────

import { el } from './dom.js';
import { PALETTE, INK, rgba, vGradient } from './palette.js';

export const FONT = '"LXGW WenKai Screen", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';

let loading = null;
export const loadECharts = () => (loading ||= import('echarts'));

/** 模型给的图表高度（px）夹到合理范围；没给返回 null，用组件 css 里的默认高度 */
export const chartHeight = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.max(120, Math.min(600, Math.round(Number(v)))) : null);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 数值的短写：%、万、亿；单位是 % 时直接拼百分号 */
export function fmtValue(v, unit) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '—');
  if (unit === '%') return `${+n.toFixed(1)}%`;
  const abs = Math.abs(n);
  const s = abs >= 1e8 ? `${+(n / 1e8).toFixed(2)}亿` : abs >= 1e4 ? `${+(n / 1e4).toFixed(1)}万` : n.toLocaleString('zh-CN');
  return unit ? `${s} ${unit}` : s;
}

/** 浮层里的数值写全：千分位 + 单位 */
export function fmtExact(v, unit) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '—');
  if (unit === '%') return `${n}%`;
  return unit ? `${n.toLocaleString('zh-CN')} ${unit}` : n.toLocaleString('zh-CN');
}

/** 深色浮层：标题 + 每个序列一行（色点 · 名称 · 加粗数值）。
 *  colors 给了就按序列序取色 —— 渐变柱的 p.color 是对象，拿不到代表色 */
export function tooltipBase(unit, colors = null) {
  return {
    backgroundColor: INK.tip,
    borderWidth: 0,
    padding: [10, 14],
    textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
    extraCssText: 'border-radius:10px;box-shadow:0 12px 32px -12px rgba(11,27,63,.6);',
    confine: true,
    formatter(params) {
      const list = Array.isArray(params) ? params : [params];
      const title = list[0]?.axisValueLabel ?? list[0]?.name ?? '';
      const rows = list
        .map((p) => `<div style="display:flex;align-items:center;gap:8px;margin-top:6px">`
          + `<span style="width:7px;height:7px;border-radius:50%;background:${colors ? colors[p.seriesIndex % colors.length] : typeof p.color === 'string' ? p.color : PALETTE[p.seriesIndex % PALETTE.length]}"></span>`
          + `<span style="color:rgba(255,255,255,.72)">${esc(p.seriesName)}</span>`
          + `<b style="margin-left:auto;padding-left:24px;font-weight:700">${esc(fmtExact(p.value, unit))}</b></div>`)
        .join('');
      return `<div style="font-weight:600;font-size:12.5px">${esc(title)}</div>${rows}`;
    },
  };
}

/** 浮层贴在悬停点右侧、垂直居中；右边放不下就翻到左侧 */
export function besidePoint(point, _params, _dom, _rect, size) {
  const [w, h] = size.contentSize;
  const [vw] = size.viewSize;
  const x = point[0] + 16 + w > vw ? point[0] - 16 - w : point[0] + 16;
  return [x, Math.max(4, point[1] - h / 2)];
}

/**
 * 直角坐标系的共用轴：无轴线、无刻度、无网格，只有一行浅灰标签。
 * showY 为真时才画纵轴（给了 yAxisLabel 才画），数值也是浅灰小字。
 */
export function softAxes({ labels, unit, yName, boundaryGap, showY = false, splitNumber = 4, gridLines = false }) {
  return {
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: INK.dim, fontSize: 11, margin: 14, fontFamily: FONT, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      show: showY,
      name: yName && unit !== '%' ? yName : '',
      nameTextStyle: { color: INK.dim, fontSize: 11, align: 'left', padding: [0, 0, 6, -4] },
      splitNumber,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: INK.dim, fontSize: 11, fontFamily: FONT, margin: 10, formatter: (v) => fmtValue(v, unit === '%' ? '%' : '') },
      // 柱状图给极淡的横向参照线：柱子下方有刻度，才不会「浮在空中」
      splitLine: gridLines
        ? { show: true, lineStyle: { color: INK.grid, width: 1, type: [1, 0] } }
        : { show: false },
    },
  };
}

/** 横轴悬停：虚线竖线 + 当前标签高亮成主色 */
export function linePointer(color) {
  return {
    type: 'line',
    lineStyle: { color, type: [4, 4], width: 1, opacity: 0.5 },
    label: { show: true, backgroundColor: '#fff', color, fontWeight: 700, fontSize: 11.5, fontFamily: FONT, padding: [3, 6], margin: 8, shadowBlur: 0 },
  };
}

/** 悬停的那一列铺一条浅色光带 */
export function bandPointer(color) {
  return { type: 'shadow', shadowStyle: { color: vGradient(rgba(color, 0.03), rgba(color, 0.12)) }, label: { show: false } };
}

/** 图例 + 区间切换的 HTML 头部；返回 { head, legend, ranges } */
export function chartHead() {
  const head = el('div', 'ec-head');
  const legend = el('div', 'ec-legend');
  const ranges = el('div', 'ec-ranges');
  head.append(legend, ranges);
  return { head, legend, ranges };
}

/** 点图例切换序列显隐；shift 是 tone 给色板加的偏移，要和图上的颜色对上。
 *  colors 给了就按序取色（柱状图这类「渐变柱」用中间那段当代表色） */
export function fillLegend(box, names, getChart, shift = 0, colors = null) {
  box.innerHTML = '';
  if (names.length < 2) return;
  const selected = getChart()?.getOption()?.legend?.[0]?.selected || {};
  names.forEach((name, i) => {
    const b = el('button', 'ec-legend-item');
    b.type = 'button';
    if (selected[name] === false) b.classList.add('off');
    const dot = el('span', 'ec-dot');
    dot.style.background = colors ? colors[i] : PALETTE[(i + shift) % PALETTE.length];
    b.append(dot, el('span', null, name));
    b.addEventListener('click', () => {
      b.classList.toggle('off');
      getChart()?.dispatchAction({ type: 'legendToggleSelect', name });
    });
    box.appendChild(b);
  });
}

/** 祖先链上 CSS zoom 的乘积（预览区的缩放按钮用的是 zoom） */
function cssZoomOf(node) {
  let z = 1;
  for (let n = node; n && n.nodeType === 1; n = n.parentElement) z *= parseFloat(getComputedStyle(n).zoom) || 1;
  return z;
}

/**
 * 旧版 Chromium 的 CSS zoom 下，鼠标事件的 offsetX/Y 是视口像素、没按缩放折算，
 * ECharts 直接拿它当画布坐标，悬停会错位。捕获阶段先把它折回画布坐标。
 * 支持标准化 zoom 的浏览器（有 currentCSSZoom）offsetX 本来就对，不处理。
 */
function fixZoomedPointer(box) {
  if (typeof Element === 'undefined' || 'currentCSSZoom' in Element.prototype) return;
  const fix = (e) => {
    const z = cssZoomOf(box);
    if (Math.abs(z - 1) < 1e-3) return;
    const x = e.offsetX / z;
    const y = e.offsetY / z;
    Object.defineProperty(e, 'offsetX', { value: x });
    Object.defineProperty(e, 'offsetY', { value: y });
  };
  for (const t of ['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'mousewheel', 'wheel', 'pointermove', 'pointerdown', 'pointerup']) {
    box.addEventListener(t, fix, true);
  }
}

/**
 * 把 ECharts 挂到 box 上。宽度为 0（还没进 DOM、在收起的标签页里）时先不 init，
 * 有尺寸了再画；元素被移出文档后释放实例。
 * 返回 draw(option)：随时可调，实例没好时记下最后一次的 option。
 */
export function mountChart(box, onReady) {
  let chart = null;
  let pending = null;
  let echarts = null;
  const tryInit = () => {
    if (chart || !echarts || !box.clientWidth) return;
    chart = echarts.init(box, null, { renderer: 'svg' });
    box.__chart = chart;
    if (onReady) onReady(chart);
    if (pending) chart.setOption(pending);
  };
  const ro = new ResizeObserver(() => {
    if (!box.isConnected) {
      if (chart) chart.dispose();
      chart = null;
      ro.disconnect();
      return;
    }
    if (chart) chart.resize();
    else tryInit();
  });
  ro.observe(box);
  fixZoomedPointer(box);
  loadECharts().then((m) => {
    echarts = m;
    tryInit();
  });
  return {
    draw(option, opts) {
      pending = option;
      if (chart) chart.setOption(option, opts);
    },
    chart: () => chart,
  };
}

export const CHART_CSS = `
.ec { display: flex; flex-direction: column; gap: 12px; }
.ec-head { display: flex; align-items: center; gap: 12px; min-height: 0; }
.ec-head:empty, .ec-head:has(> .ec-legend:empty + .ec-ranges:empty) { display: none; }
.ec-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; flex: 1; min-width: 0; }
.ec-legend-item { all: unset; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: .02em; color: ${INK.dim}; cursor: pointer; transition: color .15s; }
.ec-legend-item:hover { color: ${INK.muted}; }
.ec-legend-item.off { opacity: .38; }
.ec-dot { width: 7px; height: 7px; border-radius: 50%; }
.ec-ranges { display: flex; gap: 4px; margin-left: auto; }
.ec-range { all: unset; font-size: 11px; font-weight: 600; color: ${INK.muted}; background: ${INK.grid}; border-radius: 999px; padding: 4px 11px; cursor: pointer; transition: background .15s, color .15s; }
.ec-range:hover { background: #e6ebf3; }
.ec-range.active { background: ${PALETTE[0]}; color: #fff; }
.ec-box { width: 100%; }
`;
