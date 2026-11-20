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

  /** @returns {{categoryId: string|null, by: 'manual'|'rule'|null, ruleId: string|null, hits: string[]}} */
  function classify(mail, rules, manual) {
    var m = manual && manual[mail.key];
    if (m) return { categoryId: m, by: 'manual', ruleId: null, hits: [] };
    for (var i = 0; i < rules.length; i++) {
      if (!rules[i].categoryId) continue;
      var hits = matchRule(mail, rules[i]);
      if (hits) return { categoryId: rules[i].categoryId, by: 'rule', ruleId: rules[i].id, hits: hits };
    }
    return { categoryId: null, by: null, ruleId: null, hits: [] };
  }

  var seq = 0;
  function newId(prefix) { return prefix + Date.now().toString(36) + (seq++).toString(36); }

  /** 初期設定: ガソリンスタンドの補修依頼が中心、パスワード通知などは対象外 */
  function defaults() {
    var cats = [
      { id: 'c-exclude', name: '対象外（パスワード・自動通知）', color: '#8a8f98', exclude: true },
      { id: 'c-repair', name: '補修依頼', color: '#d9480f', exclude: false },
      { id: 'c-estimate', name: '見積・請求', color: '#1971c2', exclude: false },
      { id: 'c-done', name: '完了報告', color: '#2f9e44', exclude: false },
      { id: 'c-other', name: 'その他', color: '#7048e8', exclude: false }
    ];
    var rules = [
      { id: 'r-pw', categoryId: 'c-exclude', enabled: true, conditions: [
        { field: 'subject', op: 'contains', value: 'パスワード, password, 認証コード, ワンタイム, ログイン, サインイン, 確認コード, verification, アカウント' }] },
      { id: 'r-noreply', categoryId: 'c-exclude', enabled: true, conditions: [
        { field: 'from', op: 'contains', value: 'noreply, no-reply, donotreply, mailer-daemon, postmaster' }] },
      { id: 'r-estimate', categoryId: 'c-estimate', enabled: true, conditions: [
        { field: 'subject', op: 'contains', value: '見積, 御見積, 請求, 精算' }] },
      { id: 'r-done', categoryId: 'c-done', enabled: true, conditions: [
        { field: 'subject', op: 'contains', value: '完了, 完工, 作業報告, 報告書' }] },
      { id: 'r-repair', categoryId: 'c-repair', enabled: true, conditions: [
        { field: 'any', op: 'contains', value: '補修, 修理, 修繕, 修復, 復旧, 故障, 不具合, 破損, 損傷, 異常, 不良, 点検, 交換, 取替, 取り替え, 漏れ, 漏洩, 調整, 直して, メンテ, 工事, 対応依頼, 依頼' }] }
    ];
    return { categories: cats, rules: rules };
  }

  var api = {
    FIELDS: FIELDS, OPS: OPS, classify: classify, matchRule: matchRule,
    fieldValue: fieldValue, defaults: defaults, newId: newId, norm: norm
  };
  g.MsgClassify = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
