import { describe, expect, test } from 'bun:test';
import { mergeSource, readModeLine, splitStatements } from '../src/index.ts';

const BASE = `root = Stack([title, chart])
title = TextContent("Q3 销售")
chart = BarChart(["7月", "8月"], [Series("线上", [1, 2])])
summary = [Note("初版", "第一版", ["chart"])]`;

describe('splitStatements', () => {
  test('一行一条、跨行、一行多条都能切开', () => {
    const s = splitStatements('a = Stack([\n  b,\n  c\n]) b = TextContent("x = y")\nc = null');
    expect(s.map((x) => x.name)).toEqual(['a', 'b', 'c']);
    expect(s[1]!.value).toBe('TextContent("x = y")');
    expect(s[2]!.value).toBe('null');
  });
  test('字符串里的转义引号不打断扫描', () => {
    const s = splitStatements('a = TextContent("he said \\"b = 1\\"")\nb = Card([])');
    expect(s.map((x) => x.name)).toEqual(['a', 'b']);
  });
  test('还没写到 = 的半截变量名不算语句', () => {
    expect(splitStatements('a = Card([])\nti').map((x) => x.name)).toEqual(['a']);
  });
});

describe('mergeSource', () => {
  test('同名覆盖、位置不变；新变量排在 summary 前；summary 被覆盖', () => {
    const out = mergeSource(BASE, 'title = TextContent("Q3 销售复盘")\nnote = TextCallout("info", "提示", "新加的")\nsummary = [Note("改了标题", "加了提示", ["note"])]', { final: true });
    const names = splitStatements(out).map((s) => s.name);
    expect(names).toEqual(['root', 'title', 'chart', 'note', 'summary']);
    expect(out).toContain('TextContent("Q3 销售复盘")');
    expect(out).not.toContain('初版');
  });
  test('x = null 删掉变量', () => {
    const out = mergeSource(BASE, 'root = Stack([title])\nchart = null', { final: true });
    expect(splitStatements(out).map((s) => s.name)).toEqual(['root', 'title', 'summary']);
  });
  test('流式：最后一条补丁可能没写完，先放到末尾，不吞掉后面的语句', () => {
    const out = mergeSource(BASE, 'title = TextContent("Q3 销', { final: false });
    const names = splitStatements(out).map((s) => s.name);
    expect(names).toEqual(['root', 'chart', 'summary', 'title']);
    const done = mergeSource(BASE, 'title = TextContent("Q3 销售复盘")\nchart = BarChart(["7月"], ', { final: false });
    expect(splitStatements(done).map((s) => s.name)).toEqual(['root', 'title', 'summary', 'chart']);
  });
  test('空补丁原样返回', () => {
    expect(mergeSource(BASE, '', { final: true })).toBe(BASE);
  });
});

describe('readModeLine', () => {
  test('读出 @edit / @new 并去掉这一行', () => {
    expect(readModeLine('@edit\nroot = Card([])')).toEqual({ mode: 'edit', rest: 'root = Card([])' });
    expect(readModeLine('  @NEW  \nroot = Card([])').mode).toBe('new');
    expect(readModeLine('root = Card([])')).toEqual({ mode: null, rest: 'root = Card([])' });
  });
});
