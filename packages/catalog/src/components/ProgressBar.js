import { defineComponent, str, num } from '../define.js';
import { el } from '../dom.js';
import { PALETTE, cssSegFill } from '../palette.js';

export default defineComponent({
  name: 'ProgressBar',
  group: 'Charts',
  description: '进度条',
  skeleton: { lines: 2 },
  params: [
    num('value', { required: true }),
    num('max', { default: 100 }),
    str('label'),
  ],
  render: {
    create(p) {
      const n = el('div', 'progress');
      if (p.label) n.appendChild(el('div', 'progress-label', p.label));
      const track = el('div', 'progress-track');
      const fill = el('div', 'progress-fill');
      fill.style.width = Math.min(100, ((p.value || 0) / (p.max || 100)) * 100) + '%';
      track.appendChild(fill);
      n.appendChild(track);
      return n;
    },
    updates: ['max', 'value'],
    update(n, p) {
      const fill = n.querySelector('.progress-fill');
      if (fill) fill.style.width = Math.min(100, ((p.value || 0) / (p.max || 100)) * 100) + '%';
    },
  },
  css: `
.progress { display: flex; flex-direction: column; gap: 6px; }
.progress-label { font-size: 11.5px; color: var(--ui-ink-3); }
.progress-track { height: 9px; background: var(--ui-band-strong, rgba(17,24,39,.07)); border-radius: 999px; overflow: hidden; }
.progress-fill { height: 100%; background: ${cssSegFill(PALETTE[0])}; border-radius: 999px; transition: width .35s ease; }
`,
});
