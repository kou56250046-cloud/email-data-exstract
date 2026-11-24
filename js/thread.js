/*
 * 再送の判定と、依頼メール・返信メールの紐づけ。画面に依存しない純粋関数。
 * mails は app.js の一覧の要素（key, subject, from, sentAt, receivedAt, messageId, inReplyTo, references,
 * conversationIndex, ss, error）。結果は Map で返し、mails 自体は書き換えない。
 */
(function (g) {
  'use strict';

  var DAY = 86400000;
  var IDX_HEAD = 44; // PR_CONVERSATION_INDEX の先頭 22 バイト（16 進で 44 文字）。会話ごとに同じ
  var IDX_CHILD = 10; // 返信ごとに 5 バイト（16 進で 10 文字）伸びる

  function nfkc(s) { s = String(s == null ? '' : s); return s.normalize ? s.normalize('NFKC') : s; }

  var PREFIX = /^\s*(re|fw|fwd|aw|wg|返信|転送|回答)\s*(\[\d+\]|\(\d+\))?\s*[:：]\s*/i;
  var RESEND_TAG = /[【\[(<〔]\s*(再送|再送信|再々送|再再送)\s*[】\])>〕]/g;
  var RESEND_HEAD = /^\s*(再送|再送信|再々送|再再送)\s*[:：]\s*/;
  var NUM_TAG = /[(\[]\s*\d{1,3}\s*[)\]]/g;

  /** 件名を比べられる形にする。RE: / FW: / 再送の印 / (1) のような番号を除き、小文字・空白なしにする */
  function normSubject(s) {
    s = nfkc(s).toLowerCase();
    var prev;
    do {
      prev = s;
      s = s.replace(PREFIX, '').replace(RESEND_HEAD, '');
    } while (s !== prev);
    s = s.replace(RESEND_TAG, '').replace(NUM_TAG, '');
    return s.replace(/\s+/g, '');
  }

  /** 件名が返信の形（RE: など）か */
  function isReplySubject(s) { return /^\s*(re|返信|回答)\s*(\[\d+\]|\(\d+\))?\s*[:：]/i.test(nfkc(s)); }

  /** Message-ID を比べられる形にする */
  function normId(s) { return String(s || '').trim().replace(/^<|>$/g, '').toLowerCase(); }
  /** References は空白区切りの Message-ID の並び（古い順） */
  function idsOf(s) { return (String(s || '').match(/<[^>]+>|[^\s<>,]+@[^\s<>,]+/g) || []).map(normId).filter(Boolean); }

  function timeOf(m) {
    var t = Date.parse(m.sentAt || m.receivedAt || '');
    return isNaN(t) ? null : t;
  }
  function before(a, b) { // a が b より前か（日時が無ければ前とみなす）
    var x = timeOf(a), y = timeOf(b);
    return x == null || y == null || x <= y;
  }

  /**
   * 返信の親を探す。① In-Reply-To・References が読み込み済みのメールの Message-ID と一致する
   * ② PR_CONVERSATION_INDEX が親の値に 5 バイト足した形になっている（無ければ先頭 22 バイトが同じで、前に届いた最も近いもの）
   * @returns {Map} mail -> { parent: mail, method: 'header' | 'conversation' }
   */
  function linkReplies(mails) {
    var byId = new Map(), byIdx = new Map(), byHead = new Map();
    mails.forEach(function (m) {
      if (m.error) return;
      var id = normId(m.messageId);
      if (id && !byId.has(id)) byId.set(id, m);
      var ix = String(m.conversationIndex || '').toLowerCase();
      if (ix.length >= IDX_HEAD) {
        if (!byIdx.has(ix)) byIdx.set(ix, m);
        var h = ix.slice(0, IDX_HEAD);
        if (!byHead.has(h)) byHead.set(h, []);
        byHead.get(h).push(m);
      }
    });
    var out = new Map();
    mails.forEach(function (m) {
      if (m.error) return;
      var ids = [normId(m.inReplyTo)].concat(idsOf(m.references).reverse()); // 直接の親を先に見る
      for (var i = 0; i < ids.length; i++) {
        var p = ids[i] && byId.get(ids[i]);
        if (p && p.key !== m.key) { out.set(m, { parent: p, method: 'header' }); return; }
      }
      var ix = String(m.conversationIndex || '').toLowerCase();
      if (ix.length < IDX_HEAD + IDX_CHILD) return; // 会話の最初のメール
      var exact = byIdx.get(ix.slice(0, ix.length - IDX_CHILD));
      if (exact && exact.key !== m.key) { out.set(m, { parent: exact, method: 'conversation' }); return; }
      var best = null;
      (byHead.get(ix.slice(0, IDX_HEAD)) || []).forEach(function (c) {
        var cx = String(c.conversationIndex).toLowerCase();
        if (c.key === m.key || cx.length >= ix.length || !before(c, m)) return;
        if (!best || cx.length > String(best.conversationIndex).length ||
          (cx.length === String(best.conversationIndex).length && (timeOf(c) || 0) > (timeOf(best) || 0))) best = c;
      });
      if (best) out.set(m, { parent: best, method: 'conversation' });
    });
    return out;
  }

  /**
   * 同じ依頼の送り直しをまとめる。送信者・件名（normSubject）が同じで、SS 名が食い違わず、
   * グループの最初の 1 通から days 日以内のもの。同じ key（重複ファイル）は 1 通として数える。
   * replies（linkReplies の結果）は返信なので除く。件名の RE: だけでは除かない（依頼の転送が連なると付くため）。
   * @returns {Map} mail -> { group: 番号, n: 何通目か(1 が原本), size: グループの通数, first: 原本 }
   */
  function groupResends(mails, opts) {
    var days = (opts && opts.days != null) ? opts.days : 14;
    var replies = (opts && opts.replies) || new Map();
    var buckets = new Map();
    mails.forEach(function (m) {
      if (m.error || replies.has(m)) return;
      var subj = normSubject(m.subject);
      var from = String((m.from && m.from.email) || '').trim().toLowerCase();
      if (!subj || !from) return;
      var k = from + '\n' + subj;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(m);
    });
    var out = new Map();
    var gid = 0;
    buckets.forEach(function (list) {
      if (list.length < 2) return;
      list = list.slice().sort(function (a, b) { return (timeOf(a) || 0) - (timeOf(b) || 0); });
      var groups = [];
      list.forEach(function (m) {
        var t = timeOf(m), ss = (m.ss && m.ss.name) || '';
        var g0 = null;
        for (var i = 0; i < groups.length && !g0; i++) {
          var gr = groups[i];
          if (gr.keys.has(m.key)) { g0 = gr; break; }
          if (gr.ss && ss && gr.ss !== ss) continue;
          if (t != null && gr.t != null && t - gr.t > days * DAY) continue;
          g0 = gr;
        }
        if (!g0) { g0 = { t: t, ss: ss, keys: new Map(), members: [] }; groups.push(g0); }
        if (!g0.ss && ss) g0.ss = ss;
        if (!g0.keys.has(m.key)) g0.keys.set(m.key, g0.keys.size + 1);
        g0.members.push(m);
      });
      groups.forEach(function (gr) {
        if (gr.keys.size < 2) return;
        gid++;
        var first = gr.members[0];
        gr.members.forEach(function (m) { out.set(m, { group: gid, n: gr.keys.get(m.key), size: gr.keys.size, first: first }); });
      });
    });
    return out;
  }

  /**
   * 依頼メールと最初の返信の組を作る。再送グループの返信は原本への返信として扱う。
   * @returns {{ replies: Map, resends: Map, firstReply: Map, pairs: Array }}
   *   firstReply: 依頼 mail -> { reply, method }（再送グループでは全員に同じものを付ける）
   *   pairs: [{ request, reply, method, resendCount }] 依頼（key）ごとに 1 組
   */
  function analyze(mails, opts) {
    var replies = linkReplies(mails);
    var resends = groupResends(mails, { days: opts && opts.days, replies: replies });
    var rootOf = function (m) { var r = resends.get(m); return r ? r.first : m; };
    var best = new Map(); // 依頼の原本の key -> { root, reply, method }（同じ key の重複ファイルにも同じものを付けるため key で持つ）
    replies.forEach(function (v, reply) {
      if (replies.has(v.parent)) return; // 返信への返信は、依頼に対する最初の返信ではない
      var root = rootOf(v.parent);
      var cur = best.get(root.key);
      if (!cur || (timeOf(reply) || 0) < (timeOf(cur.reply) || 0)) best.set(root.key, { root: root, reply: reply, method: v.method });
    });
    var firstReply = new Map();
    mails.forEach(function (m) {
      var b = best.get(rootOf(m).key);
      if (b && !replies.has(m)) firstReply.set(m, { reply: b.reply, method: b.method });
    });
    var pairs = [];
    best.forEach(function (b) {
      var r = resends.get(b.root);
      pairs.push({ request: b.root, reply: b.reply, method: b.method, resendCount: r ? r.size : 1 });
    });
    pairs.sort(function (a, b) { return (timeOf(a.request) || 0) - (timeOf(b.request) || 0); });
    return { replies: replies, resends: resends, firstReply: firstReply, pairs: pairs };
  }

  var api = { normSubject: normSubject, isReplySubject: isReplySubject, linkReplies: linkReplies, groupResends: groupResends, analyze: analyze };
  g.MsgThread = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
