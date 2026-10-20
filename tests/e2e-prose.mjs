// 端到端验证：纯文字回答那一轮，左侧画布不该被改动，也不该出诊断。
//
// 用假上游（MOCK_PORT=8790 的 mock.mjs，散文路由）跑真实链路：
//   页面 → 会话内核 → LineRouter 分流 → 编译器 → 沙箱 worker → 渲染器
//
// 断言的是页面上的真实状态，不是单元测试里的中间值。
//
// 前置：dev 服务在 8788、假上游在 8790，另需 playwright-core 与本机 Chromium。
// 没装 playwright-core 就跳过（不失败）。
//
//   PW_CORE=<playwright-core 的绝对路径> CHROME=<Chromium 可执行文件> \
//     bun tests/e2e-prose.mjs
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '';
const DEFAULT_CHROME = `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const CHROME = process.env.CHROME || DEFAULT_CHROME;
const APP = process.env.E2E_APP || 'http://127.0.0.1:8788/';
const MOCK = process.env.E2E_MOCK || 'http://127.0.0.1:8790/v1';

async function loadChromium() {
  const tries = [
    process.env.PW_CORE,
    `${HOME}/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.mjs`,
    'playwright-core',
  ].filter(Boolean);
  for (const t of tries) {
    try {
      const m = await import(t);
      const found = m.chromium || (m.default && m.default.chromium);
      if (found) return found;
    } catch (e) {
      /* 换下一个 */
    }
  }
  return null;
}

const chromium = await loadChromium();
if (!chromium) {
  console.log('跳过：没找到 playwright-core（设 PW_CORE 指向它的 index.js）');
  process.exit(0);
}
if (!fs.existsSync(CHROME)) {
  console.log(`跳过：没找到 Chromium（${CHROME}）`);
  process.exit(0);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// 主应用有登录门禁（见 apps/web/index.html 头部门禁脚本）：先塞一个本地 mock 账号，
// 否则 goto('/') 会被重定向到 /login，后面的 waitForFunction 永远等不到 session。
await page.addInitScript(() => {
  localStorage.setItem(
    'wuch-ai.accounts',
    JSON.stringify([{ id: 'acc_e2e', name: 'E2E', email: 'e2e@local', provider: 'email', joinedAt: 1 }]),
  );
  localStorage.setItem('wuch-ai.current', 'acc_e2e');
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__openui && window.__openui.session, null, { timeout: 20000 });

// 指向假上游：只在运行时改这一份设置，不碰服务端库里的模型配置
await page.evaluate((mock) => {
  window.__openui.session.applyModel({
    id: 'e2e-mock', name: 'e2e-mock', baseURL: mock, apiKey: '', model: 'mock-openui-1', temperature: 0.7, thinking: false,
  });
}, MOCK);

// 等沙箱 worker 就绪，否则界面渲染不出来
await page.waitForFunction(() => window.__openui.session.state.ready, null, { timeout: 20000 });

const snap = () =>
  page.evaluate(() => {
    const s = window.__openui.session;
    const st = s.snapshot();
    const turn = [...document.querySelectorAll('#messages .turn')].pop();
    return {
      raw: s.server.raw,
      source: st.source,
      elements: st.stats?.elements ?? 0,
      diagnostics: (st.diagnostics || []).length,
      status: turn?.querySelector('.turn-status')?.textContent ?? '(无)',
      canvasBadge: document.querySelector('#canvas-badge')?.textContent ?? '(无)',
      replyText: turn?.querySelector('.reply-text')?.textContent?.slice(0, 160) ?? '',
      stageHtml: document.querySelector('#stage')?.innerHTML.length ?? 0,
      routeSteps: [...(turn?.querySelectorAll('.turn-step') ?? [])].map((n) => n.textContent.trim()),
    };
  });

const say = async (text) => {
  await page.evaluate((p) => window.__openui.session.runTurn(p), text);
  await page.waitForFunction(() => !window.__openui.session.state.running, null, { timeout: 40000 });
  await page.waitForTimeout(800);
  return snap();
};

const fails = [];

// 第 1 轮：正常画一版界面 —— 门控不能把这条路误伤掉
const drawn = await say('做一个团队版的费用估算，能填席位数看月费');
console.log('\n──── 第 1 轮：画界面 ────');
console.log(JSON.stringify(drawn, null, 2));
if (!(drawn.elements > 0)) fails.push(`画界面那轮应该出组件，实际 ${drawn.elements} 个`);
if (!drawn.raw.trim()) fails.push('画界面那轮 raw 不该为空');
if (drawn.diagnostics) fails.push(`画界面那轮不该有诊断，实际 ${drawn.diagnostics} 条`);

// 第 2 轮：画布上已有界面，来一轮纯文字 —— 这一轮必须什么都不动
const prose = await say('换底公式 ln10 除以 ln2 怎么算');
console.log('\n──── 第 2 轮：纯文字（画布上已有界面）────');
console.log(JSON.stringify(prose, null, 2));
if (prose.raw.trim() !== '') fails.push(`raw 应该是空的，实际 ${JSON.stringify(prose.raw)}`);
if (prose.diagnostics !== 0) fails.push(`不该有诊断，实际 ${prose.diagnostics} 条`);
if (prose.elements !== drawn.elements) fails.push(`组件数变了：${drawn.elements} → ${prose.elements}`);
// 纯文字路径会走 mergeSource(base, '')，按语句重新拼一遍：语义相同、行尾空白会被规整。
// 这是原来就有的行为，所以比语义不比字节。
if (prose.source.trim() !== drawn.source.trim()) fails.push('画布原文被改动了');
if (prose.stageHtml !== drawn.stageHtml) fails.push(`画布 DOM 变了：${drawn.stageHtml} → ${prose.stageHtml}`);
if (!/画布未改动/.test(prose.status)) fails.push(`状态行应该是「直接回答 · 画布未改动」，实际「${prose.status}」`);
if (!prose.replyText.includes('ln10 / ln2')) fails.push('右栏应该保留那行算式');
if (!prose.routeSteps.some((s) => s.startsWith('直接回答'))) fails.push(`路由步骤应该是「直接回答」，实际 ${JSON.stringify(prose.routeSteps)}`);

// 第 3 轮：再来一次纯文字，确认不是一次性的
const again = await say('再讲讲 log2 的换算倍数怎么用');
console.log('\n──── 第 3 轮：再一轮纯文字 ────');
console.log(JSON.stringify(again, null, 2));
if (again.raw.trim() !== '') fails.push(`第三轮 raw 应该是空的，实际 ${JSON.stringify(again.raw)}`);
if (again.elements !== drawn.elements) fails.push(`第三轮组件数变了：${drawn.elements} → ${again.elements}`);
if (again.diagnostics !== 0) fails.push(`第三轮不该有诊断，实际 ${again.diagnostics} 条`);

console.log('\n──── 控制台 ────');
console.log(logs.slice(-12).join('\n') || '(无)');

if (fails.length) {
  console.log('\n✗ ' + fails.join('\n✗ '));
  process.exitCode = 1;
} else {
  console.log('\n✓ 画界面照常；两轮纯文字都没碰画布、没出诊断，算式留在右栏');
}

await page.screenshot({ path: 'tests/e2e-prose.png', fullPage: false });
await browser.close();
