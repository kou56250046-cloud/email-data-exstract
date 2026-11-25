import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../js/summary.js');
const F = require('../js/fields.js');

const mainCats = [{ id: 'm1' }, { id: 'm2' }];
const subCats = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
const row = (main, sub, ss, date) => ({ cls: { main: { categoryId: main }, sub: { categoryId: sub } }, ss: { name: ss }, sentAt: date });

const rows = [
  row('m1', 's1', '本町SS', '2025-01-10T03:00:00Z'),
  row('m1', 's1', '本町SS', '2025-01-20T03:00:00Z'),
  row('m1', 's2', '駅前SS', '2025-03-05T03:00:00Z'),
  row('m2', null, '', '2025-03-06T03:00:00Z'),
  row(null, 's3', '駅前SS', null),
  row('gone', 's1', '本町SS', '2025-03-07T03:00:00Z') // 削除されたカテゴリ → 未分類に数える
];

test('主×副: 合計がメール件数と一致し、未分類の行・列がある', () => {
  const m = S.matrix(rows, mainCats, subCats);
  assert.deepEqual(m.rows, ['m1', 'm2', S.NONE]);
  assert.deepEqual(m.cols, ['s1', 's2', 's3', S.NONE]);
  assert.equal(m.cells.m1.s1, 2);
  assert.equal(m.cells.m2[S.NONE], 1);
  assert.equal(m.cells[S.NONE].s3, 1);
  assert.equal(m.cells[S.NONE].s1, 1);
  assert.equal(m.total, rows.length);
  const sumRows = Object.values(m.rowTotal).reduce((a, b) => a + b, 0);
  const sumCols = Object.values(m.colTotal).reduce((a, b) => a + b, 0);
  assert.equal(sumRows, rows.length);
  assert.equal(sumCols, rows.length);
  assert.equal(m.max, 2);
});

test('未分類が無ければ未分類の行・列を出さない', () => {
  const m = S.matrix([row('m1', 's1', '', '2025-01-01T00:00:00Z')], mainCats, subCats);
  assert.deepEqual(m.rows, ['m1', 'm2']);
  assert.deepEqual(m.cols, ['s1', 's2', 's3']);
});

test('月別: 間の月を 0 件で埋め、日付なしを最後に置く', () => {
  const r = S.monthly(rows, mainCats);
  assert.deepEqual(r.rows.map((x) => x.month), ['2025-01', '2025-02', '2025-03', '日付なし']);
  assert.equal(r.rows[0].counts.m1, 2);
  assert.equal(r.rows[1].total, 0);
  assert.equal(r.rows[2].total, 3);
  assert.equal(r.rows.reduce((a, x) => a + x.total, 0), rows.length);
});

test('SS 別: 件数の多い順、SS 不明は最後', () => {
  const r = S.bySs(rows, mainCats);
  assert.deepEqual(r.rows.map((x) => x.ss), ['本町SS', '駅前SS', S.NO_SS]);
  assert.equal(r.rows[0].total, 3);
  assert.equal(r.rows[0].counts.m1, 2);
  assert.equal(r.rows.reduce((a, x) => a + x.total, 0), rows.length);
});

