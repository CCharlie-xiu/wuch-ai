import { defineComponent, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'AsyncImage',
  group: 'Media',
  description: '由服务端解析的图片：模型只描述，不提供链接',
  serverResolved: true,
  skeleton: { ratio: '16 / 9' },
  params: [
    str('query', { required: true }),
    str('aspectRatio', { default: '1:1' }),
    str('maxWidth', { default: '100%' }),
    str('caption'),
  ],
  render: {
    create(p, ctx) {
      const fig = el('figure', 'figure');
      const box = el('div', 'async-image');
      box.style.aspectRatio = String(p.aspectRatio || '1:1').replace(':', ' / ');
      if (p.maxWidth && p.maxWidth !== '100%') box.style.maxWidth = p.maxWidth;
      box.dataset.query = p.query;
      const resolved = p.__resolved || ctx.resolve(p.__id);
      const url = resolved?.state?.images?.[0]?.content_url || resolved?.state?.images?.[0]?.url;
      if (resolved && !resolved.state?.is_loading && url) {
        const img = el('img', 'img');
        img.src = url;
        img.alt = p.query;
        img.loading = 'lazy';
        // 图片搜索可能落空（博客里说的 rough edge），兜底成占位图
        img.addEventListener('error', () => {
          const fb = resolved.state.images[0].fallback;
          if (fb && img.src !== fb) img.src = fb;
        });
        box.appendChild(img);
      } else {
        box.classList.add('loading');
        box.appendChild(el('div', 'shimmer'));
        box.appendChild(el('div', 'async-hint', resolved ? '取图中…' : '等待服务端解析'));
      }
      fig.appendChild(box);
      if (p.caption) fig.appendChild(el('figcaption', null, p.caption));
      return fig;
    },
  },
  markdown: (p) => `![${p.caption || p.alt || p.query || '图片'}](图片由服务端提供)`,
  css: `
.async-image { position: relative; overflow: hidden; border-radius: 11px; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); background: var(--ui-band, rgba(17,24,39,.035)); width: 100%; }
.async-image.loading { display: grid; place-items: center; }
.shimmer { position: absolute; inset: 0; background: linear-gradient(100deg, #f1f1f3 30%, #e6e6ea 50%, #f1f1f3 70%); background-size: 220% 100%; animation: shimmer 1.4s linear infinite; }
.async-hint { position: relative; font-size: 11px; color: var(--ui-ink-3); }
`,
});
