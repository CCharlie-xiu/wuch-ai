import { defineComponent, str, enumOf } from '../define.js';
import { el, icon, ICON_NAMES } from '../dom.js';

export default defineComponent({
  name: 'MetricIndicator',
  group: 'Charts',
  description: '指标卡：小标签 + 一行大数字（unit 是数字后面的浅色单位，如 "/100"、"%"，可不写）；delta 是右上角的小胶囊（如 "+6.2%"、"最常选"）；icon 是标签前的小图标',
  skeleton: { frame: true, lines: 2 },
  params: [
    str('label', { required: true }),
    str('value', { required: true }),
    str('delta'),
    enumOf('trend', ['up', 'down', 'flat'], { default: 'flat' }),
    str('unit'),
    enumOf('icon', ICON_NAMES),
  ],
  render: {
    create(p) {
      const n = el('div', 'metric');
      n.dataset.trend = p.trend || 'flat';

      const top = el('div', 'metric-top');
      if (p.icon) {
        const badge = el('span', 'metric-badge');
        badge.appendChild(icon(p.icon, 'icon sm'));
        top.appendChild(badge);
      }
      top.appendChild(el('span', 'metric-label', p.label));
      if (p.delta) top.appendChild(el('span', 'metric-delta', p.delta));
      n.appendChild(top);

      const row = el('div', 'metric-row');
      row.appendChild(el('b', 'metric-value', p.value));
      if (p.unit) row.appendChild(el('span', 'metric-unit', p.unit));
      n.appendChild(row);
      return n;
    },
  },
  markdown: (p) => `- ${p.label}：**${p.value}**${p.unit || ''}${p.delta ? `（${p.delta}）` : ''}`,
  css: `
.metric { border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px 13px; background: var(--card); display: flex; flex-direction: column; gap: 6px; min-width: 130px; }
.metric-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.metric-badge { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 8px; flex: 0 0 auto; background: var(--accent-soft); color: var(--accent); }
.metric-label { font-size: 11.5px; color: var(--muted); flex: 1; min-width: 0; }
.metric-delta { margin-left: auto; flex: 0 1 auto; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--panel-2); color: var(--subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.metric-row { display: flex; align-items: baseline; gap: 5px; }
.metric-value { font-size: 26px; font-weight: 700; letter-spacing: -.025em; line-height: 1.15; font-variant-numeric: tabular-nums; }
.metric-unit { font-size: 13px; color: var(--dim); font-weight: 500; }
/* 涨红跌绿：跟随 A 股习惯 */
.metric[data-trend="up"] .metric-delta { background: #fef2f2; color: #dc2626; }
.metric[data-trend="up"] .metric-badge { background: #fef2f2; color: #dc2626; }
.metric[data-trend="down"] .metric-delta { background: #f0fdf4; color: #16a34a; }
.metric[data-trend="down"] .metric-badge { background: #f0fdf4; color: #16a34a; }
`,
});
