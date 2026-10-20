// 端到端冒烟测试：OpenUI Lang → 宽容分析 → 编译 → 沙箱求值 → 操作编码 → 解码
// 用 node:vm 造一个假 self，让真正的 worker-runtime.js 在里面跑起来。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from '@openui-lab/compiler/compile.js';
import { CATALOG, COMPONENTS, groupsUsedIn, canvasBudget } from '@openui-lab/catalog';
import { decodeOps, encodeOps } from '@openui-lab/protocol';
import { DEMOS, FOLLOWUP } from '@openui-lab/fixtures';
import { buildSystemPrompt } from '@openui-lab/web/model.js';
import { RENDERED } from '@openui-lab/web/renderer.js';
import { turnToMarkdown } from '../apps/web/src/turn-markdown.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSrc = fs.readFileSync(path.join(root, 'packages/runtime/src/worker-runtime.js'), 'utf8');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} ${extra}`);
  }
};
const EMPTY_DATA = { opGenui: { componentResults: {}, modelDataBindings: {} } };

// ── 假 worker ──────────────────────────────────────────────────────────────
function createFakeWorker() {
  const inbox = [];
  const outbox = [];
  const sandbox = {
    console,
    postMessage: (msg) => outbox.push(msg),
    addEventListener: (type, handler) => {
      if (type === 'message') inbox.push(handler);
    },
    queueMicrotask,
    Uint8Array,
    ArrayBuffer,
    performance,
    setTimeout,
    clearTimeout,
    // 浏览器里这些都在，沙箱 lockdown 应该把它们摘掉
    fetch: () => Promise.reject(new Error('blocked')),
    XMLHttpRequest: class {},
    WebSocket: class {},
    localStorage: {},
    navigator: {},
  };
  vm.createContext(sandbox);
  vm.runInContext('globalThis.self = globalThis', sandbox);
  vm.runInContext(runtimeSrc, sandbox);
  vm.runInContext('self.__OPENUI_WORKER__()', sandbox);
  return {
    ready: outbox.find((m) => m.type === 'ready'),
    send(msg) {
      for (const h of inbox) h({ data: msg });
    },
    last(type) {
      return [...outbox].reverse().find((m) => m.type === type);
    },
    drain() {
      const all = outbox.slice();
      outbox.length = 0;
      return all;
    },
  };
}

const program = (out, appData = out.appData) => ({ type: 'program', code: out.code, constants: out.constants, appData, reason: 'program' });
const creates = (msg, type) => (msg ? decodeOps(msg.payload).filter((o) => o.op === 'CREATE' && (!type || o.type === type)) : []);

// ── 0. 目录是唯一真相源 ────────────────────────────────────────────────────
console.log('0. 组件目录');
{
  ok(CATALOG.size > 40, `目录里有 ${CATALOG.size} 个组件`);
  const rendered = new Set(RENDERED);
  const missing = [...CATALOG.keys()].filter((n) => !rendered.has(n));
  ok(missing.length === 0 && RENDERED.length === CATALOG.size, '渲染器的组件表由目录派生，一一对应', missing.join(', '));
  const noRender = COMPONENTS.filter((d) => !d.data && typeof d.render?.create !== 'function').map((d) => d.name);
  ok(noRender.length === 0, '每个非数据组件都自带 render.create', noRender.join(', '));
  const dataOnly = COMPONENTS.filter((d) => d.data).map((d) => d.name);
  ok(dataOnly.length >= 4, `数据型组件：${dataOnly.join(' / ')}`);
}

