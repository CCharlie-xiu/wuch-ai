// 数据集 CRUD + CSV 导入/导出（Workers 无 sheetjs：xlsx/xls 导入与 xlsx 导出返回 501）

import { ApiError } from './errors.js';
import { extOf } from './files-api.js';

export const IMPORT_LIMIT = 8 * 1024 * 1024;
const DATASET_RE = /^ds_[A-Za-z0-9]{4,32}$/;
const VERSION_RE = /^dv_[A-Za-z0-9]{4,32}$/;
const AUTHORS = new Set(['import', 'user', 'ai', 'skill']);
const NAME_MAX = 80;
const MAX_CELLS = 2_000_000;
const MAX_ROWS = 100_000;
const MAX_COLS = 500;

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
};

const shortId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = await crypto.subtle.digest('SHA-256', u8);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function checkTableData(data) {
  if (!data || !Array.isArray(data.sheets) || !data.sheets.length) throw new ApiError(400, 'data.sheets 至少要有一张表');
  let cells = 0;
  for (const s of data.sheets) {
    if (!s || typeof s.name !== 'string' || !Array.isArray(s.cells)) {
      throw new ApiError(400, '每张表要有 name 和 cells（二维数组）');
    }
    for (const r of s.cells) {
      if (!Array.isArray(r)) throw new ApiError(400, `${s.name} 的 cells 必须是二维数组`);
      cells += r.length;
      for (const v of r) {
        if (v != null && !['string', 'number', 'boolean'].includes(typeof v)) {
          throw new ApiError(400, `${s.name} 里有不是值的单元格`);
        }
      }
    }
  }
  if (cells > MAX_CELLS) throw new ApiError(413, `单元格太多（${cells}），上限 ${MAX_CELLS}`);
}

function toVersion(r) {
  return { id: r.id, parentId: r.parent_id, author: r.author, note: r.note, createdAt: r.created_at };
}

function toDataset(r) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    name: r.name,
    sourceName: r.source_name,
    hasSource: !!r.source_blob,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function normalizeTableJson(data) {
  return JSON.stringify({ sheets: data.sheets.map((s) => ({ name: s.name, cells: s.cells })) });
}

async function putTextBlob(db, text, mime) {
  const body = String(text);
  const hash = await sha256Text(body);
  const size = new TextEncoder().encode(body).length;
  await db
    .prepare('INSERT OR IGNORE INTO blob (hash, body, size, mime, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(hash, body, size, mime, Date.now())
    .run();
  return hash;
}

async function putBinaryBlob(db, bytes, mime = 'application/octet-stream') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const hash = await sha256Bytes(u8);
  const body = bytesToBase64(u8);
  await db
    .prepare('INSERT OR IGNORE INTO blob (hash, body, size, mime, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(hash, body, u8.length, mime, Date.now())
    .run();
  return hash;
}

async function putDataBlob(db, data) {
  checkTableData(data);
  return putTextBlob(db, normalizeTableJson(data), 'application/json');
}

function baseName(fileName) {
  return String(fileName || '表格').replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || '表格';
}

function coerceCell(s) {
  const t = String(s ?? '').trim();
  if (t === '') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

function parseCsvLine(line) {
  const row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(coerceCell(cur));
      cur = '';
      continue;
    }
    cur += ch;
  }
  row.push(coerceCell(cur));
  return row;
}

/** 简单 CSV → 表格数据（单 sheet） */
export function readCsv(buf, fileName) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^\ufeff/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) throw new ApiError(422, '文件里没有数据');
  const cells = [];
  for (let r = 0; r < Math.min(lines.length, MAX_ROWS); r++) {
    const row = parseCsvLine(lines[r]);
    cells.push(row.slice(0, MAX_COLS));
    while (cells[cells.length - 1].length && cells[cells.length - 1][cells[cells.length - 1].length - 1] == null) {
      cells[cells.length - 1].pop();
    }
  }
  while (cells.length && !cells[cells.length - 1].length) cells.pop();
  if (!cells.length) throw new ApiError(422, '文件里没有数据');
  const sheetName = baseName(fileName) || 'Sheet1';
  return { sheets: [{ name: sheetName.slice(0, 31), cells }] };
}

export function readTableImport(buf, fileName) {
  const ext = extOf(fileName);
  if (ext === 'csv') return readCsv(buf, fileName);
  if (ext === 'xlsx' || ext === 'xls') {
    throw new ApiError(
      501,
      'Cloudflare 切片暂不支持 xlsx/xls 导入。请用本地 bun run dev，或粘贴 JSON 调 POST /datasets。',
    );
  }
  throw new ApiError(415, '只支持 .csv（?name= 带上原文件名）；xlsx 请用本地环境');
}

export function sheetsToCsv(data) {
  if (!data?.sheets?.length) throw new ApiError(400, '没有可导出的表');
  const sheet = data.sheets[0];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = (sheet.cells || []).map((row) => row.map(escape).join(','));
  return '\ufeff' + lines.join('\n');
}

