import { defineComponent, str, bool } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'SwitchItem',
  group: 'Forms',
  description: '开关项',
  skeleton: { lines: 1 },
  params: [
    str('name', { required: true }),
    str('label', { required: true }),
    bool('checked', { default: false }),
  ],
  render: {
    create(p, ctx) {
      const n = el('label', 'switch');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = !!p.checked;
      box.addEventListener('change', () => ctx.emit('change', box.checked));
      const track = el('span', 'switch-track');
      track.appendChild(el('span', 'switch-knob'));
      n.appendChild(box);
      n.appendChild(track);
      n.appendChild(el('span', 'switch-label', p.label));
      return n;
    },
    updates: ['checked'],
    update(n, p) {
      const box = n.querySelector('input');
      if (box && box.checked !== !!p.checked) box.checked = !!p.checked;
    },
  },
  css: `
.switch { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; font-size: 13px; }
.switch input { display: none; }
.switch-track { width: 36px; height: 20px; border-radius: 999px; background: var(--ui-band-strong, rgba(17,24,39,.07)); border: 1px solid transparent; position: relative; transition: background .2s ease; }
.switch-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 999px; background: #ffffff; box-shadow: 0 1px 2px rgba(16, 16, 20, .2); transition: all .2s ease; }
.switch input:checked + .switch-track { background: var(--accent); border-color: var(--accent); }
.switch input:checked + .switch-track .switch-knob { left: 18px; }
`,
});
