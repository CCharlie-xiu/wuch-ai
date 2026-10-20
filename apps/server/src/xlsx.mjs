// ─────────────────────────────────────────────────────────────────────────────
// xlsx / xls / csv ⇄ 表格数据。只做格式转换，不碰数据库。
//
// 表格数据的形状（前端 Sheet 组件、dataset_version 存的都是它）：
//   { sheets: [{ name, cells: [[值 | "=公式"]] }] }
// 公式原样保留（导入时读 cell.f，导出时写回 f），由前端的公式引擎计算。
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { RepoError } from './db.mjs';

XLSX.set_cptable(cptable); // 老 .xls / 非 UTF-8 的中文需要代码页表

export const IMPORT_LIMIT = 10 * 1024 * 1024;
const EXTS = new Set(['xlsx', 'xls', 'csv']);
const MAX_ROWS = 100_000;
const MAX_COLS = 500;

export const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
};

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 文件 → 表格数据。日期按 Excel 显示的文字保留，其余取原值 */
export function readTable(buf, fileName) {
  const ext = extOf(fileName);
  if (!EXTS.has(ext)) throw new RepoError(415, '只支持 .xlsx / .xls / .csv');
  let wb;
  try {
    // csv 按 UTF-8 文本读（去掉 BOM），否则中文会被当成单字节乱码
    wb =
      ext === 'csv'
        ? XLSX.read(Buffer.from(buf).toString('utf8').replace(/^\ufeff/, ''), { type: 'string', cellFormula: true, raw: false })
        : XLSX.read(buf, { type: 'buffer', cellFormula: true, cellDates: false });
  } catch (e) {
    throw new RepoError(422, '文件读不出来：' + e.message);
  }
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return { name, cells: [] };
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = Math.min(range.e.r + 1, MAX_ROWS);
    const cols = Math.min(range.e.c + 1, MAX_COLS);
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) row.push(null);
        else if (cell.f) row.push('=' + cell.f);
        else if (cell.t === 'd' || (cell.t === 'n' && cell.z && /[ymdhs]/i.test(String(cell.z)) && cell.w)) row.push(cell.w);
        else if (cell.t === 'e') row.push(cell.w || null);
        else row.push(cell.v ?? null);
      }
      while (row.length && row[row.length - 1] == null) row.pop();
      cells.push(row);
    }
    while (cells.length && !cells[cells.length - 1].length) cells.pop();
    return { name, cells };
  });
  if (!sheets.some((s) => s.cells.length)) throw new RepoError(422, '文件里没有数据');
  return { sheets };
}

/**
 * 表格数据 → 文件。values 是前端算好的公式结果（同形状二维数组，可选）：
 * 带上它，没有重算能力的查看器（预览、手机）也能显示公式结果。
 */
export function writeTable(data, format = 'xlsx', values = null) {
  if (!['xlsx', 'csv'].includes(format)) throw new RepoError(400, 'format 只能是 xlsx / csv');
  const wb = XLSX.utils.book_new();
  const used = new Set();
  data.sheets.forEach((s, si) => {
    const ws = {};
    let maxR = 0;
    let maxC = 0;
    s.cells.forEach((row, r) => {
      row.forEach((v, c) => {
        if (v == null || v === '') return;
        const addr = XLSX.utils.encode_cell({ r, c });
        const cached = values && values[si] && values[si][r] ? values[si][r][c] : undefined;
        if (typeof v === 'string' && v.startsWith('=') && v.length > 1) {
          const cell = { f: v.slice(1) };
          if (typeof cached === 'number') Object.assign(cell, { t: 'n', v: cached });
          else if (typeof cached === 'boolean') Object.assign(cell, { t: 'b', v: cached });
          else if (typeof cached === 'string') Object.assign(cell, { t: 's', v: cached });
          else cell.t = 'n'; // 不带缓存值：Excel 打开时自己算
          ws[addr] = cell;
        } else if (typeof v === 'number') ws[addr] = { t: 'n', v };
        else if (typeof v === 'boolean') ws[addr] = { t: 'b', v };
        else ws[addr] = { t: 's', v: String(v) };
        maxR = Math.max(maxR, r);
        maxC = Math.max(maxC, c);
      });
    });
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    // 表名：Excel 限 31 字、不能有 []:*?/\ 、不能重名
    let name = String(s.name || `Sheet${si + 1}`).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || `Sheet${si + 1}`;
    for (let k = 2; used.has(name); k++) name = `${name.slice(0, 28)}(${k})`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  if (format === 'csv') return Buffer.from('\ufeff' + XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]), 'utf8');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** 文件名去掉扩展名，作数据集名 */
export function baseName(fileName) {
  return String(fileName || '表格').replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || '表格';
}
