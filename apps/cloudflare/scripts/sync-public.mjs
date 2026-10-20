// 把 docs/ 介绍页同步进 public/（Workers Static Assets）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.resolve(HERE, '../public');

fs.mkdirSync(path.join(OUT, 'images'), { recursive: true });
fs.copyFileSync(path.join(DOCS, 'index.html'), path.join(OUT, 'index.html'));
for (const name of fs.readdirSync(path.join(DOCS, 'images'))) {
  if (!/\.(jpe?g|png|webp|gif)$/i.test(name)) continue;
  fs.copyFileSync(path.join(DOCS, 'images', name), path.join(OUT, 'images', name));
}
console.log('synced docs → apps/cloudflare/public');
