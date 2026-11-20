import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../js/report.js');
const S = require('../js/summary.js');
const E = require('../js/export.js');

const evil = '<img src=x onerror=alert(1)>"&';
function data() {
  const al = S.allocate([{ key: 'a', count: 3 }, { key: 'b', count: 1 }], 4, 'prop');
  al.rows[0].name = evil; al.rows[1].name = 'B';
  return {
    title: '集計レポート', createdAt: '2026/11/20 10:00:00', conditions: ['検索語: ' + evil], total: 4,
    kpis: [{ label: '集計したメール', value: '4 件' }],
    main: { list: [{ name: evil, count: 3, share: 0.75, color: 'red;background:url(x)' }, { name: '見積', count: 1, share: 0.25, color: '#1971c2' }], total: 4 },
    sub: { list: [{ name: '計量機', count: 4, share: 1, color: '#d9480f' }], total: 4 },
    matrix: { rowNames: [evil, '見積'], colNames: ['計量機'], cells: [[3], [1]], rowTotal: [3, 1], colTotal: [4], total: 4 },
    alloc: { title: '配分', note: '', result: al },
    monthly: { series: [{ label: evil, color: '#d9480f' }], bars: [{ label: '25/01', values: [3] }, { label: '25/02', values: [1] }], cols: [evil], rows: [{ name: '2025年01月', counts: [3], total: 3 }] },
    ss: { cols: [evil], rows: [{ name: '本町SS', counts: [3], total: 3 }] }
  };
}

test('保存 HTML: スクリプトを含まず、名前を escape する', () => {
  const h = R.toHtml(data());
  assert.doesNotMatch(h, /<script/i);
  assert.doesNotMatch(h, /<img/i);
  assert.doesNotMatch(h, /url\(/, '不正な色は既定の配色に置き換わる');
  assert.doesNotMatch(h, /https?:\/\/(?!www\.w3\.org)/);
  assert.match(h, /default-src 'none'; style-src 'unsafe-inline'/);
  assert.match(h, /&lt;img src=x/);
  assert.match(h, /75\.0%/);
});

test('保存 HTML: 色に不正な値が来たら既定の配色に置き換える', () => {
  assert.equal(R.color(0, 'red;background:url(x)'), R.PALETTE[0]);
  assert.equal(R.color(1, '#1971c2'), '#1971c2');
});

test('「集計だけ」にはメール本文が入らず、「集計＋メール一覧」には入る', () => {
  const mail = { subject: '本町SS 計量機', bodyText: '本文ひみつ', attachments: [] };
  const info = { main: () => '補修依頼', sub: () => '計量機', ss: () => '本町SS', by: () => '' };
  const only = R.toHtml(data());
  assert.doesNotMatch(only, /本文ひみつ/);
  const both = R.toHtml(data(), { mails: { css: E.LIST_CSS_SCOPED, body: E.listBody([mail], info, ['補修依頼']) } });
  assert.match(both, /本文ひみつ/);
  assert.match(both, /<main class="mails">/);
});

test('グラフ: 積み上げ棒は棒の数だけ区分を描き、縦軸は 0 から', () => {
  const svg = R.stackedBars([{ label: 'A', color: '#111111' }, { label: 'B', color: '#222222' }], [{ label: '1', values: [2, 3] }, { label: '2', values: [0, 4] }]);
  assert.equal((svg.match(/<rect/g) || []).length, 3, '0 件の区分は描かない');
  assert.match(svg, />0<\/text>/);
  const hb = R.hbars([{ label: 'x', value: 0.5, text: '50.0%' }, { label: 'y', value: 0, text: '0.0%' }], { max: 1 });
  assert.equal((hb.match(/<rect/g) || []).length, 2);
});

test('主×副の表: 行内の割合は行ごとに 100%', () => {
  const h = R.matrixTable(data().matrix, 'row');
  assert.equal((h.match(/100\.0%/g) || []).length, 2, '各マス 100%');
  assert.match(h, /100%（n=3）/, '行の合計に件数を併記する');
  assert.match(h, /100%（n=1）/);
  assert.match(h, /見積 ※/, '母数の少ない行に印');
});

test('行内比: 0 件の行の合計は「—」', () => {
  const m = { rowNames: ['A', 'B'], colNames: ['x'], cells: [[2], [0]], rowTotal: [2, 0], colTotal: [2], total: 2 };
  assert.match(R.matrixTable(m, 'row'), /<td class="r tot">—<\/td>/);
});

test('縦軸: 最大 1〜2 件でも目盛りが重複しない', () => {
  for (const max of [1, 2, 3]) {
    const svg = R.stackedBars([{ label: 'A', color: '#111111' }], [{ label: '1', values: [max] }]);
    const ticks = [...svg.matchAll(/text-anchor="end" font-size="11" fill="#5b6270">(\d+)</g)].map((m) => m[1]);
    assert.equal(new Set(ticks).size, ticks.length, `max=${max}: ${ticks}`);
  }
});

test('文字色: 濃い背景は白、薄い背景は濃色。0.1% 未満は「<0.1%」', () => {
  assert.equal(R.textOn('#1f5fa8'), '#fff');
  assert.equal(R.textOn('#ffd43b'), '#1c1f24');
  assert.match(R.heatStyle(1, 10), /color:#1c1f24/);
  assert.match(R.heatStyle(10, 10), /color:#fff/);
  assert.equal(R.pct(0.0004), '<0.1%');
  assert.equal(R.pct(0), '0.0%');
});
