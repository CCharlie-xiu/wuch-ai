// ─────────────────────────────────────────────────────────────────────────────
// 演示回放页：不连模型，走预置 OpenUI Lang。
// 链路与聊天页完全相同 —— 同一个会话内核、同一份编译器和沙箱运行时。
//
// 两条额外能力（都不经过模型）：
//   · Excel：导入自己的 xlsx / xls / csv → 服务端解析成数据集 → 现场生成一份分析界面
//   · 画布：Drawing 由 worker 里的程序画，坐标写死在 Lang 里，可导出 PNG
// ─────────────────────────────────────────────────────────────────────────────

import { createSession } from './session.js';
import { createInspector } from './inspector.js';
import { createShell } from './shell.js';
import { DEMOS, DEMO_CATEGORIES, FOLLOWUP } from '@openui-lab/fixtures';
import { evaluateSheet, toCell } from '@openui-lab/catalog';
import { authHeaders } from './accounts.js';

const API = '/api';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// 界面上按了「继续对话」时，用一条预置回答顶上（真实模型由会话内核去问上游）
const session = createSession({
  stage: $('#stage'),
  runnerFrame: $('#runner'),
  resolveCannedTurn: () => ({ source: FOLLOWUP.source }),
  // 绑定数据集的 Sheet 由这里取数（导入的 Excel 走这条）
  resolveDataset: async (datasetId) => {
    const r = await fetch(`${API}/datasets/${encodeURIComponent(datasetId)}/data`, { headers: authHeaders() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return { version: j.version.id, name: j.dataset.name, data: j.data };
  },
  onHost: (kind, payload) => onSheetHost(kind, payload),
});
const inspector = createInspector({ session });
createShell({ session, inspector, toast });

let live = null;
let current = DEMOS[0];
let filter = 'all';

function addUserBubble(text) {
  const t = $('#transcript');
  const wrap = el('div', 'turn user');
  wrap.appendChild(el('div', 'bubble', text));
  t.appendChild(wrap);
  t.scrollTop = t.scrollHeight;
}

function addAssistantBubble() {
  const t = $('#transcript');
  const wrap = el('div', 'turn assistant');
  const head = el('div', 'turn-head');
  head.appendChild(el('span', 'badge', 'assistant'));
  const status = el('span', 'turn-status', '回放中…');
  head.appendChild(status);
  const fbBtn = el('button', 'mini', '看 fallback');
  head.appendChild(fbBtn);
  wrap.appendChild(head);

  const pre = el('pre', 'dil-stream');
  const fb = el('div', 'fallback hidden');
  fbBtn.addEventListener('click', () => fb.classList.toggle('hidden'));
  wrap.appendChild(pre);
  wrap.appendChild(fb);
  t.appendChild(wrap);
  t.scrollTop = t.scrollHeight;
  live = { pre, status, fb };
  return live;
}

// ── 演示列表：分类筛选 + 分组 ──────────────────────────────────────────────
function renderCats() {
  const box = $('#demo-cats');
  box.textContent = '';
  const all = el('button', 'cat' + (filter === 'all' ? ' on' : ''), '全部');
  all.addEventListener('click', () => {
    filter = 'all';
    renderCats();
    renderDemoList();
  });
  box.appendChild(all);
  for (const c of DEMO_CATEGORIES) {
    const count = DEMOS.filter((d) => d.category === c.id).length;
    if (!count) continue;
    const b = el('button', 'cat' + (filter === c.id ? ' on' : ''), c.name);
    b.title = c.hint || '';
    b.addEventListener('click', () => {
      filter = c.id;
      renderCats();
      renderDemoList();
    });
    box.appendChild(b);
  }
}

function renderDemoList() {
  const list = $('#demos');
  list.textContent = '';
  let shown = 0;
  for (const c of DEMO_CATEGORIES) {
    if (filter !== 'all' && filter !== c.id) continue;
    const items = DEMOS.filter((d) => d.category === c.id);
    if (!items.length) continue;
    const group = el('div', 'demo-group');
    const head = el('div', 'demo-group-head');
    head.appendChild(el('span', 'demo-group-name', c.name));
    head.appendChild(el('span', 'demo-group-count', String(items.length)));
    group.appendChild(head);
    for (const d of items) {
      const b = el('button', 'demo' + (d === current ? ' active' : ''));
      b.appendChild(el('span', 'demo-title', d.title));
      b.appendChild(el('span', 'demo-hint', d.hint));
      b.addEventListener('click', () => {
        for (const x of list.querySelectorAll('.demo')) x.classList.remove('active');
        b.classList.add('active');
        current = d;
        $('#transcript').querySelectorAll('.turn').forEach((n) => n.remove());
        run(d);
      });
      group.appendChild(b);
      shown++;
    }
    list.appendChild(group);
  }
  const count = $('#demo-count');
  if (count) count.textContent = filter === 'all' ? `${shown} 条` : `${shown} / ${DEMOS.length} 条`;
}

function run(demo) {
  session.runTurn(demo.prompt, { source: demo.source, bindings: demo.bindings });
}

// ── 会话事件 ───────────────────────────────────────────────────────────────
session.on('turn-start', ({ userText }) => {
  addUserBubble(userText);
  addAssistantBubble();
});

session.on('delta', ({ raw }) => {
  if (!live) return;
  live.pre.textContent = raw;
  live.pre.scrollTop = live.pre.scrollHeight;
  live.status.textContent = `${raw.length} 字符 · 更新 ${session.state.patchLog.length}`;
});

let raf = false;
const refresh = () => {
  if (raf) return;
  raf = true;
  requestAnimationFrame(() => {
    raf = false;
    inspector.refresh();
  });
};
session.on('ops', refresh);
session.on('patch', refresh);

session.on('turn-end', ({ failure }) => {
  if (live) {
    const s = session.snapshot();
    live.status.textContent = failure
      ? '失败：' + failure
      : `${s.stats?.elements ?? 0} 个组件 · ${s.serverStats.updates} 次更新 · ${s.serverStats.recompiles} 次重编译`;
    live.fb.textContent = s.fallbackMarkdown || '（无）';
    live = null;
  }
  inspector.refresh();
});

session.on('notice', ({ text }) => toast(text));
session.on('quarantined', (m) => toast(`程序 ${m.timeout}ms 没回应，已隔离并重启 worker`));
session.on('error', (e) => {
  if (e.kind === 'runtime') toast('程序里有表达式抛错，已隔离到单个元素');
  else if (e.message) toast(e.message);
});

// 「导入我的 Excel」按钮：action:excel-import
session.on('action', ({ value }) => {
  if (value === 'excel-import') pickExcel();
});

$('#stop').addEventListener('click', () => {
  session.stop();
  toast('已请求打断');
});

// ── Excel：导入 → 数据集 → 现场生成分析界面 ────────────────────────────────
let picker = null;
function pickFile() {
  return new Promise((resolve) => {
    if (!picker) {
      picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.xlsx,.xls,.csv';
      picker.hidden = true;
      document.body.appendChild(picker);
    }
    picker.value = '';
    picker.onchange = () => resolve(picker.files && picker.files[0]);
    picker.click();
  });
}

function onSheetHost(kind, p) {
  if (kind === 'sheet-export') return exportSheet(p);
  if (kind === 'sheet-import') return pickExcel();
}

async function pickExcel() {
  if (session.state.running) return toast('正在生成，等这一轮结束再导入');
  const file = await pickFile();
  if (!file) return;
  toast(`正在解析「${file.name}」…`);
  try {
    const res = await fetch(`${API}/datasets/import?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
      body: file,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    const source = excelAnalysisSource(out.dataset.name, out.dataset.id, out.data, file.name);
    session.runTurn(`把「${file.name}」放进来分析`, { source });
    toast(`已解析 ${out.data.sheets.length} 张表 · ${out.dataset.name}`);
  } catch (e) {
    toast('导入失败：' + (e.message || e));
  }
}

/** 值 → OpenUI Lang 字符串字面量 */
const q = (v) =>
  '"' +
  String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() +
  '"';

const num = (v) => {
  const x = Number(v);
  if (!Number.isFinite(x)) return '0';
  return String(Math.round(x * 100) / 100);
};

const fmt = (v) => {
  const x = Number(v);
  if (!Number.isFinite(x)) return String(v ?? '—');
  if (Math.abs(x) >= 10000) return `${(x / 10000).toFixed(1)} 万`;
  return String(Math.round(x * 100) / 100);
};

/**
 * 导入的表 → 一份分析界面（Lang）。
 * 结构从数据本身推：表头 → 数值列 → 用文本列做横轴、数值列做纵轴。
 * 只取前几行做图，整张表交给 Sheet 绑定数据集（不把数据抄进原文）。
 */
function excelAnalysisSource(name, datasetId, data, fileName) {
  const sheets = (data && data.sheets) || [];
  const sheet = sheets[0] || { name: 'Sheet1', cells: [] };
  const cells = (sheet.cells || []).map((r) => (Array.isArray(r) ? r : [r]));
  const head = (cells[0] || []).map((v, i) => (String(v ?? '').trim() ? String(v).trim() : `列 ${i + 1}`));
  const body = cells.slice(1).filter((r) => r.some((v) => v !== '' && v != null));
  const width = Math.max(head.length, ...body.map((r) => r.length), 1);
  while (head.length < width) head.push(`列 ${head.length + 1}`);

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const numeric = [];
  for (let c = 0; c < width; c++) {
    const vals = body.map((r) => r[c]).filter(isNum);
    if (vals.length >= Math.max(2, Math.ceil(body.length * 0.5))) numeric.push({ c, vals });
  }
  const textCol = [...Array(width).keys()].find((c) => !numeric.some((x) => x.c === c));
  const label = (r, c) => String((c >= 0 && r[c]) ?? '').slice(0, 12) || '—';

  const lines = [];
  lines.push('root = Stack([title, intro, board, ask], "column", "l")');
  lines.push(`title = TextContent(${q(name)}, "xl-heavy")`);
  lines.push(
    `intro = TextContent(${q(
      `${fileName} · ${body.length} 行 × ${width} 列 · ${sheets.length} 张表。左边是原始数据（可编辑、可导出），右边是从数值列直接算出来的摘要。`,
    )}, "default", true)`,
  );

  const cards = ['sheetCard', 'm1', 'm2'];
  if (numeric.length) cards.push('m3');
  if (numeric.length && textCol != null) cards.push('chart');
  if (numeric.length >= 2 && textCol != null) cards.push('chart2');
  cards.push('preview', 'note');
  lines.push(`board = Grid([${cards.join(', ')}], 3)`);
  lines.push('sheetCard = GridItem([Card([CardHeader("原始数据", "点单元格可改，= 开头是公式"), sheet])], 2, 16, 360)');
  lines.push(`sheet = Sheet(${q(datasetId)}, ${q(sheet.name)}, null, null, true, ${q(name)})`);

  lines.push(`m1 = MetricIndicator("行数", ${q(String(body.length))}, ${q(`${sheets.length} 张表`)}, "flat", "行", "chart")`);
  lines.push(`m2 = MetricIndicator("列数", ${q(String(width))}, ${q(`${numeric.length} 列是数字`)}, "flat", "列", "settings")`);

  if (numeric.length) {
    const sum = numeric[0].vals.reduce((a, b) => a + b, 0);
    const avg = sum / numeric[0].vals.length;
    lines.push(`m3 = MetricIndicator(${q(head[numeric[0].c])}, ${q(fmt(sum))}, ${q(`均值 ${fmt(avg)}`)}, "flat", "合计", "sparkles")`);
  }

  const pick = body.slice(0, 8);
  if (numeric.length && textCol != null) {
    const labels = pick.map((r) => q(label(r, textCol))).join(', ');
    const values = pick.map((r) => num(r[numeric[0].c])).join(', ');
    lines.push(
      `chart = GridItem([Card([CardHeader(${q(`${head[numeric[0].c]} · 前 ${pick.length} 行`)}, ${q(`按「${head[textCol]}」排开`)}), BarChart([${labels}], [Series(${q(head[numeric[0].c])}, [${values}])], "grouped", "teal", ${q(head[textCol])}, "", 230)])], 2, 16)`,
    );
  }
  if (numeric.length >= 2 && textCol != null) {
    const labels = pick.map((r) => q(label(r, textCol))).join(', ');
    const v1 = pick.map((r) => num(r[numeric[0].c])).join(', ');
    const v2 = pick.map((r) => num(r[numeric[1].c])).join(', ');
    lines.push(
      `chart2 = GridItem([Card([CardHeader(${q(`${head[numeric[0].c]} vs ${head[numeric[1].c]}`)}, ${q(`前 ${pick.length} 行`)}), BarChart([${labels}], [Series(${q(head[numeric[0].c])}, [${v1}]), Series(${q(head[numeric[1].c])}, [${v2}])], "stacked", "violet", ${q(head[textCol])}, "", 230)])], 2, 16)`,
    );
  }

  const cols = head.slice(0, 5).map((h, i) => `Col(${q(h)}, ${q(numeric.some((x) => x.c === i) ? 'number' : 'string')})`);
  const rows = body.slice(0, 5).map((r) => {
    const vs = [];
    for (let c = 0; c < Math.min(5, width); c++) vs.push(isNum(r[c]) ? num(r[c]) : q(r[c]));
    return `[${vs.join(', ')}]`;
  });
  lines.push(`preview = Card([CardHeader("前 5 行", "完整数据在上面的表里"), Table([${cols.join(', ')}], [${rows.join(', ')}], true)])`);

  lines.push(
    `note = TextCallout("info", "怎么读", ${q(
      `共 ${body.length} 行、${numeric.length} 个数值列${textCol != null ? `，横轴取「${head[textCol]}」` : ''}。改表里的数字不会自动重算图表 —— 想按新数据重画，直接跟我说一句。`,
    )})`,
  );
  lines.push(
    'ask = Buttons([Button("按这张表出结论", "turn:按这张表给我三条结论和两条建议", "primary", "sparkles"), Button("再导入一张", "action:excel-import", "secondary", "external")])',
  );
  lines.push(
    `summary = [Note("已导入", ${q(`${fileName}：${body.length} 行 × ${width} 列。`)}, ["sheet"]), Note("数值列", ${q(
      numeric.length ? numeric.map((x) => head[x.c]).join('、') : '没识别到数值列（值可能带单位或千分位）',
    )}, ["preview"])]`,
  );
  return lines.join('\n');
}

/** 表格导出：把当前单元格（含公式）算成值，下载 CSV */
function exportSheet(p) {
  const sheets = p.sheets || [];
  const sheet = sheets[Math.max(0, p.sheetIndex || 0)] || sheets[0] || { name: 'Sheet1', cells: [] };
  const cells = (sheet.cells || []).map((r) => (Array.isArray(r) ? r : [r]));
  const values = evaluateSheet(cells.map((r) => r.map(toCell)));
  const csv = values
    .map((r) =>
      r
        .map((v) => {
          const s = v && typeof v === 'object' && 'err' in v ? v.err : v == null ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.caption || sheet.name || 'sheet'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已导出 CSV（Excel 能直接打开）');
}

function toast(msg) {
  const node = $('#toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => node.classList.remove('show'), 2600);
}

// ── 启动 ───────────────────────────────────────────────────────────────────
// ?demo=<id> 直接回放指定演示：分享单条演示、截图核对时不用手点
const wanted = new URLSearchParams(location.search).get('demo');
if (wanted) current = DEMOS.find((d) => d.id === wanted) || current;
renderCats();
renderDemoList();
inspector.switchTab('stage', { animate: false });
inspector.refresh();
session.initRunner();
setTimeout(() => run(current), 400);

window.__openui = { session, inspector };
