import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../js/classify.js');
const E = require('../js/export.js');

const mail = (o) => ({ key: o.key || Math.random().toString(), subject: '', bodyText: '', from: { name: '', email: '' }, to: [], cc: [], attachments: [], ...o });
const d = C.defaults();
const name = (axis, m, manualId) => {
  const r = C.classify(m, d.axes[axis].rules, manualId || null);
  return r.categoryId && d.axes[axis].categories.find((c) => c.id === r.categoryId).name;
};
const main = (m, man) => name('main', m, man);
const sub = (m, man) => name('sub', m, man);

test('主: 言い換え・表記揺れでも補修依頼になる', () => {
  assert.equal(main(mail({ subject: '本町SS 計量機の修理依頼' })), '補修依頼');
  assert.equal(main(mail({ subject: '【至急】補修 依頼の件' })), '補修依頼');
  assert.equal(main(mail({ subject: 'ﾎｼｭｳ', bodyText: '洗車機が故障しました' })), '補修依頼');
  assert.equal(main(mail({ subject: 'ご相談', xlsxText: '[依頼内容]\n看板 破損' })), '補修依頼');
});

test('主: パスワード通知は補修より先に対象外になる', () => {
  assert.equal(main(mail({ subject: 'パスワード変更のお知らせ', bodyText: '修理依頼システムのパスワードを変更しました' })), '対象外（パスワード・自動通知）');
  assert.equal(main(mail({ subject: 'Your PASSWORD reset' })), '対象外（パスワード・自動通知）');
  assert.equal(main(mail({ subject: 'お知らせ', from: { name: 'system', email: 'no-reply@example.com' } })), '対象外（パスワード・自動通知）');
});

test('主: 業務の段階（見積・発注・完了・請求）を見分ける / 当たらなければ未分類', () => {
  assert.equal(main(mail({ subject: '御見積書送付（ノズル交換）' })), '見積');
  assert.equal(main(mail({ subject: '注文書送付の件（ノズル交換）' })), '発注');
  assert.equal(main(mail({ subject: '作業完了のご報告' })), '完了報告');
  assert.equal(main(mail({ subject: '11月分 ご請求書' })), '請求');
  assert.equal(main(mail({ subject: '忘年会のご案内' })), null);
});

const form = (o) => ({ checked: [], repair: '', status: '', burden: '', ...o });
// 補修依頼書の選択肢の文字は、チェックの有無にかかわらず xlsxText に全部入る
const FORM_TEXT = '[補修依頼書]\n依頼内容\n建物関係\t外構関係\t機器関係\t油面計\nサービス機器\tセルフ機器\t電気関係\tその他\n負担区分\tENEOS\t運営店\t調査次第';

test('副: 依頼内容のチェックで決める（語より優先）', () => {
  assert.equal(sub(mail({ subject: '照明の不灯', xlsxText: FORM_TEXT, form: form({ checked: ['外構関係'] }) })), '外構関係');
  assert.equal(sub(mail({ xlsxText: FORM_TEXT, form: form({ checked: ['その他'] }) })), 'その他');
});

test('副: チェックが無ければ件名・本文・補修内容・状況内容の語で推定する', () => {
  assert.equal(sub(mail({ subject: '駅前SS ノズル破損' })), 'サービス機器');
  assert.equal(sub(mail({ subject: '修理依頼', xlsxText: FORM_TEXT, form: form({ repair: '洗車機のブラシ交換' }) })), '機器関係');
  assert.equal(sub(mail({ subject: 'キャノピー灯の不灯' })), '電気関係');
  assert.equal(sub(mail({ subject: '地下タンク液面計の表示異常' })), '油面計');
  assert.equal(sub(mail({ subject: '防火壁のひび' })), '外構関係', '「壁」より先に外構の語を見る');
  assert.equal(sub(mail({ subject: '修理依頼', xlsxText: FORM_TEXT, form: form() })), null, 'チェックの無い選択肢の文字には当たらない');
  assert.equal(sub(mail({ subject: 'ご案内', from: { name: 'post', email: 'postmaster@x.jp' } })), null, '英字の短い語で誤検出しない');
});

