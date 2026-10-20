// ─────────────────────────────────────────────────────────────────────────────
// 聊天页：左边是 OpenUI Lang 渲染出的实时界面（白卡画布 + 检视器），
// 右边是会话总结 —— 每轮回答的 summary = [Note(...)] 编成总结条目，
// 条目上的引用点一下，左边对应变量的组件就会定位并闪一下。
// ─────────────────────────────────────────────────────────────────────────────

import { createSession, describeTurn, HISTORY_MAX_TURNS } from './session.js';
import { createInspector } from './inspector.js';
import { createShell, copy } from './shell.js';
import { createSettingsPage } from './settings-page.js';
import { createThinking } from './thinking.js';
import { createConversationStore, newConversationId } from './conversations.js';
import { createModelStore } from './models.js';
import { createComposerMenu } from './composer-menu.js';
import { createAttachments, splitFileBlocks } from './attachments.js';
import { createModelPicker } from './model-picker.js';
import { createAccountMenu } from './account-menu.js';
import { announcePopover, closeOnOtherPopover } from './popovers.js';
import { createThinkSlider } from './think-slider.js';
import { vt } from './motion.js';
import { DEMOS, FOLLOWUP } from '@openui-lab/fixtures';
import { SKILLS, COMPONENTS, evaluateSheet, toCell } from '@openui-lab/catalog';
import { mergeSource } from '@openui-lab/ui-dsl';
import { cacheRate, contextRatio, formatTokens, formatPercent } from './usage.js';
import { compile } from '@openui-lab/compiler/compile.js';
import { turnToMarkdown } from './turn-markdown.js';
import { authHeaders } from './accounts.js';

const MD = COMPONENTS.find((d) => d.name === 'MarkDownRenderer').render;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const EXAMPLES = [
  '做一个团队版的费用估算，能拖动席位数看月费',
  '给我一个灰度上线的计划，按时间线展示',
  '做一个产品分析仪表盘，包含用量、获客和收入',
];

const ICON = {  spark: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>',
  rewind: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
};

const store = createConversationStore();
const modelStore = createModelStore();

// 没配模型时：界面里的 turn: 按钮 / 表单提交用预置的下一轮回答演示
const session = createSession({
  stage: $('#stage'),
  runnerFrame: $('#runner'),
  resolveCannedTurn: () => (session.state.settings.modelId ? null : { source: FOLLOWUP.source }),
  resolveDataset: async (datasetId) => {
    const r = await store.readDataset(datasetId, refsNow()[datasetId]);
    return { version: r.version.id, name: r.dataset.name, data: r.data };
  },
  onHost: (kind, payload) => onSheetHost(kind, payload),
});
const inspector = createInspector({ session });
const shellUi = createShell({ session, inspector, toast });
// 顶栏账号菜单：改名字 / 切换 / 添加 / 退出（登录页是独立路由，见 login.html）
createAccountMenu({ toast });

let live = null; // 正在流式的这一轮
let lastTurnRecord = null; // 当前会话最近发起的一轮（写库完成前也可复制）
let nextOpts = null; // 下一次 turn-start 对应的 runTurn 参数（重新生成要用）
let conv = null; // 当前会话（服务端的整棵树）；还没发第一句时为 null
let restoringTurn = 0; // 正在还原画布的那一轮的轮次号

// ── 版本：画布停在哪一轮（HEAD），数据集用哪一版 ─────────────────────────
let headRefs = {}; // HEAD 那一轮引用的数据集版本
let pendingRefs = {}; // 还没随某一轮存下的引用（刚导入的文件）
const refsNow = () => ({ ...headRefs, ...pendingRefs });
const records = new Map(); // 轮次 id → 聊天区的卡片；切换版本时复用，流式时的思考过程不丢
let rootFork = false; // 重新生成第一轮：新一轮不接在 HEAD 后面，另起一支
const turnById = (id) => (conv && conv.turns ? conv.turns.find((t) => t.id === id) : null);

