import { defineComponent, str, bool, enumOf } from '../define.js';
import { el, icon } from '../dom.js';

export default defineComponent({
  name: 'Button',
  group: 'Forms',
  description: '按钮。action："submit:<表单id>" 提交表单；"turn:<文字>" 以这段文字开启下一轮对话；"action:<名字>" 交给宿主',
  skeleton: { inline: true, w: 110, h: 34 },
  params: [
    str('label', { required: true }),
    str('action'),
    enumOf('variant', ['primary', 'secondary', 'tertiary', 'danger'], { default: 'primary' }),
    str('icon'),
    bool('block', { default: false }),
  ],
  render: {
    create(p, ctx) {
      const n = el('button', 'btn');
      n.type = 'button';
      n.dataset.variant = p.variant || 'primary';
      if (p.block) n.classList.add('block');
      if (p.icon) n.appendChild(icon(p.icon, 'icon sm'));
      n.appendChild(el('span', null, p.label));
      n.addEventListener('click', () => ctx.emit('click'));
      return n;
    },
  },
  markdown: (p) => `[${p.label}]`,
});
