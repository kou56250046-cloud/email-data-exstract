import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeZip } from './zip.mjs';

const require = createRequire(import.meta.url);
const Xlsx = require('../js/xlsx.js');

export function sampleXlsx(compress = true) {
  return makeZip({
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="依頼内容" sheetId="1" r:id="rId1"/><sheet name="写真" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>SS名</t></si><si><t>○○石油 本町SS</t></si><si><r><t>計量機</t></r><r><t xml:space="preserve"> ノズル破損</t></r></si><si><t>依頼日</t><rPh><t>イライビ</t></rPh></si><si><t>A&amp;B</t></si></sst>',
    'xl/styles.xml': '<styleSheet><numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="176"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>45748</v></c><c r="C2" s="2"><v>45749</v></c></row>' +
      '<row r="4"><c r="A4" t="s"><v>2</v></c><c r="C4"><v>0.30000000000000004</v></c><c r="D4" t="inlineStr"><is><t>至急</t></is></c><c r="E4" t="s"><v>4</v></c></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>'
  }, compress);
}

for (const compress of [true, false]) {
  test(`xlsx を読む（${compress ? 'DEFLATE' : '無圧縮'}）`, async () => {
    const r = await Xlsx.read(sampleXlsx(compress));
    assert.deepEqual(r.sheets.map((s) => s.name), ['依頼内容', '写真']);
    const rows = r.sheets[0].rows;
    assert.deepEqual(rows[0], ['SS名', '○○石油 本町SS']);
    assert.deepEqual(rows[1], ['依頼日', '2025/04/01', '2025/04/02']);
    assert.deepEqual(rows[2], []);
    assert.deepEqual(rows[3], ['計量機 ノズル破損', '', '0.3', '至急', 'A&B']);
    assert.match(r.text, /本町SS/);
    assert.match(r.text, /ノズル破損/);
    assert.doesNotMatch(r.text, /イライビ/);
  });
}

test('xlsx 判定', () => {
  assert.equal(Xlsx.isXlsx({ name: '依頼書.XLSX' }), true);
  assert.equal(Xlsx.isXlsx({ name: 'a.xls' }), false);
});

// 補修依頼書の形: 依頼内容のチェックボックス（文字つき・文字なし）、補修内容・状況内容、負担区分
export function formXlsx() {
  const shape = (id, col, row, checked, text) =>
    `<v:shape id="_x0000_s${id}" type="#_x0000_t201"><v:textbox><div><font face="ＭＳ Ｐゴシック">${text}</font></div></v:textbox>` +
    `<x:ClientData ObjectType="Checkbox"><x:Anchor>\n ${col}, 2, ${row}, 1, ${col + 1}, 10, ${row}, 18</x:Anchor>${checked ? '<x:Checked>1</x:Checked>' : ''}<x:AutoFill>False</x:AutoFill></x:ClientData></v:shape>`;
  const vml = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
    '<v:shapetype id="_x0000_t201"/>' +
    shape(1025, 1, 2, true, '建物関係') +
    shape(1026, 3, 2, false, '外構関係') +
    shape(1027, 1, 3, false, '') + // 文字なし → C4 の「電気関係」。ctrlProps で Checked
    '<v:shape id="_x0000_s1028"><x:ClientData ObjectType="Note"><x:Anchor>1,0,0,0,2,0,1,0</x:Anchor></x:ClientData></v:shape>' +
    shape(1029, 1, 8, false, 'ENEOS') +
    shape(1030, 3, 8, true, '運営店') +
    '</xml>';
  const controls = '<mc:AlternateContent><mc:Choice Requires="x14"><controls>' +
    '<mc:AlternateContent><mc:Choice Requires="x14"><control shapeId="1027" r:id="rId3" name="Check Box 3"><controlPr><anchor><from><xdr:col>1</xdr:col><xdr:row>3</xdr:row></from></anchor></controlPr></control></mc:Choice>' +
    '<mc:Fallback><control shapeId="1027" r:id="rId3" name="Check Box 3"/></mc:Fallback></mc:AlternateContent>' +
    '</controls></mc:Choice></mc:AlternateContent>';
  const c = (ref, s) => `<c r="${ref}" t="inlineStr"><is><t>${s}</t></is></c>`;
  return makeZip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="補修依頼書" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
      `<row r="2">${c('A2', '依頼内容')}</row>` +
      `<row r="3">${c('C3', '建物関係')}${c('E3', '外構関係')}</row>` +
      `<row r="4">${c('C4', '電気関係')}</row>` +
      `<row r="5">${c('A5', '補修内容')}${c('B5', 'シャッターが閉まらない')}</row>` +
      `<row r="6">${c('A6', '【状況内容】')}</row>` +
      `<row r="7">${c('A7', '強風の後から異音がする')}</row>` +
      `<row r="9">${c('A9', '負担区分')}${c('C9', 'ENEOS')}${c('E9', '運営店')}</row>` +
      '</sheetData><legacyDrawing r:id="rId2"/>' + controls + '</worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="rId2" Target="../drawings/vmlDrawing1.vml"/><Relationship Id="rId3" Target="../ctrlProps/ctrlProp3.xml"/></Relationships>',
    'xl/drawings/vmlDrawing1.vml': vml,
    'xl/ctrlProps/ctrlProp3.xml': '<formControlPr xmlns="x14" objectType="CheckBox" checked="Checked" lockText="1"/>'
  });
}

