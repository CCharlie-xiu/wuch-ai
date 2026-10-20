import { defineComponent, str, num } from '../define.js';
import { el } from '../dom.js';
import { PALETTE, INK, cssSegFill } from '../palette.js';

const FILL = PALETTE[2];
const MIN = 2;
const MAX = 12;

const segCount = (v) => Math.max(MIN, Math.min(MAX, Math.round(Number(v) || 0)));

function paint(n, p) {
  const max = segCount(p.max ?? 4);
  const value = Math.max(0, Math.min(max, Math.round(Number(p.value) || 0)));

  const track = n.querySelector('.segbar-track');
  track.textContent = '';
  for (let i = 0; i < max; i++) {
    const s = el('span', 'segbar-seg');
    if (i < value) s.classList.add('on');
    track.appendChild(s);
  }

  const label = n.querySelector('.segbar-label');
  label.textContent = p.label || '';
  label.style.display = p.label ? '' : 'none';
  n.querySelector('.segbar-count').textContent = `${value} / ${max}`;
}

export default defineComponent({
  name: 'SegmentedBar',
  group: 'Charts',
  description: '分段进度条：max 段圆角小格，走满 value 格；label 是左下角的小标题，右下角自动写 "已走 / 总数"',
  skeleton: { lines: 2 },
  params: [
    num('value', { required: true }),
    num('max', { default: 4 }),
    str('label'),
  ],
  render: {
    create(p) {
      const n = el('div', 'segbar');
      n.appendChild(el('div', 'segbar-track'));
      const foot = el('div', 'segbar-foot');
      foot.append(el('span', 'segbar-label'), el('span', 'segbar-count'));
      n.appendChild(foot);
      paint(n, p);
      return n;
    },
    updates: ['value', 'max', 'label'],
    update(n, p) {
      paint(n, p);
    },
  },
  markdown: (p) => `- ${p.label ? `${p.label}：` : ''}**${p.value ?? 0} / ${p.max ?? 4}**`,
  css: `
.segbar { display: flex; flex-direction: column; gap: 9px; }
.segbar-track { display: flex; gap: 5px; }
.segbar-seg { flex: 1 1 0; height: 10px; border-radius: 999px; background: var(--ui-band-strong, rgba(17,24,39,.07)); transition: background .3s ease; }
.segbar-seg.on { background: ${cssSegFill(FILL)}; }
.segbar-foot { display: flex; align-items: center; gap: 10px; font-size: 11.5px; letter-spacing: .01em; color: var(--ui-ink-3); }
.segbar-count { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--ui-ink-2); font-weight: 600; }
`,
});
