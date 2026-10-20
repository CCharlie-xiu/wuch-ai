import { defineComponent, str, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Entity',
  group: 'Data',
  description: '商品 / 地点卡片，字段由服务端按引用填充',
  serverResolved: true,
  skeleton: { frame: true, h: 120, lines: 2 },
  params: [
    str('ref', { required: true }),
    enumOf('kind', ['product', 'place', 'person', 'org'], { default: 'product' }),
  ],
  render: {
    create(p, ctx) {
      const r = p.__resolved || ctx.resolve(p.ref) || ctx.resolve(p.__id) || {};
      const s = r.state || {};
      const n = el('div', 'entity');
      if (s.image_url) {
        const img = el('img', 'entity-img');
        img.src = s.image_url;
        img.alt = s.title || '';
        n.appendChild(img);
      }
      const body = el('div', 'entity-body');
      body.appendChild(el('div', 'entity-title', s.title || p.ref));
      if (s.subtitle) body.appendChild(el('div', 'entity-sub', s.subtitle));
      if (s.displayed_price) body.appendChild(el('div', 'entity-price', s.displayed_price));
      if (s.merchant) body.appendChild(el('div', 'entity-merchant', s.merchant));
      n.appendChild(body);
      return n;
    },
  },
  css: `
.entity { display: flex; gap: 10px; border: 0; border-radius: 12px; padding: 10px; background: var(--ui-band, rgba(17,24,39,.035)); }
.entity-img { width: 72px; height: 72px; object-fit: cover; border-radius: 9px; }
.entity-body { display: flex; flex-direction: column; gap: 2px; }
.entity-title { font-weight: 650; font-size: 13px; }
.entity-sub, .entity-merchant { font-size: 11.5px; color: var(--ui-ink-3); }
.entity-price { font-size: 14px; font-weight: 700; color: var(--text); }
`,
});