// ── 1. 流式：任意位置切开都能编、都能跑 ────────────────────────────────────
console.log('\n1. 流式切口');
for (const demo of DEMOS) {
  const src = demo.source;
  const worker = createFakeWorker();
  let threw = 0;
  let rendered = 0;
  let cuts = 0;
  let runtimeErrors = 0;
  let removedRoot = 0;
  let rootId = null;
  for (let cut = 1; cut <= src.length; cut += 9) {
    cuts++;
    try {
      const out = compile(src.slice(0, cut));
      if (out.stats.elements > 0) rendered++;
      worker.drain();
      worker.send(program(out));
      const ops = worker.last('ops');
      if (ops && ops.errors.length) runtimeErrors++;
      // 骨架一旦出现，后续切口不应把根节点拆掉重建
      const decoded = ops ? decodeOps(ops.payload) : [];
      if (rootId == null) rootId = decoded.find((o) => o.op === 'CREATE' && o.type === 'Stack')?.id ?? null;
      else if (decoded.some((o) => o.op === 'REMOVE' && o.id === rootId)) removedRoot++;
    } catch (e) {
      threw++;
      if (threw < 3) console.log('    切在', cut, '时抛错：', e.message);
    }
  }
  ok(threw === 0 && runtimeErrors === 0, `${demo.id}：${cuts} 个切口都不抛错，沙箱无运行时错误`);
  ok(rendered / cuts > 0.8, `${demo.id}：${rendered}/${cuts} 个切口已有可渲染内容（root 一行写完就出骨架）`);
  ok(removedRoot === 0, `${demo.id}：根节点跨重编译保持不动（稳定 key）`, `重建 ${removedRoot} 次`);
}
{
  const a = compile('root = Stack([title])\ntitle = TextContent("季度销');
  const b = compile('root = Stack([title])\ntitle = TextContent("季度销量概览');
  ok(a.code === b.code, '文字增长只改常量表，程序不变');
  ok(Object.values(b.constants).includes('季度销量概览'), '半截字符串被临时补齐，文字边写边出');
  ok(a.recoveryDiagnostics.length > 0 && a.diagnostics.length === 0, '切口记为恢复诊断，不算错误');
  const p = compile('root = Stack([title, chart])\ntitle = TextContent("hi")');
  ok(p.pending.includes('chart') && p.stats.placeholders === 1 && p.code.includes('__dil.jsx("Placeholder", { key: "chart"'), '还没写到的变量先放骨架占位（key 就是变量名），其余照常渲染');
  const q = compile('root = Stack([title, chart])\ntitle = TextContent("hi")\nchart = BarChart(["Q1", "Q2"], ');
  ok(q.code.includes('of: __dilConstants') && q.code.includes('h: 250'), '写到一半的图表按 BarChart 的骨架形状占位（250px 高）');
  const done = compile('root = Stack([title, chart])\ntitle = TextContent("hi")\nchart = BarChart(["Q1"], [Series("北区", [3])])', { final: true });
  ok(done.stats.placeholders === 0 && done.code.includes('key: "chart"'), '写完后占位被同 key 的成品替换，不留占位');
}
{
  let maxPh = 0;
  let finalPh = 0;
  for (const demo of DEMOS) {
    for (let cut = 1; cut <= demo.source.length; cut += 23) maxPh = Math.max(maxPh, compile(demo.source.slice(0, cut)).stats.placeholders);
    finalPh += compile(demo.source, { final: true }).stats.placeholders;
  }
  ok(maxPh > 0 && finalPh === 0, `流式中最多同时 ${maxPh} 块骨架，流结束后一块不剩`);
}

// ── 2. 按目录校验：坏的部分被摘掉，兄弟节点不受影响 ────────────────────────
console.log('\n2. 按目录校验');
{
  const src = `root = Stack([a, b, c, d])
a = TextContent("留下", "不存在的样式")
b = NoSuchComponent("x")
c = CardHeader()
d = TextContent("后面的元素还在")`;
  const out = compile(src, { final: true });
  const codes = out.diagnostics.map((d) => d.code);
  ok(codes.includes('E_ARG_TYPE'), 'E_ARG_TYPE：枚举取值不合法的参数被丢掉，组件用默认值');
  ok(codes.includes('E_UNKNOWN_COMPONENT'), 'E_UNKNOWN_COMPONENT：目录外组件被摘掉');
  ok(codes.includes('E_DROPPED_COMPONENT'), 'E_DROPPED_COMPONENT：缺必填参数的组件被摘掉');
  ok(!out.code.includes('NoSuchComponent') && !out.code.includes('"CardHeader"'), '编译产物里没有被摘掉的组件');
  ok(Object.values(out.constants).includes('后面的元素还在') && Object.values(out.constants).includes('留下'), '同级的其他元素照常编译');
  ok(out.diagnostics.every((d) => d.pos && d.pos.line > 0), '每条诊断都带行列号');

  const bad = compile('root = Stack([TextContent("a"), ])\nroot2 = Card(', { final: true });
  ok(bad.diagnostics.some((d) => d.code === 'E_INCOMPLETE_STATEMENT'), '流结束时仍没写完的语句报错');
  ok(bad.stats.elements === 2, '尾逗号合法，前面完整的语句照常渲染');
}

