// ─────────────────────────────────────────────────────────────────────────────
// 假上游：一个 OpenAI 兼容的 /v1/chat/completions，按 SSE 把 OpenUI Lang 吐出来。
// 零依赖，用来在**没有 API Key** 的情况下把「接真模型」这条路验穿。
//
//   node mock-model.mjs           # http://127.0.0.1:8789/v1
//
// 设置里接口地址填 http://127.0.0.1:8789/v1（本机直连不涉及 CORS），
// 或经转发：http://127.0.0.1:8788/proxy?url=http://127.0.0.1:8789/v1
//
// 它按关键词挑一条预置 OpenUI Lang 回放，所以效果和演示页一样，但走的是
// 「HTTP 请求 → SSE 流 → 页面解析 → 编译 → 沙箱 → 渲染」这条真实路径。
//
// 它照着真实模型的契约演，两段分开：
//   第一段（轻量对话）→ 要画界面就先调 draw_ui，不自己写界面代码；
//                       纯文字问题则直接答。
//   第二段（拿到界面规范）→ 才把 OpenUI Lang 流出来。
// 两段靠 system 提示词区分：第一段里有「不要自己写界面代码」这句，第二段没有。
// 不这么演的话，「模型自己在对话里写界面」会被当成正常路径，掩盖真正的问题。
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { DEMOS } from '@openui-lab/fixtures';

const PORT = Number(process.env.MOCK_PORT || 8789);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const ROUTES = [
  [/费用|价格|席位|pricing|定价|多少钱/, 'team-plan'],
  [/晚餐|羊|菜单|dinner|recipe|做饭/, 'dinner'],
  [/仪表盘|分析|dashboard|指标|图表|数据/, 'dashboard'],
  [/背心|狗|宠物|moodboard|设计方向|风格/, 'moodboard'],
  [/上线|发布|灰度|回滚|时间线|部署|release/, 'release'],
];

// 纯文字回答，但正文里带着一行长得像界面语句的算式。
// 这一行必须留在右栏，不能被当成 OpenUI Lang 送进编译器 —— 否则左侧会重编、报诊断。
const PROSE = `换底公式的做法是两边取自然对数，再用 ln 的性质拆开：

t = ln10 / ln2 ≈ 3.32

所以以 2 为底，10 的对数约等于 3.32。这个 3.32 就是换算倍数：二进制位数乘 3.32 就是十进制位数。`;

const PROSE_ROUTE = /换底|对数|ln10|log2|换算倍数/;

const lastUser = (messages) => {
  const users = messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
  return users[users.length - 1] || '';
};

/** 第一段还是第二段：第一段的提示词里有「不要自己写界面代码」 */
const isChatSegment = (messages) => {
  const sys = messages.find((m) => m.role === 'system');
  return !!sys && /不要自己写界面代码/.test(String(sys.content || ''));
};

function pickDemo(text) {
  const low = text.toLowerCase();
  for (const [re, id] of ROUTES) {
    if (re.test(low)) {
      const hit = DEMOS.find((d) => d.id === id);
      if (hit) return hit;
    }
  }
  return DEMOS[0];
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-openui-1', object: 'model' }] }));
  }

  if (!req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '只有 /v1/chat/completions 和 /v1/models' } }));
  }

  const body = await readBody(req);
  const messages = body.messages || [];
  const text = lastUser(messages);
  const demo = pickDemo(text);
  const chat = isChatSegment(messages);
  const prose = chat && PROSE_ROUTE.test(text);

  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const head = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model || 'mock-openui-1' };
  const chunk = (delta, finish = null) => ({ ...head, choices: [{ index: 0, delta, finish_reason: finish }] });
  const end = (finish) => {
    send(chunk({}, finish));
    res.write('data: [DONE]\n\n');
    res.end();
  };

  // 首块给个角色，和真上游一致
  send(chunk({ role: 'assistant' }));

  // 第一段要画界面：按契约先调 draw_ui，界面代码留给第二段
  if (chat && !prose) {
    send(chunk({ content: '这个用界面展示更清楚，我来画。' }));
    send(chunk({ tool_calls: [{ index: 0, id: 'call_draw_1', type: 'function', function: { name: 'draw_ui', arguments: '' } }] }));
    // 不写 components：这样页面会带上全部组件组，演示界面才画得全
    const args = JSON.stringify({ task: demo.prompt });
    setTimeout(() => {
      send(chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }));
      end('tool_calls');
    }, 120);
    return;
  }

  const source = prose ? PROSE : demo.source;
  let i = 0;
  const step = () => {
    if (i >= source.length) return end('stop');
    const size = 2 + Math.floor(Math.random() * 7);
    send(chunk({ content: source.slice(i, i + size) }));
    i += size;
    setTimeout(step, 8 + Math.random() * 18);
  };
  step();

  req.on('close', () => {
    i = source.length;
  });
});

server.listen(PORT, () => {
  console.log(`假上游  http://127.0.0.1:${PORT}/v1  （OpenAI 兼容，流式 OpenUI Lang）`);
});
