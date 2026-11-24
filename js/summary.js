/*
 * 集計。画面に依存しない純粋関数だけを置く（Node でテストする）。
 * rows の各要素は { cls: { main: {categoryId}, sub: {categoryId} }, ss: {name}, sentAt, receivedAt }。
 * カテゴリ ID が null のものは「未分類」の列・行（キー NONE）に数える。
 */
(function (g) {
  'use strict';

  var NONE = '__none__';
  var NO_SS = '（SS 不明）';

  function idOf(m, axis) { return (m.cls && m.cls[axis] && m.cls[axis].categoryId) || NONE; }

  /** カテゴリ一覧＋未分類（未分類が 0 件なら出さない） */
  function axisKeys(rows, cats, axis) {
    var keys = cats.map(function (c) { return c.id; });
    var known = {};
    keys.forEach(function (k) { known[k] = 1; });
    var hasNone = rows.some(function (m) { return !known[idOf(m, axis)]; });
    if (hasNone) keys.push(NONE);
    return keys;
  }

  /** 主×副の件数表 */
  function matrix(rows, mainCats, subCats) {
    var mk = axisKeys(rows, mainCats, 'main');
    var sk = axisKeys(rows, subCats, 'sub');
    var mSet = {}, sSet = {};
    mk.forEach(function (k) { mSet[k] = 1; });
    sk.forEach(function (k) { sSet[k] = 1; });
    var cells = {}, rowTotal = {}, colTotal = {}, max = 0;
    mk.forEach(function (r) { cells[r] = {}; rowTotal[r] = 0; sk.forEach(function (c) { cells[r][c] = 0; }); });
    sk.forEach(function (c) { colTotal[c] = 0; });
    rows.forEach(function (m) {
      var r = idOf(m, 'main'), c = idOf(m, 'sub');
      if (!mSet[r]) r = NONE;
      if (!sSet[c]) c = NONE;
      cells[r][c]++;
      rowTotal[r]++;
      colTotal[c]++;
      if (cells[r][c] > max) max = cells[r][c];
    });
    return { rows: mk, cols: sk, cells: cells, rowTotal: rowTotal, colTotal: colTotal, total: rows.length, max: max };
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function monthOf(m) {
    var iso = m.sentAt || m.receivedAt;
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  /** 月別（行＝月の古い順、列＝主カテゴリ）。日付の無いメールは「日付なし」 */
  function monthly(rows, mainCats) {
    var cols = axisKeys(rows, mainCats, 'main');
    var known = {};
    cols.forEach(function (k) { known[k] = 1; });
    var map = {};
    var NO_DATE = '日付なし';
    rows.forEach(function (m) {
      var mo = monthOf(m) || NO_DATE;
      var c = idOf(m, 'main');
      if (!known[c]) c = NONE;
      if (!map[mo]) { map[mo] = { total: 0 }; cols.forEach(function (k) { map[mo][k] = 0; }); }
      map[mo][c]++;
      map[mo].total++;
    });
    // 件数 0 の月も抜けないように、最初の月から最後の月まで埋める
    var months = Object.keys(map).filter(function (k) { return k !== NO_DATE; }).sort();
    var filled = [];
    if (months.length) {
      var y = +months[0].slice(0, 4), mo = +months[0].slice(5);
      var last = months[months.length - 1];
      for (var guard = 0; guard < 1200; guard++) {
        var key = y + '-' + pad(mo);
        filled.push(key);
        if (key === last) break;
        if (++mo > 12) { mo = 1; y++; }
      }
    }
    if (map[NO_DATE]) filled.push(NO_DATE);
    var out = filled.map(function (k) {
      var row = map[k] || { total: 0 };
      cols.forEach(function (c) { if (row[c] == null) row[c] = 0; });
      return { month: k, counts: row, total: row.total };
    });
    var max = out.reduce(function (a, r) { return Math.max(a, r.total); }, 0);
    return { cols: cols, rows: out, max: max, total: rows.length };
  }

  /** SS 別（行＝SS の件数が多い順、列＝主カテゴリ） */
  function bySs(rows, mainCats) {
    var cols = axisKeys(rows, mainCats, 'main');
    var known = {};
    cols.forEach(function (k) { known[k] = 1; });
    var map = {};
    rows.forEach(function (m) {
      var s = (m.ss && m.ss.name) || NO_SS;
      var c = idOf(m, 'main');
      if (!known[c]) c = NONE;
      if (!map[s]) { map[s] = { total: 0 }; cols.forEach(function (k) { map[s][k] = 0; }); }
      map[s][c]++;
      map[s].total++;
    });
    var list = Object.keys(map).map(function (k) { return { ss: k, counts: map[k], total: map[k].total }; });
    list.sort(function (a, b) {
      if ((a.ss === NO_SS) !== (b.ss === NO_SS)) return a.ss === NO_SS ? 1 : -1; // 不明は最後
      return b.total - a.total || (a.ss < b.ss ? -1 : 1);
    });
    var max = list.reduce(function (a, r) { return Math.max(a, r.total); }, 0);
    return { cols: cols, rows: list, max: max, total: rows.length };
  }

  /** 軸ごとの件数と割合（カテゴリの並び順、未分類は最後）。share は 0〜1 */
  function shares(rows, cats, axis) {
    var keys = axisKeys(rows, cats, axis);
    var known = {}, count = {};
    keys.forEach(function (k) { known[k] = 1; count[k] = 0; });
    rows.forEach(function (m) {
      var k = idOf(m, axis);
      count[known[k] ? k : NONE]++;
    });
    var total = rows.length;
    return {
      total: total,
      rows: keys.map(function (k) { return { key: k, count: count[k], share: total ? count[k] / total : 0 }; })
    };
  }

  /** 主×副の各マスの割合。all＝全体に占める割合、row＝行（主）の中の割合 */
  function matrixShares(mx) {
    var all = {}, row = {}, maxAll = 0, maxRow = 0;
    mx.rows.forEach(function (r) {
      all[r] = {}; row[r] = {};
      mx.cols.forEach(function (c) {
        var n = mx.cells[r][c];
        all[r][c] = mx.total ? n / mx.total : 0;
        row[r][c] = mx.rowTotal[r] ? n / mx.rowTotal[r] : 0;
        if (all[r][c] > maxAll) maxAll = all[r][c];
        if (row[r][c] > maxRow) maxRow = row[r][c];
      });
    });
    return { all: all, row: row, maxAll: maxAll, maxRow: maxRow };
  }

  /** 最大剰余法: 重み weights に比例して n を整数で配る（合計は必ず n） */
  function largestRemainder(weights, n) {
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    if (!sum || n <= 0) return weights.map(function () { return 0; });
    var raw = weights.map(function (w) { return (w / sum) * n; });
    var out = raw.map(Math.floor);
    var left = n - out.reduce(function (a, b) { return a + b; }, 0);
    var order = raw.map(function (v, i) { return { i: i, r: v - Math.floor(v), w: weights[i] }; })
      .filter(function (o) { return o.w > 0; })
      .sort(function (a, b) { return b.r - a.r || b.w - a.w || a.i - b.i; });
    for (var j = 0; j < left && order.length; j++) out[order[j % order.length].i]++;
    return out;
  }

  /**
   * 評価データの配分試算。
   * strata: [{ key, count }]（母数 0 の層は除いて渡す）
   * method: 'prop'（比例）| 'equal'（均等）| 'min'（各層に最低 minK 件、残りを比例）
   * 返り値: { rows: [{ key, count, share, alloc, allocShare, short }], n, population, notes: [] }
   *   short＝配分件数が母数を超える分（集めきれない件数）
   */
  function allocate(strata, n, method, minK) {
    n = Math.max(0, Math.floor(+n || 0));
    minK = Math.max(0, Math.floor(+minK || 0));
    var counts = strata.map(function (s) { return s.count; });
    var population = counts.reduce(function (a, b) { return a + b; }, 0);
    var notes = [];
    var alloc;
    if (method === 'equal') {
      alloc = largestRemainder(counts.map(function (c) { return c > 0 ? 1 : 0; }), n);
    } else if (method === 'min') {
      var k = minK;
      var active = counts.filter(function (c) { return c > 0; }).length;
      if (k * active > n) {
        k = active ? Math.floor(n / active) : 0;
        notes.push('最低件数 ' + minK + ' 件 × ' + active + ' 層が総件数 ' + n + ' 件を超えるため、最低件数を ' + k + ' 件に下げて配りました。');
      }
      var base = counts.map(function (c) { return c > 0 ? k : 0; });
      var rest = n - base.reduce(function (a, b) { return a + b; }, 0);
      var extra = largestRemainder(counts, rest);
      alloc = base.map(function (b, i) { return b + extra[i]; });
    } else {
      alloc = largestRemainder(counts, n);
    }
    if (n > population) notes.push('総件数 ' + n + ' 件が対象のメール ' + population + ' 件より多いため、集めきれません。');
    var rows = strata.map(function (s, i) {
      return {
        key: s.key, count: s.count,
        share: population ? s.count / population : 0,
        alloc: alloc[i],
        allocShare: n ? alloc[i] / n : 0,
        short: Math.max(0, alloc[i] - s.count)
      };
    });
    var zero = rows.filter(function (r) { return r.count > 0 && r.alloc === 0; }).length;
    if (zero) notes.push('配分が 0 件の層が ' + zero + ' つあります。この層は評価データに入りません。少ない分類も確かめたいときは「比例＋最低件数」を選んでください。');
    var shortN = rows.reduce(function (a, r) { return a + r.short; }, 0);
    if (shortN && n <= population) notes.push('母数が配分件数に足りない層があります（不足 計 ' + shortN + ' 件）。');
    return { rows: rows, n: n, population: population, notes: notes };
  }

  /** 評価データの層のキー（app.js の配分の層と同じ形: 主 / 副 / 主|副）。カテゴリ一覧に無いものは未分類 */
  function stratumKeyOf(m, layer, mainCats, subCats) {
    var has = function (cats, id) { return cats.some(function (c) { return c.id === id; }); };
    var r = idOf(m, 'main'), c = idOf(m, 'sub');
    if (!has(mainCats, r)) r = NONE;
    if (!has(subCats, c)) c = NONE;
    return layer === 'main' ? r : layer === 'sub' ? c : r + '|' + c;
  }

  /** 32 bit の乱数（mulberry32）。同じ seed なら同じ列 */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function strHash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  /**
   * 層ごとの無作為抽出。groups: { 層キー: [{ key, ... }] }、allocMap: { 層キー: 件数 }。
   * 読み込み順に左右されないよう key で並べてから、seed と層キーで決まる乱数で並べ替えて先頭から取る。
   * 返り値: { 層キー: [選ばれた要素] }（件数は min(配分, 母数)）
   */
  function sample(groups, allocMap, seed) {
    var out = {};
    Object.keys(allocMap).forEach(function (k) {
      var items = (groups[k] || []).slice().sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
      var n = Math.min(Math.max(0, Math.floor(+allocMap[k] || 0)), items.length);
      var rand = rng((seed >>> 0) ^ strHash(k));
      for (var i = items.length - 1; i > 0; i--) {
        var j = Math.floor(rand() * (i + 1));
        var t = items[i]; items[i] = items[j]; items[j] = t;
      }
      out[k] = items.slice(0, n);
    });
    return out;
  }

  function cell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  /** 2 次元配列 → CSV（UTF-8 BOM 付き、Excel 向け） */
  function tableToCsv(table) {
    return '﻿' + table.map(function (r) { return r.map(cell).join(','); }).join('\r\n') + '\r\n';
  }

  var api = {
    NONE: NONE, NO_SS: NO_SS, matrix: matrix, monthly: monthly, bySs: bySs, tableToCsv: tableToCsv, monthOf: monthOf,
    shares: shares, matrixShares: matrixShares, largestRemainder: largestRemainder, allocate: allocate,
    stratumKeyOf: stratumKeyOf, sample: sample
  };
  g.MsgSummary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
