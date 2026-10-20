import { defineComponent, str, list } from '../define.js';

export default defineComponent({
  name: 'Series',
  group: 'Charts',
  description: '一组数据序列',
  data: true,
  params: [
    str('name', { required: true }),
    list('data', { required: true }),
  ],
});
