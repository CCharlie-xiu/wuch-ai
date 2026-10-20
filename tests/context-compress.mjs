// 上下文压缩：阈值判定 + 历史压成要点。
// 抽出来测是因为 session.js 的其余部分依赖 DOM，跑不进 node。
import {
  DEFAULT_COMPRESS,
  contentText,
  squeeze,
  splitTurns,
  summarizeTurn,
  shouldCompress,
  compressHistory,
  summaryBullets,
} from '../apps/web/src/context-compress.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
};

console.log('多模态 content 取文字');
{
  ok(contentText('abc') === 'abc', '字符串原样');
  ok(contentText([{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'x' } }]) === '看图\n[图片]', '文本 + 图片占位');
  ok(contentText(null) === '', 'null → 空串');
}

console.log('\n一行摘要：折叠换行 + 截断标原长');
{
  ok(squeeze('a\n\n  b   c') === 'a b c', '折叠空白');
  const long = 'x'.repeat(300);
  const out = squeeze(long, 100);
  ok(out.length < 140 && out.includes('原 300 字'), '超长截断并标出原长', out);
  ok(squeeze('', 10) === '', '空内容 → 空串');
}

console.log('\n分轮：一条 user 开启一轮');
{
  const turns = splitTurns([
    { role: 'user', content: '做一个待办' },
    { role: 'assistant', content: '已重画' },
    { role: 'user', content: '改成暗色' },
    { role: 'assistant', content: '已改' },
  ]);
  ok(turns.length === 2, '两轮');
  ok(turns[1].assistant.length === 1 && contentText(turns[1].assistant[0].content) === '已改', 'assistant 归到所属轮');
  const orphan = splitTurns([{ role: 'assistant', content: '开场白' }, { role: 'user', content: '你好' }]);
  ok(orphan.length === 2, '开头孤立的 assistant 自成一"轮"、不丢');
}

console.log('\n阈值：按「最近一次请求」占窗口的比例');
{
  const base = { contextTokens: 800, contextLimit: 1000, calls: 1 };
  ok(shouldCompress(base, { threshold: 0.8 }) === true, '80% 到阈值 → 压');
  ok(shouldCompress({ ...base, contextTokens: 700 }, { threshold: 0.8 }) === false, '70% 不到 → 不压');
  ok(shouldCompress({ ...base, calls: 0 }) === false, '没发过请求 → 不压（没有可信比例）');
  ok(shouldCompress(base, { enabled: false }) === false, '关掉开关 → 不压');
  ok(shouldCompress({ contextTokens: 1500, contextLimit: 1000, calls: 1 }, { threshold: 0.8 }), '超窗口也压');
  ok(shouldCompress(base, { threshold: 9 }) === false, '阈值被夹到 0.99 以内，不会永远不触发', '');
}

console.log('\n压缩：保留最近几轮，早前压成要点');
{
  const history = [];
  for (let i = 1; i <= 6; i++) {
    history.push({ role: 'user', content: `第 ${i} 轮需求` });
    history.push({ role: 'assistant', content: `第 ${i} 轮结果` });
  }
  const out = compressHistory(history, { keepTurns: 2, maxSummaryChars: 5000 });
  ok(out.droppedTurns === 4, '压掉 4 轮', `实际 ${out.droppedTurns}`);
  ok(out.keptTurns === 2, '留 2 轮');
  ok(out.history.length === 4, '保留的原文是 4 条消息');
  ok(contentText(out.history[0].content) === '第 5 轮需求', '从第 5 轮开始留', contentText(out.history[0].content));
  ok(out.summary.includes('第 1 轮需求') && out.summary.includes('第 2 轮需求'), '摘要里有早前的用户需求');
  ok(!out.summary.includes('第 5 轮需求'), '最近几轮不进摘要');
  ok(out.droppedChars > 0, '记下省了多少字');
  ok(summaryBullets(out.summary) === 4, '四条要点', String(summaryBullets(out.summary)));
}

console.log('\n增量压缩：上一轮摘要接着用，不重复抄');
{
  const hist = [
    { role: 'user', content: '第一件事' },
    { role: 'assistant', content: '做完了' },
    { role: 'user', content: '第二件事' },
    { role: 'assistant', content: '也做完了' },
  ];
  const first = compressHistory(hist, { keepTurns: 1 });
  ok(first.summary.includes('第一件事'), '第一次压：第一件事进摘要');

  // 第二次：历史已被替换成 [第二轮]，摘要是上次的。再补一轮后压缩
  const hist2 = [
    ...first.history,
    { role: 'user', content: '第三件事' },
    { role: 'assistant', content: '好了' },
  ];
  const second = compressHistory(hist2, { keepTurns: 1, prevSummary: first.summary });
  ok(second.summary.includes('第一件事'), '老摘要还在');
  ok(second.summary.includes('第二件事'), '新压进去的第二件事也在');
  ok(second.summary.match(/第一件事/g).length === 1, '没有重复抄第一件事');
}

console.log('\n摘要长度上限');
{
  const history = [];
  for (let i = 0; i < 40; i++) {
    history.push({ role: 'user', content: `需求 ${i} `.repeat(20) });
    history.push({ role: 'assistant', content: `结果 ${i} `.repeat(20) });
  }
  const out = compressHistory(history, { keepTurns: 2, maxSummaryChars: 800 });
  ok(out.summary.length <= 900, '摘要不超上限（含固定说明）', `实际 ${out.summary.length}`);
}

console.log('\n边界：没有旧轮次时不动');
{
  const out = compressHistory([{ role: 'user', content: '只有一轮' }], { keepTurns: 4 });
  ok(out.droppedTurns === 0, '轮次不够 → 不压');
  ok(out.history.length === 1 && out.history[0].content === '只有一轮', '原文原样返回');
  const empty = compressHistory([], {});
  ok(empty.history.length === 0 && empty.droppedTurns === 0, '空历史不炸');
}

console.log('\n默认值合理');
{
  ok(DEFAULT_COMPRESS.threshold > 0.5 && DEFAULT_COMPRESS.threshold < 1, '默认阈值在 50%–100% 之间');
  ok(DEFAULT_COMPRESS.keepTurns >= 2, '至少留 2 轮原文');
  ok(DEFAULT_COMPRESS.maxSummaryChars <= 2000, '摘要够短，不至于又撑满');
}

console.log(failed ? `\n${failed} 条没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
