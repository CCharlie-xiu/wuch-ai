import { defineComponent, str, num, list } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'TextArea',
  group: 'Forms',
  description: '多行文本输入',
  skeleton: { h: 80 },
  params: [
    str('name', { required: true }),
    str('placeholder'),
    num('rows', { default: 4 }),
    str('value'),
    list('rules'),
  ],
  render: {
    create(p, ctx) {
      const n = el('textarea', 'input');
      n.name = p.name;
      n.rows = p.rows || 4;
      n.placeholder = p.placeholder || '';
      if (p.value != null) n.value = String(p.value);
      n.addEventListener('input', () => ctx.emit('change', n.value));
      return n;
    },
    updates: ['value'],
    update(n, p) {
      if (p.value != null && document.activeElement !== n && n.value !== String(p.value)) n.value = String(p.value);
    },
  },
});
