/*
 * OLE 複合ファイル (Compound File Binary, MS-CFB) の読み取り。
 * .msg はこの形式の中に MAPI プロパティをストリームとして格納している。
 * 読み取り専用。書き込みは tests/make-msg.mjs 側にある。
 */
(function (g) {
  'use strict';

  var SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  var ENDOFCHAIN = 0xfffffffe;
  var FREESECT = 0xffffffff;
  var NOSTREAM = 0xffffffff;

  function CfbError(msg) {
    var e = new Error(msg);
    e.name = 'CfbError';
    return e;
  }

  /**
   * @param {Uint8Array} bytes ファイル全体
   * @returns {{root: object, read: function(object): Uint8Array}}
   */
  function parse(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < 512) throw CfbError('ファイルが小さすぎます（.msg ではありません）');
    for (var i = 0; i < 8; i++) {
      if (bytes[i] !== SIG[i]) throw CfbError('.msg 形式ではありません（OLE 署名なし）');
    }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var u16 = function (o) { return dv.getUint16(o, true); };
    var u32 = function (o) { return dv.getUint32(o, true); };

    var sectorShift = u16(0x1e);
    var miniShift = u16(0x20);
    if (sectorShift !== 9 && sectorShift !== 12) throw CfbError('不正なセクタサイズ');
    var sectorSize = 1 << sectorShift;
    var miniSize = 1 << miniShift;
    var numFat = u32(0x2c);
    var firstDir = u32(0x30);
    var miniCutoff = u32(0x38) || 4096;
    var firstMiniFat = u32(0x3c);
    var numMiniFat = u32(0x40);
    var firstDifat = u32(0x44);
    var numDifat = u32(0x48);
    var totalSectors = Math.floor((bytes.length - sectorSize) / sectorSize) + 1;

    function sectorOffset(n) { return (n + 1) * sectorSize; }

    // FAT セクタ番号の一覧（ヘッダの 109 個 + DIFAT チェーン）
    var fatSectors = [];
    for (i = 0; i < 109 && fatSectors.length < numFat; i++) {
      var s = u32(0x4c + i * 4);
      if (s === FREESECT) break;
      fatSectors.push(s);
    }
    var difat = firstDifat;
    var guard = 0;
    while (fatSectors.length < numFat && difat !== ENDOFCHAIN && difat !== FREESECT && guard++ <= numDifat) {
      var off = sectorOffset(difat);
      if (off + sectorSize > bytes.length) break;
      var per = sectorSize / 4 - 1;
      for (i = 0; i < per && fatSectors.length < numFat; i++) {
        var v = u32(off + i * 4);
        if (v !== FREESECT) fatSectors.push(v);
      }
      difat = u32(off + per * 4);
    }

    var entriesPerSector = sectorSize / 4;
    var fat = new Uint32Array(fatSectors.length * entriesPerSector);
    for (i = 0; i < fatSectors.length; i++) {
      var fo = sectorOffset(fatSectors[i]);
      for (var j = 0; j < entriesPerSector; j++) {
        fat[i * entriesPerSector + j] = fo + j * 4 + 4 <= bytes.length ? u32(fo + j * 4) : FREESECT;
      }
    }

    // チェーンをたどる。壊れたファイルでの無限ループを防ぐため訪問数を上限で切る
    function chain(start, table, limit) {
      var out = [];
      var cur = start;
      while (cur !== ENDOFCHAIN && cur !== FREESECT && cur < table.length) {
        out.push(cur);
        if (out.length > limit) throw CfbError('セクタチェーンが循環しています');
        cur = table[cur];
      }
      return out;
    }

    function readChain(start, size) {
      var secs = chain(start, fat, totalSectors + 1);
      var len = size == null ? secs.length * sectorSize : size;
      var out = new Uint8Array(len);
      var pos = 0;
      for (var k = 0; k < secs.length && pos < len; k++) {
        var so = sectorOffset(secs[k]);
        var n = Math.min(sectorSize, len - pos, Math.max(0, bytes.length - so));
        out.set(bytes.subarray(so, so + n), pos);
        pos += n;
      }
      return out;
    }

    // ディレクトリ
    var dirBytes = readChain(firstDir, null);
    var entries = [];
    for (var d = 0; d + 128 <= dirBytes.length; d += 128) {
      var ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset + d, 128);
      var nameLen = ddv.getUint16(0x40, true);
      var name = '';
      for (var c = 0; c + 2 < nameLen && c < 64; c += 2) name += String.fromCharCode(ddv.getUint16(c, true));
      entries.push({
        name: name,
        type: ddv.getUint8(0x42),
        left: ddv.getUint32(0x44, true),
        right: ddv.getUint32(0x48, true),
        child: ddv.getUint32(0x4c, true),
        start: ddv.getUint32(0x74, true),
        size: ddv.getUint32(0x78, true) // 上位 32bit は v3 では無意味なので読まない
      });
    }
    if (!entries.length || entries[0].type !== 5) throw CfbError('ルートエントリがありません');

    // ミニストリームと MiniFAT
    var root = entries[0];
    var miniStream = root.start === ENDOFCHAIN ? new Uint8Array(0) : readChain(root.start, root.size);
    var miniFat = new Uint32Array(0);
    if (numMiniFat > 0 && firstMiniFat !== ENDOFCHAIN) {
      var mfBytes = readChain(firstMiniFat, null);
      miniFat = new Uint32Array(mfBytes.length / 4);
      var mdv = new DataView(mfBytes.buffer, mfBytes.byteOffset, mfBytes.byteLength);
      for (i = 0; i < miniFat.length; i++) miniFat[i] = mdv.getUint32(i * 4, true);
    }

    function readMini(start, size) {
      var secs = chain(start, miniFat, miniFat.length + 1);
      var out = new Uint8Array(size);
      var pos = 0;
      for (var k = 0; k < secs.length && pos < size; k++) {
        var so = secs[k] * miniSize;
        var n = Math.min(miniSize, size - pos, Math.max(0, miniStream.length - so));
        out.set(miniStream.subarray(so, so + n), pos);
        pos += n;
      }
      return out;
    }

    // 兄弟の赤黒木を平らにして子の一覧を作る
    var visited = new Uint8Array(entries.length);
    function children(idx) {
      var list = [];
      var stack = [];
      var cur = idx;
      var steps = 0;
      while ((cur !== NOSTREAM && cur < entries.length) || stack.length) {
        if (++steps > entries.length * 4) break;
        while (cur !== NOSTREAM && cur < entries.length) {
          stack.push(cur);
          cur = entries[cur].left;
        }
        cur = stack.pop();
        list.push(cur);
        cur = entries[cur].right;
      }
      return list;
    }

    function build(idx) {
      var e = entries[idx];
      var node = { name: e.name, type: e.type === 2 ? 'stream' : 'storage', size: e.size, _start: e.start, children: null };
      if (e.type === 1 || e.type === 5) {
        node.children = {};
        if (e.child !== NOSTREAM) {
          var kids = children(e.child);
          for (var k = 0; k < kids.length; k++) {
            var ki = kids[k];
            if (visited[ki]) continue;
            visited[ki] = 1;
            var ce = entries[ki];
            if (ce.type !== 1 && ce.type !== 2) continue;
            node.children[ce.name.toLowerCase()] = build(ki);
          }
        }
      }
      return node;
    }
    visited[0] = 1;
    var tree = build(0);

    function read(node) {
      if (!node || node.type !== 'stream') return null;
      if (node.size === 0) return new Uint8Array(0);
      if (node.size < miniCutoff) return readMini(node._start, node.size);
      return readChain(node._start, node.size);
    }

    return { root: tree, read: read };
  }

  var api = { parse: parse };
  g.MsgCfb = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
