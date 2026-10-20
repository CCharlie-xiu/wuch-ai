// ─────────────────────────────────────────────────────────────────────────────
// 输入框的附件：传图 / 传文件。三条入口共用同一套逻辑：
//   ① 回形针按钮 / 「+」菜单 → 文件选择框
//   ② 拖到输入框上 → 输入框自己变成虚线投放区（.composer.drop-on）
//   ③ 在输入框里直接粘贴（⌘V）→ 剪贴板里的图片
//
// 一个附件 = { id, kind, name, size, status, sha256?, ... }
//   image  图片：带缩略图，发送时作为多模态内容（image_url）交给模型
//   sheet  表格：交给宿主导入成数据集（xlsx / xls / csv），原文里只留引用
//   doc    文档：pdf / docx / pptx / odt / ods / odp —— 交给服务端抽出正文（见 files.mjs）
//   text   文本：内容读进消息正文
//   file   其他（压缩包 / 老版 .doc 等）：只带文件名，内容不解析
//
// 每个附件都算一次 sha256：知识库按文件去重要用它，模型拿不到字节、只能照抄。
// 模块只负责「攒、画、组装」；导入表格、抽文档正文、发消息由页面（chat.js）接线。
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MB = 25;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const INLINE_TEXT_MAX = 20_000; // 塞进消息正文的上限，超了截断

const ICON = {
  file: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  sheet: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M3 15h18M9 4v16"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function humanSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 服务端能抽正文的文档格式（与 apps/server/src/files.mjs 的 SUPPORTED 对齐） */
const DOC_EXT = /\.(pdf|docx|pptx|odt|ods|odp)$/i;

function kindOf(file) {
  const name = file.name || '';
  if (/^image\//i.test(file.type) && !/svg/i.test(file.type)) return 'image';
  if (/\.(xlsx|xls|csv|tsv)$/i.test(name)) return 'sheet';
  if (DOC_EXT.test(name)) return 'doc';
  if (/^text\//i.test(file.type)) return 'text';
  if (/\.(md|markdown|json|ya?ml|log|xml|html?|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|css|scss|sh|sql|ini|toml|env)$/i.test(name)) return 'text';
  return 'file';
}

const readAs = (file, how) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读不出来'));
    r[how](file);
  });

// ── 文件块 ↔ 正文 ───────────────────────────────────────────────────────────
// build() 把附件正文拼成「【文件 名字｜sha256 …】\n正文」塞进消息。这些块要发给
// 模型，但**不该原样铺在气泡里** —— 一份两万字的 md 会把整段对话刷掉。
// 展示时用 splitFileBlocks 剥出来收进文件位；发给模型 / 重发用的仍是完整原文。

const FILE_HEAD = /^【文件 (.+?)(?:｜sha256 ([0-9a-f]{8,128}))?】(.*)$/;

/**
 * 把一条消息拆成「用户自己写的话」+「附件块」。
 * @param {string} message
 * @returns {{text: string, files: {name: string, sha256: string, body: string}[]}}
 */
export function splitFileBlocks(message) {
  const files = [];
  const keep = [];
  let cur = null;
  for (const line of String(message || '').split('\n')) {
    const m = FILE_HEAD.exec(line);
    if (m) {
      if (cur) files.push(cur);
      cur = { name: m[1], sha256: m[2] || '', body: m[3] ? [m[3]] : [] };
      continue;
    }
    (cur ? cur.body : keep).push(line);
  }
  if (cur) files.push(cur);
  return {
    text: keep.join('\n').trim(),
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, body: f.body.join('\n').trim() })),
  };
}

/** 附件的 sha256（知识库按文件去重靠它）。算不出来就返回空串，不影响别的流程 */
async function sha256Hex(buf) {
  try {
    if (!globalThis.crypto?.subtle) return '';
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return '';
  }
}

