import { defineComponent, nodes, str, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'TimelineItem',
  group: 'Layout',
  description: '时间线条目：时间 + 标题 + 正文',
  skeleton: { lines: 2 },
  params: [
    str('title', { required: true }),
    str('time'),
    enumOf('status', ['done', 'active', 'todo'], { default: 'todo' }),
    str('text'),
    nodes('children'),
  ],
  render: {
    create(p) {
      const n = el('div', 'tl-item');
      n.dataset.status = p.status || 'todo';
      const rail = el('div', 'tl-rail');
      rail.appendChild(el('span', 'tl-dot'));
      const body = el('div', 'tl-body');
      const head = el('div', 'tl-head');
      if (p.time) head.appendChild(el('span', 'tl-time', p.time));
      head.appendChild(el('span', 'tl-title', p.title));
      body.appendChild(head);
      if (p.text) body.appendChild(el('div', 'tl-text', p.text));
      n.appendChild(rail);
      n.appendChild(body);
      n.__slot = body;
      return n;
    },
  },
  markdown: (p) => `- ${p.time ? p.time + ' ' : ''}**${p.title}**${p.text ? '：' + p.text : ''}`,
  css: `
.tl-item { display: flex; gap: 12px; }
.tl-rail { display: flex; flex-direction: column; align-items: center; flex: 0 0 16px; }
.tl-rail::after { content: ""; flex: 1; width: 1px; background: var(--border); margin: 4px 0; }
.tl-item:last-child .tl-rail::after { display: none; }
.tl-dot { width: 9px; height: 9px; border-radius: 999px; background: var(--card); border: 1.5px solid var(--border); margin-top: 5px; flex: 0 0 auto; }
.tl-body { padding-bottom: 14px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.tl-head { display: flex; align-items: baseline; gap: 8px; }
.tl-time { font-size: 11px; color: var(--dim); }
.tl-title { font-size: 13.5px; font-weight: 650; }
.tl-text { font-size: 12.5px; color: var(--muted); }
.tl-item[data-status="done"] .tl-dot { background: var(--ok); border-color: var(--ok); }
.tl-item[data-status="active"] .tl-dot { background: var(--accent); border-color: var(--accent); outline: 3px solid var(--accent-soft); }
`,
});
