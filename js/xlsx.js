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
      var usize = u32(b, p + 24);
      var nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
      var local = u32(b, p + 42);
      var name = utf8.decode(b.subarray(p + 46, p + 46 + nlen));
      out[name.replace(/^\//, '')] = { method: method, csize: csize, usize: usize, local: local };
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  // 展開後の大きさの上限（圧縮爆弾でタブが落ちないように）。図形の VML などはもっと小さくてよい
  var MAX_ENTRY = 64 * 1024 * 1024;

  /** 展開しながら大きさを数え、max を超えたら打ち切って失敗にする */
  function inflateRaw(data, max) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('このブラウザは展開に対応していません'));
    var ds = new DecompressionStream('deflate-raw');
    var reader = new Blob([data]).stream().pipeThrough(ds).getReader();
    var chunks = [], total = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(total), o = 0;
          chunks.forEach(function (c) { out.set(c, o); o += c.length; });
          return out;
        }
        total += r.value.length;
        if (total > max) { reader.cancel(); throw new Error('展開後の大きさが上限を超えています'); }
        chunks.push(r.value);
        return pump();
      });
    }
    return pump();
  }

  function readEntry(b, e, max) {
    max = max || MAX_ENTRY;
    var lo = e.local;
    if (u32(b, lo) !== 0x04034b50) return Promise.reject(new Error('ZIP が壊れています'));
    if (e.usize > max) return Promise.reject(new Error('展開後の大きさが上限を超えています'));
    var start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    var data = b.subarray(start, start + e.csize);
    if (e.method === 0) return data.length > max ? Promise.reject(new Error('展開後の大きさが上限を超えています')) : Promise.resolve(data);
    if (e.method === 8) return inflateRaw(data, max);
    return Promise.reject(new Error('未対応の圧縮方式'));
  }

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unxml(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, function (m, e) {
      if (e[0] === '#') {
        var cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        // 範囲外・サロゲートは置換文字にする（例外で同じシートの他の値まで読めなくならないように）
        return cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
      }
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

  // ---------- フォームのチェックボックス ----------
  // 位置・文字・状態は VML（旧形式の図形）にある。Excel 2010 以降は ctrlProps にも状態を書くので、あればそちらを使う

  /** "xl/worksheets/sheet1.xml" と "../drawings/x.vml" から "xl/drawings/x.vml" を作る */
  function resolvePath(base, target) {
    if (!target) return '';
    if (target[0] === '/') return target.slice(1);
    var parts = base.split('/');
    parts.pop();
    target.split('/').forEach(function (p) {
      if (p === '..') parts.pop();
      else if (p && p !== '.') parts.push(p);
    });
    return parts.join('/');
  }
  function relsPath(path) {
    var i = path.lastIndexOf('/');
    return path.slice(0, i + 1) + '_rels/' + path.slice(i + 1) + '.rels';
  }
  function parseRels(xml, base) {
    var out = {};
    var re = /<Relationship\b[^>]*>/g, m;
    while ((m = re.exec(xml || ''))) out[attr(m[0], 'Id')] = resolvePath(base, attr(m[0], 'Target'));
    return out;
  }
  // 外から届く xlsx を読むので、図形まわりは正規表現の後戻りに頼らず indexOf で前へ進むだけの走査にする
  // （閉じタグの無い要素や長い属性値を並べた細工で、読み込みが固まらないように）
  var MAX_VML = 4 * 1024 * 1024;   // VML の展開後の上限
  var MAX_CTRL = 64 * 1024;        // ctrlProp 1 つの上限
  var MAX_CHECKS = 500;            // 1 シートで読むチェックボックスの数

  /** 開始タグ "<name" の直後が名前の続きでないか（"<control" と "<controls" を分ける） */
  function tagEndsAt(xml, i) { var c = xml.charAt(i); return c === '' || c === '>' || c === '/' || /\s/.test(c); }

  /**
   * 要素 <name ...>...</name> と <name .../> を順に返す。{ attrs: 開始タグの属性部, inner: 中身（自己終了なら ''） }
   * 閉じタグが見つからなければそこで打ち切る（以降を何度も走査しない）
   */
  function elements(xml, name, limit) {
    var out = [];
    var open = '<' + name, close = '</' + name + '>';
    var pos = 0;
    while (out.length < (limit || Infinity)) {
      var i = xml.indexOf(open, pos);
      if (i < 0) break;
      if (!tagEndsAt(xml, i + open.length)) { pos = i + open.length; continue; }
      var gt = xml.indexOf('>', i);
      if (gt < 0) break;
      var attrs = xml.slice(i + open.length, gt);
      if (attrs.charAt(attrs.length - 1) === '/') { out.push({ attrs: attrs.slice(0, -1), inner: '' }); pos = gt + 1; continue; }
      var j = xml.indexOf(close, gt);
      if (j < 0) break;
      out.push({ attrs: attrs, inner: xml.slice(gt + 1, j) });
      pos = j + close.length;
    }
    return out;
  }
  function tagText(xml, name) { var e = elements(xml, name, 1)[0]; return e ? e.inner : null; }
  function tagAttrs(xml, name) { var e = elements(xml, name, 1)[0]; return e ? ' ' + e.attrs : null; }

  /** 図形の中の文字（タグを除く）。< から > までを飛ばす。> が無ければ残りを捨てる */
  function plainText(xml) {
    var s = xml.replace(/<br\s*\/?>/gi, '\n');
    var out = '', pos = 0;
    while (pos < s.length) {
      var lt = s.indexOf('<', pos);
      if (lt < 0) { out += s.slice(pos); break; }
      out += s.slice(pos, lt);
      var gt = s.indexOf('>', lt);
      if (gt < 0) break;
      pos = gt + 1;
    }
    return unxml(out).replace(/[ \t\r\n]+/g, ' ').trim();
  }
  /** 属性の生の値（unxml しない）。"_x0000_s1025" を文字に戻さないため */
  function rawAttr(attrs, name) {
    var key = name + '="';
    var i = attrs.indexOf(' ' + key);
    if (i < 0) i = attrs.indexOf('\t' + key);
    if (i < 0) i = attrs.indexOf('\n' + key);
    if (i < 0) return null;
    var start = i + 1 + key.length;
    var end = attrs.indexOf('"', start);
    return end < 0 ? null : attrs.slice(start, end);
  }
  /** 文字列の末尾に続く数字（"_x0000_s1025" → "1025"）。無ければ null */
  function trailingDigits(s) {
    var i = s.length;
    while (i > 0 && s.charCodeAt(i - 1) >= 48 && s.charCodeAt(i - 1) <= 57) i--;
    return i < s.length ? s.slice(i) : null;
  }

  /** VML からチェックボックスを集める。shapeId（数値の文字列）→ {label, checked, row, col, row2} */
  function vmlChecks(xml) {
    var out = {}, n = 0;
    var shapes = elements(xml || '', 'v:shape');
    for (var k = 0; k < shapes.length && n < MAX_CHECKS; k++) {
      var sh = shapes[k];
      var cdAttrs = tagAttrs(sh.inner, 'x:ClientData');
      if (!cdAttrs || !/ObjectType="Checkbox"/i.test(cdAttrs)) continue;
      var cd = tagText(sh.inner, 'x:ClientData') || '';
      // シートの <control shapeId> と結ぶ番号。o:spid を先に見る（id が "Check_x0020_Box_x0020_1" のような名前のことがある）
      var raw = rawAttr(' ' + sh.attrs, 'o:spid') || rawAttr(' ' + sh.attrs, 'id') || '';
      var id = trailingDigits(raw) || 'v' + k;
      var anchor = (tagText(cd, 'x:Anchor') || '').split(',').map(function (s) { return parseInt(s, 10); });
      var ck = tagText(cd, 'x:Checked');
      var tb = tagText(sh.inner, 'v:textbox');
      out[id] = {
        label: tb ? plainText(tb) : '',
        checked: ck != null && ck.trim() === '1',
        col: isFinite(anchor[0]) ? anchor[0] : -1,
        row: isFinite(anchor[2]) ? anchor[2] : -1,
        row2: isFinite(anchor[6]) ? anchor[6] : -1
      };
      n++;
    }
    return out;
  }

  /** シートの <control> を集める（mc:AlternateContent の Choice と Fallback で重なるので shapeId でまとめる） */
  function sheetControls(xml) {
    var out = {}, n = 0;
    var list = elements(xml || '', 'control');
    for (var k = 0; k < list.length && n < MAX_CHECKS; k++) {
      var c = list[k];
      var id = attr(' ' + c.attrs, 'shapeId');
      if (!id || out[id]) continue;
      // Excel は <anchor><from><xdr:col>… と書く（from に接頭辞が無い）。接頭辞つきにも備える
      var from = tagText(c.inner, 'from') || tagText(c.inner, 'xdr:from') || '';
      var col = tagText(from, 'xdr:col'), row = tagText(from, 'xdr:row');
      out[id] = { rid: attr(' ' + c.attrs, 'r:id'), name: attr(' ' + c.attrs, 'name') || '', col: col != null ? parseInt(col, 10) : -1, row: row != null ? parseInt(row, 10) : -1 };
      n++;
    }
    return out;
  }

  /** 文字の無いチェックボックスは、置いてあるセルから右へ探して最初の文字をラベルにする */
  function labelFromCells(rows, row, col) {
    var r = rows[row];
    if (!r || col < 0) return '';
    for (var c = col; c < Math.min(r.length, col + 6); c++) {
      var v = (r[c] || '').trim();
      if (v && !/^(TRUE|FALSE)$/.test(v)) return v;
    }
    return '';
  }

  /**
   * @param {{rows:string[][]}} sheet
   * @param {object} vml vmlChecks の結果
   * @param {object} controls sheetControls の結果
   * @param {object} ctrlXml rId → ctrlProp の XML
   * @returns {{label:string, checked:boolean, row:number, col:number}[]} row・col は 0 始まり
   */
  function buildChecks(sheet, vml, controls, ctrlXml) {
    var ids = Object.keys(vml);
    var seen = {};
    ids.forEach(function (id) { seen[id] = 1; });
    Object.keys(controls).forEach(function (id) {
      if (seen[id]) return;
      var pr = ctrlXml[controls[id].rid] || '';
      if (/objectType="CheckBox"/i.test(pr) && ids.length < MAX_CHECKS) {
        vml[id] = { label: '', checked: false, col: controls[id].col, row: controls[id].row, row2: -1 };
        seen[id] = 1;
        ids.push(id);
      }
    });
    var out = ids.map(function (id) {
      var v = vml[id];
      var ctl = controls[id];
      var checked = v.checked;
      if (ctl && ctrlXml[ctl.rid]) {
        var pr = /<formControlPr\b[^>]*>/.exec(ctrlXml[ctl.rid]);
        if (pr) checked = attr(pr[0], 'checked') === 'Checked';
      }
      var label = v.label || labelFromCells(sheet.rows, v.row, v.col) || (v.row2 >= 0 && v.row2 !== v.row ? labelFromCells(sheet.rows, v.row2, v.col) : '');
      return { label: label, checked: checked, row: v.row, col: v.col };
    });
    out.sort(function (a, b) { return a.row - b.row || a.col - b.col; });
    return out;
  }

  /** シート 1 枚のチェックボックスを読む。無ければ [] */
  function readChecks(get, path, sheetXml, sheet) {
    if (!/<legacyDrawing\b|<control\b/.test(sheetXml)) return Promise.resolve([]);
    return get(relsPath(path)).then(function (relXml) {
      var rels = parseRels(relXml, path);
      var ld = tagAttrs(sheetXml, 'legacyDrawing');
      var controls = sheetControls(sheetXml);
      // 同じ ctrlProp を何度も展開しない
      var rids = [], has = {};
      Object.keys(controls).forEach(function (k) { var r = controls[k].rid; if (r && rels[r] && !has[r]) { has[r] = 1; rids.push(r); } });
      // ctrlProp は 1 つずつ失敗を受け止める（1 つ壊れていても VML の結果は使う）
      var ctrls = rids.map(function (r) { return get(rels[r], MAX_CTRL).catch(function () { return ''; }); });
      var vmlP = ld ? get(rels[attr(ld, 'r:id')] || '', MAX_VML).catch(function () { return ''; }) : Promise.resolve('');
      return Promise.all([vmlP].concat(ctrls)).then(function (xs) {
        var ctrlXml = {};
        rids.forEach(function (r, i) { ctrlXml[r] = xs[i + 1]; });
        return buildChecks(sheet, vmlChecks(xs[0]), controls, ctrlXml);
      });
    }).catch(function () { return []; });
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {Promise<{sheets: {name:string, rows:string[][], cols:number, truncated:boolean, checks:{label:string, checked:boolean, row:number, col:number}[]}[], text:string}>}
   */
  function read(bytes) {
    var zip = listZip(bytes);
    function get(name, max) {
      return name && Object.prototype.hasOwnProperty.call(zip, name)
        ? readEntry(bytes, zip[name], max).then(function (b) { return new TextDecoder('utf-8').decode(b); })
        : Promise.resolve('');
    }
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
        return Promise.all(sheets.map(function (p, i) { return readChecks(get, sheetDefs[i].path, xmls[i], p); })).then(function (cs) {
          cs.forEach(function (c, i) { sheets[i].checks = c; });
          return sheets;
        });
      }).then(function (sheets) {
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
