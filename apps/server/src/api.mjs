// ─────────────────────────────────────────────────────────────────────────────
// /api/* 路由：会话列表与会话记录。请求体、响应体都是 JSON。
//
// 路由表同时是接口目录：GET /api/endpoints 原样吐给前端设置页的「数据库接口列表」，
// 加接口只改这张表，前端调试面板自动出现。
// ─────────────────────────────────────────────────────────────────────────────

import { RepoError, createSkillRepo, createDatasetRepo, createModelRepo, checkTableData } from './db.mjs';
import { readTable, writeTable, baseName, extOf, IMPORT_LIMIT, MIME } from './xlsx.mjs';
import { extractText, EXTRACT_LIMIT } from './files.mjs';
import { createToolSettings, webSearch, fetchUrl } from './tools.mjs';
import { createMemoryRepo } from './memory.mjs';
import { createKnowledgeRepo } from './kb.mjs';

export const API_PREFIX = '/api/';
const BODY_LIMIT = 8 * 1024 * 1024;

/** body 是 Buffer 时原样发（文件下载），否则按 JSON */
function reply(res, status, body, headers, extra) {
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers, ...extra });
    return res.end(body);
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers, ...extra });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new RepoError(413, `请求体太大（上限 ${Math.round(limit / 1024 / 1024)}MB）`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, BODY_LIMIT);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new RepoError(400, '请求体不是合法 JSON');
  }
}

/** 下载文件名：中文名用 RFC 5987 编码 */
function attachment(name, format) {
  const file = `${name}.${format}`;
  return {
    'Content-Type': MIME[format],
    'Content-Disposition': `attachment; filename="${file.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(file)}`,
  };
}

