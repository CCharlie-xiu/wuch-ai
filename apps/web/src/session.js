// ─────────────────────────────────────────────────────────────────────────────
// 会话内核：把四层链路封成一个可复用的对象。
//
// 两个页面（index.html 聊天 / demos.html 演示回放）都只是它的壳：
//   页面负责长什么样，内核负责链路怎么跑。
//
//   页面 ──runTurn──▶ 服务端编译 ──▶ 沙箱 worker ──▶ 操作 ──▶ 渲染器 ──▶ 页面上的容器
//                          ▲                                     │
//                          └──── 交互只回 worker，不回模型 ◀───────┘
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from './compile-session.js';
import { createRenderer } from './renderer.js';
import { decodeOps } from '@openui-lab/protocol';
import { readModeLine } from '@openui-lab/ui-dsl';
import { SKILL_MAP, skillsUsedIn, COMPONENT_GROUPS, COMPONENTS, GROUP_IDS, groupOf, canvasBudget, CATALOG, listComponents, componentDocs, layoutGuide, componentsUsedIn } from '@openui-lab/catalog';
import { streamChat, buildSystemPrompt, buildChatPrompt, CHAT_TOOLS, SEARCH_TOOLS, SEARCH_TOOL_NAMES, KB_TOOLS, KB_TOOL_NAMES } from './model.js';
import { addUsage, emptyUsage, contextWindowFor, contextRatio } from './usage.js';
import { DEFAULT_COMPRESS, compressHistory, shouldCompress } from './context-compress.js';
import { loadMemoryBlock, loadSessionSummary } from './memory-client.js';
import { loadKbIndex, invalidateKbCache } from './kb-client.js';
import { askToolApproval } from './tool-approval.js';
import { createToolBudget } from './tool-budget.js';
import { LineRouter } from './line-router.js';
import { authHeaders } from './accounts.js';

const TOOL_LABEL = {
  load_skill: '加载技能…',
  list_components: '查组件',
  get_components: '读组件用法',
  get_layout: '读排布规则',
  draw_ui: '调用界面生成…',
  web_search: '联网搜索',
  fetch_url: '读取网页',
  kb_lookup: '查知识库',
  kb_put: '存入知识库',
  kb_get: '读知识库条目',
};
const GROUP_MAP = new Map(COMPONENT_GROUPS.map((g) => [g.id, g]));
const groupSize = (id) => COMPONENTS.filter((c) => !c.internal && !c.skill && groupOf(c) === id).length;
// 选了技能但没走查询时，按技能给一套默认组件（骨架由 generatePrompt 补）
const SKILL_EXTRA = { sheet: ['BarChart', 'LineChart', 'PieChart', 'MetricIndicator'] };

// ── 工具循环 ────────────────────────────────────────────────────────────────
// 每一轮：模型可同时要「联网工具」+「信号工具」(draw_ui / load_skill)。
// 全部 tool_call 都必须有 tool 回执，否则下一轮上游会拒（表现为突然中断）。
//
// 工具结果是要有预算的 —— 搜一次就几百到几千 token 进上下文，模型又爱换词重搜。
// 两条闸（单个工具的次数、整轮的字数）与防死循环都在 tool-budget.js 里。
//
// **轮数不设上限**：模型想调几轮就调几轮，直到它自己不再要工具为止。
const KEEP_TOOL_CHARS = 1200; // 上一轮的结果进下一轮时保留多少字
// 历史最多留几轮（user + assistant 各一条 = 2）。超过就丢最早的 ——
// 但先由上下文压缩把它们压成要点，丢的是「原文」而不是「信息」。
export const HISTORY_MAX_TURNS = 12;
const HISTORY_MAX = HISTORY_MAX_TURNS * 2;

// 工具 → 服务端接口。联网工具在 /api/tools/*，知识库在 /api/kb/*。
const TOOL_PATHS = {
  web_search: () => '/api/tools/web_search',
  fetch_url: () => '/api/tools/fetch_url',
  kb_lookup: () => '/api/kb/lookup',
  kb_put: () => '/api/kb/items',
  kb_get: (args) => `/api/kb/items/${encodeURIComponent(String((args && args.id) || ''))}`,
};
/** 要回灌给模型的工具（联网 + 知识库）；draw_ui / load_skill 是信号工具，不走这里 */
const SERVER_TOOL_NAMES = new Set([...SEARCH_TOOL_NAMES, ...KB_TOOL_NAMES]);

/** 本地组件查询工具：直接读 catalog，不经过服务端；结果要回灌，模型才能接着挑 */
const COMPONENT_TOOL_NAMES = new Set(['list_components', 'get_components', 'get_layout']);

function runComponentTool(name, args, viewport) {
  if (name === 'list_components') {
    const text = listComponents({ group: args?.group, query: args?.query });
    const detail = args?.group ? `组 ${args.group}` : args?.query ? `搜「${args.query}」` : '组件组';
    return { text, detail };
  }
  if (name === 'get_components') {
    const raw = args?.names;
    const names = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter(Boolean);
    return { text: componentDocs(names), detail: names.slice(0, 6).join(' / ') || '没给组件名' };
  }
  if (name === 'get_layout') {
    return { text: layoutGuide(viewport), detail: '列数 / 块高 / 瀑布流规则', layout: true };
  }
  return { text: `没有这个工具：${name}`, detail: '' };
}

