// テスト用 .msg の生成器。実物の .msg が機密で使えないため、MS-CFB / MS-OXMSG の仕様どおりに組み立てる。
// 依存ゼロ。export する buildMsg(spec) が Uint8Array を返す。

const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

// ---------- CFB 書き出し ----------

/** node: { name, children: [...] } か { name, data: Uint8Array } */
export function writeCfb(rootChildren) {
  const entries = [];
  const root = { name: 'Root Entry', type: 5, children: rootChildren };
  function cmp(a, b) {
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    const x = a.name.toUpperCase(), y = b.name.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function add(node) {
    const e = { node, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, start: ENDOFCHAIN, size: 0 };
    e.type = node.type || (node.children ? 1 : 2);
    const id = entries.length;
    entries.push(e);
    if (node.children && node.children.length) {
      const kids = [...node.children].sort(cmp);
      const ids = kids.map(add);
      // 兄弟は右リンクの一本鎖にする（大小順は守る。色はすべて黒）
      for (let i = 0; i < ids.length - 1; i++) entries[ids[i]].right = ids[i + 1];
      e.child = ids[0];
    }
    return id;
  }
  add(root);

  // ミニストリームと通常ストリームに振り分ける
  const miniChunks = [];
  let miniSectors = 0;
  const miniFat = [];
  const big = [];
  for (const e of entries) {
    if (e.type !== 2) continue;
    const d = e.node.data;
    e.size = d.length;
    if (d.length === 0) { e.start = ENDOFCHAIN; continue; }
    if (d.length < CUTOFF) {
      const n = Math.ceil(d.length / MINI);
      e.start = miniSectors;
      for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? ENDOFCHAIN : miniSectors + i + 1);
      const padded = new Uint8Array(n * MINI);
      padded.set(d);
      miniChunks.push(padded);
      miniSectors += n;
    } else {
      big.push(e);
    }
  }
  const miniStream = concat(miniChunks);
  entries[0].size = miniStream.length;

  const dirSecs = Math.ceil((entries.length * 128) / SECTOR);
  const miniFatSecs = Math.ceil((miniFat.length * 4) / SECTOR);
  const miniStreamSecs = Math.ceil(miniStream.length / SECTOR);
  const bigSecs = big.map((e) => Math.ceil(e.size / SECTOR));
  const dataSecs = dirSecs + miniFatSecs + miniStreamSecs + bigSecs.reduce((a, b) => a + b, 0);
  let fatSecs = 1;
  while (fatSecs * 128 < dataSecs + fatSecs) fatSecs++;
  if (fatSecs > 109) throw new Error('テスト生成器は 7MB 程度まで');
  const total = fatSecs + dataSecs;
  const fat = new Uint32Array(fatSecs * 128).fill(FREESECT);
  let cur = 0;
  for (let i = 0; i < fatSecs; i++) fat[cur++] = FATSECT;
  function alloc(n) {
    if (n === 0) return ENDOFCHAIN;
    const start = cur;
    for (let i = 0; i < n; i++) { fat[cur] = i === n - 1 ? ENDOFCHAIN : cur + 1; cur++; }
    return start;
  }
  const dirStart = alloc(dirSecs);
  const miniFatStart = alloc(miniFatSecs);
  entries[0].start = miniStreamSecs ? alloc(miniStreamSecs) : ENDOFCHAIN;
  big.forEach((e, i) => { e.start = alloc(bigSecs[i]); });

  const out = new Uint8Array(SECTOR * (total + 1));
  const dv = new DataView(out.buffer);
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((b, i) => { out[i] = b; });
  dv.setUint16(0x18, 0x3e, true);
  dv.setUint16(0x1a, 3, true);
  dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true);
  dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, fatSecs, true);
  dv.setUint32(0x30, dirStart, true);
  dv.setUint32(0x38, CUTOFF, true);
  dv.setUint32(0x3c, miniFatSecs ? miniFatStart : ENDOFCHAIN, true);
  dv.setUint32(0x40, miniFatSecs, true);
  dv.setUint32(0x44, ENDOFCHAIN, true);
  dv.setUint32(0x48, 0, true);
  for (let i = 0; i < 109; i++) dv.setUint32(0x4c + i * 4, i < fatSecs ? i : FREESECT, true);
  const so = (n) => (n + 1) * SECTOR;
  for (let i = 0; i < fat.length; i++) dv.setUint32(so(0) + i * 4, fat[i], true);
  // ディレクトリ
  const dirBuf = new Uint8Array(dirSecs * SECTOR);
  const ddv = new DataView(dirBuf.buffer);
  entries.forEach((e, i) => {
    const o = i * 128;
    const nm = e.node.name;
    for (let k = 0; k < nm.length; k++) ddv.setUint16(o + k * 2, nm.charCodeAt(k), true);
    ddv.setUint16(o + 0x40, (nm.length + 1) * 2, true);
    ddv.setUint8(o + 0x42, e.type);
    ddv.setUint8(o + 0x43, 1);
    ddv.setUint32(o + 0x44, e.left, true);
    ddv.setUint32(o + 0x48, e.right, true);
    ddv.setUint32(o + 0x4c, e.child, true);
    ddv.setUint32(o + 0x74, e.start, true);
    ddv.setUint32(o + 0x78, e.size, true);
  });
  for (let i = entries.length; i < dirSecs * 4; i++) {
    ddv.setUint32(i * 128 + 0x44, NOSTREAM, true);
    ddv.setUint32(i * 128 + 0x48, NOSTREAM, true);
    ddv.setUint32(i * 128 + 0x4c, NOSTREAM, true);
  }
  out.set(dirBuf, so(dirStart));
  if (miniFatSecs) {
    const mf = new Uint8Array(miniFatSecs * SECTOR);
    const mdv = new DataView(mf.buffer);
    for (let i = 0; i < miniFatSecs * 128; i++) mdv.setUint32(i * 4, i < miniFat.length ? miniFat[i] : FREESECT, true);
    out.set(mf, so(miniFatStart));
  }
  if (miniStreamSecs) out.set(miniStream, so(entries[0].start));
  for (const e of big) out.set(e.node.data, so(e.start));
  return out;
}

