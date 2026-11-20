// msgreader (OSS) のテスト資材と突き合わせる。資材はリポジトリ外に置き、パスを引数で渡す。
// 使い方: node tests/compare-fixtures.mjs <資材フォルダ>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../js/cfb.js');
require('../js/rtf.js');
const Msg = require('../js/msg.js');

const dir = process.argv[2];
let ng = 0, checked = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.msg'))) {
  const jf = join(dir, f.replace(/\.msg$/, '.json'));
  if (!existsSync(jf)) continue;
  const exp = JSON.parse(readFileSync(jf, 'utf8'));
  const m = Msg.parse(readFileSync(join(dir, f)));
  const diffs = [];
  const eq = (k, a, b) => { checked++; if ((a || '') !== (b || '')) { diffs.push(`${k}: 期待=${JSON.stringify(b).slice(0, 80)} 実際=${JSON.stringify(a).slice(0, 80)}`); } };
  eq('subject', m.subject, exp.subject);
  if (exp.body != null) eq('body', m.bodySource === 'text' ? m.bodyText : '(本文なし)', exp.body.replace(/\u0000+$/, ''));
  const recips = (exp.recipients || []);
  const byType = (t) => recips.filter((r) => r.recipType === t).map((r) => r.smtpAddress || r.email).join(';');
  eq('to', m.to.map((r) => r.email).join(';'), byType('to'));
  eq('cc', m.cc.map((r) => r.email).join(';'), byType('cc'));
  eq('bcc', m.bcc.map((r) => r.email).join(';'), byType('bcc'));
  const atts = (exp.attachments || []).map((a) => a.fileName || a.name);
  eq('attachments', m.attachments.map((a) => a.name).join('|'), atts.join('|'));
  if (exp.messageId) eq('messageId', m.messageId, exp.messageId);
  console.log((diffs.length ? '✖ ' : '✔ ') + f + (diffs.length ? '\n    ' + diffs.join('\n    ') : ''));
  if (diffs.length) ng++;
}
// 圧縮 RTF の展開結果を資材の .rtf と比べる
const Cfb = globalThis.MsgCfb, Rtf = globalThis.MsgRtf;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.msg'))) {
  const rf = join(dir, f.replace(/\.msg$/, '.rtf'));
  if (!existsSync(rf)) continue;
  const c = Cfb.parse(readFileSync(join(dir, f)));
  const node = c.root.children['__substg1.0_10090102'];
  const got = Buffer.from(Rtf.decompress(c.read(node)));
  const exp = readFileSync(rf);
  const same = got.equals(exp) || got.toString('latin1').replace(/\0+$/, '') === exp.toString('latin1').replace(/\0+$/, '');
  console.log((same ? '✔ RTF ' : '✖ RTF ') + f + ` (${got.length}/${exp.length}B)`);
  if (!same) ng++;
}
console.log(`項目 ${checked} 件を照合 / 不一致 ${ng}`);
process.exitCode = ng ? 1 : 0;