test('集計表の CSV: BOM・引用・数式の無害化', () => {
  const csv = S.tableToCsv([['主 ＼ 副', '計量機'], ['=補修', 3]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.slice(1), '"主 ＼ 副","計量機"\r\n"\'=補修","3"\r\n');
});

test('SS 名: 添付 xlsx の見出しの隣を優先する', () => {
  const labels = ['SS名', '店舗名'];
  assert.deepEqual(F.extractSs({ subject: '駅前SS 修理', xlsxText: '[依頼書]\n補修依頼書\nSS名\t本町ＳＳ\n依頼日\t2025/04/01' }, labels), { name: '本町SS', by: 'xlsx' });
  assert.deepEqual(F.extractSs({ xlsxText: '店舗名：\t\tセルフ 東店' }, labels), { name: 'セルフ東店', by: 'xlsx' });
});

test('SS 名: 件名・本文の「○○SS」「○○給油所」から取る', () => {
  const ex = (o) => F.extractSs(o, ['SS名']).name;
  assert.equal(ex({ subject: 'RE: 港南SS ノズル破損の修理依頼' }), '港南SS');
  assert.equal(ex({ subject: '【補修依頼】駅前ＳＳ' }), '駅前SS');
  assert.equal(ex({ subject: 'ご依頼', bodyText: 'いつもお世話になっております。\n北インター給油所の看板が破損しました' }), '北インター給油所');
  assert.equal(ex({ subject: '○○石油 本町SS 店長' }), '本町SS');
  assert.equal(ex({ subject: '忘年会のご案内', bodyText: 'よろしく' }), '');
});

test('割合: 合計が 100% になり、未分類も数える', () => {
  const sh = S.shares(rows, mainCats, 'main');
  assert.deepEqual(sh.rows.map((r) => r.key), ['m1', 'm2', S.NONE]);
  assert.deepEqual(sh.rows.map((r) => r.count), [3, 1, 2]);
  assert.ok(Math.abs(sh.rows.reduce((a, r) => a + r.share, 0) - 1) < 1e-9);
  const ms = S.matrixShares(S.matrix(rows, mainCats, subCats));
  assert.equal(ms.all.m1.s1, 2 / 6);
  assert.equal(ms.row.m1.s1, 2 / 3);
});

const strata = [{ key: 'a', count: 700 }, { key: 'b', count: 250 }, { key: 'c', count: 45 }, { key: 'd', count: 5 }];
const sum = (al) => al.rows.reduce((a, r) => a + r.alloc, 0);

test('配分: 比例は合計が N になり、端数は最大剰余法', () => {
  const al = S.allocate(strata, 100, 'prop');
  assert.deepEqual(al.rows.map((r) => r.alloc), [70, 25, 5, 0]); // 4.5→5, 0.5→0（剰余が同じなら母数の多い方）
  assert.equal(sum(al), 100);
  assert.ok(al.notes.some((n) => n.includes('0 件の層')), '0 件の層を注記する');
  for (const n of [1, 7, 33, 99, 101, 999]) assert.equal(sum(S.allocate(strata, n, 'prop')), n);
});

test('配分: 均等と、比例＋最低件数', () => {
  assert.deepEqual(S.allocate(strata, 10, 'equal').rows.map((r) => r.alloc), [3, 3, 2, 2]);
  const al = S.allocate(strata, 100, 'min', 10);
  assert.equal(sum(al), 100);
  assert.ok(al.rows.every((r) => r.alloc >= 10));
  assert.equal(al.rows[3].short, 5, '母数 5 の層に 10 件配ると 5 件不足');
  // 最低件数 × 層数 が N を超えるときは最低件数を下げる
  const over = S.allocate(strata, 10, 'min', 5);
  assert.equal(sum(over), 10);
  assert.ok(over.notes.some((n) => n.includes('最低件数を 2 件')));
});

test('配分: 総件数が母数より多いと注記、0 件や空でも壊れない', () => {
  const al = S.allocate(strata, 2000, 'prop');
  assert.equal(sum(al), 2000);
  assert.ok(al.notes.some((n) => n.includes('集めきれません')));
  assert.equal(sum(S.allocate(strata, 0, 'min', 5)), 0);
  assert.deepEqual(S.allocate([], 10, 'prop').rows, []);
});

test('stratumKeyOf: 集計と同じく、一覧に無いカテゴリは未分類', () => {
  const m = row('gone', 's2');
  assert.equal(S.stratumKeyOf(m, 'main', mainCats, subCats), S.NONE);
  assert.equal(S.stratumKeyOf(m, 'sub', mainCats, subCats), 's2');
  assert.equal(S.stratumKeyOf(row('m1', null), 'cross', mainCats, subCats), 'm1|' + S.NONE);
});

test('sample: 件数は min(配分, 母数)・同じシードなら同じ・入力順に依存しない', () => {
  const mk = (p, n) => Array.from({ length: n }, (_, i) => ({ key: p + String(i).padStart(3, '0') }));
  const groups = { a: mk('a', 50), b: mk('b', 3) };
  const r1 = S.sample(groups, { a: 10, b: 5, c: 2 }, 42);
  assert.equal(r1.a.length, 10);
  assert.equal(r1.b.length, 3);
  assert.equal(r1.c.length, 0);
  assert.equal(new Set(r1.a.map((x) => x.key)).size, 10, '重複なし');
  const rev = { a: groups.a.slice().reverse(), b: groups.b.slice().reverse() };
  const r2 = S.sample(rev, { a: 10, b: 5, c: 2 }, 42);
  assert.deepEqual(r2.a.map((x) => x.key), r1.a.map((x) => x.key));
  const r3 = S.sample(groups, { a: 10 }, 43);
  assert.notDeepEqual(r3.a.map((x) => x.key), r1.a.map((x) => x.key));
  assert.equal(groups.a[0].key, 'a000', '入力を書き換えない');
});

test('負担区分別: 決まった順、無いものは最後、件数 0 の行は出さない', () => {
  const b = (main, burden) => ({ cls: { main: { categoryId: main }, sub: { categoryId: null } }, form: burden == null ? null : { burden } });
  const list = [b('m1', '運営店'), b('m2', '運営店'), b('m1', 'ENEOS'), b('m1', null), b('m2', '')];
  const r = S.byBurden(list, mainCats, (m) => (m.form && m.form.burden) || '', F.BURDENS);
  assert.deepEqual(r.rows.map((x) => [x.name, x.total]), [['ENEOS', 1], ['運営店', 2], [S.NO_BURDEN, 2]]);
  assert.equal(r.rows[1].counts.m2, 1);
  assert.equal(r.max, 2);
  assert.equal(r.total, 5);
});
