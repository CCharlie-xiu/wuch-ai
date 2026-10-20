// ─────────────────────────────────────────────────────────────────────────────
// 会话历史：存在服务端的本地 SQLite 里（apps/server/src/db.mjs），这里只是接口客户端。
//
// 读出来的一条会话 = { id, title, turnCount, headTurnId, turns, path, chain, ... }
//   turns   整棵轮次树：用户原话、OpenUI Lang 原文（续画时是补丁）、snapshot（画布完整原文）、
//           总结、失败原因、回放参数、parentId / siblings / depth（vN）、refs（数据集版本）
//   path    第一轮 → HEAD：画布当前版本的来历，也是给模型的上下文
//   chain   聊天区显示的那一支，HEAD 之后的轮次置灰
// 数据集（导入的 xlsx、编辑过的表格）也走这里：导入、按版本读、提交新版本、导出。
//
// 「当前打开的是哪个会话」是这台浏览器的界面状态，仍放 localStorage。
// ─────────────────────────────────────────────────────────────────────────────

import { authHeaders } from './accounts.js';

const LEGACY_KEY = 'openui.conversations';
const ACTIVE_KEY = 'openui.activeConversation';
const API = '/api';

export function newConversationId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('连不上服务端');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    /* 非 JSON 响应：多半是旧版服务端没有 /api */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `服务端返回 ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 页面上一轮的结局 → 库里的状态 */
const stateOf = (failure) => (!failure ? 'complete' : failure === '已取消' ? 'cancelled' : 'error');

const enc = encodeURIComponent;

/** 文件下载：响应头里的文件名优先 */
async function download(res, fallback) {
  if (!res.ok) {
    let msg = `服务端返回 ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch (e) {
      /* 不是 JSON */
    }
    throw new Error(msg);
  }
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallback;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

export function createConversationStore() {
  const dataCache = new Map(); // `${数据集}@${版本}` → { dataset, version, data }
  return {
    /** 按最近更新排在前面 */
    async list() {
      return (await request('GET', '/conversations')).conversations;
    },
    /** 本地历史占用：{ conversations, turns, bytes, dbBytes }（老服务端没有这个接口时返回 null） */
    async stats() {
      try {
        return await request('GET', '/storage');
      } catch (e) {
        return null;
      }
    },
    /** 整个会话：turns（整棵树）、path（第一轮 → HEAD）、chain（聊天区显示的那一支）、headTurnId */
    async get(id) {
      try {
        return (await request('GET', `/conversations/${enc(id)}`)).conversation;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
    /**
     * 追加一轮；会话不存在时服务端用第一句话建出来。
     * parentId 不传 = 接在服务端的 HEAD 后面；snapshot 是这一轮结束时画布的完整原文
     */
    async appendTurn(id, { user, raw, snapshot, summary, failure, opts, model, mode, parentId, refs, skills, metrics }) {
      return request('POST', `/conversations/${enc(id)}/turns`, {
        userText: user,
        raw,
        snapshot,
        summary,
        failure: failure || null,
        state: stateOf(failure),
        replay: opts,
        model: model || null,
        mode,
        parentId,
        refs,
        skills,
        metrics: metrics || undefined,
      });
    },
    /** 移动画布版本：back / forward / checkout / switch；返回移动后的整个会话 */
    async moveHead(id, op, turnId) {
      return (await request('POST', `/conversations/${enc(id)}/head`, { op, turnId })).conversation;
    },
    /** 逐轮 token 计量：打开历史会话时用来回填会话用量 */
    async metrics(id) {
      try {
        return await request('GET', `/conversations/${enc(id)}/metrics`);
      } catch (e) {
        return null; // 老服务端没有这个接口：静默降级，不挡会话打开
      }
    },
    async skillCatalog() {
      return (await request('GET', '/skills')).skills;
    },
    async skills(id) {
      return (await request('GET', `/conversations/${enc(id)}/skills`)).skills;
    },
    async setSkills(id, skills) {
      try {
        await request('PUT', `/conversations/${enc(id)}/skills`, { skills });
        return true;
      } catch (e) {
        if (e.status === 404) return false; // 会话还没建出来：第一轮存下后再补
        throw e;
      }
    },
    /** 导入 xlsx / xls / csv：请求体就是文件 */
    async importDataset(file, conversationId) {
      const q = new URLSearchParams({ name: file.name });
      if (conversationId) q.set('conversationId', conversationId);
      let res;
      try {
        res = await fetch(`${API}/datasets/import?${q}`, { method: 'POST', headers: authHeaders(), body: file });
      } catch (e) {
        throw new Error('连不上服务端');
      }
      const out = await res.json().catch(() => null);
      if (!res.ok) throw new Error((out && out.error) || `服务端返回 ${res.status}`);
      dataCache.set(`${out.dataset.id}@${out.version.id}`, out);
      return out;
    },
    async createDataset(body) {
      const out = await request('POST', '/datasets', body);
      dataCache.set(`${out.dataset.id}@${out.version.id}`, { ...out, data: body.data });
      return out;
    },
    async commitDataset(datasetId, { parentId, data, author = 'user', note = null }) {
      const { version } = await request('POST', `/datasets/${enc(datasetId)}/versions`, { parentId, data, author, note });
      const prev = parentId && dataCache.get(`${datasetId}@${parentId}`);
      if (prev) dataCache.set(`${datasetId}@${version.id}`, { dataset: prev.dataset, version, data });
      return version;
    },
    /** 某个版本的数据（不传版本取最新）；按版本缓存，版本内容不会变 */
    async readDataset(datasetId, versionId) {
      const key = versionId && `${datasetId}@${versionId}`;
      if (key && dataCache.has(key)) return dataCache.get(key);
      const q = versionId ? `?version=${enc(versionId)}` : '';
      const out = await request('GET', `/datasets/${enc(datasetId)}/data${q}`);
      dataCache.set(`${datasetId}@${out.version.id}`, out);
      return out;
    },
    /** 页面上的表格（含没存的编辑）直接导出成文件并下载 */
    async exportSheets({ name, format = 'xlsx', sheets, values }) {
      const res = await fetch(`${API}/export`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name, format, sheets, values }),
      });
      return download(res, `${name}.${format}`);
    },
    async remove(id) {
      try {
        await request('DELETE', `/conversations/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      if (this.activeId() === id) this.setActive(null);
    },
    /** 清空全部：逐个删，返回删掉的数量 */
    async clear() {
      const list = await this.list();
      for (const c of list) await this.remove(c.id);
      this.setActive(null);
      return list.length;
    },
    activeId() {
      try {
        return localStorage.getItem(ACTIVE_KEY);
      } catch (e) {
        return null;
      }
    },
    setActive(id) {
      try {
        if (id) localStorage.setItem(ACTIVE_KEY, id);
        else localStorage.removeItem(ACTIVE_KEY);
      } catch (e) {
        /* 隐私模式下写不进去，忽略 */
      }
    },
    /**
     * 早先会话存在 localStorage 里：有就搬进服务端，服务端确认收下后再删本地那份。
     * 服务端按 id 去重，半路失败下次打开页面会再试，不会重复。
     */
    async importLegacy() {
      let list;
      try {
        list = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
      } catch (e) {
        return null;
      }
      if (!Array.isArray(list) || !list.length) return null;
      const result = await request('POST', '/import/conversations', { conversations: list });
      localStorage.removeItem(LEGACY_KEY);
      return result;
    },
  };
}