function concat(chunks) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------- MAPI ----------

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
const utf16 = (s) => {
  const b = new Uint8Array((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) & 255; b[i * 2 + 1] = s.charCodeAt(i) >> 8; }
  return b;
};
const ascii = (s) => { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };

function toFiletime(iso) {
  const t = BigInt(Date.parse(iso)) * 10000n + 116444736000000000n;
  return [Number(t & 0xffffffffn), Number(t >> 32n)];
}

/**
 * props: [{id, type:'str'|'str8'|'bin'|'int'|'time'|'bool', value}]
 * str8 の value は Uint8Array（任意の文字コードのバイト列）
 */
function propStorage(props, headerSize, header, extraChildren = []) {
  const children = [];
  const fixed = [];
  for (const p of props) {
    if (p.type === 'str') {
      const d = utf16(p.value);
      children.push({ name: `__substg1.0_${hex4(p.id)}001F`, data: d });
      fixed.push([0x001f, p.id, d.length, 0]);
    } else if (p.type === 'str8') {
      const d = p.value instanceof Uint8Array ? p.value : ascii(p.value);
      children.push({ name: `__substg1.0_${hex4(p.id)}001E`, data: d });
      fixed.push([0x001e, p.id, d.length, 0]);
    } else if (p.type === 'bin') {
      children.push({ name: `__substg1.0_${hex4(p.id)}0102`, data: p.value });
      fixed.push([0x0102, p.id, p.value.length, 0]);
    } else if (p.type === 'int') {
      fixed.push([0x0003, p.id, p.value >>> 0, 0]);
    } else if (p.type === 'bool') {
      fixed.push([0x000b, p.id, p.value ? 1 : 0, 0]);
    } else if (p.type === 'time') {
      const [lo, hi] = toFiletime(p.value);
      fixed.push([0x0040, p.id, lo, hi]);
    }
  }
  const ps = new Uint8Array(headerSize + fixed.length * 16);
  const dv = new DataView(ps.buffer);
  if (header) header(dv);
  fixed.forEach(([type, id, lo, hi], i) => {
    const o = headerSize + i * 16;
    dv.setUint16(o, type, true);
    dv.setUint16(o + 2, id, true);
    dv.setUint32(o + 4, 6, true);
    dv.setUint32(o + 8, lo, true);
    dv.setUint32(o + 12, hi, true);
  });
  children.push({ name: '__properties_version1.0', data: ps });
  return children.concat(extraChildren);
}

/** 非圧縮のまま LZFu 形式に包む（全バイトをリテラルで書き、最後に終端参照） */
export function compressRtfLiteral(rtfStr) {
  const raw = ascii(rtfStr).subarray(0, rtfStr.length);
  const PRE = 207;
  const body = [];
  let w = PRE;
  let i = 0;
  while (true) {
    const group = [];
    let ctrl = 0;
    let ended = false;
    for (let bit = 0; bit < 8; bit++) {
      if (i < raw.length) { group.push(raw[i++]); w = (w + 1) & 4095; }
      else { ctrl |= 1 << bit; group.push((w >> 4) & 255, (w & 15) << 4); ended = true; break; }
    }
    body.push(ctrl, ...group);
    if (ended) break;
  }
  const out = new Uint8Array(16 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length + 12, true);
  dv.setUint32(4, raw.length, true);
  dv.setUint32(8, 0x75465a4c, true);
  out.set(body, 16);
  return out;
}