/** '/conversations/:id/turns' → 正则 + 参数名 */
function compilePath(p) {
  const names = [];
  const src = p
    .slice(1)
    .split('/')
    .map((seg) => (seg.startsWith(':') ? (names.push(seg.slice(1)), '([^/]+)') : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return { re: new RegExp(`^${src}$`), names };
}

export function createApi({ repo, db = null, headers = {}, skills = db && createSkillRepo(db), datasets = db && createDatasetRepo(db), models = db && createModelRepo(db), tools = createToolSettings(db), memory = createMemoryRepo(db), kb = createKnowledgeRepo(db) }) {
  const needDatasets = () => {
    if (!datasets) throw new RepoError(503, '没有接数据库，数据集不可用');
    return datasets;
  };
  const needModels = () => {
    if (!models) throw new RepoError(503, '没有接数据库，模型配置不可用');
    return models;
  };
  const routes = [
    {
      method: 'GET',
      path: '/health',
      summary: '服务与数据库是否就绪',
      run: () => {
        const info = { ok: true, db: 'ready' };
        if (db) {
          info.file = db.location() || ':memory:';
          info.schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
        }
        return [200, info];
      },
    },
    {
      method: 'GET',
      path: '/endpoints',
      summary: '接口目录（就是这张列表的数据来源）',
      run: () => [200, { endpoints: catalog }],
    },
    {
      method: 'GET',
      path: '/conversations',
      summary: '会话列表，按最近更新倒序',
      query: [
        { name: 'limit', example: '50', hint: '1–200，默认 50' },
        { name: 'before', example: '', hint: '翻页：上一页最后一条的 updatedAt' },
      ],
      run: ({ query }) => [200, { conversations: repo.list({ limit: query.get('limit'), before: query.get('before') }) }],
    },
    {
      method: 'GET',
      path: '/conversations/:id',
      summary: '单个会话：全部轮次 + 拼好的模型上下文',
      run: ({ params }) => {
        const conversation = repo.get(params.id);
        return conversation ? [200, { conversation }] : [404, { error: '会话不存在' }];
      },
    },
    {
      method: 'PATCH',
      path: '/conversations/:id',
      summary: '改会话标题',
      writes: true,
      body: { title: '新标题' },
      run: async ({ params, req }) => {
        const { title } = await readJson(req);
        return repo.rename(params.id, title) ? [204] : [404, { error: '会话不存在' }];
      },
    },
    {
      method: 'DELETE',
      path: '/conversations/:id',
      summary: '删除会话（软删除）',
      writes: true,
      run: ({ params }) => (repo.remove(params.id) ? [204] : [404, { error: '会话不存在' }]),
    },
    {
      method: 'POST',
      path: '/conversations/:id/turns',
      summary: '追加一轮；会话不存在就用第一句话建出来。可选 metrics 记 token，并触发记忆摄入',
      writes: true,
      body: {
        userText: '调试：做一个待办列表',
        raw: 'root = Card([TextContent("调试数据")])',
        state: 'complete',
        summary: [{ title: '界面已生成', text: '来自接口调试', refs: [] }],
        failure: null,
        replay: null,
        model: null,
        metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, contextUsage: 0.1, estimated: false },
      },
      run: async ({ params, req }) => {
        const body = await readJson(req);
        const out = repo.appendTurn(params.id, body);
        if (memory) {
          if (body.metrics) memory.recordMetrics(params.id, out.turnId, body.metrics);
          out.memory = memory.ingestTurn({ conversationId: params.id, turnId: out.turnId, userText: body.userText });
        }
        return [201, out];
      },
    },
    {
      method: 'POST',
      path: '/conversations/:id/head',
      summary: '移动画布版本 HEAD：back 上一版 / forward 下一版 / checkout 跳到某一轮 / switch 换到某个分支',
      writes: true,
      body: { op: 'back', turnId: null },
      run: async ({ params, req }) => {
        const conversation = repo.moveHead(params.id, await readJson(req));
        return conversation ? [200, { conversation }] : [404, { error: '会话不存在' }];
      },
    },
    {
      method: 'GET',
      path: '/conversations/:id/head-log',
      summary: 'HEAD 移动记录（类似 git reflog），新的在前',
      query: [{ name: 'limit', example: '50', hint: '1–500' }],
      run: ({ params, query }) => [200, { log: repo.headLog(params.id, query.get('limit')) }],
    },
    {
      method: 'GET',
      path: '/skills',
      summary: '技能目录（内置 + 外部）',
      run: () => [200, { skills: skills ? skills.list() : [] }],
    },
    {
      method: 'GET',
      path: '/models',
      summary: '模型配置列表 + 当前用的是哪一个',
      run: () => [200, needModels().snapshot()],
    },
    {
      method: 'POST',
      path: '/models',
      summary: '新增一个模型配置（第一个会自动成为当前）',
      writes: true,
      body: { name: 'DeepSeek', provider: 'DeepSeek', baseURL: 'https://api.deepseek.com', apiKey: 'sk-…', model: 'deepseek-chat', temperature: 0.7, thinking: true, enabled: true },
      run: async ({ req }) => [201, { model: needModels().create(await readJson(req)) }],
    },
    {
      method: 'PATCH',
      path: '/models/:id',
      summary: '改一个模型配置（改名 / 换地址 / 换 Key / 开关）',
      writes: true,
      body: { name: 'DeepSeek 快版', enabled: false },
      run: async ({ params, req }) => [200, { model: needModels().update(params.id, await readJson(req)) }],
    },
    {
      method: 'DELETE',
      path: '/models/:id',
      summary: '删一个模型配置（删的是当前那个就自动落到下一个可用的）',
      writes: true,
      run: ({ params }) => (needModels().remove(params.id) ? [204] : [404, { error: '模型不存在' }]),
    },
    {
      method: 'POST',
      path: '/models/:id/activate',
      summary: '切换当前使用的模型（只能切到开着的）',
      writes: true,
      run: ({ params }) => {
        needModels().setActive(params.id);
        return [200, needModels().snapshot()];
      },
    },
    {
      method: 'GET',
      path: '/conversations/:id/skills',
      summary: '会话里选中的技能',
      run: ({ params }) => [200, { skills: repo.skills(params.id) }],
    },
    {
      method: 'PUT',
      path: '/conversations/:id/skills',
      summary: '整体替换会话里选中的技能（按会话粘滞）',
      writes: true,
      body: { skills: ['sheet'] },
      run: async ({ params, req }) => (repo.setSkills(params.id, (await readJson(req)).skills) ? [204] : [404, { error: '会话不存在' }]),
    },
    {
      method: 'GET',
      path: '/conversations/:id/datasets',
      summary: '会话里的数据集',
      run: ({ params }) => [200, { datasets: needDatasets().listForConversation(params.id) }],
    },
    {
      method: 'POST',
      path: '/datasets/import',
      summary: '导入 xlsx / xls / csv：请求体就是文件本身（≤10MB），文件名放在 ?name=',
      writes: true,
      query: [
        { name: 'name', example: '销售.xlsx', hint: '原文件名，决定按什么格式解析' },
        { name: 'conversationId', example: '', hint: '挂到哪个会话（可空）' },
      ],
      run: async ({ query, req }) => {
        const name = query.get('name') || '';
        if (!['xlsx', 'xls', 'csv'].includes(extOf(name))) throw new RepoError(415, '只支持 .xlsx / .xls / .csv（?name= 带上原文件名）');
        const body = await readBody(req, IMPORT_LIMIT);
        if (!body.length) throw new RepoError(400, '文件是空的');
        const data = readTable(body, name);
        const out = needDatasets().create({
          conversationId: query.get('conversationId') || null,
          name: baseName(name),
          data,
          author: 'import',
          note: `导入 ${name}`,
          source: { body, mime: MIME[extOf(name)], name },
        });
        return [201, { ...out, data }];
      },
    },
    {
      method: 'POST',
      path: '/files/extract',
      summary: '抽文件正文：请求体就是文件本身（≤32MB），文件名放在 ?name=。pdf / docx / pptx / odt / ods / odp 与常见文本，只读不落盘',
      writes: false,
      query: [
        { name: 'name', example: '需求文档.pdf', hint: '原文件名，决定按什么格式解析' },
        { name: 'maxChars', example: '200000', hint: '正文上限，默认 20 万字' },
      ],
      run: async ({ query, req }) => {
        const body = await readBody(req, EXTRACT_LIMIT);
        return [200, await extractText({ name: query.get('name') || '', body, maxChars: query.get('maxChars') })];
      },
    },
    {
      method: 'POST',
      path: '/datasets',
      summary: '用表格数据新建数据集（比如把画布上的内联表格存下来）',
      writes: true,
      body: { conversationId: null, name: '调试表', data: { sheets: [{ name: 'Sheet1', cells: [['月', '量'], ['1月', 3]] }] }, author: 'user' },
      run: async ({ req }) => [201, needDatasets().create(await readJson(req))],
    },
    {
      method: 'GET',
      path: '/datasets/:id',
      summary: '数据集信息 + 版本链',
      run: ({ params }) => [200, { dataset: needDatasets().get(params.id) }],
    },
    {
      method: 'POST',
      path: '/datasets/:id/versions',
      summary: '在某个版本上提交新版本（用户编辑 / AI 改写）',
      writes: true,
      body: { parentId: null, data: { sheets: [{ name: 'Sheet1', cells: [['月', '量']] }] }, author: 'user', note: null },
      run: async ({ params, req }) => [201, { version: needDatasets().commit(params.id, await readJson(req)) }],
    },
    {
      method: 'GET',
      path: '/datasets/:id/data',
      summary: '某个版本的表格数据（不传 version 取最新）',
      query: [{ name: 'version', example: '', hint: 'dv_xxx' }],
      run: ({ params, query }) => [200, needDatasets().read(params.id, query.get('version') || null)],
    },
    {
      method: 'GET',
      path: '/datasets/:id/export',
      summary: '导出某个版本为 xlsx / csv 文件',
      query: [
        { name: 'version', example: '', hint: 'dv_xxx，不传取最新' },
        { name: 'format', example: 'xlsx', hint: 'xlsx / csv' },
      ],
      run: ({ params, query }) => {
        const format = query.get('format') || 'xlsx';
        const { dataset, data } = needDatasets().read(params.id, query.get('version') || null);
        return [200, writeTable(data, format), attachment(dataset.name, format)];
      },
    },
    {
      method: 'POST',
      path: '/export',
      summary: '把页面上的表格（含没存的编辑、内联表）直接导出成文件',
      writes: false,
      body: { name: '表格', format: 'xlsx', sheets: [{ name: 'Sheet1', cells: [['月', '量'], ['1月', 3]] }], values: null },
      run: async ({ req }) => {
        const { name = '表格', format = 'xlsx', sheets, values = null } = await readJson(req);
        const data = { sheets };
        checkTableData(data);
        return [200, writeTable(data, format, values), attachment(String(name).slice(0, 80) || '表格', format)];
      },
    },
    {
      method: 'POST',
      path: '/import/conversations',
      summary: '导入浏览器 localStorage 里的旧会话，按 id 去重',
      writes: true,
      body: { conversations: [] },
      run: async ({ req }) => [200, repo.importLegacy((await readJson(req)).conversations)],
    },

    // ── 记忆：跨会话 L2 + Token 计量 + 排除列表 ──────────────────────────
    {
      method: 'GET',
      path: '/memory/settings',
      summary: '记忆设置：启用 / 计入画像 / 置信度门槛',
      run: () => [200, memory.settings()],
    },
    {
      method: 'PUT',
      path: '/memory/settings',
      summary: '改记忆设置',
      writes: true,
      body: { enabled: true, includeInProfile: true, confidenceThreshold: 0.5 },
      run: async ({ req }) => [200, memory.updateSettings(await readJson(req))],
    },
    {
      method: 'GET',
      path: '/memory/items',
      summary: '记忆条目列表（原子陈述 + 置信度，不含原文）',
      query: [{ name: 'limit', example: '100', hint: '1–500' }],
      run: ({ query }) => [200, { items: memory.list({ limit: query.get('limit') }) }],
    },
    {
      method: 'POST',
      path: '/memory/items/:id/confirm',
      summary: '确认一条记忆（进画像）',
      writes: true,
      run: ({ params }) => [200, { item: memory.confirm(params.id) }],
    },
    {
      method: 'POST',
      path: '/memory/items/:id/reject',
      summary: '否定一条记忆（同指纹屏蔽）',
      writes: true,
      run: ({ params }) => [200, { item: memory.reject(params.id) }],
    },
    {
      method: 'PATCH',
      path: '/memory/items/:id',
      summary: '编辑记忆陈述',
      writes: true,
      body: { statement: '偏好：暗色主题', type: 'preference' },
      run: async ({ params, req }) => [200, { item: memory.edit(params.id, await readJson(req)) }],
    },
    {
      method: 'GET',
      path: '/memory/profile',
      summary: '用户画像标签',
      run: () => [200, { tags: memory.profile() }],
    },
    {
      method: 'DELETE',
      path: '/memory/profile',
      summary: '清空画像标签（危险）',
      writes: true,
      run: () => [200, memory.clearProfile()],
    },
    {
      method: 'GET',
      path: '/memory/exclusions',
      summary: '不计入记忆 / 画像的会话列表',
      run: () => [200, { exclusions: memory.exclusions() }],
    },
    {
      method: 'PUT',
      path: '/memory/exclusions/:conversationId',
      summary: '设置会话是否排除出记忆',
      writes: true,
      body: { excluded: true },
      run: async ({ params, req }) => {
        const { excluded } = await readJson(req);
        memory.setExcluded(params.conversationId, excluded !== false);
        return [200, { exclusions: memory.exclusions() }];
      },
    },
    {
      method: 'GET',
      path: '/conversations/:id/metrics',
      summary: '会话的 token 计量',
      run: ({ params }) => [200, memory.metricsFor(params.id)],
    },
    {
      method: 'GET',
      path: '/memory/prompt-block',
      summary: '可注入 system 的记忆短块（调试用；会顺带做每日衰减）',
      query: [{ name: 'limit', example: '12', hint: '最多条数' }],
      run: ({ query }) => [200, { block: memory.promptBlock({ limit: query.get('limit') }) }],
    },
    {
      method: 'GET',
      path: '/conversations/:id/summary',
      summary: '会话 L1 摘要（窗口压缩用，不含用户原文）',
      run: ({ params }) => {
        const summary = memory.getSummary(params.id);
        return summary ? [200, summary] : [200, { conversationId: params.id, summary: '', updatedAt: null }];
      },
    },
    {
      method: 'POST',
      path: '/conversations/:id/summary/rebuild',
      summary: '根据轮次 summary 重建本会话 L1',
      writes: true,
      run: ({ params }) => {
        const summary = memory.rebuildSummary(params.id);
        return summary ? [200, summary] : [404, { error: '会话不存在' }];
      },
    },
    {
      method: 'POST',
      path: '/memory/decay',
      summary: '立即对全部记忆做一次半衰期衰减',
      writes: true,
      run: () => [200, memory.decay()],
    },

    // ── 工具：给模型的联网能力。声明在 TOOL_META，执行在下面两个接口 ──────
    {
      method: 'GET',
      path: '/tools',
      summary: '工具目录：联网搜索 / 读取网页，含开关与授权方式',
      run: () => [200, tools ? tools.snapshot() : { tavilyKey: '', tools: {} }],
    },
    {
      method: 'PUT',
      path: '/tools',
      summary: '改工具设置：开关（enabled）、授权方式（auto 自动 / ask 每次询问）、Tavily Key',
      writes: true,
      body: { tools: { web_search: { enabled: true, approval: 'auto' } }, tavilyKey: '' },
      run: async ({ req }) => [200, tools.update(await readJson(req))],
    },
    {
      method: 'POST',
      path: '/tools/web_search',
      summary: '联网搜索：返回标题 + 链接 + 摘录，不给整页（有 Tavily Key 走 Tavily，否则走必应 RSS）',
      body: { query: 'React 19 有什么 breaking change', recency: 'week', maxResults: 5 },
      run: async ({ req }) => {
        const s = tools.snapshot();
        if (!s.tools.web_search?.enabled) throw new RepoError(403, '联网搜索已关闭（设置页 · 工具里打开）');
        return [200, await webSearch({ ...(await readJson(req)), tavilyKey: s.tavilyKey })];
      },
    },
    {
      method: 'POST',
      path: '/tools/fetch_url',
      summary: '读一个网页：只取正文，不加载 CSS / JS / 图片（llms.txt → Tavily → Jina → 自己抠）',
      body: { url: 'https://example.com/article', maxChars: 8000 },
      run: async ({ req }) => {
        const s = tools.snapshot();
        if (!s.tools.fetch_url?.enabled) throw new RepoError(403, '读取网页已关闭（设置页 · 工具里打开）');
        return [200, await fetchUrl({ ...(await readJson(req)), tavilyKey: s.tavilyKey })];
      },
    },

    // ── 知识库：AOCI 条目。存蒸馏产物，不存原文；入库前先 lookup 去重 ──────
    {
      method: 'POST',
      path: '/kb/lookup',
      summary: '入库前查重：按文件 hash / 标题 / 摘要找已有条目，命中连正文一起返回',
      body: { title: '产品需求文档', fileHash: '', summary: '' },
      run: async ({ req }) => [200, kb.lookup(await readJson(req))],
    },
    {
      method: 'POST',
      path: '/kb/items',
      summary: '建知识条目（模型蒸馏产物）。内部先查重，命中就返回已有条目，不重复建',
      writes: true,
      body: { name: '灰度发布流程', tag: '流程+发布', summary: '一句话核心职责', body: '## 何时用\n…', evidence: { conversationId: '', turnId: '', fileName: '', fileHash: '' } },
      run: async ({ req }) => [201, kb.create(await readJson(req))],
    },
    {
      method: 'GET',
      path: '/kb/items',
      summary: '知识条目列表（索引行 + 命中次数 + 证据条数）',
      query: [
        { name: 'limit', example: '100', hint: '1–500' },
        { name: 'status', example: 'active', hint: 'active / archived / all' },
      ],
      run: ({ query }) => [200, { items: kb.list({ limit: query.get('limit'), status: query.get('status') || 'active' }) }],
    },
    {
      method: 'GET',
      path: '/kb/items/:id',
      summary: '单条：索引行 + 蒸馏正文 + 证据指针',
      run: ({ params }) => [200, kb.get(params.id)],
    },
    {
      method: 'POST',
      path: '/kb/search',
      summary: '索引检索：只扫 name / summary / tag，正文要用 GET /kb/items/:id 取',
      body: { query: '发布流程', limit: 20 },
      run: async ({ req }) => [200, { items: kb.search(await readJson(req)) }],
    },
    {
      method: 'GET',
      path: '/kb/index',
      summary: '索引清单（一行一条，注入 system prompt 用）',
      query: [{ name: 'limit', example: '40', hint: '1–80' }],
      run: ({ query }) => {
        const items = kb.index({ limit: query.get('limit') });
        return [200, { items, block: kb.promptBlock({ limit: query.get('limit') }) }];
      },
    },
    {
      method: 'PATCH',
      path: '/kb/items/:id',
      summary: '改条目：名字 / 标签 / 一句话 / 归档状态',
      writes: true,
      body: { tag: '流程+发布', summary: '改过的一句话', status: 'active' },
      run: async ({ params, req }) => [200, { item: kb.patch(params.id, await readJson(req)) }],
    },
    {
      method: 'DELETE',
      path: '/kb/items/:id',
      summary: '软删知识条目（置为 archived）',
      writes: true,
      run: ({ params }) => (kb.archive(params.id) ? [204] : [404, { error: '知识条目不存在' }]),
    },
  ].map((r) => ({ ...r, ...compilePath(r.path) }));

  const catalog = routes.map((r) => ({
    method: r.method,
    path: r.path,
    summary: r.summary,
    writes: !!r.writes,
    params: r.names,
    query: r.query || [],
    body: r.body === undefined ? null : r.body,
  }));

  return async function handleApi(req, res) {
    if (req.method === 'OPTIONS') return reply(res, 204, undefined, headers);
    const url = new URL(req.url, 'http://localhost');
    const rest = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '');
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(rest);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      try {
        const [status, body, extra] = await r.run({ params, query: url.searchParams, req });
        return reply(res, status, body, headers, extra);
      } catch (e) {
        if (e instanceof RepoError) return reply(res, e.status, { error: e.message }, headers);
        console.error('[api]', req.method, url.pathname, e);
        return reply(res, 500, { error: '服务端出错：' + e.message }, headers);
      }
    }
    return reply(res, pathMatched ? 405 : 404, { error: pathMatched ? '不支持这个方法' : '没有这个接口' }, headers);
  };
}
