// ─────────────────────────────────────────────────────────────────────────────
// 规范化：Resolved → UiValue
//
// 已注册组件有绑定结果（slots）：按参数下标对齐输出，被跳过/显式缺省的位置
// 补成 null，尾部未提供的参数省略。这样「第 N 个参数」在下游是稳定的。
// 未注册组件没有绑定：原样输出，至少不丢信息。
// ─────────────────────────────────────────────────────────────────────────────

import type { Resolved, UiValue } from './ast.ts';

export function normalize(value: Resolved): UiValue {
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'array':
      return value.items.map(normalize);
    case 'node':
      return {
        varName: value.name,
        component: value.component,
        args: normalizeArgs(value),
        pos: value.pos,
      };
  }
}

function normalizeArgs(value: Resolved & { kind: 'node' }): UiValue[] {
  const slots = value.slots;
  if (!slots) return value.args.map(normalize);

  let lastProvided = -1;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] !== undefined) lastProvided = i;
  }
  const out: UiValue[] = [];
  for (let i = 0; i <= lastProvided; i++) {
    const slot = slots[i];
    out.push(slot === null || slot === undefined ? null : normalize(slot));
  }
  return out;
}
