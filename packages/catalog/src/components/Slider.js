import { defineComponent, str, num } from '../define.js';
import { el, fmtNum } from '../dom.js';

export default defineComponent({
  name: 'Slider',
  group: 'Forms',
  description: '滑块，拖动不产生模型调用',
  skeleton: { h: 28 },
  params: [
    num('min', { default: 0 }),
    num('max', { default: 100 }),
    num('value', { required: true }),
    num('step', { default: 1 }),
    str('label'),
  ],
  render: {
    create(p, ctx) {
      const wrap = el('div', 'slider');
      if (p.label) wrap.appendChild(el('div', 'slider-label', p.label));
      const row = el('div', 'slider-row');
      const input = el('input', 'range');
      input.type = 'range';
      input.min = p.min ?? 0;
      input.max = p.max ?? 100;
      input.step = p.step || 1;
      input.value = p.value ?? 0;
      const out = el('span', 'slider-value', fmtNum(p.value ?? 0));
      input.addEventListener('input', () => {
        out.textContent = fmtNum(Number(input.value));
        ctx.emit('change', Number(input.value));
      });
      row.appendChild(input);
      row.appendChild(out);
      wrap.appendChild(row);
      return wrap;
    },
    updates: ['min', 'max', 'step', 'value'],
    update(n, p) {
      const input = n.querySelector('input');
      const out = n.querySelector('.slider-value');
      if (!input) return;
      input.min = p.min ?? 0;
      input.max = p.max ?? 100;
      input.step = p.step || 1;
      // 正在拖动时不要被回传的值抢走
      if (document.activeElement !== input && String(input.value) !== String(p.value ?? 0)) {
        input.value = p.value ?? 0;
      }
      if (out) out.textContent = fmtNum(Number(input.value));
      const lab = n.querySelector('.slider-label');
      if (lab && p.label != null) lab.textContent = p.label;
    },
  },
  markdown: (p) => `（可拖动滑块：${p.label || '数值'}，当前 ${p.value}）`,
  css: `
.slider { display: flex; flex-direction: column; gap: 6px; }
.slider-label { font-size: 12px; color: var(--ui-ink-2); }
.slider-row { display: flex; align-items: center; gap: 12px; }
.range { -webkit-appearance: none; appearance: none; flex: 1; height: 5px; border-radius: 999px; background: var(--ui-band-strong, rgba(17,24,39,.07)); outline: none; }
.range::-webkit-slider-thumb { -webkit-appearance: none; width: 17px; height: 17px; border-radius: 999px; background: var(--accent); border: 3px solid #ffffff; box-shadow: 0 0 0 1px var(--ui-line-strong, rgba(17,24,39,.1)); cursor: pointer; }
.slider-value { font-size: 13px; color: var(--text); min-width: 42px; text-align: right; }
`,
});