/**
 * @param {object} o
 * @param {HTMLElement} o.box                附件 chip 容器
 * @param {HTMLElement} o.zone               投放区（就是输入框 #composer）
 * @param {HTMLTextAreaElement} o.prompt     输入框（粘贴图片用）
 * @param {(file: File) => Promise<{datasetId, versionId, name, sheets}>} o.importSheet
 * @param {(file: File, buf: ArrayBuffer) => Promise<{text, chars, truncated, via, pages}>} o.extractDoc
 * @param {(item: object) => void} [o.onRemove] 用户点 × 移除时回调（页面据此撤掉数据集引用）
 * @param {(item: object) => void} [o.onStore] 用户点「存」时回调：把这份文件交给模型走入库流程
 * @param {(text: string) => void} [o.onNotice]
 */
export function createAttachments({ box, zone, prompt, importSheet, extractDoc, onRemove, onStore, onNotice }) {
  const items = [];
  let dragDepth = 0;
  const notice = (t) => onNotice && onNotice(t);
  const ready = () => items.filter((i) => i.status === 'ready');

  function render() {
    box.textContent = '';
    for (const it of items) box.appendChild(chip(it));
    box.hidden = !items.length;
  }

  function chip(it) {
    const c = el('span', 'attach-chip' + (it.status === 'reading' ? ' busy' : '') + (it.status === 'error' ? ' bad' : ''));
    c.title = `${it.name}${it.size ? ` · ${humanSize(it.size)}` : ''}`;

    if (it.kind === 'image' && it.dataURL) {
      const img = el('img', 'attach-thumb');
      img.src = it.dataURL;
      img.alt = it.name;
      img.title = '点开看大图';
      img.addEventListener('click', () => preview(it));
      c.appendChild(img);
    } else {
      const ic = el('span', 'attach-icon');
      if (it.status === 'reading') ic.appendChild(el('span', 'attach-spin'));
      else ic.innerHTML = it.kind === 'sheet' ? ICON.sheet : ICON.file;
      c.appendChild(ic);
    }

    c.appendChild(el('span', 'attach-name', it.name));
    c.appendChild(el('span', 'attach-size', it.status === 'reading' ? '读取中' : it.status === 'error' ? '读取失败' : humanSize(it.size)));

    // 内容拿得到的附件都给「存」：图片走多模态，文本 / 文档的正文在内存里，
    // 表格是数据集（模型能从表头与前几行蒸馏）。只有读不了的格式（file）没有。
    if (onStore && it.kind !== 'file') {
      const store = el('button', 'attach-store', '存');
      store.type = 'button';
      store.title = `把「${it.name}」存入知识库（先查重，未命中再蒸馏入库）`;
      store.setAttribute('aria-label', `把 ${it.name} 存入知识库`);
      store.addEventListener('click', (e) => {
        e.stopPropagation();
        onStore(it);
      });
      c.appendChild(store);
    }

    const x = el('button', 'attach-x');
    x.type = 'button';
    x.innerHTML = ICON.x;
    x.title = `移除 ${it.name}`;
    x.setAttribute('aria-label', `移除 ${it.name}`);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      remove(it.id);
    });
    c.appendChild(x);
    return c;
  }

  function preview(it) {
    const veil = el('div', 'attach-preview');
    const img = el('img');
    img.src = it.dataURL;
    img.alt = it.name;
    veil.appendChild(img);
    veil.appendChild(el('span', 'attach-preview-name', it.name));
    const close = () => {
      veil.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    veil.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(veil);
  }

  /** 一条一条读：读的过程中 chip 上转圈，读完原地变成缩略图 / 文件图标 */
  async function add(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        notice(`「${file.name}」超过 ${MAX_MB}MB，没有加进来`);
        continue;
      }
      const it = { id: uid(), kind: kindOf(file), name: file.name || '未命名', size: file.size, status: 'reading' };
      items.push(it);
      render();
      try {
        if (it.kind === 'image') {
          it.dataURL = await readAs(file, 'readAsDataURL');
          it.sha256 = await sha256Hex(await file.arrayBuffer());
        } else if (it.kind === 'sheet') {
          it.sha256 = await sha256Hex(await file.arrayBuffer());
          const out = await importSheet(file);
          Object.assign(it, out);
        } else if (it.kind === 'doc') {
          // 服务端只抽正文、不落盘：拿回来当文本用，走和 txt 一样的通路
          const buf = await file.arrayBuffer();
          it.sha256 = await sha256Hex(buf);
          const out = await extractDoc(file, buf);
          Object.assign(it, { text: out.text || '', chars: out.chars || 0, truncated: !!out.truncated, via: out.via, pages: out.pages });
        } else if (it.kind === 'text') {
          const buf = await file.arrayBuffer();
          it.sha256 = await sha256Hex(buf);
          it.text = new TextDecoder().decode(buf);
        }
        it.status = 'ready';
      } catch (e) {
        it.status = 'error';
        it.error = e.message || String(e);
        notice(`「${it.name}」没读进来：${it.error}`);
      }
      render();
    }
  }

  /** 已经导入好的数据集（画布上的表格「导入」）直接挂成 chip */
  function addRef({ datasetId, versionId, name, sheets }) {
    items.push({ id: uid(), datasetId, versionId, name, sheets, size: 0, kind: 'sheet', status: 'ready' });
    render();
  }

  function remove(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [gone] = items.splice(i, 1);
    render();
    onRemove && onRemove(gone);
  }

  function clear() {
    if (!items.length) return;
    items.length = 0;
    render();
  }

  /** 数据集引用被外面换掉时（切版本 / 换分支）把对不上的表格 chip 摘掉 */
  function syncRefs(refs) {
    const keep = new Set(Object.keys(refs || {}));
    let changed = false;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].datasetId && !keep.has(items[i].datasetId)) {
        items.splice(i, 1);
        changed = true;
      }
    }
    if (changed) render();
  }

  /** 发送时把附件摊成三样：图片走多模态、文本进正文、其余只留名字 */
  function build() {
    const list = ready();
    const images = list.filter((i) => i.kind === 'image');
    const blocks = [];
    for (const i of list) {
      // 文本与已抽正文的文档走同一条路：正文进消息，头部带上 sha256 供知识库去重
      if (i.kind === 'text' || i.kind === 'doc') {
        const body = i.text || '';
        const cut = body.length > INLINE_TEXT_MAX;
        blocks.push(
          `【文件 ${i.name}${i.sha256 ? `｜sha256 ${i.sha256}` : ''}】\n` +
            body.slice(0, INLINE_TEXT_MAX) +
            (cut ? `\n…（共 ${body.length} 字，已截断）` : ''),
        );
      } else if (i.kind === 'file') {
        blocks.push(`【文件 ${i.name}】这个格式读不了，只拿到文件名`);
      }
    }
    return {
      count: list.length,
      images: images.map((i) => ({ name: i.name, url: i.dataURL })),
      inline: blocks.join('\n\n'),
      names: list.map((i) => i.name),
      /** 空文字也能发：只有附件时用这句兜底 */
      fallbackText: list.length ? '看看这些文件' : '',
    };
  }

  // ── 入口②：拖到输入框上 ─────────────────────────────────────────────────
  // 只认输入框这一块：拖到别处不接管、也不铺遮罩（但下面还是兜住了浏览器
  // 「拖进来的文件直接把页面顶掉」这个默认行为）。
  const carriesFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

  const showDrop = () => zone.classList.add('drop-on');
  const hideDrop = () => {
    dragDepth = 0;
    zone.classList.remove('drop-on');
  };

  zone.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    showDrop();
  });
  zone.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    showDrop();
  });
  zone.addEventListener('dragleave', (e) => {
    if (!carriesFiles(e)) return;
    if (--dragDepth <= 0) hideDrop();
  });
  zone.addEventListener('drop', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    hideDrop();
    add(e.dataTransfer.files);
    prompt && prompt.focus();
  });
  // 落在输入框以外：只是不让浏览器打开这个文件，不接管
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ── 入口③：粘贴 ─────────────────────────────────────────────────────────
  prompt &&
    prompt.addEventListener('paste', (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const files = [...(dt.files || [])];
      if (!files.length) {
        for (const item of dt.items || []) {
          if (item.kind !== 'file') continue;
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      add(files);
    });

  render();

  return {
    add,
    addRef,
    remove,
    clear,
    syncRefs,
    build,
    list: () => items.slice(),
    count: () => ready().length,
  };
}
