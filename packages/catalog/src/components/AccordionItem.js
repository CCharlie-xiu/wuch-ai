import { defineComponent, nodes, str, bool } from '../define.js';
import { el, icon } from '../dom.js';

export default defineComponent({
  name: 'AccordionItem',
  group: 'Layout',
  description: '折叠面板单项',
  skeleton: { lines: 1 },
  params: [
    str('id', { required: true }),
    str('title', { required: true }),
    nodes('children'),
    bool('defaultOpen', { default: false }),
  ],
  render: {
    create(p) {
      const wrap = el('div', 'acc-item');
      if (p.defaultOpen) wrap.classList.add('open');
      const head = el('button', 'acc-head');
      head.type = 'button';
      head.appendChild(el('span', 'acc-title', p.title));
      head.appendChild(icon('arrow-right', 'icon acc-chevron'));
      head.addEventListener('click', () => wrap.classList.toggle('open'));
      const body = el('div', 'acc-body');
      wrap.appendChild(head);
      wrap.appendChild(body);
      wrap.__slot = body;
      return wrap;
    },
  },
  css: `
/* 列表项：靠底色划出这一条，不描边；展开状态下底色略深一档 */
.acc-item { border: 0; border-radius: 11px; overflow: hidden; background: var(--ui-band, rgba(17,24,39,.035)); }
.acc-item.open { background: var(--ui-band-strong, rgba(17,24,39,.07)); }
.acc-head {
  width: 100%; display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer;
  font: inherit; font-weight: 600; color: var(--text); background: transparent; border: 0; padding: 11px 13px;
}
.acc-title { flex: 1; }
.acc-chevron { color: var(--ui-ink-3); transition: transform .2s ease; }
.acc-item.open .acc-chevron { transform: rotate(90deg); }
.acc-body { display: none; padding: 0 13px 12px; }
.acc-item.open .acc-body { display: block; }
`,
});
