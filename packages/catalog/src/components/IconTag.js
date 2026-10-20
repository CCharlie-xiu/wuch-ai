import { defineComponent, str, enumOf } from '../define.js';
import { el, icon } from '../dom.js';
import { VARIANTS } from '../tokens.js';

export default defineComponent({
  name: 'IconTag',
  group: 'Content',
  description: '带图标的标签',
  skeleton: { inline: true, w: 72, h: 24 },
  params: [
    str('label', { required: true }),
    str('icon'),
    enumOf('variant', VARIANTS, { default: 'neutral' }),
  ],
  render: {
    create(p) {
      const n = el('span', 'tag');
      n.dataset.variant = p.variant || 'neutral';
      if (p.icon) n.appendChild(icon(p.icon, 'icon xs'));
      n.appendChild(el('span', null, p.label));
      return n;
    },
  },
});
