// 指定した .msg（またはフォルダ内の全 .msg）を解析して要約を表示する。実物の確認用。
// 使い方: node tests/dump.mjs <ファイルかフォルダ> [--body]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../js/cfb.js');
require('../js/rtf.js');
const Msg = require('../js/msg.js');

const target = process.argv[2];
const showBody = process.argv.includes('--body');
if (!target) { console.error('使い方: node tests/dump.mjs <ファイルかフォルダ> [--body]'); process.exit(1); }

const files = statSync(target).isDirectory()
  ? readdirSync(target).filter((f) => f.toLowerCase().endsWith('.msg')).map((f) => join(target, f))
  : [target];

const fmt = (list) => list.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join('; ');
function show(m, indent) {
  const p = (k, v) => console.log(`${indent}${k}: ${v}`);
  p('件名', m.subject);
  p('From', `${m.from.name} <${m.from.email}>`);
  p('送信', m.sentAt); p('受信', m.receivedAt);
  p('To', fmt(m.to).slice(0, 200)); p('Cc', fmt(m.cc)); p('Bcc', fmt(m.bcc));
  p('Message-ID', m.messageId); p('本文', `${m.bodySource} text=${m.bodyText.length} html=${m.bodyHtml.length} cp=${m.codepage}`);
  if (showBody) console.log(m.bodyText.slice(0, 400).replace(/^/gm, indent + '  | '));
  for (const a of m.attachments) {
    p('  添付', `${a.name} [${a.kind}] ${a.size}B ${a.mime} ${a.contentId ? 'cid=' + a.contentId : ''}${a.error ? ' ERR ' + a.error : ''}`);
    if (a.message) show(a.message, indent + '    ');
  }
}
let ok = 0, ng = 0;
for (const f of files) {
  console.log('== ' + f);
  try { const t = Date.now(); show(Msg.parse(readFileSync(f)), '  '); console.log(`  (${Date.now() - t}ms)`); ok++; }
  catch (e) { console.log('  エラー: ' + e.message); ng++; }
}
console.log(`成功 ${ok} / 失敗 ${ng}`);
