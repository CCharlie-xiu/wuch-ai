import { defineComponent, str, style } from '../define.js';
import { el, icon } from '../dom.js';

export default defineComponent({
  name: 'IconText',
  group: 'Content',
  description: '图标 + 文字',
  skeleton: { lines: 1 },
  params: [
    str('text', { required: true }),
    str('icon'),
    style('style', 'default'),
  ],
  render: {
    create(p) {
      const n = el('div', 'icon-text');
      n.dataset.style = p.style || 'default';
      if (p.icon) n.appendChild(icon(p.icon, 'icon sm'));
      n.appendChild(el('span', null, p.text));
      return n;
    },
  },
  css: `
.icon-text { display: flex; align-items: center; gap: 7px; font-size: 13.5px; }
`,
});