/** 工具目录（开关 + 授权方式）来自服务端，拉一次就缓存；没服务端就当没有联网工具 */
let toolCatalogPromise = null;
function loadToolCatalog() {
  if (!toolCatalogPromise) {
    toolCatalogPromise = fetch('/api/tools', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return toolCatalogPromise;
}

const toolOn = (catalog, name) => !!(catalog && catalog.tools && catalog.tools[name] && catalog.tools[name].enabled);

const chatTools = (catalog) => {
  const on = [...SEARCH_TOOLS, ...KB_TOOLS].filter((t) => toolOn(catalog, t.function.name));
  return on.length ? [...CHAT_TOOLS, ...on] : CHAT_TOOLS;
};

async function callServerTool(name, args, signal) {
  const build = TOOL_PATHS[name];
  if (!build) throw new Error(`没有这个工具：${name}`);
  const method = name === 'kb_get' ? 'GET' : 'POST';
  const res = await fetch(build(args), {
    method,
    headers: authHeaders(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    body: method === 'POST' ? JSON.stringify(args || {}) : undefined,
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const toolDetail = (name, out) => {
  if (!out) return '';
  if (out.error) return '失败：' + out.error;
  if (name === 'web_search') return `${(out.results || []).length} 条 · ${out.engine || ''}${out.cached ? ' · 缓存' : ''}`.trim();
  if (name === 'kb_lookup') return out.hit ? `命中已有条目 · ${out.reason}` : '没查到，可以入库';
  if (name === 'kb_put') return out.created ? `已入库 ${out.item?.id || ''}`.trim() : `已有同条，未重复建 · ${out.item?.id || ''}`.trim();
  if (name === 'kb_get') return out.item ? `${out.item.name} · ${(out.body || '').length} 字` : '';
  return `${out.length || 0} 字 · ${out.via || ''}${out.cached ? ' · 缓存' : ''}`.trim();
};

/** 回灌给模型的文本：紧凑排列，别用 JSON（引号转义会白涨一截） */
function formatToolResult(name, out) {
  if (!out) return '';
  if (out.error) return `调用失败：${out.error}`;
  if (name === 'web_search') {
    const list = out.results || [];
    if (!list.length) return '没搜到结果。换个更具体的词再试一次；还是没有就直接告诉用户没查到。';
    return (
      `搜「${out.query}」，${list.length} 条${out.cached ? '（命中缓存）' : ''}：\n` +
      list.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n')
    );
  }
  if (name === 'kb_lookup') {
    if (!out.hit) return '知识库里没有这条（按文件 hash / 标题 / 摘要都没找到）。要沉淀就用 kb_put 建一条，body 写蒸馏后的骨架，不要贴原文。';
    const it = out.item || {};
    return `知识库里已经有这条，直接用它，不要再 kb_put：\n${it.name}（${it.id}）${it.tag ? ` [${it.tag}]` : ''}\n${it.summary || ''}\n\n${out.body || ''}`;
  }
  if (name === 'kb_put') {
    if (!out.item) return '入库失败，没有返回条目。';
    return out.created
      ? `已入库：${out.item.name}（${out.item.id}）。之后需要正文用 kb_get 读。`
      : `知识库里已经有「${out.item.name}」（${out.item.id}），没有重复建。`;
  }
  if (name === 'kb_get') {
    if (!out.item) return '没找到这条知识条目。';
    return `${out.item.name}${out.item.tag ? ` [${out.item.tag}]` : ''}\n${out.item.summary || ''}\n\n${out.body || ''}`;
  }
  return `${out.url}（${out.via || ''}${out.cached ? '，缓存' : ''}）\n${out.text}`;
}

/** 上一轮的结果进下一轮前截断：留个索引就够，要看细节模型会自己再调一次 */
function slimToolMessages(messages, skipIds = null) {
  for (const m of messages) {
    if (m.role !== 'tool' || m.content.length <= KEEP_TOOL_CHARS) continue;
    if (skipIds && skipIds.has(m.tool_call_id)) continue; // 组件用法是这一轮的工作底稿，不截
    m.content = `${m.content.slice(0, KEEP_TOOL_CHARS)}\n…（以上是前一轮的结果，已截断；需要更多细节再调一次工具）`;
  }
}

/** 组件名 / 组 id / 技能 id 混着写也能认：统一展开成组件名 */
function normalizeComponents(values) {
  const out = new Set();
  for (const raw of values || []) {
    const v = String(raw || '');
    if (!v) continue;
    const def = CATALOG.get(v) || [...CATALOG.values()].find((c) => c.name.toLowerCase() === v.toLowerCase());
    if (def && !def.internal) {
      out.add(def.name);
      continue;
    }
    if (!GROUP_MAP.has(v) && !SKILL_MAP.has(v)) continue;
    for (const c of COMPONENTS) {
      if (c.internal) continue;
      if (c.skill ? c.skill === v : groupOf(c) === v) out.add(c.name);
    }
  }
  return [...out];
}

function applySignal(c, signals, step, id) {
  if (c.name === 'load_skill' && SKILL_MAP.has(c.args.id)) {
    if (!signals.skills.includes(c.args.id)) signals.skills.push(c.args.id);
    const sk = SKILL_MAP.get(c.args.id);
    step({ id, label: `加载技能：${sk.name}`, detail: sk.description, state: 'done' });
    return { ok: true, note: `已加载技能 ${sk.name}` };
  }
  if (c.name === 'draw_ui') {
    signals.task = String(c.args.task || '').trim() || signals.task;
    const raw = c.args.components;
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，\s]+/).filter(Boolean) : null;
    if (list) signals.components = normalizeComponents(list);
    signals.draw = true;
    const picked = signals.components.length ? ` · ${signals.components.length} 个组件` : '';
    step({ id, label: '调用界面生成', detail: `${signals.task || ''}${picked}`, state: 'done' });
    return { ok: true, note: '已记下，稍后生成界面' };
  }
  step({ id, label: `未知工具 ${c.name}，已忽略`, state: 'done' });
  return { ok: false, error: `未知工具 ${c.name}` };
}

/**
 * 工具循环：搜/读 → 回灌 → 再分析 → 再调，直到模型不再要工具或用户中断。
 * @returns {{ res, signals: { draw, task, groups, skills } }}
 */
async function runTools(res, messages, catalog, { step, ask, cancelled, onToolCall, tools, signal, viewport }) {
  const signals = { draw: false, task: null, skills: [], components: [], layout: false };
  const componentCallIds = new Set();
  const budget = createToolBudget();
  let round = 0;

  while (res && res.toolCalls.length) {
    if (cancelled && cancelled()) break;
    const calls = res.toolCalls;
    const hasServerTool = calls.some((c) => SERVER_TOOL_NAMES.has(c.name) || COMPONENT_TOOL_NAMES.has(c.name));
    budget.beginRound();
    // DeepSeek 思考模式 + tools：reasoning_content 必须原样回灌，否则上游会 400。
    // 不带 tools 的请求会忽略它，所以这里只在拿到时附上。
    const assistantMsg = { role: 'assistant', content: res.content || '', tool_calls: res.rawToolCalls || [] };
    if (res.reasoning) assistantMsg.reasoning_content = res.reasoning;
    messages.push(assistantMsg);

    for (const c of calls) {
      if (cancelled && cancelled()) break;
      const id = `tool-r${round}-${c.id || c.name}`;
      if (COMPONENT_TOOL_NAMES.has(c.name)) {
        const label = TOOL_LABEL[c.name] || c.name;
        const gate = budget.check(c.name);
        if (!gate.allow) {
          step({ id, label, detail: gate.code === 'limit' ? `本轮上限 ${gate.limit} 次` : '工具预算已用完', state: 'done' });
          messages.push({
            role: 'tool',
            tool_call_id: c.id,
            content: gate.code === 'limit'
              ? `「${label}」这一轮最多 ${gate.limit} 次，已经用完。用上面已有的信息继续，不要再调它。`
              : '这一轮的工具预算用完了。用上面已有的信息继续，不要再调工具。',
          });
          continue;
        }
        const out = runComponentTool(c.name, c.args, viewport);
        if (out.layout) signals.layout = true;
        budget.spent(c.name, out.text.length);
        componentCallIds.add(c.id);
        step({ id, label, detail: out.detail, state: 'done' });
        messages.push({ role: 'tool', tool_call_id: c.id, content: out.text });
        continue;
      }
      if (SERVER_TOOL_NAMES.has(c.name)) {
        const label = TOOL_LABEL[c.name] || c.name;
        const what = String(c.args.query || c.args.url || c.args.title || c.args.name || c.args.id || '').slice(0, 90);
        // 两条闸（单个工具的次数 / 整轮的字数）都在 budget 里，见 tool-budget.js
        const gate = budget.check(c.name);
        if (!gate.allow) {
          step({ id, label, detail: gate.code === 'limit' ? `本轮上限 ${gate.limit} 次` : '工具预算已用完', state: 'done' });
          messages.push({
            role: 'tool',
            tool_call_id: c.id,
            content:
              gate.code === 'limit'
                ? `「${label}」这一轮最多 ${gate.limit} 次，已经用完。用上面已有的信息回答，不要再调它。`
                : '这一轮的工具预算用完了。用上面已有的信息回答，不要再调工具。',
          });
          continue;
        }
        step({ id, label: what ? `${label}：${what}` : label, state: 'running' });
        if (catalog && catalog.tools[c.name] && catalog.tools[c.name].approval === 'ask') {
          const meta = catalog.tools[c.name];
          const ok = await askToolApproval({
            name: c.name,
            label,
            detail: what,
            risk: meta.risk,
            summary: meta.summary,
            signal,
          });
          if (cancelled && cancelled()) {
            step({ id, label, detail: '已中断', state: 'done' });
            messages.push({ role: 'tool', tool_call_id: c.id, content: '用户中断了这一轮' });
            continue;
          }
          if (!ok) {
            step({ id, label, detail: '已拒绝', state: 'done' });
            messages.push({ role: 'tool', tool_call_id: c.id, content: '用户拒绝了这次调用' });
            continue;
          }
        }
        let out;
        try {
          out = await callServerTool(c.name, c.args, signal);
          step({ id, label, detail: toolDetail(c.name, out), state: 'done' });
        } catch (e) {
          const aborted = e.name === 'AbortError' || (cancelled && cancelled());
          out = { error: aborted ? '已中断' : e.message };
          step({ id, label, detail: aborted ? '已中断' : '失败：' + e.message, state: 'done' });
        }
        // 入库成功后索引就变了：作废前端缓存，下一轮立刻带上新条目
        if (c.name === 'kb_put' && !out.error) invalidateKbCache();
        const text = formatToolResult(c.name, out);
        budget.spent(c.name, text.length);
        messages.push({ role: 'tool', tool_call_id: c.id, content: text });
      } else {
        const ack = applySignal(c, signals, step, id);
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(ack) });
      }
    }

    if (cancelled && cancelled()) break;
    round += 1;
    // 这一轮只剩信号、没有要回灌的工具：不用再问，外层直接进画界面
    if (!hasServerTool) break;
    // 防死循环：这一轮的工具调用一个都没真跑（全被次数 / 预算挡下），再问还是白问。
    // 轮数本身没有上限 —— 想调几轮调几轮，只有原地打转才收尾。
    if (budget.allStalled()) {
      step({ id: `tool-stall-${round}`, label: '工具没有再执行', detail: '次数 / 预算已用完，用已有信息收尾', state: 'done' });
      break;
    }
    // 上一轮的结果截断，别让上下文越滚越大
    slimToolMessages(messages, componentCallIds);
    res = await ask(messages, { tools, onToolCall });
  }

  return { res, signals, componentCallIds };
}

export const DEFAULT_SETTINGS = {
  // 这几个是「当前生效的那个模型」的快照，来源是服务端的模型配置列表
  // （apps/web/src/models.js），改配置在设置页，这里只是运行时读的那一份。
  modelId: null,
  modelName: '',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  thinking: false,
  // DeepSeek 的思考强度：low / high / xhigh / max（官方还认 none，medium 与 xhigh 暂时映射到 high）。
  // 只在 thinking 开着时生效；别的端点不认这个字段，不会发出去。
  reasoningEffort: 'high',
  // 上下文压缩：占用到阈值就把早前的轮次压成要点。关掉之后历史一直原样发。
  contextCompress: true,
  compressThreshold: 0.8,
  // 先用轻量提示词判断：简单问题直接答，要画界面时才拉完整规范
  router: true,
  onlineImages: true,
  restoreLast: true,
};

const STORE_KEY = 'openui.settings';

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch (e) {
    /* 隐私模式下写不进去，忽略 */
  }
}

/** 模型有时会把 OpenUI Lang 包在围栏里；流式到达时得先把围栏吃掉 */
class FenceFilter {
  constructor() {
    this.buf = '';
    this.headDone = false;
  }
  push(chunk) {
    this.buf += chunk;
    if (!this.headDone) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1 && this.buf.length < 16) return [];
      const firstLine = this.buf.slice(0, nl === -1 ? this.buf.length : nl).trim();
      if (/^```/.test(firstLine)) this.buf = nl === -1 ? '' : this.buf.slice(nl + 1);
      this.headDone = true;
    }
    if (this.buf.length <= 4) return [];
    const out = this.buf.slice(0, -4);
    this.buf = this.buf.slice(-4);
    return [out];
  }
  end() {
    const tail = this.buf.replace(/\n?```[a-z]*\s*$/i, '');
    this.buf = '';
    return tail ? [tail] : [];
  }
}

