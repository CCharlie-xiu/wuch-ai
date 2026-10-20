import { defineComponent, str, enumOf, list, num } from '../define.js';
import { el } from '../dom.js';
import { PALETTE, areaFill } from '../palette.js';
import { tooltipBase, besidePoint, softAxes, linePointer, bandPointer, chartHead, fillLegend, mountChart, chartHeight } from '../echarts.js';

const SMOOTH = { natural: 0.5, monotone: 0.4, linear: false, step: false };

/** 点数够多时给「全部 / 近一半 / 近四分之一」三档区间，本地切换，不产生模型调用 */
function rangeOptions(n) {
  if (n < 8) return [];
  const half = Math.ceil(n / 2);
  const quarter = Math.max(3, Math.ceil(n / 4));
  return [['全部', n], [`近 ${half}`, half], ...(quarter < half ? [[`近 ${quarter}`, quarter]] : [])];
}

function buildOption(p, take) {
  const labels = (p.labels || []).map(String);
  const series = (p.series || []).map((s) => ({ name: s?.name ?? '', data: (s?.data || []).map((v) => Number(v) || 0) }));
  const from = Math.max(0, labels.length - take);
  const unit = p.yAxisLabel === '%' ? '%' : '';
  const max = Math.max(0, ...series.flatMap((s) => s.data));
  const solo = series.length === 1;
  const main = PALETTE[0];
  const base = softAxes({ labels: labels.slice(from), unit, yName: p.yAxisLabel, boundaryGap: false, showY: Boolean(p.yAxisLabel) });
  // 点不多时把每个点画成白心圆点（参考图的样子）；点密了就只留线，免得糊成一片
  const dots = labels.length - from <= 32;
  return {
    animationDuration: 900,
    animationEasing: 'cubicOut',
    grid: { left: 4, right: 18, top: p.yAxisLabel && unit !== '%' ? 26 : 10, bottom: 4, containLabel: true },
    legend: { show: false },
    tooltip: { ...tooltipBase(p.yAxisLabel || ''), trigger: 'axis', position: besidePoint },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [
      { ...base.xAxis, axisPointer: { show: true, ...linePointer(main) } },
      { ...base.xAxis, show: false, axisPointer: { show: true, triggerTooltip: false, ...bandPointer(main) } },
    ],
    yAxis: { ...base.yAxis, ...(unit === '%' && max <= 100 ? { min: 0, max: 100, interval: 25 } : {}) },
    series: series.map((s, i) => {
      const c = PALETTE[i % PALETTE.length];
      return {
        name: s.name,
        type: 'line',
        data: s.data.slice(from),
        smooth: SMOOTH[p.variant] ?? 0.4,
        smoothMonotone: p.variant === 'monotone' ? 'x' : undefined,
        step: p.variant === 'step' ? 'middle' : false,
        showSymbol: dots,
        symbol: 'circle',
        symbolSize: 6.5,
        lineStyle: { width: solo ? 2.8 : 2.2, color: c, cap: 'round' },
        itemStyle: { color: '#fff', borderColor: c, borderWidth: 2 },
        areaStyle: { color: areaFill(c, solo ? 0.3 : 0.14) },
        emphasis: { focus: solo ? 'none' : 'series', scale: 1.5 },
        z: 3 + i,
      };
    }),
  };
}

export default defineComponent({
  name: 'LineChart',
  group: 'Charts',
  description: '折线 / 面积图：labels 是横轴标签，series 是 Series 数组；variant 用 linear 画不带平滑的折线；yAxisLabel 写单位（写 "%" 纵轴按百分比，不写就不画纵轴）；height 是图表区高度 px（默认 240）',
  skeleton: { h: 278 },
  params: [
    list('labels', { required: true }),
    list('series', { required: true }),
    enumOf('variant', ['natural', 'monotone', 'linear', 'step'], { default: 'monotone' }),
    str('xAxisLabel'),
    str('yAxisLabel'),
    num('height'),
  ],
  render: {
    create(p) {
      const wrap = el('div', 'ec');
      const { head, legend, ranges } = chartHead();
      const box = el('div', 'ec-box line-box');
      const h = chartHeight(p.height);
      if (h) box.style.height = h + 'px';
      wrap.append(head, box);
      wrap.__legend = legend;
      wrap.__ranges = ranges;
      wrap.__mount = mountChart(box);
      paint(wrap, p);
      return wrap;
    },
    updates: ['labels', 'series', 'variant', 'xAxisLabel', 'yAxisLabel'],
    update(wrap, p) {
      paint(wrap, p);
    },
  },
  markdown: (p) => `（图表：${(p.series || []).map((s) => s?.name).filter(Boolean).join('、')}）`,
  css: `
.line-box { height: 240px; }
`,
});

function paint(wrap, p) {
  const n = (p.labels || []).length;
  const opts = rangeOptions(n);
  if (!opts.some(([, k]) => k === wrap.__take)) wrap.__take = n;
  const ranges = wrap.__ranges;
  ranges.innerHTML = '';
  for (const [label, k] of opts) {
    const b = el('button', 'ec-range', label);
    b.type = 'button';
    if (k === wrap.__take) b.classList.add('active');
    b.addEventListener('click', () => {
      wrap.__take = k;
      paint(wrap, wrap.__props);
    });
    ranges.appendChild(b);
  }
  wrap.__props = p;
  fillLegend(wrap.__legend, (p.series || []).map((s) => s?.name ?? ''), wrap.__mount.chart);
  wrap.__mount.draw(buildOption(p, wrap.__take || n), { replaceMerge: ['series'] });
}
