import { defineComponent, str, list } from '../define.js';

export default defineComponent({
  name: 'Note',
  group: 'Meta',
  description: '会话总结条目：只写在 summary = [...] 里，显示在右侧会话总结，不进界面。refs 写它说的是哪些变量（如 ["metrics", "chart"]）',
  data: true,
  params: [str('title', { required: true }), str('text', { required: true }), list('refs')],
});
