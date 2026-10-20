import { defineComponent, nodes, node, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Form',
  group: 'Forms',
  description: '表单容器：fields 是 FormControl 数组，buttons 里放 action 为 "submit:<id>" 的按钮',
  skeleton: { frame: true, lines: 4 },
  params: [
    str('id', { required: true }),
    nodes('fields'),
    node('buttons'),
  ],
  render: {
    create(p, ctx) {
      const n = el('form', 'form');
      n.addEventListener('submit', (e) => e.preventDefault());
      n.__formId = p.id;
      return n;
    },
  },
  css: `
.form { display: flex; flex-direction: column; gap: 12px; }
`,
});
