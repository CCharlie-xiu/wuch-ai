// ─────────────────────────────────────────────────────────────────────────────
// 模型接入：OpenAI 兼容的流式接口 + 由组件目录生成的 system prompt
// ─────────────────────────────────────────────────────────────────────────────

import { generatePrompt, SKILLS } from '@openui-lab/catalog';
import { normalizeUsage } from './usage.js';
import { proxyAuthHeaders } from './accounts.js';

/** 直连上游只用 API Key；走本站 /proxy 时额外带登录态（Authorization 仍是 Key） */
function upstreamHeaders(url, apiKey, extra = {}) {
  if (String(url || '').includes('/proxy?url=')) return proxyAuthHeaders(apiKey, extra);
  return { ...extra, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

export function buildSystemPrompt(opts = {}) {
  return generatePrompt(opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 第一段：轻量对话。只带一页提示词和两个工具，简单问题直接答；
// 要画界面时调用 draw_ui，页面再拉完整的界面规范（上面那份）去画。
// ─────────────────────────────────────────────────────────────────────────────
export const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '给这一轮的界面加载一个专门技能（额外的组件和画法）。只在要画界面、且确实用得上时调用，调用后还要调用 draw_ui。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: SKILLS.map((s) => s.id), description: SKILLS.map((s) => `${s.id}：${s.name}，${s.description}`).join('；') },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_components',
      description: '列组件：不带参数看有哪些组件组；带 group 看该组里的组件名和一句话说明；带 query 按名字 / 说明搜。只回名字，不占上下文。画界面前先用它挑组件。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组 id，如 charts / table / forms / media / rich / base；技能组用 canvas / sheet' },
          query: { type: 'string', description: '按名字或说明搜，如「图表」「表格」「图片」' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_components',
      description: '按组件名取用法：签名、参数、一句话说明，配套的数据型组件会一起返回。可以分多次查，只查这一轮要用的。',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: '组件名数组，如 ["BarChart", "Table", "MetricIndicator"]' },
        },
        required: ['names'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_layout',
      description: '取当前画布的完整排布规则：列数、每列宽度、首屏块数、块高和瀑布流约束。画界面前调用一次，布局才不散。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw_ui',
      description: '在左侧画布上生成或修改界面。调用后由界面生成器接着画，你不用写界面代码。components 只写这一轮真正用到的组件名，先用 list_components / get_components 查过再写。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '一句话写清这一轮要画什么；改当前画布时写清改哪里、怎么改' },
          components: {
            type: 'array',
            items: { type: 'string' },
            description: '这一轮用到的组件名（不是组名），如 ["BarChart", "Table", "MetricIndicator", "AsyncImage"]。骨架组件（Stack / Grid / Card / TextContent 等）会自动带上，不用写。',
          },
        },
        required: ['task', 'components'],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 联网工具。声明在这里喂给模型，执行在服务端（/api/tools/*）：
// 浏览器直连搜索 API 会被 CORS 拦，Key 也不能放在页面上。
// 这两个和 load_skill / draw_ui 不同 —— 它们要把结果回灌给模型（见 session.js）。
// ─────────────────────────────────────────────────────────────────────────────
export const SEARCH_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索实时信息：新闻、股价、版本变更、最新文档。只在事实可能已经变了、或需要引用来源时用，返回若干条「标题 + 链接 + 摘录」。通用知识、概念解释、代码写法不要用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '一次搜到位的搜索词：带上年份、版本号、限定词。不要同一个意思换词重搜' },
          recency: { type: 'string', enum: ['day', 'week', 'month'], description: '要多久以内的；查最新消息用 day' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '读取一个网页的正文。只在 web_search 的摘录明显不够、缺关键细节（完整列表、代码、表格）时才用，挑最相关的一条打开。多数情况摘录就够回答了。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '确切的网址，来自搜索结果，不要自己编' },
        },
        required: ['url'],
      },
    },
  },
];

export const SEARCH_TOOL_NAMES = new Set(SEARCH_TOOLS.map((t) => t.function.name));

// ─────────────────────────────────────────────────────────────────────────────
// 知识库（AOCI）工具。和联网工具一样，声明在这里喂给模型，执行在服务端（/api/kb/*）。
//
// 入库分两步走，顺序不能颠倒：
//   kb_lookup 先查有没有 → 命中就直接引用已有条目（连正文一起返回），不要再 kb_put
//   kb_put    只在没命中时调；body 写蒸馏后的骨架，不贴原文
// ─────────────────────────────────────────────────────────────────────────────
export const KB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'kb_lookup',
      description: '入库前先查知识库里有没有同一条：按文件 hash / 标题 / 一句话摘要去重。命中会连正文一起返回，那就直接用，不要再入库。用户上传文件、或让你「记住这个」时，第一步必须调它。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '这条知识的名字（用文件名或主题名）' },
          fileHash: { type: 'string', description: '文件的 sha256（有就带，去重最准）；拿不到就不填' },
          summary: { type: 'string', description: '一句话说清它是什么，用于兜底去重' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kb_put',
      description: '把蒸馏后的知识条目写进知识库。只在 kb_lookup 没命中时调。body 按固定骨架写（何时用 / 要点 / 步骤 / 边界），是提炼后的正文，不要贴原文。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '条目的名字' },
          tag: { type: 'string', description: '标签，形如「类型+领域+价值+成熟度」，例如 流程+发布+提效+stable' },
          summary: { type: 'string', description: '一句话核心职责（进索引，模型平时只看到这一行）' },
          body: { type: 'string', description: '蒸馏正文，markdown，按「## 何时用 / ## 要点 / ## 步骤 / ## 边界」组织' },
          kind: { type: 'string', enum: ['doc', 'capability', 'note', 'snippet'], description: '条目类型，默认 doc' },
          domain: { type: 'string', description: '领域，可空' },
          maturity: { type: 'string', enum: ['draft', 'stable', 'retired'], description: '成熟度，默认 draft' },
          evidence: {
            type: 'object',
            description: '来源指针（会话 / 轮次由服务端补，这里一般只填文件名）',
            properties: { fileName: { type: 'string' }, fileHash: { type: 'string' } },
          },
        },
        required: ['name', 'summary', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kb_get',
      description: '按 id 读一条知识库条目的完整正文。索引里只有一行，需要细节时用它。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '形如 kb_xxxxxxxx，来自知识库索引' } },
        required: ['id'],
      },
    },
  },
];

export const KB_TOOL_NAMES = new Set(KB_TOOLS.map((t) => t.function.name));

/**
 * @param {object} [o]
 * @param {{version?: number}|null} [o.canvas] 画布上已经有一版界面
 * @param {object[]} [o.datasets] 会话里的数据集摘要
 * @param {boolean} [o.online] 这一轮挂了联网工具
 * @param {string} [o.memory] 跨会话记忆短块（来自 /api/memory/prompt-block）
 * @param {boolean} [o.kb] 这一轮挂了知识库（AOCI）工具
 * @param {string} [o.kbIndex] 知识库索引块（来自 /api/kb/index）
 */
/**
 * 数据集摘要 → 提示词里的一小段。对话段以前只写「名字（ds_xxx）」，
 * 模型看不到表里有什么，既答不了关于表的问题，也写不出像样的知识条目。
 * 这里带上表头与前 3 行（表体可能是几万行，不能全塞）。
 */
function datasetBrief(d) {
  const lines = (d.sheets || []).map((s) => {
    const head = (s.header || []).map((h) => String(h ?? '')).join(' | ');
    const sample = (s.sample || [])
      .slice(0, 3)
      .map((r) => `      ${JSON.stringify(r)}`)
      .join('\n');
    return `  · 工作表「${s.name}」${s.rows} 行 × ${s.cols} 列\n    表头：${head || '（空）'}${sample ? `\n    前几行：\n${sample}` : ''}`;
  });
  return `- ${d.name}（${d.id}）\n${lines.join('\n')}`;
}

export function buildChatPrompt({ canvas = null, datasets = [], online = false, memory = '', kb = false, kbIndex = '' } = {}) {
  const skills = SKILLS.map((s) => `  - \`${s.id}\`：${s.name} — ${s.description}`).join('\n');
  const mem = String(memory || '').trim();
  return `你是 wuch-ai，一个能在左侧画布上直接生成交互界面的助手。用户的话先由你接住，每一轮先判断怎么答：

- 闲聊、问答、解释、建议、改写这类，文字就能说清的：直接用中文回答，简洁，不要调用工具。回答显示在右侧窄栏（约 340px 宽），按 Markdown 渲染：分点用列表、重点用 **粗体**、分节用 ### 小标题，代码写进带语言的代码块；表格最多 3 列，别用一二级标题。
- 用界面展示明显更好的：图表、数据看板、表格、对比、计划 / 时间线、清单、表单、可交互的演示、公式和函数图像，或者用户要改当前画布 → 先查组件，再调用 \`draw_ui\`。不要自己写界面代码。
- 画界面前按这个顺序查，用到什么查什么，**不要一次把所有组件塞进上下文**：
  1. \`list_components\`：不带参数看组件组；\`{group:"charts"}\` 看组里的组件；\`{query:"图"}\` 按名字搜。
  2. \`get_components(["BarChart","Table"])\`：看签名和用法，可以分多次查。
  3. \`get_layout\`：看当前画布的列数、块高和完整排布规则。
  4. \`draw_ui(task, components)\`：components 只写这一轮真正用到的组件名；骨架组件（Stack / Grid / Card / TextContent 等）会自动带上，不用写。
- 需要专门能力时，在查组件之前先调用 \`load_skill\`：
${skills}
${online ? `
- 只有**事实可能已经变了**才搜：新闻、股价、价格、最新版本、最近事件、你知识截止之后的文档。概念解释、代码写法、通用知识、用户没问实时信息的 —— 直接答，一次都别搜。
- 搜一次就够：\`web_search\` 的 query 一次写到位（带上年份 / 版本号 / 限定词），**不要同一个意思换词重搜**，一轮最多 2 次。
- \`fetch_url\` 只在摘录明显缺关键细节时才用，一轮最多 1 次。摘录够就直接答。
- 结果会自动回给你，拿到后照常回答，或用 \`draw_ui\` 画出来。没搜到的就说没搜到，别编造事实、也别说自己搜过。` : ''}${kb ? `
- 用户上传了文件、或说「记住这个 / 存进知识库 / 以后按这个来」时，**第一步先 \`kb_lookup\`**（title 用文件名或主题名）：命中就直接引用已有条目，那条的正文已经一起给你了，**不要再 \`kb_put\`**。
- 只有 \`kb_lookup\` 没命中才 \`kb_put\`。body 按「## 何时用 / ## 要点 / ## 步骤 / ## 边界」蒸馏成要点，**不要贴原文**；summary 写一句话，它进索引，是平时唯一被看到的一行。
- 知识库索引里有、但需要细节的条目，用 \`kb_get\` 读正文，不要凭一行摘要猜。
- 纯聊天、回答问题不要入库；只在用户明确要沉淀内容时才入库。` : ''}
调用工具前可以先用一句话告诉用户你准备做什么；拿不准要不要画时，先直接回答。${canvas ? `\n\n画布上当前已经有一版界面（v${canvas.version || '?'}）。用户说「改一下」「加个」「换成」「再详细点」这类，多半是在改它 → \`draw_ui\`，task 写清改哪里。` : ''}${datasets.length ? `\n\n会话里有数据集（表体可能有几万行，这里只给表头和前几行）：\n${datasets.map(datasetBrief).join('\n')}\n要用表格展示或计算它 → \`load_skill\` sheet + \`draw_ui\`；要把这张表沉淀成知识条目 → 按上面的知识库规则走 \`kb_lookup\` / \`kb_put\`。` : ''}${mem ? `\n\n${mem}` : ''}${String(kbIndex || '').trim() ? `\n\n${String(kbIndex).trim()}` : ''}`;
}

/**
 * 流式对话。onDelta 每收到一段就回调一次 —— 上游是 SSE，逐 token 到达。
 * 支持任何 OpenAI 兼容端点：OpenAI / DeepSeek / vLLM / Ollama 的 /v1。
 */
const IDLE_MS = 90_000; // 连接还开着但这么久一个字节都没来，判定上游卡住
const QUEUE_MS = 120_000; // 只有 keep-alive 心跳、一个数据事件都没有：上游在排队，等这么久就放弃

export async function streamChat({ baseURL, apiKey, model, messages, tools, onDelta, onReasoning, onProgress, onToolCall, signal, temperature = 0.7, thinking = false, reasoningEffort = null, idleMs = IDLE_MS, queueMs = QUEUE_MS }) {
  const url = String(baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
  const body = { model, messages, stream: true, temperature };
  // 主流兼容端点支持 stream 末包带回 usage；本地 / 杂牌端点常因未知字段 400，缺 usage 时再按字符估算
  if (/openai|deepseek|anthropic|openrouter|together|groq|fireworks|azure/i.test(String(baseURL))) {
    body.stream_options = { include_usage: true };
  }
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // DeepSeek 默认开思考模式：先在 reasoning_content 里吐很久，content 才开始出 OpenUI Lang。
  // 只对 DeepSeek 发这个字段，OpenAI 等端点不认识它会直接 400。
  if (/deepseek/i.test(String(baseURL))) {
    body.thinking = { type: thinking ? 'enabled' : 'disabled' };
    // 思考强度：low / high / xhigh / max（官方还认 none；medium 与 xhigh 暂时映射到 high）。
    // 只在开着思考时发，不传就是服务端默认（high）
    if (thinking && reasoningEffort) body.reasoning_effort = reasoningEffort;
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: upstreamHeaders(url, apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(networkHint(url, e));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`上游返回 ${res.status}：${text.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // 接收过程全部计数：页面没反应时，靠这些数字分清是「没数据」「只有心跳」还是「字段不认识」
  const progress = { bytes: 0, events: 0, keepalives: 0, contentChars: 0, reasoningChars: 0, unknownKeys: [], contentType: res.headers.get('content-type') || '' };
  const report = () => onProgress && onProgress({ ...progress });
  const connectedAt = Date.now();
  let buffer = '';
  let raw = '';
  let full = '';
  let fullReasoning = ''; // 思考内容整段留着：带 tools 的 DeepSeek 请求必须原样回灌
  let usage = null; // 上游 usage；没有就按字符估算
  // 工具调用按 index 分片到达：名字先来，参数 JSON 一段段拼
  const calls = [];

  const handleJson = (json) => {
    if (json.error) throw new Error(`上游在流里返回错误：${json.error.message || JSON.stringify(json.error).slice(0, 300)}`);
    if (json.usage) {
      // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
      // OpenAI:   prompt_tokens_details.cached_tokens
      // 统一归一，端点没报的字段保持 null，界面才不会把 0 当成「全未命中」
      usage = normalizeUsage(json.usage);
    }
    const choice = json.choices?.[0];
    const d = choice?.delta ?? choice?.message;
    const reasoning = d?.reasoning_content ?? d?.reasoning ?? '';
    if (reasoning) {
      fullReasoning += reasoning;
      progress.reasoningChars += reasoning.length;
      onReasoning && onReasoning(reasoning);
    }
    const delta = d?.content ?? choice?.text ?? '';
    if (delta) {
      full += delta;
      progress.contentChars += delta.length;
      onDelta && onDelta(delta);
    }
    for (const tc of d?.tool_calls || []) {
      const i = tc.index ?? calls.length;
      const call = (calls[i] ||= { id: '', name: '', arguments: '' });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name && !call.name) {
        call.name = tc.function.name;
        onToolCall && onToolCall({ index: i, name: call.name });
      }
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
    }
    if (!reasoning && !delta && d) {
      for (const k of Object.keys(d)) if (k !== 'role' && k !== 'tool_calls' && d[k] != null && d[k] !== '' && !progress.unknownKeys.includes(k)) progress.unknownKeys.push(k);
    }
  };

  for (;;) {
    let idleTimer;
    const idle = new Promise((_, reject) => {
      idleTimer = setTimeout(() => reject(new Error(`上游连接还开着，但 ${Math.round(idleMs / 1000)} 秒没有发来任何数据（已收 ${progress.bytes} 字节、${progress.events} 个事件、${progress.keepalives} 次心跳）`)), idleMs);
    });
    let chunk;
    try {
      chunk = await Promise.race([reader.read(), idle]);
    } catch (e) {
      reader.cancel().catch(() => {});
      throw e;
    } finally {
      clearTimeout(idleTimer);
    }
    const { done, value } = chunk;
    if (done) break;
    if (!progress.events && Date.now() - connectedAt > queueMs) {
      reader.cancel().catch(() => {});
      throw new Error(`上游排队超过 ${Math.round(queueMs / 1000)} 秒（只收到 ${progress.keepalives} 次 keep-alive 心跳，没有任何内容）。多半是服务商在故障或限流，可以查一下它的状态页`);
    }
    progress.bytes += value.byteLength;
    const text = decoder.decode(value, { stream: true });
    if (!progress.events) raw += text;
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    // 一大包 SSE 里可能塞了成百个 token：同步跑完 onReasoning/onDelta 会占满主线程，
    // 思考字数停住、界面也不画。每处理一小段就让出一帧，让浏览器先刷 DOM。
    let spent = performance.now();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith(':')) {
        progress.keepalives++;
        continue;
      }
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      progress.events++;
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        continue; // 半截 JSON，丢掉
      }
      handleJson(json);
      if (performance.now() - spent > 12) {
        report();
        await new Promise((r) => setTimeout(r, 0));
        spent = performance.now();
      }
    }
    report();
  }

  // 上游没按 SSE 回（忽略了 stream: true，直接给一整个 JSON）
  if (!progress.events && raw.trim().startsWith('{')) {
    try {
      handleJson(JSON.parse(raw));
      report();
    } catch (e) {
      if (e.message.startsWith('上游')) throw e;
    }
  }
  const toolCalls = calls.filter(Boolean).map((c) => {
    let args = {};
    try {
      args = c.arguments ? JSON.parse(c.arguments) : {};
    } catch (e) {
      /* 参数写坏了：按没给参数处理 */
    }
    return { id: c.id, name: c.name, args };
  });
  // 回灌要用原始结构：{id, type, function:{name, arguments}}，模型只认这个形状
  const rawToolCalls = calls
    .filter(Boolean)
    .map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
  if (!full && !toolCalls.length) {
    const why = progress.reasoningChars
      ? `只收到 ${progress.reasoningChars} 字思考内容，没有正文`
      : progress.unknownKeys.length
        ? `收到 ${progress.events} 个事件，但里面只有这些字段：${progress.unknownKeys.join('、')}`
        : `收到 ${progress.bytes} 字节、${progress.events} 个事件，没有正文。开头：${raw.slice(0, 200)}`;
    throw new Error(`上游流结束了，但没有任何界面内容：${why}`);
  }
  if (!usage) {
    // 没有 usage 字段：按字符粗估（中英混合约 ÷3），标 estimated
    const promptChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
    const completionChars = full.length + progress.reasoningChars;
    const promptTokens = Math.max(1, Math.round(promptChars / 3));
    const completionTokens = Math.max(0, Math.round(completionChars / 3));
    usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheHitTokens: null, cacheMissTokens: null, estimated: true };
  }
  return { content: full, reasoning: fullReasoning, toolCalls, rawToolCalls, usage };
}