test('フォームのチェックボックスを読む', async () => {
  const r = await Xlsx.read(formXlsx());
  const checks = r.sheets[0].checks;
  assert.deepEqual(checks.map((c) => [c.label, c.checked]), [
    ['建物関係', true], ['外構関係', false], ['電気関係', true], ['ENEOS', false], ['運営店', true]
  ]);
  assert.deepEqual([checks[0].row, checks[0].col], [2, 1]);
});

test('補修依頼書の欄を取り出す（チェック・補修内容・状況内容・負担区分）', async () => {
  const Fields = require('../js/fields.js');
  const r = await Xlsx.read(formXlsx());
  assert.deepEqual(Fields.extractForm(r.sheets), {
    checked: ['建物関係', '電気関係'], repair: 'シャッターが閉まらない', status: '強風の後から異音がする', burden: '運営店'
  });
  const plain = await Xlsx.read(sampleXlsx());
  assert.equal(Fields.extractForm(plain.sheets), null, '補修依頼書でなければ null');
  // 「補修依頼」を名前に含むシートがあれば、ほかのシートは見ない
  const two = [
    { name: '記入例', rows: [['補修内容', '例の文']], checks: [{ label: '油面計', checked: true }] },
    { name: '補修依頼書', rows: [['補修内容', '本当の文']], checks: [] }
  ];
  assert.deepEqual(Fields.extractForm(two), { checked: [], repair: '本当の文', status: '', burden: '' });
});

test('補修依頼書: シートは 1 枚だけ使い、記入例・非表示は外し、中身が空なら次を見る', () => {
  const Fields = require('../js/fields.js');
  const sheets = [
    { name: '補修依頼書（記入例）', rows: [['補修内容', '例の文']], checks: [{ label: '油面計', checked: true }] },
    { name: '雛形', hidden: true, rows: [], checks: [{ label: '外構関係', checked: true }] },
    { name: '補修依頼書', rows: [['補修内容', '本当の文']], checks: [{ label: '建物 関係', checked: true }] },
    { name: '補修依頼書(2)', rows: [], checks: [{ label: '電気関係', checked: true }] }
  ];
  assert.deepEqual(Fields.extractForm(sheets), { checked: ['建物関係'], repair: '本当の文', status: '', burden: '' }, '記入例・非表示・2 枚目を混ぜない');
  assert.equal(Fields.hasFormSheet(sheets), true);
  // 見積書の「税込」のようにチェックの無いチェックボックスだけなら、補修依頼書とみなさない
  assert.equal(Fields.extractForm([{ name: '見積書', rows: [], checks: [{ label: '税込', checked: false }] }]), null);
  assert.equal(Fields.hasFormSheet([{ name: '見積書', rows: [] }]), false);
  const long = Fields.extractForm([{ name: '補修依頼書', rows: [['補修内容', 'あ'.repeat(10000)]], checks: [] }]);
  assert.equal(long.repair.length, 2000, '長さの上限');
});

