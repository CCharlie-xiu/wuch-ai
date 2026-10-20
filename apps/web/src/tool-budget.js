// ─────────────────────────────────────────────────────────────────────────────
// 工具预算：一轮里每个工具能调几次、工具结果总共能灌多少字。
//
// **轮数不在这里管。** 模型想调几轮就调几轮，直到它自己不再要工具为止。
//
// 两条闸，按工具的性质分开：
//   · 次数：每个工具一个对话轮里最多调几次。联网的给得紧（烧额度、灌上下文），
//     本地的（kb_*）给得松，只是防跑飞。
//   · 字数：只有**联网**工具的结果计入 —— 这条预算的用意是别把整页网页塞进上下文，
//     而知识库条目是用户自己攒的，不该被它掐掉。
//
// 外加一个防死循环：如果一整轮的调用**全被挡下**（一个都没真跑），
// 再问一遍还是同样的结果，调用方该收尾了 —— 这是防打转，不是轮数预算。
//
// 抽成独立模块是因为 session.js 的其余部分依赖 DOM、没法在 node 里测；
// 这里全是纯逻辑，测试见 tests/tool-budget.mjs。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每个工具一个对话轮里最多调几次。
 *
 * 联网工具给得紧：每次搜索都烧第三方额度、还会把大段网页灌进上下文。
 * 本地工具（kb_*）给得松 —— 它们只是读写本地 SQLite，没有外部成本，
 * 次数在这里只是「防跑飞」的兜底，不该卡住正常干活（读几条知识、存几个文件）。
 */
export const DEFAULT_LIMITS = { web_search: 2, fetch_url: 1, kb_lookup: 12, kb_put: 12, kb_get: 12 };
export const DEFAULT_BUDGET_CHARS = 8000;
/** 目录里没写过的工具，默认给这个次数 */
export const FALLBACK_LIMIT = 2;
/**
 * 计入字数预算的工具 —— 只有联网的。
 * 这条预算的用意是「别把整页网页塞进上下文」，而知识库条目是用户自己攒的，
 * 体积由条目本身决定，不该被这条预算掐掉。
 */
export const DEFAULT_METERED = ['web_search', 'fetch_url'];

/**
 * @param {object} [o]
 * @param {Record<string, number>} [o.limits] 每个工具一轮里最多调几次
 * @param {number} [o.budgetChars] 一轮里**计入预算的**工具结果总字数上限
 * @param {Iterable<string>} [o.metered] 哪些工具的结果计入字数预算
 */
export function createToolBudget({
  limits = DEFAULT_LIMITS,
  budgetChars = DEFAULT_BUDGET_CHARS,
  metered = DEFAULT_METERED,
} = {}) {
  const counts = new Set(metered);
  const used = new Map();
  let chars = 0;
  let attempts = 0; // 这一轮请求执行了几次
  let stalled = 0; // 其中被闸挡下的次数

  return {
    /**
     * 开始一次新的工具轮（模型又要了一批工具）。
     * 只清「这一轮全被挡下」的判定计数 —— 次数与字数是**整个对话轮**的预算，
     * 跨工具轮累计，不清。
     */
    beginRound() {
      attempts = 0;
      stalled = 0;
    },

    /**
     * 这个工具现在能不能调。被挡下的会记进 stalled，供 allStalled 判断。
     * @param {string} name
     * @returns {{allow: true} | {allow: false, code: 'limit'|'budget', limit?: number}}
     */
    check(name) {
      attempts += 1;
      const limit = limits[name] ?? FALLBACK_LIMIT;
      if ((used.get(name) || 0) >= limit) {
        stalled += 1;
        return { allow: false, code: 'limit', limit };
      }
      if (chars >= budgetChars) {
        stalled += 1;
        return { allow: false, code: 'budget' };
      }
      return { allow: true };
    },

    /** 真跑了一次：记下次数；只有计入预算的工具才累加字数 */
    spent(name, textLength) {
      used.set(name, (used.get(name) || 0) + 1);
      if (counts.has(name)) chars += Math.max(0, Number(textLength) || 0);
    },

    /** 这一轮请求执行的调用是不是全被挡下了（一个都没真跑） */
    allStalled() {
      return attempts > 0 && stalled === attempts;
    },

    /** 给检视器 / 调试看的快照 */
    stats() {
      return { used: Object.fromEntries(used), chars, attempts, stalled };
    },
  };
}