export function attachmentHeaders(name, format) {
  const file = `${name}.${format}`;
  return {
    'Content-Type': MIME[format] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${file.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(file)}`,
    'Cache-Control': 'no-store',
  };
}

export function createDatasetRepo(db, accountId) {
  async function need(id) {
    if (typeof id !== 'string' || !DATASET_RE.test(id)) throw new ApiError(400, '数据集 id 形如 ds_xxxx');
    const row = accountId
      ? await db.prepare('SELECT * FROM dataset WHERE id = ? AND account_id = ? AND deleted_at IS NULL').bind(id, accountId).first()
      : await db.prepare('SELECT * FROM dataset WHERE id = ? AND deleted_at IS NULL').bind(id).first();
    if (!row) throw new ApiError(404, `数据集 ${id} 不存在`);
    return row;
  }

  async function conversationOk(conversationId) {
    if (conversationId == null) return null;
    const row = accountId
      ? await db
          .prepare('SELECT id FROM conversation WHERE id = ? AND deleted_at IS NULL AND user_id = ?')
          .bind(conversationId, accountId)
          .first()
      : await db.prepare('SELECT id FROM conversation WHERE id = ? AND deleted_at IS NULL').bind(conversationId).first();
    return row ? conversationId : null;
  }

  async function addVersion(datasetId, { parentId = null, data, author, note = null }, now) {
    if (!AUTHORS.has(author)) throw new ApiError(400, `author 只能是 ${[...AUTHORS].join(' / ')}`);
    if (parentId != null) {
      if (!VERSION_RE.test(parentId)) throw new ApiError(400, `版本 ${parentId} 不属于 ${datasetId}`);
      const pv = await db
        .prepare('SELECT id FROM dataset_version WHERE id = ? AND dataset_id = ?')
        .bind(parentId, datasetId)
        .first();
      if (!pv) throw new ApiError(400, `版本 ${parentId} 不属于 ${datasetId}`);
    }
    const id = shortId('dv_');
    const dataBlob = await putDataBlob(db, data);
    await db.batch([
      db
        .prepare(
          'INSERT INTO dataset_version (id, dataset_id, parent_id, data_blob, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, datasetId, parentId, dataBlob, author, note, now),
      db.prepare('UPDATE dataset SET updated_at = ? WHERE id = ?').bind(now, datasetId),
    ]);
    const row = await db.prepare('SELECT * FROM dataset_version WHERE id = ? AND dataset_id = ?').bind(id, datasetId).first();
    return toVersion(row);
  }

  return {
    async create({ conversationId = null, name, data, author = 'import', note = null, source = null }) {
      if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, '数据集要有名字');
      conversationId = await conversationOk(conversationId);
      checkTableData(data);
      const now = Date.now();
      const id = shortId('ds_');
      const sourceBlob = source ? await putBinaryBlob(db, source.body, source.mime) : null;
      const dataBlob = await putDataBlob(db, data);
      const versionId = shortId('dv_');
      await db.batch([
        db
          .prepare(
            'INSERT INTO dataset (id, account_id, conversation_id, name, source_blob, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(id, accountId, conversationId, name.trim().slice(0, NAME_MAX), sourceBlob, source?.name || null, now, now),
        db
          .prepare(
            'INSERT INTO dataset_version (id, dataset_id, parent_id, data_blob, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(versionId, id, null, dataBlob, author, note, now),
      ]);
      const dataset = await db.prepare('SELECT * FROM dataset WHERE id = ?').bind(id).first();
      const version = await db.prepare('SELECT * FROM dataset_version WHERE id = ?').bind(versionId).first();
      return { dataset: toDataset(dataset), version: toVersion(version) };
    },

    async commit(datasetId, { parentId = null, data, author = 'user', note = null }) {
      await need(datasetId);
      return addVersion(datasetId, { parentId, data, author, note }, Date.now());
    },

    async get(datasetId) {
      const row = await need(datasetId);
      const { results } = await db
        .prepare('SELECT * FROM dataset_version WHERE dataset_id = ? ORDER BY created_at, rowid')
        .bind(datasetId)
        .all();
      return { ...toDataset(row), versions: (results || []).map(toVersion) };
    },

    async read(datasetId, versionId) {
      const row = await need(datasetId);
      let v;
      if (versionId) {
        v = await db.prepare('SELECT * FROM dataset_version WHERE id = ? AND dataset_id = ?').bind(versionId, datasetId).first();
      } else {
        v = await db
          .prepare('SELECT * FROM dataset_version WHERE dataset_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
          .bind(datasetId)
          .first();
      }
      if (!v) throw new ApiError(404, `版本 ${versionId || ''} 不存在`);
      const blob = await db.prepare('SELECT body FROM blob WHERE hash = ?').bind(v.data_blob).first();
      if (!blob) throw new ApiError(500, '数据 blob 丢失');
      let data;
      try {
        data = JSON.parse(blob.body);
      } catch {
        throw new ApiError(500, '数据 blob 不是合法 JSON');
      }
      return { dataset: toDataset(row), version: toVersion(v), data };
    },

    listForConversation(conversationId) {
      return listDatasetsForConversation(db, conversationId, accountId);
    },
  };
}

export async function listDatasetsForConversation(db, conversationId, accountId) {
  const { results } = accountId
    ? await db
        .prepare('SELECT * FROM dataset WHERE conversation_id = ? AND account_id = ? AND deleted_at IS NULL ORDER BY created_at')
        .bind(conversationId, accountId)
        .all()
    : await db
        .prepare('SELECT * FROM dataset WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY created_at')
        .bind(conversationId)
        .all();
  return (results || []).map(toDataset);
}

async function readImportBody(request) {
  const cl = request.headers.get('content-length');
  if (cl && Number(cl) > IMPORT_LIMIT) {
    throw new ApiError(413, `请求体太大（上限 ${IMPORT_LIMIT / 1024 / 1024}MB）`);
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > IMPORT_LIMIT) {
    throw new ApiError(413, `请求体太大（上限 ${IMPORT_LIMIT / 1024 / 1024}MB）`);
  }
  if (!raw.byteLength) throw new ApiError(400, '文件是空的');
  return new Uint8Array(raw);
}

export async function handleDatasets(request, db, path, url, account) {
  const method = request.method;
  const datasets = createDatasetRepo(db, account.id);
  const bodyJson = async () => {
    try {
      return await request.json();
    } catch {
      throw new ApiError(400, '请求体不是合法 JSON');
    }
  };

  if (method === 'POST' && path === '/datasets/import') {
    const name = url.searchParams.get('name') || '';
    const ext = extOf(name);
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      throw new ApiError(415, '只支持 .csv / .xlsx / .xls（?name= 带上原文件名）');
    }
    const body = await readImportBody(request);
    const data = readTableImport(body, name);
    const out = await datasets.create({
      conversationId: url.searchParams.get('conversationId') || null,
      name: baseName(name),
      data,
      author: 'import',
      note: `导入 ${name}`,
      source: { body, mime: MIME[ext] || 'application/octet-stream', name },
    });
    return { status: 201, body: { ...out, data } };
  }

  if (method === 'POST' && path === '/datasets') {
    const payload = await bodyJson();
    const out = await datasets.create(payload);
    return { status: 201, body: out };
  }

  let m = /^\/datasets\/([^/]+)$/.exec(path);
  if (method === 'GET' && m) {
    return { status: 200, body: { dataset: await datasets.get(decodeURIComponent(m[1])) } };
  }

  m = /^\/datasets\/([^/]+)\/versions$/.exec(path);
  if (method === 'POST' && m) {
    const version = await datasets.commit(decodeURIComponent(m[1]), await bodyJson());
    return { status: 201, body: { version } };
  }

  m = /^\/datasets\/([^/]+)\/data$/.exec(path);
  if (method === 'GET' && m) {
    const versionId = url.searchParams.get('version') || null;
    return { status: 200, body: await datasets.read(decodeURIComponent(m[1]), versionId) };
  }

  m = /^\/datasets\/([^/]+)\/export$/.exec(path);
  if (method === 'GET' && m) {
    const format = url.searchParams.get('format') || 'xlsx';
    if (format === 'xlsx') {
      throw new ApiError(501, 'Cloudflare 切片暂不支持 xlsx 导出。请用本地 bun run dev，或 ?format=csv');
    }
    if (format !== 'csv') throw new ApiError(400, 'format 只能是 xlsx / csv');
    const versionId = url.searchParams.get('version') || null;
    const { dataset, data } = await datasets.read(decodeURIComponent(m[1]), versionId);
    const csv = sheetsToCsv(data);
    return {
      status: 200,
      binary: new TextEncoder().encode(csv),
      headers: attachmentHeaders(dataset.name, 'csv'),
    };
  }

  throw new ApiError(404, '没有这个接口');
}

/** POST /export — 页面内联表格导出（CSV only on Workers） */
export async function handleExport(request) {
  if (request.method !== 'POST') throw new ApiError(404, '没有这个接口');
  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON');
  }
  const { name = '表格', format = 'xlsx', sheets } = payload;
  if (format === 'xlsx') {
    throw new ApiError(501, 'Cloudflare 切片暂不支持 xlsx 导出。请用本地 bun run dev，或 format=csv');
  }
  if (format !== 'csv') throw new ApiError(400, 'format 只能是 xlsx / csv');
  const data = { sheets };
  checkTableData(data);
  const csv = sheetsToCsv(data);
  const fileName = String(name).slice(0, 80) || '表格';
  return {
    status: 200,
    binary: new TextEncoder().encode(csv),
    headers: attachmentHeaders(fileName, 'csv'),
  };
}
