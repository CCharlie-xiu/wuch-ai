// ─────────────────────────────────────────────────────────────────────────────
// 会话 token 用量：把每次上游调用的 usage 归一、累加，并算出「当前上下文占窗口多少」。
//
// 为什么分成「累加」和「当前上下文」两个数：
//   · promptTokens 是**每次请求都重发一遍**的，多轮相加只能看花了多少钱；
//   · 要判断该不该压缩上下文，看的是**最近一次**请求的 promptTokens —— 那才是
//     这一次真正塞进模型的上下文大小。
//
// 一次调用的用量（normalizeUsage 的输出）：
//   promptTokens / completionTokens / totalTokens
//   cacheHitTokens / cacheMissTokens   DeepSeek 的前缀缓存命中 / 未命中；端点没报就是 null
//   estimated                          上游没给 usage 时按字符估的
//
// 累加后的用量（addUsage 的输出）额外有：
//   contextTokens   最近一次调用的 promptTokens
//   contextLimit    模型上下文窗口
//   calls           累加了几次上游调用
//   cacheReported   至少有一次调用报过缓存字段（没报过时不要把 0 当成「全未命中」）
//
// 纯函数、不碰 DOM —— session.js 的其余部分依赖 DOM，跑不进 node；
// 这里的测试见 tests/usage.mjs。
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_WINDOW = 128_000;

// 只做「常见端点的保守默认值」。要精确，就在模型配置里加窗口参数，
// 这里由 contextWindowFor 的 fallback 兜住。
const WINDOWS = [
  // DeepSeek V4 系列（deepseek-flash / deepseek-v4-pro）上下文 1M，最大输出 384K
  [/deepseek/i, 1_000_000],
  [/gpt-4\.1|gpt-5/i, 1_047_576],
  [/gpt-4o|gpt-4-turbo|o1|o3|o4/i, 128_000],
  [/claude/i, 200_000],
  [/gemini/i, 1_000_000],
];

/** 按模型名 / 接口地址猜上下文窗口；认不出来用兜底值 */
export function contextWindowFor(model = '', baseURL = '', fallback = DEFAULT_CONTEXT_WINDOW) {
  const s = `${model || ''} ${baseURL || ''}`;
  for (const [re, n] of WINDOWS) if (re.test(s)) return n;
  return fallback;
}

export function emptyUsage(contextLimit = DEFAULT_CONTEXT_WINDOW) {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheReported: false,
    contextTokens: 0,
    contextLimit,
    calls: 0,
    estimated: false,
  };
}

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.floor(Number(v))));

/**
 * 上游 usage → 统一的驼峰结构。
 * 兼容两种缓存字段：
 *   DeepSeek  prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   OpenAI    prompt_tokens_details.cached_tokens（只给命中数，未命中 = prompt - hit）
 * 上游没给缓存字段时保持 null，不要伪造成 0。
 */
export function normalizeUsage(usage, { estimated = false } = {}) {
  const u = usage || {};
  const promptTokens = num(u.prompt_tokens ?? u.promptTokens) ?? 0;
  const completionTokens = num(u.completion_tokens ?? u.completionTokens) ?? 0;
  const totalTokens = num(u.total_tokens ?? u.totalTokens) ?? promptTokens + completionTokens;

  const openaiCached = num(u.prompt_tokens_details?.cached_tokens);
  const hit = num(u.prompt_cache_hit_tokens ?? u.cacheHitTokens) ?? openaiCached;
  const miss =
    num(u.prompt_cache_miss_tokens ?? u.cacheMissTokens) ??
    (hit != null ? Math.max(0, promptTokens - hit) : null);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    estimated: !!estimated,
  };
}

/**
 * 把一次调用累加进总量。返回新对象，不改入参。
 * contextTokens 取「最近一次」的 promptTokens：它才是当前上下文大小；
 * 新一轮的工具回灌会让它变大，压缩后应该变小。
 */
export function addUsage(acc, one, { contextLimit } = {}) {
  const base = acc || emptyUsage();
  const prompt = num(one?.promptTokens) ?? 0;
  const hit = num(one?.cacheHitTokens);
  const miss = num(one?.cacheMissTokens);
  return {
    promptTokens: base.promptTokens + prompt,
    completionTokens: base.completionTokens + (num(one?.completionTokens) ?? 0),
    totalTokens: base.totalTokens + (num(one?.totalTokens) ?? prompt + (num(one?.completionTokens) ?? 0)),
    cacheHitTokens: base.cacheHitTokens + (hit ?? 0),
    cacheMissTokens: base.cacheMissTokens + (miss ?? 0),
    cacheReported: base.cacheReported || hit != null,
    // 这次调用没带 prompt（比如估算失败）就保留上一次的上下文大小
    contextTokens: prompt || base.contextTokens,
    contextLimit: contextLimit || base.contextLimit || DEFAULT_CONTEXT_WINDOW,
    calls: base.calls + 1,
    estimated: base.estimated || !!one?.estimated,
  };
}

/** 缓存命中率（0–1）；端点没报缓存字段返回 null */
export function cacheRate(usage) {
  if (!usage || !usage.cacheReported) return null;
  const total = usage.cacheHitTokens + usage.cacheMissTokens;
  return total > 0 ? usage.cacheHitTokens / total : null;
}

/** 上下文占用（0–1，可能 >1：估算或窗口填错时如实暴露） */
export function contextRatio(usage) {
  if (!usage || !usage.contextTokens || !usage.contextLimit) return null;
  return usage.contextTokens / usage.contextLimit;
}

/** 128000 → 128k；1047576 → 1.05M；不到一千原样显示 */
export function formatTokens(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(k >= 10 ? 1 : 2).replace(/\.0+$/, '')}k`;
  }
  return `${(v / 1_000_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`;
}

export function formatPercent(ratio) {
  return ratio == null ? '—' : `${Math.round(ratio * 100)}%`;
}
