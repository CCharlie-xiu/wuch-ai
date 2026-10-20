import { defineComponent, str, enumOf } from '../define.js';
import { el, icon } from '../dom.js';

export default defineComponent({
  name: 'IconButton',
  group: 'Forms',
  description: '图标按钮',
  skeleton: { inline: true, w: 34, h: 34 },
  params: [
    str('icon', { required: true }),
    str('label'),
    str('action'),
    enumOf('variant', ['ghost', 'secondary'], { default: 'ghost' }),
  ],
  render: {
    create(p, ctx) {
      const n = el('button', 'btn icon-only');
      n.type = 'button';
      n.title = p.label || '';
      n.dataset.variant = p.variant || 'ghost';
      n.appendChild(icon(p.icon, 'icon sm'));
      n.addEventListener('click', () => ctx.emit('click'));
      return n;
    },
  },
});
