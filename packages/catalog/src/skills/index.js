// 内置技能清单：一个技能 = 一组组件 + 一段提示词 + 若干工具 + 可接受的上传类型。
// 用户在输入框「+」里选中后才进模型上下文。外部技能（数据库 skill.manifest）走同一个形状。

import canvas from './canvas.js';
import sheet from './sheet.js';

const KEYS = ['id', 'name', 'description', 'placeholder', 'icon', 'accepts', 'components', 'tools', 'prompt'];

function check(s) {
  const where = `技能 ${s && s.id}`;
  if (!s || !/^[a-z][a-z0-9-]*$/.test(s.id || '')) throw new Error(`${where}：id 必须是小写 id`);
  for (const k of KEYS) if (s[k] == null) throw new Error(`${where}：缺少 ${k}`);
  if (!Array.isArray(s.components) || !Array.isArray(s.tools) || !Array.isArray(s.accepts)) throw new Error(`${where}：components / tools / accepts 必须是数组`);
  return Object.freeze(s);
}

export const SKILLS = [canvas, sheet].map(check);
