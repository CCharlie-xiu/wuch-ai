import { defineComponent, enumOf, list, num } from '../define.js';
import { el, fmtNum } from '../dom.js';
import { PALETTE, INK, rgba } from '../palette.js';
import { FONT, esc, tooltipBase, mountChart, chartHeight } from '../echarts.js';

const slicesOf = (p) => (p.slices || []).map((s) => ({ label: String(s?.label ?? ''), value: Number(s?.value) || 0 }));

function centerText(title, sub) {
  return [
    { type: 'text', left: 'center', top: '41%', style: { text: title, fill: INK.text, font: `700 22px ${FONT}`, textAlign: 'center' } },
    { type: 'text', left: 'center', top: '56%', style: { text: sub, fill: INK.dim, font: `500 11px ${FONT}`, textAlign: 'center' } },
  ];
}

function buildOption(p) {
  const slices = slicesOf(p);
  const total = slices.reduce((a, s) => a + s.value, 0);
  const donut = p.variant !== 'pie';
  return {
    animationDuration: 900,
    animationEasing: 'cubicOut',
    tooltip: {
      ...tooltipBase(''),
      trigger: 'item',
      show: !donut,
      formatter: (e) => `<div style="font-weight:600">${esc(e.name)}</div><div style="margin-top:6px"><b>${esc(fmtNum(e.value))}</b> <span style="color:rgba(255,255,255,.72)">· ${+e.percent.toFixed(1)}%</span></div>`,
    },
    graphic: donut ? { elements: centerText(fmtNum(total), '合计') } : undefined,
    series: [
      {
        type: 'pie',
        radius: donut ? ['66%', '92%'] : ['0%', '92%'],
        padAngle: donut ? 2.5 : 0,
        itemStyle: { borderRadius: donut ? 9 : 5, borderColor: '#fff', borderWidth: donut ? 0 : 2 },
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 6, itemStyle: { shadowBlur: 18, shadowColor: 'rgba(15, 23, 42, .16)' } },
        data: slices.map((s, i) => ({ name: s.label, value: s.value, itemStyle: { color: PALETTE[i % PALETTE.length] } })),
      },
    ],
  };
}

export default defineComponent({
  name: 'PieChart',
  group: 'Charts',
  description: '饼图 / 环图：slices 是 Slice 数组；height 是饼图直径 px（默认 168，最大 360）',
  skeleton: { h: 168 },
  params: [
    list('slices', { required: true }),
    enumOf('variant', ['donut', 'pie'], { default: 'donut' }),
    num('height'),
  ],
  render: {
    create(p) {
      const wrap = el('div', 'pie-wrap');
      const box = el('div', 'ec-box pie-box');
      const h = chartHeight(p.height);
      if (h) box.style.width = box.style.height = Math.min(h, 360) + 'px';
      const legend = el('div', 'pie-legend');
      wrap.append(box, legend);
      wrap.__legend = legend;
      wrap.__mount = mountChart(box, (chart) => {
        const reset = () => {
          if (wrap.__props.variant === 'pie') return;
          const total = slicesOf(wrap.__props).reduce((a, s) => a + s.value, 0);
          chart.setOption({ graphic: { elements: centerText(fmtNum(total), '合计') } });
        };
        chart.on('mouseover', (e) => {
          if (wrap.__props.variant === 'pie') return;
          chart.setOption({ graphic: { elements: centerText(`${+e.percent.toFixed(1)}%`, e.name) } });
        });
        chart.on('mouseout', reset);
      });
      paint(wrap, p);
      return wrap;
    },
    updates: ['slices', 'variant'],
    update(wrap, p) {
      paint(wrap, p);
    },
  },
  markdown: (p) => `（饼图：${(p.slices || []).map((s) => `${s?.label} ${s?.value}`).join('、')}）`,
  css: `
.pie-wrap { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
.pie-box { width: 168px; height: 168px; flex: 0 0 auto; }
.pie-legend { flex: 1 1 120px; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pie-row { all: unset; display: flex; align-items: center; gap: 9px; font-size: 11.5px; color: ${INK.muted}; padding: 5px 8px; border-radius: 8px; cursor: default; transition: background .15s; }
.pie-row:hover { background: ${INK.grid}; }
.pie-row .ec-dot { flex: 0 0 auto; }
.pie-row .pie-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pie-row b { font-weight: 650; color: ${INK.text}; font-variant-numeric: tabular-nums; }
`,
});

function paint(wrap, p) {
  wrap.__props = p;
  const slices = slicesOf(p);
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const legend = wrap.__legend;
  legend.innerHTML = '';
  slices.forEach((s, i) => {
    const row = el('div', 'pie-row');
    const dot = el('span', 'ec-dot');
    dot.style.background = PALETTE[i % PALETTE.length];
    dot.style.boxShadow = `0 0 0 3px ${rgba(PALETTE[i % PALETTE.length], 0.15)}`;
    row.append(dot, el('span', 'pie-name', s.label), el('b', null, `${+((s.value / total) * 100).toFixed(1)}%`));
    row.addEventListener('mouseenter', () => {
      const chart = wrap.__mount.chart();
      chart?.dispatchAction({ type: 'highlight', dataIndex: i });
      if (chart && p.variant !== 'pie') chart.setOption({ graphic: { elements: centerText(`${+((s.value / total) * 100).toFixed(1)}%`, s.label) } });
    });
    row.addEventListener('mouseleave', () => {
      const chart = wrap.__mount.chart();
      chart?.dispatchAction({ type: 'downplay', dataIndex: i });
      if (chart && p.variant !== 'pie') chart.setOption({ graphic: { elements: centerText(fmtNum(slices.reduce((a, x) => a + x.value, 0)), '合计') } });
    });
    legend.appendChild(row);
  });
  wrap.__mount.draw(buildOption(p));
}
