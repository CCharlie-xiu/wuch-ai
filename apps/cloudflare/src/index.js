import { AuthError, handleAuth, requireAccount } from './auth.js';
import { handleAdmin } from './admin-api.js';
import { ApiError } from './errors.js';
import { handleProxy } from './proxy.js';
import { handleConversations } from './conversations-api.js';
import { handleModels } from './models-api.js';
import { handleTools } from './tools-api.js';
import { handleMemory } from './memory-api.js';
import { handleKb } from './kb-api.js';
import { handleSkills } from './skills-api.js';
import { handleFiles } from './files-api.js';
import { handleDatasets, handleExport } from './datasets-api.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-OpenUI-Token',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(status, body, extra = {}) {
  if (status === 204) return new Response(null, { status, headers: { ...CORS, ...extra } });
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

function apiOut(out) {
  if (out?.binary) {
    return new Response(out.binary, { status: out.status, headers: { ...CORS, ...(out.headers || {}) } });
  }
  return json(out.status, out.body);
}

function authFail(e) {
  if (e instanceof AuthError || e instanceof ApiError) return json(e.status, { error: e.message });
  throw e;
}

/** 尚未迁到 D1 的接口：返回空壳，让前端能进主界面而不炸 */
function stub(path, method) {
  if (path === '/endpoints' && method === 'GET') {
    return {
      status: 200,
      body: {
        endpoints: [
          { method: 'GET', path: '/health', summary: '健康检查', writes: false, params: [], query: [], body: null },
          { method: 'GET', path: '/conversations', summary: '会话列表', writes: false, params: [], query: [], body: null },
          { method: 'GET', path: '/models', summary: '模型配置', writes: false, params: [], query: [], body: null },
        ],
      },
    };
  }
  if (path === '/storage' && method === 'GET') {
    return { status: 200, body: { conversations: 0, turns: 0, contentBytes: 0, dbBytes: 0 } };
  }
  return null;
}

async function serveAssets(request, env, url) {
  if (!env.ASSETS) return new Response('ASSETS binding missing', { status: 500 });
  // /login → login.html；/intro → intro.html；/ → index.html（资产目录里已有）
  const aliases = {
    '/login': '/login.html',
    '/login/': '/login.html',
    '/intro': '/intro.html',
    '/intro/': '/intro.html',
  };
  const alias = aliases[url.pathname];
  if (alias) {
    const u = new URL(request.url);
    u.pathname = alias;
    return env.ASSETS.fetch(new Request(u, request));
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS' && (pathname.startsWith('/api/') || pathname.startsWith('/proxy'))) {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (pathname === '/proxy' || pathname.startsWith('/proxy/')) {
      try {
        await requireAccount(request, env.DB);
      } catch (e) {
        return authFail(e);
      }
      return handleProxy(request);
    }

    if (pathname.startsWith('/api/')) {
      const rest = pathname.slice('/api'.length).replace(/\/+$/, '') || '/';
      try {
        if (rest === '/health' && request.method === 'GET') {
          const accounts = await env.DB.prepare('SELECT COUNT(*) AS n FROM account').first();
          const conversations = await env.DB.prepare('SELECT COUNT(*) AS n FROM conversation WHERE deleted_at IS NULL').first();
          return json(200, {
            ok: true,
            db: 'd1',
            runtime: 'cloudflare-workers',
            accounts: accounts?.n ?? 0,
            conversations: conversations?.n ?? 0,
            slice: 'tenant+auth+conversations+models+tools+memory+kb+skills+files+datasets+proxy+static-app',
          });
        }

        if (rest.startsWith('/auth')) {
          const out = await handleAuth(request, env.DB, rest, env);
          return json(out.status, out.body);
        }

        if (rest.startsWith('/admin')) {
          const account = await requireAccount(request, env.DB);
          const out = await handleAdmin(request, env.DB, rest, env, account);
          return json(out.status, out.body);
        }

        const account = await requireAccount(request, env.DB);

        if (rest === '/skills' && request.method === 'GET') {
          const out = await handleSkills(request, env.DB, rest);
          if (out) return json(out.status, out.body);
        }
        if (rest.startsWith('/memory')) {
          const out = await handleMemory(request, env.DB, rest, url, account);
          return json(out.status, out.body);
        }
        if (rest.startsWith('/kb')) {
          const out = await handleKb(request, env.DB, rest, url, account);
          return json(out.status, out.body);
        }
        if (rest === '/models' || rest.startsWith('/models/')) {
          const out = await handleModels(request, env.DB, rest, account);
          return json(out.status, out.body);
        }
        if (rest === '/tools' || rest.startsWith('/tools/')) {
          const out = await handleTools(request, env.DB, rest, env, account);
          return json(out.status, out.body);
        }
        if (rest === '/conversations' || rest.startsWith('/conversations/')) {
          const out = await handleConversations(request, env.DB, rest, url, account);
          return apiOut(out);
        }
        if (rest.startsWith('/files/')) {
          const out = await handleFiles(request, rest, url);
          return apiOut(out);
        }
        if (rest === '/export') {
          const out = await handleExport(request);
          return apiOut(out);
        }
        if (rest === '/datasets' || rest.startsWith('/datasets/')) {
          const out = await handleDatasets(request, env.DB, rest, url, account);
          return apiOut(out);
        }

        const soft = stub(rest, request.method);
        if (soft) return json(soft.status, soft.body);

        return json(404, { error: '没有这个接口' });
      } catch (e) {
        if (e instanceof AuthError || e instanceof ApiError) return json(e.status, { error: e.message });
        console.error('[api]', request.method, pathname, e);
        return json(500, { error: '服务端出错：' + (e?.message || String(e)) });
      }
    }

    return serveAssets(request, env, url);
  },
};
