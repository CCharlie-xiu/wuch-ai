import { test, expect, beforeEach, afterEach } from 'bun:test';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb, createConversationRepo } from '../src/db.mjs';
import { createApi } from '../src/api.mjs';
import { extractText } from '../src/files.mjs';

// ── 夹具：手搓一个「stored（不压缩）」的 zip，够 docx / pptx 用 ──────────────
// 自己的读取器不校验 CRC，所以 CRC 写 0 也能过；真文件已用 Downloads 里的实测过。
function storedZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 手搓一个最小可用 PDF（单页 + Helvetica 一行字），xref 偏移要算准 */
function makePdf(text) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  const stream = `BT /F1 14 Tf 20 150 Td (${text}) Tj ET`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const off = [];
  for (let i = 1; i <= 5; i++) {
    off[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const DOCX = storedZip([
  [
    'word/document.xml',
    Buffer.from(
      '<w:document><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>',
    ),
  ],
]);
const PPTX = storedZip([
  ['ppt/slides/slide1.xml', Buffer.from('<p:sld><a:t>第一页</a:t></p:sld>')],
  ['ppt/slides/slide2.xml', Buffer.from('<p:sld><a:t>Second</a:t></p:sld>')],
]);

// ── 直调 extractText ────────────────────────────────────────────────────────

test('文本直接按 utf8 读，sha256 与 crypto 一致', async () => {
  const body = Buffer.from('# 标题\n正文', 'utf8');
  const out = await extractText({ name: 'note.md', body });
  expect(out.ext).toBe('md');
  expect(out.via).toBe('raw');
  expect(out.text).toBe('# 标题\n正文');
  expect(out.sha256).toBe(crypto.createHash('sha256').update(body).digest('hex'));
  expect(out.truncated).toBe(false);
});

test('docx：抽段落文字，段落之间换行', async () => {
  const out = await extractText({ name: 'a.docx', body: DOCX });
  expect(out.via).toBe('zip');
  expect(out.text).toBe('Hello DOCX\n第二段');
});

test('pptx：按页码排序，每页带序号标题', async () => {
  const out = await extractText({ name: 'a.pptx', body: PPTX });
  expect(out.text).toBe('## 第 1 页\n第一页\n\n## 第 2 页\nSecond');
});

test('pdf：抽出文字层', async () => {
  const out = await extractText({ name: 'a.pdf', body: makePdf('Hello OpenUI PDF') });
  expect(out.via).toBe('pdfjs');
  expect(out.pages).toBe(1);
  expect(out.text).toContain('Hello OpenUI PDF');
});

test('maxChars 截断并标记 truncated', async () => {
  const body = Buffer.from('x'.repeat(5000), 'utf8');
  const out = await extractText({ name: 'big.txt', body, maxChars: 1000 });
  expect(out.chars).toBe(5000);
  expect(out.truncated).toBe(true);
  expect(out.text.length).toBe(1000);
});

test('不支持的格式 415、空文件 400', async () => {
  await expect(extractText({ name: 'a.zip', body: Buffer.from('PK') })).rejects.toThrow(/还读不了/);
  await expect(extractText({ name: 'a.txt', body: Buffer.alloc(0) })).rejects.toThrow(/空的/);
});

// ── HTTP 路由 ───────────────────────────────────────────────────────────────

let server;
let base;

beforeEach(async () => {
  const db = await openDb(':memory:');
  const handleApi = createApi({ repo: createConversationRepo(db), db });
  server = http.createServer(handleApi);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterEach(() => server.close());

test('POST /files/extract：请求体是文件本身，文件名放在 ?name=', async () => {
  const res = await fetch(`${base}/files/extract?name=${encodeURIComponent('需求文档.docx')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: DOCX,
  });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.name).toBe('需求文档.docx');
  expect(j.text).toBe('Hello DOCX\n第二段');
  expect(j.sha256).toHaveLength(64);
});

test('POST /files/extract：读不了的格式给 415 和一句人话', async () => {
  const res = await fetch(`${base}/files/extract?name=pack.zip`, { method: 'POST', body: Buffer.from('PK') });
  expect(res.status).toBe(415);
  expect((await res.json()).error).toContain('还读不了');
});
