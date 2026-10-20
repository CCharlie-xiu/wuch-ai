// ─────────────────────────────────────────────────────────────────────────────
// 模型配置：存在服务端的本地库（apps/server/src/db.mjs 的 model_config 表），
// 这里只是接口客户端 + 一层内存缓存。可以接多个模型、多个接口地址，随时改名。
//
// 一条模型 = { id, name, provider, baseURL, apiKey, model, temperature, thinking, enabled }
//   name        显示名，随便起（「DeepSeek 快版」）
//   provider    分组名，输入框的切换列表按它分组
//   enabled     关掉的不会出现在切换列表里
// 当前用的是哪一个由服务端记（app_setting.activeModelId），所以换台浏览器打开也一样。
// ─────────────────────────────────────────────────────────────────────────────

import { authHeaders } from './accounts.js';

const API = '/api';
const enc = encodeURIComponent;
/** 旧版那份单例配置（session.js 仍在写，作为全局喜好的备份；只读一次用来搬家） */
const LEGACY_KEY = 'openui.settings';
/** 搬过一次就不再搬 */
const MIGRATED_KEY = 'openui.modelsMigrated';

const readJson = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch (e) {
    return null;
  }
};
const readFlag = (key) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch (e) {
    return true; // 读不到就当搬过了，别反复建
  }
};
const writeFlag = (key) => {
  try {
    localStorage.setItem(key, '1');
  } catch (e) {
    /* 隐私模式下写不进去，忽略 */
  }
};

/** 接口地址 → 主机名；走本地转发时显示真正的上游 */
export function hostOf(baseURL) {
  const raw = String(baseURL || '');
  const marker = '/proxy?url=';
  const i = raw.indexOf(marker);
  const target = i >= 0 ? raw.slice(i + marker.length) : raw;
  try {
    return new URL(target).host;
  } catch (e) {
    return target.slice(0, 30) || '还没填地址';
  }
}

export const isProxy = (baseURL) => String(baseURL || '').includes('/proxy?url=');

/** 列表里的第二行：模型名 · 主机名 */
export const modelSub = (m) => [m.model || '没填模型名', hostOf(m.baseURL)].join(' · ');

export function createModelStore() {
  let models = [];
  let activeId = null;

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
      /* 非 JSON 响应 */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `服务端返回 ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function snapshot() {
    return {
      models: models.slice(),
      activeId,
      active: models.find((m) => m.id === activeId) || null,
      enabled: models.filter((m) => m.enabled),
    };
  }

  function apply(out) {
    models = Array.isArray(out.models) ? out.models : [];
    activeId = out.activeId || null;
    return snapshot();
  }

  return {
    snapshot,

    async reload() {
      return apply(await request('GET', '/models'));
    },

    async create(patch) {
      const out = await request('POST', '/models', patch);
      await this.reload();
      return out.model;
    },

    async update(id, patch) {
      const out = await request('PATCH', `/models/${enc(id)}`, patch);
      await this.reload();
      return out.model;
    },

    async remove(id) {
      await request('DELETE', `/models/${enc(id)}`);
      return this.reload();
    },

    async activate(id) {
      return apply(await request('POST', `/models/${enc(id)}/activate`));
    },

    /**
     * 页面启动时调一次：
     *   1. 库里一个模型都没有、而 localStorage 里还留着旧版那份单例配置 → 搬成第一条
     *      （搬过就不再搬，否则用户把模型全删了、刷新页面又会冒出来一条）
     *   2. 当前那个不存在 / 被停用 → 落到第一个开着的
     */
    async bootstrap() {
      let snap = await this.reload();
      if (!snap.models.length && !readFlag(MIGRATED_KEY)) {
        const legacy = readJson(LEGACY_KEY);
        if (legacy && (legacy.baseURL || legacy.apiKey || legacy.model)) {
          await this.create({
            name: legacy.model || '默认模型',
            provider: '',
            baseURL: legacy.baseURL,
            apiKey: legacy.apiKey,
            model: legacy.model,
            temperature: legacy.temperature,
            thinking: legacy.thinking,
          });
          snap = await this.reload();
        }
      }
      writeFlag(MIGRATED_KEY);
      const cur = snap.active;
      if (!cur || !cur.enabled) {
        const first = snap.models.find((m) => m.enabled);
        if (first) snap = await this.activate(first.id);
      }
      return snap;
    },
  };
}
