import { defineComponent, str } from '../define.js';

export default defineComponent({
  name: 'SelectItem',
  group: 'Forms',
  description: '下拉选项',
  data: true,
  params: [
    str('value', { required: true }),
    str('label', { required: true }),
  ],
});
