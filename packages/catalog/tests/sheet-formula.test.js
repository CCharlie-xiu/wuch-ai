import { describe, expect, test } from 'bun:test';
import { evaluateSheet, parseRef, refName, parseInput, toCell, formatValue, colLetters, colIndex } from '../src/sheet-formula.js';
import { inlineCells } from '../src/components/Sheet.js';

const calc = (rows) => evaluateSheet(rows.map((r) => r.map(toCell)));
const errOf = (v) => (v && v.err) || null;

describe('引用', () => {
  test('A1 / $B$3 / AA10', () => {
    expect(parseRef('A1')).toEqual({ row: 0, col: 0 });
    expect(parseRef('$B$3')).toEqual({ row: 2, col: 1 });
    expect(parseRef('AA10')).toEqual({ row: 9, col: 26 });
    expect(parseRef('1A')).toBeNull();
  });
  test('列号往返', () => {
    for (const i of [0, 25, 26, 51, 701, 702]) expect(colIndex(colLetters(i))).toBe(i);
    expect(refName(4, 27)).toBe('AB5');
  });
});

describe('求值', () => {
  test('四则运算、优先级、百分号、乘方', () => {
    const v = calc([[2, 3, '=A1+B1*2', '=(A1+B1)*2', '=-A1^2', '=50%', '=2^3^2']]);
    expect(v[0].slice(2)).toEqual([8, 10, 4, 0.5, 64]);
  });
  test('区域函数忽略文本，AVERAGE 空区域报 #DIV/0!', () => {
    const v = calc([
      ['名称', '数量'],
      ['a', 3],
      ['b', 5],
      ['c', 'x'],
      ['合计', '=SUM(B2:B4)'],
      ['均值', '=AVERAGE(B2:B4)'],
      ['计数', '=COUNT(B1:B4)'],
      ['空均值', '=AVERAGE(C1:C3)'],
    ]);
    expect(v[4][1]).toBe(8);
    expect(v[5][1]).toBe(4);
    expect(v[6][1]).toBe(2);
    expect(errOf(v[7][1])).toBe('#DIV/0!');
  });
  test('MIN / MAX / ROUND / ABS / IF / CONCAT / 比较', () => {
    const v = calc([[1.256, -4, 9, '=MIN(A1:C1)', '=MAX(A1:C1)', '=ROUND(A1, 2)', '=ABS(B1)', '=IF(C1>5, "高", "低")', '=CONCAT("v", C1)', '=A1<>B1', '="a"&"b"']]);
    expect(v[0].slice(3)).toEqual([-4, 9, 1.26, 4, '高', 'v9', true, 'ab']);
  });
  test('公式引用公式，依赖链按需计算', () => {
    const v = calc([['=B1*2', '=C1+1', 10]]);
    expect(v[0]).toEqual([22, 11, 10]);
  });
  test('循环引用报 #CYCLE!，不影响其他格', () => {
    const v = calc([['=B1', '=A1', 7, '=C1*2']]);
    expect(errOf(v[0][0])).toBe('#CYCLE!');
    expect(errOf(v[0][1])).toBe('#CYCLE!');
    expect(v[0][3]).toBe(14);
  });
  test('IF 只算被选中的分支', () => {
    const v = calc([[1, '=IF(A1=1, 5, B1)']]);
    expect(v[0][1]).toBe(5);
  });
  test('错误：未知函数、语法错、除零、文本参与运算', () => {
    const v = calc([['=FOO(1)', '=1+', '=1/0', '="a"*2', '=SUM(A1:A1)']]);
    expect(v[0].slice(0, 4).map(errOf)).toEqual(['#NAME?', '#VALUE!', '#DIV/0!', '#VALUE!']);
    expect(errOf(v[0][4])).toBe('#NAME?');
  });
  test('导入的缓存值不影响公式重算', () => {
    const v = evaluateSheet([[{ v: 1 }, { v: 2 }, { v: 999, f: 'A1+B1' }]]);
    expect(v[0][2]).toBe(3);
  });
});

describe('输入与显示', () => {
  test('编辑框文字 → 单元格', () => {
    expect(parseInput('=A1')).toEqual({ v: null, f: 'A1' });
    expect(parseInput('12.5')).toEqual({ v: 12.5 });
    expect(parseInput('  ')).toEqual({ v: null });
    expect(parseInput('TRUE')).toEqual({ v: true });
    expect(parseInput('北区')).toEqual({ v: '北区' });
  });
  test('格式化', () => {
    expect(formatValue(1234567)).toBe('1,234,567');
    expect(formatValue(0.1 + 0.2)).toBe('0.3');
    expect(formatValue({ err: '#REF!' })).toBe('#REF!');
    expect(formatValue(null)).toBe('');
  });
  test('内联表：表头占第 1 行，公式字符串变成公式', () => {
    const cells = inlineCells(['产品', '金额'], [['A', '=1+1']]);
    expect(cells[0].map((c) => c.v)).toEqual(['产品', '金额']);
    expect(cells[1][1]).toEqual({ v: null, f: '1+1' });
    expect(evaluateSheet(cells)[1][1]).toBe(2);
  });
});
