// ─────────────────────────────────────────────────────────────────────────────
// 迁移执行器：版本递增 + sha256 校验 + 幂等检查。规范见 .cursor/rules/backend.mdc。
//
//   data/schema.sql                 版本 1
//   data/migrations/NNN_xxx.sql     纯 SQL，执行前做幂等静态检查
//   data/migrations/NNN_xxx.mjs     SQL 表达不了幂等的（加列、改名、数据回填）：
//                                   export default function up(db, h) { h.addColumn(...) }
//
// 启动时：
//   1. 已应用的每个版本，文件必须还在、sha256 必须和登记时一致，否则拒绝启动
//   2. 未应用的依次执行，每个一个事务，和版本登记一起提交
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export class MigrationError extends Error {}

/** 只统一换行符：注释、空白改了也算改了，已应用的文件一个字节都不许动 */
export function checksum(text) {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

export function discover(dataDir) {
  const list = [{ version: 1, name: 'schema.sql', file: path.join(dataDir, 'schema.sql') }];
  const dir = path.join(dataDir, 'migrations');
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      const m = /^(\d{3,})_[a-z0-9_]+\.(sql|mjs)$/.exec(name);
      if (!m) {
        if (!name.startsWith('.')) throw new MigrationError(`迁移文件名不合规：${name}（应为 NNN_snake_case.sql 或 .mjs）`);
        continue;
      }
      list.push({ version: Number(m[1]), name, file: path.join(dir, name) });
    }
  }
  const seen = new Map();
  for (const m of list) {
    if (seen.has(m.version)) throw new MigrationError(`迁移版本号重复：${seen.get(m.version)} 与 ${m.name}`);
    seen.set(m.version, m.name);
  }
  return list.sort((a, b) => a.version - b.version);
}

// ── 幂等静态检查 ────────────────────────────────────────────────────────────

function stripSql(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

const RULES = [
  [/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|VIEW|TRIGGER)\b(?!\s+IF\s+NOT\s+EXISTS\b)/i, (m) => `CREATE ${m[1].toUpperCase()} 必须写 IF NOT EXISTS`],
  [/\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER)\b(?!\s+IF\s+EXISTS\b)/i, (m) => `DROP ${m[1].toUpperCase()} 必须写 IF EXISTS`],
  [/\bALTER\s+TABLE\b/i, () => 'ALTER TABLE 在 SQLite 里无法写成幂等，改用 .mjs 迁移的 h.addColumn / h.renameColumn'],
  [/\b(?:PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|VACUUM|ATTACH)\b/i, (m) => `迁移文件里不能出现 ${m[0].toUpperCase()}：事务与连接参数由执行器管理`],
];

/** 返回违规说明列表；空数组 = 通过 */
export function lintSql(sql) {
  const problems = [];
  let body = stripSql(sql);
  // 触发器体里的语句随触发器一起建，不单独要求幂等；只检查触发器头
  body = body.replace(/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b[\s\S]*?\bBEGIN\b[\s\S]*?\bEND\b/gi, (t) => t.replace(/\bBEGIN\b[\s\S]*$/i, ''));
  for (const stmt of body.split(';').map((s) => s.trim()).filter(Boolean)) {
    const head = stmt.replace(/\s+/g, ' ').slice(0, 80);
    for (const [re, msg] of RULES) {
      const m = re.exec(stmt);
      if (m) problems.push(`${msg(m)} —— ${head}`);
    }
    if (/^(?:WITH\b[\s\S]*?\b)?INSERT\b/i.test(stmt) && !/^INSERT\s+OR\s+(IGNORE|REPLACE)\b/i.test(stmt) && !/\bON\s+CONFLICT\b/i.test(stmt)) {
      problems.push(`INSERT 必须写成 INSERT OR IGNORE 或带 ON CONFLICT —— ${head}`);
    }
  }
  return problems;
}

// ── .mjs 迁移的幂等辅助 ─────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (s) => {
  if (!IDENT.test(s)) throw new MigrationError(`非法标识符：${s}`);
  return `"${s}"`;
};

function helpers(db) {
  const hasTable = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const hasColumn = (table, column) => !!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
  return {
    hasTable,
    hasColumn,
    /** 列已存在就跳过 */
    addColumn(table, column, definition) {
      if (hasColumn(table, column)) return false;
      db.exec(`ALTER TABLE ${ident(table)} ADD COLUMN ${ident(column)} ${definition}`);
      return true;
    },
    /** 旧列不在、新列已在就跳过 */
    renameColumn(table, from, to) {
      if (!hasColumn(table, from) && hasColumn(table, to)) return false;
      db.exec(`ALTER TABLE ${ident(table)} RENAME COLUMN ${ident(from)} TO ${ident(to)}`);
      return true;
    },
    /** 执行一段 SQL，同样过幂等检查 */
    exec(sql) {
      const problems = lintSql(sql);
      if (problems.length) throw new MigrationError(problems.join('\n'));
      db.exec(sql);
    },
  };
}

// ── 执行 ────────────────────────────────────────────────────────────────────

function ensureVersionTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const h = helpers(db);
  h.addColumn('schema_version', 'name', 'TEXT');
  h.addColumn('schema_version', 'checksum', 'TEXT');
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export async function migrate(db, dataDir) {
  const files = discover(dataDir);
  const byVersion = new Map(files.map((m) => [m.version, m]));
  ensureVersionTable(db);

  const applied = db.prepare('SELECT version, name, checksum FROM schema_version ORDER BY version').all();
  const backfill = db.prepare('UPDATE schema_version SET name = ?, checksum = ? WHERE version = ? AND checksum IS NULL');
  const problems = [];
  for (const row of applied) {
    const m = byVersion.get(row.version);
    if (!m) {
      problems.push(`版本 ${row.version}（${row.name || '未登记文件名'}）已应用，但迁移文件不见了`);
      continue;
    }
    const sum = checksum(fs.readFileSync(m.file, 'utf8'));
    if (row.checksum == null) {
      // 引入校验之前就应用过的版本：以当前文件为准补登记，只发生一次
      backfill.run(m.name, sum, row.version);
    } else if (row.checksum !== sum) {
      problems.push(`版本 ${row.version}（${m.name}）已应用后被修改过：登记 ${row.checksum.slice(0, 12)}…，现在 ${sum.slice(0, 12)}…`);
    }
  }
  if (problems.length) {
    throw new MigrationError(`迁移校验失败，拒绝启动：\n- ${problems.join('\n- ')}\n已应用的迁移不能改，要改表结构请新增一个迁移文件。`);
  }

  const done = new Set(applied.map((r) => r.version));
  const record = db.prepare('INSERT INTO schema_version (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
  const ran = [];
  for (const m of files) {
    if (done.has(m.version)) continue;
    const text = fs.readFileSync(m.file, 'utf8');
    let up;
    if (m.name.endsWith('.sql')) {
      const lint = lintSql(text);
      if (lint.length) throw new MigrationError(`${m.name} 不是幂等写法：\n- ${lint.join('\n- ')}`);
      up = () => db.exec(text);
    } else {
      const mod = await import(pathToFileURL(m.file).href);
      if (typeof mod.default !== 'function') throw new MigrationError(`${m.name} 必须 export default function up(db, h)`);
      up = () => {
        const out = mod.default(db, helpers(db));
        if (out && typeof out.then === 'function') throw new MigrationError(`${m.name} 的 up 必须是同步函数（要和版本登记在同一个事务里）`);
      };
    }
    tx(db, () => {
      up();
      record.run(m.version, m.name, checksum(text), Date.now());
    });
    ran.push(m.name);
  }
  return ran;
}
