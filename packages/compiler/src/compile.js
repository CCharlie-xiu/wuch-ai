// ─────────────────────────────────────────────────────────────────────────────
// 服务端编译：OpenUI Lang → JS 程序 + JSON 文档
//
// 客户端从不执行模型原样写出来的东西。这里把模型写的 OpenUI Lang 编成
//   ① 一段 JavaScript 程序（只有 __dil.jsx 调用，没有任何模型写的表达式）
//   ② 一份 JSON 文档（常量表 + 服务端解析出来的数据）
//
// 编译替每个客户端做掉四件事：
//   · 位置参数 → 具名 props，补默认值，space token 归一成像素
//   · 文字进常量表 —— 流式时增长的文字改的是数据，不是程序
//   · 稳定 key —— 变量名就是 key，节点跨每一次重编译都能对上
//   · 数据型组件（Series / Slice / Col / SelectItem / Span）在数组参数里编成普通对象
// 解析、校验、摘掉坏掉的部分由 @openui-lab/ui-dsl 的宽容分析完成。
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeUiDsl } from '@openui-lab/ui-dsl';
import { CATALOG, PLACEHOLDER, SERVER_RESOLVED, TOKENS } from '@openui-lab/catalog';

class Emitter {
  constructor() {
    this.constants = [];
    this.constIndex = new Map();
    this.requests = [];
    this.keys = new Map();
    this.rendered = 0;
    this.placeholders = 0;
  }
  /** 静态文字进常量表，返回取用它的表达式 */
  constant(text) {
    const key = String(text);
    if (!this.constIndex.has(key)) {
      this.constIndex.set(key, String(this.constants.length));
      this.constants.push(key);
    }
    return `__dilConstants[${JSON.stringify(this.constIndex.get(key))}]`;
  }
  /** 同一个变量被引用多次时，后出现的那份带上序号，key 不撞车 */
  key(name) {
    const n = (this.keys.get(name) || 0) + 1;
    this.keys.set(name, n);
    return n === 1 ? name : `${name}#${n}`;
  }
}

/** 'space' → 像素 */
function coerceSpace(v) {
  if (typeof v === 'number') return TOKENS.space[Math.max(0, Math.min(TOKENS.space.length - 1, Math.round(v)))];
  return TOKENS.gap[v] ?? 0;
}

const isNode = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && typeof v.component === 'string';

// ─────────────────────────────────────────────────────────────────────────────
// 瀑布流融合
//
// 模型很容易写成「每段一个 Grid」：
//   root = Stack([header, kpis, usageSection, acqSection], "column", "l")
//   usageSection = Stack([usageHead, usageGrid], "column", "s")
//   usageGrid = Grid([mauCard, dauCard], 4)
//
// 这样段间距（Stack 的 16 / 8）和块间距（Grid 的 12）对不上，每个 Grid 还各自
// 从 y=0 开始算列，跨段的块永远对不齐 —— 页面上看就是「每块间距都不一样」。
//
// 这里在编译前把同一个 Stack 里的多个 Grid 融成一个：分节标题变成跨满整行的
// GridItem，所有内容块进同一条瀑布流。提示词已经要求模型直接写单个 Grid，
// 这一层是兜底，不依赖模型自觉。
// ─────────────────────────────────────────────────────────────────────────────
const GRID_DEF = CATALOG.get('Grid');
const GRID_KIDS = GRID_DEF ? GRID_DEF.params.findIndex((p) => p.type === 'nodes') : 0;
const GRID_COLS = GRID_DEF ? GRID_DEF.params.findIndex((p) => p.name === 'columns') : 1;
const STACK_KIDS = (() => {
  const d = CATALOG.get('Stack');
  return d ? d.params.findIndex((p) => p.type === 'nodes') : 0;
})();

const kidsOf = (node, index) => (Array.isArray(node.args?.[index]) ? node.args[index] : []);
const isGrid = (n) => isNode(n) && n.component === 'Grid';

