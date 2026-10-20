// LineRouter 的行分流：散文不能进编译器，界面语句不能漏。
//
// 上游是 SSE，chunk 切在哪都可能 —— 所以每个用例都用逐字 / 跨字 / 整段三种切法跑，
// 结果必须完全一致。这是这个模块唯一真正难的地方。
import { LineRouter } from '../apps/web/src/line-router.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
};

/** 按固定步长喂进去，收集分流结果 */
function route(src, { allowUi = true, uiFences = false } = {}, step = 1) {
  const r = new LineRouter({ allowUi });
  r.uiFences = uiFences;
  let ui = '';
  let text = '';
  for (let i = 0; i < src.length; i += step) {
    const out = r.push(src.slice(i, i + step));
    ui += out.ui;
    text += out.text;
  }
  const tail = r.flush();
  ui += tail.ui;
  text += tail.text;
  return { ui, text, uiSeen: r.uiSeen };
}

/** 三种切法结果一致才算稳 */
function stable(src, opts) {
  const a = route(src, opts, 1);
  const b = route(src, opts, 7);
  const c = route(src, opts, src.length || 1);
  ok(
    a.ui === b.ui && a.ui === c.ui && a.text === b.text && a.text === c.text,
    `切法无关：${JSON.stringify(src.slice(0, 28))}`,
    `1字=${JSON.stringify(a.ui)}|7字=${JSON.stringify(b.ui)}|整段=${JSON.stringify(c.ui)}`
  );
  return a;
}

console.log('\n散文不进编译器');
{
  const r = stable('把两边取对数：\nt = ln10 / ln2 ≈ 3.32\n');
  ok(r.ui === '', '算式行没被当成界面语句', JSON.stringify(r.ui));
  ok(r.text.includes('t = ln10 / ln2'), '算式留在文字回答里');
  ok(r.uiSeen === false, '一个字没写界面 → uiSeen 保持 false');

  ok(route('n = 10 次\n').ui === '', '`名字 = 数字 后面还有话` → 文字');
  ok(route('面积 = 232 元\n').ui === '', '中文标识符不是 DSL 名字 → 文字');
  ok(route('所以 t = ln10 时\n').ui === '', '行首不是名字 → 文字');
}

console.log('\n界面语句照常进编译器');
{
  const r = stable('root = column([title], "column")\ntitle = text("你好")\n');
  ok(r.ui === 'root = column([title], "column")\ntitle = text("你好")\n', '组件调用两行都进', JSON.stringify(r.ui));
  ok(r.uiSeen === true, 'uiSeen 置真');

  ok(route('n = 10\n').ui === 'n = 10\n', '整行正好是 `名字 = 数字` → 界面');
  ok(route('a = b\n').ui === 'a = b\n', '右侧是变量名（DSL 合法）→ 界面');
  ok(route('flag = null\n').ui === 'flag = null\n', '`= null` 是删除语句 → 界面');
  ok(route('items = [a, b]\n').ui === 'items = [a, b]\n', '数组 → 界面');
  ok(route('root = column([a], "column")').ui === 'root = column([a], "column")', '流断在行尾（没有换行）也要收尾');
}

console.log('\n界面与文字混排');
{
  const src = '先解释：\nt = ln10 / ln2\n\n然后是界面：\nroot = column([a], "column")\na = text("x")\n';
  const r = stable(src);
  ok(r.ui === 'root = column([a], "column")\na = text("x")\n', '只有界面那两行进编译器', JSON.stringify(r.ui));
  ok(r.text === '先解释：\nt = ln10 / ln2\n\n然后是界面：\n', '散文与空行原样留在右边', JSON.stringify(r.text));
}

console.log('\n跨行语句');
{
  const src = 'root = column([\n  a,\n  b\n], "column")\na = text("x")\n';
  const r = stable(src);
  ok(r.ui === src, '括号没闭合时下一行接着算界面', JSON.stringify(r.ui));
  ok(r.text === '', '一个字都没漏到右边');
}

console.log('\n围栏');
{
  const src = '说明一下：\n```js\nx = 1\n```\n然后：\n```openui\nroot = column([a], "column")\n```\n';
  const r = stable(src, { uiFences: true });
  ok(r.ui === 'root = column([a], "column")\n', '只取 openui 围栏里的内容', JSON.stringify(r.ui));
  ok(r.text.includes('```js') && r.text.includes('x = 1'), '别的代码块整块算文字，围栏本身也留着');
  ok(!r.ui.includes('```'), '界面围栏两边都不要');
}

console.log('\nallowUi=false（第一段只接住用户的话）');
{
  const src = 'root = column([a], "column")\na = text("x")\n';
  const r = stable(src, { allowUi: false });
  ok(r.ui === '', '界面语句一个字节都不进编译器', JSON.stringify(r.ui));
  ok(r.uiSeen === false, 'uiSeen 不会被置真');
  ok(r.text === src, '内容原样留在右边，不丢');

  const fenced = stable('```openui\nroot = column([a], "column")\n```\n', { allowUi: false });
  ok(fenced.ui === '', '围栏包着的界面也不进编译器');
  ok(fenced.text.includes('root = column([a], "column")'), '围栏内容当普通代码块留在右边');
}

console.log('\n真实素材回归（预置演示原文一字不漏地判成界面）');
{
  const { DEMOS, FOLLOWUP } = await import('@openui-lab/fixtures');
  for (const d of [...DEMOS, FOLLOWUP]) {
    const r = route(d.source, { allowUi: true, uiFences: true }, 3);
    ok(r.ui === d.source, `${d.id}：整份原文都进编译器`, `漏到右边的：${JSON.stringify(r.text.slice(0, 60))}`);
  }
}

console.log(`\n${failed ? `✗ ${failed} 条失败` : '✓ 全部通过'}\n`);
process.exit(failed ? 1 : 0);
