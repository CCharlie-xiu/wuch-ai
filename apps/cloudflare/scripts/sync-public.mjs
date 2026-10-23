// 把 docs/ 介绍页与宣传图同步进 Workers Static Assets（不覆盖聊天首页）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.resolve(HERE, '../public');

fs.mkdirSync(path.join(OUT, 'images'), { recursive: true });
fs.copyFileSync(path.join(DOCS, 'index.html'), path.join(OUT, 'intro.html'));
for (const name of fs.readdirSync(path.join(DOCS, 'images'))) {
  if (!/\.(jpe?g|png|webp|gif)$/i.test(name)) continue;
  fs.copyFileSync(path.join(DOCS, 'images', name), path.join(OUT, 'images', name));
}
console.log('synced docs → apps/cloudflare/public/intro.html + images/');
