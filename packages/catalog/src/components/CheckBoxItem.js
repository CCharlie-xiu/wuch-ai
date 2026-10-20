import { defineComponent, str, bool } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'CheckBoxItem',
  group: 'Forms',
  description: '多选项',
  skeleton: { lines: 1 },
  params: [
    str('value', { required: true }),
    str('label', { required: true }),
    bool('checked', { default: false }),
  ],
  render: {
    create(p, ctx) {
      const n = el('label', 'opt');
      const box = el('input');
      box.type = 'checkbox';
      box.name = p.value;
      box.checked = !!p.checked;
      box.addEventListener('change', () => ctx.emit('change', box.checked));
      n.appendChild(box);
      n.appendChild(el('span', null, p.label));
      return n;
    },
    updates: ['checked'],
    update(n, p) {
      const box = n.querySelector('input');
      if (box && box.checked !== !!p.checked) box.checked = !!p.checked;
    },
  },
});
