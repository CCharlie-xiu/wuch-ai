import { defineComponent, str } from '../define.js';
import { codeView } from '../code.js';

export default defineComponent({
  name: 'CodeBlock',
  group: 'Content',
  description: '代码块：按 language 语法高亮（python / typescript / bash / sql / json / go …），带复制按钮；code 里换行写 \\n',
  skeleton: { frame: true, lines: 5 },
  params: [
    str('code', { required: true }),
    str('language'),
    str('filename'),
  ],
  render: {
    create: (p) => codeView(p.code, p.language, p.filename),
    updates: ['code', 'language', 'filename'],
    update(n, p) {
      n.__set(p.code, p.language, p.filename);
    },
  },
  markdown: (p) => '```' + (p.language || '') + '\n' + (p.code ?? '') + '\n```',
});
