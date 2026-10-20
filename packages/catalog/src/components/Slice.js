import { defineComponent, str, num } from '../define.js';

export default defineComponent({
  name: 'Slice',
  group: 'Charts',
  description: '饼图扇区',
  data: true,
  params: [
    str('label', { required: true }),
    num('value', { required: true }),
  ],
});
