/*
 * 添付 xlsx の読み取り（表示・検索用）。ZIP は自前で読み、DEFLATE はブラウザ標準の DecompressionStream で戻す。
 * 数式は計算済みの値だけを読む。書式・結合セル・画像は扱わない。
 */
(function (g) {
  'use strict';

  var MAX_ROWS = 2000;
  var MAX_COLS = 60;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

  /** ZIP の中央ディレクトリから一覧を作る */
  function listZip(b) {
    var eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP 形式ではありません');
    var n = u16(b, eocd + 10);
    var p = u32(b, eocd + 16);
    var out = {};
    var utf8 = new TextDecoder('utf-8');
    for (var k = 0; k < n && p + 46 <= b.length; k++) {
      if (u32(b, p) !== 0x02014b50) break;
      var method = u16(b, p + 10);
      var csize = u32(b, p + 20);
      var nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
      var local = u32(b, p + 42);
      var name = utf8.decode(b.subarray(p + 46, p + 46 + nlen));
      out[name.replace(/^\//, '')] = { method: method, csize: csize, local: local };
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('このブラウザは展開に対応していません'));
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([data]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function readEntry(b, e) {
    var lo = e.local;
    if (u32(b, lo) !== 0x04034b50) return Promise.reject(new Error('ZIP が壊れています'));
    var start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    var data = b.subarray(start, start + e.csize);
    if (e.method === 0) return Promise.resolve(data);
    if (e.method === 8) return inflateRaw(data);
    return Promise.reject(new Error('未対応の圧縮方式'));
  }

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unxml(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, function (m, e) {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e] || m;
    }).replace(/_x([0-9A-Fa-f]{4})_/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
  }
  function attr(tag, name) {
    var m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
    return m ? unxml(m[1]) : null;
  }
  // <t> を集める。ふりがな (<rPh>) は除く
  function texts(xml) {
    xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    var out = '';
    var re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, m;
    while ((m = re.exec(xml))) out += unxml(m[1]);
    return out;
  }

  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    var n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }

  var BUILTIN_DATE = { 14: 1, 15: 1, 16: 1, 17: 1, 18: 2, 19: 2, 20: 2, 21: 2, 22: 3, 45: 2, 46: 2, 47: 2, 27: 1, 28: 1, 29: 1, 30: 1, 31: 1, 32: 2, 33: 2, 34: 2, 35: 2, 36: 1, 50: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1 };
  /** styles.xml から、スタイル番号 → 0:数値 1:日付 2:時刻 3:日時 の表を作る */
  function dateStyles(xml) {
    var custom = {};
    var re = /<numFmt\b[^>]*>/g, m;
    while ((m = re.exec(xml))) {
      var id = parseInt(attr(m[0], 'numFmtId'), 10);
      var code = (attr(m[0], 'formatCode') || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      var d = /[ymd]|e|g/i.test(code.replace(/General/i, '')), t = /[hs]/i.test(code);
      custom[id] = d && t ? 3 : d ? 1 : t ? 2 : 0;
    }
    var out = [];
    var xfs = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(xml);
    if (xfs) {
      var xr = /<xf\b[^>]*>/g;
      while ((m = xr.exec(xfs[0]))) {
        var nid = parseInt(attr(m[0], 'numFmtId') || '0', 10);
        out.push(custom[nid] != null ? custom[nid] : (BUILTIN_DATE[nid] || 0));
      }
    }
    return out;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function serialToText(v, kind) {
    var ms = Math.round((v - 25569) * 86400000);
    var d = new Date(ms);
    if (isNaN(d)) return String(v);
    var date = d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate());
    var time = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return kind === 1 ? date : kind === 2 ? time : date + ' ' + time;
  }
  function numText(s) {
    var n = Number(s);
    if (!isFinite(n)) return s;
    // 浮動小数の誤差 (0.1+0.2) を表示上だけ丸める
    return String(Math.round(n * 1e10) / 1e10);
  }

  function parseSheet(xml, shared, styles) {
    var rows = [];
    var truncated = false;
    var rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g, rm;
    var autoRow = 0;
    while ((rm = rowRe.exec(xml))) {
      if (rm[2] == null) { autoRow++; continue; }
      var rAttr = /\sr="(\d+)"/.exec(rm[1]);
      var ri = rAttr ? parseInt(rAttr[1], 10) - 1 : autoRow;
      autoRow = ri + 1;
      if (ri >= MAX_ROWS) { truncated = true; break; }
      var row = [];
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      var autoCol = 0;
      while ((cm = cellRe.exec(rm[2]))) {
        var ca = cm[1];
        var ci = colIndex(attr(ca, 'r'));
        if (ci < 0) ci = autoCol;
        autoCol = ci + 1;
        if (ci >= MAX_COLS) { truncated = true; continue; }
        var body = cm[2] || '';
        var t = attr(ca, 't');
        var vm = /<v>([\s\S]*?)<\/v>/.exec(body);
        var v = vm ? unxml(vm[1]) : '';
        var text = '';
        if (t === 's') text = shared[parseInt(v, 10)] || '';
        else if (t === 'inlineStr') text = texts(body);
        else if (t === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
        else if (t === 'str' || t === 'e') text = v;
        else if (v !== '') {
          var kind = styles[parseInt(attr(ca, 's') || '0', 10)] || 0;
          text = kind ? serialToText(Number(v), kind) : numText(v);
        }
        if (text !== '') row[ci] = text;
      }
      if (row.length) rows[ri] = row;
    }
    // 空行・空列を詰めずに残すと表が崩れないが、末尾の空は落とす
    var dense = [];
    var maxCol = 0;
    for (var r = 0; r < rows.length; r++) {
      var rr = rows[r] || [];
      for (var c = 0; c < rr.length; c++) if (rr[c] == null) rr[c] = '';
      if (rr.length > maxCol) maxCol = rr.length;
      dense.push(rr);
    }
    return { rows: dense, cols: maxCol, truncated: truncated };
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {Promise<{sheets: {name:string, rows:string[][], cols:number, truncated:boolean}[], text:string}>}
   */
  function read(bytes) {
    var zip = listZip(bytes);
    function get(name) { return zip[name] ? readEntry(bytes, zip[name]).then(function (b) { return new TextDecoder('utf-8').decode(b); }) : Promise.resolve(''); }
    if (!zip['xl/workbook.xml']) return Promise.reject(new Error('xlsx ではありません'));
    return Promise.all([get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'), get('xl/sharedStrings.xml'), get('xl/styles.xml')]).then(function (r) {
      var wb = r[0], rels = r[1], ssXml = r[2], stXml = r[3];
      var shared = [];
      var siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g, m;
      while ((m = siRe.exec(ssXml))) shared.push(m[1] ? texts(m[1]) : '');
      var styles = dateStyles(stXml);
      var relMap = {};
      var relRe = /<Relationship\b[^>]*>/g;
      while ((m = relRe.exec(rels))) relMap[attr(m[0], 'Id')] = attr(m[0], 'Target');
      var sheetDefs = [];
      var shRe = /<sheet\b[^>]*>/g;
      while ((m = shRe.exec(wb))) {
        var target = relMap[attr(m[0], 'r:id')] || '';
        target = target.replace(/^\//, '').replace(/^xl\//, '');
        sheetDefs.push({ name: attr(m[0], 'name') || 'Sheet', path: 'xl/' + target, hidden: /state="(hidden|veryHidden)"/.test(m[0]) });
      }
      return Promise.all(sheetDefs.map(function (s) { return get(s.path); })).then(function (xmls) {
        var sheets = sheetDefs.map(function (s, i) {
          var p = parseSheet(xmls[i], shared, styles);
          p.name = s.name;
          p.hidden = s.hidden;
          return p;
        });
        var text = sheets.map(function (s) {
          return '[' + s.name + ']\n' + s.rows.map(function (row) {
            return row.filter(function (x) { return x !== ''; }).join('\t');
          }).filter(Boolean).join('\n');
        }).join('\n');
        return { sheets: sheets, text: text };
      });
    });
  }

  function isXlsx(att) {
    return /\.(xlsx|xlsm)$/i.test(att.name || '') || /spreadsheetml\.sheet|ms-excel\.sheet\.macroenabled/i.test(att.mime || '');
  }

  var api = { read: read, isXlsx: isXlsx, listZip: listZip };
  g.MsgXlsx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