/** 一层 Stack 里能不能找到「多个 Grid」；返回把它们摊平后的块列表 */
function collectBlocks(stack) {
  let grids = 0;
  const buckets = [];
  for (const k of kidsOf(stack, STACK_KIDS)) {
    if (isGrid(k)) {
      grids++;
      buckets.push({ before: [], grid: k });
      continue;
    }
    // Stack([小节标题, Grid]) 这种「一段一包」：标题提到 Grid 外面，块并进来
    if (isNode(k) && k.component === 'Stack') {
      const inner = kidsOf(k, STACK_KIDS);
      const found = inner.filter(isGrid);
      if (found.length === 1) {
        grids++;
        buckets.push({ before: inner.filter((x) => x !== found[0]), grid: found[0] });
        continue;
      }
    }
    buckets.push({ before: [k], grid: null });
  }
  if (grids < 2) return null;
  return buckets;
}

export function fuseMasonry(root) {  if (!isNode(root)) return root;

  (function walk(node, inGrid) {
    const kids = nodesIndexKids(node);
    for (const k of kids) if (isNode(k)) walk(k, inGrid || node.component === 'Grid');
    // 只融合 Stack：Grid 内部再套 Stack 时不动，那已经是瀑布流里的一块了
    if (inGrid || node.component !== 'Stack') return;
    const buckets = collectBlocks(node);
    if (!buckets) return;

    const cols = Math.max(
      1,
      ...buckets.filter((b) => b.grid).map((b) => Math.round(Number(b.grid.args?.[GRID_COLS])) || 3)
    );
    const children = [];
    for (const b of buckets) {
      for (const item of b.before) {
        if (!isNode(item)) continue;
        // 不分节的零散元素（页头、按钮行）也变成跨满整行的一块，跟着瀑布流走
        children.push({ component: 'GridItem', args: [[item], cols] });
      }
      if (b.grid) children.push(...kidsOf(b.grid, GRID_KIDS));
    }
    node.component = 'Grid';
    // gap 用 token 名而不是数字：space 参数的数字是刻度序号（12 → 第 12 档 = 48px）
    node.args = [children, cols, 'm'];
  })(root, false);

  return root;
}

/** 任意容器的子节点（只关心 nodes 参数） */
function nodesIndexKids(node) {
  const def = CATALOG.get(node.component);
  if (!def) return [];
  const i = def.params.findIndex((p) => p.type === 'nodes');
  return i < 0 ? [] : kidsOf(node, i);
}

/** 数组参数里的值：数据型组件 → 普通对象（typed 的带上 __type），其余原样 */
function toData(v) {
  if (isNode(v)) {
    const { def, props } = namedProps(v);
    return def.typed ? { __type: def.name, ...props } : props;
  }
  if (Array.isArray(v)) return v.map(toData);
  return v;
}

/**
 * 位置参数 → { props, children }。
 * nodes / node 参数按参数顺序进 children，其余进 props（含默认值）。
 */
function namedProps(node) {
  const def = CATALOG.get(node.component);
  const props = {};
  const children = [];
  def.params.forEach((param, i) => {
    const v = node.args[i];
    if (param.type === 'nodes') {
      if (Array.isArray(v)) children.push(...v.filter(isNode));
      return;
    }
    if (param.type === 'node') {
      if (isNode(v)) children.push(v);
      return;
    }
    if (v == null) {
      if (param.default !== undefined) props[param.name] = param.type === 'space' ? coerceSpace(param.default) : param.default;
      return;
    }
    if (param.type === 'space') props[param.name] = coerceSpace(v);
    else if (param.type === 'array') props[param.name] = toData(v);
    else props[param.name] = v;
  });
  return { def, props, children };
}

