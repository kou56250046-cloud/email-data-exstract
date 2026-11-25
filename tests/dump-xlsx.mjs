// 添付 xlsx（または .xlsx そのもの）のチェックボックスと補修依頼書の欄を表示する。実物の確認用。
// 使い方: node tests/dump-xlsx.mjs <.msg か .xlsx、またはフォルダ> [--cells]
//   --cells  見出し（依頼内容・補修内容・状況内容・負担区分）の周りのセルを座標つきで出す
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../js/cfb.js');
require('../js/rtf.js');
const Msg = require('../js/msg.js');
const Xlsx = require('../js/xlsx.js');
const Fields = require('../js/fields.js');

const target = process.argv[2];
const showCells = process.argv.includes('--cells');
if (!target) { console.error('使い方: node tests/dump-xlsx.mjs <.msg か .xlsx、またはフォルダ> [--cells]'); process.exit(1); }

const files = statSync(target).isDirectory()
  ? readdirSync(target).filter((f) => /\.(msg|xlsx|xlsm)$/i.test(f)).map((f) => join(target, f))
  : [target];

const colName = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const HEADS = /依頼内容|補修内容|状況内容|負担区分/;

function xlsxOf(m, out = []) {
  for (const a of m.attachments) {
    if (a.message) xlsxOf(a.message, out);
    else if (a.data && Xlsx.isXlsx(a)) out.push({ name: a.name, data: a.data });
  }
  return out;
}

async function showXlsx(name, data) {
  console.log(`  《${name}》`);
  let r;
  try { r = await Xlsx.read(data); } catch (e) { console.log('    読み取れません: ' + e.message); return; }
  for (const s of r.sheets) {
    console.log(`    [${s.name}]${s.hidden ? '（非表示）' : ''} 行 ${s.rows.length} / チェックボックス ${s.checks.length}`);
    for (const c of s.checks) {
      console.log(`      ${c.checked ? '☑' : '☐'} ${c.label || '（文字なし）'}  @${c.col >= 0 ? colName(c.col) : '?'}${c.row >= 0 ? c.row + 1 : '?'}`);
    }
    if (!showCells) continue;
    s.rows.forEach((row, ri) => {
      row.forEach((v, ci) => {
        if (!v || !HEADS.test(v)) return;
        console.log(`      見出し ${colName(ci)}${ri + 1}: ${v}`);
        for (let d = 0; d <= 3 && ri + d < s.rows.length; d++) {
          const cells = (s.rows[ri + d] || []).map((x, k) => (x && k >= ci ? `${colName(k)}${ri + d + 1}=${x.slice(0, 40)}` : '')).filter(Boolean);
          if (cells.length) console.log('        ' + cells.join(' | '));
        }
      });
    });
  }
  console.log('    → 取り出し結果: ' + JSON.stringify(Fields.extractForm(r.sheets)));
}

for (const f of files) {
  console.log('== ' + f);
  try {
    const buf = new Uint8Array(readFileSync(f));
    if (/\.msg$/i.test(f)) {
      const list = xlsxOf(Msg.parse(buf));
      if (!list.length) console.log('  xlsx の添付なし');
      for (const x of list) await showXlsx(x.name, x.data);
    } else await showXlsx(f, buf);
  } catch (e) { console.log('  エラー: ' + e.message); }
}
