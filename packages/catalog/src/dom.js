// ─────────────────────────────────────────────────────────────────────────────
// 组件渲染共用的 DOM 小工具。只在 render.create / update 里被调用，
// 模块加载时不碰 document，所以服务端 import 目录（生成提示词）也安全。
// ─────────────────────────────────────────────────────────────────────────────

import { TOKENS } from './tokens.js';

const ICONS = {
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  check: 'M4 12l5 5L20 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  play: 'M6 4l14 8-14 8z',
  pause: 'M8 5v14M16 5v14',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  star: 'M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8h.01M11 12h1v5h1',
  warning: 'M12 3l9 16H3zM12 9v5M12 17h.01',
  plus: 'M12 5v14M5 12h14',
  sparkles: 'M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  cart: 'M3 5h2l2.4 10.4A2 2 0 0 0 9.4 17h8.2a2 2 0 0 0 2-1.6L21 8H6M10 21h.01M18 21h.01',
  calendar: 'M4 6h16v15H4zM4 10h16M9 3v4M15 3v4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 14H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21 10h.1a2 2 0 1 1 0 4H21',
  external: 'M14 4h6v6M20 4l-8 8M18 14v6H4V6h6',
  dot: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
};

export const ICON_NAMES = Object.keys(ICONS);

export function icon(name, cls = 'icon') {
  const d = ICONS[name] || ICONS.dot;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);

/** 只放行 http(s) 绝对地址，返回规范化后的字符串；其他（javascript: / data: / 半截地址）返回 null */
export function httpUrl(s) {
  try {
    const u = new URL(String(s ?? '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * 流式时字符串参数（比如 URL）一个字一个字长出来，每变一次组件就重建。
 * 停笔 ms 毫秒、且节点仍在文档里时才执行 fn，免得拿半截地址发请求；被替换掉的旧节点不会执行。
 */
export function whenSettled(node, fn, ms = 350, tries = 30) {
  setTimeout(() => {
    if (node.isConnected) fn();
    else if (tries > 1) whenSettled(node, fn, ms, tries - 1);
  }, ms);
}

/** 秒 → m:ss / h:mm:ss */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

export const px = (v) => (typeof v === 'number' ? v + 'px' : v ?? '');

export const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : String(n ?? ''));

export function styleVars(node, props) {
  if (props.maxWidth && props.maxWidth !== 'full') node.style.maxWidth = TOKENS.maxWidth[props.maxWidth] || '';
}

/** 文字的 color / size / weight → data-tc / data-ts / data-tw（样式在 styles.js），没给的清掉 */
export function textAttrs(node, { color, size, weight } = {}) {
  node.classList.add('tx');
  const set = (k, v, table) => {
    if (v && Object.hasOwn(table, v)) node.dataset[k] = v;
    else delete node.dataset[k];
  };
  set('tc', color === 'default' ? null : color, TOKENS.textColor);
  set('ts', size, TOKENS.textSize);
  set('tw', weight, TOKENS.textWeight);
}

/** 迷你 Markdown（MarkDownRenderer 用）：先转义再替换，模型写不进任意 HTML */
export function mdToHtml(src) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const lines = String(src ?? '').split('\n');
  const out = [];
  let list = null;
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (h) {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
    } else if (li) {
      if (list !== 'ul') {
        if (list) out.push(`</${list}>`);
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (line.trim() === '') {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    } else {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}
