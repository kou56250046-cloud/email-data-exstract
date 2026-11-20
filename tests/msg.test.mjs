import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildMsg } from './make-msg.mjs';

const require = createRequire(import.meta.url);
require('../js/cfb.js');
require('../js/rtf.js');
const Msg = require('../js/msg.js');

// Shift_JIS のエンコーダ（TextDecoder の逆引きで作る）
const sjisMap = (() => {
  const m = new Map();
  const dec = new TextDecoder('shift_jis', { fatal: true });
  for (let b = 0x09; b < 0x7f; b++) m.set(String.fromCharCode(b), [b]);
  for (let b = 0xa1; b <= 0xdf; b++) m.set(dec.decode(new Uint8Array([b])), [b]);
  for (let h = 0x81; h <= 0xfc; h++) {
    if (h > 0x9f && h < 0xe0) continue;
    for (let l = 0x40; l <= 0xfc; l++) {
      if (l === 0x7f) continue;
      try { const c = dec.decode(new Uint8Array([h, l])); if (!m.has(c)) m.set(c, [h, l]); } catch { /* 未定義 */ }
    }
  }
  return m;
})();
const sjis = (s) => {
  const out = [];
  for (const ch of s) { const b = sjisMap.get(ch); if (!b) throw new Error('SJIS 不可: ' + ch); out.push(...b); }
  out.push(0);
  return new Uint8Array(out);
};

