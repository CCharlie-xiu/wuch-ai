import { defineComponent, str, bool } from '../define.js';

export default defineComponent({
  name: 'TaskItem',
  group: 'Layout',
  description: '任务清单里的一项',
  data: true,
  params: [
    str('title', { required: true }),
    str('note'),
    bool('done', { default: false }),
  ],
});
