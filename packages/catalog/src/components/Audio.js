import { defineComponent, str } from '../define.js';
import { el, icon, httpUrl, whenSettled, fmtTime } from '../dom.js';

const SPEEDS = [1, 1.25, 1.5, 2];

export default defineComponent({
  name: 'Audio',
  group: 'Media',
  description: '音频播放条：播放 / 暂停、进度拖动、时长、倍速。src 填 http(s) 音频文件地址（mp3 / m4a / ogg / wav），subtitle 可写作者或节目名，cover 为封面图地址',
  skeleton: { frame: true, h: 44, lines: 1 },
  params: [
    str('src', { required: true }),
    str('title'),
    str('subtitle'),
    str('cover'),
  ],
  render: {
    create(p) {
      const n = el('div', 'audio');
      const cover = el('div', 'audio-cover');
      const coverUrl = httpUrl(p.cover);
      if (coverUrl) {
        const img = el('img');
        img.src = coverUrl;
        img.alt = '';
        img.loading = 'lazy';
        cover.appendChild(img);
      } else cover.appendChild(icon('music', 'icon'));

      const play = el('button', 'audio-play');
      play.type = 'button';
      play.title = '播放';
      play.disabled = true;
      play.appendChild(icon('play', 'icon sm'));

      const meta = el('div', 'audio-meta');
      meta.appendChild(el('div', 'audio-title', p.title || '音频'));
      if (p.subtitle) meta.appendChild(el('div', 'audio-sub', p.subtitle));

      const speed = el('button', 'audio-speed', '1×');
      speed.type = 'button';
      speed.title = '倍速';
      speed.disabled = true;

      const bar = el('div', 'audio-bar');
      const cur = el('span', 'audio-time', '0:00');
      const seek = el('input', 'audio-seek');
      seek.type = 'range';
      seek.min = '0';
      seek.max = '0';
      seek.step = '0.1';
      seek.value = '0';
      seek.disabled = true;
      const total = el('span', 'audio-time', '--:--');
      bar.append(cur, seek, total);

      const top = el('div', 'audio-top');
      top.append(cover, play, meta, speed);
      n.append(top, bar);

      whenSettled(n, () => {
        const href = httpUrl(p.src);
        if (!href) {
          n.classList.add('error');
          total.textContent = '地址无效';
          return;
        }
        const a = el('audio');
        a.preload = 'metadata';
        const sync = () => {
          seek.style.setProperty('--p', a.duration ? a.currentTime / a.duration : 0);
          if (!seek.__drag) seek.value = String(a.currentTime);
          cur.textContent = fmtTime(a.currentTime);
        };
        const setIcon = () => {
          play.replaceChildren(icon(a.paused ? 'play' : 'pause', 'icon sm'));
          play.title = a.paused ? '播放' : '暂停';
          n.classList.toggle('playing', !a.paused);
        };
        a.addEventListener('loadedmetadata', () => {
          seek.max = String(a.duration || 0);
          total.textContent = fmtTime(a.duration);
          play.disabled = speed.disabled = seek.disabled = false;
        });
        a.addEventListener('timeupdate', sync);
        a.addEventListener('play', setIcon);
        a.addEventListener('pause', setIcon);
        a.addEventListener('ended', setIcon);
        a.addEventListener('error', () => {
          n.classList.add('error');
          total.textContent = '无法加载';
          play.disabled = speed.disabled = seek.disabled = true;
        });
        play.addEventListener('click', () => (a.paused ? a.play().catch(() => {}) : a.pause()));
        speed.addEventListener('click', () => {
          a.playbackRate = SPEEDS[(SPEEDS.indexOf(a.playbackRate) + 1) % SPEEDS.length];
          speed.textContent = `${a.playbackRate}×`;
        });
        seek.addEventListener('input', () => {
          seek.__drag = true;
          cur.textContent = fmtTime(Number(seek.value));
          seek.style.setProperty('--p', a.duration ? Number(seek.value) / a.duration : 0);
        });
        seek.addEventListener('change', () => {
          a.currentTime = Number(seek.value);
          seek.__drag = false;
        });
        a.src = href;
        n.appendChild(a);
      });
      return n;
    },
  },
  markdown: (p) => `[音频：${p.title || p.src || ''}](${p.src ?? ''})`,
  css: `
.audio { display: flex; flex-direction: column; gap: 10px; border: 0; border-radius: 12px; padding: 12px 14px; background: var(--ui-band, rgba(17,24,39,.035)); min-width: 0; }
.audio-top { display: flex; align-items: center; gap: 12px; min-width: 0; }
.audio-cover { width: 44px; height: 44px; flex: 0 0 auto; border-radius: 9px; overflow: hidden; background: var(--ui-band-strong, rgba(17,24,39,.07)); display: grid; place-items: center; color: var(--ui-ink-3); }
.audio-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.audio-play { width: 36px; height: 36px; flex: 0 0 auto; border-radius: 50%; border: 0; background: var(--accent); color: var(--accent-text); display: grid; place-items: center; cursor: pointer; transition: transform .12s, opacity .12s; }
.audio-play:hover:not(:disabled) { transform: scale(1.06); }
.audio-play:disabled { opacity: .35; cursor: default; }
.audio-play .icon { stroke-width: 2.4; }
.audio-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.audio-title { font-size: 13.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.audio-sub { font-size: 12px; color: var(--ui-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.audio-speed { flex: 0 0 auto; font-size: 11.5px; font-weight: 600; color: var(--ui-ink-2); background: transparent; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); border-radius: 7px; padding: 4px 8px; cursor: pointer; min-width: 44px; }
.audio-speed:hover:not(:disabled) { color: var(--text); }
.audio-speed:disabled { opacity: .45; cursor: default; }
.audio-bar { display: flex; align-items: center; gap: 10px; }
.audio-time { font-size: 11px; color: var(--ui-ink-3); min-width: 36px; font-variant-numeric: tabular-nums; }
.audio-time:last-child { text-align: right; }
.audio-seek { flex: 1; min-width: 0; height: 4px; margin: 0; appearance: none; -webkit-appearance: none; border-radius: 999px; cursor: pointer;
  --fill: calc(6px + (100% - 12px) * var(--p, 0));
  background: linear-gradient(to right, var(--text) var(--fill), var(--ui-line-strong, rgba(17,24,39,.1)) var(--fill)); }
.audio-seek:disabled { cursor: default; }
.audio-seek::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: var(--text); border: 2px solid var(--card); box-shadow: 0 0 0 1px var(--ui-line-strong, rgba(17,24,39,.1)); }
.audio-seek::-moz-range-thumb { width: 10px; height: 10px; border-radius: 50%; background: var(--text); border: 2px solid var(--card); }
.audio.error .audio-time:last-child { color: var(--danger); font-family: inherit; }
`,
});
