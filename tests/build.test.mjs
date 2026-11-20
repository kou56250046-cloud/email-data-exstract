import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('1 ファイル版 index.html: 外部参照なし・CSP ハッシュが全スクリプトと一致', () => {
  execFileSync(process.execPath, [join(root, 'build.mjs')]);
  // 改行が CRLF でもブラウザは LF にそろえて解析するので、同じ扱いで確かめる
  const html = readFileSync(join(root, 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
  assert.doesNotMatch(html, /<script\s+src=/);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, '外部 URL を含まない');

  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  const allowed = new Set([...csp.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]));

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const srcCount = (readFileSync(join(root, 'src/page.html'), 'utf8').match(/<script src=/g) || []).length;
  assert.equal(scripts.length, srcCount, 'src/page.html のスクリプトがすべて埋め込まれている');
  for (const code of scripts) {
    const h = createHash('sha256').update(code, 'utf8').digest('base64');
    assert.ok(allowed.has(h), 'CSP で許可されていないスクリプトがある');
  }
});
