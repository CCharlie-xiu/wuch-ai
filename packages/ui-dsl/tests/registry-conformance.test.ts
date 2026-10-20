// ─────────────────────────────────────────────────────────────────────────────
// 注册表 ↔ 真实 catalog 一致性
//
// registry.ts 由 catalog 的组件文件派生：新增组件只动 catalog，DSL 自动认得。
// 这里验证派生没有丢信息 —— 组件集合、参数顺序 / 类型 / required / default /
// enum 取值、token 表都与 catalog 逐条一致。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from 'bun:test';
import { CATALOG, TOKENS } from '@openui-lab/catalog';

import { ENUMS, MAX_WIDTHS, REGISTRY, SPACE_TOKENS, TEXT_STYLES } from '../src/index.ts';

describe('注册表 ↔ catalog：组件集合', () => {
  test('注册表里的每个组件都能在 catalog 找到', () => {
    const missing = [...REGISTRY.keys()].filter((name) => !CATALOG.has(name));
    expect(missing).toEqual([]);
  });

  test('catalog 里的每个组件都进了注册表（新增组件不用改 DSL）；内部组件除外', () => {
    const open = [...CATALOG.values()].filter((c) => !c.internal).map((c) => c.name);
    const missing = open.filter((name) => !REGISTRY.has(name));
    expect(missing).toEqual([]);
    expect(REGISTRY.size).toBe(open.length);
    expect([...CATALOG.values()].filter((c) => c.internal && REGISTRY.has(c.name))).toEqual([]);
  });

  test('数据型组件标记跟随 catalog', () => {
    for (const [name, spec] of REGISTRY) {
      expect({ name, data: spec.data }).toEqual({ name, data: CATALOG.get(name)!.data === true });
    }
  });

  test('分组名与 catalog 一致', () => {
    for (const [name, spec] of REGISTRY) {
      expect(spec.group).toBe(CATALOG.get(name)!.group);
    }
  });
});

describe('注册表 ↔ catalog：参数契约逐条对齐', () => {
  test('参数数量一致', () => {
    for (const [name, spec] of REGISTRY) {
      const cat = CATALOG.get(name)!;
      expect({ component: name, count: spec.params.length }).toEqual({
        component: name,
        count: cat.params.length,
      });
    }
  });

  test('参数名 / 类型 / required / default / enum 逐位置一致', () => {
    for (const [name, spec] of REGISTRY) {
      const cat = CATALOG.get(name)!;
      cat.params.forEach((catParam, i) => {
        const regParam = spec.params[i]!;
        const where = `${name}#${i + 1}`;
        // 名字与顺序：位置参数的全部含义就在这里
        expect({ where, name: regParam.name }).toEqual({ where, name: catParam.name });
        expect({ where, type: regParam.type }).toEqual({ where, type: catParam.type });
        expect({ where, required: regParam.required }).toEqual({ where, required: catParam.required });
        expect({ where, default: regParam.default as unknown }).toEqual({
          where,
          default: catParam.default as unknown,
        });

        if (catParam.type === 'enum') {
          expect({ where, enum: regParam.enum }).toEqual({ where, enum: catParam.enum });
        } else {
          expect({ where, enum: regParam.enum ?? null }).toEqual({ where, enum: null });
        }
      });
    }
  });
});

describe('注册表 ↔ catalog：token 与 enum 取值表', () => {
  test('space token 表来自 TOKENS.gap', () => {
    expect([...SPACE_TOKENS] as string[]).toEqual(Object.keys(TOKENS.gap));
  });

  test('文本样式表来自 TOKENS.text', () => {
    expect([...TEXT_STYLES] as string[]).toEqual(Object.keys(TOKENS.text));
  });

  test('maxWidth 表来自 TOKENS.maxWidth', () => {
    expect([...MAX_WIDTHS] as string[]).toEqual(Object.keys(TOKENS.maxWidth));
  });

  test('每个 enum 参数都拿到了取值表', () => {
    for (const [name, spec] of REGISTRY) {
      for (const p of spec.params) {
        if (p.type !== 'enum') continue;
        expect({ where: `${name}.${p.name}`, has: Array.isArray(p.enum) }).toEqual({
          where: `${name}.${p.name}`,
          has: true,
        });
        expect({ where: `${name}.${p.name}`, key: `${name}.${p.name}` in ENUMS }).toEqual({
          where: `${name}.${p.name}`,
          key: true,
        });
      }
    }
  });
});
