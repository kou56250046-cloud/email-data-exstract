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

  // ---------- 補修依頼書 ----------
  var BURDENS = ['ENEOS', '運営店', '調査次第'];
  var DETAIL_LABELS = { repair: '補修内容', status: '状況内容' };

  /** 見出しの比較用: 括弧・記号・空白を落とす */
  function headKey(s) { return labelKey(s).replace(/[【】\[\]()（）「」『』<>＜＞※*・]/g, ''); }
  function isHead(s, target) { var k = headKey(s); return k === target || (k.indexOf(target) === 0 && k.length <= target.length + 2); }
  function anyHead(s) {
    for (var k in DETAIL_LABELS) if (isHead(s, DETAIL_LABELS[k])) return true;
    return isHead(s, '依頼内容') || isHead(s, '負担区分');
  }

  /** 見出しの右隣、無ければ下の行（3 行まで）の値 */
  function valueNear(rows, r, c) {
    var row = rows[r];
    for (var n = c + 1; n < row.length; n++) {
      var v = (row[n] || '').trim();
      if (!v) continue;
      if (anyHead(v)) break;
      return v;
    }
    for (var d = 1; d <= 3 && r + d < rows.length; d++) {
      var below = rows[r + d] || [];
      var vs = [];
      for (var x = c; x < below.length; x++) { var t = (below[x] || '').trim(); if (t) vs.push(t); }
      if (vs.length && anyHead(vs[0])) break;
      if (vs.length) return vs.join(' ');
    }
    return '';
  }

  function findDetail(rows, target) {
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) if (row[c] && isHead(row[c], target)) return valueNear(rows, r, c);
    }
    return '';
  }

  function burdenOf(label) {
    var k = labelKey(label);
    for (var i = 0; i < BURDENS.length; i++) if (k.indexOf(labelKey(BURDENS[i])) >= 0) return BURDENS[i];
    return '';
  }

  // 取り出す値の上限（細工した xlsx で巨大な文字列を抱え込まないため）
  var MAX_LABEL = 100, MAX_DETAIL = 2000, MAX_CHECKED = 50;

  function sheetName(s) { var n = s.name || ''; return n.normalize ? n.normalize('NFKC') : n; }
  function isFormSheet(s) { return /補修依頼/.test(sheetName(s)); }
  // 記入例・見本のシートは、チェック済みの見本があるので読まない
  function isSampleSheet(s) { return /記入例|見本|サンプル|^例|[(（]例[)）]/.test(sheetName(s)); }

  /** シート 1 枚から補修依頼書の欄を取り出す */
  function formOfSheet(s) {
    var out = { checked: [], repair: '', status: '', burden: '' };
    (s.checks || []).forEach(function (ch) {
      if (!ch.checked || !ch.label) return;
      // 「建物 関係」「建物関係　」の揺れをそろえる（正規表現のルールは正規化せずに比べるため）
      var label = (ch.label.normalize ? ch.label.normalize('NFKC') : ch.label).replace(/[\s　]+/g, '').slice(0, MAX_LABEL);
      var b = burdenOf(label);
      if (b) { if (!out.burden) out.burden = b; }
      else if (label && out.checked.length < MAX_CHECKED && out.checked.indexOf(label) < 0) out.checked.push(label);
    });
    for (var k in DETAIL_LABELS) out[k] = findDetail(s.rows || [], DETAIL_LABELS[k]).slice(0, MAX_DETAIL);
    return out;
  }
  function isEmpty(f) { return !f.checked.length && !f.repair && !f.status && !f.burden; }

  /** 名前に「補修依頼」を含む（記入例・非表示でない）シートがあるか。添付が複数あるとき、どれを使うか決めるため */
  function hasFormSheet(sheets) {
    return (sheets || []).some(function (s) { return !s.hidden && !isSampleSheet(s) && isFormSheet(s); });
  }

  /**
   * xlsx の読み取り結果から補修依頼書の欄を取り出す。シートは 1 枚だけ使い、複数のシートを混ぜない。
   * 非表示・記入例のシートは外し、「補修依頼」を名前に含むシートを優先する。無ければ残りのシートを順に見る
   * @param {{name:string, rows:string[][], checks?:object[], hidden?:boolean}[]} sheets
   * @returns {{checked:string[], repair:string, status:string, burden:string}|null} 中身が何も無ければ null
   */
  function extractForm(sheets) {
    var list = (sheets || []).filter(function (s) { return !s.hidden && !isSampleSheet(s); });
    var named = list.filter(isFormSheet);
    var order = named.concat(list.filter(function (s) { return !isFormSheet(s); }));
    for (var i = 0; i < order.length; i++) {
      var f = formOfSheet(order[i]);
      if (!isEmpty(f)) return f;
    }
    return null;
  }

  var api = { extractSs: extractSs, normalizeSs: normalizeSs, extractForm: extractForm, hasFormSheet: hasFormSheet, BURDENS: BURDENS };
  g.MsgFields = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
