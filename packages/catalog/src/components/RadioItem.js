import { defineComponent, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'RadioItem',
  group: 'Forms',
  description: '单选项',
  skeleton: { lines: 1 },
  params: [
    str('value', { required: true }),
    str('label', { required: true }),
  ],
  render: {
    create(p, ctx) {
      const n = el('label', 'opt');
      const box = el('input');
      box.type = 'radio';
      box.name = p.value;
      box.addEventListener('change', () => ctx.emit('change', p.value));
      n.appendChild(box);
      n.appendChild(el('span', null, p.label));
      return n;
    },
  },
});
