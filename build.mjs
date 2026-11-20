// src/page.html の <link rel="stylesheet"> と <script src> を中に埋め込み、1 ファイルで動く index.html を作る。
// 埋め込んだスクリプトは CSP のハッシュで許可する（'unsafe-inline' は使わない）。
// 使い方: node build.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (rel) => {
  const p = join(root, rel);
  if (!existsSync(p)) throw new Error('見つかりません: ' + rel);
  // HTML の解析時に改行は LF にそろえられ、CSP のハッシュも LF で計算されるため、こちらも LF にする
  return readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
};

let html = read('src/page.html');

// </script> や </style> が中身に現れると埋め込みが壊れる
const guard = (code, tag, file) => {
  if (new RegExp('</' + tag, 'i').test(code)) throw new Error(`${file} に </${tag} が含まれていて埋め込めません`);
  return code;
};

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${guard(read(href), 'style', href)}</style>`);

const hashes = [];
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const code = '\n' + guard(read(src), 'script', src);
  hashes.push(`'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`);
  return `<script data-src="${src}">${code}</script>`;
});

const csp = [
  "default-src 'none'",
  `script-src ${hashes.join(' ')}`,
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'frame-src blob: data:',
  "connect-src 'none'",
  "form-action 'none'"
].join('; ');
const before = html;
html = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
if (html === before) throw new Error('CSP の meta が見つかりません');
if (/<script src=|<link rel="stylesheet"/.test(html)) throw new Error('埋め込めなかった外部ファイルがあります');

html = html.replace('<!doctype html>', '<!doctype html>\n<!-- このファイルは build.mjs が src/page.html から生成したもの。直接編集しない -->');
writeFileSync(join(root, 'index.html'), html);
console.log(`index.html を生成しました（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB、スクリプト ${hashes.length} 本）`);
