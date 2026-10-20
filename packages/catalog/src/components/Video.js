import { defineComponent, str, num } from '../define.js';
import { el, icon, httpUrl, whenSettled } from '../dom.js';

// 视频站的页面链接 <video> 播不了：认出视频 ID 后用官方播放器嵌入。
// 嵌入地址由 ID 拼出来，不直接用模型给的 URL；iframe 加 sandbox。
export function videoEmbed(src, start) {
  const href = httpUrl(src);
  if (!href) return null;
  const u = new URL(href);
  const host = u.hostname.replace(/^(www|m)\./, '');
  const t = Math.max(0, Math.floor(Number(start) || 0));
  let id;
  if (host === 'youtu.be') id = u.pathname.slice(1);
  else if (host === 'youtube.com') id = u.searchParams.get('v') || /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname)?.[1];
  if (id && /^[\w-]{11}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}${t ? `?start=${t}` : ''}`;
  if (host === 'bilibili.com') {
    const bv = /^\/video\/(BV[0-9A-Za-z]{10})/.exec(u.pathname)?.[1];
    const page = Number(u.searchParams.get('p')) || 1;
    if (bv) return `https://player.bilibili.com/player.html?bvid=${bv}&p=${page}&autoplay=0${t ? `&t=${t}` : ''}`;
  }
  if (host === 'vimeo.com') {
    const vid = /^\/(\d+)/.exec(u.pathname)?.[1];
    if (vid) return `https://player.vimeo.com/video/${vid}${t ? `#t=${t}s` : ''}`;
  }
  return null;
}

const ratio = (r) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(r ?? ''));
  return m ? `${m[1]} / ${m[2]}` : '16 / 9';
};

function failed(box, href) {
  const msg = el('div', 'video-error');
  msg.appendChild(el('span', null, '视频无法播放'));
  if (href) {
    const a = el('a', null, '在新标签页打开');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noreferrer';
    msg.appendChild(a);
  }
  box.replaceChildren(msg);
}

export default defineComponent({
  name: 'Video',
  group: 'Media',
  description:
    '视频播放器。src 填 http(s) 视频文件地址（mp4 / webm），或 YouTube / B 站 / Vimeo 的视频页链接（自动嵌入官方播放器）；aspectRatio 如 "16:9"、竖屏 "9:16"；start 为起播秒数',
  skeleton: { ratio: '16 / 9' },
  params: [
    str('src', { required: true }),
    str('title'),
    str('poster'),
    str('aspectRatio', { default: '16:9' }),
    num('start'),
  ],
  render: {
    create(p) {
      const fig = el('figure', 'figure video');
      const box = el('div', 'video-box');
      box.style.aspectRatio = ratio(p.aspectRatio);
      box.appendChild(icon('play', 'icon video-wait'));
      fig.appendChild(box);
      if (p.title) fig.appendChild(el('figcaption', null, p.title));

      whenSettled(fig, () => {
        const href = httpUrl(p.src);
        const embed = videoEmbed(p.src, p.start);
        if (embed) {
          const f = el('iframe', 'video-frame');
          f.src = embed;
          f.title = p.title || '视频';
          f.loading = 'lazy';
          f.allow = 'fullscreen; picture-in-picture; encrypted-media';
          f.allowFullscreen = true;
          f.referrerPolicy = 'strict-origin-when-cross-origin';
          f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
          box.replaceChildren(f);
          return;
        }
        if (!href) return failed(box, null);
        const v = el('video', 'video-el');
        v.controls = true;
        v.playsInline = true;
        v.preload = 'metadata';
        const poster = httpUrl(p.poster);
        if (poster) v.poster = poster;
        v.addEventListener('error', () => failed(box, href));
        v.src = p.start > 0 ? `${href}#t=${Number(p.start)}` : href;
        box.replaceChildren(v);
      });
      return fig;
    },
  },
  markdown: (p) => `[视频：${p.title || p.src || ''}](${p.src ?? ''})`,
  css: `
.video-box { position: relative; width: 100%; border-radius: 11px; overflow: hidden; background: #0b0b0f; border: 1px solid var(--border); display: grid; place-items: center; }
.video-el, .video-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }
.video-el { object-fit: contain; }
.video-wait { width: 28px; height: 28px; color: rgba(255, 255, 255, .35); }
.video-error { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12.5px; color: rgba(255, 255, 255, .7); }
.video-error a { color: #fff; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
`,
});
