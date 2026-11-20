/*
 * メールから項目を取り出す。今は SS（店舗）名だけ。
 * 1. 添付 xlsx の「SS名」などの見出しの隣のセル
 * 2. 件名・本文の「○○SS」「○○給油所」の形
 */
(function (g) {
  'use strict';

  /** SS 名の表記をそろえる: 全角半角・空白・前後の記号 */
  function normalizeSs(s) {
    s = (s || '');
    if (s.normalize) s = s.normalize('NFKC');
    return s.replace(/[\s　]+/g, '').replace(/^[【\[(（「『:：・-]+|[】\])）」』:：・-]+$/g, '').replace(/ss$/i, 'SS');
  }

  function labelKey(s) {
    s = s || '';
    if (s.normalize) s = s.normalize('NFKC');
    return s.replace(/[\s　:：]+/g, '').toLowerCase();
  }

  /** xlsxText（行ごとにセルをタブ区切り）から、見出しの右隣の値を取る */
  function fromXlsx(text, labels) {
    if (!text) return '';
    var keys = labels.map(labelKey).filter(Boolean);
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var cells = lines[i].split('\t');
      for (var c = 0; c < cells.length - 1; c++) {
        if (keys.indexOf(labelKey(cells[c])) < 0) continue;
        for (var n = c + 1; n < cells.length; n++) {
          var v = normalizeSs(cells[n]);
          if (v) return v;
        }
      }
    }
    return '';
  }

  // 漢字・カタカナ・英数字が続いた後に SS / 給油所 / サービスステーション。ひらがなは含めない（「の本町SS」を避ける）
  var SS_RE = /([一-鿿々゠-ヿｦ-ﾟA-Za-z0-9０-９Ａ-Ｚａ-ｚ・ー]{1,20}?)(SS|ＳＳ|給油所|サービスステーション)(?![A-Za-z])/;

  function fromText(s) {
    if (!s) return '';
    var m = SS_RE.exec(s.normalize ? s.normalize('NFKC') : s);
    if (!m) return '';
    var head = m[1].replace(/^(RE|FW|FWD)$/i, '');
    if (!head) return '';
    return normalizeSs(head + (m[2] === 'ＳＳ' ? 'SS' : m[2]));
  }

  /**
   * @param {object} mail subject, bodyText, xlsxText を持つ
   * @param {string[]} labels xlsx の見出し語
   * @returns {{name: string, by: 'xlsx'|'text'|null}}
   */
  function extractSs(mail, labels) {
    var x = fromXlsx(mail.xlsxText, labels || []);
    if (x) return { name: x, by: 'xlsx' };
    var t = fromText(mail.subject) || fromText((mail.bodyText || '').slice(0, 3000));
    if (t) return { name: t, by: 'text' };
    return { name: '', by: null };
  }

  var api = { extractSs: extractSs, normalizeSs: normalizeSs };
  g.MsgFields = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
