/*
 * 圧縮 RTF (PR_RTF_COMPRESSED, MS-OXRTFCP) の展開と、RTF からの本文取り出し。
 * Outlook は HTML メールを RTF に包んで (\fromhtml1) 保存することがあり、
 * その場合は MS-OXRTFEX の手順で元の HTML を取り出す。
 */
(function (g) {
  'use strict';

  var PREBUF = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

  /** @param {Uint8Array} src @returns {Uint8Array} RTF のバイト列 */
  function decompress(src) {
    if (!src || src.length < 16) throw new Error('圧縮 RTF が短すぎます');
    var dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    var compSize = dv.getUint32(0, true);
    var rawSize = dv.getUint32(4, true);
    var type = dv.getUint32(8, true);
    if (type === 0x414c454d) { // 'MELA' 非圧縮
      return src.subarray(16, Math.min(src.length, 16 + rawSize));
    }
    if (type !== 0x75465a4c) throw new Error('未知の RTF 圧縮形式');
    var end = Math.min(src.length, compSize + 4);
    var dict = new Uint8Array(4096);
    for (var i = 0; i < PREBUF.length; i++) dict[i] = PREBUF.charCodeAt(i);
    var w = PREBUF.length;
    var out = new Uint8Array(Math.max(rawSize, 16));
    var o = 0;
    function put(b) {
      if (o >= out.length) {
        var n = new Uint8Array(out.length * 2);
        n.set(out);
        out = n;
      }
      out[o++] = b;
    }
    var p = 16;
    while (p < end) {
      var ctrl = src[p++];
      for (var bit = 0; bit < 8 && p < end; bit++) {
        if (ctrl & (1 << bit)) {
          if (p + 1 >= end) return out.subarray(0, o);
          var ref = (src[p] << 8) | src[p + 1];
          p += 2;
          var off = ref >> 4;
          var len = (ref & 0xf) + 2;
          if (off === w) return out.subarray(0, o); // 終端
          for (var k = 0; k < len; k++) {
            var b = dict[(off + k) & 4095];
            put(b);
            dict[w] = b;
            w = (w + 1) & 4095;
          }
        } else {
          var lit = src[p++];
          put(lit);
          dict[w] = lit;
          w = (w + 1) & 4095;
        }
      }
    }
    return out.subarray(0, o);
  }

  // 本文として出さない宛先 (destination) グループ
  var SKIP_DEST = {
    fonttbl: 1, colortbl: 1, stylesheet: 1, info: 1, pict: 1, object: 1, header: 1, footer: 1,
    headerl: 1, headerr: 1, headerf: 1, footerl: 1, footerr: 1, footerf: 1, listtable: 1,
    listoverridetable: 1, revtbl: 1, rsidtbl: 1, generator: 1, xmlnstbl: 1, themedata: 1,
    colorschememapping: 1, latentstyles: 1, datastore: 1, fldinst: 1, filetbl: 1, pgdsctbl: 1,
    operator: 1, author: 1, title: 1, comment: 1, company: 1
  };

  /**
   * RTF を走査して HTML（\fromhtml1 のとき）またはテキストを取り出す。
   * @param {Uint8Array} rtf
   * @param {function(Uint8Array, number): string} decodeBytes 文字コード変換
   * @returns {{kind: 'html'|'text', content: string}}
   */
  function extract(rtf, decodeBytes) {
    var len = rtf.length;
    var head = '';
    for (var h = 0; h < Math.min(len, 2048); h++) head += String.fromCharCode(rtf[h]);
    var fromHtml = /\\fromhtml1/.test(head);
    var codepage = 1252;
    var mcp = /\\ansicpg(\d+)/.exec(head);
    if (mcp) codepage = parseInt(mcp[1], 10);

    var out = [];
    var bytesBuf = [];
    function flushBytes() {
      if (!bytesBuf.length) return;
      out.push(decodeBytes(new Uint8Array(bytesBuf), codepage));
      bytesBuf = [];
    }
    function emit(s) { flushBytes(); out.push(s); }

    // 状態: skip=出力しない, htmlrtf=HTML復元時に捨てる領域, tag=\*\htmltag の中, uc=\u の後に読み飛ばす数
    var st = { skip: false, htmlrtf: false, tag: false, uc: 1 };
    var stack = [];
    var groupStart = false;
    var starPending = false;
    var ucSkip = 0;
    var i = 0;

    function visible() {
      if (st.skip) return false;
      if (fromHtml) return st.tag || !st.htmlrtf;
      return true;
    }

    while (i < len) {
      var ch = rtf[i];
      if (ch === 0x7b) { // {
        stack.push(st);
        st = { skip: st.skip, htmlrtf: st.htmlrtf, tag: st.tag, uc: st.uc };
        groupStart = true;
        i++;
        continue;
      }
      if (ch === 0x7d) { // }
        if (stack.length) st = stack.pop();
        groupStart = false;
        starPending = false;
        i++;
        continue;
      }
      if (ch === 0x5c) { // \
        var nx = rtf[i + 1];
        if (nx === undefined) break;
        var isLetter = (nx >= 0x61 && nx <= 0x7a) || (nx >= 0x41 && nx <= 0x5a);
        if (!isLetter) {
          i += 2;
          if (nx === 0x27) { // \'hh
            var hex = String.fromCharCode(rtf[i], rtf[i + 1]);
            i += 2;
            if (ucSkip > 0) { ucSkip--; continue; }
            if (visible()) bytesBuf.push(parseInt(hex, 16) || 0);
            continue;
          }
          if (nx === 0x2a) { starPending = true; continue; } // \*
          if (ucSkip > 0) { ucSkip--; continue; }
          groupStart = false;
          if (!visible()) continue;
          if (nx === 0x5c || nx === 0x7b || nx === 0x7d) emit(String.fromCharCode(nx));
          else if (nx === 0x7e) emit(' ');
          else if (nx === 0x0a || nx === 0x0d) emit('\n');
          continue;
        }
        // 制御語
        var j = i + 1;
        while (j < len && ((rtf[j] >= 0x61 && rtf[j] <= 0x7a) || (rtf[j] >= 0x41 && rtf[j] <= 0x5a))) j++;
        var word = '';
        for (var q = i + 1; q < j; q++) word += String.fromCharCode(rtf[q]);
        var param = null;
        var ps = j;
        if (rtf[j] === 0x2d || (rtf[j] >= 0x30 && rtf[j] <= 0x39)) {
          j++;
          while (j < len && rtf[j] >= 0x30 && rtf[j] <= 0x39) j++;
          var numStr = '';
          for (q = ps; q < j; q++) numStr += String.fromCharCode(rtf[q]);
          param = parseInt(numStr, 10);
        }
        if (rtf[j] === 0x20) j++;
        i = j;

        if (groupStart) {
          groupStart = false;
          if (starPending) {
            starPending = false;
            if (fromHtml && word === 'htmltag') { st.tag = true; st.skip = false; continue; }
            st.skip = true;
            continue;
          }
          if (SKIP_DEST[word]) { st.skip = true; continue; }
        }
        starPending = false;

        if (word === 'bin' && param > 0) { i += param; continue; }
        if (ucSkip > 0) { ucSkip--; continue; }
        if (word === 'htmlrtf') { st.htmlrtf = param !== 0; continue; }
        if (word === 'uc') { st.uc = param == null ? 1 : param; continue; }
        if (word === 'u') {
          var code = param < 0 ? param + 65536 : param;
          if (visible()) emit(String.fromCharCode(code));
          ucSkip = st.uc;
          continue;
        }
        if (word === 'ansicpg' && param) { flushBytes(); codepage = param; continue; }
        if (!visible()) continue;
        if (word === 'par' || word === 'line') emit(fromHtml && st.tag ? '\r\n' : '\n');
        else if (word === 'tab') emit('\t');
        else if (word === 'emdash') emit('—');
        else if (word === 'endash') emit('–');
        else if (word === 'bullet') emit('•');
        else if (word === 'lquote') emit('‘');
        else if (word === 'rquote') emit('’');
        else if (word === 'ldblquote') emit('“');
        else if (word === 'rdblquote') emit('”');
        continue;
      }
      // 通常の文字
      groupStart = false;
      starPending = false;
      i++;
      if (ch === 0x0d || ch === 0x0a) continue;
      if (ucSkip > 0) { ucSkip--; continue; }
      if (visible()) bytesBuf.push(ch);
    }
    flushBytes();
    var content = out.join('');
    if (!fromHtml) content = content.replace(/\n{3,}/g, '\n\n').trim();
    return { kind: fromHtml ? 'html' : 'text', content: content };
  }

  var api = { decompress: decompress, extract: extract, PREBUF: PREBUF };
  g.MsgRtf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
