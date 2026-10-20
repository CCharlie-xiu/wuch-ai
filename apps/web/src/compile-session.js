// ─────────────────────────────────────────────────────────────────────────────
// 服务端（这一侧的真实职责，都在这个文件里）
//
//   · 收模型吐出来的 OpenUI Lang，边收边全量重编译（不是增量编译）
//   · 把「原文 / 编译产物 / 数据」并排放在一条结构化消息里
//   · 每几毫秒发一次 JSON-Patch 风格的更新
//   · 解析需要服务端出数据的组件（AsyncImage / Entity / Cite）
//   · 顺手生成 fallbackMarkdown
//
// 编译从第一个 token 就开始了：root 一出现就有骨架，后面的变量写到哪补到哪。
// ─────────────────────────────────────────────────────────────────────────────

import { compile } from '@openui-lab/compiler/compile.js';
import { mergeSource } from '@openui-lab/ui-dsl';

const RECOMPILE_MS = 240; // 博客里实测中位间隔 230ms，全量重编译 290ms
const RECOMPILE_MAX_MS = 900; // 源码变长后编译变慢：拉长间隔，把主线程让给绘制

export function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 离线也能看的占位图（图片搜索失败 / 没网时兜底） */
export function placeholderImage(query, ratio = '1:1') {
  const [w, h] = String(ratio).split(':').map(Number);
  const width = 800;
  const height = Math.round((width * (h || 1)) / (w || 1));
  const seed = hashSeed(query);
  const hue = parseInt(seed.slice(0, 4), 36) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},32%,26%)"/><stop offset="1" stop-color="hsl(${(hue + 48) % 360},38%,14%)"/>
</linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#g)"/>
<text x="40" y="${height - 48}" fill="rgba(255,255,255,.72)" font-family="system-ui,sans-serif" font-size="26">${escapeXml(
    query.slice(0, 60)
  )}</text>