// ── 附件：传图 / 传文件（选择 · 拖到输入框 · 粘贴，逻辑见 src/attachments.js） ──
const attach = createAttachments({
  box: $('#attach-chips'),
  zone: $('#composer'),
  prompt: $('#prompt'),
  onNotice: toast,
  // 表格（xlsx / xls / csv）不塞进消息正文，导入成数据集，原文里只留引用
  importSheet: async (file) => {
    const out = await store.importDataset(file, conv && conv.turns ? conv.id : null);
    pendingRefs = { ...pendingRefs, [out.dataset.id]: out.version.id };
    menu.set(['sheet']);
    toast(`已导入「${out.dataset.name}」· ${out.data.sheets.length} 张表`);
    if (!$('#prompt').value.trim()) fillPrompt(`把「${out.dataset.name}」放进可编辑的表格，并给出关键结论`);
    return { datasetId: out.dataset.id, versionId: out.version.id, name: out.dataset.name, sheets: out.data.sheets.length };
  },
  // 文档（pdf / docx / pptx / odt / ods / odp）：交给服务端抽正文，只读不落盘
  extractDoc: async (file, buf) => {
    const r = await fetch(`/api/files/extract?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
      body: buf,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (!String(j.text || '').trim()) throw new Error('没抽出正文（多半是扫描件：只有图片，没有文字层）');
    return j;
  },
  // 用户把表格 chip 摘了：对应的数据集引用一起撤掉，别偷偷跟着发出去
  onRemove: (item) => {
    if (item && item.datasetId) delete pendingRefs[item.datasetId];
  },
  // 附件上的「存」：把这份文件交给模型，走 kb_lookup 查重 → 未命中 kb_put 的入库流程。
  // 表格走的是数据集，正文在服务端，模型只能从提示词里的表头与前几行蒸馏，所以单独一句。
  onStore: (item) => {
    const prompt = $('#prompt');
    prompt.value =
      item.kind === 'sheet' && item.datasetId
        ? `把数据集「${item.name}」（${item.datasetId}）沉淀成一条知识条目：先 kb_lookup 查重（标题用数据集名），命中就直接用已有条目；未命中再 kb_put，body 按「何时用 / 要点 / 步骤 / 边界」写清这张表是什么、有哪些字段、怎么用，不要贴原文`
        : `把「${item.name}」存入知识库：先 kb_lookup 查重（${item.sha256 ? `文件 sha256 是 ${item.sha256}，` : ''}标题用文件名），命中就直接用已有条目；未命中再 kb_put 蒸馏成 AOCI 条目（何时用 / 要点 / 步骤 / 边界），不要贴原文`;
    prompt.focus();
    prompt.dispatchEvent(new Event('input'));
    $('#composer').requestSubmit();
  },
});

// ── 设置页 ─────────────────────────────────────────────────────────────────
const settings = createSettingsPage({
  session,
  toast,
  models: modelStore,
  onChange: () => renderEmpty(),
  onModelsChange: () => syncModels(),
  history: {
    count: async () => (await store.list()).length,
    /** 本地历史占用：会话数 / 轮次 / 字节；拿不到返回 null，设置页退回只显示条数 */
    stats: async () => store.stats(),
    clear: async () => {
      await saving;
      await store.clear();
      newConversation();
    },
  },
});
$('#empty-settings').addEventListener('click', () => settings.open(true, 'model'));

// ── 模型：输入框右下角的切换器 ─────────────────────────────────────────────
const picker = createModelPicker({
  button: $('#model-btn'),
  label: $('#model-btn-label'),
  menu: $('#model-menu'),
  store: modelStore,
  onPick: async (m) => {
    try {
      await modelStore.activate(m.id);
      await syncModels();
      toast(`已切到「${m.name}」· ${m.model}`);
    } catch (e) {
      toast('切换失败：' + e.message);
    }
  },
  onManage: () => settings.open(true, 'model'),
});

/** 列表变了（设置页改过 / 输入框里切过）→ 把当前那个摊进 session，再刷新按钮 */
async function syncModels() {
  const snap = modelStore.snapshot();
  const active = snap.active && snap.active.enabled ? snap.active : snap.models.find((m) => m.enabled) || null;
  session.applyModel(active);
  picker.refresh();
  settings.renderStatusLine();
  paintThink();
  paintUsage();
  renderEmpty();
}

$('#chat-clear').addEventListener('click', () => newConversation());

/** 换场：停掉在途的一轮，清掉右侧卡片和左侧画布 */
function clearChat() {
  session.resetConversation();
  $('#messages').querySelectorAll('.turn, .head-divider').forEach((n) => n.remove());
  records.clear();
  live = null;
  lastTurnRecord = null;
  restoringTurn = 0;
  rootFork = false;
  headRefs = {};
  pendingRefs = {};
  attach.clear();
  renderEmpty();
  resetCanvas();
  updateVersionNav();
  inspector.refresh();
}

function newConversation() {
  openSeq++;
  clearChat();
  conv = null;
  store.setActive(null);
  menu.set([], { silent: true });
  setTitle('新会话');
  showHistory(false);
  renderHistory();
}

// ── 历史会话 ───────────────────────────────────────────────────────────────
const timeFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function showHistory(open) {
  // 消息区与历史列表互换，走 View Transition：消息淡出、面板淡入上移
  vt(() => {
    $('.chat-pane').classList.toggle('show-history', open);
    $('#history-panel').hidden = !open;
    $('#chat-history').classList.toggle('active', open);
    $('#chat-history').setAttribute('aria-expanded', String(open));
    if (open) renderHistory();
  });
}

$('#chat-history').addEventListener('click', () => showHistory($('#history-panel').hidden));
$('#history-new').addEventListener('click', () => newConversation());

let historySeq = 0;

async function renderHistory() {
  const box = $('#history-list');
  const seq = ++historySeq;
  let list;
  try {
    list = await store.list();
  } catch (e) {
    if (seq !== historySeq) return;
    $('#history-count').textContent = '';
    box.textContent = '';
    box.appendChild(el('div', 'history-empty', `历史会话读不出来：${e.message}`));
    return;
  }
  if (seq !== historySeq) return;
  $('#history-count').textContent = list.length ? `${list.length} 个` : '';
  box.textContent = '';
  if (!list.length) {
    box.appendChild(el('div', 'history-empty', '还没有历史会话，发一句话就会出现在这里'));
    return;
  }
  for (const c of list) {
    const item = el('div', 'history-item');
    if (conv && c.id === conv.id) item.classList.add('active');
    const open = el('button', 'history-open');
    open.type = 'button';
    open.appendChild(el('b', null, c.title || '未命名会话'));
    open.appendChild(el('span', null, `${c.turnCount} 轮 · ${timeFmt.format(c.updatedAt)}`));
    open.addEventListener('click', () => openConversation(c.id));
    const del = el('button', 'icon-btn small');
    del.type = 'button';
    del.title = '删除这个会话';
    del.setAttribute('aria-label', '删除这个会话');
    del.innerHTML = ICON.trash;
    del.addEventListener('click', async () => {
      try {
        await store.remove(c.id);
      } catch (e) {
        toast('删除失败：' + e.message);
        return;
      }
      if (conv && conv.id === c.id) {
        newConversation();
        showHistory(true);
      } else renderHistory();
      toast('已删除');
    });
    item.appendChild(open);
    item.appendChild(del);
    box.appendChild(item);
  }
}

/** 离线例子的回放参数要存下来，重新生成才回放得出来；真实模型那轮不用存 */
function storableOpts(opts) {
  return opts && opts.source ? { source: opts.source, bindings: opts.bindings || {} } : null;
}

// 写库排队：同一会话的轮次必须按发生顺序落库，seq 才对得上
let saving = Promise.resolve();

/** 模型这一轮写完：原文（续画时是补丁）+ 合并后的画布快照，接在 HEAD 后面存成新的一版 */
function saveTurn(record, failure, mode, usage) {
  const opts = storableOpts(record.opts);
  const raw = session.server.raw;
  const snapshot = session.snapshot();
  record.source = session.server.source || snapshot.source || '';
  record.fallbackMarkdown = snapshot.fallbackMarkdown || '';
  record.failure = failure || '';
  commit(
    {
      user: record.userText,
      raw,
      // 一个字没写出来：快照沿用父节点（服务端处理）；文字回答时画布就是上一版
      snapshot: raw.trim() || record.reply ? session.server.source : undefined,
      summary: (() => {
        // 按 DOM 时间线顺序落库，重开会话时仍能按执行顺序回放
        const out = [];
        for (const node of record.flow.children) {
          if (node.classList.contains('reply-text')) {
            const text = node.textContent || '';
            if (text.trim()) out.push({ kind: 'reply', title: '回答', text, refs: [] });
          } else if (node.classList.contains('turn-step')) {
            const label = node.querySelector('.turn-step-label')?.textContent || '';
            const detail = node.querySelector('.turn-step-detail')?.textContent || '';
            if (label) out.push({ kind: 'step', title: label, text: detail, refs: [] });
          } else if (node.classList.contains('sum-list')) {
            for (const item of node.querySelectorAll('.sum-item')) {
              out.push({
                title: item.querySelector('h4')?.textContent || '',
                text: item.querySelector('p')?.textContent || '',
                refs: [...item.querySelectorAll('code')].map((c) => c.textContent).filter(Boolean),
              });
            }
          }
        }
        if (!out.length && record.summary?.length) return record.summary;
        return out;
      })(),
      failure: failure || null,
      opts,
      model: opts ? null : session.state.settings.model,
      mode: mode || 'new',
      skills: menu.get(),
      metrics: usage || null,
    },
    record,
  );
}

/** 用户直接在画布上改（表格编辑 / 导入）：也是一版，可以回退 */
function commitUserTurn({ text, snapshot, refs = {}, recompile = false, note = '画布上的改动已存为一个版本，可以回退' }) {
  session.state.canvas = { source: snapshot, version: (session.state.canvas && session.state.canvas.version) || 0 };
  pendingRefs = { ...pendingRefs, ...refs };
  commit(
    { user: text, raw: '', snapshot, summary: [{ title: '手动编辑', text: note, refs: [] }], failure: null, opts: null, model: null, mode: 'user', skills: menu.get() },
    null,
    { recompile },
  );
}

// 写库排队：同一会话的轮次必须按发生顺序落库，父节点取的是上一轮存下后的 HEAD
function commit(turn, record, { recompile = false } = {}) {
  if (!conv) conv = { id: newConversationId() };
  const id = conv.id;
  session.state.conversationId = id;
  const fork = rootFork;
  rootFork = false;
  const refs = refsNow();
  headRefs = refs;
  pendingRefs = {};
  attach.clear();
  store.setActive(id);
  saving = saving
    .then(async () => {
      const first = !conv || !conv.turns;
      const parentId = fork ? null : conv && conv.id === id && conv.headTurnId ? conv.headTurnId : undefined;
      const out = await store.appendTurn(id, { ...turn, refs, parentId });
      if (record) {
        record.turnId = out.turnId;
        records.set(out.turnId, record);
      }
      if (!conv || conv.id !== id) return; // 存的时候已经换到别的会话了
      if (first) await store.setSkills(id, menu.get()).catch(() => {});
      const saved = await store.get(id);
      if (saved && conv && conv.id === id) applyConversation(saved, { recompile });
    })
    .then(
      () => !$('#history-panel').hidden && renderHistory(),
      (e) => toast('这一轮没存上：' + e.message),
    );
}

let openSeq = 0;

/** 打开一个历史会话：卡片按存档还原，画布直接编译 HEAD 那一版的快照，不调模型 */
async function openConversation(id, { quiet = false } = {}) {
  const seq = ++openSeq;
  let saved;
  let skills = [];
  try {
    await saving;
    saved = await store.get(id);
    if (saved) skills = await store.skills(id).catch(() => []);
  } catch (e) {
    if (seq === openSeq && !quiet) toast('会话读不出来：' + e.message);
    return;
  }
  if (seq !== openSeq) return;
  if (!saved) {
    if (store.activeId() === id) store.setActive(null);
    if (!quiet) toast('这个会话已经不在了');
    renderHistory();
    return;
  }
  clearChat();
  conv = saved;
  store.setActive(saved.id);
  setTitle(saved.title || '未命名会话');
  menu.set(skills, { silent: true });
  showHistory(false);
  applyConversation(saved, { recompile: true });
  // 历史会话的 token 用量从服务端逐轮计量回填（老服务端没这个接口就保持空）
  store.metrics(saved.id).then((m) => {
    if (seq !== openSeq) return;
    if (m && Array.isArray(m.turns)) session.setUsageFromTurns(m.turns);
  }).catch(() => {});
  scrollDown();
}

/**
 * 服务端的会话 → 页面：聊天区显示 chain（HEAD 之后的置灰），模型上下文取 path，
 * recompile 时把 HEAD 那一版的快照重新编译到画布上
 */
function applyConversation(saved, { recompile = false } = {}) {
  conv = saved;
  const head = turnById(saved.headTurnId);
  headRefs = head ? { ...head.refs } : {};
  renderChain();
  updateVersionNav();
  session.setHead({
    canvas: head ? { source: head.snapshot, version: head.depth } : null,
    history: historyFrom(saved),
    conversationId: saved.id,
  });
  session.state.skills = menu.get();
  if (!recompile) return;
  if (head && head.snapshot.trim()) {
    session.runTurn(head.userText, { source: head.snapshot, bindings: (head.replay && head.replay.bindings) || {}, restore: true });
  } else {
    session.resetConversation();
    session.setHead({ canvas: null, history: historyFrom(saved), conversationId: saved.id });
    resetCanvas();
  }
}

/** 第一轮 → HEAD 路径上完成的轮次 → 模型上下文。画布原文整份在系统提示里，这里每轮只留一句 */
function historyFrom(saved) {
  return saved.path
    .map((id) => turnById(id))
    .filter((t) => t && t.state === 'complete' && (t.raw || t.mode === 'user' || replyOf(t)))
    .slice(-HISTORY_MAX_TURNS)
    .flatMap((t) => [
      { role: 'user', content: t.userText },
      {
        role: 'assistant',
        content:
          t.mode === 'user'
            ? '（已记下这次手动编辑，画布已更新）'
            : [replyOf(t), t.raw ? describeTurn({ summary: (t.summary || []).filter((s) => !s.kind) }, t.mode) : ''].filter(Boolean).join('\n'),
      },
    ]);
}

/**
 * 模型写在界面之外的文字。
 * summary 按时间线落库：前面常是 step（「判断怎么回答」），reply 不一定在 [0]。
 * 以前只读第一条 → 纯文字轮次被 historyFrom 过滤掉，下一轮请求就丢了上文。
 */
function replyOf(t) {
  const summary = Array.isArray(t?.summary) ? t.summary : [];
  const replies = summary.filter((s) => s && s.kind === 'reply' && String(s.text || '').trim());
  if (replies.length) return replies.map((s) => s.text).join('\n');
  // 兼容老存档：没有 kind 的第一项曾经就是回答正文
  const first = summary[0];
  if (first && !first.kind && String(first.text || '').trim()) return first.text;
  return '';
}

/** 只有文字、没写界面的那一轮 */
const textOnly = (t) => t.mode !== 'user' && !!replyOf(t) && !t.raw;

/** 用完整画布快照编译出可读 Markdown；续画的 raw 只是补丁，不能单独导出。 */
function markdownForRecord(record, snapshot = null) {
  const source = record?.source || record?.snapshot || snapshot?.source || '';
  let fallbackMarkdown = record?.fallbackMarkdown || snapshot?.fallbackMarkdown || '';
  if (source) {
    try {
      fallbackMarkdown = compile(source, { final: true }).fallbackMarkdown || fallbackMarkdown;
    } catch (e) {
      // 即使旧画布无法重新编译，也保留已有 Markdown 与完整源码。
    }
  }
  return turnToMarkdown({
    userText: record?.userText || '',
    reply: record?.reply || '',
    summary: record?.summary || [],
    source,
    fallbackMarkdown,
    failure: record?.failure || '',
  });
}

function latestTurnRecord() {
  if (live) return live;
  if (lastTurnRecord && (!lastTurnRecord.turnId || !turnById(lastTurnRecord.turnId))) return lastTurnRecord;
  const turn = conv && turnById(conv.headTurnId);
  if (!turn) return null;
  let record = records.get(turn.id);
  if (!record) {
    record = storedRecord(turn);
    records.set(turn.id, record);
  }
  return record;
}

/** 按 chain 重排聊天区：卡片复用，HEAD 之后的置灰并插一条提示 */
function renderChain() {
  const box = $('#messages');
  box.querySelectorAll('.turn, .head-divider').forEach((n) => n.remove());
  if (!conv || !conv.chain) return;
  const headAt = conv.chain.indexOf(conv.headTurnId);
  conv.chain.forEach((id, i) => {
    const t = turnById(id);
    if (!t) return;
    let rec = records.get(id);
    if (!rec) {
      rec = storedRecord(t);
      records.set(id, rec);
    }
    rec.turnId = id;
    decorate(rec, t, i > headAt, id === conv.headTurnId);
    box.appendChild(rec.turn);
    if (i === headAt && i < conv.chain.length - 1) box.appendChild(headDivider(t));
  });
  if (live && live.turn.isConnected === false) box.appendChild(live.turn);
  renderEmpty();
}

/** 存档里的一轮 → 卡片 */
function storedRecord(t) {
  const record = addTurn(t.userText, t.replay || {}, { append: false, manual: t.mode === 'user' });
  record.tools.classList.remove('hidden');
  record.pre.textContent = t.raw || '';
  record.rawHead.textContent = t.mode === 'user' ? '画布快照' : `界面原文${t.mode === 'edit' ? '（续画补丁）' : ''} · ${(t.raw || '').split('\n').length} 行`;
  if (t.mode === 'user') record.pre.textContent = t.snapshot;
  record.source = t.snapshot || '';
  record.failure = t.failure || '';
  if (t.failure) {
    record.status.textContent = t.failure === '已取消' ? '已取消' : '失败';
    if (t.failure !== '已取消') record.status.classList.add('bad');
  } else record.status.textContent = t.mode === 'user' ? '手动编辑' : textOnly(t) ? '直接回答' : '历史记录';
  record.reply = replyOf(t);
  if (textOnly(t)) record.rawHead.parentElement.hidden = true;
  const summary = t.summary || [];
  const timed = summary.some((s) => s.kind === 'step' || s.kind === 'reply');
  let stepI = 0;
  if (timed) {
    for (const s of summary) {
      if (s.kind === 'step') renderStep(record, { id: `s${stepI++}`, label: s.title, detail: s.text || '' });
      else if (s.kind === 'reply' && s.text) {
        sealReply(record);
        const box = MD.create({ markdown: s.text, variant: 'clear' });
        box.classList.add('reply-text');
        record.flow.appendChild(box);
      }
    }
    record.reply = replyOf(t) || record.reply;
  } else {
    if (record.reply) {
      renderReply(record, record.reply, { pending: false });
      sealReply(record);
    }
    summary.forEach((s, i) => s.kind === 'step' && renderStep(record, { id: `s${i}`, label: s.title, detail: s.text }));
  }
  const items = summary.filter((s) => !s.kind);
  renderSummary(record, items.length || record.reply ? items : [{ title: t.failure ? '这一轮没有完成' : '界面已生成', text: t.failure || '', refs: [] }]);
  return record;
}

const MODE_LABEL = { new: '重画', edit: '续画', user: '手动' };

/** 版本号、分支切换、「回到此版本」 */
function decorate(rec, t, after, isHead) {
  rec.turn.classList.toggle('after-head', after);
  rec.turn.classList.toggle('is-head', isHead);
  rec.version.textContent = `v${t.depth} · ${textOnly(t) ? '回答' : MODE_LABEL[t.mode] || '重画'}`;
  rec.version.title = isHead ? '画布当前停在这一版' : `第 ${t.depth} 版`;
  rec.version.classList.toggle('current', isHead);
  rec.checkout.hidden = isHead;
  rec.checkout.onclick = () => moveHead('checkout', t.id);
  rec.redo.onclick = () => regenerate(t);
  const sibs = t.siblings || [t.id];
  rec.branch.textContent = '';
  rec.branch.classList.toggle('hidden', sibs.length < 2);
  if (sibs.length > 1) {
    const at = sibs.indexOf(t.id);
    const prev = el('button', 'branch-btn', '‹');
    prev.type = 'button';
    prev.title = '上一个分支';
    prev.disabled = at <= 0;
    prev.addEventListener('click', () => moveHead('switch', sibs[at - 1]));
    const next = el('button', 'branch-btn', '›');
    next.type = 'button';
    next.title = '下一个分支';
    next.disabled = at >= sibs.length - 1;
    next.addEventListener('click', () => moveHead('switch', sibs[at + 1]));
    rec.branch.append(prev, el('span', null, `${at + 1}/${sibs.length}`), next);
  }
}

function headDivider(t) {
  const d = el('div', 'head-divider');
  d.appendChild(el('span', null, `已回退到 v${t.depth}，发送新消息将创建分支`));
  const b = el('button', 'link-btn', '回到最新');
  b.type = 'button';
  b.addEventListener('click', () => moveHead('checkout', conv.chain[conv.chain.length - 1]));
  d.appendChild(b);
  return d;
}

/** 移动 HEAD：画布、上下文、数据版本一起切过去 */
async function moveHead(op, turnId) {
  if (!conv || !conv.turns) return;
  if (session.state.running) return toast('正在生成，等这一轮结束再切换版本');
  closeVersionMenu();
  try {
    await saving;
    const saved = await store.moveHead(conv.id, op, turnId);
    pendingRefs = {};
    attach.syncRefs(pendingRefs);
    applyConversation(saved, { recompile: true });
    const head = turnById(saved.headTurnId);
    if (head && head.skills && head.skills.length) menu.set(head.skills, { silent: true });
  } catch (e) {
    toast(e.message);
  }
}

/** 重新生成某一轮：回到它的上一版再问一次，结果长成兄弟分支 */
async function regenerate(t) {
  if (session.state.running) return toast('正在生成，等这一轮结束');
  const opts = t.replay && t.replay.source ? { source: t.replay.source, bindings: t.replay.bindings || {} } : {};
  if (t.parentId) {
    await moveHead('checkout', t.parentId);
  } else {
    await saving;
    session.resetConversation();
    headRefs = {};
    rootFork = true;
  }
  startTurn(t.userText, opts);
}

// ── 画布版本条：‹ vN/M › ───────────────────────────────────────────────────
function updateVersionNav() {
  const nav = $('#version-nav');
  const head = conv && turnById(conv.headTurnId);
  if (!head) {
    nav.classList.add('hidden');
    return;
  }
  const tip = turnById(conv.chain[conv.chain.length - 1]) || head;
  nav.classList.remove('hidden');
  $('#version-label').textContent = `v${head.depth}/${tip.depth}`;
  const busy = session.state.running;
  $('#version-back').disabled = busy || !head.parentId;
  $('#version-forward').disabled = busy || !head.activeChildId;
  $('#version-label').disabled = busy;
}

function closeVersionMenu() {
  $('#version-menu').classList.add('hidden');
  $('#version-label').setAttribute('aria-expanded', 'false');
}

$('#version-back').addEventListener('click', () => moveHead('back'));
$('#version-forward').addEventListener('click', () => moveHead('forward'));
$('#version-label').addEventListener('click', (e) => {
  e.stopPropagation();
  const box = $('#version-menu');
  if (!box.classList.contains('hidden')) return closeVersionMenu();
  box.textContent = '';
  for (const id of [...conv.chain].reverse()) {
    const t = turnById(id);
    const b = el('button', 'version-item' + (id === conv.headTurnId ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.appendChild(el('b', null, `v${t.depth}`));
    b.appendChild(el('span', null, previewText(t.userText)));
    b.appendChild(el('small', null, MODE_LABEL[t.mode] || ''));
    b.addEventListener('click', () => moveHead('checkout', id));
    box.appendChild(b);
  }
  box.classList.remove('hidden');
  $('#version-label').setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', (e) => {
  if (!$('#version-nav').contains(e.target)) closeVersionMenu();
});
// ⌘[ / ⌘]：在输入框外切换画布版本
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || (e.key !== '[' && e.key !== ']')) return;
  const t = e.target;
  if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)) return;
  if (!conv || !conv.turns) return;
  e.preventDefault();
  moveHead(e.key === '[' ? 'back' : 'forward');
});

// 复制当前这一轮：页面可读内容 + 右侧描述 / 要点 + 完整 OpenUI Lang 源码
$('#chat-copy').addEventListener('click', async () => {
  const record = latestTurnRecord();
  if (!record) return toast('还没有可复制的轮次');
  const text = markdownForRecord(record, live ? session.snapshot() : null);
  const ok = await copy(text);
  toast(ok ? `已复制本轮 Markdown（${text.length} 字符）` : '复制失败');
});

$('#chat-info').addEventListener('click', () => {
  toast('模型只写界面描述，编译与沙箱执行都在本地，界面在左边实时渲染');
});

// ── 开场卡片 ───────────────────────────────────────────────────────────────
function renderEmpty() {
  const box = $('#empty');
  if (!box) return;
  const hasModel = !!session.state.settings.modelId;
  const title = box.querySelector('h3');
  const desc = box.querySelector('p');
  const actions = box.querySelector('.empty-actions');
  title.textContent = hasModel ? '开始描述你想要的世界' : '先配一个模型';
  desc.textContent = hasModel
    ? ''
    : 'wuch-ai 让模型直接写界面，服务端编译成程序，在沙箱里跑出交互组件。填一个 OpenAI 兼容端点就能开始——可以配多个，随时在输入框右下角切换。';
  desc.hidden = hasModel;
  // 配好模型后这张卡只剩一句话，设置入口交给顶栏齿轮
  if (actions) actions.hidden = hasModel;
  // 有了第一轮就把开场卡片收起来；没配模型时一直留着提醒
  const started = !!$('#messages .turn');
  box.classList.toggle('hidden', hasModel && started);
  // 对话开始后左侧开场页也收起：这一轮没出界面时画布就是空白
  $('#stage').closest('.canvas-card')?.classList.toggle('started', started);
}

// 例子直接回放预置的 OpenUI Lang，不需要模型。
// 一屏四条、单列、单行截断；「换一批」手动翻，不自动轮播 ——
// 自动轮播会让人在读的时候画面跳走，而且旧实现按页取模，最后一页会重复前面的条目。
const EXAMPLE_PAGE = 4;

function buildExamples() {
  const wrap = el('div', 'examples');

  const head = el('div', 'examples-head');
  head.appendChild(el('span', 'examples-title', '试试这些'));
  const more = el('button', 'examples-more', '换一批');
  more.type = 'button';
  head.appendChild(more);
  wrap.appendChild(head);

  const list = el('div', 'examples-list');
  wrap.appendChild(list);

  const pages = Math.ceil(DEMOS.length / EXAMPLE_PAGE);
  let at = 0;
  const paint = () => {
    list.replaceChildren();
    for (let j = 0; j < EXAMPLE_PAGE; j++) {
      const demo = DEMOS[(at + j) % DEMOS.length];
      const b = el('button', 'example', demo.prompt);
      b.type = 'button';
      b.title = demo.prompt;
      b.addEventListener('click', () => startTurn(demo.prompt, { source: demo.source, bindings: demo.bindings }));
      list.appendChild(b);
    }
  };
  more.hidden = pages < 2;
  more.addEventListener('click', () => {
    at = (at + EXAMPLE_PAGE) % DEMOS.length;
    paint();
  });
  paint();

  $('#empty').appendChild(wrap);
}

async function startTurn(text, opts = {}) {
  setTitle(text);
  const skills = menu.get();
  session.state.skills = skills;
  if (!opts.source) session.state.datasets = await datasetSummaries();
  nextOpts = opts;
  session.runTurn(text, { ...opts, skills });
}

/** 当前引用的数据集 → 系统提示里的概要（表头 + 前几行），模型据此决定怎么用 */
async function datasetSummaries() {
  const out = [];
  for (const [id, version] of Object.entries(refsNow())) {
    try {
      const { dataset, data } = await store.readDataset(id, version);
      out.push({
        id,
        name: dataset.name,
        sheets: data.sheets.map((s) => ({
          name: s.name,
          rows: s.cells.length,
          cols: s.cells.reduce((m, r) => Math.max(m, r.length), 0),
          header: s.cells[0] || [],
          sample: s.cells.slice(1, 6),
        })),
      });
    } catch (e) {
      /* 读不出来的数据集不进提示词 */
    }
  }
  return out;
}

// ── 左侧画布的标题与状态 ───────────────────────────────────────────────────
function setCanvas({ title, sub, badge, tone }) {
  if (title != null) $('#canvas-title').textContent = title;
  if (sub != null) $('#canvas-sub').textContent = sub;
  if (badge != null) {
    const b = $('#canvas-badge');
    b.textContent = badge;
    b.className = 'status-badge ' + (tone || 'idle');
  }
}

function canvasSub(stats) {
  if (!stats) return '实时界面';
  return `${stats.elements} 个组件 · ${stats.definitions} 个变量`;
}

function resetCanvas() {
  setCanvas({ title: '实时界面', sub: '模型写的界面会在这里边写边渲染', badge: '待命', tone: 'idle' });
}

// ── 引用定位：右侧总结 → 左侧组件 ─────────────────────────────────────────
function focusRefs(refs, stale) {
  // 窄屏时聊天面板盖在画布上，先收起才看得到被定位的组件
  if (window.innerWidth <= 1024) shellUi.setChatOpen(false);
  inspector.switchTab('stage', { animate: false });
  const hits = refs.flatMap((r) => [...$('#stage').querySelectorAll(`[data-var="${CSS.escape(r)}"]`)]);
  if (!hits.length) {
    toast(stale ? '画布当前不是这一版，点「回到此版本」再看' : `界面里没找到 ${refs.join('、')}`);
    return;
  }
  hits[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const h of hits) {
    h.classList.remove('ref-flash');
    void h.offsetWidth;
    h.classList.add('ref-flash');
    setTimeout(() => h.classList.remove('ref-flash'), 1700);
  }
}

// ── 每一轮：用户一句 + AI 会话总结 ───────────────────────────────────────
/**
 * 气泡里的一句话：附件正文不进气泡（见 attachments.js 的 splitFileBlocks）。
 * 只给标题 / 预览用，取不到自己的话就拿文件名顶上。
 */
function previewText(userText, limit = 40) {
  const { text, files } = splitFileBlocks(userText);
  return (text || files.map((f) => f.name).join('、')).slice(0, limit);
}

/** 一个文件位：名字 + 字数，点开才看随消息发出去的内容 */
function fileSlot(f) {
  const d = el('details', 'bubble-file file-slot');
  const s = el('summary');
  s.appendChild(el('span', 'file-slot-name', f.name));
  if (f.body) s.appendChild(el('span', 'file-slot-size', `${f.body.length.toLocaleString()} 字`));
  s.title = '点开看这一轮随消息发出去的内容';
  d.appendChild(s);
  if (f.body) d.appendChild(el('pre', 'file-slot-body', f.body));
  return d;
}

/** 用户气泡里的附件：图片给缩略图，文件给文件位，表格等只给名字 */
function attachmentRow(att, files = []) {
  const row = el('div', 'bubble-attach');
  const named = new Set((att?.images || []).map((i) => i.name));
  for (const img of att?.images || []) {
    const im = el('img', 'bubble-thumb');
    im.src = img.url;
    im.alt = img.name;
    im.title = img.name;
    row.appendChild(im);
  }
  for (const f of files) {
    named.add(f.name);
    row.appendChild(fileSlot(f));
  }
  for (const n of att?.names || []) if (!named.has(n)) row.appendChild(el('span', 'bubble-file', n));
  return row;
}

function addTurn(userText, opts, { append = true, manual = false } = {}) {
  const turn = el('div', 'turn' + (manual ? ' manual' : ''));
  const user = el('div', 'turn-user');
  // 附件正文不进气泡：只显示用户自己写的话 + 一个文件位（点开才看内容）。
  // record.userText 仍是完整原文 —— 重发、模型上下文、导出都靠它。
  const { text: said, files } = splitFileBlocks(userText);
  const bubble = el('div', 'bubble', said);
  const att = opts && opts.attachment;
  if (files.length || (att && att.count)) bubble.appendChild(attachmentRow(att, files));
  user.appendChild(bubble);
  const branch = el('div', 'branch-nav hidden');
  user.appendChild(branch);
  turn.appendChild(user);

  const ai = el('div', 'turn-ai');
  const head = el('div', 'turn-head');
  const mark = el('span', 'ai-mark');
  mark.innerHTML = ICON.spark;
  head.appendChild(mark);
  const status = el('span', 'turn-status', '连接中…');
  head.appendChild(status);
  const version = el('span', 'turn-version');
  head.appendChild(version);
  ai.appendChild(head);

  // 时间线：思考 / 工具 / 回答 / 界面总结，按发生顺序往下排
  const flow = el('div', 'turn-flow');
  ai.appendChild(flow);

  const raw = el('details', 'raw');
  const rawHead = el('summary', null, '界面原文');
  const pre = el('pre', 'dil-stream');
  raw.appendChild(rawHead);
  raw.appendChild(pre);
  ai.appendChild(raw);

  const tools = el('div', 'turn-tools hidden');
  const copyBtn = el('button', 'icon-btn small');
  copyBtn.type = 'button';
  copyBtn.title = '复制本轮 Markdown（界面内容 + 描述 + 源码）';
  copyBtn.innerHTML = ICON.copy;
  const redoBtn = el('button', 'icon-btn small');
  redoBtn.type = 'button';
  redoBtn.title = '重新生成';
  redoBtn.innerHTML = ICON.redo;
  const checkout = el('button', 'icon-btn small');
  checkout.type = 'button';
  checkout.title = '回到此版本：画布与上下文回到这一轮结束时';
  checkout.innerHTML = ICON.rewind;
  checkout.hidden = true;
  tools.appendChild(copyBtn);
  tools.appendChild(redoBtn);
  tools.appendChild(checkout);
  ai.appendChild(tools);
  turn.appendChild(ai);

  const record = {
    turn, head, flow, stepRows: new Map(), stepLog: [], timeline: [], status, pre, rawHead, tools, branch, version, checkout, redo: redoBtn,
    thinking: null, replyBox: null, replySealed: 0, sumBox: null, summary: [], key: '',
    turnId: null, userText, opts, source: '', fallbackMarkdown: '', failure: '', reply: '',
  };
  copyBtn.title = '复制本轮 Markdown（界面内容 + 描述 + 源码）';
  copyBtn.setAttribute('aria-label', copyBtn.title);
  copyBtn.addEventListener('click', async () => {
    const text = markdownForRecord(record, record === live ? session.snapshot() : null);
    const ok = await copy(text);
    toast(ok ? `已复制本轮 Markdown（${text.length} 字符）` : '复制失败');
  });
  // 存下来之前没有轮次 id：按原样再问一次；存下来后 decorate 会换成「回到上一版再问」
  redoBtn.onclick = () => startTurn(userText, opts || {});

  if (append) {
    $('#messages').appendChild(turn);
    renderEmpty();
    scrollDown();
  }
  return record;
}

/** 封存当前回答段：后面再来工具 / 思考时，新文字另起一段，保证时间线按发生顺序 */
function sealReply(record) {
  if (!record.replyBox) return;
  record.replySealed = (record.reply || '').length;
  record.replyBox.classList.remove('pending');
  record.replyBox = null;
}

/** 流式回答：接在时间线末尾；若中间插过步骤，则新开一段 */
function renderReply(record, text, { pending = true } = {}) {
  record.reply = text || '';
  const sealed = record.replySealed || 0;
  const chunk = record.reply.slice(sealed);
  if (!chunk.trim() && !record.replyBox) return;
  if (!record.replyBox) {
    record.replyBox = MD.create({ markdown: chunk, variant: 'clear' });
    record.replyBox.classList.add('reply-text');
    if (record.sumBox?.isConnected) record.flow.insertBefore(record.replyBox, record.sumBox);
    else record.flow.appendChild(record.replyBox);
  } else {
    MD.update(record.replyBox, { markdown: chunk, variant: 'clear' });
  }
  record.replyBox.classList.toggle('pending', pending);
}

/** 一步过程：同一个 id 原地更新；新步骤插在时间线当前末尾（总结块之前） */
function renderStep(record, { id, label, detail = '', state = 'done' }) {
  sealReply(record);
  let row = record.stepRows.get(id);
  if (!row) {
    row = el('div', 'turn-step');
    row.append(el('span', 'turn-step-label'), el('span', 'turn-step-detail'));
    record.stepRows.set(id, row);
    if (record.sumBox?.isConnected) record.flow.insertBefore(row, record.sumBox);
    else record.flow.appendChild(row);
  }
  row.classList.toggle('running', state === 'running');
  row.firstChild.textContent = label;
  row.lastChild.textContent = detail;
  row.lastChild.hidden = !detail;
  row.title = detail ? `${label}：${detail}` : label;
  const at = record.stepLog.findIndex((s) => s.id === id);
  const entry = { id, label, detail };
  if (at === -1) record.stepLog.push(entry);
  else record.stepLog[at] = entry;
}

/** 界面总结条目：始终挂在时间线最末；回答由 renderReply 按发生顺序插入 */
function renderSummary(record, items, { pending = false } = {}) {
  items = items.filter((s) => !s.kind);
  const key = JSON.stringify(items) + pending + (record.reply || '');
  if (key === record.key) return;
  record.key = key;
  record.summary = [
    ...(record.reply ? [{ kind: 'reply', title: '回答', text: record.reply, refs: [] }] : []),
    ...record.stepLog.map((s) => ({ kind: 'step', title: s.label, text: s.detail, refs: [] })),
    ...items,
  ];

  if (!items.length) {
    if (record.sumBox) {
      record.sumBox.remove();
      record.sumBox = null;
    }
    return;
  }
  if (!record.sumBox) {
    record.sumBox = el('div', 'sum-list');
    record.flow.appendChild(record.sumBox);
  }
  record.sumBox.textContent = '';
  items.forEach((s, i) => {
    const item = el('div', 'sum-item');
    if (pending && i === items.length - 1) item.classList.add('pending');
    item.appendChild(el('h4', null, s.title));
    if (s.text) item.appendChild(el('p', null, s.text));
    if (s.refs && s.refs.length) {
      const chip = el('button', 'ref-chip');
      chip.type = 'button';
      chip.title = '在左侧界面里定位：' + s.refs.join('、');
      chip.innerHTML = ICON.file;
      chip.appendChild(el('code', null, s.refs[0]));
      if (s.refs.length > 1) chip.appendChild(el('span', null, `+${s.refs.length - 1}`));
      chip.addEventListener('click', () => focusRefs(s.refs, record !== live && !record.turn.classList.contains('is-head')));
      item.appendChild(chip);
    }
    record.sumBox.appendChild(item);
  });
}

/** 模型没写 summary 时，按界面结构补一条 */
function fallbackSummary(s) {
  const st = s.stats || {};
  const diag = s.diagnostics.length;
  return [
    {
      title: '界面已生成',
      text: `${st.elements ?? 0} 个组件、${st.definitions ?? 0} 个变量${diag ? `，${diag} 条诊断（见左侧「诊断 / 沙箱」）` : ''}。这一轮模型没有写 summary。`,
      refs: s.rootName ? [s.rootName] : [],
    },
  ];
}

let scrollRaf = 0;
function scrollDown() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const m = $('#messages');
    m.scrollTop = m.scrollHeight;
  });
}

// ── 会话事件 ───────────────────────────────────────────────────────────────
session.on('turn-start', ({ userText, canned, restore, turn, base }) => {
  if (restore) {
    restoringTurn = turn;
    setCanvas({ title: previewText(userText), sub: '正在还原这一版', badge: '还原中', tone: 'busy' });
    return;
  }
  // 停在旧版本上发消息 = 长出新分支：HEAD 之后那些置灰的轮次先收起来
  $('#messages')
    .querySelectorAll(rootFork ? '.turn, .head-divider' : '.turn.after-head, .head-divider')
    .forEach((n) => n.remove());
  live = addTurn(userText, nextOpts);
  lastTurnRecord = live;
  live.canvasBefore = {
    title: $('#canvas-title').textContent,
    sub: $('#canvas-sub').textContent,
    badge: $('#canvas-badge').textContent,
    tone: [...$('#canvas-badge').classList].find((c) => c !== 'status-badge') || 'idle',
  };
  nextOpts = null;
  live.status.textContent = canned ? '回放中…' : base ? '读第一行：续画还是重画…' : '生成中…';
  setCanvas({ title: previewText(userText), sub: '正在流式编译', badge: '生成中', tone: 'busy' });
  paintSend(true);
  updateVersionNav();
});

session.on('mode', ({ mode }) => {
  if (!live) return;
  live.mode = mode;
  live.version.textContent = mode === 'edit' ? '续画' : '重画';
  live.status.textContent = mode === 'edit' ? '在上一版上续画…' : '重新绘制…';
});

// 正文还没来时，把接收进度摆出来：卡在哪一步一眼能看到
session.on('progress', (p) => {
  if (!live || live.replyBox || session.server.raw || (live.thinking && p.reasoningChars)) return;
  let text;
  if (p.connecting) text = '已发出请求，等上游响应…';
  else if (!p.events) text = `已连上 · 收到 ${p.bytes} 字节${p.keepalives ? `（${p.keepalives} 次心跳，上游排队中）` : ''}，还没有内容`;
  else if (p.unknownKeys.length) text = `收到 ${p.events} 个事件，但没有正文字段（只有 ${p.unknownKeys.join('、')}）`;
  else text = `收到 ${p.events} 个事件，等正文…`;
  live.status.textContent = text;
});

// 思考 / 原文都可能每秒上百次回调：状态字和侧栏原文合并到下一帧再刷，避免卡死主线程
let reasoningUi = { raf: 0, chars: 0 };
session.on('reasoning', ({ chunk, chars }) => {
  if (!live || session.server.raw) return;
  if (!live.thinking) {
    sealReply(live);
    live.thinking = createThinking();
    if (live.sumBox?.isConnected) live.flow.insertBefore(live.thinking.el, live.sumBox);
    else live.flow.appendChild(live.thinking.el);
  }
  live.thinking.append(chunk);
  reasoningUi.chars = chars;
  if (!reasoningUi.raf) {
    reasoningUi.raf = requestAnimationFrame(() => {
      reasoningUi.raf = 0;
      if (!live || session.server.raw) return;
      live.status.textContent = `思考中 · ${reasoningUi.chars} 字`;
      setCanvas({ sub: `模型思考中 · 已 ${reasoningUi.chars} 字，界面还没开始写` });
      scrollDown();
    });
  }
});

let deltaUi = { raf: 0, raw: '' };
session.on('delta', ({ raw }) => {
  if (!live) return;
  if (live.thinking) live.thinking.finish();
  deltaUi.raw = raw;
  if (!deltaUi.raf) {
    deltaUi.raf = requestAnimationFrame(() => {
      deltaUi.raf = 0;
      if (!live) return;
      const r = deltaUi.raw;
      live.pre.textContent = r;
      live.pre.scrollTop = live.pre.scrollHeight;
      live.rawHead.textContent = `界面原文 · ${r.split('\n').length} 行`;
      live.status.textContent = `${r.length} 字符 · 更新 ${session.state.patchLog.length}`;
    });
  }
});

// 过程：判断怎么答、加载技能、载入规范、绘制界面 —— 灰字一行一步
session.on('step', (s) => {
  if (!live) return;
  renderStep(live, s);
  if (s.state === 'running') live.status.textContent = s.label;
  scrollDown();
});

// 进第二段：第一段的思考 / 回答封存，第二段另起一块接在后面
session.on('stage', () => {
  if (!live) return;
  if (live.thinking) live.thinking.finish();
  live.thinking = null;
  sealReply(live);
});

// 模型写在界面之外的文字：按发生顺序插进时间线（工具前后各成一段）
session.on('reply', ({ text }) => {
  if (!live) return;
  if (live.thinking) live.thinking.finish();
  renderReply(live, text, { pending: true });
  if (!session.server.raw) live.status.textContent = `回答中 · ${text.length} 字`;
  scrollDown();
});

// 每次重编译：总结条目和画布标题跟着长
session.on('diagnostics', ({ stats }) => {
  if (!live) return;
  const items = session.server.message.summary || [];
  renderSummary(live, items, { pending: true });
  setCanvas({ sub: canvasSub(stats) });
  if (items.length) scrollDown();
});

let rafPending = false;
const refreshSoon = () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    inspector.refresh();
  });
};
session.on('ops', refreshSoon);
session.on('patch', refreshSoon);
session.on('usage', paintUsage);
// 压缩发生在请求之前：刷新用量指示器，让「已压缩」这个状态立刻可见
session.on('compress', () => paintUsage());

session.on('turn-end', ({ failure, restore, turn, mode, reply, usage }) => {
  updateVersionNav();
  if (restore) {
    if (restoringTurn !== turn) return;
    restoringTurn = 0;
    const s = session.snapshot();
    const diag = s.diagnostics.length;
    const head = conv && turnById(conv.headTurnId);
    setCanvas({ sub: canvasSub(s.stats), badge: failure ? '还原失败' : head ? `v${head.depth}` : '历史记录', tone: failure ? 'bad' : 'idle' });
    if (!failure && diag) setCanvas({ badge: `${diag} 条诊断`, tone: 'warn' });
    inspector.refresh();
    return;
  }
  if (!live) return;
  const s = session.snapshot();
  if (live.thinking) live.thinking.finish();
  live.tools.classList.remove('hidden');
  live.reply = reply || live.reply || '';
  if (live.reply) renderReply(live, live.reply, { pending: false });
  sealReply(live);
  paintSend(false);
  const onlyText = !!live.reply && !session.server.raw.trim();
  if (onlyText) live.rawHead.parentElement.hidden = true;
  if (failure === '已取消' && onlyText) {
    live.status.textContent = '已取消';
    renderSummary(live, []);
    setCanvas(live.canvasBefore);
  } else if (failure === '已取消') {
    live.status.textContent = '已取消';
    const done = s.summary && s.summary.length ? s.summary : [];
    renderSummary(live, [...done, { title: '这一轮被取消', text: '已写出的部分保留在原文里；界面以后面那一轮为准。', refs: [] }]);
    setCanvas({ badge: '已取消', tone: 'idle' });
  } else if (failure) {
    live.status.textContent = '失败';
    live.status.classList.add('bad');
    live.pre.textContent += `\n\n[上游错误] ${failure}`;
    renderSummary(live, [{ title: '这一轮没有完成', text: failure, refs: [] }]);
    setCanvas({ badge: '失败', tone: 'bad' });
  } else if (onlyText) {
    live.status.textContent = '直接回答 · 画布未改动';
    live.version.textContent = '回答';
    renderSummary(live, []);
    setCanvas(live.canvasBefore);
  } else {
    const diag = s.diagnostics.length;
    live.status.textContent = `${s.stats?.elements ?? 0} 个组件 · ${s.serverStats.updates} 次更新 · ${diag ? `${diag} 条诊断` : '无诊断'}`;
    renderSummary(live, s.summary && s.summary.length ? s.summary : live.reply ? [] : fallbackSummary(s));
    setCanvas({ sub: canvasSub(s.stats), badge: diag ? `${diag} 条诊断` : '运行正常', tone: diag ? 'warn' : 'ok' });
  }
  saveTurn(live, failure, mode, usage);
  live = null;
  inspector.refresh();
  scrollDown();
});

session.on('error', (e) => {
  if (e.kind === 'upstream') toast('上游请求失败：' + e.message);
  else if (e.kind === 'quarantined') toast('程序超时，已隔离并重启 worker');
  else if (e.kind === 'runtime' && e.errors) toast('程序里有表达式抛错，已隔离到单个元素');
});
session.on('quarantined', (m) => toast(`程序 ${m.timeout}ms 没回应，已隔离并重启 worker（第 ${m.count} 次）`));
session.on('notice', ({ text }) => toast(text));
session.on('unhandled', ({ node, kind }) => toast(`${node.type} 的 ${kind} 没有处理器`));

// ── 输入 ───────────────────────────────────────────────────────────────────
/**
 * 附件 + 文字 → 这一轮要发的东西。
 * 图片走多模态（image_url），文本文件的内容并进正文，其余在正文里留一句说明；
 * 表格不在这里 —— 它已经导入成数据集，由系统提示里的数据集概要交代。
 */
function composeTurn(text, att) {
  let body = text || (att && att.fallbackText) || '';
  if (att && att.inline) body = body ? `${body}\n\n${att.inline}` : att.inline;
  return {
    body,
    content: att && att.images.length
      ? [{ type: 'text', text: body }, ...att.images.map((i) => ({ type: 'image_url', image_url: { url: i.url } }))]
      : null,
  };
}

// 输入框右下角：当前会话的 token 用量。
// contextTokens 是**最近一次**请求的 promptTokens —— 上下文压缩看这个；
// 缓存命中率取本轮（一次对话可能包含多次工具回灌请求），没有缓存字段就不显示。
function paintUsage({ turn, session: total } = {}) {
  const pill = $('#usage-pill');
  if (!pill) return;
  // 没配模型时没什么可量的；配了就常驻，第一轮之前显示「—/1M」，让人知道这里有这个数
  if (!session.state.settings.modelId) {
    pill.hidden = true;
    return;
  }
  const u = total || session.state.usage;
  const ratio = contextRatio(u);
  // 有本轮数据就按本轮算；本轮端点没报缓存字段就留空，不拿会话累计值冒充这一轮
  const rate = turn ? (turn.cacheReported ? cacheRate(turn) : null) : cacheRate(u);
  // 输入框那条 bar 上空间很紧（旁边还有来源、模型、发送）：只摆「上下文 / 窗口」这个数，
  // 缓存命中率和本轮花费都放 tooltip 里。
  const used = u.calls ? formatTokens(u.contextTokens) : '—';
  pill.textContent = `${used}/${formatTokens(u.contextLimit)}`;
  pill.hidden = false;
  pill.classList.toggle('warn', ratio != null && ratio >= 0.8);
  pill.title = usageTip(u, turn, ratio, rate);
  // 压过的会话标一下：上下文里已经不是全部原文了，看回放时要心里有数
  const comp = session.state.compress;
  if (comp) {
    pill.title += `\n\n已压缩：累计 ${comp.total} 轮进摘要，最近一次约省 ${Math.round(comp.savedChars / 3).toLocaleString()} token`;
    pill.classList.add('compressed');
  } else {
    pill.classList.remove('compressed');
  }
}

function usageTip(total, turn, ratio, rate) {
  if (!total.calls) return '这一轮还没发请求。发一次之后这里显示上下文占用、本轮花费与缓存命中率。';
  const lines = [
    `上下文 ${Math.round(total.contextTokens).toLocaleString()} / ${Math.round(total.contextLimit).toLocaleString()}（${formatPercent(ratio)}）`,
  ];
  if (turn && turn.calls) {
    lines.push(`本轮输入 ${turn.promptTokens.toLocaleString()} · 输出 ${turn.completionTokens.toLocaleString()} · ${turn.calls} 次请求`);
    if (rate != null) lines.push(`缓存命中 ${turn.cacheHitTokens.toLocaleString()} · 未命中 ${turn.cacheMissTokens.toLocaleString()}`);
    if (total.calls > turn.calls) lines.push(`会话累计输入 ${total.promptTokens.toLocaleString()} · 输出 ${total.completionTokens.toLocaleString()}`);
  } else {
    lines.push(`会话累计输入 ${total.promptTokens.toLocaleString()} · 输出 ${total.completionTokens.toLocaleString()}`);
  }
  if (total.cacheReported) {
    lines.push(`会话缓存命中 ${total.cacheHitTokens.toLocaleString()} · 未命中 ${total.cacheMissTokens.toLocaleString()}（${formatPercent(cacheRate(total))}）`);
  }
  if (total.estimated) lines.push('上游没回 usage，按字符估算');
  return lines.join('\n');
}

// 思考模式：只有 DeepSeek 端点认这个字段（别的端点发了会 400），所以按接口地址判断。
// 开关本身写回服务端的模型配置（换浏览器也一样），强度只存在本机设置里 ——
// 它不属于「模型是什么」，属于「这次想花多少时间思考」。
//
// 四档：中 low / 高 high / 超高 xhigh / 极致 max。
// 官方文档 reasoning_effort 只认 none / low / high / max，其中 medium 与 xhigh 暂时映射到
// high —— 先按四档摆出来，等上游把 xhigh 做成真档位，这里不用再改。
const THINK_LEVELS = [
  { label: '中', effort: 'low', hint: 'low · 最快，改一两处、问一句话够用' },
  { label: '高', effort: 'high', hint: 'high · 默认档，速度和画得准之间的平衡点' },
  { label: '超高', effort: 'xhigh', hint: 'xhigh · 多步任务、要连着改好几轮时用' },
  { label: '极致', effort: 'max', hint: 'max · 最慢，最难画的界面留给它' },
];

const thinkBtn = $('#think-btn');
const thinkMenu = $('#think-menu');
const thinkSliderEl = $('#think-slider');
const thinkEnabled = $('#think-enabled');
const thinkHint = $('#think-hint');
const thinkSlider = thinkSliderEl
  ? createThinkSlider({
      root: thinkSliderEl,
      thumb: $('#think-thumb'),
      fill: $('#think-fill'),
      labels: [...thinkMenu.querySelectorAll('.think-tick')],
      onLevel: (i) => pickThink(i),
    })
  : null;

/** 当前强度在四档里的位置；认不出来的值按「高」算 */
function thinkIndex() {
  const i = THINK_LEVELS.findIndex((l) => l.effort === (session.state.settings.reasoningEffort || 'high'));
  return i < 0 ? 1 : i;
}

function paintThink() {
  if (!thinkBtn) return;
  const s = session.state.settings;
  if (!/deepseek/i.test(String(s.baseURL || ''))) {
    thinkBtn.hidden = true;
    closeThink();
    return;
  }
  thinkBtn.hidden = false;
  const on = !!s.thinking;
  const i = thinkIndex();
  const label = on ? THINK_LEVELS[i].label : '关';
  thinkBtn.textContent = `思考 ${label}`;
  thinkBtn.classList.toggle('on', on);
  thinkBtn.classList.toggle('off', !on);
  thinkBtn.title = on
    ? `思考强度：${label}（点开调整）—— 开着要等思考完界面才开始出现`
    : '思考已关闭（点开开启）—— 关了响应更快，但复杂界面更容易画偏';

  // 气泡里的控件跟着状态走（没打开时也同步，下次打开就是对的）
  thinkSlider?.set(i);
  if (thinkEnabled) thinkEnabled.checked = on;
  if (thinkHint) thinkHint.textContent = on ? THINK_LEVELS[i].hint : '已关闭：不发思考，响应最快';
  thinkMenu?.classList.toggle('is-off', !on);
}

/** 开关写回模型配置；失败就把界面退回去，返回是否成功 */
async function saveThinkSwitch(on) {
  const snap = modelStore.snapshot();
  const active = snap.active && snap.active.enabled ? snap.active : snap.models.find((m) => m.enabled) || null;
  if (active) {
    try {
      await modelStore.update(active.id, { thinking: on });
    } catch (e) {
      toast('思考开关没存上：' + e.message);
      session.setSettings({ thinking: !on }); // 回滚到点之前
      paintThink();
      return false;
    }
    session.applyModel({ ...active, thinking: on });
  }
  session.setSettings({ thinking: on });
  return true;
}

/** 选某一档：界面先切（不等网络），再把「思考开着」写回模型配置 */
function pickThink(i) {
  const wasOff = !session.state.settings.thinking;
  session.setSettings({ thinking: true, reasoningEffort: THINK_LEVELS[i].effort });
  paintThink();
  if (wasOff) saveThinkSwitch(true);
}

/** 气泡跟着按钮摆：右边缘对齐，默认弹在上方；上面放不下就翻到下方 */
function placeThinkMenu() {
  if (!thinkMenu || !thinkBtn) return;
  const bb = thinkBtn.getBoundingClientRect();
  const w = thinkMenu.offsetWidth || 236;
  const h = thinkMenu.offsetHeight || 150;
  thinkMenu.style.left = Math.round(Math.max(8, Math.min(bb.right - w, window.innerWidth - w - 8))) + 'px';
  if (bb.top - h - 12 > 8) {
    thinkMenu.style.top = 'auto';
    thinkMenu.style.bottom = Math.round(window.innerHeight - bb.top + 8) + 'px';
  } else {
    thinkMenu.style.bottom = 'auto';
    thinkMenu.style.top = Math.round(bb.bottom + 8) + 'px';
  }
}

function closeThink() {
  if (!thinkMenu || thinkMenu.classList.contains('hidden')) return;
  thinkMenu.classList.add('hidden');
  thinkBtn?.setAttribute('aria-expanded', 'false');
}

thinkBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!thinkMenu) return;
  const open = thinkMenu.classList.toggle('hidden');
  if (!open) {
    announcePopover(thinkMenu); // 模型 / 来源那些气泡先关掉，别叠在一起
    paintThink();
    placeThinkMenu();
  }
  thinkBtn.setAttribute('aria-expanded', String(!open));
});

thinkEnabled?.addEventListener('change', async () => {
  const on = thinkEnabled.checked;
  if (!(await saveThinkSwitch(on))) return;
  paintThink();
  toast(on ? `思考已开启 · ${THINK_LEVELS[thinkIndex()].label}` : '思考已关闭');
});

if (thinkMenu) {
  closeOnOtherPopover(thinkMenu, closeThink);
  document.addEventListener('click', (e) => {
    if (thinkMenu.classList.contains('hidden')) return;
    if (thinkMenu.contains(e.target) || thinkBtn?.contains(e.target)) return;
    if (thinkSlider?.justReleased()) return; // 拖到气泡外面松手：别把气泡一起关了
    closeThink();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !thinkMenu.classList.contains('hidden')) closeThink();
  });
  window.addEventListener('resize', () => !thinkMenu.classList.contains('hidden') && placeThinkMenu());
}

// 发送键：空闲时发消息；生成中变成停止键
const sendBtn = $('#send');
const sendMod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
function paintSend(busy) {
  sendBtn.classList.toggle('is-stop', busy);
  sendBtn.title = busy ? '停止生成' : `发送（${sendMod} + Enter）`;
  sendBtn.setAttribute('aria-label', busy ? '停止生成' : '发送');
}
paintSend(false);
paintUsage();

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (session.state.running) {
    session.stop();
    toast('已请求停止');
    return;
  }
  const text = $('#prompt').value.trim();
  const att = attach.build();
  if (!text && !att.count) return;
  if (!session.state.settings.modelId) {
    settings.open(true, 'model');
    toast('先配一个模型；也可以点开场卡片里的例子离线看');
    return;
  }
  $('#prompt').value = '';
  $('#prompt').style.height = 'auto';
  const turn = composeTurn(text, att);
  startTurn(turn.body, { content: turn.content, attachment: att });
  attach.clear();
});

// 顶部面包屑与右栏标题、输入框上下文标签同源
function setTitle(text) {
  // 标题也别拿附件正文开头 —— 那份正文可能几万字
  const short = previewText(text, 22);
  $('#crumb').textContent = short;
  $('#chat-title').textContent = short;
  $('#composer-chip-text').textContent = `实时界面 · ${previewText(text, 18)}`;
}

// 「+」：气泡菜单（上传文件 / 技能 / 更多 / 示例），选中的技能以 chip 挂着，按会话粘滞
let exampleCursor = 0;
const fillPrompt = (text) => {
  $('#prompt').value = text;
  $('#prompt').focus();
  $('#prompt').dispatchEvent(new Event('input'));
};
const menu = createComposerMenu({
  button: $('#composer-add'),
  chips: $('#skill-chips'),
  menu: $('#add-menu'),
  fileInput: $('#file-input'),
  prompt: $('#prompt'),
  skills: SKILLS,
  onChange: (ids) => {
    session.state.skills = ids;
    if (conv && conv.turns) store.setSkills(conv.id, ids).catch((e) => toast('技能选择没存上：' + e.message));
  },
  onUpload: (files) => attach.add(files),
  onExample: () => fillPrompt(EXAMPLES[exampleCursor++ % EXAMPLES.length]),
});
store
  .skillCatalog()
  .then((list) => menu.setExternal(list.filter((s) => !s.builtin)))
  .catch(() => {});
// ── 表格（Sheet）找宿主办事：编辑存版本、导入、导出 ─────────────────────
const INLINE_MAX_CELLS = 2000; // 再大的内联表转存成数据集，原文里只留引用
const plainCell = (c) => (c && typeof c === 'object' ? (c.f ? '=' + c.f : (c.v ?? null)) : (c ?? null));
const plainSheets = (sheets) => sheets.map((s) => ({ name: s.name, cells: s.cells.map((r) => r.map(plainCell)) }));
const sheetLabel = (p) => p.caption || p.var || '表格';

function inlineStatement(p, cells) {
  const [head = [], ...rows] = cells;
  const args = [JSON.stringify(head.map((v) => (v == null ? '' : String(v)))), JSON.stringify(rows)];
  if (p.editable === false || p.caption) args.push(String(p.editable !== false));
  if (p.caption) args.push(JSON.stringify(p.caption));
  return `${p.var} = Sheet(${args.join(', ')})`;
}

function boundStatement(p, datasetId, sheetName) {
  const args = [JSON.stringify(datasetId), JSON.stringify(sheetName || '')];
  if (p.editable === false || p.caption) args.push(String(p.editable !== false));
  if (p.caption) args.push(JSON.stringify(p.caption));
  return `${p.var} = Sheet(${args.join(', ')})`;
}

const editTimers = new Map();
function onSheetHost(kind, p) {
  if (kind === 'sheet-export') return exportSheet(p);
  if (kind === 'sheet-import') return importIntoSheet(p);
  if (kind === 'sheet-edit') {
    // 连续输入只存一版
    const key = p.var || p.dataset || '';
    clearTimeout(editTimers.get(key));
    editTimers.set(
      key,
      setTimeout(() => {
        editTimers.delete(key);
        saveSheetEdit(p).catch((e) => toast('表格改动没存上：' + e.message));
      }, 1200),
    );
  }
}

async function exportSheet(p) {
  const sheets = plainSheets(p.sheets);
  const values = sheets.map((s) =>
    evaluateSheet(s.cells.map((r) => r.map(toCell))).map((r) => r.map((v) => (v && typeof v === 'object' && 'err' in v ? v.err : v))),
  );
  try {
    const name = await store.exportSheets({ name: sheetLabel(p), format: 'xlsx', sheets, values });
    toast(`已导出 ${name}`);
  } catch (e) {
    toast('导出失败：' + e.message);
  }
}

/** 用户在表格里改了单元格：绑定数据集的提交新版本；内联小表改写原文里那条语句。都记成一版「手动」 */
async function saveSheetEdit(p) {
  if (session.state.running) return toast('正在生成，这次表格改动没有存进版本');
  const sheets = plainSheets(p.sheets);
  const label = sheetLabel(p);
  const base = (session.state.canvas && session.state.canvas.source) || '';
  const text = `（手动编辑了表格「${label}」）`;
  if (p.dataset) {
    const version = await store.commitDataset(p.dataset, { parentId: refsNow()[p.dataset] || null, data: { sheets }, note: `编辑 ${label}` });
    return commitUserTurn({ text, snapshot: base, refs: { [p.dataset]: version.id } });
  }
  if (!p.var) return toast('这张表没有变量名，改动只留在页面上，不会存进版本');
  const cells = sheets[0].cells;
  if (cells.reduce((n, r) => n + r.length, 0) <= INLINE_MAX_CELLS) {
    return commitUserTurn({ text, snapshot: mergeSource(base, inlineStatement(p, cells), { final: true }) });
  }
  const { dataset, version } = await store.createDataset({ conversationId: conv && conv.turns ? conv.id : null, name: label, data: { sheets }, author: 'user', note: '内联表格转存' });
  return commitUserTurn({ text, snapshot: mergeSource(base, boundStatement(p, dataset.id, sheets[0].name), { final: true }), refs: { [dataset.id]: version.id } });
}

let sheetPicker = null;
function pickFile() {
  return new Promise((resolve) => {
    if (!sheetPicker) {
      sheetPicker = document.createElement('input');
      sheetPicker.type = 'file';
      sheetPicker.accept = '.xlsx,.xls,.csv';
      sheetPicker.hidden = true;
      document.body.appendChild(sheetPicker);
    }
    sheetPicker.value = '';
    sheetPicker.onchange = () => resolve(sheetPicker.files && sheetPicker.files[0]);
    sheetPicker.click();
  });
}

/** 表格上的「导入」：文件导入成数据集，这张表改成引用它（也是一版，可以回退） */
async function importIntoSheet(p) {
  if (session.state.running) return toast('正在生成，等这一轮结束再导入');
  const file = await pickFile();
  if (!file) return;
  try {
    const out = await store.importDataset(file, conv && conv.turns ? conv.id : null);
    if (!p.var) {
      pendingRefs = { ...pendingRefs, [out.dataset.id]: out.version.id };
      attach.addRef({ datasetId: out.dataset.id, versionId: out.version.id, name: file.name, sheets: out.data.sheets.length });
      return toast('已导入；这张表没有变量名，发消息让 AI 用它');
    }
    const base = (session.state.canvas && session.state.canvas.source) || '';
    commitUserTurn({
      text: `（把「${file.name}」导入到表格「${sheetLabel(p)}」）`,
      snapshot: mergeSource(base, boundStatement(p, out.dataset.id, out.data.sheets[0].name), { final: true }),
      refs: { [out.dataset.id]: out.version.id },
      recompile: true,
      note: `表格换成了导入的 ${file.name}，可以回退`,
    });
  } catch (e) {
    toast('导入失败：' + e.message);
  }
}

$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#prompt').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px';
});

function toast(msg) {
  const n = $('#toast');
  n.textContent = msg;
  n.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => n.classList.remove('show'), 2600);
}

// ── 启动 ───────────────────────────────────────────────────────────────────
buildExamples();
renderEmpty();
inspector.switchTab('stage', { animate: false });
inspector.refresh();
session.initRunner();
// 模型配置存在服务端：拉列表 → 定当前那个 → 摊进 session
modelStore
  .bootstrap()
  .then(() => syncModels())
  .catch((e) => toast('模型配置读不出来：' + e.message + '（确认 bun run dev 已重启）'));
// 早先存在 localStorage 的会话先搬进服务端，再回到上次打开的会话
store
  .importLegacy()
  .then((r) => r && r.imported && toast(`已把 ${r.imported} 个本地会话搬进数据库`))
  .catch((e) => toast('本地旧会话没搬成，下次打开再试：' + e.message))
  .then(() => session.state.settings.restoreLast !== false && store.activeId() && openConversation(store.activeId(), { quiet: true }));

window.__openui = { session, inspector, shellUi };
