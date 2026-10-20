import { defineComponent, node, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'FormControl',
  group: 'Forms',
  description: '表单字段：标签 + 控件',
  skeleton: { lines: 2 },
  params: [
    str('label', { required: true }),
    node('control'),
    str('hint'),
  ],
  render: {
    create(p) {
      const n = el('div', 'field');
      if (p.label) {
        const lab = el('label', 'field-label', p.label);
        n.appendChild(lab);
      }
      if (p.hint) n.appendChild(el('div', 'field-hint', p.hint));
      return n;
    },
  },
  css: `
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; color: var(--ui-ink-2); font-weight: 500; }
.field-hint { font-size: 11px; color: var(--ui-ink-3); }
`,
});
