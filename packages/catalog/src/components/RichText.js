import { defineComponent, list, style, textColor } from '../define.js';
import { el, textAttrs } from '../dom.js';

/** spans 里的一项：纯字符串原样输出，Span 编成的对象带上自己的颜色 / 字号 / 粗细 */
function paint(n, spans) {
  n.replaceChildren();
  for (const s of spans || []) {
    if (s == null) continue;
    if (typeof s !== 'object') {
      n.appendChild(document.createTextNode(String(s)));
      continue;
    }
    const span = el('span', 'rt-span', s.text ?? '');
    textAttrs(span, s);
    if (s.italic) span.classList.add('rt-italic');
    n.appendChild(span);
  }
}

function apply(n, p) {
  n.dataset.style = p.style || 'default';
  textAttrs(n, { color: p.color });
}

export default defineComponent({
  name: 'RichText',
  group: 'Content',
  description:
    '一段行内混排的文字：spans 是字符串与 Span 混合的数组，例如 ["月费 ", Span("¥1,280", "primary", "bold"), "，比上月 ", Span("+12%", "success")]；style 是整段的排版预设，color 是整段底色',
  skeleton: { lines: 1 },
  params: [
    list('spans', { required: true }),
    style('style', 'default'),
    textColor('color'),
  ],
  render: {
    create(p) {
      const n = el('div', 'text rich-text');
      apply(n, p);
      paint(n, p.spans);
      return n;
    },
    updates: ['spans', 'style', 'color'],
    update(n, p, prev) {
      apply(n, p);
      if (JSON.stringify(p.spans) !== JSON.stringify(prev?.spans)) paint(n, p.spans);
    },
  },
  markdown: (p) =>
    (p.spans || [])
      .map((s) => {
        if (s == null) return '';
        if (typeof s !== 'object') return String(s);
        let t = String(s.text ?? '');
        if (!t) return '';
        if (/^(semibold|bold)$/.test(s.weight)) t = `**${t}**`;
        if (s.italic) t = `*${t}*`;
        return t;
      })
      .join(''),
  css: `
.rich-text { overflow-wrap: anywhere; }
.rt-italic { font-style: italic; }
`,
});
