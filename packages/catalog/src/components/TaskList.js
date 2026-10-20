// ─────────────────────────────────────────────────────────────────────────────
// 任务清单 / 进度表：顶部进度条按完成数自动算，下面是可以点着勾的清单。
//
// 进度条和清单必须在同一个组件里 —— OpenUI Lang 没有跨组件的状态通道，
// 拆成「ProgressBar + 清单」的话，勾选之后进度条不会动。
//
// 勾选纯本地：改的是这个组件自己的 DOM，不产生模型调用，也不回吐给宿主。
// ─────────────────────────────────────────────────────────────────────────────

import { defineComponent, str, list } from '../define.js';
import { el, svgEl } from '../dom.js';

/** 复制到剪贴板：安全上下文走 Clipboard API，否则退回 execCommand */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/** 按当前的勾选状态导出 Markdown 任务列表 */
function serialize(wrap) {
  return (wrap.__items || []).map((it, i) => `- [${wrap.__done.has(i) ? 'x' : ' '}] ${it.title}`).join('\n');
}

function checkMark() {
  const svg = svgEl('svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  const path = svgEl('path');
  path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** 数组里可能是 TaskItem 编出来的对象，也可能被写成裸字符串 */
function normalize(items) {
  return (items || []).map((it) =>
    it && typeof it === 'object'
      ? { title: it.title ?? '', note: it.note ?? '', done: !!it.done }
      : { title: String(it ?? ''), note: '', done: false }
  );
}

function create(p) {
  const wrap = el('div', 'tasks');

  const head = el('div', 'tasks-head');
  const track = el('div', 'tasks-track');
  const fill = el('div', 'tasks-fill');
  track.appendChild(fill);
  const count = el('span', 'tasks-count');
  head.append(track, count);

  const body = el('div', 'tasks-body');
  wrap.append(head, body);

  const copy = el('button', 'tasks-copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    const label = wrap.__props?.copyLabel ?? '复制任务清单';
    const ok = await copyText(serialize(wrap));
    copy.textContent = ok ? '已复制' : '复制失败，请手动选中';
    copy.classList.toggle('ok', ok);
    clearTimeout(copy._t);
    copy._t = setTimeout(() => {
      copy.textContent = label;
      copy.classList.remove('ok');
    }, 1800);
  });
  wrap.appendChild(copy);

  wrap.__fill = fill;
  wrap.__copy = copy;
  wrap.__count = count;
  wrap.__body = body;
  wrap.__touched = new Map(); // 用户点过的项：索引 → 状态，重建时不被模型给的值盖掉
  wrap.__done = new Set();

  paint(wrap, p);
  return wrap;
}

function paint(wrap, p) {
  wrap.__props = p || {};
  const items = normalize(wrap.__props.items);

  // 用户点过的以用户为准，其余跟随模型给的状态
  const done = new Set();
  items.forEach((it, i) => {
    const user = wrap.__touched.get(i);
    if (user !== undefined ? user : it.done) done.add(i);
  });
  wrap.__done = done;

  const n = items.length;
  const k = done.size;
  wrap.__fill.style.width = (n ? (k / n) * 100 : 0) + '%';
  wrap.__count.textContent = `${k}/${n}`;
  wrap.classList.toggle('all', n > 0 && k === n);

  wrap.__items = items;
  wrap.__body.textContent = '';
  items.forEach((it, i) => wrap.__body.appendChild(row(wrap, it, i, done.has(i))));

  if (wrap.__copy) {
    const label = wrap.__props.copyLabel ?? '复制任务清单';
    wrap.__copy.textContent = label;
    wrap.__copy.hidden = !label || !n; // 写空字符串就不显示按钮
  }
}

function row(wrap, it, i, isDone) {
  const line = el('div', 'tasks-row');
  if (isDone) line.classList.add('done');

  const btn = el('button', 'tasks-check');
  btn.type = 'button';
  btn.setAttribute('aria-pressed', String(isDone));
  btn.setAttribute('aria-label', `${isDone ? '取消完成' : '标记完成'}：${it.title}`);
  if (isDone) btn.appendChild(checkMark());
  btn.addEventListener('click', () => {
    wrap.__touched.set(i, !wrap.__done.has(i));
    paint(wrap, wrap.__props);
  });

  const text = el('div', 'tasks-text');
  text.appendChild(el('div', 'tasks-title', it.title));
  if (it.note) text.appendChild(el('div', 'tasks-note', it.note));

  line.append(btn, text);
  return line;
}

function update(wrap, p) {
  paint(wrap, p);
}

export default defineComponent({
  name: 'TaskList',
  group: 'Layout',
  description:
    '任务清单 / 进度表：items 是 TaskItem 数组，每项写标题、说明和是否完成。顶部按完成数自动算进度条，点圆圈可以勾选，底部按钮把当前清单复制成 Markdown（copyLabel 改文案，写空字符串就不显示按钮）。都在本地生效，不产生模型调用',
  skeleton: { lines: 7 },
  params: [list('items', { required: true }), str('copyLabel', { default: '复制任务清单' })],
  render: { create, updates: ['items', 'copyLabel'], update },
  markdown: (p) =>
    normalize(p.items)
      .map((it) => `- [${it.done ? 'x' : ' '}] ${it.title}`)
      .join('\n'),
  css: `
.tasks { display: flex; flex-direction: column; gap: 12px; }
.tasks-head { display: flex; align-items: center; gap: 10px; }
.tasks-track { flex: 1 1 auto; min-width: 0; height: 7px; background: var(--ui-band-strong, rgba(17,24,39,.07)); border-radius: 999px; overflow: hidden; }
.tasks-fill { height: 100%; width: 0; background: var(--accent); border-radius: 999px; transition: width .35s cubic-bezier(.22, 1, .36, 1); }
.tasks.all .tasks-fill { background: var(--ok); }
.tasks-count { flex: 0 0 auto; font: 11.5px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.tasks.all .tasks-count { color: var(--ok); }
.tasks-body { display: flex; flex-direction: column; }
.tasks-row { display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; border-top: 1px solid var(--ui-line, rgba(17,24,39,.06)); }
.tasks-row:first-child { border-top: 0; }
.tasks-check {
  flex: 0 0 auto; width: 19px; height: 19px; margin-top: 1px; padding: 0;
  display: grid; place-items: center; border-radius: 999px; cursor: pointer;
  border: 1.6px solid var(--ui-line-strong, rgba(17,24,39,.1)); background: transparent; color: #ffffff;
  transition: background .15s ease, border-color .15s ease;
}
.tasks-check:hover { border-color: var(--accent); }
.tasks-check:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.tasks-row.done .tasks-check { background: var(--accent); border-color: var(--accent); }
.tasks-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tasks-title { font-size: 13px; font-weight: 550; color: var(--text); }
.tasks-note { font-size: 11.5px; color: var(--ui-ink-3); line-height: 1.6; }
.tasks-row.done .tasks-title { color: var(--muted); }
.tasks-copy {
  width: 100%; font: inherit; font-size: 12.5px; color: var(--muted);
  background: transparent; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); border-radius: 9px;
  padding: 8px 12px; cursor: pointer;
  transition: color .15s ease, border-color .15s ease;
}
.tasks-copy:hover { color: var(--text); border-color: rgba(17, 24, 39, .16); }
.tasks-copy.ok { color: var(--ok); border-color: var(--ok); }
`,
});
