/*
 * 集計レポート: SVG のグラフと表を文字列で組み立て、保存用の 1 ファイル HTML を作る。
 * DOM に依存しない（Node でテストする）。保存する HTML にはスクリプトを入れない。
 */
(function (g) {
  'use strict';

  // 白地でコントラスト 3:1 以上の配色。カテゴリに色が無いときに使う
  var PALETTE = ['#1f5fa8', '#c2410c', '#2a7a3b', '#7b3fa0', '#9a6b00', '#0b7a7a', '#b0245a', '#5d4037'];
  var NONE_COLOR = '#9aa0a6';
  var SMALL_N = 10; // 行内比で「母数が少ない」として ※ を付ける件数
  var ACCENT = [31, 95, 168]; // 濃淡の色（#1f5fa8）

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pct(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v > 0 && v * 100 < 0.05) return '<0.1%'; // 0 件と見分けるため
    return (v * 100).toFixed(1) + '%';
  }
  function color(i, c) { return (c && /^#[0-9a-f]{3,8}$/i.test(c)) ? c : PALETTE[i % PALETTE.length]; }
  /** 部品に渡された色の検査（CSS の値として何でも入らないように） */
  function safe(c, i) { return color(i || 0, c); }

  /** 文字幅の見積もり（全角 1、半角 0.55） */
  function textW(s, size) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 0xff ? 1 : 0.55;
    return w * size;
  }
  function clip(s, maxW, size) {
    s = String(s);
    if (textW(s, size) <= maxW) return s;
    while (s.length > 1 && textW(s + '…', size) > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  /** 相対輝度（WCAG） */
  function lum(rgb) {
    var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function hexRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3 || h.length === 4) h = h.split('').map(function (x) { return x + x; }).join('');
    return [0, 2, 4].map(function (i) { return parseInt(h.slice(i, i + 2), 16); });
  }
  var INK = '#1c1f24';
  /** 背景の上で読める文字色（白と濃色のうちコントラストが高い方） */
  function textOn(bg) {
    var L = lum(typeof bg === 'string' ? hexRgb(bg) : bg);
    return 1.05 / (L + 0.05) >= (L + 0.05) / (lum(hexRgb(INK)) + 0.05) ? '#fff' : INK;
  }
  /** 濃淡の背景（v/max に応じて白→アクセント色）。画面と保存 HTML で同じ計算を使う */
  function heatStyle(v, max) {
    if (!v || !max) return '';
    var t = 0.08 + (v / max) * 0.8;
    var rgb = ACCENT.map(function (a) { return Math.round(255 + (a - 255) * t); });
    return 'background:rgb(' + rgb.join(',') + ');color:' + textOn(rgb) + ';';
  }

  function niceStep(max, n) {
    var raw = max / n;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  /**
   * 横棒（構成）。items: [{ label, value, text, color }]。text は棒の右に出す文字
   * 最大値ではなく 0〜1 の割合を value に渡すと、全体に占める長さになる
   */
  function hbars(items, opt) {
    opt = opt || {};
    var W = opt.width || 640, rowH = 24, labW = opt.labelWidth || 190, valW = 120, size = 12;
    var max = opt.max || items.reduce(function (a, it) { return Math.max(a, it.value); }, 0) || 1;
    var plotW = W - labW - valW;
    var H = items.length * rowH + 4;
    var s = ['<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(opt.title || '構成') + '" xmlns="http://www.w3.org/2000/svg">'];
    // 0 の基準線
    s.push('<line x1="' + labW + '" y1="0" x2="' + labW + '" y2="' + H + '" stroke="#adb5bd"/>');
    items.forEach(function (it, i) {
      var y = i * rowH + 2;
      var w = Math.max(it.value > 0 ? 1 : 0, Math.round((it.value / max) * plotW));
      s.push('<g><title>' + esc(it.label + ' ' + (it.text || '')) + '</title>');
      s.push('<text x="' + (labW - 6) + '" y="' + (y + 15) + '" text-anchor="end" font-size="' + size + '" fill="#1c1f24">' + esc(clip(it.label, labW - 10, size)) + '</text>');
      s.push('<rect x="' + labW + '" y="' + (y + 4) + '" width="' + w + '" height="' + (rowH - 8) + '" rx="2" fill="' + safe(it.color, i) + '"/>');
      s.push('<text x="' + (labW + w + 6) + '" y="' + (y + 15) + '" font-size="' + size + '" fill="#1c1f24">' + esc(it.text == null ? it.value : it.text) + '</text>');
      s.push('</g>');
    });
    s.push('</svg>');
    return s.join('');
  }

  /**
   * 積み上げ縦棒。series: [{ label, color }]（下から積む順）、bars: [{ label, values: [] }]
   * 凡例は別の HTML（legend）で隣に置く。並びは積み上げと同じく上から＝最後の系列から
   */
  function stackedBars(series, bars, opt) {
    opt = opt || {};
    var W = opt.width || 860, H = opt.height || 260, padL = 44, padB = 34, padT = 24, padR = 8;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var totals = bars.map(function (b) { return b.values.reduce(function (a, v) { return a + v; }, 0); });
    var max = Math.max.apply(null, totals.concat([1]));
    var step = Math.max(1, niceStep(max, 4)); // 件数の軸なので 0.5 刻みにしない
    var top = Math.ceil(max / step) * step;
    var y = function (v) { return padT + plotH - (v / top) * plotH; };
    var slot = plotW / Math.max(1, bars.length);
    var bw = Math.max(2, Math.min(40, slot * 0.7));
    var every = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plotW / 58)))); // ラベル（2024/03）の間引き
    var s = ['<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(opt.title || '推移') + '" xmlns="http://www.w3.org/2000/svg">'];
    s.push('<text x="' + (padL - 6) + '" y="' + (padT - 8) + '" text-anchor="end" font-size="11" fill="#5b6270">件</text>');
    for (var t = 0; t <= top + 1e-9; t += step) {
      var yy = Math.round(y(t)) + 0.5;
      s.push('<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="' + (t === 0 ? '#868e96' : '#e9ecef') + '"/>');
      s.push('<text x="' + (padL - 6) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="11" fill="#5b6270">' + Math.round(t) + '</text>');
    }
    bars.forEach(function (b, i) {
      var x = padL + slot * i + (slot - bw) / 2;
      var acc = 0;
      s.push('<g><title>' + esc(b.label + ' 計 ' + totals[i] + ' 件' + series.map(function (se, k) { return b.values[k] ? '\n' + se.label + ' ' + b.values[k] : ''; }).join('')) + '</title>');
      series.forEach(function (se, k) {
        var v = b.values[k];
        if (!v) return;
        var y1 = y(acc + v), y0 = y(acc);
        s.push('<rect x="' + x.toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, y0 - y1).toFixed(1) + '" fill="' + safe(se.color, k) + '" stroke="#fff" stroke-width="0.5"/>');
        if (y0 - y1 >= 14 && bw >= 18) s.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="' + ((y0 + y1) / 2 + 4).toFixed(1) + '" text-anchor="middle" font-size="10" fill="' + textOn(safe(se.color, k)) + '">' + v + '</text>');
        acc += v;
      });
      if (totals[i]) s.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y(totals[i]) - 4).toFixed(1) + '" text-anchor="middle" font-size="10" fill="#1c1f24">' + totals[i] + '</text>');
      if (i % every === 0) s.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - padB + 16) + '" text-anchor="middle" font-size="11" fill="#5b6270">' + esc(b.label) + '</text>');
      s.push('</g>');
    });
    s.push('</svg>');
    return s.join('');
  }

  /** 凡例（積み上げの上から順に並べる） */
  function legend(series) {
    var n = series.length;
    return '<ul class="legend">' + series.slice().reverse().map(function (se, j) {
      return '<li><span class="sw" style="background:' + safe(se.color, n - 1 - j) + '"></span>' + esc(se.label) + '</li>';
    }).join('') + '</ul>';
  }

  /**
   * 表。head: 文字列の配列。body: 行の配列、各セルは文字列か { v, cls, style, th }
   */
  function table(head, body, opt) {
    opt = opt || {};
    var cellHtml = function (c, tag) {
      if (c == null || typeof c !== 'object') c = { v: c };
      var t = c.th ? 'th' : tag;
      return '<' + t + (c.cls ? ' class="' + esc(c.cls) + '"' : '') + (c.style ? ' style="' + esc(c.style) + '"' : '') + '>' + esc(c.v == null ? '' : c.v) + '</' + t + '>';
    };
    var h = ['<table class="t' + (opt.cls ? ' ' + esc(opt.cls) : '') + '">'];
    if (head) h.push('<thead><tr>' + head.map(function (c) { return cellHtml(c, 'th'); }).join('') + '</tr></thead>');
    h.push('<tbody>' + body.map(function (r) { return '<tr>' + r.map(function (c) { return cellHtml(c, 'td'); }).join('') + '</tr>'; }).join('') + '</tbody></table>');
    return h.join('');
  }

  var CSS = 'body{font-family:"Meiryo","Hiragino Sans",sans-serif;margin:0;color:#1c1f24;background:#f4f5f7;line-height:1.6}' +
    'main{max-width:1100px;margin:auto;padding:16px}h1{font-size:22px;margin:8px 0}' +
    'section{background:#fff;border:1px solid #dee2e6;border-radius:8px;padding:12px 16px;margin:14px 0;break-inside:avoid}' +
    'h2{font-size:17px;margin:0 0 4px}.n{color:#5b6270;font-size:12.5px;margin:2px 0 8px}' +
    '.cond{margin:0;padding-left:1.2em;font-size:13px}.kpis{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}' +
    '.kpi{background:#fff;border:1px solid #dee2e6;border-radius:8px;padding:8px 14px;min-width:140px}.kpi b{display:block;font-size:22px}.kpi span{color:#5b6270;font-size:12px}' +
    '.wrap{overflow:auto}.chart{max-width:100%;height:auto;display:block}.cols{display:flex;flex-wrap:wrap;gap:16px}.cols>div{flex:1 1 420px;min-width:0}' +
    '.legend{list-style:none;padding:0;margin:6px 0;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px}.sw{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:4px;vertical-align:-1px}' +
    '.t{border-collapse:collapse;font-size:12.5px;min-width:100%;margin:6px 0}.t th,.t td{border:1px solid #dee2e6;padding:4px 7px}' +
    '.t thead th{background:#f1f3f5;color:#5b6270;font-weight:normal}.t .r{text-align:right;font-variant-numeric:tabular-nums}' +
    '.t .h{text-align:left;font-weight:normal;background:#fafbfc;white-space:nowrap}.t .tot{font-weight:bold;background:#f8f9fa}.t .warn{color:#c92a2a;font-weight:bold}' +
    '.note{color:#7a2e00;font-size:14px;margin:6px 0;padding:4px 10px;border-left:4px solid #c2410c;background:#fff4ec}' +
    '@media print{@page{size:A4 landscape;margin:10mm}body{background:#fff}main{max-width:none;padding:0}section{border-color:#bbb}.wrap{overflow:visible}}';

  function kpiHtml(list) {
    return '<div class="kpis">' + list.map(function (k) { return '<div class="kpi"><b>' + esc(k.value) + '</b><span>' + esc(k.label) + '</span></div>'; }).join('') + '</div>';
  }
  function sec(title, note, inner) {
    return '<section><h2>' + esc(title) + '</h2>' + (note ? '<p class="n">' + esc(note) + '</p>' : '') + inner + '</section>';
  }

  /** 割合の表＋横棒。list: [{ name, count, share, color }] */
  function sharesBlock(list, total, title) {
    var rows = list.map(function (r) { return [{ v: r.name, th: true, cls: 'h' }, { v: r.count, cls: 'r' }, { v: pct(r.share), cls: 'r' }]; });
    rows.push([{ v: '合計', th: true, cls: 'h tot' }, { v: total, cls: 'r tot' }, { v: total ? '100.0%' : '—', cls: 'r tot' }]);
    var chart = hbars(list.map(function (r) { return { label: r.name, value: r.share, text: pct(r.share) + '（' + r.count + '）', color: r.color }; }), { width: 560, title: title }); // 長さは最大の分類が基準（小さい分類も見えるように）
    return '<div class="cols"><div>' + table(['分類', '件数', '割合'], rows) + '</div><div class="wrap">' + chart + '</div></div>';
  }

  /**
   * 主×副の表。mode: 'count' | 'all' | 'row'。mx は MsgSummary.matrix の結果に名前を足したもの
   * mxv: { rowNames, colNames, cells[r][c], rowTotal[r], colTotal[c], total }（配列の添字で引く）
   */
  function matrixTable(mxv, mode) {
    var val = function (r, c) {
      var n = mxv.cells[r][c];
      if (mode === 'all') return mxv.total ? n / mxv.total : 0;
      if (mode === 'row') return mxv.rowTotal[r] ? n / mxv.rowTotal[r] : 0;
      return n;
    };
    var max = 0;
    mxv.rowNames.forEach(function (_, r) { mxv.colNames.forEach(function (_, c) { max = Math.max(max, val(r, c)); }); });
    var show = function (v) { return mode === 'count' ? (v || '·') : (v ? pct(v) : '·'); };
    var body = mxv.rowNames.map(function (name, r) {
      var tot = mode === 'count' ? mxv.rowTotal[r] : mode === 'all' ? pct(mxv.total ? mxv.rowTotal[r] / mxv.total : 0) : rowTotLabel(mxv.rowTotal[r]);
      var small = mode === 'row' && mxv.rowTotal[r] > 0 && mxv.rowTotal[r] < SMALL_N;
      return [{ v: small ? name + ' ※' : name, th: true, cls: 'h' }].concat(mxv.colNames.map(function (_, c) {
        var v = val(r, c);
        return { v: show(v), cls: 'r', style: heatStyle(v, max) };
      }), [{ v: tot, cls: 'r tot' }]);
    });
    if (mode !== 'row') {
      body.push([{ v: '合計', th: true, cls: 'h tot' }].concat(mxv.colNames.map(function (_, c) {
        return { v: mode === 'count' ? mxv.colTotal[c] : pct(mxv.total ? mxv.colTotal[c] / mxv.total : 0), cls: 'r tot' };
      }), [{ v: mode === 'count' ? mxv.total : '100.0%', cls: 'r tot' }]));
    }
    return table(['主 ＼ 副'].concat(mxv.colNames, ['合計']), body, { cls: 'matrix' });
  }

  /** 行内比の行の合計欄。件数を併記し、0 件の行は割合が無いので「—」 */
  function rowTotLabel(n) { return n ? '100%（n=' + n + '）' : '—'; }

  /** 配分試算の表。al: MsgSummary.allocate の結果に name を足したもの */
  function allocTable(al) {
    var body = al.rows.map(function (r) {
      return [{ v: r.name, th: true, cls: 'h' }, { v: r.count, cls: 'r' }, { v: pct(r.share), cls: 'r' },
        { v: r.alloc, cls: 'r' }, { v: pct(r.allocShare), cls: 'r' }, { v: r.short ? r.short : '', cls: 'r' + (r.short ? ' warn' : '') }];
    });
    var sumShort = al.rows.reduce(function (a, r) { return a + r.short; }, 0);
    body.push([{ v: '合計', th: true, cls: 'h tot' }, { v: al.population, cls: 'r tot' }, { v: al.population ? '100.0%' : '—', cls: 'r tot' },
      { v: al.n, cls: 'r tot' }, { v: al.n ? '100.0%' : '—', cls: 'r tot' }, { v: sumShort || '', cls: 'r tot' + (sumShort ? ' warn' : '') }]);
    return table(['層', '母数', '母集団の割合', '配分件数', '配分の割合', '不足（母数が足りず集められない件数）'], body);
  }

  function countTable(firstHead, cols, rows) {
    // rows: [{ name, counts: [], total }]
    var body = rows.map(function (r) {
      return [{ v: r.name, th: true, cls: 'h' }].concat(r.counts.map(function (n) { return { v: n || '·', cls: 'r' }; }), [{ v: r.total, cls: 'r tot' }]);
    });
    return table([firstHead].concat(cols, ['合計']), body);
  }

  /**
   * 保存用 HTML。
   * d: {
   *   title, createdAt, conditions: [文], total,
   *   kpis: [{ label, value }],
   *   main: { list: [{ name, count, share, color }], total }, sub: { ... },
   *   matrix: mxv,
   *   alloc: { title, note, result }（result は allocTable に渡す形）|| null,
   *   monthly: { series: [{ label, color }], bars: [{ label, values }], cols: [名前], rows: [{ name, counts, total }] },
   *   ss: { cols, rows }
   * }
   * opt.mails: { css, body } を渡すと、メール一覧を後ろに付ける
   */
  function toHtml(d, opt) {
    opt = opt || {};
    var h = [];
    h.push('<!doctype html><html lang="ja"><head><meta charset="utf-8">');
    h.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">');
    h.push('<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(d.title) + '</title>');
    h.push('<style>' + CSS + (opt.mails ? opt.mails.css : '') + '</style></head><body><main>');
    h.push('<h1>' + esc(d.title) + '</h1><p class="n">作成 ' + esc(d.createdAt) + '</p>');
    h.push(sec('集計の条件', '', '<ul class="cond">' + d.conditions.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>'));
    if (d.kpis && d.kpis.length) h.push(kpiHtml(d.kpis));
    var barNote = '棒の長さは最も多い分類を基準にしています。割合は小数 1 桁に丸めているため、足して 100% にならないことがあります';
    h.push(sec('主カテゴリの割合', d.total + ' 件のうちの割合。' + barNote, sharesBlock(d.main.list, d.main.total, '主カテゴリの割合')));
    h.push(sec('副カテゴリの割合', d.total + ' 件のうちの割合。' + barNote, sharesBlock(d.sub.list, d.sub.total, '副カテゴリの割合')));
    // 目的（評価データの配分）を割合の直後に置く
    if (d.alloc) {
      h.push(sec(d.alloc.title, d.alloc.note,
        d.alloc.result.notes.map(function (n) { return '<p class="note">注意: ' + esc(n) + '</p>'; }).join('') + allocTable(d.alloc.result)));
    }
    h.push(sec('主カテゴリ × 副カテゴリ（全体に占める割合）', d.total + ' 件を 100% とした割合。濃いマスほど多い', '<div class="wrap">' + matrixTable(d.matrix, 'all') + '</div>'));
    h.push(sec('主カテゴリ × 副カテゴリ（主カテゴリの中の割合）', '行ごとに 100% とした割合。その段階のメールがどの設備に偏っているか。※ は母数 ' + SMALL_N + ' 件未満で、割合がぶれやすい行', '<div class="wrap">' + matrixTable(d.matrix, 'row') + '</div>'));
    h.push(sec('主カテゴリ × 副カテゴリ（件数）', '', '<div class="wrap">' + matrixTable(d.matrix, 'count') + '</div>'));
    if (d.monthly) {
      h.push(sec('月別の推移（主カテゴリ別）', 'メールの送信日（無ければ受信日）で数えています' + (d.monthly.note ? '。' + d.monthly.note : ''),
        legend(d.monthly.series) + '<div class="wrap">' + stackedBars(d.monthly.series, d.monthly.bars, { title: '月別の推移' }) + '</div>' +
        '<div class="wrap">' + countTable('月', d.monthly.cols, d.monthly.rows) + '</div>'));
    }
    if (d.ss) h.push(sec('SS 別（主カテゴリ別）', '', '<div class="wrap">' + countTable('SS', d.ss.cols, d.ss.rows) + '</div>'));
    h.push('</main>');
    if (opt.mails) h.push('<main class="mails">' + opt.mails.body + '</main>');
    h.push('</body></html>');
    return h.join('\n');
  }

  var api = {
    PALETTE: PALETTE, NONE_COLOR: NONE_COLOR, SMALL_N: SMALL_N, esc: esc, pct: pct, color: color, heatStyle: heatStyle, textOn: textOn, rowTotLabel: rowTotLabel,
    hbars: hbars, stackedBars: stackedBars, legend: legend, table: table, matrixTable: matrixTable, allocTable: allocTable, toHtml: toHtml
  };
  g.MsgReport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