/**
 * fetch 抛 TypeError 时浏览器只给一句「Failed to fetch」，什么也说明不了。
 * 把最可能的三种原因直接写进错误里。
 */
function networkHint(url, e) {
  return [
    `请求没发出去（${e && e.message}）`,
    `地址：${url}`,
    '常见原因：① 官方 API 不返回 CORS 头，浏览器直连被拦 —— 改用本地转发（node server.mjs）；',
    '② 地址写错或少了 /v1；③ 断网或被代理挡了。',
  ].join('\n');
}

const trimBase = (baseURL) => String(baseURL || '').replace(/\/+$/, '');

/** 规则提示：探测 / 测试失败时，在没有可用模型做 AI 分析时用 */
export function ruleHintsForKind(kind) {
  switch (kind) {
    case 'auth':
      return ['API Key 可能不对，或这个地址不认 Bearer 鉴权。', '核对 Key 是否完整、有没有前后空格。'];
    case 'html':
      return [
        '打过去像是网页/文档页，不是 JSON API。',
        '常见原因：地址少了 /v1、打到了官网首页、或网关把未知路径重定向到了文档。',
        '本应用只认 OpenAI 兼容的 /chat/completions；Anthropic 原生 /v1/messages 暂不支持。',
      ];
    case 'shape':
      return [
        '返回了 JSON，但不是 OpenAI 兼容的 chat/completions 结构。',
        '若像 Anthropic（type: message、content 数组），需要兼容网关，或改成带 /v1 的 OpenAI 形地址。',
      ];
    case 'network':
      return [
        '请求没发出去：多半是 CORS、地址写错，或服务没起来。',
        '官方 API 常缺 CORS —— 用设置里的「改成本地转发地址」，并确保 bun run dev 在跑。',
      ];
    default:
      return ['检查接口地址是否以 /v1 结尾、模型名是否存在、Key 是否有效。'];
  }
}

