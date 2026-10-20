import { defineComponent, str, list } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Select',
  group: 'Forms',
  description: '下拉选择',
  skeleton: { h: 36 },
  params: [
    str('name', { required: true }),
    list('options', { required: true }),
    str('placeholder'),
    str('value'),
    list('rules'),
  ],
  render: {
    create(p, ctx) {
      const n = el('select', 'input');
      n.name = p.name;
      const ph = el('option', null, p.placeholder || '请选择');
      ph.value = '';
      n.appendChild(ph);
      for (const o of p.options || []) {
        const opt = el('option', null, o?.label ?? String(o));
        opt.value = o?.value ?? String(o);
        n.appendChild(opt);
      }
      if (p.value != null) n.value = String(p.value);
      n.addEventListener('change', () => ctx.emit('change', n.value));
      return n;
    },
    updates: ['value'],
    update(n, p) {
      if (p.value != null && n.value !== String(p.value)) n.value = String(p.value);
    },
  },
});
