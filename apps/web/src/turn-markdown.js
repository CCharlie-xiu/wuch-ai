/** 把一轮界面与右侧说明整理成可复制的 Markdown 文档。 */
export function turnToMarkdown({ userText = '', reply = '', summary = [], source = '', fallbackMarkdown = '', failure = '' } = {}) {
  const sections = ['# 本轮生成'];
  const request = String(userText || '').trim();
  if (request) {
    const quote = request.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
    sections.push(`## 用户需求\n\n${quote}`);
  }

  const page = String(fallbackMarkdown || '').trim();
  if (page) sections.push(`## 页面内容\n\n${page}`);
  else if (source) sections.push('## 页面内容\n\n（当前组件没有 Markdown 展开内容，完整界面源码见下方。）');
  else sections.push('## 页面内容\n\n（本轮没有生成或修改界面。）');

  const answer = String(reply || '').trim();
  if (answer) sections.push(`## 描述\n\n${answer}`);

  const notes = (Array.isArray(summary) ? summary : []).filter((item) => item && !item.kind && (item.title || item.text));
  if (notes.length) {
    sections.push(`## 本轮要点\n\n${notes.map((item) => {
      const title = String(item.title || '').trim();
      const text = String(item.text || '').trim();
      const refs = Array.isArray(item.refs) && item.refs.length ? `（关联：${item.refs.join('、')}）` : '';
      return `- ${title ? `**${title}**${text ? '：' : ''}` : ''}${text}${refs}`;
    }).join('\n')}`);
  }

  if (failure) sections.push(`## 状态\n\n本轮未完成：${String(failure).trim()}`);

  const code = String(source || '').trim();
  if (code) {
    const longestFence = Math.max(0, ...[...code.matchAll(/`+/g)].map(([fence]) => fence.length));
    const fence = '`'.repeat(Math.max(3, longestFence + 1));
    sections.push(`## OpenUI Lang 源码\n\n${fence}openui\n${code}\n${fence}`);
  }

  return sections.join('\n\n');
}