/**
 * 把上游响应归类，供设置页决定要不要拉 AI 纠错。
 * kind: ok | auth | html | shape | network | http
 */
export function classifyUpstreamResponse({ status, contentType = '', bodyText = '', ok = false }) {
  const ct = String(contentType || '').toLowerCase();
  const text = String(bodyText || '');
  const head = text.trim().slice(0, 200).toLowerCase();
  const snippet = text.slice(0, 1200);

  const looksHtml =
    ct.includes('text/html') ||
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    (head.startsWith('<') && /<\/(html|head|body|title)>/i.test(text.slice(0, 800)));

  if (looksHtml) {
    return {
      kind: 'html',
      status,
      contentType: ct,
      snippet,
      message: `上游返回了网页而不是 API JSON（HTTP ${status || '—'}）`,
      hints: ruleHintsForKind('html'),
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      status,
      contentType: ct,
      snippet,
      message: `鉴权失败（HTTP ${status}）`,
      hints: ruleHintsForKind('auth'),
    };
  }

  // 成功且无正文（测试连接取消了 body）
  if ((ok || (status >= 200 && status < 300)) && !text.trim()) {
    return { kind: 'ok', status, contentType: ct, snippet: '', message: `连接正常（HTTP ${status}）` };
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    /* 非 JSON */
  }

  if (json && typeof json === 'object') {
    const anthropicLike =
      json.type === 'message' ||
      (json.type === 'error' && typeof json.error === 'object' && json.error?.type) ||
      (Array.isArray(json.content) && json.content.some((c) => c && (c.type === 'text' || c.type === 'tool_use')));
    const openaiChat = Array.isArray(json.choices) || json.object === 'chat.completion' || json.object === 'chat.completion.chunk';
    const openaiModels = (json.object === 'list' && Array.isArray(json.data)) || Array.isArray(json.data);
    const openaiErr = json.error && (json.error.message || json.error.code);

    if (anthropicLike && !openaiChat && !openaiModels) {
      return {
        kind: 'shape',
        status,
        contentType: ct,
        snippet,
        message: '响应结构像 Anthropic，不是 OpenAI 兼容接口',
        hints: ruleHintsForKind('shape'),
        json,
      };
    }
    if (openaiChat || openaiModels) {
      return { kind: 'ok', status, contentType: ct, snippet: '', message: `连接正常（HTTP ${status}）`, json };
    }
    if (!ok && status >= 400) {
      return {
        kind: 'http',
        status,
        contentType: ct,
        snippet,
        message: openaiErr
          ? `HTTP ${status}：${String(json.error.message || json.error.code).slice(0, 240)}`
          : `HTTP ${status}：${snippet.slice(0, 240)}`,
        hints: ruleHintsForKind('http'),
        json,
      };
    }
    if (!ok) {
      return {
        kind: 'shape',
        status,
        contentType: ct,
        snippet,
        message: `返回了 JSON，但结构不像 OpenAI 兼容接口（HTTP ${status}）`,
        hints: ruleHintsForKind('shape'),
        json,
      };
    }
    // 2xx 但结构陌生：仍标 shape，方便纠错
    return {
      kind: 'shape',
      status,
      contentType: ct,
      snippet,
      message: `返回了 JSON，但结构不像 OpenAI 兼容接口（HTTP ${status}）`,
      hints: ruleHintsForKind('shape'),
      json,
    };
  }

  if (ok || (status >= 200 && status < 300)) {
    return { kind: 'ok', status, contentType: ct, snippet: '', message: `连接正常（HTTP ${status}）` };
  }

  if (status) {
    return {
      kind: 'http',
      status,
      contentType: ct,
      snippet,
      message: `HTTP ${status}：${snippet.slice(0, 240) || '无正文'}`,
      hints: ruleHintsForKind('http'),
    };
  }

  return {
    kind: 'http',
    status: 0,
    contentType: ct,
    snippet,
    message: snippet.slice(0, 240) || '未知响应',
    hints: ruleHintsForKind('http'),
  };
}