/** VML だけ差し替えた補修依頼書（シートの見出し・ctrlProps は formXlsx と同じ形） */
function vmlXlsx(vml, extra = {}) {
  return makeZip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="補修依頼書" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="3"><c r="C3" t="inlineStr"><is><t>建物関係</t></is></c></row></sheetData><legacyDrawing r:id="rId2"/>' + (extra.controls || '') + '</worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="rId2" Target="../drawings/vmlDrawing1.vml"/><Relationship Id="rId3" Target="../ctrlProps/ctrlProp1.xml"/><Relationship Id="rId4" Target="../ctrlProps/ctrlProp2.xml"/></Relationships>',
    'xl/drawings/vmlDrawing1.vml': vml,
    ...(extra.files || {})
  });
}
const cbShape = (attrs, inner) => `<v:shape ${attrs}>${inner}<x:ClientData ObjectType="Checkbox"><x:Anchor>1, 2, 2, 1, 2, 10, 2, 18</x:Anchor></x:ClientData></v:shape>`;

test('チェックボックス: 名前つきの id でも o:spid で ctrlProps と結ぶ。control の from に接頭辞が無くても位置を読む', async () => {
  const vml = '<xml>' + cbShape('id="Check_x0020_Box_x0020_1" o:spid="_x0000_s1025"', '') + '</xml>';
  const controls = '<controls><control shapeId="1025" r:id="rId3" name="Check Box 1"/>' +
    '<control shapeId="1026" r:id="rId4" name="Check Box 2"><controlPr><anchor><from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row></from></anchor></controlPr></control></controls>';
  const r = await Xlsx.read(vmlXlsx(vml, { controls, files: {
    'xl/ctrlProps/ctrlProp1.xml': '<formControlPr objectType="CheckBox" checked="Checked"/>',
    'xl/ctrlProps/ctrlProp2.xml': '<formControlPr objectType="CheckBox"/>'
  } }));
  assert.deepEqual(r.sheets[0].checks.map((c) => [c.label, c.checked, c.row, c.col]), [['建物関係', true, 2, 1], ['建物関係', false, 2, 1]]);
});

test('チェックボックス: 範囲外の数値参照や壊れた ctrlProp があっても他を読む', async () => {
  const vml = '<xml>' + cbShape('id="_x0000_s1025"', '<v:textbox><div>電気&#x110000;関係</div></v:textbox>') + '<x:Checked>1</x:Checked></xml>';
  const vml2 = vml.replace('</x:Anchor>', '</x:Anchor><x:Checked>1</x:Checked>');
  const controls = '<controls><control shapeId="1025" r:id="rId3"/></controls>';
  // rId3 の ctrlProp は上限（64KB）を超えて読み取りに失敗する
  const r = await Xlsx.read(vmlXlsx(vml2, { controls, files: { 'xl/ctrlProps/ctrlProp1.xml': '<formControlPr objectType="CheckBox"/>' + ' '.repeat(100 * 1024) } }));
  assert.deepEqual(r.sheets[0].checks.map((c) => [c.label, c.checked]), [['電気�関係', true]]);
});

test('チェックボックス: 細工した VML・シートでも固まらない', async () => {
  const t = Date.now();
  // 閉じない v:shape の山、閉じない引用符の長い数字の id、> の無い < の山
  const bad = '<xml>' + '<v:shape id="1">'.repeat(20000) + '<v:shape id="' + '1'.repeat(200000) + '>' +
    '<x:ClientData ObjectType="Checkbox"></x:ClientData></v:shape>' + cbShape('id="_x0000_s9"', '<v:textbox>' + '<'.repeat(200000) + '</v:textbox>') + '</xml>';
  const controls = '<controls>' + '<control shapeId="7" r:id="rId3"/>'.repeat(50000) + '</controls>';
  const r = await Xlsx.read(vmlXlsx(bad, { controls, files: { 'xl/ctrlProps/ctrlProp1.xml': '<formControlPr objectType="CheckBox"/>' } }));
  assert.ok(Date.now() - t < 3000, `時間がかかりすぎ: ${Date.now() - t}ms`);
  assert.ok(r.sheets[0].checks.length <= 500);
});

test('チェックボックス: VML が大きすぎれば読まない', async () => {
  const big = '<xml>' + cbShape('id="_x0000_s1025"', '') + ' '.repeat(5 * 1024 * 1024) + '</xml>';
  const r = await Xlsx.read(vmlXlsx(big));
  assert.deepEqual(r.sheets[0].checks, []);
  assert.equal(r.sheets[0].rows[2][2], '建物関係', 'セルはそのまま読める');
});

test('チェックボックスの無い xlsx は checks が空', async () => {
  const r = await Xlsx.read(sampleXlsx());
  assert.deepEqual(r.sheets.map((s) => s.checks), [[], []]);
});
