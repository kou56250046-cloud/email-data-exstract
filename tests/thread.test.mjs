import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildMsg } from './make-msg.mjs';

const require = createRequire(import.meta.url);
const T = require('../js/thread.js');
require('../js/cfb.js');
require('../js/rtf.js');
const Msg = require('../js/msg.js');

let seq = 0;
const mail = (o) => Object.assign({
  key: 'k' + (++seq), subject: '', from: { name: '', email: 'gs@example.jp' }, sentAt: null,
  messageId: '', inReplyTo: '', references: '', conversationIndex: '', ss: { name: '' }
}, o);

test('normSubject: RE: / 再送の印 / (1) を除いて同じになる', () => {
  const base = T.normSubject('本町SS 給油機補修依頼');
  for (const s of ['RE: 【再送】本町SS 給油機補修依頼(2)', '再送：本町ＳＳ　給油機補修依頼', 'Fw: Re: 本町SS 給油機補修依頼 (1)', '[再送] 本町SS 給油機補修依頼']) {
    assert.equal(T.normSubject(s), base, s);
  }
  assert.notEqual(T.normSubject('本町SS 給油機補修依頼 2025'), base); // 括弧の無い数字は残す
  assert.equal(T.isReplySubject('RE: 件名'), true);
  assert.equal(T.isReplySubject('返信：件名'), true);
  assert.equal(T.isReplySubject('FW: 件名'), false);
});

test('groupResends: 送信者・件名・期間・SS の条件', () => {
  const a = mail({ subject: '補修依頼', sentAt: '2025-01-01T00:00:00Z', ss: { name: '本町SS' } });
  const b = mail({ subject: '【再送】補修依頼', sentAt: '2025-01-10T00:00:00Z', ss: { name: '' } });
  const c = mail({ subject: '補修依頼(1)', sentAt: '2025-01-14T23:00:00Z', ss: { name: '本町SS' } }); // 14 日以内
  const late = mail({ subject: '補修依頼', sentAt: '2025-01-16T00:00:00Z', ss: { name: '本町SS' } }); // 15 日後 → 別の依頼
  const other = mail({ subject: '補修依頼', sentAt: '2025-01-02T00:00:00Z', from: { email: 'other@example.jp' } });
  const ss2 = mail({ subject: '補修依頼', sentAt: '2025-01-03T00:00:00Z', ss: { name: '駅前SS' } });
  const re = mail({ subject: 'RE: 補修依頼', sentAt: '2025-01-04T00:00:00Z', ss: { name: '本町SS' } }); // 同じ送信者の RE: は再送に入れる
  const linked = mail({ subject: '補修依頼', sentAt: '2025-01-05T00:00:00Z' }); // 返信と結べたものは除く
  const dupB = Object.assign({}, b); // 同じファイルが 2 つ（key が同じ）
  const r = T.groupResends([late, c, b, a, other, ss2, re, dupB, linked], { replies: new Map([[linked, { parent: a, method: 'header' }]]) });
  assert.equal(r.get(a).n, 1);
  assert.equal(r.get(b).n, 3);
  assert.equal(r.get(dupB).n, 3);
  assert.equal(r.get(re).n, 2);
  assert.equal(r.get(c).n, 4);
  assert.equal(r.get(a).size, 4);
  assert.equal(r.get(c).first, a);
  for (const m of [late, other, ss2, linked]) assert.equal(r.has(m), false);
});

test('linkReplies: In-Reply-To / References / ConversationIndex で結ぶ', () => {
  const head = 'ab'.repeat(22);
  const req = mail({ subject: '補修依頼', messageId: '<req@gs>', sentAt: '2025-01-01T00:00:00Z', conversationIndex: head });
  const byHdr = mail({ subject: 'RE: 補修依頼', inReplyTo: '<REQ@gs>', sentAt: '2025-01-02T00:00:00Z' });
  const byRef = mail({ subject: 'RE: 補修依頼', references: '<x@y> <req@gs>', sentAt: '2025-01-03T00:00:00Z' });
  const byIdx = mail({ subject: 'RE: 補修依頼', conversationIndex: head + '0102030405', sentAt: '2025-01-04T00:00:00Z' });
  const loose = mail({ subject: 'RE: 補修依頼', conversationIndex: head + '9999999999' + '1111111111', sentAt: '2025-01-05T00:00:00Z' });
  const lone = mail({ subject: 'RE: 別件', inReplyTo: '<none@x>' });
  const r = T.linkReplies([req, byHdr, byRef, byIdx, loose, lone]);
  assert.deepEqual(r.get(byHdr), { parent: req, method: 'header' });
  assert.deepEqual(r.get(byRef), { parent: req, method: 'header' });
  assert.deepEqual(r.get(byIdx), { parent: req, method: 'conversation' });
  assert.equal(r.get(loose).parent, byIdx); // 親が無ければ、先頭 22 バイトが同じで最も近いもの
  assert.equal(r.has(lone), false);
  assert.equal(r.has(req), false);
});

test('analyze: 再送グループの返信は原本の組になり、最初の返信だけが選ばれる', () => {
  const a = mail({ subject: '補修依頼', messageId: '<a@gs>', sentAt: '2025-01-01T00:00:00Z' });
  const b = mail({ subject: '【再送】補修依頼', messageId: '<b@gs>', sentAt: '2025-01-03T00:00:00Z' });
  const late = mail({ subject: 'RE: 補修依頼', inReplyTo: '<a@gs>', sentAt: '2025-01-05T00:00:00Z', from: { email: 'me@corp.jp' } });
  const early = mail({ subject: 'RE: 【再送】補修依頼', inReplyTo: '<b@gs>', sentAt: '2025-01-04T00:00:00Z', from: { email: 'me@corp.jp' } });
  const back = mail({ subject: 'RE: RE: 補修依頼', inReplyTo: '<e@corp>', sentAt: '2025-01-06T00:00:00Z' });
  early.messageId = '<e@corp>';
  const noReply = mail({ subject: '見積依頼', sentAt: '2025-02-01T00:00:00Z' });
  const r = T.analyze([a, b, late, early, back, noReply]);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].request, a);
  assert.equal(r.pairs[0].reply, early);
  assert.equal(r.pairs[0].method, 'header');
  assert.equal(r.pairs[0].resendCount, 2);
  assert.equal(r.firstReply.get(b).reply, early);
  assert.equal(r.firstReply.has(noReply), false);
  assert.equal(r.firstReply.has(early), false); // 返信メール自身には付けない
  assert.equal(r.replies.get(back).parent, early);
});

test('msg: PR_CONVERSATION_INDEX と References を読む', () => {
  const idx = new Uint8Array(27).map((_, i) => i);
  const m = Msg.parse(buildMsg({ subject: 'RE: x', references: '<a@b>', conversationTopic: 'x', conversationIndex: idx }));
  assert.equal(m.conversationIndex, Array.from(idx, (b) => b.toString(16).padStart(2, '0')).join(''));
  assert.equal(m.conversationTopic, 'x');
  assert.equal(m.references, '<a@b>');
});
