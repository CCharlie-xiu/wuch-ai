// ─────────────────────────────────────────────────────────────────────────────
// 文件正文抽取：把附件变成纯文本，喂给模型。
//
//   pdf                       pdfjs-dist 的 legacy 构建（Node 下自带假 worker）
//   docx / pptx / odt / ods / odp   zip 里的 XML，用 node:zlib 自己解，不引依赖
//   文本类（txt / md / csv / json / 代码…）  直接按 utf8 读
//
// 只读不落盘：进来是 Buffer，出去是字符串 + sha256（知识库按文件去重要用它）。
// 顺带算出 sha256 是白送的 —— 字节已经在手上了。
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { RepoError } from './db.mjs';
import { extOf } from './xlsx.mjs';

export const EXTRACT_LIMIT = 32 * 1024 * 1024; // 送进来解析的文件大小上限
export const DEFAULT_MAX_CHARS = 200_000; // 抽出来的正文上限
const MAX_CHARS_CAP = 1_000_000;

/** zip 容器类格式：里面是 XML */
const ZIP_DOC_EXT = new Set(['docx', 'pptx', 'odt', 'ods', 'odp']);
/** 直接按文本读的 */
const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'log',
  'xml', 'html', 'htm', 'svg', 'srt', 'vtt',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'r', 'm', 'sql',
  'css', 'scss', 'less', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'ini', 'toml', 'env', 'conf', 'properties',
]);

export const SUPPORTED = new Set(['pdf', ...ZIP_DOC_EXT, ...TEXT_EXT]);

// ── 文本 / XML ──────────────────────────────────────────────────────────────

const decode = (buf) => Buffer.from(buf).toString('utf8').replace(/^\ufeff/, '');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCp(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

const safeCp = (n) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/**
 * OOXML / ODF 的 XML → 纯文本。
 * 先把「段落结束」「换行」「制表」折成换行与制表符，再把剩下的标签全剥掉。
 */
function xmlToText(xml) {
  return decodeXml(
    String(xml)
      .replace(/<w:tab\b[^>]*\/?>/gi, '\t')
      .replace(/<w:br\b[^>]*\/?>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<\/a:p>/gi, '\n')
      .replace(/<\/text:p>/gi, '\n')
      .replace(/<\/text:h>/gi, '\n')
      .replace(/<\/w:tr>/gi, '\n')
      .replace(/<\/w:tc>/gi, '\t')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 极简 zip 读取（只够读 Office / ODF 里的 XML）─────────────────────────────
// 走中央目录拿条目表，再按本地头算数据偏移。支持 stored(0) 与 deflate(8)，够用。

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

function openZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new RepoError(422, '不是有效的 zip 包（找不到中央目录）');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  if (count === 0xffff || cdOffset === 0xffffffff) {
    // zip64：定位器在 EOCD 前面 20 字节
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === ZIP64_LOCATOR_SIG) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (usize === 0xffffffff || csize === 0xffffffff || lho === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const hid = buf.readUInt16LE(e);
        const hsz = buf.readUInt16LE(e + 2);
        if (hid === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) (usize = Number(buf.readBigUInt64LE(q))), (q += 8);
          if (csize === 0xffffffff) (csize = Number(buf.readBigUInt64LE(q))), (q += 8);
          if (lho === 0xffffffff) (lho = Number(buf.readBigUInt64LE(q))), (q += 8);
          break;
        }
        e += 4 + hsz;
      }
    }
    entries.set(name, { method, csize, usize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }

  function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const nameLen = buf.readUInt16LE(e.lho + 26);
    const extraLen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) {
      try {
        return zlib.inflateRawSync(raw);
      } catch (err) {
        throw new RepoError(422, `解压 ${name} 失败：${err.message}`);
      }
    }
    throw new RepoError(422, `${name} 用了不支持的压缩方式（${e.method}）`);
  }

  return { names: () => [...entries.keys()], read };
}

// ── 各类型 ──────────────────────────────────────────────────────────────────

function docxText(zip) {
  const xml = zip.read('word/document.xml');
  if (!xml) throw new RepoError(422, 'docx 里找不到 word/document.xml');
  return xmlToText(xml.toString('utf8'));
}

function pptxText(zip) {
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
  if (!slides.length) throw new RepoError(422, 'pptx 里没有幻灯片');
  return slides.map((n, i) => `## 第 ${i + 1} 页\n${xmlToText(zip.read(n).toString('utf8'))}`).join('\n\n');
}

function odfText(zip) {
  const xml = zip.read('content.xml');
  if (!xml) throw new RepoError(422, 'odf 里找不到 content.xml');
  return xmlToText(xml.toString('utf8'));
}

// pdfjs 只加载一次；Bun 下走 legacy 构建（自带假 worker，不用起线程）
let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

async function pdfText(buf, maxChars) {
  const pdfjs = await loadPdfjs();
  // v6 里 destroy() 在 loadingTask 上，文档代理只有 cleanup()
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    throw new RepoError(422, 'pdf 打不开：' + e.message);
  }
  try {
    const pages = [];
    let total = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const parts = [];
      for (const it of tc.items) {
        if (typeof it.str === 'string') parts.push(it.str);
        if (it.hasEOL) parts.push('\n');
      }
      const text = parts.join('').replace(/[ \t]+\n/g, '\n').trim();
      if (text) pages.push(text);
      total += text.length;
      page.cleanup && page.cleanup();
      if (total >= maxChars) break;
    }
    return { text: pages.join('\n\n'), pages: doc.numPages };
  } finally {
    await doc.cleanup?.().catch?.(() => {});
    await task.destroy?.().catch?.(() => {});
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.name    原文件名（决定按什么格式解析）
 * @param {Buffer} o.body    文件字节
 * @param {number} [o.maxChars] 正文上限，默认 20 万字
 * @returns {Promise<{name, ext, via, chars, truncated, sha256, text, pages?}>}
 */
export async function extractText({ name, body, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (!buf.length) throw new RepoError(400, '文件是空的');
  if (buf.length > EXTRACT_LIMIT) {
    throw new RepoError(413, `文件太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），上限 ${EXTRACT_LIMIT / 1024 / 1024}MB`);
  }
  const ext = extOf(name);
  if (!SUPPORTED.has(ext)) {
    throw new RepoError(415, `还读不了 .${ext || '未知'} 这种格式（支持 pdf / docx / pptx / odt / ods / odp 与常见文本）`);
  }
  const limit = Math.max(1000, Math.min(MAX_CHARS_CAP, Number(maxChars) || DEFAULT_MAX_CHARS));

  let text = '';
  let via = 'raw';
  let pages;
  if (ext === 'pdf') {
    const out = await pdfText(buf, limit);
    text = out.text;
    pages = out.pages;
    via = 'pdfjs';
  } else if (ZIP_DOC_EXT.has(ext)) {
    const zip = openZip(buf);
    text = ext === 'docx' ? docxText(zip) : ext === 'pptx' ? pptxText(zip) : odfText(zip);
    via = 'zip';
  } else {
    text = decode(buf);
  }

  text = text.replace(/\r\n/g, '\n').trim();
  const truncated = text.length > limit;
  return {
    name: String(name || ''),
    ext,
    via,
    chars: text.length,
    truncated,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    text: truncated ? text.slice(0, limit) : text,
    ...(pages ? { pages } : {}),
  };
}
