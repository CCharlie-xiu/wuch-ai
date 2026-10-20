import { defineComponent, str, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'TextCallout',
  group: 'Content',
  description: '轻量提示块：变体 + 标题 + 一句话',
  skeleton: { frame: true, lines: 2 },
  params: [
    enumOf('variant', ['info', 'success', 'warning', 'danger', 'neutral'], { required: true, default: 'neutral' }),
    str('title', { required: true }),
    str('text'),
  ],
  render: {
    create(p) {
      const n = el('div', 'callout');
      n.dataset.variant = p.variant || 'neutral';
      if (p.title) n.appendChild(el('div', 'callout-title', p.title));
      if (p.text) n.appendChild(el('div', 'callout-text', p.text));
      return n;
    },
  },
  markdown: (p) => `> ${[p.title, p.text].filter(Boolean).join(' ')}`,
  css: `
.callout-text { font-size: 12.5px; line-height: 1.65; color: var(--ui-ink-2); }
`,
});
