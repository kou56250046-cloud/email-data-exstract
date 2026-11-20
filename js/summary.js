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

  function cell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  /** 2 次元配列 → CSV（UTF-8 BOM 付き、Excel 向け） */
  function tableToCsv(table) {
    return '﻿' + table.map(function (r) { return r.map(cell).join(','); }).join('\r\n') + '\r\n';
  }

  var api = { NONE: NONE, NO_SS: NO_SS, matrix: matrix, monthly: monthly, bySs: bySs, tableToCsv: tableToCsv, monthOf: monthOf };
  g.MsgSummary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
