import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, DATA_DIR } from '../src/db.mjs';
import { lintSql, checksum } from '../src/migrate.mjs';

let dir;
let dataDir;
let dbFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openui-migrate-'));
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'schema.sql'), 'CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY);\n');
  dbFile = path.join(dir, 'test.db');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name, text) => fs.writeFileSync(path.join(dataDir, 'migrations', name), text);
const open = () => openDb(dbFile, { dataDir });
const versions = (db) => db.prepare('SELECT version, name, checksum FROM schema_version ORDER BY version').all().map((r) => ({ ...r }));
const columns = (db, t) => db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);

test('项目自己的 schema.sql 通过幂等检查', () => {
  expect(lintSql(fs.readFileSync(path.join(DATA_DIR, 'schema.sql'), 'utf8'))).toEqual([]);
});

test('项目自己的 .sql 迁移都通过幂等检查', () => {
  for (const name of fs.readdirSync(path.join(DATA_DIR, 'migrations')).filter((n) => n.endsWith('.sql'))) {
    expect({ name, problems: lintSql(fs.readFileSync(path.join(DATA_DIR, 'migrations', name), 'utf8')) }).toEqual({ name, problems: [] });
  }
});

test('版本 2 回填：旧的线性会话串成一条链，HEAD 指最后一轮，空原文沿用上一轮快照', async () => {
  const realDir = path.join(dir, 'real');
  fs.mkdirSync(path.join(realDir, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(DATA_DIR, 'schema.sql'), path.join(realDir, 'schema.sql'));
  const file = path.join(dir, 'real.db');
  // 先只跑版本 1，写入旧数据
  (await openDb(file, { dataDir: realDir })).close();
  const pre = new DatabaseSync(file);
  pre.exec("INSERT INTO conversation (id, title, turn_count, created_at, updated_at) VALUES ('c1', 't', 3, 1, 1)");
  const ins = pre.prepare("INSERT INTO turn (id, conversation_id, seq, user_text, raw, state, created_at, updated_at) VALUES (?, 'c1', ?, 'q', ?, ?, 1, 1)");
  ins.run('t1', 1, 'root = A()', 'complete');
  ins.run('t2', 2, '', 'error');
  ins.run('t3', 3, 'root = B()', 'complete');
  pre.close();
  for (const name of fs.readdirSync(path.join(DATA_DIR, 'migrations'))) fs.copyFileSync(path.join(DATA_DIR, 'migrations', name), path.join(realDir, 'migrations', name));
  const db = await openDb(file, { dataDir: realDir });
  const rows = db.prepare('SELECT id, parent_id, active_child_id, depth, snapshot FROM turn ORDER BY seq').all().map((r) => ({ ...r }));
  expect(rows).toEqual([
    { id: 't1', parent_id: null, active_child_id: 't2', depth: 1, snapshot: 'root = A()' },
    { id: 't2', parent_id: 't1', active_child_id: 't3', depth: 2, snapshot: 'root = A()' },
    { id: 't3', parent_id: 't2', active_child_id: null, depth: 3, snapshot: 'root = B()' },
  ]);
  expect(db.prepare("SELECT head_turn_id FROM conversation WHERE id = 'c1'").get().head_turn_id).toBe('t3');
  expect(db.prepare('SELECT id FROM skill ORDER BY id').all().map((r) => r.id)).toEqual(['canvas', 'sheet']);
  expect(columns(db, 'dataset_version')).toContain('data_blob');
  db.close();
});

test('依次应用并登记文件名与 sha256，重复打开不再执行', async () => {
  write('002_add_b.sql', 'CREATE TABLE IF NOT EXISTS b (id TEXT);\nINSERT OR IGNORE INTO b (id) VALUES (\'x\');\n');
  let db = await open();
  expect(versions(db)).toEqual([
    { version: 1, name: 'schema.sql', checksum: checksum(fs.readFileSync(path.join(dataDir, 'schema.sql'), 'utf8')) },
    { version: 2, name: '002_add_b.sql', checksum: expect.stringMatching(/^[0-9a-f]{64}$/) },
  ]);
  db.close();
  db = await open();
  expect(db.prepare('SELECT COUNT(*) AS n FROM b').get().n).toBe(1);
  db.close();
});

test('已应用的文件被改过：拒绝启动', async () => {
  write('002_add_b.sql', 'CREATE TABLE IF NOT EXISTS b (id TEXT);\n');
  (await open()).close();
  write('002_add_b.sql', 'CREATE TABLE IF NOT EXISTS b (id TEXT, extra TEXT);\n');
  await expect(open()).rejects.toThrow(/版本 2（002_add_b.sql）已应用后被修改过/);
});

test('只改注释也算修改；CRLF 与 LF 视为相同', async () => {
  write('002_add_b.sql', 'CREATE TABLE IF NOT EXISTS b (id TEXT);\n');
  (await open()).close();
  write('002_add_b.sql', 'CREATE TABLE IF NOT EXISTS b (id TEXT);\r\n');
  (await open()).close();
  write('002_add_b.sql', '-- 注释\nCREATE TABLE IF NOT EXISTS b (id TEXT);\n');
  await expect(open()).rejects.toThrow(/已应用后被修改过/);
});

test('已应用的文件被删了：拒绝启动', async () => {
  write('002_add_b.sql', 'CREATE TABLE IF NOT EXISTS b (id TEXT);\n');
  (await open()).close();
  fs.rmSync(path.join(dataDir, 'migrations', '002_add_b.sql'));
  await expect(open()).rejects.toThrow(/版本 2（002_add_b.sql）已应用，但迁移文件不见了/);
});

test('非幂等 SQL 不执行、不登记', async () => {
  write('002_bad.sql', 'CREATE TABLE b (id TEXT);\n');
  await expect(open()).rejects.toThrow(/002_bad.sql 不是幂等写法[\s\S]*CREATE TABLE 必须写 IF NOT EXISTS/);
  const raw = new DatabaseSync(dbFile);
  expect(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v).toBe(1);
  expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'b'").get()).toBeUndefined();
  raw.close();
});

test('迁移中途出错整体回滚', async () => {
  write('002_half.sql', 'CREATE TABLE IF NOT EXISTS b (id TEXT);\nINSERT OR IGNORE INTO nope (id) VALUES (1);\n');
  await expect(open()).rejects.toThrow();
  const raw = new DatabaseSync(dbFile);
  expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'b'").get()).toBeUndefined();
  raw.close();
});

test('.mjs 迁移：addColumn 列已存在时跳过', async () => {
  write('002_add_col.mjs', "export default function up(db, h) { h.addColumn('a', 'title', \"TEXT NOT NULL DEFAULT ''\"); }\n");
  const pre = new DatabaseSync(dbFile);
  pre.exec('CREATE TABLE a (id TEXT PRIMARY KEY, title TEXT)');
  pre.close();
  const db = await open();
  expect(columns(db, 'a')).toEqual(['id', 'title']);
  expect(versions(db).map((v) => v.name)).toEqual(['schema.sql', '002_add_col.mjs']);
  db.close();
});

test('引入校验前应用过的版本：按当前文件补登记一次', async () => {
  const pre = new DatabaseSync(dbFile);
  pre.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  pre.exec('CREATE TABLE a (id TEXT PRIMARY KEY)');
  pre.exec('INSERT INTO schema_version VALUES (1, 1)');
  pre.close();
  const db = await open();
  expect(versions(db)[0]).toEqual({ version: 1, name: 'schema.sql', checksum: checksum(fs.readFileSync(path.join(dataDir, 'schema.sql'), 'utf8')) });
  db.close();
});

test('文件名与版本号检查', async () => {
  write('002_a.sql', 'SELECT 1;');
  write('002_b.sql', 'SELECT 1;');
  await expect(open()).rejects.toThrow(/迁移版本号重复/);
  fs.rmSync(path.join(dataDir, 'migrations', '002_b.sql'));
  write('3-Bad Name.sql', 'SELECT 1;');
  await expect(open()).rejects.toThrow(/迁移文件名不合规/);
});

test('lintSql 规则', () => {
  const bad = (sql) => lintSql(sql).length > 0;
  expect(bad('CREATE TABLE IF NOT EXISTS t (a)')).toBe(false);
  expect(bad('CREATE  TABLE   IF  NOT  EXISTS t (a)')).toBe(false);
  expect(bad('CREATE UNIQUE INDEX IF NOT EXISTS i ON t(a)')).toBe(false);
  expect(bad('CREATE INDEX i ON t(a)')).toBe(true);
  expect(bad('DROP TABLE t')).toBe(true);
  expect(bad('DROP INDEX IF EXISTS i')).toBe(false);
  expect(bad('ALTER TABLE t ADD COLUMN b TEXT')).toBe(true);
  expect(bad("INSERT INTO t VALUES ('a')")).toBe(true);
  expect(bad("INSERT OR IGNORE INTO t VALUES ('a')")).toBe(false);
  expect(bad("INSERT INTO t VALUES ('a') ON CONFLICT (a) DO NOTHING")).toBe(false);
  expect(bad('PRAGMA foreign_keys = ON')).toBe(true);
  expect(bad("-- CREATE TABLE t\nSELECT 'DROP TABLE x'")).toBe(false);
  expect(
    bad('CREATE TRIGGER IF NOT EXISTS tg AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.a); END'),
  ).toBe(false);
  expect(bad('CREATE TRIGGER tg AFTER INSERT ON t BEGIN SELECT 1; END')).toBe(true);
});
