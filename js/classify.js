/*
 * カテゴリとルールによる自動分類。
 * ルールは上から順に評価し、最初に当てはまったカテゴリを付ける。手で付けたカテゴリはルールより優先する。
 */
(function (g) {
  'use strict';

  var FIELDS = {
    any: '件名・本文・送信者・添付xlsx',
    subject: '件名',
    body: '本文',
    from: '送信者（名前・アドレス）',
    fromDomain: '送信者ドメイン',
    to: '宛先（To/Cc）',
    attachmentName: '添付ファイル名',
    xlsx: '添付xlsxの内容',
    hasAttachment: '添付あり'
  };
  var OPS = {
    contains: 'を含む（, 区切りでいずれか）',
    notContains: 'を含まない',
    equals: 'と一致',
    regex: '正規表現'
  };

  /** 表記揺れをそろえる: 全角/半角 (NFKC)・大小文字・空白 */
  function norm(s) {
    s = s || '';
    if (s.normalize) s = s.normalize('NFKC');
    return s.toLowerCase().replace(/[\s　]+/g, '');
  }
  function lower(s) { return norm(s); }
  function addrText(list) {
    return (list || []).map(function (r) { return (r.name || '') + ' ' + (r.email || ''); }).join(' ');
  }

  function fieldValue(mail, field) {
    switch (field) {
      case 'subject': return mail.subject || '';
      case 'body': return mail.bodyText || '';
      case 'from': return (mail.from.name || '') + ' ' + (mail.from.email || '');
      case 'fromDomain': return (mail.from.email || '').split('@')[1] || '';
      case 'to': return addrText(mail.to) + ' ' + addrText(mail.cc);
      case 'attachmentName': return (mail.attachments || []).map(function (a) { return a.name; }).join(' ');
      case 'xlsx': return mail.xlsxText || '';
      case 'any': return (mail.subject || '') + '\n' + (mail.from.name || '') + ' ' + (mail.from.email || '') + '\n' + (mail.bodyText || '') + '\n' + (mail.xlsxText || '');
      default: return '';
    }
  }

  var reCache = {};
  /** 当てはまれば当てはまった語（または true）を、外れれば false を返す */
  function testCond(mail, c) {
    if (c.field === 'hasAttachment') {
      var has = (mail.attachments || []).some(function (a) { return !a.hidden; });
      return c.value === 'no' ? !has : has;
    }
    var v = fieldValue(mail, c.field);
    var val = c.value || '';
    if (c.op === 'regex') {
      var re = reCache[val];
      if (re === undefined) {
        try { re = new RegExp(val, 'i'); } catch (e) { re = null; }
        reCache[val] = re;
      }
      if (!re) return false;
      var rm = re.exec(v);
      return rm ? rm[0] : false;
    }
    // 正規化した値はメールごとに覚えておく（ルール編集のたびに全件を再評価するため）
    var cache = mail._norm || (mail._norm = {});
    var lv = cache[c.field];
    if (lv === undefined) lv = cache[c.field] = lower(v);
    var words = val.split(/[,、，]/).map(function (w) { return lower(w.trim()); }).filter(Boolean);
    if (!words.length) return false;
    var hit = null;
    for (var i = 0; i < words.length && hit == null; i++) {
      if (c.op === 'equals' ? lv === words[i] : lv.indexOf(words[i]) >= 0) hit = words[i];
    }
    if (c.op === 'notContains') return hit == null;
    return hit == null ? false : hit;
  }

  /** ルールのすべての条件を満たせば、当てはまった語の配列を返す。外れれば null */
  function matchRule(mail, rule) {
    if (!rule.enabled || !rule.conditions || !rule.conditions.length) return null;
    var hits = [];
    for (var i = 0; i < rule.conditions.length; i++) {
      var r = testCond(mail, rule.conditions[i]);
      if (r === false) return null;
      if (typeof r === 'string') hits.push(r);
    }
    return hits;
  }

  /**
   * 1 つの軸で分類する。manualId はその軸で手で付けたカテゴリ（無ければ null）
   * @returns {{categoryId: string|null, by: 'manual'|'rule'|null, ruleId: string|null, hits: string[]}}
   */
  function classify(mail, rules, manualId) {
    if (manualId) return { categoryId: manualId, by: 'manual', ruleId: null, hits: [] };
    for (var i = 0; i < rules.length; i++) {
      if (!rules[i].categoryId) continue;
      var hits = matchRule(mail, rules[i]);
      if (hits) return { categoryId: rules[i].categoryId, by: 'rule', ruleId: rules[i].id, hits: hits };
    }
    return { categoryId: null, by: null, ruleId: null, hits: [] };
  }

  var seq = 0;
  function newId(prefix) { return prefix + Date.now().toString(36) + (seq++).toString(36); }

  var AXES = { main: '主カテゴリ（業務の段階）', sub: '副カテゴリ（設備・工種）' };
  var SS_LABELS = ['SS名', '店舗名', '給油所名', '施設名', 'SS'];

  function rule(id, cat, field, value) {
    return { id: id, categoryId: cat, enabled: true, conditions: [{ field: field, op: 'contains', value: value }] };
  }

  // 「見積・請求」を分けた後の見積ルール（v1 の初期値と区別するため両方持つ）
  var V1_ESTIMATE = '見積, 御見積, 請求, 精算';

  /** 初期設定。主＝業務の段階、副＝設備・工種。ガソリンスタンドの補修依頼が中心 */
  function defaults() {
    var main = {
      categories: [
        { id: 'c-exclude', name: '対象外（パスワード・自動通知）', color: '#8a8f98', exclude: true },
        { id: 'c-repair', name: '補修依頼', color: '#d9480f', exclude: false },
        { id: 'c-estimate', name: '見積', color: '#1971c2', exclude: false },
        { id: 'c-order', name: '発注', color: '#0c8599', exclude: false },
        { id: 'c-done', name: '完了報告', color: '#2f9e44', exclude: false },
        { id: 'c-invoice', name: '請求', color: '#e67700', exclude: false },
        { id: 'c-other', name: 'その他', color: '#7048e8', exclude: false }
      ],
      rules: [
        rule('r-pw', 'c-exclude', 'subject', 'パスワード, password, 認証コード, ワンタイム, ログイン, サインイン, 確認コード, verification, アカウント'),
        rule('r-noreply', 'c-exclude', 'from', 'noreply, no-reply, donotreply, mailer-daemon, postmaster'),
        rule('r-invoice', 'c-invoice', 'subject', '請求, 精算, 支払'),
        rule('r-order', 'c-order', 'subject', '発注, 注文, 注文書, 発注書'),
        rule('r-estimate', 'c-estimate', 'subject', '見積, 御見積, お見積'),
        rule('r-done', 'c-done', 'subject', '完了, 完工, 作業報告, 報告書'),
        rule('r-repair', 'c-repair', 'any', '補修, 修理, 修繕, 修復, 復旧, 故障, 不具合, 破損, 損傷, 異常, 不良, 点検, 交換, 取替, 取り替え, 漏れ, 漏洩, 調整, 直して, メンテ, 工事, 対応依頼, 依頼')
      ]
    };
    var subDefs = [
      ['s-dispenser', '計量機', '#d9480f', '計量機, 給油機, ノズル, 給油ホース, 表示器, 給油ポンプ'],
      ['s-carwash', '洗車機', '#1971c2', '洗車機, 洗車'],
      ['s-sign', '看板・照明', '#e67700', '看板, サイン, 照明, キャノピー, led照明, led灯, 蛍光灯, ポール'],
      ['s-elec', 'POS・電気', '#7048e8', 'pos端末, posレジ, レジ, 分電盤, ブレーカー, 配線, 電気, 漏電'],
      ['s-tank', 'タンク・配管', '#0c8599', 'タンク, 液面計, 配管, 漏洩, 油水分離, 地下'],
      ['s-air', '空調・コンプレッサー', '#2f9e44', 'エアコン, 空調, コンプレッサー, エアー'],
      ['s-building', '建物・舗装', '#5c940d', '防火壁, 舗装, 屋根, 外壁, トイレ, 排水, 建物, 事務所, シャッター'],
      ['s-other', 'その他設備', '#8a8f98', '']
    ];
    var sub = { categories: [], rules: [] };
    subDefs.forEach(function (d) {
      sub.categories.push({ id: d[0], name: d[1], color: d[2], exclude: false });
      if (d[3]) sub.rules.push(rule('r' + d[0], d[0], 'any', d[3]));
    });
    return { version: 2, axes: { main: main, sub: sub }, ssLabels: SS_LABELS.slice() };
  }

  /**
   * 保存された設定を v2 にそろえる。v1（categories/rules が 1 軸、manual[key] = catId）を主カテゴリへ移す
   * @returns {{settings: object, manual: object, migrated: boolean}}
   */
  function migrate(settings, manual) {
    var d = defaults();
    var migrated = false;
    var out;
    if (settings && settings.axes && settings.axes.main) {
      out = settings;
      if (!out.axes.sub) out.axes.sub = d.axes.sub;
      if (!Array.isArray(out.ssLabels)) out.ssLabels = d.ssLabels;
      out.version = 2;
    } else if (settings && Array.isArray(settings.categories)) {
      migrated = true;
      var cats = settings.categories.map(function (c) {
        if (c.id === 'c-estimate' && c.name === '見積・請求') return Object.assign({}, c, { name: '見積' });
        return c;
      });
      var rules = (settings.rules || []).map(function (r) {
        if (r.id === 'r-estimate' && r.conditions && r.conditions.length === 1 && r.conditions[0].value === V1_ESTIMATE) {
          return Object.assign({}, r, { conditions: [Object.assign({}, r.conditions[0], { value: '見積, 御見積, お見積' })] });
        }
        return r;
      });
      // 初期設定のままの利用者には、新しく分けた「発注」「請求」も足す（見積ルールより前に置く）
      var has = function (id) { return cats.some(function (c) { return c.id === id; }); };
      var at = rules.findIndex(function (r) { return r.id === 'r-estimate'; });
      if (at < 0) at = rules.length;
      // カテゴリは業務の流れの順（発注は見積の後、請求は完了報告の後）に置く
      [['c-order', 'r-order', 'c-estimate'], ['c-invoice', 'r-invoice', 'c-done']].forEach(function (t) {
        if (has(t[0])) return;
        var dc = d.axes.main.categories.find(function (c) { return c.id === t[0]; });
        var dr = d.axes.main.rules.find(function (r) { return r.id === t[1]; });
        var after = cats.findIndex(function (c) { return c.id === t[2]; });
        cats.splice(after < 0 ? cats.length : after + 1, 0, dc);
        rules.splice(at, 0, dr);
      });
      out = { version: 2, axes: { main: { categories: cats, rules: rules }, sub: d.axes.sub }, ssLabels: d.ssLabels };
    } else {
      out = d;
    }
    var m2 = {};
    if (manual) {
      for (var k in manual) {
        var v = manual[k];
        if (typeof v === 'string') { m2[k] = { main: v }; migrated = true; }
        else if (v && typeof v === 'object') m2[k] = v;
      }
    }
    return { settings: out, manual: m2, migrated: migrated };
  }

  var api = {
    FIELDS: FIELDS, OPS: OPS, AXES: AXES, classify: classify, matchRule: matchRule,
    fieldValue: fieldValue, defaults: defaults, migrate: migrate, newId: newId, norm: norm
  };
  g.MsgClassify = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
