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
