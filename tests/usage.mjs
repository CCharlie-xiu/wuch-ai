// 会话 token 用量：缓存命中拆分 + 「当前上下文」口径。
// 抽出来测是因为 session.js 的其余部分依赖 DOM，跑不进 node。
import {
  normalizeUsage,
  addUsage,
  emptyUsage,
  cacheRate,
  contextRatio,
  contextWindowFor,
  formatTokens,
  formatPercent,
  DEFAULT_CONTEXT_WINDOW,
} from '../apps/web/src/usage.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log('归一：两种缓存字段');
{
  const ds = normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
    prompt_cache_hit_tokens: 768, prompt_cache_miss_tokens: 232,
  });
  ok(ds.promptTokens === 1000 && ds.completionTokens === 200 && ds.totalTokens === 1200, 'DeepSeek 基础字段');
  ok(ds.cacheHitTokens === 768 && ds.cacheMissTokens === 232, 'DeepSeek 命中 / 未命中原样保留');

  const oa = normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 640 },
  });
  ok(oa.cacheHitTokens === 640, 'OpenAI cached_tokens → 命中');
  ok(oa.cacheMissTokens === 360, '未命中 = prompt - 命中');

  const none = normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  ok(none.cacheHitTokens === null && none.cacheMissTokens === null, '端点没报缓存：保持 null，不伪造 0');
}

console.log('\n累加：累计花费 vs 当前上下文');
{
  const limit = 100_000;
  let acc = emptyUsage(limit);
  ok(acc.contextLimit === limit && acc.calls === 0, '空用量带上窗口');

  acc = addUsage(acc, normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 }), { contextLimit: limit });
  ok(acc.contextTokens === 1000, '第一次请求：上下文 = 1000');
  ok(acc.calls === 1 && acc.promptTokens === 1000, '调用次数与输入累计');

  acc = addUsage(acc, normalizeUsage({ prompt_tokens: 4000, completion_tokens: 300, prompt_cache_hit_tokens: 3600, prompt_cache_miss_tokens: 400 }), { contextLimit: limit });
  ok(acc.contextTokens === 4000, '上下文取最近一次，不累加');
  ok(acc.promptTokens === 5000 && acc.completionTokens === 400, '输入 / 输出是累计值');
  ok(acc.cacheHitTokens === 4000 && acc.cacheMissTokens === 1000, '缓存字段累计');
  ok(acc.cacheReported === true, '至少一次报过缓存 → cacheReported');

  ok(near(cacheRate(acc), 4000 / 5000), '缓存命中率 = 命中 / (命中 + 未命中)');
  ok(near(contextRatio(acc), 4000 / limit), '上下文占用 = 最近一次输入 / 窗口');
}

console.log('\n没报缓存时不把 0 当分母');
{
  const acc = addUsage(emptyUsage(), normalizeUsage({ prompt_tokens: 100, completion_tokens: 10 }));
  ok(cacheRate(acc) === null, '缓存命中率未知 → null');
  ok(contextRatio({ contextTokens: 0, contextLimit: 100 }) === null, '没有上下文大小 → null');
  ok(contextRatio({ contextTokens: 120, contextLimit: 100 }) > 1, '超出窗口如实返回 > 1');
}

console.log('\n窗口推断与格式化');
{
  ok(contextWindowFor('deepseek-chat', 'https://api.deepseek.com') === 1_000_000, 'DeepSeek 1M');
  ok(contextWindowFor('gpt-4o-mini', '') === 128_000, 'GPT-4o 128k');
  ok(contextWindowFor('some-model', 'http://localhost:11434') === DEFAULT_CONTEXT_WINDOW, '认不出来用兜底');
  ok(formatTokens(999) === '999', '千以下原样');
  ok(formatTokens(12_345) === '12.3k', '万级一位小数');
  ok(formatTokens(128_000) === '128k', '整 k 不带小数');
  ok(formatTokens(1_047_576) === '1.05M', '百万级');
  ok(formatPercent(0.4743) === '47%', '百分比四舍五入');
}

console.log(failed ? `\n${failed} 条没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
