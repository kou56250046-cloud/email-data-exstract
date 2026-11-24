/*
 * .msg (MS-OXMSG) の解析。CFB の中の MAPI プロパティをメールの項目に変換する。
 * 依存: MsgCfb (cfb.js), MsgRtf (rtf.js)
 */
(function (g) {
  'use strict';

  var Cfb = g.MsgCfb || (typeof require === 'function' ? require('./cfb.js') : null);
  var Rtf = g.MsgRtf || (typeof require === 'function' ? require('./rtf.js') : null);

  // MAPI プロパティ ID
  var P = {
    IMPORTANCE: 0x0017, MESSAGE_CLASS: 0x001a, SUBJECT: 0x0037, CLIENT_SUBMIT_TIME: 0x0039,
    CONVERSATION_TOPIC: 0x0070, CONVERSATION_INDEX: 0x0071,
    SENT_REP_NAME: 0x0042, SENT_REP_EMAIL: 0x0065, SENT_REP_ADDRTYPE: 0x0064,
    TRANSPORT_HEADERS: 0x007d, SENDER_NAME: 0x0c1a, SENDER_ADDRTYPE: 0x0c1e, SENDER_EMAIL: 0x0c1f,
    RECIPIENT_TYPE: 0x0c15, DISPLAY_BCC: 0x0e02, DISPLAY_CC: 0x0e03, DISPLAY_TO: 0x0e04,
    DELIVERY_TIME: 0x0e06, MESSAGE_SIZE: 0x0e08, ATTACH_SIZE: 0x0e20,
    BODY: 0x1000, RTF_COMPRESSED: 0x1009, HTML: 0x1013, INTERNET_MESSAGE_ID: 0x1035,
    INTERNET_REFERENCES: 0x1039, IN_REPLY_TO: 0x1042,
    DISPLAY_NAME: 0x3001, ADDRTYPE: 0x3002, EMAIL: 0x3003, CREATION_TIME: 0x3007, LAST_MOD_TIME: 0x3008,
    ATTACH_DATA: 0x3701, ATTACH_FILENAME: 0x3704, ATTACH_METHOD: 0x3705, ATTACH_LONG_FILENAME: 0x3707,
    ATTACH_MIME: 0x370e, ATTACH_CONTENT_ID: 0x3712, ATTACH_FLAGS: 0x3714, ATTACHMENT_HIDDEN: 0x7ffe,
    SMTP_ADDRESS: 0x39fe, INTERNET_CPID: 0x3fde, MESSAGE_CODEPAGE: 0x3ffd,
    SENDER_SMTP: 0x5d01, SENT_REP_SMTP: 0x5d02, CREATOR_SMTP: 0x5d0a
  };

  var CP_LABEL = {
    932: 'shift_jis', 50220: 'iso-2022-jp', 50221: 'iso-2022-jp', 50222: 'iso-2022-jp', 51932: 'euc-jp',
    20932: 'euc-jp', 65001: 'utf-8', 1200: 'utf-16le', 1201: 'utf-16be', 1252: 'windows-1252',
    1250: 'windows-1250', 1251: 'windows-1251', 1253: 'windows-1253', 1254: 'windows-1254',
    20127: 'us-ascii', 28591: 'iso-8859-1', 28592: 'iso-8859-2', 936: 'gbk', 54936: 'gb18030',
    949: 'euc-kr', 950: 'big5', 874: 'windows-874', 10000: 'macintosh'
  };

  var decoders = {};
  function decoderFor(label) {
    if (!decoders[label]) {
      try { decoders[label] = new TextDecoder(label); } catch (e) { decoders[label] = new TextDecoder('shift_jis'); }
    }
    return decoders[label];
  }

  /** バイト列をコードページで復号する。不明なら Shift_JIS（日本の .msg の大半） */
  function decodeBytes(bytes, codepage) {
    var label = CP_LABEL[codepage] || 'shift_jis';
    if (label === 'us-ascii') label = 'shift_jis'; // ASCII 宣言で実際は SJIS のことがある
    var s = decoderFor(label).decode(bytes);
    return s.replace(/\u0000+$/, '');
  }
  var utf16 = new TextDecoder('utf-16le');
  function decodeUnicode(bytes) { return utf16.decode(bytes).replace(/\u0000+$/, ''); }

  function hex4(n) { return ('0000' + n.toString(16).toUpperCase()).slice(-4); }

  function filetimeToIso(lo, hi) {
    if (!lo && !hi) return null;
    var ms = (hi * 4294967296 + lo) / 10000 - 11644473600000;
    if (!isFinite(ms) || ms < 0 || ms > 4102444800000) return null; // 2100 年超は無効値とみなす
    return new Date(Math.round(ms)).toISOString();
  }

  /**
   * 1つのストレージ（メッセージ・受信者・添付）からプロパティを読む。
   * 可変長は __substg1.0_ ストリーム、固定長は __properties_version1.0 に入っている。
   */
  function Props(cfb, node, headerSize, codepageRef) {
    this.cfb = cfb;
    this.node = node;
    this.cpRef = codepageRef;
    this.fixed = {};
    var ps = node.children['__properties_version1.0'];
    if (ps) {
      var b = cfb.read(ps);
      var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (var o = headerSize; o + 16 <= b.length; o += 16) {
        var type = dv.getUint16(o, true);
        var id = dv.getUint16(o + 2, true);
        this.fixed[id] = { type: type, lo: dv.getUint32(o + 8, true), hi: dv.getUint32(o + 12, true), off: o + 8, buf: b };
      }
    }
  }
  Props.prototype.stream = function (id, type) {
    return this.node.children[('__substg1.0_' + hex4(id) + hex4(type)).toLowerCase()] || null;
  };
  Props.prototype.bytes = function (id) {
    var s = this.stream(id, 0x0102);
    return s ? this.cfb.read(s) : null;
  };
  Props.prototype.str = function (id) {
    var s = this.stream(id, 0x001f);
    if (s) return decodeUnicode(this.cfb.read(s));
    s = this.stream(id, 0x001e);
    if (s) return decodeBytes(this.cfb.read(s), this.cpRef.cp);
    return null;
  };
  Props.prototype.int = function (id) {
    var f = this.fixed[id];
    if (!f) return null;
    if (f.type === 0x0003 || f.type === 0x000b || f.type === 0x0002) return f.lo | 0;
    return null;
  };
  Props.prototype.time = function (id) {
    var f = this.fixed[id];
    if (!f || f.type !== 0x0040) return null;
    return filetimeToIso(f.lo, f.hi);
  };

  function parseHeaders(raw) {
    var h = {};
    if (!raw) return h;
    var lines = raw.split(/\r?\n(?![ \t])/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^([A-Za-z0-9-]+):\s*([\s\S]*)$/.exec(lines[i]);
      if (!m) continue;
      var k = m[1].toLowerCase();
      if (!(k in h)) h[k] = m[2].replace(/\r?\n[ \t]+/g, ' ').trim();
    }
    return h;
  }

  /** RFC 2047 (=?ISO-2022-JP?B?...?=) を戻す。ヘッダ由来の値にだけ使う */
  function decodeMimeWords(s) {
    if (!s || s.indexOf('=?') < 0) return s;
    return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, function (_, cs, enc, txt) {
      try {
        var bytes;
        if (enc.toUpperCase() === 'B') {
          var bin = atob(txt);
          bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          var arr = [];
          txt = txt.replace(/_/g, ' ');
          for (var j = 0; j < txt.length; j++) {
            if (txt[j] === '=' && j + 2 < txt.length + 1) { arr.push(parseInt(txt.substr(j + 1, 2), 16)); j += 2; }
            else arr.push(txt.charCodeAt(j));
          }
          bytes = new Uint8Array(arr);
        }
        return new TextDecoder(cs.toLowerCase()).decode(bytes);
      } catch (e) { return _; }
    });
  }

  function parseAddress(s) {
    s = decodeMimeWords(s || '').trim();
    var m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
    if (m) return { name: m[1].trim(), email: m[2].trim() };
    if (/@/.test(s)) return { name: '', email: s };
    return { name: s, email: '' };
  }

  function isSmtp(addr) { return !!addr && /^[^\s/@]+@[^\s@]+$/.test(addr); }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', yen: '¥' };
  /** HTML 本文からテキストを作る（検索・CSV・閲覧用 HTML 書き出し用） */
  function htmlToText(html) {
    if (!html) return '';
    var s = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(head|style|script|title|xml)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, '\n')
      .replace(/<(td|th)[^>]*>/gi, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&([a-z]+);/gi, function (m, n) { return ENTITIES[n.toLowerCase()] || m; });
    return s.replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** HTML のバイト列を復号。meta charset があればそちらを優先する */
  function decodeHtmlBytes(bytes, cp) {
    var head = '';
    for (var i = 0; i < Math.min(bytes.length, 4096); i++) head += String.fromCharCode(bytes[i]);
    var m = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_\-]+)/i.exec(head);
    if (m) {
      try { return new TextDecoder(m[1].toLowerCase()).decode(bytes); } catch (e) { /* 既定へ */ }
    }
    return decodeBytes(bytes, cp);
  }

  function readMessage(cfb, node, isEmbedded, depth) {
    var cpRef = { cp: 0 };
    var p = new Props(cfb, node, isEmbedded ? 24 : 32, cpRef);
    // 8bit 文字列 (001E) は Windows のコードページで入っている。PR_INTERNET_CPID が
    // ISO-2022-JP (5022x) でも中身は Shift_JIS なので置き換える
    var internetCp = p.int(P.INTERNET_CPID) || 0;
    var msgCp = p.int(P.MESSAGE_CODEPAGE) || 0;
    var strCp = msgCp || internetCp || 932;
    if (strCp >= 50220 && strCp <= 50222) strCp = 932;
    cpRef.cp = strCp;

    var headersRaw = p.str(P.TRANSPORT_HEADERS) || '';
    var hdr = parseHeaders(headersRaw);

    // 送信者: 表示名＋SMTP アドレス。Exchange 内部形式 (/O=...) は SMTP の別プロパティかヘッダで補う
    var fromName = p.str(P.SENDER_NAME) || p.str(P.SENT_REP_NAME) || '';
    var fromEmail = p.str(P.SENDER_SMTP) || p.str(P.SENT_REP_SMTP) || '';
    if (!isSmtp(fromEmail)) {
      var e1 = p.str(P.SENDER_EMAIL);
      var e2 = p.str(P.SENT_REP_EMAIL);
      fromEmail = isSmtp(e1) ? e1 : isSmtp(e2) ? e2 : '';
    }
    if (!fromEmail && (p.str(P.SENDER_ADDRTYPE) || '').toUpperCase() === 'EX') {
      var cr = p.str(P.CREATOR_SMTP);
      if (isSmtp(cr)) fromEmail = cr; // 送信済みアイテムでは作成者＝送信者
    }
    if ((!fromEmail || !fromName) && hdr.from) {
      var ha = parseAddress(hdr.from);
      if (!fromEmail) fromEmail = ha.email;
      if (!fromName) fromName = ha.name;
    }

    // 受信者
    var to = [], cc = [], bcc = [];
    var names = Object.keys(node.children);
    for (var i = 0; i < names.length; i++) {
      if (names[i].indexOf('__recip_version1.0_') !== 0) continue;
      var rn = node.children[names[i]];
      if (rn.type !== 'storage') continue;
      var rp = new Props(cfb, rn, 8, cpRef);
      var em = rp.str(P.SMTP_ADDRESS);
      if (!isSmtp(em)) {
        var raw = rp.str(P.EMAIL);
        em = isSmtp(raw) ? raw : (em || '');
      }
      var r = { name: rp.str(P.DISPLAY_NAME) || '', email: em, _order: names[i] };
      var t = rp.int(P.RECIPIENT_TYPE);
      if (t === 2) cc.push(r); else if (t === 3) bcc.push(r); else to.push(r);
    }
    [to, cc, bcc].forEach(function (list) {
      list.sort(function (a, b) { return a._order < b._order ? -1 : 1; });
      list.forEach(function (r) { delete r._order; });
    });
    // 受信者ストレージが無い .msg では表示用文字列だけが残る
    function fromDisplay(list, id) {
      if (list.length) return list;
      var d = p.str(id);
      if (!d) return list;
      return d.split(';').map(function (s) { return s.trim(); }).filter(Boolean).map(function (n) { return { name: n, email: '' }; });
    }
    to = fromDisplay(to, P.DISPLAY_TO);
    cc = fromDisplay(cc, P.DISPLAY_CC);
    bcc = fromDisplay(bcc, P.DISPLAY_BCC);

    // 本文
    var bodyText = p.str(P.BODY) || '';
    var bodyHtml = '';
    var hb = p.bytes(P.HTML);
    if (hb && hb.length) bodyHtml = decodeHtmlBytes(hb, internetCp || strCp);
    else {
      var hs = p.str(P.HTML);
      if (hs) bodyHtml = hs;
    }
    var bodySource = bodyText ? 'text' : '';
    if (!bodyText || !bodyHtml) {
      var rb = p.bytes(P.RTF_COMPRESSED);
      if (rb && rb.length) {
        try {
          var rtf = Rtf.decompress(rb);
          var ex = Rtf.extract(rtf, decodeBytes);
          if (ex.kind === 'html' && !bodyHtml) bodyHtml = ex.content;
          else if (ex.kind === 'text' && !bodyText) { bodyText = ex.content; bodySource = 'rtf'; }
        } catch (err) { /* RTF が壊れていても他の本文で続ける */ }
      }
    }
    if (!bodyText && bodyHtml) { bodyText = htmlToText(bodyHtml); bodySource = 'html'; }

    // 添付
    var attachments = [];
    for (i = 0; i < names.length; i++) {
      if (names[i].indexOf('__attach_version1.0_') !== 0) continue;
      var an = node.children[names[i]];
      if (an.type !== 'storage') continue;
      var ap = new Props(cfb, an, 8, cpRef);
      var method = ap.int(P.ATTACH_METHOD);
      var a = {
        name: ap.str(P.ATTACH_LONG_FILENAME) || ap.str(P.ATTACH_FILENAME) || ap.str(P.DISPLAY_NAME) || '',
        mime: ap.str(P.ATTACH_MIME) || '',
        contentId: (ap.str(P.ATTACH_CONTENT_ID) || '').replace(/^<|>$/g, ''),
        hidden: ap.int(P.ATTACHMENT_HIDDEN) === 1,
        size: 0,
        data: null,
        message: null,
        _order: names[i]
      };
      var objNode = an.children[('__substg1.0_' + hex4(P.ATTACH_DATA) + '000D').toLowerCase()];
      if (objNode && objNode.type === 'storage') {
        // 埋め込み .msg（転送メールなど）
        if (method === 5 || objNode.children['__properties_version1.0']) {
          if (depth < 8) {
            try { a.message = readMessage(cfb, objNode, true, depth + 1); } catch (err) { a.error = String(err.message || err); }
          }
          if (!a.name) a.name = (a.message && a.message.subject) || '添付メール';
          a.kind = 'message';
        } else {
          a.kind = 'ole';
        }
      } else {
        a.data = ap.bytes(P.ATTACH_DATA);
        a.size = a.data ? a.data.length : 0;
        a.kind = 'file';
      }
      if (!a.size) a.size = ap.int(P.ATTACH_SIZE) || 0;
      if (!a.name) a.name = 'attachment' + (attachments.length + 1);
      attachments.push(a);
    }
    attachments.sort(function (x, y) { return x._order < y._order ? -1 : 1; });
    attachments.forEach(function (x) { delete x._order; });

    var imp = p.int(P.IMPORTANCE);
    return {
      subject: p.str(P.SUBJECT) || decodeMimeWords(hdr.subject || ''),
      from: { name: fromName, email: fromEmail },
      to: to, cc: cc, bcc: bcc,
      sentAt: p.time(P.CLIENT_SUBMIT_TIME) || (hdr.date && !isNaN(Date.parse(hdr.date)) ? new Date(hdr.date).toISOString() : null),
      receivedAt: p.time(P.DELIVERY_TIME),
      createdAt: p.time(P.CREATION_TIME),
      messageId: p.str(P.INTERNET_MESSAGE_ID) || hdr['message-id'] || '',
      inReplyTo: p.str(P.IN_REPLY_TO) || hdr['in-reply-to'] || '',
      references: p.str(P.INTERNET_REFERENCES) || hdr.references || '',
      conversationTopic: p.str(P.CONVERSATION_TOPIC) || '',
      conversationIndex: toHex(p.bytes(P.CONVERSATION_INDEX)),
      importance: imp == null ? 1 : imp,
      messageClass: p.str(P.MESSAGE_CLASS) || '',
      codepage: cpRef.cp,
      bodyText: bodyText,
      bodyHtml: bodyHtml,
      bodySource: bodySource,
      headers: headersRaw,
      attachments: attachments
    };
  }

  /** Outlook の会話情報（PR_CONVERSATION_INDEX）を 16 進文字列にする。返信は先頭 22 バイトを元のメールから引き継ぐ */
  function toHex(b) {
    if (!b || !b.length) return '';
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  /** @param {Uint8Array|ArrayBuffer} bytes .msg ファイルの中身 */
  function parseMsg(bytes) {
    var cfb = Cfb.parse(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    var root = cfb.root;
    if (!root.children['__properties_version1.0'] && !root.children['__substg1.0_0037001f'] && !root.children['__substg1.0_0037001e']) {
      throw new Error('OLE ファイルですが Outlook のメール (.msg) ではありません');
    }
    return readMessage(cfb, root, false, 0);
  }

  var api = {
    parse: parseMsg, decodeBytes: decodeBytes, htmlToText: htmlToText,
    parseAddress: parseAddress, decodeMimeWords: decodeMimeWords, PROPS: P
  };
  g.MsgParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
