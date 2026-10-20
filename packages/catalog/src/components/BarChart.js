import { defineComponent, str, enumOf, list, num } from '../define.js';
import { el } from '../dom.js';
import { PALETTE, INK, TONES, toneShift, mix, toneScale } from '../palette.js';
import { FONT, tooltipBase, softAxes, bandPointer, chartHead, fillLegend, mountChart, chartHeight } from '../echarts.js';

// ─────────────────────────────────────────────────────────────────────────────
// 柱状图：一个色相、几档明度
//
// 以前是多段彩虹渐变（紫底配橙顶、绿→青→靛）。单看一根还行，两段堆叠就像
// 两块糖 —— 色相打架、渐变脏、圆角过大。现在改成数据图该有的样子：
//   · 序列靠**同一色相的深浅**区分，不换色相：堆叠起来仍是「一根柱子」
//   · 柱子纯色平涂，不做渐变 —— 渐变在细柱上只会显脏
//   · 圆角 4px、柱子偏细，贴地平底
//   · 极淡的横向参照线，柱子不再浮在空中
//
// 这些是视觉约定，不是参数：模型不该关心圆角和网格。
// ─────────────────────────────────────────────────────────────────────────────

/** 柱顶圆角：只圆上面两个角，底部贴地 */
const R_TOP = 6;
const R_RADIUS = [R_TOP, R_TOP, 0, 0];

/** 柱顶数值：一千以上折成 k，避免 18,240 这种长串挤在一起 */
function shortNum(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 10000) return `${+(n / 1000).toFixed(0)}k`;
  if (Math.abs(n) >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(Number.isInteger(n) ? n : +n.toFixed(1));
}

export function buildOption(p) {
  const labels = (p.labels || []).map(String);
  const series = (p.series || []).map((s) => ({ name: s?.name ?? '', data: (s?.data || []).map((v) => Number(v) || 0) }));
  const stacked = p.variant === 'stacked';
  const diverging = p.variant === 'diverging';
  const grouped = series.length > 1 && !stacked && !diverging;
  const count = Math.max(1, series.length);

  // 同色相阶梯：索引 0 最深（堆叠最下面），最后一条最浅
  const shades = toneScale(PALETTE[toneShift(p.tone)], count);
  const unit = p.yAxisLabel === '%' ? '%' : '';

  // 单序列才在柱顶标数值；堆叠改成标「这一列的合计」—— 分段已经说明结构了
  const showValues = !stacked && !diverging && count === 1 && labels.length <= 14;
  const showTotal = stacked && count > 1 && labels.length <= 10;
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.data[i] || 0), 0));

  const base = softAxes({ labels, unit, yName: p.yAxisLabel, boundaryGap: true, showY: true, gridLines: true });
  const barMaxWidth = diverging ? 12 : grouped ? 18 : labels.length > 8 ? 16 : 30;
  const barCategoryGap = labels.length > 8 ? '40%' : '30%';

  const bars = diverging
    ? [
        {
          name: series[0]?.name ?? '',
          type: 'bar',
          barMaxWidth,
          barCategoryGap,
          // 正负分开：向上是主色，向下是同色浅调 —— 方向一眼可读
          itemStyle: { borderRadius: R_RADIUS },
          data: (series[0]?.data || []).map((v) => ({
            value: v,
            itemStyle: {
              color: v >= 0 ? shades[0] : mix(shades[0], '#ffffff', 0.5),
              borderRadius: v >= 0 ? R_RADIUS : [0, 0, R_TOP, R_TOP],
            },
          })),
          emphasis: { itemStyle: { color: mix(shades[0], '#ffffff', 0.24) } },
        },
      ]
    : series.map((s, i) => {
        const isTop = !stacked || i === count - 1;
        const radius = stacked && !isTop ? 0 : R_RADIUS;
        const showLabel = isTop && (showValues || showTotal);
        return {
          name: s.name,
          type: 'bar',
          data: s.data,
          stack: stacked ? 'total' : undefined,
          barMaxWidth,
          barCategoryGap,
          barGap: grouped ? '24%' : undefined,
          itemStyle: { color: shades[i], borderRadius: radius },
          label: {
            show: showLabel,
            position: 'top',
            distance: 6,
            color: INK.muted,
            fontSize: showTotal ? 11 : 10.5,
            fontWeight: 600,
            fontFamily: FONT,
            formatter: (e) => shortNum(showTotal ? totals[e.dataIndex] : e.value),
          },
          // 悬停只提亮，不加投影：投影会把细柱子画糊
          emphasis: { itemStyle: { color: mix(shades[i], '#ffffff', 0.24) } },
        };
      });

  return {
    animationDuration: 620,
    animationEasing: 'cubicOut',
    animationDelay: (i) => i * 22,
    grid: { left: 2, right: 10, top: showValues || showTotal ? 22 : 8, bottom: 2, containLabel: true },
    legend: { show: false },
    tooltip: { ...tooltipBase(p.yAxisLabel || '', shades), trigger: 'axis', axisPointer: bandPointer(shades[0]) },
    xAxis: { ...base.xAxis, axisPointer: { label: { show: false } } },
    // 柱顶已经写了数值时，纵轴刻度就是重复信息 —— 只留横线和刻度线，不留字
    yAxis: showValues ? { ...base.yAxis, name: '', axisLabel: { ...base.yAxis.axisLabel, show: false } } : base.yAxis,
    series: bars,
  };
}

export default defineComponent({
  name: 'BarChart',
  group: 'Charts',
  description: '柱状图：labels 是横轴标签，series 是 Series 数组；tone 挑主色（多序列在同一色相里分深浅）；yAxisLabel 写单位；variant 用 diverging 画有正负的双向柱；height 是图表区高度 px（默认 230）',
  skeleton: { h: 250 },
  params: [
    list('labels', { required: true }),
    list('series', { required: true }),
    enumOf('variant', ['grouped', 'stacked', 'diverging'], { default: 'grouped' }),
    enumOf('tone', TONES, { default: 'blue' }),
    str('xAxisLabel'),
    str('yAxisLabel'),
    num('height'),
  ],
  render: {
    create(p) {
      const wrap = el('div', 'ec');
      const { head, legend } = chartHead();
      const box = el('div', 'ec-box bar-box');
      const h = chartHeight(p.height);
      if (h) box.style.height = h + 'px';
      wrap.append(head, box);
      wrap.__legend = legend;
      wrap.__mount = mountChart(box);
      paint(wrap, p);
      return wrap;
    },
    updates: ['labels', 'series', 'variant', 'tone', 'xAxisLabel', 'yAxisLabel'],
    update(wrap, p) {
      paint(wrap, p);
    },
  },
  markdown: (p) => `（图表：${(p.series || []).map((s) => s?.name).filter(Boolean).join('、')}）`,
  css: `
.bar-box { height: 230px; }
`,
});

function paint(wrap, p) {
  const names = (p.series || []).map((s) => s?.name ?? '');
  const shades = toneScale(PALETTE[toneShift(p.tone)], Math.max(1, names.length));
  fillLegend(wrap.__legend, names, wrap.__mount.chart, 0, shades);
  wrap.__mount.draw(buildOption(p), { replaceMerge: ['series'] });
}
