// ─────────────────────────────────────────────────────────────────────────────
// 宽容分析（analyzeUiDsl）测试：流式切口、悬空引用、局部摘除
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from 'bun:test';

import { analyzeUiDsl, CODES, type UiNode } from '../src/index.ts';

const SRC = `root = Stack([title, card], "column", "l")
title = TextContent("季度销量", "xl-heavy")
card = Card([CardHeader("北区"), TextContent("同比 +12%")])
`;

const codes = (ds: { code: string }[]) => ds.map((d) => d.code);
const kids = (n: UiNode | null) => (n ? (n.args[0] as UiNode[]) : []);

describe('流式切口', () => {
  test('任意位置切开都不抛错，且从不报真错误', () => {
    for (let cut = 0; cut <= SRC.length; cut++) {
      const r = analyzeUiDsl(SRC.slice(0, cut));
      expect({ cut, errors: r.diagnostics.filter((d) => d.severity === 'error') }).toEqual({ cut, errors: [] });
    }
  });

  test('root 一行写完就有骨架，后面的变量先进 pending', () => {
    const r = analyzeUiDsl(SRC.split('\n')[0]!);
    expect(r.root?.component).toBe('Stack');
    expect(kids(r.root)).toEqual([]);
    expect(r.pending.sort()).toEqual(['card', 'title']);
  });

  test('半截字符串被临时补齐，文字边写边出', () => {
    const r = analyzeUiDsl('root = Stack([title])\ntitle = TextContent("季度销');
    expect(kids(r.root)[0]!.args[0]).toBe('季度销');
    expect(r.partial).toBe(true);
    expect(codes(r.recovery)).toContain(CODES.INCOMPLETE_STATEMENT);
  });

  test('补齐语句里的半截枚举值只记恢复诊断', () => {
    const r = analyzeUiDsl('root = TextContent("hi", "xl-he');
    expect(r.root?.component).toBe('TextContent');
    expect(r.diagnostics).toEqual([]);
    expect(codes(r.recovery)).toContain(CODES.ARG_TYPE);
  });

  test('流结束时没写完的语句才算错误', () => {
    const r = analyzeUiDsl('root = Stack([a])\na = TextContent("x', { final: true });
    expect(codes(r.diagnostics)).toContain(CODES.INCOMPLETE_STATEMENT);
    expect(r.partial).toBe(false);
  });

  test('流结束时仍悬空的引用报 UNDEFINED_REFERENCE', () => {
    const r = analyzeUiDsl('root = Stack([a, b])\na = TextContent("x")', { final: true });
    expect(codes(r.diagnostics)).toContain(CODES.UNDEFINED_REFERENCE);
    expect(kids(r.root).length).toBe(1);
  });
});

describe('局部摘除', () => {
  test('未知组件只摘掉自己', () => {
    const r = analyzeUiDsl('root = Stack([Foo("a"), TextContent("b")])', { final: true });
    expect(codes(r.diagnostics)).toContain(CODES.UNKNOWN_COMPONENT);
    expect(kids(r.root).map((n) => n.component)).toEqual(['TextContent']);
  });

  test('缺必填参数的组件被摘掉，兄弟节点照常', () => {
    const r = analyzeUiDsl('root = Stack([CardHeader(), TextContent("b")])', { final: true });
    expect(codes(r.diagnostics)).toContain(CODES.DROPPED_COMPONENT);
    expect(kids(r.root).map((n) => n.component)).toEqual(['TextContent']);
  });

  test('中间坏掉的语句跳过，下一条继续', () => {
    const r = analyzeUiDsl('root = Stack([a, b])\na = TextContent("x" "y")\nb = TextContent("z")', { final: true });
    expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(kids(r.root).map((n) => n.args[0])).toEqual(['z']);
  });

  test('同名变量再定义：后者覆盖前者', () => {
    const r = analyzeUiDsl('root = Stack([a])\na = TextContent("旧")\na = TextContent("新")', { final: true });
    expect(codes(r.diagnostics)).toContain(CODES.REDEFINED);
    expect(kids(r.root)[0]!.args[0]).toBe('新');
  });

  test('引用成环报错，不会死循环', () => {
    const r = analyzeUiDsl('root = Stack([a])\na = Card([b])\nb = Card([a])', { final: true });
    expect(codes(r.diagnostics)).toContain(CODES.CYCLIC_REFERENCE);
  });

  test('没有 root 时取第一条定义', () => {
    const r = analyzeUiDsl('main = TextContent("hi")');
    expect(r.rootName).toBe('main');
    expect(r.root?.component).toBe('TextContent');
  });
});