test('ルールの対象: 補修依頼書の欄', () => {
  const m = mail({ form: form({ checked: ['建物関係', '電気関係'], repair: 'シャッター', status: '異音', burden: '運営店' }) });
  assert.equal(C.fieldValue(m, 'formChecked'), '建物関係\n電気関係');
  assert.equal(C.fieldValue(m, 'formDetail'), 'シャッター\n異音');
  assert.equal(C.fieldValue(m, 'burden'), '運営店');
  const multi = [{ id: 'x', categoryId: 'c-other', enabled: true, conditions: [{ field: 'formChecked', op: 'regex', value: '\\n' }] }];
  assert.equal(C.classify(m, multi, null).categoryId, 'c-other', '2 項目以上のチェックを正規表現で見分ける');
  assert.equal(C.classify(mail({ form: form({ checked: ['建物関係'] }) }), multi, null).categoryId, null);
  assert.equal(C.fieldValue(mail({}), 'formChecked'), '', '補修依頼書が無ければ空');
});

test('手で付けたカテゴリはルールより優先（軸ごと）', () => {
  const m = mail({ subject: 'パスワード ノズル' });
  assert.equal(main(m, 'c-repair'), '補修依頼');
  assert.equal(sub(m, 's-machine'), '機器関係');
});

test('移行: v2 は主を残し、副を依頼内容の 8 項目に置き換えて副の手直しを消す', () => {
  const v2 = C.defaults();
  v2.version = 2;
  v2.axes.main.categories.push({ id: 'c-mine', name: '自分で足した', color: '#000', exclude: false });
  v2.axes.sub = { categories: [{ id: 's-dispenser', name: '計量機', color: '#000', exclude: false }], rules: [] };
  v2.ssLabels = ['店名'];
  const r = C.migrate(v2, { k1: { main: 'c-mine', sub: 's-dispenser', ss: '本町SS' }, k2: { sub: 's-dispenser' } });
  assert.equal(r.migrated, true);
  assert.equal(r.settings.version, 3);
  assert.ok(r.settings.axes.main.categories.find((c) => c.id === 'c-mine'), '主はそのまま');
  assert.deepEqual(r.settings.axes.sub.categories.map((c) => c.name), ['建物関係', '外構関係', '機器関係', '油面計', 'サービス機器', 'セルフ機器', '電気関係', 'その他']);
  assert.deepEqual(r.settings.ssLabels, ['店名']);
  assert.deepEqual(r.manual, { k1: { main: 'c-mine', ss: '本町SS' } });
  const again = C.migrate(r.settings, { k1: { sub: 's-bldg' } });
  assert.equal(again.migrated, false, 'v3 はそのまま');
  assert.deepEqual(again.manual, { k1: { sub: 's-bldg' } }, 'v3 の副の手直しは残す');
});

test('当てはまった語を返す', () => {
  const r = C.classify(mail({ subject: '計量機の修理' }), d.axes.main.rules, null);
  assert.deepEqual(r.hits, ['修理']);
});

test('複数条件は AND、添付あり、正規表現', () => {
  const rs = [{ id: 'x', categoryId: 'c-other', enabled: true, conditions: [
    { field: 'fromDomain', op: 'equals', value: 'eneos.example' },
    { field: 'hasAttachment', op: 'contains', value: 'yes' },
    { field: 'subject', op: 'regex', value: 'No\\.\\d+' }] }];
  const base = { from: { name: '', email: 'a@ENEOS.example' }, subject: '依頼 No.123', attachments: [{ name: 'a.xlsx' }] };
  assert.equal(C.classify(mail(base), rs, null).categoryId, 'c-other');
  assert.equal(C.classify(mail({ ...base, attachments: [] }), rs, null).categoryId, null);
  assert.equal(C.classify(mail({ ...base, attachments: [{ name: 'image001.png', hidden: true }] }), rs, null).categoryId, null);
});