<text x="40" y="${height - 18}" fill="rgba(255,255,255,.35)" font-family="system-ui,sans-serif" font-size="16">服务端图片解析占位</text>
</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** 「服务端」执行图片搜索：模型只写描述，这里把结果补进去 */
export function resolveImageRequest(req, { online = true } = {}) {
  const query = req.props.query || 'abstract';
  const ratio = req.props.aspectRatio || '1:1';
  const [w, h] = String(ratio).split(':').map(Number);
  const height = Math.round((800 * (h || 1)) / (w || 1));
  const seed = hashSeed(query);
  const remote = `https://picsum.photos/seed/${seed}/800/${height}`;
  return {
    id: req.id,
    componentName: 'AsyncImage',
    state: {
      is_loading: false,
      query,
      images: [
        {
          content_url: online ? remote : placeholderImage(query, ratio),
          url: online ? remote : placeholderImage(query, ratio),
          fallback: placeholderImage(query, ratio),
          title: query,
        },
      ],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {(datasetId: string) => Promise<{version: string, name: string, data: object}>} [o.resolveDataset]
 *        绑定数据集的 Sheet 由它取数（按当前版本的 refs）；表格数据只留在页面这边，
 *        componentResults 里只放 { dataset, version } 这样的小描述，免得整张表跟着程序进出沙箱
 */
export function createServer({ onPatch, onDiagnostics, online = true, resolveDataset = null }) {
  let raw = '';
  let base = null; // 续画：上一版完整原文；raw 只是这一轮的补丁
  let source = ''; // 合并后的完整原文（= 这一轮结束时的画布快照）
  const tableData = {}; // componentResults id → 数据集内容
  let timer = null;
  let last = null; // 上一次编译结果
  let lastAt = 0;
  let lastCompileMs = 0; // 上一轮全量重编译耗时：用来自适应拉长间隔
  let finished = false;
  let resolveQueue = [];
  let resolved = {};
  let bindings = {};
  let epoch = 0; // 每条回答一个编号：上一条回答迟到的图片解析不能写进这一条
  let carried = null;

  const stats = {
    chars: 0,
    updates: 0,
    kinds: { structure: 0, text: 0, pending: 0, data: 0, final: 0 },
    patchBytes: 0,
    resentBytes: 0,
    startedAt: 0,
    endedAt: 0,
    intervals: [],
    recompiles: 0,
    lastUpdateKind: null,
  };

  const message = {
    raw: '',
    code: '',
    constants: {},
    appData: { opGenui: { componentResults: {}, modelDataBindings: {} } },
    fallbackMarkdown: '',
    diagnostics: [],
    recoveryDiagnostics: [],
    partial: false,
    serverRequests: [],
    summary: [],
    stats: null,
  };

  function emitPatch(ops, kind) {
    const payload = { o: 'patch', v: ops };
    const bytes = JSON.stringify(payload).length;
    stats.patchBytes += bytes;
    for (const op of ops) {
      if (op.o === 'replace' && op.p.endsWith('/code')) stats.resentBytes += String(op.v).length;
    }
    stats.updates++;
    stats.kinds[kind]++;
    stats.lastUpdateKind = kind;
    const now = performance.now();
    if (lastAt) stats.intervals.push(now - lastAt);
    lastAt = now;
    onPatch && onPatch(payload, kind);
  }

  function recompile(reason) {
    stats.recompiles++;
    source = base != null ? mergeSource(base, raw, { final: reason === 'final' }) : raw;
    const out = compile(source, { final: reason === 'final' });
    message.raw = raw;
    message.source = source;
    message.fallbackMarkdown = out.fallbackMarkdown;
    message.diagnostics = out.diagnostics;
    message.recoveryDiagnostics = out.recoveryDiagnostics;
    message.partial = out.partial;
    message.serverRequests = out.serverRequests;
    message.summary = out.summary;
    message.stats = out.stats;

    const codeChanged = !last || last.code !== out.code;
    const constantsChanged = !last || JSON.stringify(last.constants) !== JSON.stringify(out.constants);
    const grew = !last || raw.length > last.rawLen;

    // 三类更新：结构变了 / 只是文字长了 / 新写的部分还拼不出组件
    let kind = 'pending';
    if (codeChanged) kind = 'structure';
    else if (constantsChanged) kind = 'text';

    const ops = [];
    if (grew) {
      const delta = raw.slice(last ? last.rawLen : 0);
      if (delta) ops.push({ p: '/message/content/parts/0', o: 'append', v: delta });
    }
    if (codeChanged) {
      ops.push({ p: '/message/metadata/model_dil_v2/code', o: 'replace', v: out.code });
      message.code = out.code;
      // 常量表整表替换（键稳定，增量 append 只用于纯文字增长）
      ops.push({ p: '/message/metadata/model_dil_v2/constants', o: 'replace', v: out.constants });
      message.constants = out.constants;
      ops.push({ p: '/message/metadata/model_dil_v2/fallbackMarkdown', o: 'replace', v: out.fallbackMarkdown });
    } else if (constantsChanged) {
      const fresh = {};
      for (const k of Object.keys(out.constants)) if (!last || last.constants[k] !== out.constants[k]) fresh[k] = out.constants[k];
      ops.push({ p: '/message/metadata/model_dil_v2/constants', o: 'append', v: fresh });
      message.constants = out.constants;
    }
    if (ops.length) emitPatch(ops, kind);

    const notes = out.pending.length ? [`等待还没写到的变量：${out.pending.join('、')}`] : [];
    message.recoveryNotes = notes;
    onDiagnostics && onDiagnostics({ diagnostics: out.diagnostics, recovery: out.recoveryDiagnostics, notes, stats: out.stats });

    // 组件写完 → 服务端去取数据，一两秒后 patch 进来。
    // 末尾语句是临时补齐的，描述还在长：连续两次编译都出现的请求才算写完
    const prevIds = last ? last.requestIds : new Set();
    const settled = reason === 'final' ? out.serverRequests : out.serverRequests.filter((r) => prevIds.has(r.id));
    last = { code: out.code, constants: out.constants, rawLen: raw.length, requestIds: new Set(out.serverRequests.map((r) => r.id)) };
    queueResolution(settled);
    return kind;
  }

  function publish(results) {
    message.appData.opGenui.componentResults = { ...message.appData.opGenui.componentResults, ...results };
    emitPatch(
      [
        {
          p: '/message/metadata/model_dil_v2/appData/opGenui/componentResults',
          o: 'append',
          v: results,
        },
      ],
      'data'
    );
  }

  // 内联 Sheet 不用取数；绑定数据集的 Sheet 交给 resolveDataset
  const isTable = (r) => r.componentName === 'Sheet';
  const wantsData = (r) => !isTable(r) || !!r.props.dataset;

  function queueResolution(requests) {
    const fresh = requests.filter((r) => !resolved[r.id] && wantsData(r));
    if (!fresh.length) return;
    for (const r of fresh) resolved[r.id] = { pending: true };
    const images = fresh.filter((r) => !isTable(r));
    const tables = fresh.filter(isTable);
    const owner = epoch;
    if (images.length) {
      setTimeout(() => {
        if (owner !== epoch) return;
        const results = {};
        for (const r of images) {
          const out = resolveImageRequest(r, { online });
          resolved[r.id] = out;
          results[r.id] = { componentName: out.componentName, state: out.state };
        }
        publish(results);
      }, 500 + Math.random() * 500);
    }
    for (const r of tables) resolveTable(r, owner);
  }

  async function resolveTable(r, owner = epoch) {
    let state;
    try {
      if (!resolveDataset) throw new Error('没有数据集接口');
      const got = await resolveDataset(r.props.dataset);
      if (owner !== epoch) return;
      tableData[r.id] = got.data;
      state = { dataset: r.props.dataset, version: got.version, name: got.name };
    } catch (e) {
      if (owner !== epoch) return;
      delete tableData[r.id];
      state = { dataset: r.props.dataset, error: e.message || String(e) };
    }
    resolved[r.id] = { componentName: 'Sheet', state };
    publish({ [r.id]: { componentName: 'Sheet', state } });
  }

  function schedule() {
    if (timer || finished) return;
    // 编译慢于固定间隔时，下一轮再等久一点，否则会连续占满主线程 → 思考停、画布卡、最后突然整页蹦出
    const wait = Math.min(RECOMPILE_MAX_MS, Math.max(RECOMPILE_MS, Math.round(lastCompileMs * 1.6)));
    timer = setTimeout(() => {
      timer = null;
      const t0 = performance.now();
      recompile('stream');
      lastCompileMs = performance.now() - t0;
      if (!finished) schedule();
    }, wait);
  }

  function begin({ modelDataBindings, base: nextBase = null } = {}) {
    epoch++;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // 上一条回答的取数结果先收着：续画时请求 id（内容哈希）不变，直接沿用
    carried = { results: message.appData.opGenui.componentResults, resolved, tables: { ...tableData } };
    raw = '';
    base = nextBase;
    source = nextBase || '';
    for (const k of Object.keys(tableData)) delete tableData[k];
    last = null;
    lastAt = 0;
    lastCompileMs = 0;
    finished = false;
    resolved = {};
    resolveQueue = [];
    bindings = modelDataBindings || {};
    stats.chars = 0;
    stats.updates = 0;
    stats.kinds = { structure: 0, text: 0, pending: 0, data: 0, final: 0 };
    stats.patchBytes = 0;
    stats.resentBytes = 0;
    stats.intervals = [];
    stats.recompiles = 0;
    stats.startedAt = performance.now();
    stats.endedAt = 0;
    message.raw = '';
    message.source = source;
    message.code = '';
    message.constants = {};
    message.fallbackMarkdown = '';
    message.diagnostics = [];
    message.recoveryDiagnostics = [];
    message.serverRequests = [];
    message.summary = [];
    message.appData = { opGenui: { componentResults: {}, modelDataBindings: bindings } };
  }

  return {
    message,
    stats,
    /** 新的一条回答 */
    begin,
    /** 清空对话：丢掉当前回答，在途的重编译与图片解析一律作废 */
    reset() {
      begin();
      finished = true;
    },
    /** 模型吐出一个片段 */
    append(text) {
      raw += text;
      stats.chars = raw.length;
      schedule();
    },
    /** 流结束：最后一次全量编译 */
    finish() {
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      recompile('final');
      stats.endedAt = performance.now();
      message.partial = false;
      emitPatch([{ p: '/message/metadata/model_dil_v2/done', o: 'replace', v: true }], 'final');
    },
    get raw() {
      return raw;
    },
    /** 合并后的完整原文（新画时就是 raw） */
    get source() {
      return source;
    },
    /** 模型读完第一行才知道是续画：把上一版原文垫到补丁下面 */
    setBase(b) {
      base = b;
      if (carried) {
        message.appData.opGenui.componentResults = { ...carried.results };
        resolved = { ...carried.resolved };
        for (const [k, v] of Object.entries(carried.tables)) tableData[k] = v;
        for (const k of Object.keys(resolved)) if (resolved[k] && resolved[k].pending) delete resolved[k];
      }
      if (raw || b) schedule();
    },
    /** 渲染器取服务端结果：Sheet 的表格数据从页面这边补上 */
    resultFor(id) {
      const r = message.appData.opGenui.componentResults[id];
      if (!r || !tableData[id]) return r || null;
      return { ...r, state: { ...r.state, data: tableData[id] } };
    },
    /** 数据集换了版本（用户编辑 / 切换版本）：画布上绑定它的 Sheet 全部重新取数 */
    refreshTables(datasetId) {
      const reqs = (message.serverRequests || []).filter((r) => isTable(r) && r.props.dataset && (!datasetId || r.props.dataset === datasetId));
      for (const r of reqs) resolveTable(r);
    },
    setModelDataBindings(b) {
      bindings = b;
      message.appData.opGenui.modelDataBindings = b;
      emitPatch([{ p: '/message/metadata/model_dil_v2/appData/opGenui/modelDataBindings', o: 'replace', v: b }], 'data');
    },
  };
}
