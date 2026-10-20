// 边界 token 的静态检查：防止「两层边界」的约定被后续改动悄悄破坏。
//
//   bun test packages/catalog/tests  （或 bun run test:catalog）
//
// 只扫字符串里的 CSS，不渲染、不碰 DOM。

import { describe, expect, test } from 'bun:test';
import { BASE_CSS } from '../src/styles.js';
import { CODE_CSS } from '../src/code.js';
import { CHART_CSS } from '../src/echarts.js';
import COMPONENTS from '../src/components/index.js';

const allCss = [BASE_CSS, CODE_CSS, CHART_CSS, ...COMPONENTS.map((c) => c.css || '')].join('\n');

/** 去掉注释再断言：注释里提到旧色值 / 旧 token 是说明，不是用法 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const code = stripComments(allCss);

describe('三层边界', () => {
  test('块级元素不再用 --border / --border-soft 描边', () => {
    // --border 是宿主壳层的线，组件内部要区分「块 / 块内 / 控件」三层，
    // 直接引用它就会退回「所有边界一样粗」的老问题。
    const hits = code.match(/var\(--border(-soft)?\)/g) || [];
    expect(hits).toEqual([]);
  });

  test('三层 token 都在 BASE_CSS 里定义', () => {
    for (const name of ['--ui-band', '--ui-band-strong', '--ui-line', '--ui-line-strong']) {
      expect(BASE_CSS).toContain(`${name}:`);
    }
  });

  test('块级元素不描边（Card / Sheet / Table / Audio / CodeBlock）', () => {
    const blocks = [
      ...COMPONENTS.filter((c) => ['Card', 'Sheet', 'Table', 'Audio'].includes(c.name)).map((c) => c.css),
      CODE_CSS,
    ].join('\n');
    // 这些选择器的主规则里不应出现 `border: 1px solid`
    for (const sel of ['.card {', '.sheet {', '.table-wrap {', '.audio {', '.code-block {']) {
      const i = blocks.indexOf(sel);
      if (i < 0) continue;
      const rule = blocks.slice(i, blocks.indexOf('}', i));
      expect(rule).not.toContain('border: 1px solid');
    }
  });

  test('三级文字不再用 2.7:1 的 #98a1b0', () => {
    expect(code).not.toContain('#98a1b0');
  });
});
