// 工具预算：轮数不设上限，只有两条闸（单个工具的次数、整轮的字数），
// 外加一个防死循环 —— 一整轮的调用全被挡下（一个都没真跑）时，调用方该收尾。
//
// 抽出来测是因为 session.js 的其余部分依赖 DOM，跑不进 node。
import { createToolBudget, DEFAULT_LIMITS, DEFAULT_METERED, FALLBACK_LIMIT } from '../apps/web/src/tool-budget.js';
import { TOOL_META } from '../apps/server/src/tools.mjs';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
};

console.log('闸一：单个工具的次数');
{
  const b = createToolBudget({ limits: { web_search: 2 }, budgetChars: 1e9 });
  b.beginRound();
  ok(b.check('web_search').allow, '第 1 次放行');
  b.spent('web_search', 10);
  ok(b.check('web_search').allow, '第 2 次放行');
  b.spent('web_search', 10);
  const third = b.check('web_search');
  ok(!third.allow && third.code === 'limit' && third.limit === 2, '第 3 次被挡，并带回上限值');
  ok(b.check('fetch_url').allow, '另一个工具不受影响');
}

console.log('\n闸二：整轮的字数（只算联网工具）');
{
  const b = createToolBudget({ limits: { web_search: 99, fetch_url: 99 }, budgetChars: 100 });
  b.beginRound();
  b.check('web_search');
  b.spent('web_search', 60);
  ok(b.check('fetch_url').allow, '字数没到顶，换工具照样放行');
  b.spent('fetch_url', 50);
  const g = b.check('web_search');
  ok(!g.allow && g.code === 'budget', '字数到顶后任何工具都被挡（次数还富余）');
}

console.log('\n知识库工具不计入字数预算');
{
  const b = createToolBudget({ budgetChars: 100 });
  b.beginRound();
  for (let i = 0; i < 5; i++) {
    ok(b.check('kb_get').allow, `kb_get 第 ${i + 1} 次仍放行（读了 5 万字也不占预算）`);
    b.spent('kb_get', 10000);
  }
  ok(b.stats().chars === 0, '字数为 0：kb 的结果没进预算');
  ok(b.check('web_search').allow, '联网工具的预算一点没被 kb 吃掉');
  b.spent('web_search', 120);
  ok(!b.check('fetch_url').allow, '联网工具自己超了预算照样被挡');
}

console.log('\n本地工具的次数上限是宽松的兜底，不该卡住正常干活');
{
  ok(DEFAULT_LIMITS.kb_get >= 10 && DEFAULT_LIMITS.kb_put >= 10 && DEFAULT_LIMITS.kb_lookup >= 10, 'kb_* 至少 10 次');
  ok(DEFAULT_LIMITS.web_search <= 3 && DEFAULT_LIMITS.fetch_url <= 2, '联网工具仍然给得紧');
  ok(!DEFAULT_METERED.includes('kb_get') && !DEFAULT_METERED.includes('kb_put'), 'kb_* 不在计费名单里');
}

console.log('\n次数与字数跨工具轮累计，不被 beginRound 清掉');
{
  const b = createToolBudget({ limits: { kb_put: 2 }, budgetChars: 1e9 });
  b.beginRound();
  b.check('kb_put');
  b.spent('kb_put', 5);
  b.beginRound();
  ok(b.check('kb_put').allow, '第 2 个工具轮还能调（累计才 1 次）');
  b.spent('kb_put', 5);
  b.beginRound();
  ok(!b.check('kb_put').allow, '第 3 个工具轮被挡：整个对话轮已经 2 次');
}

console.log('\n防死循环：allStalled');
{
  const b = createToolBudget({ limits: { web_search: 1 }, budgetChars: 1e9 });
  b.beginRound();
  b.check('web_search');
  b.spent('web_search', 1);
  b.beginRound();
  b.check('web_search'); // 这一轮唯一的调用被挡
  ok(b.allStalled(), '整轮全被挡 → 该收尾');

  b.beginRound();
  b.check('kb_get');
  b.spent('kb_get', 1);
  ok(!b.allStalled(), '有一次真跑 → 继续问模型');

  b.beginRound();
  ok(!b.allStalled(), '一次都没请求（模型没要工具）→ 不算打转');

  const c = createToolBudget({ limits: { fetch_url: 5 }, budgetChars: 1e9 });
  c.beginRound();
  ok(c.check('fetch_url').allow, '先过闸');
  // 过了闸但用户拒绝：session.js 不会 spent
  ok(!c.allStalled(), '过了闸、用户拒绝 → 不算打转，得让模型知道被拒了');
}

console.log('\n没登记的工具');
{
  const b = createToolBudget({ limits: {}, budgetChars: 1e9 });
  let n = 0;
  while (b.check('brand_new').allow) {
    b.spent('brand_new', 1);
    n += 1;
    if (n > 20) break;
  }
  ok(n === FALLBACK_LIMIT, `没登记的工具默认 ${FALLBACK_LIMIT} 次`, `实际 ${n}`);
}

console.log('\n与工具目录对齐');
{
  const ids = TOOL_META.map((t) => t.id);
  for (const id of ids) ok(DEFAULT_LIMITS[id] > 0, `工具目录里的 ${id} 配了次数`);
  const extra = Object.keys(DEFAULT_LIMITS).filter((k) => !ids.includes(k));
  ok(extra.length === 0, 'DEFAULT_LIMITS 里没有已下线的工具', extra.join('、'));
}

console.log(failed ? `\n${failed} 条没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
