import { defineComponent, str, bool, list } from '../define.js';
import { el, icon } from '../dom.js';
import { evaluateSheet, formatValue, isErr, toCell, cellSource, parseInput, colLetters, refName } from '../sheet-formula.js';

const MAX_ROWS = 1000; // 页面上最多画这么多行，导出时仍是全量

/** 内联形态：表头 + 行 → 单元格矩阵（表头占第 1 行） */
export function inlineCells(cols, rows) {
  const head = (cols || []).map((c) => toCell(c && typeof c === 'object' ? (c.label ?? '') : c));
  const body = (rows || []).map((r) => (Array.isArray(r) ? r : [r]).map(toCell));
  return head.length ? [head, ...body] : body;
}

const width = (cells) => cells.reduce((m, r) => Math.max(m, r.length), 0);

export default defineComponent({
  name: 'Sheet',
  group: 'Data',
  skill: 'sheet',
  serverResolved: true,
  description: '可编辑表格（类 Excel）：内联写 Sheet(cols, rows)，单元格可写 "=SUM(B2:B5)" 公式；引用数据集写 Sheet("ds_xxx", "工作表名")',
  skeleton: { frame: true, lines: 6 },
  params: [
    str('dataset'),
    str('sheet'),
    list('cols'),
    list('rows'),
    bool('editable', { default: true }),
    str('caption'),
  ],
  render: {
    create(p, ctx) {
      const wrap = el('div', 'sheet');
      wrap.tabIndex = 0;
      const resolved = p.dataset ? ctx.resolve(p.__id) : null;
      const data = resolved?.state?.data;
      if (p.dataset && !data) {
        wrap.classList.add('loading');
        wrap.appendChild(el('div', 'sheet-hint', resolved?.state?.error ? `数据集 ${p.dataset} 读不出来：${resolved.state.error}` : `正在读取数据集 ${p.dataset}…`));
        return wrap;
      }
      const sheets = data ? data.sheets || [] : [{ name: 'Sheet1', cells: inlineCells(p.cols, p.rows) }];
      let sheetIdx = Math.max(0, sheets.findIndex((s) => s.name === p.sheet));
      const st = {
        cells: [],
        values: [],
        sel: { r: 1, c: 0 },
        editing: null,
      };
      const load = () => {
        st.cells = (sheets[sheetIdx]?.cells || []).map((r) => r.map(toCell));
        if (!st.cells.length) st.cells = [[toCell('')]];
        st.values = evaluateSheet(st.cells);
      };
      load();

      // ── 结构 ──
      const head = el('div', 'sheet-head');
      const title = el('div', 'sheet-title', p.caption || resolved?.state?.name || (p.dataset ? p.dataset : '表格'));
      head.appendChild(title);
      const tabs = el('div', 'sheet-tabs');
      head.appendChild(tabs);
      head.appendChild(el('div', 'sheet-grow'));
      const btn = (label, ico, fn, hidden) => {
        const b = el('button', 'sheet-btn');
        b.type = 'button';
        b.title = label;
        b.appendChild(icon(ico, 'icon xs'));
        b.appendChild(el('span', null, label));
        b.addEventListener('click', fn);
        if (hidden) b.hidden = true;
        head.appendChild(b);
        return b;
      };
      const editable = p.editable !== false;
      btn('行', 'plus', () => edit(() => st.cells.push(Array.from({ length: Math.max(1, width(st.cells)) }, () => toCell('')))), !editable);
      btn('列', 'plus', () => edit(() => st.cells.forEach((r) => r.push(toCell('')))), !editable);
      btn('导入', 'external', () => ctx.host && ctx.host('sheet-import', info()), !editable);
      btn('导出', 'download', () => ctx.host && ctx.host('sheet-export', info()));
      wrap.appendChild(head);

      const fbar = el('div', 'sheet-fbar');
      const refBox = el('span', 'sheet-ref');
      const fx = el('input', 'sheet-fx');
      fx.placeholder = editable ? '选中单元格后在这里输入，= 开头是公式' : '只读';
      fx.readOnly = !editable;
      fbar.appendChild(refBox);
      fbar.appendChild(fx);
      wrap.appendChild(fbar);

      const scroller = el('div', 'sheet-scroll');
      const table = el('table', 'sheet-grid');
      scroller.appendChild(table);
      wrap.appendChild(scroller);
      const foot = el('div', 'sheet-foot');
      wrap.appendChild(foot);

      function info() {
        return { var: p.__var, dataset: p.dataset || null, sheet: sheets[sheetIdx]?.name, sheetIndex: sheetIdx, sheets: sheets.map((s, i) => (i === sheetIdx ? { name: s.name, cells: st.cells } : s)), caption: p.caption || null, editable };
      }

      function renderTabs() {
        tabs.textContent = '';
        if (sheets.length < 2) return;
        sheets.forEach((s, i) => {
          const t = el('button', 'sheet-tab' + (i === sheetIdx ? ' on' : ''), s.name);
          t.type = 'button';
          t.addEventListener('click', () => {
            sheets[sheetIdx] = { ...sheets[sheetIdx], cells: st.cells };
            sheetIdx = i;
            load();
            st.sel = { r: 1, c: 0 };
            renderTabs();
            renderGrid();
          });
          tabs.appendChild(t);
        });
      }

      function renderGrid() {
        table.textContent = '';
        const cols = Math.max(1, width(st.cells));
        const thead = el('thead');
        const hr = el('tr');
        hr.appendChild(el('th', 'sheet-corner'));
        for (let c = 0; c < cols; c++) hr.appendChild(el('th', 'sheet-col', colLetters(c)));
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = el('tbody');
        const shown = Math.min(st.cells.length, MAX_ROWS);
        for (let r = 0; r < shown; r++) {
          const tr = el('tr', r === 0 ? 'sheet-header-row' : null);
          tr.appendChild(el('th', 'sheet-rown', String(r + 1)));
          for (let c = 0; c < cols; c++) {
            const td = el('td');
            td.dataset.r = r;
            td.dataset.c = c;
            const v = st.values[r]?.[c];
            const cell = st.cells[r]?.[c];
            td.textContent = formatValue(v);
            if (typeof v === 'number') td.classList.add('num');
            if (isErr(v)) td.classList.add('err');
            if (cell && cell.f) td.classList.add('fx');
            if (r === st.sel.r && c === st.sel.c) td.classList.add('sel');
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        foot.textContent = `${st.cells.length} 行 × ${cols} 列${st.cells.length > shown ? ` · 只显示前 ${shown} 行，导出是全量` : ''}${editable ? ' · 双击或直接输入可编辑' : ''}`;
        syncBar();
      }

      function syncBar() {
        refBox.textContent = refName(st.sel.r, st.sel.c);
        if (document.activeElement !== fx) fx.value = cellSource(st.cells[st.sel.r]?.[st.sel.c]);
      }

      function select(r, c) {
        st.sel = { r: Math.max(0, Math.min(r, Math.min(st.cells.length, MAX_ROWS) - 1)), c: Math.max(0, Math.min(c, Math.max(1, width(st.cells)) - 1)) };
        for (const td of table.querySelectorAll('td.sel')) td.classList.remove('sel');
        const td = table.querySelector(`td[data-r="${st.sel.r}"][data-c="${st.sel.c}"]`);
        if (td) {
          td.classList.add('sel');
          td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        syncBar();
      }

      function edit(mutate) {
        if (!editable) return;
        mutate();
        st.values = evaluateSheet(st.cells);
        renderGrid();
        ctx.host && ctx.host('sheet-edit', info());
      }

      function setCell(r, c, text) {
        edit(() => {
          while (st.cells.length <= r) st.cells.push([]);
          const row = st.cells[r];
          while (row.length <= c) row.push(toCell(''));
          row[c] = parseInput(text);
        });
      }

      function startEdit(r, c, initial) {
        if (!editable) return;
        const td = table.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
        if (!td) return;
        const input = el('input', 'sheet-cell-input');
        input.value = initial != null ? initial : cellSource(st.cells[r]?.[c]);
        td.textContent = '';
        td.appendChild(input);
        st.editing = { r, c };
        input.focus();
        let done = false;
        const finish = (commit, move) => {
          if (done) return;
          done = true;
          st.editing = null;
          if (commit) setCell(r, c, input.value);
          else renderGrid();
          if (move) select(r + move[0], c + move[1]);
          wrap.focus({ preventScroll: true });
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(true, [1, 0]);
          else if (e.key === 'Tab') {
            e.preventDefault();
            finish(true, [0, e.shiftKey ? -1 : 1]);
          } else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
      }

      table.addEventListener('click', (e) => {
        const td = e.target.closest('td');
        if (td && !st.editing) select(Number(td.dataset.r), Number(td.dataset.c));
      });
      table.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td');
        if (td) startEdit(Number(td.dataset.r), Number(td.dataset.c));
      });
      wrap.addEventListener('keydown', (e) => {
        if (st.editing || e.target === fx) return;
        const { r, c } = st.sel;
        const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] };
        if (moves[e.key]) {
          e.preventDefault();
          select(r + moves[e.key][0], c + moves[e.key][1]);
        } else if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          startEdit(r, c);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          setCell(r, c, '');
        } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          startEdit(r, c, e.key);
        }
      });
      fx.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          setCell(st.sel.r, st.sel.c, fx.value);
          select(st.sel.r + 1, st.sel.c);
          wrap.focus({ preventScroll: true });
        } else if (e.key === 'Escape') {
          fx.value = cellSource(st.cells[st.sel.r]?.[st.sel.c]);
          wrap.focus({ preventScroll: true });
        }
      });

      renderTabs();
      renderGrid();
      return wrap;
    },
  },
  markdown(p) {
    const cells = p.dataset ? [] : inlineCells(p.cols, p.rows);
    if (!cells.length) return p.dataset ? `（表格：数据集 ${p.dataset}）` : '';
    const values = evaluateSheet(cells);
    const row = (r) => '| ' + r.map((v) => formatValue(v)).join(' | ') + ' |';
    return [row(values[0]), row(values[0].map(() => '---')), ...values.slice(1).map(row)].join('\n');
  },
  css: `
/* 块级：极浅底色划界。放进 Card 时由 Card 统一接管底色（见 Card.js），这里不再套一层 */
.sheet { display: flex; flex-direction: column; border: 0; border-radius: 11px; background: var(--ui-band, rgba(17,24,39,.035)); overflow: hidden; outline: none; font-size: 12.5px; }
.sheet:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
.sheet.loading { padding: 18px; }
.sheet-hint { color: var(--ui-ink-3); font-size: 12px; }
.sheet-head { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--ui-line); }
/* 表格自带的小标题比卡片标题弱一档：卡片已经说过这是什么，这里只补充口径 */
.sheet-title { font-weight: 500; font-size: 11.5px; color: var(--ui-ink-3); letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sheet-grow { flex: 1; }
.sheet-tabs { display: flex; gap: 4px; margin-left: 6px; }
.sheet-tab { font: inherit; font-size: 11.5px; border: 1px solid var(--ui-line); background: transparent; color: var(--ui-ink-3); border-radius: 7px; padding: 2px 8px; cursor: pointer; }
.sheet-tab.on { background: var(--ui-band-strong, rgba(17,24,39,.07)); color: var(--text); }
.sheet-btn { font: inherit; font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; border: 1px solid transparent; background: transparent; color: var(--ui-ink-3); border-radius: 7px; padding: 3px 8px; cursor: pointer; }
.sheet-btn:hover { color: var(--text); background: var(--ui-band-strong, rgba(17,24,39,.07)); }
.sheet-fbar { display: flex; align-items: center; border-bottom: 1px solid var(--ui-line); }
.sheet-ref { min-width: 52px; padding: 5px 12px; font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px; color: var(--ui-ink-3); border-right: 1px solid var(--ui-line); }
.sheet-fx { flex: 1; border: 0; outline: none; padding: 5px 12px; font: inherit; font-family: var(--mono, ui-monospace, monospace); font-size: 12px; background: transparent; color: var(--text); }
.sheet-scroll { overflow: auto; max-height: 460px; }
.sheet-grid { border-collapse: collapse; min-width: 100%; }
/* 单元格：只画横线（横读数据靠行线），竖线压到几乎看不见 —— 网格越密，眼睛越抓不住行 */
.sheet-grid th, .sheet-grid td { border: 0; border-bottom: 1px solid var(--ui-line); border-right: 1px solid rgba(17, 24, 39, .035); padding: 6px 10px; white-space: nowrap; height: 30px; }
.sheet-grid thead th { position: sticky; top: 0; z-index: 2; background: var(--ui-band-strong, rgba(17,24,39,.07)); color: var(--ui-ink-3); font-weight: 500; font-size: 10.5px; text-align: center; }
.sheet-grid .sheet-rown { position: sticky; left: 0; z-index: 1; background: var(--ui-band, rgba(17,24,39,.035)); color: var(--ui-ink-3); font-weight: 500; font-size: 10.5px; text-align: center; min-width: 34px; }
.sheet-grid .sheet-corner { left: 0; z-index: 3; }
.sheet-header-row td { font-weight: 600; background: transparent; color: var(--text); border-bottom-color: var(--ui-line-strong, rgba(17,24,39,.1)); }
.sheet-grid td { min-width: 72px; cursor: cell; }
/* 首列是「行名」：给一点字重，让每一行有锚点 */
.sheet-grid tbody td:first-child { font-weight: 500; color: var(--text); }
.sheet-grid td.num { text-align: right; font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
.sheet-grid td.fx { color: var(--ui-ink-2); }
.sheet-grid td.err { color: #b91c1c; }
.sheet-grid td.sel { outline: 2px solid var(--accent); outline-offset: -2px; }
.sheet-cell-input { width: 100%; min-width: 60px; border: 0; outline: none; font: inherit; background: transparent; color: var(--text); padding: 0; }
.sheet-foot { padding: 6px 12px; font-size: 11px; color: var(--ui-ink-3); border-top: 1px solid var(--ui-line); }
`,
});
