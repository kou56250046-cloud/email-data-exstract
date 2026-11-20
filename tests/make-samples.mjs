// 動作確認用の .msg を大量に作る。実物の代わり。
// 使い方: node tests/make-samples.mjs [件数=1000] [出力先=samples-gen]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { buildMsg } from './make-msg.mjs';
import { makeZip } from './zip.mjs';

const N = parseInt(process.argv[2] || '1000', 10);
const OUT = process.argv[3] || 'samples-gen';
mkdirSync(join(OUT, 'sub'), { recursive: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const SS = ['本町SS', '駅前SS', 'バイパス店', '中央SS', '北インターSS', '港南SS', 'セルフ東店', '湖畔SS'];
const PARTS = ['計量機', 'ノズル', '洗車機', '看板', 'キャノピー照明', 'POSレジ', '地下タンク液面計', 'エアコンプレッサー', '給油ホース', '防火壁'];
const ISSUE = ['破損', '故障', '不具合', '漏れ', '動作不良', '損傷', '異音', '表示異常'];
const REQ = ['補修依頼', '修理依頼', '修繕のお願い', '修理のご依頼', '補修の件', '点検・交換依頼', '至急対応のお願い'];
const SENDERS = [['○○石油 本町SS 店長', 'honmachi@marumaru-oil.example'], ['エリア管理 佐々木', 'sasaki@area.example.co.jp'],
  ['△△エネルギー 施設課', 'shisetsu@sankaku-energy.example'], ['駅前SS 山本', 'yamamoto@ekimae-ss.example']];

// 1x1 の PNG
function png(r, g, b) {
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const w = 64, h = 48;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r ^ x * 2; raw[o + 1] = g ^ y * 3; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// FAX を PDF にしたもの（中身はグレースケール画像 1 枚だけで、文字のデータは無い）
function faxPdf(seedByte) {
  const w = 200, h = 140;
  const raw = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = ((x * 7 + y * 13 + seedByte) % 97 < 6 || y % 20 === 0) ? 0 : 255;
  const img = deflateSync(raw);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    null, // 画像
    null  // 描画命令
  ];
  const content = Buffer.from('q 500 0 0 350 47 450 cm /Im1 Do Q');
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let len = parts[0].length;
  const push = (b) => { parts.push(b); len += b.length; };
  objs.forEach((o, i) => {
    offsets.push(len);
    if (i === 3) {
      push(Buffer.from(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`));
      push(img);
      push(Buffer.from('\nendstream\nendobj\n'));
    } else if (i === 4) {
      push(Buffer.from(`5 0 obj\n<< /Length ${content.length} >>\nstream\n`));
      push(content);
      push(Buffer.from('\nendstream\nendobj\n'));
    } else {
      push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`));
    }
  });
  const xref = len;
  push(Buffer.from('xref\n0 6\n0000000000 65535 f \n' + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'));
  return new Uint8Array(Buffer.concat(parts));
}

function xlsx(ss, part, issue, date) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const strs = ['補修依頼書', 'SS名', ss, '依頼日', '対象設備', part, '不具合内容', `${part}の${issue}。営業に支障あり。`, '希望納期', '至急', '担当者', '店長 田中'];
  const si = strs.map((s) => `<si><t>${esc(s)}</t></si>`).join('');
  const c = (r, col, i) => `<c r="${col}${r}" t="s"><v>${i}</v></c>`;
  const serial = Math.floor(Date.parse(date) / 86400000) + 25569;
  return makeZip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="依頼書" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${si}</sst>`,
    'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
      `<row r="1">${c(1, 'A', 0)}</row><row r="3">${c(3, 'A', 1)}${c(3, 'B', 2)}</row>` +
      `<row r="4">${c(4, 'A', 3)}<c r="B4" s="1"><v>${serial}</v></c></row>` +
      `<row r="5">${c(5, 'A', 4)}${c(5, 'B', 5)}</row><row r="6">${c(6, 'A', 6)}${c(6, 'B', 7)}</row>` +
      `<row r="7">${c(7, 'A', 8)}${c(7, 'B', 9)}</row><row r="8">${c(8, 'A', 10)}${c(8, 'B', 11)}</row>` +
      '</sheetData></worksheet>'
  });
}

const me = [{ name: '保守受付', email: 'uketsuke@maintenance.example.jp' }];
for (let i = 0; i < N; i++) {
  const date = new Date(Date.UTC(2024, 0, 1) + Math.floor(rnd() * 650) * 86400000 + Math.floor(rnd() * 86400000)).toISOString();
  const r = rnd();
  let spec;
  if (r < 0.12) {
    spec = { subject: pick(['【重要】パスワード変更のお知らせ', 'パスワード有効期限のお知らせ', 'ワンタイムパスワード通知', '[システム] ログイン確認', 'Password reset request']),
      fromName: 'システム管理', fromEmail: pick(['no-reply@portal.example.com', 'system@portal.example.com']),
      body: 'パスワードの有効期限が近づいています。\r\n下記 URL からパスワードを変更してください。\r\n※このメールは送信専用です。', to: me };
  } else if (r < 0.18) {
    const ss = pick(SS), part = pick(PARTS);
    spec = { subject: `御見積書送付の件（${ss} ${part}交換）`, fromName: '□□設備 営業部', fromEmail: 'eigyo@shikaku-setsubi.example',
      body: `お世話になっております。\r\n${ss}様 ${part}交換の御見積書を送付いたします。`, to: me,
      attachments: [{ name: `御見積書_${ss}.pdf`, data: faxPdf(i & 255), mime: 'application/pdf' }] };
  } else if (r < 0.21) {
    const ss = pick(SS), part = pick(PARTS);
    spec = { subject: `注文書送付の件（${ss} ${part}）`, fromName: 'エリア管理 佐々木', fromEmail: 'sasaki@area.example.co.jp',
      body: `${ss} ${part}の件、下記のとおり発注いたします。`, to: me,
      attachments: [{ name: `注文書_${ss}.pdf`, data: faxPdf((i * 3) & 255), mime: 'application/pdf' }] };
  } else if (r < 0.24) {
    const ss = pick(SS);
    spec = { subject: `${1 + (i % 12)}月分 ご請求書の送付（${ss}）`, fromName: '□□設備 経理', fromEmail: 'keiri@shikaku-setsubi.example',
      body: '今月分の請求書を送付いたします。ご査収ください。', to: me };
  } else if (r < 0.27) {
    const ss = pick(SS);
    spec = { subject: `【作業完了報告】${ss}`, fromName: '□□設備 工事課', fromEmail: 'koji@shikaku-setsubi.example', body: `${ss}の作業が完了しましたのでご報告します。`, to: me,
      attachments: [{ name: 'after.png', data: png(40, 160, 90), mime: 'image/png' }] };
  } else if (r < 0.30) {
    spec = { subject: pick(['忘年会のご案内', '年末年始の営業について', '安全大会の開催']), fromName: '総務', fromEmail: 'soumu@area.example.co.jp', body: '各位\r\nご確認ください。', to: me };
  } else {
    const ss = pick(SS), part = pick(PARTS), issue = pick(ISSUE), req = pick(REQ);
    const [fn, fe] = pick(SENDERS);
    const withX = rnd() < 0.6, withFax = !withX && rnd() < 0.6, withImg = rnd() < 0.5, html = rnd() < 0.5;
    const sr = rnd();
    // 一部は件名に SS 名を入れない（SS 名は xlsx から取る、または取れない）
    const subject = sr < 0.25 ? `${ss} ${req}` : sr < 0.5 ? `RE: ${ss} ${part}${issue}の${req}` : sr < 0.75 ? `【${req}】${ss}` : `${part}${issue}の${req}`;
    const body = sr >= 0.75 && withX
      ? `保守受付 ご担当者様\r\n\r\nいつもお世話になっております。\r\n詳細は添付の依頼書をご確認ください。\r\n\r\n${fn}`
      : `保守受付 ご担当者様\r\n\r\nいつもお世話になっております。\r\n${ss}の${part}に${issue}が発生しました。\r\n詳細は添付の依頼書をご確認ください。\r\n\r\n${fn}`;
    const atts = [];
    if (withX) atts.push({ name: `補修依頼書_${ss}_${i}.xlsx`, data: xlsx(ss, part, issue, date), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (withFax) atts.push({ name: `補修依頼書_FAX_${i}.pdf`, data: faxPdf(i & 255), mime: 'application/pdf' });
    if (withImg) atts.push({ name: `現場写真${i}.png`, data: png(200, 80, 40), mime: 'image/png' });
    if (html) atts.push({ name: 'image001.png', data: png(20, 60, 200), mime: 'image/png', contentId: 'image001@local' });
    spec = { subject, fromName: fn, fromEmail: fe, body, to: me, cc: rnd() < 0.3 ? [{ name: '施設課長', email: 'kacho@area.example.co.jp' }] : [],
      html: html ? `<html><head><meta charset="utf-8"></head><body><p>${body.replace(/\r\n/g, '<br>')}</p><p><img src="cid:image001@local"></p><p><img src="https://tracker.example.com/pixel.gif"></p></body></html>` : undefined,
      importance: rnd() < 0.1 ? 2 : 1, attachments: atts };
    if (html) atts[atts.length - 1].hidden = true;
  }
  spec.sentAt = date;
  spec.receivedAt = new Date(Date.parse(date) + 30000).toISOString();
  spec.messageId = `<${i}.${Date.parse(date)}@sample.example>`;
  const bytes = buildMsg(spec);
  writeFileSync(join(OUT, `mail_${String(i).padStart(4, '0')}.msg`), bytes);
  if (i === 0) writeFileSync(join(OUT, 'sub', 'mail_0000のコピー.msg'), bytes);
}
// 壊れたファイルも 1 つ混ぜる
writeFileSync(join(OUT, 'broken.msg'), 'これは壊れたファイルです');
console.log(`${N} 件を ${OUT}/ に書き出しました`);