// ── 3. 编译产物的形状 ──────────────────────────────────────────────────────
console.log('\n3. 编译产物');
{
  const src = `root = Stack([title, chart], "column", "l")
title = TextContent("销量", "xl-heavy")
chart = BarChart(["Q1", "Q2"], [Series("北区", [3, 5]), Series("南区", [2, 4])])`;
  const out = compile(src, { final: true });
  ok(out.code.includes('__dil.jsx("BarChart"') && out.code.includes('key: "chart"'), '变量名就是稳定 key');
  ok(out.code.includes('gap: 24') || out.code.includes('gap: 16') || /gap: \d+/.test(out.code), 'space token 归一成像素');
  ok(out.code.includes('direction: "column"'), '枚举值内联在程序里，不进常量表');
  ok(/series: \[\{ name: __dilConstants\["\d+"\], data: \[3, 5\] \}/.test(out.code), '数据型组件 Series 编成普通对象');
  ok(!/[\u4e00-\u9fa5]/.test(out.code), '程序里没有任何文字（全部走常量表）');
  ok(out.fallbackMarkdown.includes('## 销量'), `fallbackMarkdown：${JSON.stringify(out.fallbackMarkdown.slice(0, 40))}`);
}

// ── 4. 端到端：每个演示都跑通 ──────────────────────────────────────────────
console.log('\n4. 演示的端到端链路');
for (const demo of [...DEMOS, FOLLOWUP]) {
  const worker = createFakeWorker();
  ok(!!worker.ready, `${demo.id}：worker 启动`);
  const locked = worker.ready.locked;
  ok(locked.removed.includes('fetch') && locked.removed.includes('Function'), `${demo.id}：lockdown 移除了 fetch 和 Function`);

  const out = compile(demo.source, { final: true });
  ok(out.diagnostics.length === 0, `${demo.id}：编译无诊断`, JSON.stringify(out.diagnostics.slice(0, 3)));
  ok(out.stats.elements > 8, `${demo.id}：编译出 ${out.stats.elements} 个组件`);

  worker.send(program(out));
  const opsMsg = worker.last('ops');
  ok(!!opsMsg && opsMsg.counts.total > 0 && opsMsg.errors.length === 0, `${demo.id}：运行时产出 ${opsMsg ? opsMsg.counts.total : 0} 个操作，无错误`);

  const decoded = decodeOps(opsMsg.payload);
  const types = new Set(decoded.filter((o) => o.op === 'CREATE').map((o) => o.type));
  const unknown = [...types].filter((t) => t !== '#text' && !CATALOG.has(t));
  ok(unknown.length === 0, `${demo.id}：只出现目录内组件（${types.size} 种）`, unknown.join(', '));
  const roundTrip = encodeOps(
    decoded.map((o) =>
      o.op === 'CREATE'
        ? { op: 1, id: o.id, type: o.type, parent: o.parent, index: o.index, props: o.props.map(([k, v]) => [k, v && v.fn ? 1 : 0, v && v.fn ? v.fn : v]) }
        : o.op === 'SET'
          ? { op: 2, id: o.id, props: o.props.map(([k, v]) => [k, v && v.fn ? 1 : 0, v && v.fn ? v.fn : v]) }
          : o.op === 'PLACE'
            ? { op: 3, id: o.id, parent: o.parent, index: o.index }
            : { op: 4, id: o.id }
    )
  );
  ok(decodeOps(roundTrip).length === decoded.length, `${demo.id}：二进制编码往返一致（${roundTrip.bytes.length} 字节）`);
}

// ── 5. 服务端解析的组件 ────────────────────────────────────────────────────
console.log('\n5. 数据：模型只写描述，值由服务端补');
{
  const src = 'root = Stack([AsyncImage("a red bicycle", "16:9"), TextContent("下面是图")])';
  const out = compile(src, { final: true });
  ok(out.serverRequests.length === 1, `服务端待解析请求 ${out.serverRequests.length} 条`);
  ok(out.serverRequests[0].props.query === 'a red bicycle', '请求带上了模型写的描述');
  ok(compile(src).serverRequests[0].id === out.serverRequests[0].id, 'id 跨重编译稳定（图片不会反复重取）');

  const worker = createFakeWorker();
  const appData = {
    opGenui: {
      componentResults: { [out.serverRequests[0].id]: { componentName: 'AsyncImage', state: { is_loading: false, images: [{ content_url: 'https://example.test/a.jpg' }] } } },
      modelDataBindings: {},
    },
  };
  worker.send(program(out, appData));
  const img = creates(worker.last('ops'), 'AsyncImage')[0];
  ok(!!img && img.props.some(([k, v]) => k === '__id' && v === out.serverRequests[0].id), '渲染器通过 __id 取服务端结果');
}

// ── 6. 交互约定 ────────────────────────────────────────────────────────────
console.log('\n6. 交互：按钮动作');
{
  const out = compile(DEMOS.find((d) => d.id === 'team-plan').source, { final: true });
  const worker = createFakeWorker();
  worker.send(program(out));
  const buttons = creates(worker.last('ops'), 'Button').map((b) => Object.fromEntries(b.props));
  ok(buttons.some((b) => b.action === 'submit:estimate'), '表单提交按钮：submit:<表单id>');
  ok(buttons.some((b) => String(b.action).startsWith('turn:')), '开启下一轮：turn:<文字>');
  ok(creates(worker.last('ops'), 'Input').some((i) => i.props.some(([k, v]) => k === 'name' && v === 'seats')), '表单控件带 name，提交时按 name 收集');
}

// ── 6b. 公式：反斜杠写两次，常量表里拿到的是真正的 LaTeX ─────────────────
console.log('\n6b. 公式');
{
  const out = compile('root = Stack([f])\nf = Formula("\\\\frac{1}{2} + \\\\sum_i x_i", "一半", "inline")', { final: true });
  ok(out.diagnostics.length === 0 && Object.values(out.constants).includes('\\frac{1}{2} + \\sum_i x_i'), '双反斜杠解析成单个反斜杠');
  ok(out.code.includes('display: "inline"'), '可选的 display 枚举照常编译');
  ok(out.fallbackMarkdown.includes('$\\frac{1}{2}'), `fallbackMarkdown：${JSON.stringify(out.fallbackMarkdown)}`);
}

// ── 6c. Markdown 与代码 ────────────────────────────────────────────────────
console.log('\n6c. Markdown 与代码');
{
  const out = compile('root = Stack([m, c])\nm = MarkDownRenderer("| a | b |\\n|---|---|\\n| 1 | $x^2$ |")\nc = CodeBlock("print(1)", "python")', { final: true });
  ok(out.diagnostics.length === 0, 'MarkDownRenderer / CodeBlock 编译无诊断');
  ok(out.fallbackMarkdown.includes('| 1 | $x^2$ |') && out.fallbackMarkdown.includes('```python\nprint(1)\n```'), 'fallbackMarkdown 保留表格、公式和代码围栏');
}

// ── 6d. 视频与音频 ─────────────────────────────────────────────────────────
console.log('\n6d. 视频与音频');
{
  const { videoEmbed } = await import('../packages/catalog/src/components/Video.js');
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 30, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30'],
    ['https://youtu.be/dQw4w9WgXcQ', 0, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://www.bilibili.com/video/BV1GJ411x7h7/?p=2', 0, 'https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&p=2&autoplay=0'],
    ['https://vimeo.com/76979871', 5, 'https://player.vimeo.com/video/76979871#t=5s'],
    ['https://example.com/a.mp4', 0, null],
    ['javascript:alert(1)', 0, null],
    ['https://www.youtube.com/watch?v=<script>', 0, null],
  ];
  const bad = cases.filter(([src, t, want]) => videoEmbed(src, t) !== want);
  ok(bad.length === 0, '视频站链接换成官方嵌入地址，其他地址不嵌入', JSON.stringify(bad.map(([s, t]) => [s, videoEmbed(s, t)])));
  const out = compile('root = Stack([v, a])\nv = Video("https://example.com/a.mp4", "演示", null, "9:16", 12)\na = Audio("https://example.com/a.mp3", "播客", "第 1 期")', { final: true });
  ok(out.diagnostics.length === 0 && out.code.includes('start: 12'), 'Video / Audio 编译无诊断，数字参数照常编译');
  ok(out.fallbackMarkdown.includes('[视频：演示](https://example.com/a.mp4)') && out.fallbackMarkdown.includes('[音频：播客]'), 'fallbackMarkdown 退化成链接');
}

// ── 7. 由目录生成 system prompt ────────────────────────────────────────────
console.log('\n7. 由目录生成 system prompt');
{
  const prompt = buildSystemPrompt();
  ok(prompt.includes('Stack(') && prompt.includes('AsyncImage(') && prompt.includes('BarChart('), '提示词里列出了组件签名');
  ok(prompt.includes('root = '), '提示词讲清了 root 约定');
  ok(prompt.includes('turn:') && prompt.includes('submit:'), '提示词讲清了按钮动作');
  ok(!prompt.includes('useState') && !prompt.includes('{#if'), '提示词里没有状态和控制块');
  ok(prompt.length > 2000, `提示词 ${prompt.length} 字符，直接可作为 system message`);
  ok(prompt.includes('summary = [Note('), '提示词讲清了会话总结 summary 行');
  ok(!prompt.includes('Placeholder('), '内部占位组件不进提示词');
  const wide = buildSystemPrompt({ viewport: { width: 980, height: 760 } });
  const narrow = buildSystemPrompt({ viewport: { width: 380, height: 700 } });
  ok(wide.includes('当前画布宽 980px') && wide.includes('Grid([...], 3)'), '宽画布：提示词给出 3 列');
  ok(narrow.includes('Grid([...], 1)') && narrow.includes('不要用 GridItem 跨列'), '窄画布：提示词给出 1 列、不跨列');
  ok(wide.includes('瀑布流') && wide.includes('masonry'), '提示词讲清 Grid 是瀑布流，块自动咬合');
  ok(/整份脚本 \d+ 个组件以内/.test(wide), '篇幅上限跟着画幅走，不再是写死的 30');
  ok(compile('root = Placeholder("BarChart")', { final: true }).diagnostics.some((d) => d.code === 'E_UNKNOWN_COMPONENT'), '模型写不出内部占位组件');
}

// ── 7a. 画幅预算：画布尺寸 → 列数 / 首屏块数 / 组件上限 ─────────────────
console.log('\n7a. 画幅预算');
{
  const desk = canvasBudget({ width: 980, height: 760 });
  ok(desk.cols === 3 && desk.perScreen === 6 && desk.rows === 2, `980×760 → 3 列 / 2 行 / 首屏 6 块（实际 ${desk.cols} 列 / ${desk.rows} 行 / ${desk.perScreen} 块）`);
  const wide = canvasBudget({ width: 1448, height: 749 });
  ok(wide.cols === 4 && wide.perScreen === 8, `1448×749 放开到 4 列、首屏 8 块（实际 ${wide.cols} 列 / ${wide.perScreen} 块）`);
  ok(wide.components > desk.components, `组件预算随画幅变大（${desk.components} → ${wide.components}）`);
  const phone = canvasBudget({ width: 380, height: 700 });
  ok(phone.cols === 1 && phone.perScreen === 2, `380×700 单列、首屏 2 块（实际 ${phone.cols} 列 / ${phone.perScreen} 块）`);
  const none = canvasBudget(null);
  ok(none.known === false && none.cols === 3, '量不到画布：退回桌面 3 列的保守预算');
  ok([desk, wide, phone, none].every((b) => b.components >= 18 && b.components <= 64), '组件上限始终落在 18–64 的合理区间');
}

// ── 7a2. 瀑布流融合：模型按段拆多个 Grid 时，编译期并成一条瀑布流 ─────────
console.log('\n7a2. 瀑布流融合');
{
  const split = `root = Stack([header, kpis, usageSection, acqSection], "column", "l")
header = TextContent("仪表盘", "xl-heavy")
kpis = Grid([m1, m2], 4)
m1 = MetricIndicator("营收", "¥1M")
m2 = MetricIndicator("订单", "100")
usageSection = Stack([usageHead, usageGrid], "column", "s")
usageHead = InlineHeader("1 · 用量", "一句话")
usageGrid = Grid([chartA, chartB], 4)
chartA = Card([CardHeader("A")])
chartB = Card([CardHeader("B")])
acqSection = Stack([acqHead, acqGrid], "column", "s")
acqHead = InlineHeader("2 · 获客", "一句话")
acqGrid = Grid([pie], 4)
pie = Card([CardHeader("C")])
summary = [Note("t", "x", ["m1"])]`;
  const fused = compile(split, { final: true });
  const count = (re) => (fused.code.match(re) || []).length;
  ok(count(/"Grid"/g) === 1, `多段 Grid 融成一条瀑布流（实际 ${count(/"Grid"/g)} 个 Grid）`);
  ok(count(/"Stack"/g) === 0, '外层 Stack 一并收掉，整页就是这一条瀑布流');
  ok(count(/"GridItem"/g) === 3, `页头与两个分节标题变成跨满行的块（实际 ${count(/"GridItem"/g)} 个）`);
  ok(fused.code.includes('gap: 12') && !fused.code.includes('gap: 48'), '间距统一 12（space 参数不能写数字刻度）');
  ok(fused.diagnostics.length === 0, '融合不引入诊断');

  const single = compile(`root = Stack([title, board], "column", "m")
title = TextContent("只有一个 Grid", "xl-heavy")
board = Grid([a, b], 3)
a = Card([CardHeader("A")])
b = Card([CardHeader("B")])
summary = [Note("t", "x", ["a"])]`, { final: true });
  ok((single.code.match(/"Grid"/g) || []).length === 1 && single.code.includes('"Stack"'), '只有一个 Grid 时保持原结构不动');
  ok((single.code.match(/"GridItem"/g) || []).length === 0, '没发生融合就不凭空生成 GridItem');
}

// ── 7b. 技能门控：选中才进提示词，解析和渲染不受影响 ─────────────────────
console.log('\n7b. 技能门控');
{
  const plain = buildSystemPrompt();
  ok(!plain.includes('Drawing(') && !plain.includes('Sheet(') && !plain.includes('技能：'), '没选技能：Drawing / Sheet 不进提示词');
  const canvas = buildSystemPrompt({ activeSkills: ['canvas'] });
  ok(canvas.includes('Drawing(') && canvas.includes('Rect(') && canvas.includes('技能：Canvas') && !canvas.includes('Sheet('), '选中 Canvas：只给 Canvas 的组件和提示词');
  const used = buildSystemPrompt({ usedSkills: ['sheet'], canvas: { source: 'root = Sheet(["a"], [[1]])', version: 2 } });
  ok(used.includes('Sheet(') && !used.includes('技能：Excel'), '画布已用到 Sheet：组件说明保留，技能提示词不给');
  ok(used.includes('@edit') && used.includes('当前画布（v2）'), '有当前画布时讲清 @new / @edit');
  const ds = buildSystemPrompt({ activeSkills: ['sheet'], datasets: [{ id: 'ds_a', name: '销量', sheets: [{ name: 'S1', rows: 3, cols: 2, header: ['月', '量'], sample: [['1月', 3]] }] }] });
  ok(ds.includes('### ds_a · 销量') && ds.includes('A=月'), '选中 Excel：数据集摘要进提示词');
  const baseOnly = buildSystemPrompt({ groups: [] });
  ok(baseOnly.includes('Stack(') && baseOnly.includes('Button(') && !baseOnly.includes('BarChart(') && !baseOnly.includes('Input(') && !baseOnly.includes('AsyncImage('), '只带基础组：图表、表单、图片组件不进提示词');
  ok(baseOnly.length < buildSystemPrompt().length * 0.6, `只带基础组：提示词 ${baseOnly.length} 字，不到全量的六成`);
  const withCharts = buildSystemPrompt({ groups: ['charts'] });
  ok(withCharts.includes('BarChart(') && withCharts.includes('m1 = MetricIndicator('), '带图表组：图表组件和图表示例都在');
  const baseEx = baseOnly.split('## 示例')[1].split('```')[1].trim();
  ok(compile(baseEx, { final: true }).diagnostics.length === 0 && groupsUsedIn(baseEx).join() === 'base', '基础组示例零诊断，只用基础组件');
  ok(groupsUsedIn('root = Stack([BarChart(["a"], [Series("x", [1])]), Formula("x")])').sort().join() === 'base,charts,rich', '续画时能认出画布用到的组件组');
  const out = compile('root = Stack([d, s])\nd = Drawing([a, Arrow(0, 0, 10, 10)], 100, 50)\na = Rect(1, 2, 3, 4, "primary")\ns = Sheet(["x"], [["=1+1"]])', { final: true });
  ok(out.diagnostics.length === 0 && out.code.includes('__type: __dilConstants') && out.code.includes('"Sheet"'), '没选技能也能编译历史画布里的 Drawing / Sheet，图元带 __type');
}

// ── 8. 会话总结：summary 单独取出，不进界面 ───────────────────────────────
console.log('\n8. 会话总结');
for (const d of [...DEMOS, FOLLOWUP]) {
  const out = compile(d.source, { final: true });
  const vars = new Set([...out.code.matchAll(/__var: "(\w+)"/g)].map((m) => m[1]));
  const refs = out.summary.flatMap((s) => s.refs);
  ok(
    out.summary.length > 0 && !out.code.includes('"Note"') && refs.every((r) => vars.has(r)),
    `${d.id}：${out.summary.length} 条总结，引用 ${refs.length} 个变量全都在界面里`
  );
}
{
  const src = DEMOS[0].source;
  const cut = src.slice(0, src.indexOf('summary = [') + 40);
  const out = compile(cut);
  ok(out.summary.length === 1 && out.summary[0].title && out.diagnostics.length === 0, '流式写到一半的 summary 也能先出第一条');
}

// ── 8b. 整轮 Markdown 导出 ───────────────────────────────────────────────────
console.log('\n8b. 整轮 Markdown 导出');
{
  const md = turnToMarkdown({
    userText: '做个周报',
    reply: '本周订单增长 12%。',
    summary: [{ title: '关键结论', text: '营收持续增长。', refs: ['metrics'] }],
    fallbackMarkdown: '## 本周数据\n\n| 指标 | 数值 |\n| --- | --- |\n| 订单 | 120 |',
    source: "root = TextContent(\"hello ```world```\")",
  });
  ok(md.includes('## 用户需求') && md.includes('> 做个周报'), '导出包含本轮用户需求');
  ok(md.includes('## 页面内容') && md.includes('| 指标 | 数值 |'), '导出包含左侧界面的 Markdown 内容');
  ok(md.includes('## 描述') && md.includes('本周订单增长 12%。'), '导出包含模型给出的描述');
  ok(md.includes('**关键结论**：营收持续增长。') && md.includes('关联：metrics'), '导出包含右侧总结及关联变量');
  ok(md.includes('## OpenUI Lang 源码') && md.includes('````openui'), '导出附完整源码并安全处理反引号围栏');
  const empty = turnToMarkdown({ userText: '解释一下', reply: '这是纯文字回答。' });
  ok(empty.includes('本轮没有生成或修改界面。') && empty.includes('## 描述'), '纯文字回答也可导出 Markdown');
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
