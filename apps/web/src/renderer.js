// ─────────────────────────────────────────────────────────────────────────────
// 第 4 层 · 渲染
//
// 宿主页面把操作应用到自己的组件树上。每个 CREATE 实例化一个原生组件，
// 页面把变化做成动画。页面只接受已知组件类型的操作，所以模型输出
// 不可能带进任意 markup 或样式。
//
// 组件实现不在这里：每个组件的 render 和它的签名写在同一个文件里
// （packages/catalog/src/components/*.js），这里只按目录取用。
//
// 交互方向相反：用户点击 / 拖动 → 页面按 action 约定交给宿主，
// 或把处理器的标识符和参数发回 worker。全程没有模型调用。
// ─────────────────────────────────────────────────────────────────────────────

import { COMPONENTS, BASE_CSS } from '@openui-lab/catalog';
import { el } from '@openui-lab/catalog/dom.js';
import { propsToObject } from '@openui-lab/protocol';

/** 组件名 → 渲染实现。数据型组件（Series 等）只是参数里的对象，不会单独出现在 DOM 里 */
const R = Object.fromEntries(
  COMPONENTS.map((def) => [def.name, def.data ? { dataOnly: true, create: () => document.createComment(def.name) } : def.render])
);

/** 共用样式 + 组件自带的样式，只注入一次 */
let cssInjected = false;
function injectComponentCss() {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const css = [BASE_CSS, ...COMPONENTS.filter((d) => d.css).map((d) => `/* ${d.name} */\n${d.css}`)].join('\n');
  const style = document.createElement('style');
  style.dataset.openui = 'components';
  style.textContent = css;
  document.head.appendChild(style);
}

/** 渲染器实际实现的组件名。测试用它和目录做一致性校验。 */
export const RENDERED = Object.keys(R);