test('Unicode 版: 基本項目・宛先・日時・添付', () => {
  const big = new Uint8Array(10000).map((_, i) => i & 255);
  const bytes = buildMsg({
    subject: '【見積】案件A のご依頼',
    fromName: '山田 太郎', fromEmail: 'yamada@example.co.jp',
    sentAt: '2025-04-01T01:02:03.000Z', receivedAt: '2025-04-01T01:02:10.000Z',
    to: [{ name: '佐藤', email: 'sato@example.com' }, { name: '鈴木', email: 'suzuki@example.com' }],
    cc: [{ name: '田中', email: 'tanaka@example.com' }],
    bcc: [{ name: '高橋', email: 'takahashi@example.com' }],
    body: 'お世話になっております。\r\n見積をお願いします。',
    html: '<html><head><meta charset="utf-8"></head><body><p>お世話になっております。</p><img src="cid:img1"></body></html>',
    messageId: '<abc@example.co.jp>', inReplyTo: '<prev@example.co.jp>', importance: 2,
    attachments: [
      { name: '見積書.pdf', data: new Uint8Array([1, 2, 3]), mime: 'application/pdf' },
      { name: '大きい.bin', data: big },
      { name: 'image001.png', data: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', contentId: 'img1' }
    ]
  });
  const m = Msg.parse(bytes);
  assert.equal(m.subject, '【見積】案件A のご依頼');
  assert.deepEqual(m.from, { name: '山田 太郎', email: 'yamada@example.co.jp' });
  assert.equal(m.sentAt, '2025-04-01T01:02:03.000Z');
  assert.equal(m.receivedAt, '2025-04-01T01:02:10.000Z');
  assert.deepEqual(m.to.map((r) => r.email), ['sato@example.com', 'suzuki@example.com']);
  assert.deepEqual(m.cc, [{ name: '田中', email: 'tanaka@example.com' }]);
  assert.deepEqual(m.bcc, [{ name: '高橋', email: 'takahashi@example.com' }]);
  assert.match(m.bodyText, /見積をお願いします/);
  assert.match(m.bodyHtml, /<p>お世話になっております。<\/p>/);
  assert.equal(m.messageId, '<abc@example.co.jp>');
  assert.equal(m.inReplyTo, '<prev@example.co.jp>');
  assert.equal(m.importance, 2);
  assert.equal(m.attachments.length, 3);
  assert.equal(m.attachments[0].name, '見積書.pdf');
  assert.equal(m.attachments[0].mime, 'application/pdf');
  assert.deepEqual([...m.attachments[0].data], [1, 2, 3]);
  assert.equal(m.attachments[1].size, 10000);
  assert.deepEqual(m.attachments[1].data, big);
  assert.equal(m.attachments[2].contentId, 'img1');
});

test('ANSI 版 (Shift_JIS, codepage 932) が化けない', () => {
  const m = Msg.parse(buildMsg({
    subject: '請求書送付のお知らせ（１０月分）',
    fromName: '経理部', fromEmail: 'keiri@example.jp',
    body: '株式会社サンプル\r\nご確認ください。①②',
    ansi: { codepage: 932, encode: sjis }
  }));
  assert.equal(m.subject, '請求書送付のお知らせ（１０月分）');
  assert.equal(m.from.name, '経理部');
  assert.match(m.bodyText, /ご確認ください。①②/);
});

test('埋め込み .msg（転送メール）を展開する', () => {
  const m = Msg.parse(buildMsg({
    subject: 'FW: 元のメール', fromName: 'A', fromEmail: 'a@example.com', body: '転送します',
    attachments: [{ name: '元のメール.msg', message: {
      subject: '元のメール', fromName: 'B', fromEmail: 'b@example.com', body: '元の本文',
      to: [{ name: 'C', email: 'c@example.com' }],
      attachments: [{ name: '中の添付.txt', data: new TextEncoder().encode('hello') }]
    } }]
  }));
  const a = m.attachments[0];
  assert.equal(a.kind, 'message');
  assert.equal(a.message.subject, '元のメール');
  assert.equal(a.message.from.email, 'b@example.com');
  assert.equal(a.message.to[0].email, 'c@example.com');
  assert.equal(a.message.bodyText, '元の本文');
  assert.equal(a.message.attachments[0].name, '中の添付.txt');
});

test('RTF だけの本文（プレーン RTF・\\uN・\\\'hh の SJIS）', () => {
  const rtf = "{\\rtf1\\ansi\\ansicpg932\\deff0{\\fonttbl{\\f0 MS Gothic;}}\\uc1 \\pard Hello \\u12371?\\u12435?\\par \\'82\\'b1\\'82\\'f1\\'82\\'c9\\'82\\'bf\\'82\\'cd\\par}";
  const m = Msg.parse(buildMsg({ subject: 'rtf', fromName: 'X', fromEmail: 'x@example.com', rtf }));
  assert.equal(m.bodySource, 'rtf');
  assert.equal(m.bodyText, 'Hello こん\nこんにちは');
});

test('RTF に包まれた HTML (\\fromhtml1) を取り出す', () => {
  const rtf = "{\\rtf1\\ansi\\ansicpg932\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}" +
    "{\\*\\htmltag19 <html>}{\\*\\htmltag34 <body>}\\htmlrtf {\\htmlrtf0 " +
    "{\\*\\htmltag64 <p>}\\htmlrtf {\\htmlrtf0 \\'82\\'b1\\'82\\'f1 world\\htmlrtf }\\htmlrtf0 {\\*\\htmltag72 </p>}" +
    "\\htmlrtf }\\htmlrtf0 {\\*\\htmltag42 </body>}{\\*\\htmltag27 </html>}}";
  const m = Msg.parse(buildMsg({ subject: 'h', fromName: 'X', fromEmail: 'x@example.com', rtf }));
  assert.equal(m.bodyHtml, '<html><body><p>こん world</p></body></html>');
  assert.equal(m.bodyText, 'こん world');
});

test('Exchange 形式の送信者は SMTP アドレスを使う', () => {
  const m = Msg.parse(buildMsg({ subject: 's', fromName: '社内 一郎', fromEmail: 'ichiro@corp.example', fromExchange: true }));
  assert.equal(m.from.email, 'ichiro@corp.example');
});

test('受信者ストレージが無いときは表示用の宛先を使う', () => {
  const m = Msg.parse(buildMsg({ subject: 's', fromName: 'a', fromEmail: 'a@x.jp', to: [{ name: '甲' }, { name: '乙' }], noRecipientStorage: true }));
  assert.deepEqual(m.to.map((r) => r.name), ['甲', '乙']);
});

test('.msg 以外はエラーにする', () => {
  assert.throws(() => Msg.parse(new TextEncoder().encode('not a msg file'.repeat(50))), /\.msg/);
});

test('ヘッダの MIME エンコード語を戻す', () => {
  assert.equal(Msg.decodeMimeWords('=?UTF-8?B?44GC44GE?= =?UTF-8?B?44GG?='), 'あいう');
  assert.deepEqual(Msg.parseAddress('"山田" <y@example.jp>'), { name: '山田', email: 'y@example.jp' });
});
