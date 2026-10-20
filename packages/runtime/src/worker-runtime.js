// ─────────────────────────────────────────────────────────────────────────────
// 第 3 层 · 沙箱客户端运行时
//
// 程序是模型写的代码，所以它不在宿主页面里跑。这个文件被 runner.html
// 取下来塞进一个 Blob Worker，在 sandbox="allow-scripts" 的 iframe 里启动。
//
// 流程：lockdown → 用 new Function 求值程序 → 迷你 reconciler 渲染并保留
// 带 key 的 hook 状态 → 与上一棵树对比 → 把差异编码成操作发回去。
// 它自己什么都不画。
//
// 注意：下面所有对宿主能力的引用（postMessage / addEventListener / Function）
// 都在 lockdown 之前被捕获进闭包，之后才从全局上删掉。
// 程序即使想找 postMessage 也找不到了。
// ─────────────────────────────────────────────────────────────────────────────

self.__OPENUI_WORKER__ = function openuiWorker() {
  'use strict';

  // ── 0. 先抓住需要的东西 ────────────────────────────────────────────────
  const post = self.postMessage.bind(self);
  const listen = self.addEventListener.bind(self);
  const Fn = Function;
  const queue = typeof queueMicrotask === 'function' ? queueMicrotask.bind(self) : null;

  const GLOBALS_TO_FREEZE = ['Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Promise', 'Reflect', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'TypeError', 'RangeError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent'];
  const NETWORK_AND_TIMERS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers', 'importScripts', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'indexedDB', 'caches', 'Notification', 'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'navigator', 'location', 'performance', 'crypto', 'postMessage', 'onmessage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'eval', 'Function', 'WebAssembly', 'Atomics', 'SharedArrayBuffer'];

  const lockdownReport = { removed: [], frozen: [], failed: [] };
  for (const key of NETWORK_AND_TIMERS) {
    try {
      if (key in self) {
        delete self[key];
        lockdownReport.removed.push(key);
      }
    } catch (e) {
      lockdownReport.failed.push(key);
    }
  }
  for (const key of GLOBALS_TO_FREEZE) {
    try {
      if (self[key] && typeof self[key] === 'object') {
        Object.freeze(self[key]);
        lockdownReport.frozen.push(key);
      }
    } catch (e) {
      lockdownReport.failed.push(key);
    }
  }
  // 全局对象本身也钉住
  try {
    Object.freeze(self.__OPENUI_WORKER__);
  } catch (e) {
    /* 无所谓 */
  }

  // ── 1. 响应式状态仓库 ──────────────────────────────────────────────────
  // 与 OpenUI 的 store 同一套语义：值带 key，跨每一次重编译存活；
  // 还没被用户改过的值（pristine）允许被新一轮解析出来的默认值替换。
  const state = new Map();
  const pristine = new Set();
  const setters = new Map();

  function setState(key, value, opts) {
    if (opts && opts.pristine) pristine.add(key);
    else pristine.delete(key);
    const prev = state.get(key);
    if (Object.is(prev, value)) return false;
    state.set(key, value);
    return true;
  }

  // ── 2. 运行时对象 ──────────────────────────────────────────────────────
  const FRAGMENT = Symbol('dil.fragment');
  let currentConstants = {};
  let currentAppData = { opGenui: { componentResults: {}, modelDataBindings: {} } };
  let pendingTree = null;

  function jsx(type, props, ...children) {
    return { __node: true, type, props: props || {}, children };
  }
  jsx.Fragment = FRAGMENT;

  const __dil = {
    jsx,
    Fragment: FRAGMENT,
    /** 表达式抛错只掉这一个元素，不炸整棵树 */
    cond(thunk) {
      try {
        return thunk();
      } catch (e) {
        report('cond', e);
        return null;
      }
    },
    each(listThunk, mapFn) {
      let list;
      try {
        list = listThunk();
      } catch (e) {
        report('each', e);
        return [];
      }
      if (!Array.isArray(list)) return [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        try {
          out.push(mapFn(list[i], i));
        } catch (e) {
          report('each.item', e);
        }
      }
      return out;
    },
  };

  const runtimeErrors = [];
  function report(where, e) {
    if (runtimeErrors.length < 50) runtimeErrors.push({ where, message: e && e.message ? e.message : String(e) });
  }

  /** 表达式包一层：抛错只掉一个元素，不炸整棵树 */
  function __dilSafe(thunk, failureValue) {
    try {
      return thunk();
    } catch (e) {
      report('expr', e);
      return failureValue;
    }
  }

  const DIL = {
    render(tree) {
      pendingTree = tree;
    },
    useConstants() {
      return currentConstants;
    },
    useAppData(selector) {
      try {
        return selector ? selector(currentAppData) : currentAppData;
      } catch (e) {
        report('useAppData', e);
        return {};
      }
    },
    useState(init, opts) {
      const key = (opts && opts.key) || 'anon:' + anonCounter++;
      if (!state.has(key)) {
        setState(key, init, { pristine: true });
      } else if (pristine.has(key) && !Object.is(state.get(key), init)) {
        // 流式过程中被截断的声明会带来临时默认值，源补全后要跟着更新
        setState(key, init, { pristine: true });
      }
      if (!setters.has(key)) {
        setters.set(key, (v) => {
          const prev = state.get(key);
          const next = typeof v === 'function' ? v(prev) : v;
          if (setState(key, next)) scheduleRender();
        });
      }
      return [state.get(key), setters.get(key)];
    },
  };
  let anonCounter = 0;

  const GenUI = {
    issueNewTurn(text) {
      post({ type: 'action', action: 'issueNewTurn', payload: String(text) });
    },
    copy(text) {
      post({ type: 'action', action: 'copy', payload: String(text) });
    },
    openUrl(url) {
      post({ type: 'action', action: 'openUrl', payload: String(url) });
    },
    openEntityDetail(ref) {
      post({ type: 'action', action: 'openEntityDetail', payload: String(ref) });
    },
  };

  // ── 3. 函数登记处：函数只以标识符上线 ──────────────────────────────────
  const fnBySource = new Map();
  const fnById = new Map();
  let fnCounter = 0;

  function fnSource(fn) {
    try {
      return String(fn);
    } catch (e) {
      return 'fn:unknown';
    }
  }

  function registerFn(fn) {
    const src = fnSource(fn);
    const existing = fnBySource.get(src);
    if (existing) {
      fnById.set(existing, fn);
      return existing;
    }
    const id = 'fn#' + ++fnCounter;
    fnBySource.set(src, id);
    fnById.set(id, fn);
    return id;
  }

  // ── 4. 树展开 ──────────────────────────────────────────────────────────
  function expand(node, out) {
    if (node == null || node === false || node === true) return;
    if (Array.isArray(node)) {
      for (const n of node) expand(n, out);
      return;
    }
    const t = typeof node;
    if (t === 'string' || t === 'number') {
      out.push({ type: '#text', props: { value: String(node) }, children: [], key: null });
      return;
    }
    if (t !== 'object' || !node.__node) return;
    if (node.type === FRAGMENT) {
      for (const c of node.children) expand(c, out);
      return;
    }
    if (typeof node.type === 'function') {
      try {
        expand(node.type(), out);
      } catch (e) {
        report('component', e);
      }
      return;
    }
    const kids = [];
    for (const c of node.children) expand(c, kids);
    const props = Object.assign({}, node.props || {});
    // 服务端解析出来的数据要进 props，否则差异对比看不见它，
    // 图片到了也不会产生任何更新操作。
    if (props.__id != null) {
      const results = (currentAppData.opGenui && currentAppData.opGenui.componentResults) || {};
      props.__resolved = results[props.__id] || null;
    }
    out.push({
      type: node.type,
      props,
      children: kids,
      key: node.props && node.props.key != null ? String(node.props.key) : null,
    });
  }

  // ── 5. 差异 → 操作 ─────────────────────────────────────────────────────
  let idSeq = 1;
  const KIND = { VALUE: 0, FN: 1 };

  function norm(v) {
    if (typeof v === 'function') {
      const id = registerFn(v);
      return { kind: KIND.FN, value: id, cmp: 'f:' + id };
    }
    if (v === undefined) return { kind: KIND.VALUE, value: null, cmp: 'u' };
    return { kind: KIND.VALUE, value: v, cmp: JSON.stringify(v) };
  }

  function diffProps(a, b) {
    const out = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      if (k === 'key' || k === '__partial') continue;
      const na = norm(a ? a[k] : undefined);
      const nb = norm(b ? b[k] : undefined);
      if (na.cmp !== nb.cmp) out.push([k, nb.kind, nb.value]);
    }
    return out;
  }

  function create(node, parentId, index, ops) {
    node.id = idSeq++;
    const props = [];
    for (const [k, v] of Object.entries(node.props)) {
      if (k === 'key' || k === '__partial') continue;
      const n = norm(v);
      props.push([k, n.kind, n.value]);
    }
    ops.push({ op: 1, id: node.id, type: node.type, parent: parentId, index, props });
    reconcile([], node.children, node.id, ops);
    return node;
  }

  /** 贪心对齐：优先按 key 配对，其次在同一类型的近邻里找 */
  function align(prev, next) {
    const used = new Set();
    const pairs = new Array(next.length).fill(-1);
    for (let ni = 0; ni < next.length; ni++) {
      const b = next[ni];
      if (b.key == null) continue;
      for (let pi = 0; pi < prev.length; pi++) {
        if (used.has(pi)) continue;
        if (prev[pi].key === b.key && prev[pi].type === b.type) {
          pairs[ni] = pi;
          used.add(pi);
          break;
        }
      }
    }
    let cursor = 0;
    for (let ni = 0; ni < next.length; ni++) {
      if (pairs[ni] !== -1) continue;
      const b = next[ni];
      let found = -1;
      const window = Math.min(prev.length, cursor + 24);
      for (let pi = cursor; pi < window; pi++) {
        if (used.has(pi)) continue;
        if (prev[pi].type === b.type && prev[pi].key == null) {
          found = pi;
          break;
        }
      }
      if (found >= 0) used.add(found);
      pairs[ni] = found;
      cursor = Math.max(cursor, found + 1);
    }
    return pairs;
  }

  function reconcile(prev, next, parentId, ops) {
    const pairs = align(prev, next);
    const prevIndex = new Map();
    prev.forEach((n, i) => prevIndex.set(n.id, i));

    for (let i = 0; i < next.length; i++) {
      const b = next[i];
      const pi = pairs[i];
      if (pi === -1) {
        create(b, parentId, i, ops);
        continue;
      }
      const a = prev[pi];
      b.id = a.id;
      if (prevIndex.get(a.id) !== i) {
        ops.push({ op: 3, id: b.id, parent: parentId, index: i });
        prevIndex.set(b.id, i);
      }
      const sets = diffProps(a.props, b.props);
      if (sets.length) ops.push({ op: 2, id: b.id, props: sets });
      reconcile(a.children, b.children, b.id, ops);
    }
    // 没配上的旧节点 → 删除
    const matched = new Set(pairs.filter((p) => p !== -1));
    for (let pi = 0; pi < prev.length; pi++) {
      if (!matched.has(pi)) ops.push({ op: 4, id: prev[pi].id });
    }
  }

  // ── 6. 求值 + 渲染 + 出操作 ────────────────────────────────────────────
  let lastGood = { tree: [], code: null, constants: null, appData: null };
  let currentCode = null;
  let currentAppDataJson = null;
  let renderScheduled = false;
  let revision = 0;
  let turn = 0; // 轮次标记：上一轮在途的操作不能落到新一轮的 DOM 上

  function evaluate(code, constants, appData) {
    currentConstants = constants || {};
    currentAppData = appData || { opGenui: { componentResults: {}, modelDataBindings: {} } };
    const bindings = (currentAppData.opGenui && currentAppData.opGenui.modelDataBindings) || {};
    const names = Object.keys(bindings);
    // 数据绑定以参数形式注入：模型只写引用，值来自服务端
    const fn = new Fn(...names, 'DIL', '__dil', 'GenUI', '__dilSafe', '"use strict";\n' + code);
    fn(...names.map((n) => bindings[n]), DIL, __dil, GenUI, __dilSafe);
  }

  function run({ code, constants, appData, reason, turn: msgTurn }) {
    revision++;
    if (msgTurn != null) turn = msgTurn;
    runtimeErrors.length = 0;
    if (code) currentCode = code;
    currentAppDataJson = JSON.stringify(appData || null);
    pendingTree = null;
    try {
      evaluate(currentCode, constants, appData);
    } catch (e) {
      report('evaluate', e);
      // 程序跑不起来 → 保留上一版能跑的程序
      post({ type: 'error', turn, kind: 'evaluate', message: e && e.message ? e.message : String(e), revision, keptPrevious: !!lastGood.code });
      return;
    }
    let root = [];
    try {
      expand(pendingTree, root);
    } catch (e) {
      report('expand', e);
      post({ type: 'error', turn, kind: 'render', message: e && e.message ? e.message : String(e), revision, keptPrevious: true });
      return;
    }
    if (!root.length && lastGood.tree.length && reason === 'stream') {
      // 半截源码编出来是空树时不要清屏
      post({ type: 'noop', turn, revision, reason: 'empty-partial' });
      return;
    }
    const ops = [];
    // 注意：id 计数器不能每次重编译都归零。旧树里活着的节点仍然占着 id，
    // 一旦新节点复用同一个 id，操作里就会出现「把自己插进自己」这种自环。
    try {
      reconcile(lastGood.tree, root, 0, ops);
    } catch (e) {
      report('diff', e);
      post({ type: 'error', turn, kind: 'diff', message: String(e && e.message), revision, keptPrevious: true });
      return;
    }
    lastGood = { tree: root, code: currentCode, constants, appData };
    const payload = encodeOps(ops);
    post({
      type: 'ops',
      turn,
      revision,
      reason: reason || 'program',
      payload,
      counts: { total: ops.length, create: ops.filter((o) => o.op === 1).length, set: ops.filter((o) => o.op === 2).length, place: ops.filter((o) => o.op === 3).length, remove: ops.filter((o) => o.op === 4).length },
      errors: runtimeErrors.slice(),
      locked: lockdownReport,
    });
  }

  // ── 5b. 编码：操作 → 二进制整数串 + 独立的字符串表 ─────────────────────
  const OP = { CREATE: 1, SET: 2, PLACE: 3, REMOVE: 4, TEXT: 5 };

  function encodeOps(ops) {
    const strings = [];
    const sIdx = new Map();
    const values = [];
    const vIdx = new Map();
    const bytes = [];
    const str = (s) => {
      if (sIdx.has(s)) return sIdx.get(s);
      const i = strings.length;
      strings.push(s);
      sIdx.set(s, i);
      return i;
    };
    const val = (v) => {
      const key = typeof v === 'string' ? 's' + v : JSON.stringify(v === undefined ? null : v);
      if (vIdx.has(key)) return vIdx.get(key);
      const i = values.length;
      values.push(JSON.stringify(v === undefined ? null : v));
      vIdx.set(key, i);
      return i;
    };
    const w = (n) => {
      n = n >>> 0;
      for (;;) {
        const b = n & 0x7f;
        n >>>= 7;
        if (n === 0) {
          bytes.push(b);
          return;
        }
        bytes.push(b | 0x80);
      }
    };
    const props = (list) => {
      w(list.length);
      for (const [name, kind, value] of list) {
        w(str(name));
        w(kind);
        w(kind === KIND.FN ? str(value) : val(value));
      }
    };
    for (const op of ops) {
      w(op.op);
      if (op.op === OP.CREATE) {
        w(op.id);
        w(str(op.type));
        w(op.parent || 0);
        w(op.index || 0);
        props(op.props);
      } else if (op.op === OP.SET) {
        w(op.id);
        props(op.props);
      } else if (op.op === OP.PLACE) {
        w(op.id);
        w(op.parent || 0);
        w(op.index || 0);
      } else if (op.op === OP.REMOVE) {
        w(op.id);
      }
    }
    return { bytes: Uint8Array.from(bytes), strings, values };
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const flush = () => {
      renderScheduled = false;
      run({ code: null, constants: currentConstants, appData: currentAppData, reason: 'interaction' });
    };
    if (queue) queue(flush);
    else flush();
  }

  // ── 7. 消息循环 ────────────────────────────────────────────────────────
  listen('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'program') {
      run({ code: msg.code, constants: msg.constants, appData: msg.appData, reason: msg.reason || 'program', turn: msg.turn });
    } else if (msg.type === 'call') {
      const fn = fnById.get(msg.fn);
      if (typeof fn !== 'function') {
        post({ type: 'error', turn, kind: 'callback', message: '未知的处理器 ' + msg.fn, revision });
        return;
      }
      try {
        fn(...(msg.args || []));
      } catch (e) {
        report('callback', e);
        post({ type: 'error', turn, kind: 'callback', message: String(e && e.message), revision });
      }
    } else if (msg.type === 'reset') {
      state.clear();
      pristine.clear();
      setters.clear();
      fnBySource.clear();
      fnById.clear();
      lastGood = { tree: [], code: null, constants: null, appData: null };
      currentCode = null;
      idSeq = 1;
      revision = 0;
      if (msg.turn != null) turn = msg.turn;
      post({ type: 'reset-ok', turn });
    } else if (msg.type === 'snapshot') {
      // 宿主想看看沙箱里的状态（调试用；真实实现里模型看不到这些值）
      post({ type: 'snapshot', turn, state: Object.fromEntries(state), pristine: [...pristine] });
    }
  });

  post({ type: 'ready', locked: lockdownReport });
};
