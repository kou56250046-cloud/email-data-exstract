/*
 * ZIP の書き出し（評価データの一括保存用）。無圧縮（STORE）だけ。zip64 は扱わない。
 * ファイル名は UTF-8 フラグ（bit 11）付きで入れ、Windows のエクスプローラーでも日本語名のまま展開できるようにする。
 */
(function (g) {
  'use strict';

  var MAX_ENTRIES = 65535;
  var MAX_BYTES = 0xFFFFFFFF;

  var TABLE = null;
  function crcTable() {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
    return TABLE;
  }
  /** CRC-32（ZIP と同じ多項式） */
  function crc32(bytes) {
    var t = crcTable(), c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** Windows のファイル名に使えない文字を _ にし、長さを切り詰める（フォルダ 1 段分の名前） */
  function safeName(s, max) {
    max = max || 80;
    var t = String(s == null ? '' : s).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '').trim();
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(t)) t = '_' + t;
    if (t.length > max) {
      var m = /(\.[A-Za-z0-9]{1,5})$/.exec(t); // 拡張子は残す
      var ext = m ? m[1] : '';
      t = t.slice(0, max - ext.length).replace(/[. ]+$/, '') + ext;
    }
    return t || '_';
  }

  /** Date → DOS の日付・時刻 */
  function dosTime(d) {
    d = d instanceof Date && !isNaN(d) ? d : new Date();
    var y = Math.max(1980, Math.min(2107, d.getFullYear()));
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  /**
   * entries: [{ name: 'フォルダ/ファイル名', data: Uint8Array | string, date?: Date }]
   * 返り値: ZIP のバイト列（Uint8Array）
   */
  function build(entries) {
    if (entries.length > MAX_ENTRIES) throw new Error('ファイルが ' + MAX_ENTRIES + ' 個を超えるため、zip にできません（' + entries.length + ' 個）');
    var enc = new TextEncoder();
    var parts = [], central = [], off = 0;
    var seen = {};
    entries.forEach(function (e) {
      if (seen[e.name]) throw new Error('zip の中で名前が重なっています: ' + e.name);
      seen[e.name] = true;
      var nb = enc.encode(e.name);
      var data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      var crc = crc32(data), dt = dosTime(e.date);
      var lh = new Uint8Array(30), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dt.time, true); lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, nb.length, true); lv.setUint16(28, 0, true);
      var ch = new Uint8Array(46), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true); cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nb.length, true); cv.setUint32(42, off, true);
      parts.push(lh, nb, data);
      central.push(ch, nb);
      off += 30 + nb.length + data.length;
      if (off > MAX_BYTES) throw new Error('合計が 4GB を超えるため、zip にできません。件数を減らしてください');
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    if (off + cdSize > MAX_BYTES) throw new Error('合計が 4GB を超えるため、zip にできません。件数を減らしてください');
    var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
    var all = parts.concat(central, [eocd]);
    var out = new Uint8Array(off + cdSize + 22), p = 0;
    all.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  var api = { crc32: crc32, build: build, safeName: safeName };
  g.MsgZipW = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