/** 第一行的模式指令（@edit / @new）：读到第一行再决定续画还是重画，指令本身不进原文 */
class ModeFilter {
  constructor(decide) {
    this.decide = decide;
    this.head = '';
    this.done = false;
  }
  push(piece) {
    if (this.done) return [piece];
    this.head += piece;
    const lead = this.head.trimStart();
    if (!lead) return [];
    if (lead[0] === '@' && this.head.indexOf('\n') === -1 && lead.length < 40) return [];
    return this.flush();
  }
  flush() {
    if (this.done) return [];
    this.done = true;
    const { mode, rest } = readModeLine(this.head);
    this.decide(mode);
    this.head = '';
    return rest ? [rest] : [];
  }
}

const tidyReply = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** 把一轮回答压成给下一轮看的一句话：画布原文已经整份放在系统提示里，不必再塞一遍 */
export function describeTurn(message, mode) {
  const notes = (message.summary || []).map((s) => `${s.title}${s.text ? '：' + s.text : ''}`).join('\n');
  return `（已${mode === 'edit' ? '在上一版画布上续画' : '重新绘制画布'}${notes ? '。总结：\n' + notes : ''}）`;
}

/**
 * 画布当前能用的宽高（px），是「模型看得见的那一屏」，不是整块面板。
 *
 * 高度取「画布顶 → 滚动容器底」那一段：面板里还要扣掉画布头、内边距、卡片外边距，
 * 直接用 pane.clientHeight 会多报 200px 左右，模型就会把结论放到首屏之外。
 * 量不到（面板收起 / 还没布局）返回 null。
 */
