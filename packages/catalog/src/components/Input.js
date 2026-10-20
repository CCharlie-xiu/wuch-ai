import { defineComponent, str, enumOf, list } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Input',
  group: 'Forms',
  description: '文本输入框',
  skeleton: { h: 36 },
  params: [
    str('name', { required: true }),
    str('placeholder'),
    enumOf('type', ['text', 'email', 'number', 'password', 'tel'], { default: 'text' }),
    str('value'),
    list('rules'),
  ],
  render: {
    create(p, ctx) {
      const n = el('input', 'input');
      n.type = p.type || 'text';
      n.name = p.name;
      n.placeholder = p.placeholder || '';
      if (p.value != null) n.value = String(p.value);
      n.addEventListener('input', () => ctx.emit('change', n.value));
      return n;
    },
    updates: ['placeholder', 'value'],
    update(n, p) {
      if (p.placeholder != null && n.placeholder !== p.placeholder) n.placeholder = p.placeholder;
      if (p.value != null && document.activeElement !== n && n.value !== String(p.value)) n.value = String(p.value);
    },
  },
});