/**
 * GET {baseURL}/models —— 空态探测用。
 * @returns {{ kind: string, models?: {id:string, name?:string}[], message: string, hints?: string[], snippet?: string, status?: number }}
 */
export async function listRemoteModels({ baseURL, apiKey }) {
  const url = trimBase(baseURL) + '/models';
  if (!trimBase(baseURL)) {
    return { kind: 'http', message: '先填接口地址', hints: ['例如 https://api.openai.com/v1 或本地转发地址'] };
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: upstreamHeaders(url, apiKey, { Accept: 'application/json' }),
    });
  } catch (e) {
    return {
      kind: 'network',
      message: networkHint(url, e),
      hints: ruleHintsForKind('network'),
      status: 0,
    };
  }
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text().catch(() => '');
  const classified = classifyUpstreamResponse({
    status: res.status,
    contentType,
    bodyText: text,
    ok: res.ok,
  });

  if (classified.kind === 'ok' || (res.ok && classified.json)) {
    const json = classified.json || (() => {
      try {
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    })();
    const rows = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : Array.isArray(json)
          ? json
          : [];
    const models = rows
      .map((r) => {
        const id = String(r?.id || r?.name || r?.model || '').trim();
        if (!id) return null;
        return { id, name: String(r?.name || r?.id || id).trim() };
      })
      .filter(Boolean);
    if (!models.length) {
      return {
        kind: 'shape',
        status: res.status,
        message: '接口通了，但列表里没有模型 id',
        hints: ruleHintsForKind('shape'),
        snippet: text.slice(0, 1200),
        models: [],
      };
    }
    return { kind: 'ok', status: res.status, message: `探测到 ${models.length} 个模型`, models };
  }

  // 鉴权失败等：沿用分类
  if (classified.kind === 'auth' || classified.kind === 'html' || classified.kind === 'shape' || classified.kind === 'network') {
    return { ...classified, models: [] };
  }
  return { ...classified, models: [] };
}