/**
 * spec: {
 *   subject, fromName, fromEmail, sentAt, receivedAt, to:[{name,email}], cc, bcc,
 *   body, html (string | Uint8Array), rtf (string), messageId, inReplyTo, importance,
 *   ansi: {codepage, encode: (s)=>Uint8Array}  // 指定すると件名・本文を 001E で書く
 *   attachments: [{name, data, mime, contentId} | {name, message: spec}]
 * }
 */
function messageChildren(spec, embedded) {
  const props = [];
  const S = (id, v) => {
    if (v == null) return;
    if (spec.ansi) props.push({ id, type: 'str8', value: spec.ansi.encode(v) });
    else props.push({ id, type: 'str', value: v });
  };
  S(0x001a, 'IPM.Note');
  S(0x0037, spec.subject);
  S(0x0c1a, spec.fromName);
  if (spec.fromEmail) {
    S(0x0c1e, spec.fromExchange ? 'EX' : 'SMTP');
    S(0x0c1f, spec.fromExchange ? '/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=ABC123' : spec.fromEmail);
    if (spec.fromExchange) S(0x5d01, spec.fromEmail);
  }
  S(0x1000, spec.body);
  S(0x1035, spec.messageId);
  S(0x1042, spec.inReplyTo);
  S(0x007d, spec.headers);
  if (spec.html != null) props.push({ id: 0x1013, type: 'bin', value: typeof spec.html === 'string' ? new TextEncoder().encode(spec.html) : spec.html });
  if (spec.rtf != null) props.push({ id: 0x1009, type: 'bin', value: compressRtfLiteral(spec.rtf) });
  if (spec.sentAt) props.push({ id: 0x0039, type: 'time', value: spec.sentAt });
  if (spec.receivedAt) props.push({ id: 0x0e06, type: 'time', value: spec.receivedAt });
  if (spec.importance != null) props.push({ id: 0x0017, type: 'int', value: spec.importance });
  if (spec.ansi) props.push({ id: 0x3ffd, type: 'int', value: spec.ansi.codepage });
  if (spec.noRecipientStorage) {
    S(0x0e04, (spec.to || []).map((r) => r.name).join('; '));
  }

  const extra = [];
  const recips = spec.noRecipientStorage ? [] : [
    ...(spec.to || []).map((r) => [1, r]),
    ...(spec.cc || []).map((r) => [2, r]),
    ...(spec.bcc || []).map((r) => [3, r])
  ];
  recips.forEach(([type, r], i) => {
    extra.push({
      name: `__recip_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`,
      children: propStorage([
        { id: 0x0c15, type: 'int', value: type },
        { id: 0x3001, type: 'str', value: r.name },
        { id: 0x3002, type: 'str', value: 'SMTP' },
        { id: 0x3003, type: 'str', value: r.email },
        { id: 0x39fe, type: 'str', value: r.email }
      ], 8)
    });
  });
  const atts = spec.attachments || [];
  atts.forEach((a, i) => {
    const ap = [{ id: 0x3707, type: 'str', value: a.name }, { id: 0x3704, type: 'str', value: a.name.slice(0, 12) }];
    const sub = [];
    if (a.message) {
      ap.push({ id: 0x3705, type: 'int', value: 5 });
      sub.push({ name: '__substg1.0_3701000D', children: messageChildren(a.message, true) });
    } else {
      ap.push({ id: 0x3705, type: 'int', value: 1 });
      ap.push({ id: 0x3701, type: 'bin', value: a.data });
      if (a.mime) ap.push({ id: 0x370e, type: 'str', value: a.mime });
      if (a.contentId) ap.push({ id: 0x3712, type: 'str', value: a.contentId });
      if (a.hidden) ap.push({ id: 0x7ffe, type: 'bool', value: true });
    }
    extra.push({ name: `__attach_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`, children: propStorage(ap, 8, null, sub) });
  });
  if (!embedded) extra.push({ name: '__nameid_version1.0', children: [] });

  const headerSize = embedded ? 24 : 32;
  return propStorage(props, headerSize, (dv) => {
    dv.setUint32(8, recips.length, true);
    dv.setUint32(12, atts.length, true);
    dv.setUint32(16, recips.length, true);
    dv.setUint32(20, atts.length, true);
  }, extra);
}

export function buildMsg(spec) {
  return writeCfb(messageChildren(spec, false));
}
