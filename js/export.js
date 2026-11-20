/*
 * 書き出し: CSV（Excel 向け）/ 閲覧用 HTML / JSON。
 * rows は app.js の一覧の要素。catName(mail) でカテゴリ名を引く。
 */
(function (g) {
  'use strict';

  var EXCEL_CELL_MAX = 32000; // Excel のセル上限 32767 文字に余裕を持たせる

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function addr(r) {
    if (r.name && r.email && r.name !== r.email) return r.name + ' <' + r.email + '>';
    return r.email || r.name || '';
  }
  function addrs(list) { return (list || []).map(addr).join('; '); }
  function attNames(m) {
    return (m.attachments || []).filter(function (a) { return !a.hidden; }).map(function (a) { return a.name; }).join('; ');
  }
  var IMP = { 0: '低', 1: '普通', 2: '高' };

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (s.length > EXCEL_CELL_MAX) s = s.slice(0, EXCEL_CELL_MAX) + '…(以下省略)';
    // 数式として解釈される先頭文字を無害化（CSV インジェクション対策）
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  var COLS = [
    ['カテゴリ', function (m, c) { return c(m); }],
    ['分類方法', function (m, c, b) { return b(m); }],
    ['送信日時', function (m) { return fmtDate(m.sentAt); }],
    ['受信日時', function (m) { return fmtDate(m.receivedAt); }],
    ['送信者名', function (m) { return m.from ? m.from.name : ''; }],
    ['送信者アドレス', function (m) { return m.from ? m.from.email : ''; }],
    ['To', function (m) { return addrs(m.to); }],
    ['Cc', function (m) { return addrs(m.cc); }],
    ['Bcc', function (m) { return addrs(m.bcc); }],
    ['件名', function (m) { return m.subject; }],
    ['本文', function (m) { return m.bodyText; }],
    ['添付ファイル名', attNames],
    ['添付xlsxの内容', function (m) { return m.xlsxText || ''; }],
    ['添付数', function (m) { return (m.attachments || []).filter(function (a) { return !a.hidden; }).length; }],
    ['重要度', function (m) { return IMP[m.importance] || ''; }],
    ['Message-ID', function (m) { return m.messageId; }],
    ['In-Reply-To', function (m) { return m.inReplyTo; }],
    ['元ファイル名', function (m) { return m.path || m.fileName; }],
    ['エラー', function (m) { return m.error || ''; }]
  ];

  function toCsv(rows, catName, byName) {
    var lines = [COLS.map(function (c) { return csvCell(c[0]); }).join(',')];
    rows.forEach(function (m) {
      lines.push(COLS.map(function (c) { return csvCell(c[1](m, catName, byName)); }).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function toJson(rows, catName) {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      count: rows.length,
      mails: rows.map(function (m) {
        return {
          category: catName(m), file: m.path || m.fileName, error: m.error || null,
          subject: m.subject, from: m.from, to: m.to, cc: m.cc, bcc: m.bcc,
          sentAt: m.sentAt, receivedAt: m.receivedAt, importance: m.importance,
          messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references,
          bodyText: m.bodyText,
          xlsxText: m.xlsxText || '',
          attachments: (m.attachments || []).map(function (a) {
            return { name: a.name, size: a.size, mime: a.mime, kind: a.kind, inline: !!a.hidden };
          })
        };
      })
    }, null, 2);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** カテゴリ別の目次つき 1 ファイル。本文はテキストで入れる（外部画像やスクリプトを持ち込まない） */
  function toHtml(rows, catName, catOrder) {
    var groups = {};
    rows.forEach(function (m) {
      var c = catName(m) || '未分類';
      (groups[c] = groups[c] || []).push(m);
    });
    var names = Object.keys(groups).sort(function (a, b) {
      var ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    var h = [];
    h.push('<!doctype html><html lang="ja"><head><meta charset="utf-8">');
    h.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">');
    h.push('<meta name="viewport" content="width=device-width,initial-scale=1"><title>メール一覧 ' + esc(fmtDate(new Date().toISOString())) + '</title>');
    h.push('<style>body{font-family:"Meiryo","Hiragino Sans",sans-serif;margin:0;color:#1c1f24;background:#f4f5f7;line-height:1.6}' +
      'main{max-width:960px;margin:auto;padding:16px}nav{background:#fff;padding:12px 16px;border-radius:8px}' +
      'nav li{margin:2px 0}h2{margin:32px 0 8px;padding:6px 10px;background:#1c1f24;color:#fff;border-radius:6px;font-size:18px}' +
      'article{background:#fff;border-radius:8px;padding:12px 16px;margin:10px 0;break-inside:avoid}' +
      'h3{margin:0 0 6px;font-size:16px}table{border-collapse:collapse;font-size:13px;width:100%}' +
      'th{text-align:left;color:#5b6270;width:7em;vertical-align:top;font-weight:normal}td{word-break:break-all}' +
      'pre{white-space:pre-wrap;word-break:break-word;font:inherit;font-size:14px;margin:8px 0 0;padding-top:8px;border-top:1px solid #e3e5e8}' +
      '.n{color:#5b6270;font-size:12px}@media print{body{background:#fff}article{border:1px solid #ccc}}</style></head><body><main>');
    h.push('<h1>メール一覧</h1><p class="n">' + rows.length + ' 件 / 書き出し ' + esc(fmtDate(new Date().toISOString())) + '</p>');
    h.push('<nav><ol>');
    names.forEach(function (n, i) { h.push('<li><a href="#g' + i + '">' + esc(n) + '</a>（' + groups[n].length + '件）</li>'); });
    h.push('</ol></nav>');
    names.forEach(function (n, i) {
      h.push('<h2 id="g' + i + '">' + esc(n) + '（' + groups[n].length + '件）</h2>');
      groups[n].forEach(function (m) {
        h.push('<article><h3>' + esc(m.subject || '（件名なし）') + '</h3><table>');
        var row = function (k, v) { if (v) h.push('<tr><th>' + k + '</th><td>' + esc(v) + '</td></tr>'); };
        row('送信者', m.from ? addr(m.from) : '');
        row('送信日時', fmtDate(m.sentAt));
        row('受信日時', fmtDate(m.receivedAt));
        row('To', addrs(m.to)); row('Cc', addrs(m.cc)); row('Bcc', addrs(m.bcc));
        row('添付', attNames(m));
        row('元ファイル', m.path || m.fileName);
        row('エラー', m.error);
        h.push('</table><pre>' + esc(m.bodyText || '') + '</pre>');
        if (m.xlsxText) h.push('<details><summary>添付 xlsx の内容</summary><pre>' + esc(m.xlsxText) + '</pre></details>');
        h.push('</article>');
      });
    });
    h.push('</main></body></html>');
    return h.join('\n');
  }

  var api = { toCsv: toCsv, toJson: toJson, toHtml: toHtml, fmtDate: fmtDate, addrs: addrs, addr: addr, esc: esc };
  g.MsgExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
