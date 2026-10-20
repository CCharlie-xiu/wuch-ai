// ─────────────────────────────────────────────────────────────────────────────
// AST：三种形态，对应流水线的三个阶段
//
//   Expr / RawProgram       语法树（parser 产出，字面量仍是字面量）
//        ↓ resolve
//   Resolved                引用已解析（变量被内联成值或组件节点）
//        ↓ normalize
//   UiAst / UiNode          规范化 UI AST（只有 root 可达的节点）
//
// 为什么分三层而不是一层：每一层的「合法输入」不同。语法层不该知道组件目录，
// 解析层不该知道参数类型，校验层才拿注册表。混在一起会让错误定位变难。
// ─────────────────────────────────────────────────────────────────────────────

import type { Pos } from './diagnostics.ts';

// ── 字面量 ──────────────────────────────────────────────────────────────────
/** DSL 里能写的全部字面量。没有 undefined / 函数 / 对象字面量 —— 这是刻意的窄。 */
export type Literal = string | number | boolean | null;

// ── 第一层：语法树 ──────────────────────────────────────────────────────────
export type Expr =
  | { kind: 'string'; value: string; pos: Pos }
  | { kind: 'number'; value: number; pos: Pos }
  | { kind: 'boolean'; value: boolean; pos: Pos }
  | { kind: 'null'; pos: Pos }
  | { kind: 'array'; items: Expr[]; pos: Pos }
  | { kind: 'ref'; name: string; pos: Pos }
  | { kind: 'call'; component: string; args: Expr[]; pos: Pos };

/** 一条顶层语句：`name = <Expr>` */
export interface Definition {
  name: string;
  value: Expr;
  /** 变量名位置（重复定义、未引用警告报这里） */
  pos: Pos;
}

export interface RawProgram {
  definitions: Definition[];
}

// ── 第二层：引用解析后 ──────────────────────────────────────────────────────
export type Resolved =
  | { kind: 'literal'; value: Literal; pos: Pos }
  | { kind: 'array'; items: Resolved[]; pos: Pos }
  | {
      kind: 'node';
      /** 顶层变量名；内联调用（如 FormControl 里的 Input）为空串 */
      name: string;
      component: string;
      args: Resolved[];
      pos: Pos;
      /**
       * 实参绑定结果：与注册表参数顺序**下标对齐**。
       * undefined = 尾部未提供；null = 显式缺省或缺省被跳过。
       * 由 validate.ts 填入；未注册组件不会有这个字段。
       */
      slots?: (Resolved | null | undefined)[];
    };

// ── 第三层：规范化 UI AST ───────────────────────────────────────────────────
/** 参数位置上的值。数组可嵌套（rules 是字符串数组，options 是节点数组）。 */
export type UiValue = UiNode | Literal | UiValue[];

export interface UiNode {
  /** 该节点来自哪个变量；内联调用为空串 */
  varName: string;
  component: string;
  /**
   * 位置参数，**下标与注册表声明的参数顺序对齐**。
   * 被跳过的可选参数（以及作者写的 null）都占位为 null，
   * 所以下游可以安全地按下标取值。尾部未提供的参数直接省略。
   */
  args: UiValue[];
  pos: Pos;
}

/** 源位置映射：变量名 → 位置。便于把校验错误映射回用户可见的原文。 */
export interface PositionMap {
  /** 全部顶层定义（含未被引用的） */
  definitions: Record<string, Pos>;
  /** 变量引用的首次出现位置 */
  references: Record<string, Pos>;
}

export interface UiAst {
  root: UiNode;
  /** root 可达的变量名，按首次被解析顺序 */
  reachable: string[];
  /** 仅 root 可达的定义：变量名 → 规范化节点 */
  nodes: Record<string, UiNode>;
  positions: PositionMap;
}
