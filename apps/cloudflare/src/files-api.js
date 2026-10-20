// 文件正文抽取（Workers：PDF 用 unpdf；zip deflate 用 DecompressionStream）
// 线上不落存原件：只抽正文喂模型；要物料存储请用本地 bun run dev。

import { extractText as unpdfExtractText, getDocumentProxy } from 'unpdf';
import { ApiError } from './errors.js';

export const EXTRACT_LIMIT = 16 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 200_000;
const MAX_CHARS_CAP = 1_000_000;

const ZIP_DOC_EXT = new Set(['docx', 'pptx', 'odt', 'ods', 'odp']);
const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'log',
  'xml', 'html', 'htm', 'svg', 'srt', 'vtt',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'r', 'm', 'sql',
  'css', 'scss', 'less', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'ini', 'toml', 'env', 'conf', 'properties',
]);

export const SUPPORTED = new Set(['pdf', ...ZIP_DOC_EXT, ...TEXT_EXT]);

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

async function sha256Bytes(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const decodeText = (buf) => new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^\ufeff/, '');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCp(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

const safeCp = (n) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

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

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

function u32(buf, o) {
  return buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24);
}
function u16(buf, o) {
  return buf[o] | (buf[o + 1] << 8);
}
function u64(buf, o) {
  const lo = u32(buf, o);
  const hi = u32(buf, o + 4);
  return BigInt(lo) + (BigInt(hi) << 32n);
}

async function inflateRaw(raw) {
  try {
    const ds = new DecompressionStream('deflate-raw');
    const out = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
  } catch (err) {
    throw new ApiError(422, `解压失败：${err.message}`);
  }
}

function openZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (u32(buf, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ApiError(422, '不是有效的 zip 包（找不到中央目录）');

  let count = u16(buf, eocd + 10);
  let cdOffset = u32(buf, eocd + 16);

  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(buf, loc) === ZIP64_LOCATOR_SIG) {
      const z64 = Number(u64(buf, loc + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && u32(buf, z64) === ZIP64_EOCD_SIG) {
        count = Number(u64(buf, z64 + 32));
        cdOffset = Number(u64(buf, z64 + 48));
      }
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (u32(buf, p) !== CD_SIG) break;
    const method = u16(buf, p + 10);
    let csize = u32(buf, p + 20);
    let usize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    let lho = u32(buf, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

    if (usize === 0xffffffff || csize === 0xffffffff || lho === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const hid = u16(buf, e);
        const hsz = u16(buf, e + 2);
        if (hid === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) (usize = Number(u64(buf, q))), (q += 8);
          if (csize === 0xffffffff) (csize = Number(u64(buf, q))), (q += 8);
          if (lho === 0xffffffff) (lho = Number(u64(buf, q))), (q += 8);
          break;
        }
        e += 4 + hsz;
      }
    }
    entries.set(name, { method, csize, usize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const nameLen = u16(buf, e.lho + 26);
    const extraLen = u16(buf, e.lho + 28);
    const start = e.lho + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) {
      try {
        return await inflateRaw(raw);
      } catch (err) {
        if (err instanceof ApiError) throw new ApiError(422, `解压 ${name} 失败：${err.message.replace(/^解压失败：/, '')}`);
        throw err;
      }
    }
    throw new ApiError(422, `${name} 用了不支持的压缩方式（${e.method}）`);
  }

  return { names: () => [...entries.keys()], read };
}

async function docxText(zip) {
  const xml = await zip.read('word/document.xml');
  if (!xml) throw new ApiError(422, 'docx 里找不到 word/document.xml');
  return xmlToText(decodeText(xml));
}

async function pptxText(zip) {
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
  if (!slides.length) throw new ApiError(422, 'pptx 里没有幻灯片');
  const parts = [];
  for (let i = 0; i < slides.length; i++) {
    const n = slides[i];
    parts.push(`## 第 ${i + 1} 页\n${xmlToText(decodeText(await zip.read(n)))}`);
  }
  return parts.join('\n\n');
}

async function odfText(zip) {
  const xml = await zip.read('content.xml');
  if (!xml) throw new ApiError(422, 'odf 里找不到 content.xml');
  return xmlToText(decodeText(xml));
}

/**
 * @param {{ name: string, body: ArrayBuffer | Uint8Array, maxChars?: number }} o
 */
export async function extractText({ name, body, maxChars = DEFAULT_MAX_CHARS } = {}) {
  // 拷一份：pdfjs/unpdf 可能 transfer 原 ArrayBuffer，导致后续 sha256 变成空
  const src = body instanceof Uint8Array ? body : new Uint8Array(body || []);
  if (!src.length) throw new ApiError(400, '文件是空的');
  if (src.length > EXTRACT_LIMIT) {
    throw new ApiError(413, `文件太大（${(src.length / 1024 / 1024).toFixed(1)}MB），上限 ${EXTRACT_LIMIT / 1024 / 1024}MB`);
  }
  const buf = new Uint8Array(src);
  const sha256 = await sha256Bytes(buf);
  const ext = extOf(name);
  if (!SUPPORTED.has(ext)) {
    throw new ApiError(415, `还读不了 .${ext || '未知'} 这种格式（支持 pdf / docx / pptx / odt / ods / odp 与常见文本）`);
  }
  const limit = Math.max(1000, Math.min(MAX_CHARS_CAP, Number(maxChars) || DEFAULT_MAX_CHARS));

  let text = '';
  let via = 'raw';
  let pages;

  if (ext === 'pdf') {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const out = await unpdfExtractText(pdf, { mergePages: true });
      text = typeof out.text === 'string' ? out.text : Array.isArray(out.text) ? out.text.join('\n\n') : '';
      pages = out.totalPages;
      via = 'unpdf';
    } catch (e) {
      throw new ApiError(422, 'pdf 打不开：' + (e?.message || String(e)));
    }
  } else if (ZIP_DOC_EXT.has(ext)) {
    const zip = openZip(buf);
    text = ext === 'docx' ? await docxText(zip) : ext === 'pptx' ? await pptxText(zip) : await odfText(zip);
    via = 'zip';
  } else {
    text = decodeText(buf);
  }

  text = text.replace(/\r\n/g, '\n').trim();
  const truncated = text.length > limit;
  return {
    name: String(name || ''),
    ext,
    via,
    chars: text.length,
    truncated,
    sha256,
    text: truncated ? text.slice(0, limit) : text,
    ...(pages != null ? { pages } : {}),
  };
}

export async function handleFiles(request, path, url) {
  if (request.method === 'POST' && path === '/files/extract') {
    const cl = request.headers.get('content-length');
    if (cl && Number(cl) > EXTRACT_LIMIT) {
      throw new ApiError(413, `请求体太大（上限 ${EXTRACT_LIMIT / 1024 / 1024}MB）`);
    }
    const raw = await request.arrayBuffer();
    if (raw.byteLength > EXTRACT_LIMIT) {
      throw new ApiError(413, `请求体太大（上限 ${EXTRACT_LIMIT / 1024 / 1024}MB）`);
    }
    const name = url.searchParams.get('name') || '';
    const maxChars = url.searchParams.get('maxChars');
    return { status: 200, body: await extractText({ name, body: raw, maxChars }) };
  }
  throw new ApiError(404, '没有这个接口');
}