test('移行: v1（1 軸）の設定と手直しを主カテゴリへ引き継ぐ', () => {
  const v1 = {
    version: 1,
    categories: [
      { id: 'c-exclude', name: '対象外（パスワード・自動通知）', color: '#888', exclude: true },
      { id: 'c-repair', name: '補修依頼', color: '#d00', exclude: false },
      { id: 'c-estimate', name: '見積・請求', color: '#00d', exclude: false },
      { id: 'c-done', name: '完了報告', color: '#0a0', exclude: false },
      { id: 'c-mine', name: '自分で足した', color: '#0d0', exclude: false }
    ],
    rules: [
      { id: 'r-estimate', categoryId: 'c-estimate', enabled: true, conditions: [{ field: 'subject', op: 'contains', value: '見積, 御見積, 請求, 精算' }] },
      { id: 'r-mine', categoryId: 'c-mine', enabled: true, conditions: [{ field: 'subject', op: 'contains', value: '独自' }] }
    ]
  };
  const r = C.migrate(v1, { k1: 'c-mine', k2: { main: 'c-repair' } });
  assert.equal(r.migrated, true);
  const cats = r.settings.axes.main.categories;
  assert.equal(cats.find((c) => c.id === 'c-estimate').name, '見積');
  assert.ok(cats.find((c) => c.id === 'c-mine'), '自分で足したカテゴリが残る');
  assert.deepEqual(cats.map((c) => c.name), ['対象外（パスワード・自動通知）', '補修依頼', '見積', '発注', '完了報告', '請求', '自分で足した'], '発注・請求を業務の流れの順に足す');
  const ids = r.settings.axes.main.rules.map((x) => x.id);
  assert.ok(ids.indexOf('r-invoice') < ids.indexOf('r-estimate'), '請求は見積より先に調べる');
  assert.equal(r.settings.axes.main.rules.find((x) => x.id === 'r-estimate').conditions[0].value, '見積, 御見積, お見積');
  assert.equal(r.settings.axes.sub.categories.length, 8);
  assert.deepEqual(r.manual, { k1: { main: 'c-mine' }, k2: { main: 'c-repair' } });

  const again = C.migrate(r.settings, r.manual);
  assert.equal(again.migrated, false, 'v3 はそのまま');
  assert.equal(C.migrate(undefined, undefined).settings.version, 3, '設定が無ければ初期設定');
});

test('CSV: 主・副・SS・添付PDF の列、BOM・数式の無害化・改行保持', () => {
  const m = mail({ subject: '=HYPERLINK("x")', bodyText: '1行目\r\n"2行目", カンマ', from: { name: '山田', email: 'y@x.jp' },
    to: [{ name: '佐藤', email: 's@x.jp' }], sentAt: '2025-04-01T00:00:00Z', attachments: [{ name: 'FAX.pdf' }, { name: 'a.xlsx' }] });
  const info = { main: () => '補修依頼', sub: () => '計量機', ss: () => '本町SS', by: () => '主: ルール' };
  const csv = E.toCsv([m], info);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const header = csv.slice(1).split('\r\n')[0];
  assert.match(header, /^"主カテゴリ","副カテゴリ","SS名","分類方法","依頼内容チェック","負担区分",/);
  assert.match(header, /"添付PDF"/);
  assert.match(csv, /"補修依頼","計量機","本町SS"/);
  assert.match(csv, /"FAX\.pdf"/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"1行目\r\n""2行目"", カンマ"/);
  const json = JSON.parse(E.toJson([m], info));
  assert.equal(json.mails[0].mainCategory, '補修依頼');
  assert.equal(json.mails[0].subCategory, '計量機');
  assert.equal(json.mails[0].ss, '本町SS');
  assert.equal(json.mails[0].repairForm, null);
  const withForm = E.toCsv([{ ...m, form: { checked: ['建物関係'], repair: '', status: '', burden: 'ENEOS' } }], { ...info, checked: (x) => x.form.checked.join('・'), burden: (x) => x.form.burden });
  assert.match(withForm, /"主: ルール","建物関係","ENEOS"/);
});

test('閲覧用 HTML はメール由来の文字列をエスケープする', () => {
  const info = { main: () => '補修依頼', sub: () => '<b>x</b>', ss: () => '', by: () => '' };
  const html = E.toHtml([mail({ subject: '<script>alert(1)</script>', bodyText: '<img src=x onerror=alert(1)>' })], info, ['補修依頼']);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;script&gt;/);
});