/**
 * 设置面板「测试连接」：发 1 token 请求，返回结构化结果（不再抛字符串 Error；网络错误也收进 kind）。
 * @returns {{ kind: string, message: string, status?: number, snippet?: string, hints?: string[], contentType?: string }}
 */
export async function testConnection({ baseURL, apiKey, model }) {
  const url = trimBase(baseURL) + '/chat/completions';
  if (!trimBase(baseURL)) {
    return { kind: 'http', message: '先填接口地址', hints: ruleHintsForKind('http') };
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders(url, apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
  } catch (e) {
    return {
      kind: 'network',
      message: networkHint(url, e),
      hints: ruleHintsForKind('network'),
      status: 0,
    };
  }

  // 2xx：只验连得上、鉴权过；取消 body，避免流式端点拖很久
  if (res.ok) {
    try {
      await res.body?.cancel();
    } catch (e) {
      /* 已读完 */
    }
    return { kind: 'ok', status: res.status, message: `连接正常（HTTP ${res.status}）` };
  }

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text().catch(() => '');
  return classifyUpstreamResponse({
    status: res.status,
    contentType,
    bodyText: text,
    ok: false,
  });
}

/**
 * 用已可用的模型分析一次失败响应，建议改表单。不进会话、不走 OpenUI 编译。
 * @param {{ analyzer: { baseURL: string, apiKey: string, model: string }, failed: { kind: string, status?: number, contentType?: string, snippet?: string, message?: string }, userBaseURL: string, userModel: string }}
 * @returns {{ diagnosis: string, suggestedBaseURL?: string, suggestedModel?: string, hints: string[] }}
 */
export async function diagnoseUpstream({ analyzer, failed, userBaseURL, userModel }) {
  const a = analyzer || {};
  if (!trimBase(a.baseURL) || !a.model) {
    throw new Error('没有可用的分析模型');
  }
  const url = trimBase(a.baseURL) + '/chat/completions';
  const payload = {
    kind: failed?.kind,
    status: failed?.status,
    contentType: failed?.contentType,
    message: failed?.message,
    bodySnippet: String(failed?.snippet || '').slice(0, 1600),
    userBaseURL: String(userBaseURL || ''),
    userModel: String(userModel || ''),
  };
  const system = [
    '你是 API 接入助手。用户在配置 OpenAI 兼容的 chat 接口时失败了。',
    '根据失败响应判断原因，并给出可执行的修改建议。',
    '本应用只支持 OpenAI 兼容：Authorization Bearer + POST {base}/chat/completions，以及 GET {base}/models。',
    '不支持 Anthropic 原生 /v1/messages；若响应像 Anthropic，请明确说明并建议改用兼容网关或改 baseURL。',
    '只输出一个 JSON 对象，不要 markdown 围栏，字段：',
    '{"diagnosis":"一两句中文说明","suggestedBaseURL":"可选，改后的完整 baseURL","suggestedModel":"可选","hints":["短句建议",...]}',
    '没有把握就不要填 suggested*；hints 最多 4 条。',
  ].join('\n');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders(url, a.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: a.model,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    });
  } catch (e) {
    throw new Error(networkHint(url, e));
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`分析模型返回 ${res.status}：${text.slice(0, 200)}`);

  let content = '';
  try {
    const json = JSON.parse(text);
    content = json.choices?.[0]?.message?.content || json.choices?.[0]?.text || '';
  } catch (e) {
    content = text;
  }
  content = String(content || '').trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(content);
  if (fence) content = fence[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // 模型没按 JSON 回：整段当诊断
    return {
      diagnosis: content.slice(0, 400) || failed?.message || '分析失败',
      hints: failed?.hints || ruleHintsForKind(failed?.kind),
    };
  }
  const hints = Array.isArray(parsed.hints)
    ? parsed.hints.map((h) => String(h).trim()).filter(Boolean).slice(0, 4)
    : [];
  return {
    diagnosis: String(parsed.diagnosis || failed?.message || '已分析').slice(0, 500),
    suggestedBaseURL: parsed.suggestedBaseURL ? String(parsed.suggestedBaseURL).trim() : undefined,
    suggestedModel: parsed.suggestedModel ? String(parsed.suggestedModel).trim() : undefined,
    hints: hints.length ? hints : ruleHintsForKind(failed?.kind),
  };
}

/** 模型有时会把 OpenUI Lang 包在围栏里，这里剥掉 */
export function stripFences(text) {
  const t = String(text || '').trim();
  const m = /^```(?:openui(?:-lang)?|ui|html)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1] : t;
}