/** 普通值 → JS 表达式；字符串一律走常量表 */
function emitValue(em, v) {
  if (typeof v === 'string') return em.constant(v);
  if (Array.isArray(v)) return `[${v.map((x) => emitValue(em, x)).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${propKey(k)}: ${emitValue(em, x)}`).join(', ')} }`;
  return JSON.stringify(v ?? null);
}

const propKey = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function emitNode(em, node) {
  const { def, props, children } = namedProps(node);

  // 占位的形状取自它等的那个组件的 skeleton 声明，尽量和成品等大
  if (def.name === PLACEHOLDER) {
    em.placeholders++;
    Object.assign(props, CATALOG.get(props.of)?.skeleton);
  }

  if (SERVER_RESOLVED.has(def.name)) {
    const probe = def.name + '|' + Object.keys(props).sort().map((k) => `${k}=${JSON.stringify(props[k])}`).join('&');
    const id = hash(probe);
    em.requests.push({ id, componentName: def.name, props: { ...props } });
    props.__id = id;
  }

  const textual = new Set(def.params.filter((p) => p.type === 'string' || p.type === 'array').map((p) => p.name));
  const entries = [];
  if (node.varName) entries.push(`key: ${JSON.stringify(em.key(node.varName))}`, `__var: ${JSON.stringify(node.varName)}`);
  for (const [k, v] of Object.entries(props)) entries.push(`${propKey(k)}: ${textual.has(k) ? emitValue(em, v) : JSON.stringify(v)}`);

  const kids = children.map((c) => emitNode(em, c));
  em.rendered++;
  return `__dil.jsx(${JSON.stringify(def.name)}, { ${entries.join(', ')} }${kids.length ? ', ' + kids.join(', ') : ''})`;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'c' + (h >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// fallbackMarkdown：给跑不动程序的旧客户端。各组件用自己的 markdown(props) 退化成文字，
// 没写的只展开子组件。
// ─────────────────────────────────────────────────────────────────────────────
function toMarkdown(node, out) {
  const { def, props, children } = namedProps(node);
  if (def.markdown) out.push(def.markdown(props));
  children.forEach((c) => toMarkdown(c, out));
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────
/**
 * summary = [Note(...), ...] → [{ title, text, refs }]。
 * refs 里写字符串或直接写变量名都行，统一成变量名。
 */
function toSummary(value) {
  const notes = (Array.isArray(value) ? value : [value]).filter((v) => isNode(v) && v.component === 'Note');
  return notes.map((n) => {
    const { props } = namedProps(n);
    const refs = (Array.isArray(n.args[2]) ? n.args[2] : [])
      .map((r) => (typeof r === 'string' ? r : isNode(r) ? r.varName : null))
      .filter(Boolean);
    return { title: String(props.title ?? ''), text: String(props.text ?? ''), refs };
  });
}

export function compile(raw, { final = false } = {}) {  const analysis = analyzeUiDsl(raw ?? '', { final, sidecars: ['summary'], placeholder: PLACEHOLDER });
  // 融合「每段一个 Grid」的写法，让整页只有一条瀑布流（见 fuseMasonry）
  if (analysis.root) fuseMasonry(analysis.root);
  const em = new Emitter();
  const body = analysis.root ? emitNode(em, analysis.root) : null;

  const code = [
    'DIL.render(__dil.jsx(()=>{',
    'const __dilConstants = DIL.useConstants();',
    `return __dil.jsx(__dil.Fragment, null, ${body || 'null'});`,
    '}, { key: "body:0" }))',
  ].join('\n');

  const constants = Object.fromEntries(em.constants.map((v, i) => [String(i), v]));
  const md = [];
  if (analysis.root) toMarkdown(analysis.root, md);

  return {
    code,
    constants,
    appData: { opGenui: { componentResults: {}, modelDataBindings: {} } },
    diagnostics: analysis.diagnostics,
    recoveryDiagnostics: analysis.recovery,
    pending: analysis.pending,
    partial: analysis.partial,
    rootName: analysis.rootName,
    serverRequests: em.requests,
    summary: toSummary(analysis.sidecars.summary ?? []),
    fallbackMarkdown: md.filter(Boolean).join('\n\n').trim(),
    stats: {
      elements: em.rendered,
      placeholders: em.placeholders,
      definitions: analysis.definitions,
      constants: em.constants.length,
      codeBytes: code.length,
      constantBytes: JSON.stringify(constants).length,
    },
  };
}
