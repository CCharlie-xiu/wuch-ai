import { defineComponent, str, enumOf } from '../define.js';
import { el } from '../dom.js';
import { VARIANTS } from '../tokens.js';

export default defineComponent({
  name: 'Tag',
  group: 'Content',
  description: '单个标签',
  skeleton: { inline: true, w: 64, h: 24 },
  params: [
    str('label', { required: true }),
    enumOf('variant', VARIANTS, { default: 'neutral' }),
  ],
  render: {
    create(p) {
      const n = el('span', 'tag', p.label);
      n.dataset.variant = p.variant || 'neutral';
      return n;
    },
  },
});
