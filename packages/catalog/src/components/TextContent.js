import { defineComponent, str, bool, style, textColor, textSize, textWeight } from '../define.js';
import { el, textAttrs } from '../dom.js';

function apply(n, p) {
  n.dataset.style = p.style || 'default';
  n.classList.toggle('muted', !!p.muted && !p.color);
  textAttrs(n, p);
}

export default defineComponent({
  name: 'TextContent',
  group: 'Content',
  description:
    '一段文字：style 是排版预设；color / size / weight 单独覆盖颜色、字号、粗细（只收语义名）。一句话里只想强调几个字时用 RichText',
  skeleton: { lines: 1 },
  params: [
    str('text', { required: true }),
    style('style', 'default'),
    bool('muted', { default: false }),
    textColor('color'),
    textSize('size'),
    textWeight('weight'),
  ],
  render: {
    create(p) {
      const n = el('div', 'text', p.text ?? '');
      apply(n, p);
      return n;
    },
    updates: ['muted', 'style', 'text', 'color', 'size', 'weight'],
    update(n, p) {
      apply(n, p);
      if (n.textContent !== String(p.text ?? '')) n.textContent = p.text ?? '';
    },
  },
  markdown: (p) => {
    const heading = /^xl/.test(p.style) || /^(2xl|3xl)$/.test(p.size) ? '## ' : /^large/.test(p.style) || /^(lg|xl)$/.test(p.size) ? '### ' : '';
    const bold = !heading && /^(semibold|bold)$/.test(p.weight);
    const text = p.text ?? '';
    return heading + (bold && text ? `**${text}**` : text);
  },
  css: `
.text { font-size: 14px; line-height: 1.65; }
.text:where([data-style="small-heavy"]) { font-size: 12px; font-weight: 650; }
.text:where([data-style="default-heavy"]) { font-size: 14px; font-weight: 650; }
.text:where([data-style="large"]) { font-size: 17px; }
.text:where([data-style="large-heavy"]) { font-size: 17px; font-weight: 650; }
.text:where([data-style="xl"]) { font-size: 22px; }
.text:where([data-style="xl-heavy"]) { font-size: 24px; font-weight: 700; letter-spacing: -.01em; }
.text:where([data-style="code"]) { font-family: var(--mono); font-size: 12.5px; color: #3f3f46; }
.text.muted { color: var(--muted); }
`,
});
