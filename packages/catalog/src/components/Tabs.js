import { defineComponent, nodes } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Tabs',
  group: 'Layout',
  description: '标签页容器，每个子项是一个 TabItem',
  skeleton: { frame: true, lines: 4 },
  params: [
    nodes('items'),
  ],
  render: {
    needsChildSync: true,
    create() {
      const wrap = el('div', 'tabs');
      const bar = el('div', 'tabs-bar');
      const panes = el('div', 'tabs-panes');
      wrap.appendChild(bar);
      wrap.appendChild(panes);
      wrap.__slot = panes;
      wrap.__bar = bar;
      return wrap;
    },
    updates: [],
    update(n, p, prev, ctx) {
      const bar = n.__bar;
      bar.innerHTML = '';
      ctx.childRecords.forEach((c, i) => {
        if (c.type !== 'TabItem') return;
        const b = el('button', 'tab', c.props.label || c.props.id);
        b.type = 'button';
        if (i === (n.__active || 0)) b.classList.add('active');
        b.addEventListener('click', () => {
          n.__active = i;
          Array.from(bar.children).forEach((x, k) => x.classList.toggle('active', k === i));
          const recs = ctx.childRecords.filter((r) => r.type === 'TabItem');
          recs.forEach((r, k) => {
            if (r.el) r.el.style.display = k === i ? '' : 'none';
          });
        });
        bar.appendChild(b);
      });
      const recs = ctx.childRecords.filter((r) => r.type === 'TabItem');
      recs.forEach((r, k) => {
        if (r.el) r.el.style.display = k === (n.__active || 0) ? '' : 'none';
      });
    },
  },
  css: `
.tabs { display: flex; flex-direction: column; gap: 12px; }
/* 分段控件：底色轨道 + 白胶囊选中（控件层，不用描边） */
.tabs-bar { display: inline-flex; align-self: flex-start; gap: 2px; padding: 3px; background: var(--ui-band-strong, rgba(17,24,39,.07)); border-radius: 999px; }
.tabs-bar .tab {
  font: inherit; font-size: 12.5px; font-weight: 500; color: var(--ui-ink-2); background: transparent;
  border: 0; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  transition: background .18s ease, color .18s ease, box-shadow .18s ease;
}
.tabs-bar .tab:hover { color: var(--text); }
.tabs-bar .tab.active { color: var(--text); font-weight: 600; background: var(--surface-card, #fff); box-shadow: 0 1px 2px rgba(17, 24, 39, .06); }
`,
});
