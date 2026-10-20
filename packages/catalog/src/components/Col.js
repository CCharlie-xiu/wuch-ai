import { defineComponent, str, enumOf } from '../define.js';

export default defineComponent({
  name: 'Col',
  group: 'Data',
  description: '表格列定义',
  data: true,
  params: [
    str('label', { required: true }),
    enumOf('type', ['string', 'number', 'boolean', 'date'], { default: 'string' }),
  ],
});
