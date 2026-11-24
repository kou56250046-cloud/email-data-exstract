import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { crc32 as zcrc } from 'node:zlib';

const require = createRequire(import.meta.url);
const Z = require('../js/zipw.js');
const Xlsx = require('../js/xlsx.js');

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

test('crc32: 既知の値と zlib に一致する', () => {
  assert.equal(Z.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const b = new Uint8Array(5000).map((_, i) => (i * 31) & 255);
  assert.equal(Z.crc32(b), zcrc(b));
  assert.equal(Z.crc32(new Uint8Array(0)), 0);
});

test('build: 日本語名・中身・CRC・UTF-8 フラグを読み戻せる', () => {
  const msg = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]);
  const z = Z.build([
    { name: '評価データ/依頼/給油機/001_ノズル破損.msg', data: msg, date: new Date(2025, 2, 5, 10, 20, 30) },
    { name: '評価データ/一覧.csv', data: '﻿"a","b"\r\n' }
  ]);
  const list = Xlsx.listZip(z);
  assert.deepEqual(Object.keys(list), ['評価データ/依頼/給油機/001_ノズル破損.msg', '評価データ/一覧.csv']);
  for (const [name, e] of Object.entries(list)) {
    assert.equal(e.method, 0);
    const lo = e.local;
    assert.equal(u32(z, lo), 0x04034b50);
    assert.equal(u16(z, lo + 6) & 0x0800, 0x0800, 'UTF-8 フラグ');
    const data = z.subarray(lo + 30 + u16(z, lo + 26), lo + 30 + u16(z, lo + 26) + e.csize);
    assert.equal(u32(z, lo + 14), zcrc(data), name + ' の CRC');
    if (name.endsWith('.msg')) assert.deepEqual([...data], [...msg]);
    else assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(data), '﻿"a","b"\r\n');
  }
  // DOS 日時: 2025/03/05 10:20:30
  const lo = list['評価データ/依頼/給油機/001_ノズル破損.msg'].local;
  assert.equal(u16(z, lo + 12), ((2025 - 1980) << 9) | (3 << 5) | 5);
  assert.equal(u16(z, lo + 10), (10 << 11) | (20 << 5) | 15);
});

test('build: 名前の重なりはエラー', () => {
  assert.throws(() => Z.build([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]), /重なって/);
});

test('safeName: Windows で使えない文字・末尾のドット・予約名・長さ', () => {
  assert.equal(Z.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(Z.safeName('名前. . '), '名前');
  assert.equal(Z.safeName('CON'), '_CON');
  assert.equal(Z.safeName(''), '_');
  const long = Z.safeName('あ'.repeat(100) + '.msg', 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('.msg'));
});
