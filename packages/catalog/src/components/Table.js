import { defineComponent, str, bool, list } from '../define.js';
import { el, fmtNum } from '../dom.js';

export default defineComponent({
  name: 'Table',
  group: 'Data',
  description: '数据表格：cols 是 Col 数组（或字符串数组），rows 是二维数组，每行与 cols 一一对应',
  skeleton: { frame: true, lines: 5 },
  params: [
    list('cols', { required: true }),
    list('rows', { required: true }),
    bool('striped', { default: true }),
    str('caption'),
  ],
  render: {
    create(p) {
      const wrap = el('div', 'table-wrap');
      const table = el('table', 'table');
      if (p.striped) table.classList.add('striped');
      const cols = (p.cols || []).map((c) => (c && typeof c === 'object' ? { label: c.label ?? '', type: c.type ?? 'string' } : { label: String(c ?? ''), type: 'string' }));
      const thead = el('thead');
      const hr = el('tr');
      cols.forEach((c) => hr.appendChild(el('th', null, c.label)));
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const row of p.rows || []) {
        const tr = el('tr');
        cols.forEach((c, i) => {
          const raw = Array.isArray(row) ? row[i] : row?.[c.label];
          const td = el('td');
          if (c.type === 'number' && typeof raw === 'number') td.classList.add('num');
          td.textContent = typeof raw === 'number' ? fmtNum(raw) : raw == null ? '—' : String(raw);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      if (p.caption) wrap.appendChild(el('div', 'table-caption', p.caption));
      return wrap;
    },
  },
  markdown(p) {
    const cols = (p.cols || []).map((c) => (c && typeof c === 'object' ? c.label : String(c)));
    if (!cols.length) return '';
    const row = (cells) => '| ' + cells.join(' | ') + ' |';
    return [row(cols), row(cols.map(() => '---')), ...(p.rows || []).map((r) => row((Array.isArray(r) ? r : [r]).map((c) => String(c ?? ''))))].join('\n');
  },
  css: `
/* 块级元素：极浅底色划界，不描边。表格内部只用横线分出行 */
.table-wrap { display: flex; flex-direction: column; overflow: auto; border: 0; border-radius: 14px; background: var(--ui-band, rgba(17,24,39,.035)); }
.table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
.table th { position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 500; color: var(--ui-ink-3); font-size: 11px; letter-spacing: .02em; padding: 9px 14px 8px; background: var(--ui-band-strong, rgba(17,24,39,.07)); border-bottom: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); white-space: nowrap; }
.table td { padding: 11px 14px; border-bottom: 1px solid var(--ui-line); vertical-align: middle; transition: background .12s ease; }
.table.striped tbody tr:nth-child(even) td { background: transparent; }
.table tbody tr:hover td,
.table.striped tbody tr:hover td { background: rgba(17, 24, 39, .03); }
.table tbody tr:last-child td { border-bottom: 0; }
.table td:first-child { color: var(--text); font-weight: 500; }
.table td.num { text-align: right; font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
.table-caption { font-size: 11.5px; color: var(--ui-ink-3); padding: 10px 14px; border-top: 1px solid var(--ui-line); }
/* 表格已经在卡片里：不再叠一层底色，只留行分隔线 */
.card .table-wrap { border: 0; border-radius: 0; background: transparent; }
`,
});