// ─────────────────────────────────────────────────────────────────────────────
// 渲染器
// ─────────────────────────────────────────────────────────────────────────────
export function createRenderer(host, opts) {
  injectComponentCss();
  const nodes = new Map(); // id → {id, type, props, el, parent, children:number[]}
  const order = new Map(); // parentId → [ids]
  let settleQueue = [];
  const stats = { ops: 0, creates: 0, sets: 0, places: 0, removes: 0, texts: 0, bytes: 0, lastOpCount: 0 };

  function ctxFor(node) {
    return {
      node,
      childRecords: (node.children || []).map((id) => nodes.get(id)).filter(Boolean),
      resolve: (id) => (opts.resolve ? opts.resolve(id) : null),
      emit: (kind, value) => emitEvent(node, kind, value),
      /** 组件找宿主办事（不经过沙箱，比如表格编辑落库、导入导出文件） */
      host: (kind, payload) => (opts.onHost ? opts.onHost(kind, payload, node) : undefined),
    };
  }

  /** 组件把交互回吐给宿主：先找 onXxx 处理器，其次按 action 约定 */
  function emitEvent(node, kind, value) {
    const props = node.props || {};
    const handlerName = { change: 'onChange', click: 'onClick', select: 'onSelect' }[kind];
    const handler = handlerName ? props[handlerName] : null;
    if (handler && handler.fn) {
      opts.onFnCall(handler.fn, [value]);
      return;
    }
    // 表单控件：写进表单数据，交给最近的 Form
    if (kind === 'change' && node.__formName) {
      opts.onFormInput(node.__formName, value);
      return;
    }
    const action = props.action;
    if (action) {
      opts.onAction(action, { value, node });
      return;
    }
    opts.onUnhandled(node, kind, value);
  }

  function buildNode(record) {
    const props = propsToObject(record.props);
    if (record.type === '#text') {
      const node = { id: record.id, type: '#text', props, parent: record.parent, children: [], el: null };
      nodes.set(record.id, node);
      const t = document.createTextNode(props.value != null ? String(props.value) : '');
      node.el = t;
      node.slot = t;
      return t;
    }
    const spec = R[record.type];
    if (!spec) {
      const unknown = el('div', 'unknown', `未知组件 ${record.type}`);
      unknown.__slot = unknown;
      return unknown;
    }
    const node = { id: record.id, type: record.type, props, parent: record.parent, children: [], el: null };
    nodes.set(record.id, node);
    const dom = spec.create(props, ctxFor(node));
    node.el = dom;
    node.slot = dom.__slot || dom;
    node.spec = spec;
    return dom;
  }

  function domOf(id) {
    const n = nodes.get(id);
    return n ? n.el : null;
  }

  function slotOf(id) {
    if (id === 0) return host;
    const n = nodes.get(id);
    if (!n) return host;
    return n.slot || n.el;
  }

  function insertAt(parentId, childId, index) {
    const parent = parentId === 0 ? null : nodes.get(parentId);
    const list = parent ? parent.children : rootChildren;
    const elChild = domOf(childId);
    if (!elChild) return;
    const from = list.indexOf(childId);
    if (from >= 0) list.splice(from, 1);
    list.splice(index, 0, childId);
    const slot = slotOf(parentId);
    const ref = list[index + 1] != null ? domOf(list[index + 1]) : null;
    // 数据型组件被误写到子节点位置时不进 DOM
    const childNode = nodes.get(childId);
    if (childNode && childNode.spec && childNode.spec.dataOnly) return;
    try {
      if (ref && ref.parentNode === slot) slot.insertBefore(elChild, ref);
      else slot.appendChild(elChild);
    } catch (e) {
      if (opts.onRenderError) {
        opts.onRenderError({
          where: 'insertAt',
          parentId,
          childId,
          childType: childNode && childNode.type,
          slot: slot === host ? '#host' : slot.tagName || slot.nodeType,
          contains: typeof slot.contains === 'function' ? slot.contains(elChild) : null,
          message: e.message,
        });
      }
    }
  }

  function applyOp(op) {
    stats.lastOpCount++;
    if (op.op === 'CREATE') {
      stats.creates++;
      const dom = buildNode(op);
      insertAt(op.parent, op.id, op.index);
      const node = nodes.get(op.id);
      // 需要等子节点到齐再同步的组件（Tabs 铺标签栏）→ 收尾时再同步一次
      if (node && node.spec && node.spec.needsChildSync) settleQueue.push(op.id);
      const parentRec = op.parent ? nodes.get(op.parent) : null;
      if (parentRec && parentRec.spec && parentRec.spec.needsChildSync) settleQueue.push(parentRec.id);
      // 表单控件：把 name 登记到最近的 Form
      if (node && node.props && node.props.name) {
        node.__formName = node.props.name;
        let p = node.parent;
        while (p) {
          const pn = nodes.get(p);
          if (!pn) break;
          if (pn.type === 'Form') {
            node.__formKey = (pn.props.id || 'form') + '.' + node.props.name;
            break;
          }
          p = pn.parent;
        }
      }
      if (dom && dom.setAttribute) markNode(dom, { id: op.id, props: propsToObject(op.props) });
    } else if (op.op === 'SET') {
      stats.sets++;
      const node = nodes.get(op.id);
      if (!node) return;
      const prev = { ...node.props };
      for (const [k, v] of op.props) node.props[k] = v;
      if (node.type === '#text') {
        node.el.textContent = node.props.value != null ? String(node.props.value) : '';
        return;
      }
      const spec = node.spec;
      // update 只原位处理它声明过的属性；流式中其他属性也会变（半截参数被补全），那就整块重建
      const inPlace = spec && spec.update && op.props.every(([k]) => spec.updates.includes(k));
      if (inPlace) spec.update(node.el, node.props, prev, ctxFor(node));
      else if (spec) replaceInPlace(node, prev);
    } else if (op.op === 'PLACE') {
      stats.places++;
      insertAt(op.parent, op.id, op.index);
    } else if (op.op === 'REMOVE') {
      stats.removes++;
      removeNode(op.id);
    } else if (op.op === 'TEXT') {
      stats.texts++;
      const node = nodes.get(op.id);
      if (node && node.el) node.el.textContent = op.value;
    }
  }

  /** 通用更新：新建一个外壳，把已有子节点搬过去，再原位替换 */
  function replaceInPlace(node, prevProps) {
    const spec = node.spec;
    if (!spec || !spec.create) return;
    const old = node.el;
    const fresh = spec.create(node.props || {}, ctxFor(node));
    const freshSlot = fresh.__slot || fresh;
    for (const cid of node.children) {
      const c = nodes.get(cid);
      if (c && c.el && c.el.parentNode) freshSlot.appendChild(c.el);
    }
    node.el = fresh;
    node.slot = freshSlot;
    if (old.parentNode) old.parentNode.replaceChild(fresh, old);
    if (fresh.setAttribute) markNode(fresh, node);
  }

  /** data-var = OpenUI Lang 里的变量名，右侧总结的引用靠它定位 */
  function markNode(dom, node) {
    dom.setAttribute('data-node', String(node.id));
    if (node.props && node.props.__var) dom.setAttribute('data-var', node.props.__var);
  }

  function removeNode(id) {
    const node = nodes.get(id);
    if (!node) return;
    for (const cid of [...node.children]) removeNode(cid);
    const parent = node.parent ? nodes.get(node.parent) : null;
    const list = parent ? parent.children : rootChildren;
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    if (node.el && node.el.parentNode) node.el.parentNode.removeChild(node.el);
    nodes.delete(id);
  }

  let rootChildren = [];

  function settle() {
    const seen = new Set();
    while (settleQueue.length) {
      const id = settleQueue.shift();
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      const k = nodes.get(id);
      if (k && k.spec && k.spec.needsChildSync && k.spec.update) k.spec.update(k.el, k.props, k.props, ctxFor(k));
    }
  }

  // 一大批 CREATE（Canvas 示意图、长 Markdown）同步落 DOM 会堵几帧：
  // 思考字数停、侧栏也不滚。按时间片切开，每片结束让浏览器先画。
  // 注意：worker 下发的是相对上一版的 diff，必须按序完整落完，不能跳过中间 revision。
  const OP_BUDGET_MS = 8;
  let applyToken = 0; // reset / 换轮次时 ++，作废还在跑的分帧批次

  return {
    applyOps(decoded, byteLength) {
      stats.lastOpCount = 0;
      if (byteLength) stats.bytes += byteLength;
      for (const op of decoded) {
        try {
          applyOp(op);
        } catch (e) {
          if (opts.onRenderError) opts.onRenderError({ where: 'applyOp', op: op.op, message: e.message });
        }
      }
      settle();
      stats.ops += decoded.length;
      return stats.lastOpCount;
    },
    /** 分帧落盘；调用方需串行排队。reset 会作废进行中的批次 */
    applyOpsAsync(decoded, byteLength) {
      const token = applyToken;
      stats.lastOpCount = 0;
      if (byteLength) stats.bytes += byteLength;
      if (!decoded.length) {
        settle();
        return Promise.resolve(0);
      }
      let i = 0;
      return new Promise((resolve) => {
        const step = () => {
          if (token !== applyToken) return resolve(0);
          const t0 = performance.now();
          while (i < decoded.length && performance.now() - t0 < OP_BUDGET_MS) {
            try {
              applyOp(decoded[i]);
            } catch (e) {
              if (opts.onRenderError) opts.onRenderError({ where: 'applyOp', op: decoded[i].op, message: e.message });
            }
            i++;
          }
          if (i < decoded.length) {
            requestAnimationFrame(step);
            return;
          }
          settle();
          stats.ops += decoded.length;
          resolve(stats.lastOpCount);
        };
        step();
      });
    },
    cancelPendingApply() {
      applyToken++;
    },
    reset() {
      applyToken++;
      for (const id of [...nodes.keys()]) {
        const n = nodes.get(id);
        if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el);
      }
      nodes.clear();
      rootChildren = [];
      settleQueue = [];
      host.innerHTML = '';
      stats.ops = 0;
      stats.creates = 0;
      stats.sets = 0;
      stats.places = 0;
      stats.removes = 0;
      stats.texts = 0;
      stats.bytes = 0;
    },
    stats,
    nodeCount: () => nodes.size,
    /** 调试用：把内部节点表摊出来（检视器也用它） */
    debugNodes() {
      return [...nodes.values()].map((n) => ({
        id: n.id,
        type: n.type,
        parent: n.parent,
        children: [...n.children],
        props: n.props,
        inDom: !!(n.el && n.el.parentNode),
        text: n.el ? (n.el.nodeType === 3 ? n.el.data : n.el.textContent) : null,
      }));
    },
    setFormInput(key, value) {
      // 表单值由渲染器侧记录，提交时拼成 issueNewTurn 文本
      if (!this.__form) this.__form = {};
      this.__form[key] = value;
    },
    getForm() {
      return this.__form || {};
    },
    clearForm() {
      this.__form = {};
    },
    formNode(formId) {
      for (const n of nodes.values()) if (n.type === 'Form' && n.props.id === formId) return n;
      return null;
    },
    fieldValues(formId) {
      const out = {};
      for (const n of nodes.values()) {
        if (!n.__formKey || !n.__formKey.startsWith(formId + '.')) continue;
        const dom = n.el;
        if (!dom) continue;
        const name = n.props.name;
        if (dom.type === 'checkbox') out[name] = dom.checked;
        else if (dom.value != null) out[name] = dom.value;
      }
      return out;
    },
  };
}
