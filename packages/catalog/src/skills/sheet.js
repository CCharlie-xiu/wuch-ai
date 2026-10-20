// Excel 技能：Sheet 可编辑表格（内联小表 / 绑定导入的数据集），公式在页面上实时计算

export default {
  id: 'sheet',
  name: 'Excel',
  description: '可编辑表格，支持公式与 xlsx 导入导出',
  placeholder: '描述要整理或分析的表格…',
  icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M3 15h18M9 4v16M15 4v16"/></svg>',
  accepts: ['.xlsx', '.xls', '.csv'],
  components: ['Sheet'],
  tools: [],
  prompt: `## 技能：Excel 表格

用户选了 Excel：数据放进 \`Sheet\`，用户可以直接改单元格、导出 xlsx。

- 内联小表：\`Sheet(cols, rows, editable?, caption?)\`。cols 是表头字符串数组，rows 是二维数组；表头占第 1 行，数据从第 2 行开始，列从 A 开始编号。
- 公式写成以 = 开头的字符串，和 Excel 一样引用单元格：\`"=SUM(B2:B5)"\`、\`"=B2*C2"\`、\`"=ROUND(AVERAGE(D2:D9), 1)"\`。支持 + - * / ^ & 比较运算，函数 SUM / AVERAGE / MIN / MAX / COUNT / ROUND / ABS / IF / CONCAT。合计、占比、增长率都用公式算，不要手算好写死。
- 绑定数据集：下方「数据集」里列出的表用 \`Sheet("ds_xxx", "工作表名"?, editable?, caption?)\` 引用，只写 id，不要把数据抄进原文；需要图表时从样例行里取数。
- 表格旁边可以配图表和结论；summary 的 refs 写 Sheet 的变量名。`,
};