export function measureViewport(stage) {
  if (!stage || !stage.clientWidth) return null;
  const pane = stage.closest('.panel') || document.documentElement;
  const sr = stage.getBoundingClientRect();
  const pr = pane.getBoundingClientRect();
  // 画布顶到容器顶的偏移（画布头 + 卡片内边距）。加回 scrollTop 抵消滚动，
  // 否则往下滚过再生成时预算会凭空变大。
  const offset = sr.top - pr.top + (pane.scrollTop || 0);
  const visible = (pane.clientHeight || window.innerHeight) - Math.max(0, offset);
  const height = Math.max(240, Math.min(pane.clientHeight || window.innerHeight, visible, window.innerHeight));
  return { width: Math.round(stage.clientWidth), height: Math.round(height) };
}

/**
 * @param {object} o
 * @param {(datasetId: string) => Promise<{version, name, data}>} [o.resolveDataset] 绑定数据集的 Sheet 取数
 * @param {(kind: string, payload: any, node: object) => void} [o.onHost] 组件找宿主办事（表格编辑 / 导入导出）
 */
export function createSession({ stage, runnerFrame, resolveCannedTurn, resolveDataset, onHost } = {}) {
  const listeners = new Map();
  const on = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
    return () => {
      const arr = listeners.get(type);
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  };
  const emit = (type, payload) => {
    for (const fn of listeners.get(type) || []) fn(payload);
  };

  // 排布收尾信号：Grid 靠这两个事件区分「还在流式」和「这一轮画完了」。
  // 走 document 事件而不是会话回调，是因为 Grid 活在渲染器里，拿不到 session 对象。
  const layoutSignal = (name) => {
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(name));
  };

  const state = {
    settings: loadSettings(),
    turn: 0,
    running: false,
    stop: false,
    ready: false,
    lockInfo: null,
    workerErrors: [],
    renderErrors: [],
    diagnostics: { diagnostics: [], recovery: [], notes: [], stats: null },
    patchLog: [],
    opsLog: [],
    lastOps: null,
    lastPayload: null,
    history: [],
    /** 当前会话 id：拉 L1 摘要用；页面 setHead 时写入 */
    conversationId: null,
    /** 画布当前版本（HEAD 快照）：{ source, version }。有它，模型才可以续画 */
    canvas: null,
    /** 页面当前选中的技能 id、可用数据集概要（给系统提示用） */
    skills: [],
    datasets: [],
    /**
     * 当前会话的 token 用量（跨轮累计；换会话 / 清空时归零，打开历史会话时从服务端回填）。
     * contextTokens 取最近一次请求的 promptTokens —— 上下文压缩看的是这个，不是累计值。
     */
    usage: emptyUsage(contextWindowFor(loadSettings().model, loadSettings().baseURL)),
    /**
     * 压缩后的早期对话要点（挂在 system prompt 里）。history 已被压掉的部分只在这里，
     * 所以它和 history 是一对：history 说「最近几轮原文」，这个说「更早发生了什么」。
     */
    contextSummary: '',
    /** 压缩统计：{ at, droppedTurns, savedChars, total, threshold } */
    compress: null,
  };

  const queue = [];
  let abort = null; // 当前这一轮上游请求；重发 / 停止时断开
  // 每次 runTurn / 清空都换一代；被换下的那一轮不能再往服务端写一个字
  let gen = 0;
  let current = null; // 正在跑的那一轮：{ gen, stopped }
  let inflight = null; // 正在跑的那一轮的 Promise，新一轮要等它收尾
  // worker ops 是相对 diff：分帧落盘时必须按到达顺序完整串行，不能并行或跳过。
  // applyGen 在 clear/reset 时递增，丢掉还挂在旧链上的过期批次。
  let applyGen = 0;
  let applyChain = Promise.resolve();
  const enqueueApply = (fn) => {
    const g = applyGen;
    applyChain = applyChain.then(() => (g === applyGen ? fn() : undefined), () => {});
  };
  const dropPendingApplies = () => {
    applyGen++;
    applyChain = Promise.resolve();
    renderer.cancelPendingApply();
  };

  // ── 服务端 ──────────────────────────────────────────────────────────────
  const server = createServer({
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    resolveDataset,
    onPatch: (payload, kind) => {
      state.patchLog.push({ at: performance.now(), kind, size: JSON.stringify(payload).length, payload });
      if (state.patchLog.length > 300) state.patchLog.shift();
      postProgram(kind);
      emit('patch', { payload, kind });
    },
    onDiagnostics: (d) => {
      state.diagnostics = d;
      emit('diagnostics', d);
    },
  });

  // ── 渲染器 ──────────────────────────────────────────────────────────────
  const renderer = createRenderer(stage, {
    resolve: (id) => server.resultFor(id),
    onHost: (kind, payload, node) => (onHost ? onHost(kind, payload, node) : emit('notice', { text: '宿主没有处理 ' + kind })),
    onFnCall: (fn, args) => postWorker({ type: 'call', fn, args }),
    onFormInput: (key, value) => renderer.setFormInput(key, value),
    onAction: (action, ctx) => handleAction(action, ctx),
    onRenderError: (e) => {
      state.renderErrors.push(e);
      emit('error', { kind: 'render', ...e });
    },
    onUnhandled: (node, kind, value) => emit('unhandled', { node, kind, value }),
  });

  // ── 沙箱宿主 ────────────────────────────────────────────────────────────
  function postWorker(msg) {
    if (!state.ready) {
      queue.push(msg);
      return;
    }
    runnerFrame.contentWindow.postMessage(msg, '*');
  }

  async function initRunner() {
    const src = await (await fetch('js/worker-runtime.js')).text();
    window.addEventListener('message', onRunnerMessage);
    runnerFrame.addEventListener('load', () => {
      runnerFrame.contentWindow.postMessage({ type: 'init', source: src }, '*');
    });
    runnerFrame.src = 'runner.html';
  }

  function onRunnerMessage(event) {
    const msg = event.data || {};
    if (msg.type === 'ready') {
      state.ready = true;
      state.lockInfo = msg.locked;
      for (const m of queue.splice(0)) runnerFrame.contentWindow.postMessage(m, '*');
      emit('ready', msg.locked);
      return;
    }
    if (msg.type === 'ops') {
      if (msg.turn != null && msg.turn !== state.turn) return;
      if (msg.payload.bytes.length) state.lastPayload = msg.payload;
      const decoded = decodeOps(msg.payload);
      if (decoded.length) {
        state.opsLog.push(...decoded);
        if (state.opsLog.length > 400) state.opsLog.splice(0, state.opsLog.length - 400);
        state.lastOps = state.opsLog;
      }
      // 小批量同步；大批量分帧，避免一次 CREATE 几百个节点把思考 / 滚动一起卡住
      const finish = () => {
        if (msg.errors && msg.errors.length) {
          state.workerErrors = msg.errors;
          emit('error', { kind: 'runtime', errors: msg.errors });
        }
        emit('ops', { decoded, payload: msg.payload, counts: msg.counts, reason: msg.reason });
      };
      if (decoded.length > 40) {
        enqueueApply(() => renderer.applyOpsAsync(decoded, msg.payload.bytes.length).then(finish, finish));
      } else {
        enqueueApply(() => {
          renderer.applyOps(decoded, msg.payload.bytes.length);
          finish();
        });
      }
      return;
    }
    if (msg.type === 'error') {
      if (msg.turn != null && msg.turn !== state.turn) return;
      state.workerErrors.push(msg);
      emit('error', msg);
      return;
    }
    if (msg.type === 'quarantined') {
      // 新 worker 的节点 id 从 1 重新数，宿主这边的旧节点必须一起清掉，否则会叠出两份界面
      dropPendingApplies();
      renderer.reset();
      emit('quarantined', msg);
      return;
    }
    if (msg.type === 'action') {
      handleAction(msg.action, { value: msg.payload });
    }
  }

  function postProgram(kind) {
    const m = server.message;
    if (!m.code) return;
    postWorker({
      type: 'program',
      turn: state.turn,
      code: m.code,
      constants: m.constants,
      appData: m.appData,
      reason: kind === 'interaction' ? 'interaction' : 'stream',
    });
  }

  // ── 动作：界面 → 外面的世界 ────────────────────────────────────────────
  async function handleAction(action, ctx) {
    const value = ctx && ctx.value;
    if (action === 'issueNewTurn') {
      emit('action', { action, value });
      runTurn(String(value), { direct: true });
      return;
    }
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(String(value));
        emit('notice', { text: '已复制' });
      } catch (e) {
        emit('notice', { text: '复制失败' });
      }
      return;
    }
    if (action === 'openUrl') {
      window.open(String(value), '_blank', 'noopener');
      return;
    }
    if (action === 'openEntityDetail') {
      emit('notice', { text: '宿主动作：打开实体详情 ' + value });
      return;
    }
    if (typeof action === 'string' && action.startsWith('submit:')) {
      const formId = action.slice(7);
      const values = renderer.fieldValues(formId);
      const text = Object.entries(values).map(([k, v]) => `${k}: ${v}`).join('\n');
      emit('action', { action, value: text });
      runTurn(`【表单 ${formId} 提交】\n${text}`, { direct: true });
      return;
    }
    if (typeof action === 'string' && action.startsWith('turn:')) {
      const text = action.slice(5).trim();
      emit('action', { action, value: text });
      runTurn(text, { direct: true });
      return;
    }
    if (typeof action === 'string' && action.startsWith('action:')) {
      emit('action', { action, value: action.slice(7) });
      return;
    }
    emit('notice', { text: '未处理的动作：' + action });
  }

  // ── 上下文压缩 ──────────────────────────────────────────────────────────
  /**
   * 到阈值就把早前的轮次压成要点。返回本次压缩的统计；没压返回 null。
   *
   * 只动 state.history（发给模型的那份），不动磁盘上的轮次 —— 回看历史、
   * 版本树、导出都还是完整的原文。
   *
   * @param {object} [o]
   * @param {boolean} [o.force] 用户手动点了「立即压缩」（不看阈值）
   */
  function compressContext({ force = false } = {}) {
    const s = state.settings;
    const opts = {
      enabled: s.contextCompress !== false,
      threshold: Number(s.compressThreshold) || DEFAULT_COMPRESS.threshold,
      keepTurns: DEFAULT_COMPRESS.keepTurns,
      maxSummaryChars: DEFAULT_COMPRESS.maxSummaryChars,
    };
    if (!force) {
      if (!opts.enabled) return null;
      if (!shouldCompress(state.usage, opts)) return null;
    } else if (!opts.enabled) {
      return null; // 关掉了压缩就什么都不做，手动也不压
    }
    const out = compressHistory(state.history, { ...opts, prevSummary: state.contextSummary });
    if (!out.droppedTurns) return null;
    state.history = out.history;
    state.contextSummary = out.summary;
    state.compress = {
      at: Date.now(),
      droppedTurns: out.droppedTurns,
      savedChars: out.droppedChars,
      total: (state.compress?.total || 0) + out.droppedTurns,
      threshold: opts.threshold,
      forced: !!force,
    };
    emit('compress', { ...state.compress });
    return state.compress;
  }

  // ── 一轮对话 ────────────────────────────────────────────────────────────
  // 同一时刻只跑一轮：新一轮先让旧的停下并等它收尾；排队期间又来了更新的请求，就让给更新的
  async function runTurn(userText, opts = {}) {
    const my = ++gen;
    while (inflight) {
      if (abort) abort.abort();
      await inflight.catch(() => {});
      if (my !== gen) return { failure: '已取消' };
    }
    const turnPromise = doTurn(my, userText, opts);
    inflight = turnPromise;
    try {
      return await turnPromise;
    } finally {
      if (inflight === turnPromise) inflight = null;
    }
  }

  async function doTurn(my, userText, opts) {
    const tok = { gen: my, stopped: false };
    current = tok;
    const superseded = () => tok.gen !== gen;
    const cancelled = () => tok.stopped || superseded();

    state.running = true;
    state.stop = false;
    state.workerErrors = [];
    state.renderErrors = [];
    state.patchLog = [];
    state.opsLog = [];
    state.lastOps = null;
    state.lastPayload = null;
    state.turn++;
    const turnNo = state.turn;

    // 演示回放：页面给定 OpenUI Lang 原文；真实模型：问上游
    const canned = opts.source ? { source: opts.source, bindings: opts.bindings || {} } : resolveCannedTurn ? resolveCannedTurn(userText) : null;

    // 有上一版画布时，模型第一行决定续画（@edit）还是重画（@new）；读到之前画布保持原样。
    // 回放 / 恢复给的是整份原文，一律重画
    const base = !canned && state.canvas && state.canvas.source ? state.canvas.source : null;
    let mode = base ? null : 'new';
    const clearStage = () => {
      postWorker({ type: 'reset', turn: state.turn });
      dropPendingApplies();
      renderer.reset();
      renderer.clearForm();
    };
    server.begin({ modelDataBindings: (canned && canned.bindings) || {} });
    if (!base) clearStage();
    emit('turn-start', { userText, turn: turnNo, canned: !!canned, restore: !!opts.restore, base: !!base });

    const modeFilter = new ModeFilter((m) => {
      if (superseded()) return;
      if (base && m === 'edit') {
        mode = 'edit';
        server.setBase(base);
      } else if (base) {
        mode = 'new';
        clearStage();
      }
      emit('mode', { mode, turn: turnNo });
    });
    // 第一段只是「接住用户的话」，提示词里明说了不要自己写界面代码 —— 所以这一段的
    // 输出一个字节都不进编译器：模型万一还是写了，那几行只当文字，画布不受影响。
    // 回放 / 恢复给的就是整份界面原文，直接放开。第二段画界面时再开（见下）。
    const router = new LineRouter({ allowUi: !!canned });
    let reply = '';
    const take = ({ ui, text }) => {
      if (ui) {
        for (const p of modeFilter.push(ui)) {
          server.append(p);
          emit('delta', { raw: server.raw });
        }
      }
      if (text) {
        reply += text;
        if (reply.trim()) emit('reply', { text: tidyReply(reply), turn: turnNo });
      }
    };
    const feed = (pieces) => {
      for (const piece of pieces) take(router.push(piece));
    };
    // 第一段的回答多半是文字，开头结尾的代码块是回答本身，不能当界面围栏剥掉
    const PASS = { push: (c) => [c], end: () => [] };
    let filter = canned ? new FenceFilter() : PASS;
    router.uiFences = !!canned;
    const onDelta = (chunk) => {
      if (superseded()) return;
      feed(filter.push(chunk));
    };

    let failure = null;
    let drawing = false; // 进了第二段（拉完整规范画界面）
    // 上下文窗口按当前模型估；认不出来就 128k 兜底。
    // 本轮用量（turnUsage）和会话累计（state.usage）分开累加：前者看这一轮花了多少，
    // 后者的 contextTokens 始终是最近一次请求的 promptTokens —— 压缩阈值看它。
    const contextLimit = contextWindowFor(state.settings.model, state.settings.baseURL);
    state.usage = { ...state.usage, contextLimit };
    let turnUsage = emptyUsage(contextLimit);
    try {
      if (canned && opts.restore) {
        // 恢复历史会话：原文一次给全，直接出最终界面
        onDelta(canned.source);
      } else if (canned) {
        await replay(canned.source, onDelta, cancelled);
      } else {
        // 组件里触发的新一轮（按钮 / 表单）不带参数：沿用页面当前选中的技能与数据集
        const activeSkills = (opts.skills || state.skills).filter((id) => SKILL_MAP.has(id));
        const datasets = opts.datasets || state.datasets;
        // opts.content：带图片时是多模态数组（[{type:'text'}, {type:'image_url'}]）
        const userMsg = { role: 'user', content: opts.content || userText };
        let reasoningChars = 0;
        const onReasoning = (chunk) => {
          if (superseded()) return;
          reasoningChars += chunk.length;
          emit('reasoning', { chunk, chars: reasoningChars });
        };
        const onProgress = (p) => !superseded() && emit('progress', p);
        const step = (s) => !superseded() && emit('step', { ...s, turn: turnNo });
        // 整轮共用一个 AbortController：停止时断开上游流式请求和正在跑的联网工具
        abort = new AbortController();
        const ask = async (messages, extra = {}) => {
          emit('progress', { connecting: true });
          const res = await streamChat({ ...state.settings, messages, onDelta, onReasoning, onProgress, signal: abort.signal, ...extra });
          if (res && res.usage) {
            turnUsage = addUsage(turnUsage, res.usage, { contextLimit });
            state.usage = addUsage(state.usage, res.usage, { contextLimit });
            // 每调一次就更新，工具回灌把上下文撑大时界面能立刻看到
            emit('usage', { turn: turnUsage, session: state.usage });
          }
          return res;
        };

        // 跨会话 L2 +（历史够长时）本会话 L1 + 压缩后的早期轮次要点，
        // 一起挂到 chat / draw 两段 system。
        // 顺序有讲究：压缩摘要是**本会话**的事实，放最后，离用户这句话最近。
        const memoryL2 = await loadMemoryBlock({ limit: 12, force: true });
        const memoryL1 = await loadSessionSummary(state.conversationId, state.history.length);
        const compressed = compressContext();
        if (compressed) {
          const saved = Math.round(compressed.savedChars / 3);
          step({
            id: 'compress',
            label: '压缩上下文',
            detail: `早前 ${compressed.droppedTurns} 轮压成要点，约省 ${saved.toLocaleString()} token（阈值 ${Math.round(compressed.threshold * 100)}%）`,
            state: 'done',
          });
        }
        const memory = [memoryL2, memoryL1, state.contextSummary].filter(Boolean).join('\n\n');

        // 第一段：轻量对话 + 工具。用户已经点了技能、或是界面里的按钮发起的，直接画
        let task = null;
        let picked = null; // 这一轮选中的组件名；null = 没查过，退回全量
        let wantLayout = false; // 是否已经通过 get_layout 取过完整排布规则
        let draw = !!opts.direct || activeSkills.length > 0 || state.settings.router === false;
        const viewport = measureViewport(stage);
        const catalog = await loadToolCatalog();
        const tools = chatTools(catalog);
        const online = SEARCH_TOOLS.some((t) => toolOn(catalog, t.function.name));
        const kb = KB_TOOLS.some((t) => toolOn(catalog, t.function.name));
        // 知识库索引：一行一条，模型平时只看到它；要正文再 kb_get
        const kbIndex = kb ? await loadKbIndex({ limit: 40 }) : '';
        let webFacts = ''; // 搜索结果摘要，画界面时一并带上，免得第二段自己编事实
        if (draw) {
          step({ id: 'route', label: activeSkills.length ? `已选技能：${activeSkills.map((id) => SKILL_MAP.get(id).name).join('、')}` : '直接进入界面生成', state: 'done' });
        } else {
          step({ id: 'route', label: '判断怎么回答', state: 'running' });
          let res = null;
          // 工具要回灌，messages 得是可变的
          const routeMsgs = [
            { role: 'system', content: buildChatPrompt({ canvas: base ? { version: state.canvas.version } : null, datasets, online, kb, kbIndex, memory }) },
            ...state.history,
            userMsg,
          ];
          const onToolCall = ({ index, name }) => step({ id: `tool-${index}`, label: TOOL_LABEL[name] || `调用 ${name}`, state: 'running' });
          try {
            res = await ask(routeMsgs, { tools, onToolCall });
          } catch (e) {
            // 上游不认 tools 参数：退回老路，整份规范直接画
            if (cancelled() || !/上游返回 4\d\d/.test(e.message) || reply) throw e;
            step({ id: 'route', label: '这个模型不支持工具调用，直接进入界面生成', state: 'done' });
            draw = true;
          }
          if (res) {
            const ran = await runTools(res, routeMsgs, catalog, { step, ask, cancelled, onToolCall, tools, signal: abort.signal, viewport });
            res = ran.res;
            for (const id of ran.signals.skills) {
              if (!activeSkills.includes(id)) activeSkills.push(id);
            }
            if (ran.signals.task) task = ran.signals.task;
            if (ran.signals.components.length) picked = ran.signals.components;
            wantLayout = ran.signals.layout;
            webFacts = routeMsgs
              .filter((m) => m.role === 'tool' && !ran.componentCallIds.has(m.tool_call_id))
              .map((m) => m.content)
              .join('\n')
              .slice(0, 6000);
            draw = ran.signals.draw || ran.signals.skills.length > 0;
            step({ id: 'route', label: draw ? '需要界面' : '直接回答', state: 'done' });
          }
        }

        // 第二段：拉完整的界面规范去画
        if (draw && !cancelled()) {
          // 选了技能、又没走组件查询：按技能给一套默认组件，不退回全量
          if (!picked && activeSkills.length) {
            picked = [...new Set(activeSkills.flatMap((id) => [...(SKILL_MAP.get(id)?.components || []), ...(SKILL_EXTRA[id] || [])]))];
          }
          feed(filter.end());
          filter = new FenceFilter();
          feed(['\n']);
          router.allowUi = true; // 第二段就是来画界面的，界面语句从这里开始算数
          router.uiFences = true;
          router.inCode = false; // 第一段没收尾的代码块不能吞掉第二段的界面
          // 续画时把画布上已经用到的组件也带上，不然模型不认识要改的东西
          const kept = base ? componentsUsedIn(base) : [];
          if (picked) picked = [...new Set([...picked, ...kept])];
          else if (base && kept.length) picked = kept;
          const budget = canvasBudget(viewport);
          const specOpts = {
            viewport,
            activeSkills,
            usedSkills: base ? skillsUsedIn(base) : [],
            canvas: base ? { source: base, version: state.canvas.version } : null,
            datasets,
            components: picked,
            layout: wantLayout,
          };
          const system =
            buildSystemPrompt(specOpts) +
            (task ? `\n\n## 这一轮要画的\n\n${task}` : '') +
            (webFacts ? `\n\n## 工具查到的（事实以这里为准，别自己编）\n\n${webFacts}` : '') +
            (kbIndex ? `\n\n${kbIndex}` : '') +
            (memory ? `\n\n${memory}` : '');
          if (picked) {
            const list = picked.slice(0, 10).join(' / ') + (picked.length > 10 ? ' …' : '');
            step({ id: 'grp', label: `加载组件：${picked.length} 个`, detail: `${list}${wantLayout ? ' · 已取完整布局' : ' · 简版布局'}`, state: 'done' });
          } else {
            step({ id: 'grp-all', label: '加载组件：全部', detail: `${GROUP_IDS.reduce((n, id) => n + groupSize(id), 0)} 个`, state: 'done' });
          }
          const full = picked ? buildSystemPrompt({ ...specOpts, components: null, layout: false }).length : 0;
          step({
            id: 'spec',
            label: '载入界面规范',
            detail: `${system.length.toLocaleString()} 字${full ? `（全量 ${full.toLocaleString()} 字，省 ${Math.round((1 - system.length / full) * 100)}%）` : ''} · 画幅 ${budget.width}×${budget.height}（${budget.cols} 列 · 首屏约 ${budget.perScreen} 块 · 上限 ${budget.components} 组件）${activeSkills.length ? ` · 技能 ${activeSkills.map((id) => SKILL_MAP.get(id).name).join('、')}` : ''}`,
            state: 'done',
          });
          step({ id: 'draw', label: '绘制界面', state: 'running' });
          emit('stage', { stage: 'draw', turn: turnNo });
          layoutSignal('openui:turn-start');
          drawing = true;
          await ask([{ role: 'system', content: system }, ...state.history, userMsg]);
        }
      }
      if (cancelled()) failure = '已取消';
    } catch (e) {
      if (cancelled()) {
        failure = '已取消';
      } else {
        failure = e.message || String(e);
        emit('error', { kind: 'upstream', message: failure });
      }
    }

    // 被新一轮或清空换下：服务端已经归别人了，只把这一轮在页面上收个尾
    if (!superseded()) {
      feed(filter.end());
      take(router.flush());
      reply = tidyReply(reply);
      // 只有文字、没写界面：按「续画了一个空补丁」收尾，画布原样留着
      if (reply && !router.uiSeen && base) {
        mode = 'edit';
        server.setBase(base);
      } else for (const p of modeFilter.flush()) server.append(p);
      emit('delta', { raw: server.raw });
      server.finish();
      if (drawing) {
        const st = server.message.stats || {};
        emit('step', { id: 'draw', label: '绘制界面', detail: failure ? failure === '已取消' ? '已取消' : '没有完成' : `${st.elements ?? 0} 个组件 · ${st.definitions ?? 0} 个变量`, state: 'done', turn: turnNo });
      }
      // 续画却一个字没写（或停在指令行）：画布就是上一版
      if (mode == null) mode = base ? 'edit' : 'new';
      const nothing = !server.raw.trim();
      // 界面语句写了，但一个组件都没编译出来：这一轮不算数。
      // 不拿它当新的画布基线 —— 否则那几行会顶掉上一版原文，之后每一轮都在坏基线上
      // 续画，再也回不去。画布上的诊断照留：那是「这一轮没画成」的诚实反馈。
      const barren = !nothing && !((server.message.stats || {}).elements > 0);
      if (!(failure && nothing) && !barren) {
        state.canvas = { source: server.source, version: (state.canvas && state.canvas.version) || 0 };
      }
      // 原文已在系统提示里的「当前画布」，历史里只留一句话；文字回答整段留下
      if (!failure && !opts.restore) {
        state.history.push({ role: 'user', content: userText });
        // 没画成的那一轮不能跟模型说「已重新绘制画布」—— 画布其实没动，
        // 说错了它下一轮就拿着不存在的前提续画。
        const told = router.uiSeen && !barren ? describeTurn(server.message, mode) : '';
        const said = [reply, told].filter(Boolean).join('\n');
        state.history.push({ role: 'assistant', content: said || (barren ? '（界面没生成成功，画布保持原样）' : describeTurn(server.message, mode)) });
        // 上限放宽到 12 轮：留出被压缩的余量。压缩会把它削回最近 keepTurns 轮，
        // 所以平时是「涨到 12 轮 → 压到 4 轮」的锯齿，不是一路涨。
        if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
      }
    }
    if (current === tok) {
      current = null;
      state.running = false;
    }
    const usage = turnUsage.calls
      ? { ...turnUsage, contextUsage: contextRatio(turnUsage) }
      : null;
    emit('turn-end', { failure, message: server.message, turn: turnNo, restore: !!opts.restore, mode, source: server.source, reply: reply || null, usage });
    layoutSignal('openui:turn-end');
    return { failure, mode, source: server.source, reply: reply || null, usage };
  }

  function replay(text, onDelta, cancelled) {
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (cancelled()) return resolve(false);
        if (i >= text.length) return resolve(true);
        const size = 2 + Math.floor(Math.random() * 6);
        onDelta(text.slice(i, i + size));
        i += size;
        setTimeout(step, 6 + Math.random() * 16);
      };
      step();
    });
  }

  /** 停下当前这一轮：已经写出来的部分照常收尾编译 */
  function stop() {
    if (current) current.stopped = true;
    state.stop = true;
    if (abort) abort.abort();
  }

  /** 清空对话：在途的那一轮作废，轮次号继续往上数，迟到的旧消息都对不上号 */
  function resetConversation() {
    gen++;
    if (current) current.stopped = true;
    if (abort) abort.abort();
    server.reset();
    state.history = [];
    state.conversationId = null;
    state.canvas = null;
    state.turn++;
    state.opsLog = [];
    state.patchLog = [];
    state.lastOps = null;
    state.lastPayload = null;
    state.workerErrors = [];
    state.renderErrors = [];
    state.usage = emptyUsage(contextWindowFor(state.settings.model, state.settings.baseURL));
    state.contextSummary = '';
    state.compress = null;
    dropPendingApplies();
    renderer.reset();
    renderer.clearForm();
    postWorker({ type: 'reset', turn: state.turn });
    emit('usage', { session: state.usage });
  }

  return {
    state,
    server,
    renderer,
    on,
    initRunner,
    runTurn,
    stop,
    resetConversation,
    /** 切换版本 / 打开会话后由页面设置：画布当前是哪一版、上下文是哪条路径 */
    setHead({ canvas = null, history = [], conversationId } = {}) {
      const switched = conversationId !== undefined && (conversationId || null) !== state.conversationId;
      state.canvas = canvas;
      state.history = history.slice();
      if (conversationId !== undefined) state.conversationId = conversationId || null;
      // 换了会话：上一段的压缩摘要不能跟过来，否则模型会拿着别人的前情提要继续画
      if (switched) {
        state.contextSummary = '';
        state.compress = null;
      }
    },
    /**
     * 手动压缩（设置页的「立即压缩」）：不看阈值，直接压。
     * 返回 null 表示历史还不够长，没什么可压的。
     */
    compressNow() {
      return compressContext({ force: true });
    },
    setSettings(next) {
      Object.assign(state.settings, next);
      saveSettings(state.settings);
      emit('settings', state.settings);
    },
    /**
     * 把某个模型配置设为运行时用的那一个（传 null = 没有可用的模型）。
     * 配置本身存在服务端，这里只把要用到的字段摊进 settings，
     * 后面 streamChat / 状态行 / 输入框守卫都读同一份。
     */
    applyModel(config) {
      Object.assign(state.settings, {
        modelId: config ? config.id : null,
        modelName: config ? config.name : '',
        baseURL: config ? config.baseURL : DEFAULT_SETTINGS.baseURL,
        apiKey: config ? config.apiKey : '',
        model: config ? config.model : DEFAULT_SETTINGS.model,
        temperature: config ? config.temperature : DEFAULT_SETTINGS.temperature,
        thinking: config ? !!config.thinking : DEFAULT_SETTINGS.thinking,
      });
      // 换模型 = 换上下文窗口：只改上限，不清已累计的用量
      state.usage = { ...state.usage, contextLimit: contextWindowFor(state.settings.model, state.settings.baseURL) };
      saveSettings(state.settings);
      emit('settings', state.settings);
      emit('usage', { session: state.usage });
    },
    /**
     * 打开历史会话时用服务端的逐轮计量回填。turns 来自 /conversations/:id/metrics，
     * 每条至少要有 promptTokens / completionTokens（缺缓存字段就按没报处理）。
     */
    setUsageFromTurns(turns = []) {
      const contextLimit = contextWindowFor(state.settings.model, state.settings.baseURL);
      let acc = emptyUsage(contextLimit);
      for (const t of turns) acc = addUsage(acc, t, { contextLimit });
      state.usage = acc;
      emit('usage', { session: state.usage });
    },
    /** 供检视器读取的一次性快照 */
    snapshot() {
      return {
        raw: server.message.raw,
        source: server.message.source,
        code: server.message.code,
        constants: server.message.constants,
        appData: server.message.appData,
        fallbackMarkdown: server.message.fallbackMarkdown,
        diagnostics: server.message.diagnostics,
        recovery: server.message.recoveryDiagnostics,
        notes: server.message.recoveryNotes,
        partial: server.message.partial,
        summary: server.message.summary,
        stats: server.message.stats,
        serverStats: server.stats,
        rendererStats: renderer.stats,
        nodeCount: renderer.nodeCount(),
        lockInfo: state.lockInfo,
        workerErrors: state.workerErrors,
        renderErrors: state.renderErrors,
        opsLog: state.opsLog,
        lastPayload: state.lastPayload,
        patchLog: state.patchLog,
        running: state.running,
      };
    },
  };
}