describe('sidecars', () => {
  const WITH_SUMMARY = `summary = [Note("要点", "同比 +12%", ["card"])]\n${SRC}`;

  test('sidecar 单独取值，不当 root，不报未引用', () => {
    const r = analyzeUiDsl(WITH_SUMMARY, { final: true, sidecars: ['summary'] });
    expect(r.rootName).toBe('root');
    expect(codes(r.diagnostics)).toEqual([]);
    const notes = r.sidecars.summary as UiNode[];
    expect(notes.map((n) => n.component)).toEqual(['Note']);
    expect(notes[0]!.args).toEqual(['要点', '同比 +12%', ['card']]);
  });

  test('没声明 sidecars 时照旧报未引用', () => {
    const r = analyzeUiDsl(WITH_SUMMARY, { final: true });
    expect(codes(r.diagnostics)).toContain(CODES.UNUSED_DEFINITION);
    expect(r.sidecars).toEqual({});
  });

  test('没有 root 时跳过 sidecar 选第一个界面变量', () => {
    const r = analyzeUiDsl(`summary = [Note("a", "b")]\nmain = TextContent("x")`, { sidecars: ['summary'] });
    expect(r.rootName).toBe('main');
  });
});

describe('流式占位（placeholder 选项）', () => {
  const PH = { placeholder: 'Placeholder' };
  const phOf = (n: UiNode) => (n.component === 'Placeholder' ? [n.varName, n.args[0]] : null);

  test('还没写到的变量在子节点位置占位，带上变量名', () => {
    const r = analyzeUiDsl(SRC.split('\n')[0]!, PH);
    expect(kids(r.root).map(phOf)).toEqual([['title', ''], ['card', '']]);
    expect(r.pending.sort()).toEqual(['card', 'title']);
  });

  test('写到一半、必填还缺的组件按自己的类型占位', () => {
    const r = analyzeUiDsl('root = Stack([chart])\nchart = BarChart(["Q1", "Q2"]', PH);
    expect(kids(r.root).map(phOf)).toEqual([['chart', 'BarChart']]);
  });

  test('单个子节点参数（node）上的悬空引用也占位，其余参数对齐不变', () => {
    const r = analyzeUiDsl('root = Callout("warning", "标题", body)', PH);
    expect(r.root!.args.slice(0, 2)).toEqual(['warning', '标题']);
    expect(phOf(r.root!.args[2] as UiNode)).toEqual(['body', '']);
  });

  test('数据参数里的占位被剔除，不会变成数据', () => {
    const r = analyzeUiDsl('root = BarChart(["Q1"], [Series("北区", [3]), s2])', PH);
    expect(r.root!.component).toBe('BarChart');
    expect((r.root!.args[1] as UiNode[]).map((s) => s.component)).toEqual(['Series']);
  });

  test('sidecar 里写到一半的 Note 不进总结', () => {
    const r = analyzeUiDsl('root = TextContent("x")\nsummary = [Note("a", "b"), Note("c"', { ...PH, sidecars: ['summary'] });
    expect((r.sidecars.summary as UiNode[]).map((n) => n.component)).toEqual(['Note']);
  });

  test('流结束（final）时不占位，照旧报悬空引用', () => {
    const r = analyzeUiDsl(SRC.split('\n')[0]!, { ...PH, final: true });
    expect(kids(r.root)).toEqual([]);
    expect(codes(r.diagnostics)).toContain(CODES.UNDEFINED_REFERENCE);
  });

  test('任意切口都不抛错、不报真错误，写完后不留占位', () => {
    for (let cut = 0; cut <= SRC.length; cut++) {
      const r = analyzeUiDsl(SRC.slice(0, cut), PH);
      expect({ cut, errors: r.diagnostics.filter((d) => d.severity === 'error') }).toEqual({ cut, errors: [] });
    }
    expect(JSON.stringify(analyzeUiDsl(SRC, PH).root)).not.toContain('Placeholder');
  });
});
