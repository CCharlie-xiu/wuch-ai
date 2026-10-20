// ─────────────────────────────────────────────────────────────────────────────
// 上下文压缩：把早前的轮次压成要点，只留最近几轮原文。
//
// 触发依据是**最近一次请求的 promptTokens 占窗口的比例**（usage.js 的
// contextRatio），不是累计花费 —— 累计值只说明花了多少钱，说明不了「这一次
// 塞进模型的东西有多大」。
//
// 为什么不每轮都压：
//   · 压缩有代价（丢细节），只在快撑满时才划算；
//   · 前缀一变缓存就全废（DeepSeek 按前缀精确匹配），压完那一轮必然全 miss。
//     所以宁可晚压、一次压够，也别每轮都动前缀。
//
// 压缩策略：
//   · 最近 keepTurns 轮原样保留 —— 正在改的东西，细节不能丢；
//   · 更早的轮次每条压成一行「用户说了什么 → 助手做了什么」，总长有上限；
//   · 压缩是增量的：上一轮的摘要留在最前面，新的要点接在后面，
//     不会因为反复压缩把同一段话抄三遍。
//
// 纯函数、不碰 DOM —— session.js 的其余部分依赖 DOM，跑不进 node；
// 测试见 tests/context-compress.mjs。
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_COMPRESS = {
  enabled: true,
  threshold: 0.8, // 上下文占用到这个比例就压
  keepTurns: 4, // 最近几轮原样保留
  maxSummaryChars: 1400, // 压缩摘要的总长上限
  clipUser: 140, // 每条旧轮次里用户的话留多少字
  clipAssistant: 200, // 助手那句留多少字
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * 一条消息的 content 可能是字符串，也可能是多模态数组。
 * 取能进摘要的那部分：文字照抄，图片只留个占位 —— 压缩是为了省 token，
 * 不是把图片重新塞回去。
 */
export function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!p || typeof p !== 'object') return '';
        if (p.type === 'text') return String(p.text || '');
        if (p.type === 'image_url' || p.type === 'image') return '[图片]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return String(content.text || '');
  return String(content);
}

/** 压成一行：折叠换行、去掉多余空白，超长截断并标出原长 */
export function squeeze(text, limit) {
  const one = String(text || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!one) return '';
  const max = Math.max(16, Math.floor(limit) || 120);
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…（原 ${one.length} 字）`;
}

/**
 * 历史 → 轮次。一条 user 开启一轮，后面的 assistant 归它；开头孤立的
 * assistant（理论上不该有）自成一"轮"，压缩时照常处理，不丢。
 * 兼容现有写法：历史里 assistant 也可能直接是一句「（已重新绘制画布）」。
 */
export function splitTurns(history = []) {
  const turns = [];
  let cur = null;
  for (const m of history || []) {
    if (!m || !m.role) continue;
    if (m.role === 'user' || !cur) {
      cur = { user: m.role === 'user' ? m : null, assistant: m.role === 'user' ? [] : [m], messages: m.role === 'user' ? [m] : [m] };
      turns.push(cur);
      continue;
    }
    cur.assistant.push(m);
    cur.messages.push(m);
  }
  return turns;
}

/** 一轮 → 摘要里的一行；什么都没留下就返回空串 */
export function summarizeTurn(turn, { clipUser = DEFAULT_COMPRESS.clipUser, clipAssistant = DEFAULT_COMPRESS.clipAssistant } = {}) {
  const user = squeeze(contentText(turn?.user?.content), clipUser);
  const said = (turn?.assistant || [])
    .map((m) => contentText(m.content))
    .join(' ')
    .trim();
  const assistant = squeeze(said, clipAssistant);
  if (!user && !assistant) return '';
  if (user && assistant) return `- 用户：${user} → 助手：${assistant}`;
  return user ? `- 用户：${user}` : `- 助手：${assistant}`;
}

/**
 * 该不该压。
 * @param {object} usage usage.js 的会话用量（含 contextTokens / contextLimit / calls）
 * @returns {boolean}
 */
export function shouldCompress(usage, { enabled = true, threshold = DEFAULT_COMPRESS.threshold } = {}) {
  if (!enabled) return false;
  if (!usage || !usage.calls) return false; // 一次请求都没发过，没有可信的比例
  const ctx = Number(usage.contextTokens) || 0;
  const limit = Number(usage.contextLimit) || 0;
  if (!ctx || !limit) return false;
  return ctx / limit >= Math.min(0.99, Math.max(0.1, num(threshold, DEFAULT_COMPRESS.threshold)));
}

/**
 * 压缩历史。
 * @param {Array<{role: string, content: any}>} history 当前历史（user / assistant）
 * @param {object} [o]
 * @param {string} [o.prevSummary] 上一次压缩留下的摘要（会保留在最前面）
 * @returns {{ history: Array, summary: string, droppedTurns: number, droppedChars: number, keptTurns: number }}
 */
export function compressHistory(history = [], o = {}) {
  const keepTurns = Math.max(0, Math.floor(num(o.keepTurns, DEFAULT_COMPRESS.keepTurns)));
  const maxSummaryChars = Math.max(200, Math.floor(num(o.maxSummaryChars, DEFAULT_COMPRESS.maxSummaryChars)));
  const turns = splitTurns(history);
  const kept = keepTurns ? turns.slice(-keepTurns) : [];
  const old = keepTurns ? turns.slice(0, turns.length - keepTurns) : turns;

  const keptMessages = kept.flatMap((t) => t.messages);

  // 压缩省下的字：旧轮次原文 - 留下的摘要行。算的是「消息正文」而不是整个
  // 请求（system prompt 不动），所以只能当量级看，别当精确 token。
  const droppedChars = old.reduce(
    (n, t) => n + t.messages.reduce((m, msg) => m + contentText(msg.content).length, 0),
    0,
  );

  if (!old.length) {
    return { history: keptMessages, summary: String(o.prevSummary || '').trim(), droppedTurns: 0, droppedChars: 0, keptTurns: kept.length };
  }

  // 上一轮的摘要整段保留；新要点接在后面，但总长不超上限
  const prev = String(o.prevSummary || '').trim();
  const lines = [];
  for (const t of old) {
    const line = summarizeTurn(t, o);
    if (line) lines.push(line);
  }

  let summary = prev;
  for (const line of lines) {
    const next = summary ? `${summary}\n${line}` : line;
    if (next.length > maxSummaryChars) break;
    summary = next;
  }
  // 摘要本身可能被截断：宁可末尾丢几条，也别把最近的丢在最前面挤掉
  if (summary.length > maxSummaryChars) summary = summary.slice(0, maxSummaryChars - 1) + '…';

  const body = [
    '## 更早的对话（已压缩，原文不再重发）',
    '',
    '下面是这次会话更早的轮次，只保留结论与约束。细节已经不在上下文里：',
    '如果这些要点不够用，直接问用户，或从当前画布的源码里找，**不要凭印象补全**。',
    '',
    summary || '（更早的轮次没有可提炼的内容）',
  ].join('\n');

  return { history: keptMessages, summary: body, droppedTurns: old.length, droppedChars, keptTurns: kept.length };
}

/** 摘要里的原始要点（不含那几句固定说明），给界面显示省了多少字用 */
export function summaryBullets(summary) {
  return String(summary || '')
    .split('\n')
    .filter((l) => l.startsWith('- ')).length;
}
