/*
 * 画面。読み込み → 一覧 → 詳細 → 分類 → 書き出し。
 * メールの実体（本文の HTML・添付）は保持せず、詳細を開くたびに元ファイルを読み直す。1000 件超でもメモリを抑えるため。
 */
(function () {
  'use strict';

  // 画面を書き換える前の HTML を控えておく（「このツールを保存」用）。
  // build.mjs で 1 ファイルにまとめた index.html のときだけ、これだけで動くファイルになる
  const STANDALONE = !document.querySelector('script[src], link[rel=stylesheet]');
  const PRISTINE = '<!doctype html>\n' + document.documentElement.outerHTML;

  const Msg = window.MsgParser, Cls = window.MsgClassify, Store = window.MsgStore, Exp = window.MsgExport, Xlsx = window.MsgXlsx;
  const Fields = window.MsgFields, Sum = window.MsgSummary;
  const NONE = Sum.NONE;
  const $ = (id) => document.getElementById(id);
  const PAGE = 100;
  const MAX_XLSX_TEXT = 50000;

  const state = {
    mails: [],
    settings: Cls.defaults(), // { axes: { main, sub }, ssLabels }
    manual: {},               // key -> { main?, sub?, ss? }
    filter: { cat: 'all', sub: '', ss: '', q: '', from: '', dateFrom: '', dateTo: '', att: '', hideExcl: false },
    mode: 'list',             // 'list' | 'summary'
    settingsTab: 'main',      // 'main' | 'sub' | 'ss'
    sumIncExcluded: false,
    sort: { key: 'date', dir: -1 },
    page: 0,
    selected: new Set(),
    view: [],
    current: null,
    loading: false
  };

  // ---------- 小物 ----------

  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style') e.setAttribute('style', v);
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k in e && typeof v !== 'string') e[k] = v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null || c === false) continue;
        e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      }
    }
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtDateShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function mailDate(m) { return m.sentAt || m.receivedAt || null; }

  /** 64bit 相当の FNV-1a（2 系統）。Message-ID が無いメールの同一判定に使う */
  function hashBytes(b) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ b.length;
    for (let i = 0; i < b.length; i++) {
      h1 = Math.imul(h1 ^ b[i], 16777619);
      h2 = Math.imul(h2 ^ b[i], 2246822519);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  const IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;
  function isImage(a) { return /^image\/(png|jpe?g|gif|bmp|webp)/i.test(a.mime || '') || IMAGE_RE.test(a.name || ''); }
  function mimeOf(a) {
    if (a.mime) return a.mime;
    const ext = (/\.([a-z0-9]+)$/i.exec(a.name || '') || [])[1];
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', pdf: 'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })[(ext || '').toLowerCase()] || 'application/octet-stream';
  }

  // ---------- 設定 ----------

  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      Store.set('settings', state.settings);
      Store.set('manual', state.manual);
    }, 300);
  }
  async function loadSettings() {
    const r = Cls.migrate(await Store.get('settings'), await Store.get('manual'));
    state.settings = r.settings;
    state.manual = r.manual;
    if (r.migrated) saveSettings(); // 1 軸の設定を主カテゴリへ移したので保存し直す
  }
  const axis = (a) => state.settings.axes[a];
  const catById = (id, a = 'main') => axis(a).categories.find((c) => c.id === id) || null;

  /** 手直しを 1 項目だけ変える。value が空なら消す */
  function setManual(key, field, value) {
    const cur = Object.assign({}, state.manual[key] || {});
    if (value) cur[field] = value; else delete cur[field];
    if (Object.keys(cur).length) state.manual[key] = cur; else delete state.manual[key];
  }

  // ---------- 読み込み ----------

  function summarize(m) {
    const flat = (list) => (list || []).map((a) => ({ name: a.name, size: a.size, mime: a.mime, kind: a.kind, hidden: a.hidden }));
    const inner = [];
    (function walk(msg, depth) {
      for (const a of msg.attachments) {
        if (a.message && depth < 4) { inner.push(a.message.subject || '', a.message.bodyText || ''); walk(a.message, depth + 1); }
      }
    })(m, 0);
    return {
      subject: m.subject, from: m.from, to: m.to, cc: m.cc, bcc: m.bcc,
      sentAt: m.sentAt, receivedAt: m.receivedAt, messageId: m.messageId, inReplyTo: m.inReplyTo,
      references: m.references, importance: m.importance, bodyText: m.bodyText, hasHtml: !!m.bodyHtml,
      attachments: flat(m.attachments), innerText: inner.join('\n')
    };
  }

  /** 添付（転送メールの中も含む）の xlsx をテキストにする */
  async function xlsxTextOf(m) {
    const parts = [];
    async function walk(msg, depth) {
      for (const a of msg.attachments) {
        if (a.message && depth < 4) await walk(a.message, depth + 1);
        else if (a.data && Xlsx.isXlsx(a)) {
          try { const r = await Xlsx.read(a.data); parts.push('《' + a.name + '》\n' + r.text); }
          catch (e) { parts.push('《' + a.name + '》（読み取れませんでした: ' + e.message + '）'); }
        }
      }
    }
    await walk(m, 0);
    const t = parts.join('\n');
    return t.length > MAX_XLSX_TEXT ? t.slice(0, MAX_XLSX_TEXT) + '…' : t;
  }

  async function parseFile(file, path, id) {
    const rec = { id, file, path, fileName: file.name, size: file.size, from: { name: '', email: '' }, to: [], cc: [], bcc: [], attachments: [], subject: '', bodyText: '' };
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      const m = Msg.parse(bytes);
      Object.assign(rec, summarize(m));
      rec.xlsxText = await xlsxTextOf(m);
      rec.key = m.messageId ? 'id:' + m.messageId.trim() : 'h:' + hashBytes(bytes);
    } catch (e) {
      rec.error = e && e.message ? e.message : String(e);
      rec.subject = file.name;
      rec.key = bytes ? 'h:' + hashBytes(bytes) : 'f:' + path + ':' + file.size;
    }
    return rec;
  }

  async function addFiles(items) {
    if (state.loading) return;
    const known = new Set(state.mails.map((m) => m.path + '|' + m.size + '|' + m.file.lastModified));
    const todo = items.filter((it) => /\.msg$/i.test(it.file.name) && !known.has(it.path + '|' + it.file.size + '|' + it.file.lastModified));
    const skipped = items.length - todo.length;
    if (!todo.length) {
      showProgress(`読み込む .msg がありません${skipped ? `（${skipped} 件は .msg 以外か読み込み済み）` : ''}`, 1, true);
      return;
    }
    state.loading = true;
    const t0 = performance.now();
    let nextId = state.mails.length ? Math.max(...state.mails.map((m) => m.id)) + 1 : 0;
    for (let i = 0; i < todo.length; i++) {
      state.mails.push(await parseFile(todo[i].file, todo[i].path, nextId++));
      if (i % 10 === 0) { showProgress(`読み込み中 ${i + 1} / ${todo.length}`, (i + 1) / todo.length); await tick(); }
    }
    const errors = state.mails.slice(-todo.length).filter((m) => m.error).length;
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    showProgress(`${todo.length} 件を読み込みました（${sec} 秒）${errors ? ` / 読めなかったファイル ${errors} 件` : ''}${skipped ? ` / 対象外・読み込み済み ${skipped} 件` : ''}`, 1, true);
    state.loading = false;
    reclassify();
    render();
  }

  let progressTimer = null;
  function showProgress(text, ratio, done) {
    const p = $('progress');
    p.hidden = false;
    p.classList.toggle('done', !!done);
    $('progressBar').style.width = Math.round(ratio * 100) + '%';
    $('progressText').textContent = text;
    clearTimeout(progressTimer);
    if (done) progressTimer = setTimeout(() => { p.hidden = true; }, 8000);
  }

  // フォルダのドロップ: webkitGetAsEntry で再帰的にたどる
  function readEntry(entry, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => { out.push({ file: f, path: entry.fullPath.replace(/^\//, '') }); resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const next = () => reader.readEntries(async (ents) => {
          if (!ents.length) { for (const e of all) await readEntry(e, out); resolve(); return; }
          all.push(...ents);
          next();
        }, () => resolve());
        next();
      } else resolve();
    });
  }

  // ---------- 分類 ----------

  const EMPTY_CLS = { categoryId: null, by: null, ruleId: null, hits: [] };

  function classifyAxis(m, a, manualId) {
    if (manualId && !catById(manualId, a)) manualId = null; // 消したカテゴリの手直しは無視する
    const r = m.error
      ? (manualId ? { categoryId: manualId, by: 'manual', ruleId: null, hits: [] } : EMPTY_CLS)
      : Cls.classify(m, axis(a).rules, manualId);
    return r.categoryId && !catById(r.categoryId, a) ? EMPTY_CLS : r;
  }

  function reclassify() {
    const keyCount = new Map();
    for (const m of state.mails) keyCount.set(m.key, (keyCount.get(m.key) || 0) + 1);
    for (const m of state.mails) {
      m.dup = keyCount.get(m.key) > 1;
      const man = state.manual[m.key] || {};
      m.cls = { main: classifyAxis(m, 'main', man.main), sub: classifyAxis(m, 'sub', man.sub) };
      if (man.ss) m.ss = { name: Fields.normalizeSs(man.ss), by: 'manual' };
      else {
        if (!m._ssAuto) m._ssAuto = m.error ? { name: '', by: null } : Fields.extractSs(m, state.settings.ssLabels);
        m.ss = m._ssAuto;
      }
    }
  }

  function catName(m, a = 'main') { const c = m.cls && catById(m.cls[a].categoryId, a); return c ? c.name : '未分類'; }
  function byName(m) {
    const one = (a, label) => {
      const c = m.cls[a];
      if (!c.by) return '';
      if (c.by === 'manual') return label + ': 手動';
      return label + ': ルール' + (c.hits && c.hits.length ? '（' + c.hits.join('・') + '）' : '');
    };
    return [one('main', '主'), one('sub', '副')].filter(Boolean).join(' / ');
  }
  const EXPORT_INFO = { main: (m) => catName(m, 'main'), sub: (m) => catName(m, 'sub'), ss: (m) => (m.ss && m.ss.name) || '', by: byName };

  // ---------- 絞り込み・並べ替え ----------

  function searchText(m) {
    if (m._search == null) {
      const a = (l) => (l || []).map((r) => r.name + ' ' + r.email).join(' ');
      m._search = Cls.norm([m.subject, m.from.name, m.from.email, a(m.to), a(m.cc), a(m.bcc), m.bodyText, m.innerText,
        m.attachments.map((x) => x.name).join(' '), m.xlsxText, m.path].join('\n'));
    }
    return m._search;
  }

  const hasPdf = (m) => m.attachments.some(Exp.isPdf);
  const hasXlsx = (m) => m.attachments.some(Xlsx.isXlsx);

  /** 絞り込み条件に合うメール（並べ替え前）。集計画面でも使う */
  function filteredMails(ignoreHideExcl) {
    const f = Object.assign({}, state.filter, ignoreHideExcl ? { hideExcl: false } : null);
    const q = Cls.norm(f.q).length ? f.q.split(/[\s　]+/).map(Cls.norm).filter(Boolean) : [];
    const fq = Cls.norm(f.from);
    const dFrom = f.dateFrom ? new Date(f.dateFrom + 'T00:00:00').getTime() : null;
    const dTo = f.dateTo ? new Date(f.dateTo + 'T23:59:59.999').getTime() : null;
    return state.mails.filter((m) => {
      if (f.cat === 'error') { if (!m.error) return false; }
      else if (f.cat === 'none') { if (m.cls.main.categoryId || m.error) return false; } // 読めなかったファイルは未分類に入れない
      else if (f.cat !== 'all' && m.cls.main.categoryId !== f.cat) return false;
      if (f.sub === NONE) { if (m.cls.sub.categoryId || m.error) return false; }
      else if (f.sub && m.cls.sub.categoryId !== f.sub) return false;
      if (f.ss) { if (((m.ss && m.ss.name) || Sum.NO_SS) !== f.ss) return false; }
      if (f.hideExcl && isExcluded(m)) return false;
      if (q.length) { const s = searchText(m); if (!q.every((w) => s.includes(w))) return false; }
      if (fq && !Cls.norm(m.from.name + ' ' + m.from.email).includes(fq)) return false;
      if (dFrom != null || dTo != null) {
        const d = mailDate(m);
        if (!d) return false;
        const t = Date.parse(d);
        if (dFrom != null && t < dFrom) return false;
        if (dTo != null && t > dTo) return false;
      }
      if (f.att === 'pdfonly') { if (!hasPdf(m) || hasXlsx(m)) return false; }
      else if (f.att === 'pdf') { if (!hasPdf(m)) return false; }
      else if (f.att) {
        const has = m.attachments.some((a) => !a.hidden);
        if ((f.att === 'yes') !== has) return false;
      }
      return true;
    });
  }

  function computeView() {
    const list = filteredMails();
    const { key, dir } = state.sort;
    const val = {
      date: (m) => mailDate(m) || '',
      from: (m) => (m.from.name || m.from.email || '').toLowerCase(),
      subject: (m) => (m.subject || '').replace(/^\s*((re|fw|fwd)\s*[:：]\s*)+/i, '').toLowerCase()
    }[key];
    list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : a.id - b.id) * dir; });
    state.view = list;
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (state.page >= pages) state.page = pages - 1;
  }

  // ---------- 描画 ----------

  function render() {
    computeView();
    renderCats();
    renderFilterOptions();
    const has = state.mails.length > 0;
    const sum = state.mode === 'summary';
    $('empty').hidden = has;
    $('tabList').classList.toggle('on', !sum);
    $('tabSummary').classList.toggle('on', sum);
    $('tabList').setAttribute('aria-selected', String(!sum));
    $('tabSummary').setAttribute('aria-selected', String(sum));
    $('tableWrap').hidden = !has || sum;
    $('summary').hidden = !has || !sum;
    if (sum) { $('bulk').hidden = true; renderSummary(); }
    else { renderList(); renderBulk(); }
  }

  /** 副カテゴリと SS の絞り込み欄の選択肢を作り直す */
  function renderFilterOptions() {
    const subSel = $('subQ');
    const keepSub = state.filter.sub;
    clear(subSel);
    subSel.appendChild(el('option', { value: '' }, '副カテゴリ: すべて'));
    for (const c of axis('sub').categories) subSel.appendChild(el('option', { value: c.id, selected: c.id === keepSub }, c.name));
    subSel.appendChild(el('option', { value: NONE, selected: keepSub === NONE }, '（未分類）'));

    const ssSel = $('ssQ');
    const keepSs = state.filter.ss;
    const counts = new Map();
    for (const m of state.mails) { const n = (m.ss && m.ss.name) || Sum.NO_SS; counts.set(n, (counts.get(n) || 0) + 1); }
    const names = [...counts.keys()].sort((a, b) => (a === Sum.NO_SS) - (b === Sum.NO_SS) || counts.get(b) - counts.get(a) || (a < b ? -1 : 1));
    clear(ssSel);
    ssSel.appendChild(el('option', { value: '' }, 'SS: すべて'));
    if (keepSs && !counts.has(keepSs)) names.unshift(keepSs);
    for (const n of names) ssSel.appendChild(el('option', { value: n, selected: n === keepSs }, `${n}（${counts.get(n) || 0}）`));
  }

  function catChip(c, by, small) {
    if (!c) return el('span', { class: 'chip none' + (small ? ' sub' : ''), text: '未分類' });
    return el('span', { class: 'chip' + (small ? ' sub' : ''), style: `--c:${c.color}`, title: by === 'manual' ? '手で付けたカテゴリ' : 'ルールで付いたカテゴリ' },
      [el('i'), c.name, by === 'manual' ? el('b', { class: 'manual', text: '手' }) : null]);
  }

  function renderCats() {
    const ul = $('catList');
    clear(ul);
    const counts = new Map();
    let none = 0, err = 0;
    for (const m of state.mails) {
      if (m.error) err++;
      const id = m.cls.main.categoryId;
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
      else if (!m.error) none++;
    }
    const item = (key, label, n, color, extra) => {
      const li = el('li', { class: 'cat' + (state.filter.cat === key ? ' active' : '') + (extra ? ' ' + extra : '') }, [
        el('button', { type: 'button', onclick: () => { state.filter.cat = key; state.page = 0; render(); } }, [
          el('i', { style: color ? `--c:${color}` : null }), el('span', { class: 'name', text: label }), el('span', { class: 'n', text: String(n) })
        ])
      ]);
      ul.appendChild(li);
    };
    item('all', 'すべて', state.mails.length, null, 'all');
    for (const c of axis('main').categories) item(c.id, c.name, counts.get(c.id) || 0, c.color, c.exclude ? 'excluded' : '');
    item('none', '未分類', none, '#ced4da');
    if (err) item('error', '読めなかったファイル', err, '#e03131', 'err');
  }

  function renderList() {
    const tb = $('rows');
    clear(tb);
    const start = state.page * PAGE;
    const pageRows = state.view.slice(start, start + PAGE);
    for (const m of pageRows) {
      const visibleAtt = m.attachments.filter((a) => !a.hidden);
      const tr = el('tr', {
        class: (state.current === m.id ? 'current ' : '') + (m.error ? 'error' : ''),
        onclick: (ev) => { if (ev.target.closest('input')) return; openDetail(m.id); }
      }, [
        el('td', { class: 'chk' }, el('input', {
          type: 'checkbox', checked: state.selected.has(m.id), 'aria-label': '選択',
          onchange: (ev) => { ev.target.checked ? state.selected.add(m.id) : state.selected.delete(m.id); renderBulk(); }
        })),
        el('td', { class: 'cat' }, el('div', { class: 'catstack' }, [
          catChip(catById(m.cls.main.categoryId, 'main'), m.cls.main.by),
          catChip(catById(m.cls.sub.categoryId, 'sub'), m.cls.sub.by, true),
          m.ss && m.ss.name ? el('span', { class: 'ss', text: m.ss.name, title: 'SS 名' + (m.ss.by === 'manual' ? '（手で入力）' : '') }) : null
        ])),
        el('td', { class: 'date', text: fmtDateShort(mailDate(m)) }),
        el('td', { class: 'from', title: m.from.email || '' }, m.from.name || m.from.email || '（不明）'),
        el('td', { class: 'subject' }, [
          m.error ? el('span', { class: 'badge err', text: '読めません' }) : null,
          m.dup ? el('span', { class: 'badge', text: '重複', title: '同じメールが複数のファイルにあります' }) : null,
          m.importance === 2 ? el('span', { class: 'badge hi', text: '重要' }) : null,
          el('span', { class: 's', text: m.subject || '（件名なし）' }),
          el('span', { class: 'snip', text: m.error || (m.bodyText || '').replace(/\s+/g, ' ').slice(0, 80) })
        ]),
        el('td', { class: 'att', title: visibleAtt.map((a) => a.name).join('\n') }, visibleAtt.length ? [
          el('span', { text: '📎' + visibleAtt.length }),
          visibleAtt.some(Xlsx.isXlsx) ? el('span', { class: 'xl', text: 'xlsx' }) : null,
          visibleAtt.some(Exp.isPdf) ? el('span', { class: 'xl pdf', text: 'pdf' }) : null
        ] : '')
      ]);
      tb.appendChild(tr);
    }
    $('chkPage').checked = pageRows.length > 0 && pageRows.every((m) => state.selected.has(m.id));

    for (const th of document.querySelectorAll('th.sort')) {
      th.classList.toggle('on', th.dataset.sort === state.sort.key);
      th.dataset.dir = state.sort.dir > 0 ? '▲' : '▼';
    }

    const pager = $('pager');
    clear(pager);
    const total = state.view.length;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    pager.appendChild(el('span', { text: total ? `${start + 1}–${Math.min(start + PAGE, total)} 件目 / ${total} 件` : '該当するメールはありません' }));
    if (pages > 1) {
      pager.appendChild(el('button', { class: 'btn small', type: 'button', disabled: state.page === 0, onclick: () => { state.page--; renderList(); $('tableWrap').scrollTop = 0; } }, '← 前'));
      const sel = el('select', { 'aria-label': 'ページ', onchange: (ev) => { state.page = +ev.target.value; renderList(); } });
      for (let i = 0; i < pages; i++) sel.appendChild(el('option', { value: String(i), selected: i === state.page }, `${i + 1} / ${pages}`));
      pager.appendChild(sel);
      pager.appendChild(el('button', { class: 'btn small', type: 'button', disabled: state.page >= pages - 1, onclick: () => { state.page++; renderList(); $('tableWrap').scrollTop = 0; } }, '次 →'));
    }
  }

  function catOptions(select, withAuto, current, a = 'main') {
    clear(select);
    if (withAuto) select.appendChild(el('option', { value: '' }, withAuto));
    for (const c of axis(a).categories) select.appendChild(el('option', { value: c.id, selected: c.id === current }, c.name));
  }

  function renderBulk() {
    const n = state.selected.size;
    $('bulk').hidden = n === 0;
    $('selCount').textContent = `${n} 件を選択中:`;
    const keep = $('bulkCat').value;
    catOptions($('bulkCat'), null, keep, $('bulkAxis').value);
  }

  // ---------- 詳細 ----------

  let blobUrls = [];
  let detailSeq = 0;
  function revokeAll() { blobUrls.forEach((u) => URL.revokeObjectURL(u)); blobUrls = []; }
  function blobUrl(data, type) { const u = URL.createObjectURL(new Blob([data], { type })); blobUrls.push(u); return u; }

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function addrLine(list) { return (list || []).map(Exp.addr).join('; '); }

  /** HTML 本文を sandbox iframe に入れる。スクリプト・外部読み込み・遷移をさせない */
  function htmlFrame(msg) {
    const cid = {};
    for (const a of msg.attachments) {
      if (a.data && isImage(a) && a.data.length < 5 * 1048576) {
        const url = 'data:' + mimeOf(a) + ';base64,' + b64(a.data);
        if (a.contentId) cid[a.contentId.toLowerCase()] = url;
        if (a.name) cid[a.name.toLowerCase()] = url;
      }
    }
    let html = msg.bodyHtml
      .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
      .replace(/<base\b[^>]*>/gi, '')
      .replace(/(["'(])cid:([^"')\s>]+)/gi, (all, q, id) => {
        const u = cid[decodeURIComponent(id).toLowerCase()];
        return u ? q + u : q + 'about:blank';
      });
    const head = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">' +
      '<base target="_blank"><style>body{font-family:Meiryo,sans-serif;font-size:14px;margin:8px;word-break:break-word}img{max-width:100%;height:auto}</style>';
    const f = el('iframe', { class: 'htmlbody', title: 'HTML 本文', referrerpolicy: 'no-referrer' });
    f.setAttribute('sandbox', '');
    f.srcdoc = head + html;
    return f;
  }

  function xlsxTable(sheet) {
    const max = 500;
    const t = el('table', { class: 'xl-table' });
    const rows = sheet.rows.slice(0, max);
    const cols = Math.min(sheet.cols, 60);
    const head = el('tr', null, [el('th')]);
    for (let c = 0; c < cols; c++) {
      let n = c, s = '';
      do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
      head.appendChild(el('th', { text: s }));
    }
    t.appendChild(el('thead', null, head));
    const tb = el('tbody');
    rows.forEach((r, i) => {
      const tr = el('tr', null, el('th', { text: String(i + 1) }));
      for (let c = 0; c < cols; c++) tr.appendChild(el('td', { text: r[c] || '' }));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    const wrap = el('div', { class: 'xl-wrap' }, t);
    if (sheet.rows.length > max || sheet.truncated) wrap.appendChild(el('p', { class: 'note', text: `表示は先頭 ${max} 行・60 列までです。全体はファイルを保存して確認してください。` }));
    return wrap;
  }

  async function xlsxView(a) {
    const box = el('div', { class: 'xl-view' }, el('p', { class: 'note', text: '読み込み中…' }));
    try {
      const r = await Xlsx.read(a.data);
      clear(box);
      const tabs = el('div', { class: 'tabs' });
      const body = el('div');
      const show = (i) => {
        [...tabs.children].forEach((b, j) => b.classList.toggle('on', i === j));
        clear(body);
        body.appendChild(r.sheets[i].rows.length ? xlsxTable(r.sheets[i]) : el('p', { class: 'note', text: '（空のシート、または画像だけのシート）' }));
      };
      r.sheets.forEach((s, i) => tabs.appendChild(el('button', { type: 'button', class: 'tab', onclick: () => show(i) }, s.name + (s.hidden ? '（非表示）' : ''))));
      box.appendChild(tabs);
      box.appendChild(body);
      const first = r.sheets.findIndex((s) => !s.hidden && s.rows.length);
      if (r.sheets.length) show(first < 0 ? 0 : first);
    } catch (e) {
      clear(box);
      box.appendChild(el('p', { class: 'note err', text: 'この xlsx は読み取れませんでした: ' + e.message }));
    }
    return box;
  }

  function renderAttachments(msg, depth) {
    const list = msg.attachments;
    if (!list.length) return null;
    const box = el('div', { class: 'atts' }, el('h4', { text: `添付ファイル（${list.filter((a) => !a.hidden).length} 件${list.some((a) => a.hidden) ? ` ＋ 本文内の画像 ${list.filter((a) => a.hidden).length}` : ''}）` }));
    const thumbs = el('div', { class: 'thumbs' });
    for (const a of list) {
      if (a.kind === 'message') {
        const d = el('details', { class: 'inner' }, el('summary', null, ['✉ ', a.name, ' （添付メール）']));
        if (a.message) d.appendChild(renderMessage(a.message, depth + 1));
        else d.appendChild(el('p', { class: 'note err', text: '読み取れませんでした: ' + (a.error || '') }));
        box.appendChild(d);
        continue;
      }
      const row = el('div', { class: 'att-row' + (a.hidden ? ' inline' : '') }, [
        el('span', { class: 'att-name', text: a.name }),
        el('span', { class: 'att-meta', text: [fmtSize(a.size), a.hidden ? '本文内の画像' : ''].filter(Boolean).join(' ・ ') })
      ]);
      if (a.data) {
        row.appendChild(el('button', { class: 'btn small', type: 'button', onclick: () => download(a.name, a.data, mimeOf(a)) }, '保存'));
        if (Xlsx.isXlsx(a)) {
          const holder = el('div', { class: 'xl-holder' });
          let opened = false;
          const btn = el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
            if (opened) { clear(holder); opened = false; btn.textContent = '表を見る'; return; }
            opened = true; btn.textContent = '表を閉じる';
            holder.appendChild(await xlsxView(a));
          } }, '表を見る');
          row.appendChild(btn);
          box.appendChild(row);
          box.appendChild(holder);
          if (depth === 0 && list.filter(Xlsx.isXlsx).length === 1) btn.click(); // 1つだけなら最初から開く
          continue;
        }
        if (Exp.isPdf(a)) {
          // FAX を PDF にしたものは中身が画像。ブラウザ内蔵の PDF 表示で見る
          const url = blobUrl(a.data, 'application/pdf');
          const holder = el('div', { class: 'pdf-holder' });
          let opened = false;
          const btn = el('button', { class: 'btn small primary', type: 'button', onclick: () => {
            if (opened) { clear(holder); opened = false; btn.textContent = 'PDF を表示'; return; }
            opened = true; btn.textContent = 'PDF を閉じる';
            holder.appendChild(el('iframe', { class: 'pdfview', src: url, title: a.name }));
          } }, 'PDF を表示');
          row.appendChild(btn);
          row.appendChild(el('a', { class: 'btn small ghost', href: url, target: '_blank', rel: 'noopener' }, '新しいタブで開く'));
          box.appendChild(row);
          box.appendChild(holder);
          continue;
        }
        if (isImage(a) && !(a.hidden && msg.bodyHtml)) {
          const url = blobUrl(a.data, mimeOf(a));
          thumbs.appendChild(el('a', { href: url, target: '_blank', rel: 'noopener', title: a.name + '（クリックで拡大）' },
            el('img', { src: url, alt: a.name, loading: 'lazy' })));
        }
      } else if (a.kind === 'ole') {
        row.appendChild(el('span', { class: 'note', text: '（埋め込みオブジェクトのため保存できません）' }));
      }
      box.appendChild(row);
    }
    if (thumbs.children.length) box.appendChild(thumbs);
    return box;
  }

  function renderMessage(msg, depth) {
    const wrap = el('div', { class: 'msg' });
    const rows = [
      ['送信者', msg.from.name && msg.from.email ? `${msg.from.name} <${msg.from.email}>` : msg.from.name || msg.from.email],
      ['送信日時', Exp.fmtDate(msg.sentAt)], ['受信日時', Exp.fmtDate(msg.receivedAt)],
      ['To', addrLine(msg.to)], ['Cc', addrLine(msg.cc)], ['Bcc', addrLine(msg.bcc)]
    ];
    if (depth > 0) rows.unshift(['件名', msg.subject]);
    const t = el('table', { class: 'hdr' });
    for (const [k, v] of rows) if (v) t.appendChild(el('tr', null, [el('th', { text: k }), el('td', { text: v })]));
    wrap.appendChild(t);

    wrap.appendChild(renderAttachments(msg, depth));

    const hasHtml = !!msg.bodyHtml;
    const body = el('div', { class: 'body' });
    const showText = () => { clear(body); body.appendChild(el('pre', { class: 'textbody', text: msg.bodyText || '（本文なし）' })); };
    const showHtml = () => { clear(body); body.appendChild(htmlFrame(msg)); };
    if (hasHtml) {
      const tabs = el('div', { class: 'tabs' });
      const bt = el('button', { type: 'button', class: 'tab', onclick: () => { bt.classList.add('on'); bh.classList.remove('on'); showText(); } }, 'テキスト');
      const bh = el('button', { type: 'button', class: 'tab on', onclick: () => { bh.classList.add('on'); bt.classList.remove('on'); showHtml(); } }, '見たまま（HTML）');
      tabs.append(bh, bt);
      wrap.appendChild(tabs);
      showHtml();
    } else showText();
    wrap.appendChild(body);
    return wrap;
  }

  async function openDetail(id) {
    const m = state.mails.find((x) => x.id === id);
    if (!m) return;
    state.current = id;
    const seq = ++detailSeq;
    revokeAll();
    $('detail').hidden = false;
    document.body.classList.add('with-detail');
    for (const tr of $('rows').children) tr.classList.remove('current');
    renderList();

    for (const [a, id] of [['main', 'detailCat'], ['sub', 'detailSub']]) {
      const autoRes = m.error ? null : Cls.classify(m, axis(a).rules, null);
      const autoCat = autoRes && catById(autoRes.categoryId, a);
      catOptions($(id), (a === 'main' ? '主: ' : '副: ') + '自動' + (autoCat ? `（${autoCat.name}）` : '（未分類）'), m.cls[a].by === 'manual' ? m.cls[a].categoryId : '', a);
    }
    const ssIn = $('detailSs');
    ssIn.value = m.ss && m.ss.by === 'manual' ? m.ss.name : '';
    ssIn.placeholder = m.ss && m.ss.name && m.ss.by !== 'manual' ? `SS: ${m.ss.name}（自動）` : 'SS 名（不明）';

    const box = $('detailBody');
    clear(box);
    box.appendChild(el('h2', { class: 'subj', text: m.subject || '（件名なし）' }));
    const why = (a) => {
      const c = m.cls[a];
      return c.by === 'manual' ? '手で付けたカテゴリです'
        : c.by === 'rule' ? `ルールで分類: 「${(c.hits || []).join('」「') || '条件に一致'}」に当てはまりました`
          : 'どのルールにも当てはまりませんでした';
    };
    box.appendChild(el('p', { class: 'why' }, [el('span', { class: 'ax', text: '主' }), catChip(catById(m.cls.main.categoryId, 'main'), m.cls.main.by), ' ', why('main')]));
    box.appendChild(el('p', { class: 'why' }, [el('span', { class: 'ax', text: '副' }), catChip(catById(m.cls.sub.categoryId, 'sub'), m.cls.sub.by, true), ' ', why('sub')]));
    const ssWhy = !m.ss || !m.ss.name ? '取り出せませんでした（上の欄に入力できます）'
      : m.ss.by === 'manual' ? '手で入力した名前です' : m.ss.by === 'xlsx' ? '添付 xlsx の見出しの隣から取りました' : '件名・本文から取りました';
    box.appendChild(el('p', { class: 'why' }, [el('span', { class: 'ax', text: 'SS' }), el('b', { text: (m.ss && m.ss.name) || '—' }), ' ', ssWhy]));
    box.appendChild(el('p', { class: 'file', text: '元ファイル: ' + (m.path || m.fileName) + '（' + fmtSize(m.size) + '）' }));
    if (m.error) { box.appendChild(el('p', { class: 'note err', text: 'このファイルは読み取れませんでした: ' + m.error })); return; }

    const loading = el('p', { class: 'note', text: '読み込み中…' });
    box.appendChild(loading);
    try {
      const full = Msg.parse(new Uint8Array(await m.file.arrayBuffer()));
      if (seq !== detailSeq) return; // 別のメールに切り替わった
      loading.remove();
      box.appendChild(renderMessage(full, 0));
      if (m.messageId || m.inReplyTo) {
        const ids = el('details', { class: 'ids' }, [el('summary', { text: 'Message-ID・ヘッダ' })]);
        ids.appendChild(el('pre', { class: 'textbody small', text: ['Message-ID: ' + m.messageId, 'In-Reply-To: ' + (m.inReplyTo || ''), '', full.headers || ''].join('\n') }));
        box.appendChild(ids);
      }
    } catch (e) {
      loading.textContent = '読み込めませんでした: ' + e.message;
    }
  }

  function closeDetail() {
    state.current = null;
    detailSeq++;
    revokeAll();
    $('detail').hidden = true;
    document.body.classList.remove('with-detail');
    renderList();
  }

  function moveDetail(step) {
    if (state.current == null) return;
    const i = state.view.findIndex((m) => m.id === state.current);
    const n = state.view[i + step];
    if (!n) return;
    const idx = i + step;
    const page = Math.floor(idx / PAGE);
    if (page !== state.page) state.page = page;
    openDetail(n.id);
    const tr = $('rows').querySelector('tr.current');
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }

  // ---------- 分類の設定 ----------

  function settingsChanged(full) {
    saveSettings();
    for (const m of state.mails) { m._norm = null; m._ssAuto = null; } // ルールや見出し語が変わるので覚えを捨てる
    reclassify();
    render();
    if (full) renderSettings();
    else renderRuleCounts();
  }

  const PALETTE = ['#d9480f', '#1971c2', '#2f9e44', '#7048e8', '#c2255c', '#e67700', '#0c8599', '#5c940d', '#8a8f98'];

  function renderSettings() {
    const tab = state.settingsTab;
    for (const b of document.querySelectorAll('[data-stab]')) {
      b.classList.toggle('on', b.dataset.stab === tab);
      b.setAttribute('aria-selected', String(b.dataset.stab === tab));
    }
    for (const id of ['secCats', 'secRules', 'secDomains']) $(id).hidden = tab === 'ss';
    $('secSs').hidden = tab !== 'ss';
    if (tab === 'ss') { renderSsSettings(); return; }
    const a = tab;
    const ax = axis(a);
    $('catHelp').textContent = a === 'main'
      ? '業務の段階で分けます。「書き出しから外す」にしたカテゴリは、書き出しと集計で既定で除外されます。'
      : '設備・工種で分けます。1 通に 1 つ付きます。';

    // カテゴリ
    const ce = $('catEdit');
    clear(ce);
    ax.categories.forEach((c, i) => {
      const used = state.mails.filter((m) => m.cls[a].categoryId === c.id).length;
      ce.appendChild(el('li', null, [
        el('input', { type: 'color', value: c.color, 'aria-label': '色', onchange: (ev) => { c.color = ev.target.value; settingsChanged(); } }),
        el('input', { type: 'text', value: c.name, class: 'name', 'aria-label': 'カテゴリ名', onchange: (ev) => { c.name = ev.target.value.trim() || c.name; settingsChanged(true); } }),
        a === 'main' ? el('label', { class: 'excl' }, [el('input', { type: 'checkbox', checked: !!c.exclude, onchange: (ev) => { c.exclude = ev.target.checked; settingsChanged(); } }), '書き出しから外す']) : null,
        el('span', { class: 'n', text: used + ' 件' }),
        el('button', { class: 'btn small ghost', type: 'button', title: '上へ', disabled: i === 0, onclick: () => { ax.categories.splice(i - 1, 0, ax.categories.splice(i, 1)[0]); settingsChanged(true); } }, '↑'),
        el('button', { class: 'btn small ghost', type: 'button', title: '下へ', disabled: i === ax.categories.length - 1, onclick: () => { ax.categories.splice(i + 1, 0, ax.categories.splice(i, 1)[0]); settingsChanged(true); } }, '↓'),
        el('button', { class: 'btn small ghost danger', type: 'button', onclick: () => {
          ax.categories.splice(i, 1);
          for (const r of ax.rules) if (r.categoryId === c.id) r.categoryId = '';
          for (const k in state.manual) if (state.manual[k][a] === c.id) setManual(k, a, null);
          settingsChanged(true);
        } }, '削除')
      ]));
    });

    // ルール
    const re = $('ruleEdit');
    clear(re);
    ax.rules.forEach((r, i) => {
      const conds = el('div', { class: 'conds' });
      r.conditions.forEach((c, j) => {
        const fieldSel = el('select', { 'aria-label': '対象', onchange: (ev) => { c.field = ev.target.value; settingsChanged(true); } });
        for (const k in Cls.FIELDS) fieldSel.appendChild(el('option', { value: k, selected: c.field === k }, Cls.FIELDS[k]));
        let valueInput, opSel = null;
        if (c.field === 'hasAttachment') {
          valueInput = el('select', { 'aria-label': '値', onchange: (ev) => { c.value = ev.target.value; settingsChanged(); } }, [
            el('option', { value: 'yes', selected: c.value !== 'no' }, 'あり'), el('option', { value: 'no', selected: c.value === 'no' }, 'なし')]);
        } else {
          opSel = el('select', { 'aria-label': '条件', onchange: (ev) => { c.op = ev.target.value; settingsChanged(); } });
          for (const k in Cls.OPS) opSel.appendChild(el('option', { value: k, selected: c.op === k }, Cls.OPS[k]));
          valueInput = el('input', { type: 'text', class: 'val', value: c.value || '', placeholder: '例: 補修, 修理, 修繕', 'aria-label': '値',
            oninput: (ev) => { c.value = ev.target.value; debounceSettings(); } });
        }
        conds.appendChild(el('div', { class: 'cond' }, [
          j === 0 ? el('span', { class: 'lead', text: 'もし' }) : el('span', { class: 'lead', text: 'かつ' }),
          fieldSel, valueInput, opSel,
          r.conditions.length > 1 ? el('button', { class: 'btn small ghost', type: 'button', title: '条件を消す', onclick: () => { r.conditions.splice(j, 1); settingsChanged(true); } }, '×') : null
        ]));
      });
      const catSel = el('select', { 'aria-label': 'カテゴリ', onchange: (ev) => { r.categoryId = ev.target.value; settingsChanged(); } });
      catSel.appendChild(el('option', { value: '' }, '（カテゴリを選ぶ）'));
      for (const c of ax.categories) catSel.appendChild(el('option', { value: c.id, selected: r.categoryId === c.id }, c.name));
      re.appendChild(el('li', { class: 'rule' + (r.enabled ? '' : ' off') }, [
        el('div', { class: 'rule-head' }, [
          el('label', null, [el('input', { type: 'checkbox', checked: r.enabled, onchange: (ev) => { r.enabled = ev.target.checked; settingsChanged(true); } }), '有効']),
          el('span', { class: 'rule-count', 'data-rule': r.id }),
          el('span', { class: 'sp' }),
          el('button', { class: 'btn small ghost', type: 'button', title: '上へ（先に評価）', disabled: i === 0, onclick: () => { ax.rules.splice(i - 1, 0, ax.rules.splice(i, 1)[0]); settingsChanged(true); } }, '↑'),
          el('button', { class: 'btn small ghost', type: 'button', title: '下へ', disabled: i === ax.rules.length - 1, onclick: () => { ax.rules.splice(i + 1, 0, ax.rules.splice(i, 1)[0]); settingsChanged(true); } }, '↓'),
          el('button', { class: 'btn small ghost danger', type: 'button', onclick: () => { ax.rules.splice(i, 1); settingsChanged(true); } }, '削除')
        ]),
        conds,
        el('div', { class: 'rule-foot' }, [
          el('button', { class: 'btn small ghost', type: 'button', onclick: () => { r.conditions.push({ field: 'body', op: 'contains', value: '' }); settingsChanged(true); } }, '＋ 条件（かつ）'),
          el('span', { class: 'then', text: 'なら' }), catSel
        ])
      ]));
    });
    renderRuleCounts();
    renderDomains();
  }

  let settingsTimer = null;
  function debounceSettings() { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => settingsChanged(), 400); }

  function renderRuleCounts() {
    const a = state.settingsTab;
    if (a === 'ss') { renderSsSettings(); return; }
    const counts = {};
    for (const m of state.mails) if (m.cls[a].by === 'rule') counts[m.cls[a].ruleId] = (counts[m.cls[a].ruleId] || 0) + 1;
    for (const s of document.querySelectorAll('.rule-count')) s.textContent = `このルールで ${counts[s.dataset.rule] || 0} 件`;
    const ce = $('catEdit');
    axis(a).categories.forEach((c, i) => {
      const li = ce.children[i];
      if (li) li.querySelector('.n').textContent = state.mails.filter((m) => m.cls[a].categoryId === c.id).length + ' 件';
    });
    renderDomains();
  }

  /** SS 名の取り出し設定（xlsx の見出し語） */
  function renderSsSettings() {
    const inp = $('ssLabels');
    if (document.activeElement !== inp) inp.value = state.settings.ssLabels.join(', ');
    const total = state.mails.filter((m) => !m.error).length;
    const got = { xlsx: 0, text: 0, manual: 0 };
    for (const m of state.mails) if (!m.error && m.ss && m.ss.by) got[m.ss.by]++;
    const none = total - got.xlsx - got.text - got.manual;
    $('ssStat').textContent = total
      ? `添付 xlsx から ${got.xlsx} 件 / 件名・本文から ${got.text} 件 / 手で入力 ${got.manual} 件 / 不明 ${none} 件`
      : 'メールを読み込むと、取り出せた件数が表示されます';
  }

  function renderDomains() {
    const tb = $('domainList');
    clear(tb);
    const dom = new Map();
    const a = state.settingsTab;
    for (const m of state.mails) {
      if (m.cls[a].categoryId || m.error) continue;
      const d = (m.from.email.split('@')[1] || '').toLowerCase();
      if (!d) continue;
      dom.set(d, (dom.get(d) || 0) + 1);
    }
    const top = [...dom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (!top.length) { tb.appendChild(el('tr', null, el('td', { class: 'note', text: state.mails.length ? '未分類のメールはありません' : 'メールを読み込むと表示されます' }))); return; }
    for (const [d, n] of top) {
      const sel = el('select', { 'aria-label': d + ' のカテゴリ', onchange: (ev) => {
        if (!ev.target.value) return;
        axis(a).rules.push({ id: Cls.newId('r-'), categoryId: ev.target.value, enabled: true, conditions: [{ field: 'fromDomain', op: 'equals', value: d }] });
        settingsChanged(true);
      } });
      catOptions(sel, '→ カテゴリを選んでルール化', '', a);
      tb.appendChild(el('tr', null, [el('td', { text: d }), el('td', { class: 'n', text: n + ' 件' }), el('td', null, sel)]));
    }
  }

  // ---------- 集計 ----------

  function summaryRows() {
    const rows = filteredMails(true).filter((m) => !m.error);
    return state.sumIncExcluded ? rows : rows.filter((m) => !isExcluded(m));
  }
  const keyName = (id, a) => (id === NONE ? '未分類' : (catById(id, a) || { name: '?' }).name);

  /** 集計からの移動: 今の絞り込みを残したまま、クリックした条件を足して一覧へ（件数が集計と一致する） */
  function drill(patch) {
    Object.assign(state.filter, patch, { hideExcl: !state.sumIncExcluded });
    state.mode = 'list';
    state.page = 0;
    syncFilterInputs();
    render();
  }
  function syncFilterInputs() {
    $('hideExcl').checked = state.filter.hideExcl;
    $('q').value = state.filter.q; $('fromQ').value = state.filter.from;
    $('dateFrom').value = state.filter.dateFrom; $('dateTo').value = state.filter.dateTo; $('attQ').value = state.filter.att;
  }
  const mainKeyToFilter = (id) => (id === NONE ? 'none' : id);

  function heat(n, max) {
    if (!n || !max) return '';
    return `background: color-mix(in srgb, var(--accent) ${Math.round(8 + (n / max) * 62)}%, white);` + (n / max > 0.55 ? 'color:#fff;' : '');
  }
  function bar(n, max) {
    return el('div', { class: 'bar' }, el('span', { style: `width:${max ? Math.max(2, Math.round((n / max) * 100)) : 0}%` }));
  }
  function csvButton(label, fileBase, tableFn) {
    return el('button', { class: 'btn small', type: 'button', onclick: () => download(`${fileBase}-${stamp()}.csv`, Sum.tableToCsv(tableFn()), 'text/csv;charset=utf-8') }, label);
  }

  function renderSummary() {
    const box = $('summary');
    clear(box);
    const rows = summaryRows();
    const mainCats = axis('main').categories.filter((c) => state.sumIncExcluded || !c.exclude);
    const subCats = axis('sub').categories;
    const excludedN = filteredMails(true).filter((m) => !m.error && isExcluded(m)).length;

    box.appendChild(el('div', { class: 'sum-head' }, [
      el('p', null, [el('b', { text: `${rows.length} 件` }), 'を集計しています。左のカテゴリ・上の絞り込み条件がかかります。数字をクリックすると、そのメールの一覧へ移ります。']),
      el('label', null, [el('input', { type: 'checkbox', checked: state.sumIncExcluded, onchange: (ev) => { state.sumIncExcluded = ev.target.checked; render(); } }),
        `「書き出しから外す」カテゴリも含める（${excludedN} 件）`])
    ]));
    if (!rows.length) { box.appendChild(el('p', { class: 'note', text: '集計するメールがありません。' })); return; }

    // 主×副
    const mx = Sum.matrix(rows, mainCats, subCats);
    const t1 = el('table', { class: 'sum-table matrix' });
    t1.appendChild(el('thead', null, el('tr', null, [el('th', { class: 'corner', text: '主 ＼ 副' }),
      ...mx.cols.map((c) => el('th', { class: 'colh', text: keyName(c, 'sub') })), el('th', { class: 'tot', text: '合計' })])));
    const tb1 = el('tbody');
    for (const r of mx.rows) {
      const tr = el('tr', null, el('th', { class: 'rowh' }, el('button', { type: 'button', class: 'link', onclick: () => drill({ cat: mainKeyToFilter(r) }) }, keyName(r, 'main'))));
      for (const c of mx.cols) {
        const n = mx.cells[r][c];
        tr.appendChild(el('td', { class: 'num', style: heat(n, mx.max) }, n ? el('button', { type: 'button', class: 'link num', title: `${keyName(r, 'main')} × ${keyName(c, 'sub')}`,
          onclick: () => drill({ cat: mainKeyToFilter(r), sub: c }) }, String(n)) : el('span', { class: 'zero', text: '·' })));
      }
      tr.appendChild(el('td', { class: 'num tot', text: String(mx.rowTotal[r]) }));
      tb1.appendChild(tr);
    }
    const ft = el('tr', { class: 'foot' }, el('th', { text: '合計' }));
    for (const c of mx.cols) ft.appendChild(el('td', { class: 'num tot' }, mx.colTotal[c] ? el('button', { type: 'button', class: 'link num', onclick: () => drill({ sub: c }) }, String(mx.colTotal[c])) : '0'));
    ft.appendChild(el('td', { class: 'num tot', text: String(mx.total) }));
    tb1.appendChild(ft);
    t1.appendChild(tb1);
    const matrixCsv = () => [['主 ＼ 副', ...mx.cols.map((c) => keyName(c, 'sub')), '合計'],
      ...mx.rows.map((r) => [keyName(r, 'main'), ...mx.cols.map((c) => mx.cells[r][c]), mx.rowTotal[r]]),
      ['合計', ...mx.cols.map((c) => mx.colTotal[c]), mx.total]];
    box.appendChild(section('主カテゴリ × 副カテゴリ', '件数が多いマスほど濃く表示しています。', t1, csvButton('CSV で書き出す', '集計_主x副', matrixCsv)));

    // 月別
    const mo = Sum.monthly(rows, mainCats);
    const t2 = el('table', { class: 'sum-table' });
    t2.appendChild(el('thead', null, el('tr', null, [el('th', { text: '月' }), ...mo.cols.map((c) => el('th', { class: 'colh', text: keyName(c, 'main') })), el('th', { class: 'tot', text: '合計' }), el('th', { class: 'barh' })])));
    const tb2 = el('tbody');
    for (const r of mo.rows) {
      const isDate = /^\d{4}-\d{2}$/.test(r.month);
      const go = () => {
        if (!isDate) return;
        const [y, m] = r.month.split('-').map(Number);
        const last = new Date(y, m, 0).getDate();
        drill({ dateFrom: `${r.month}-01`, dateTo: `${r.month}-${String(last).padStart(2, '0')}` });
      };
      const label = isDate ? r.month.replace('-', '年') + '月' : r.month;
      tb2.appendChild(el('tr', null, [
        el('th', { class: 'rowh' }, isDate && r.total ? el('button', { type: 'button', class: 'link', onclick: go }, label) : label),
        ...mo.cols.map((c) => el('td', { class: 'num', text: r.counts[c] ? String(r.counts[c]) : '·' })),
        el('td', { class: 'num tot', text: String(r.total) }),
        el('td', { class: 'barc' }, bar(r.total, mo.max))
      ]));
    }
    t2.appendChild(tb2);
    const monthCsv = () => [['月', ...mo.cols.map((c) => keyName(c, 'main')), '合計'], ...mo.rows.map((r) => [r.month, ...mo.cols.map((c) => r.counts[c]), r.total])];
    box.appendChild(section('月別の推移（主カテゴリ別）', 'メールの送信日（無ければ受信日）で数えています。月をクリックすると、その月の一覧へ移ります。', t2, csvButton('CSV で書き出す', '集計_月別', monthCsv)));

    // SS 別
    const ss = Sum.bySs(rows, mainCats);
    const t3 = el('table', { class: 'sum-table' });
    t3.appendChild(el('thead', null, el('tr', null, [el('th', { text: 'SS' }), ...ss.cols.map((c) => el('th', { class: 'colh', text: keyName(c, 'main') })), el('th', { class: 'tot', text: '合計' }), el('th', { class: 'barh' })])));
    const tb3 = el('tbody');
    for (const r of ss.rows) {
      tb3.appendChild(el('tr', null, [
        el('th', { class: 'rowh' }, el('button', { type: 'button', class: 'link' + (r.ss === Sum.NO_SS ? ' muted' : ''), onclick: () => drill({ ss: r.ss }) }, r.ss)),
        ...ss.cols.map((c) => el('td', { class: 'num', text: r.counts[c] ? String(r.counts[c]) : '·' })),
        el('td', { class: 'num tot', text: String(r.total) }),
        el('td', { class: 'barc' }, bar(r.total, ss.max))
      ]));
    }
    t3.appendChild(tb3);
    const ssCsv = () => [['SS', ...ss.cols.map((c) => keyName(c, 'main')), '合計'], ...ss.rows.map((r) => [r.ss, ...ss.cols.map((c) => r.counts[c]), r.total])];
    const noSs = ss.rows.find((r) => r.ss === Sum.NO_SS);
    box.appendChild(section('SS 別', `SS 名は添付 xlsx の「SS名」欄、無ければ件名・本文から取っています。${noSs ? `取り出せなかった ${noSs.total} 件は「${Sum.NO_SS}」にまとめています（詳細画面で入力できます）。` : ''}`, t3, csvButton('CSV で書き出す', '集計_SS別', ssCsv)));
  }

  function section(title, note, table, action) {
    return el('section', { class: 'sum-sec' }, [
      el('div', { class: 'sum-sec-head' }, [el('h3', { text: title }), action]),
      el('p', { class: 'note', text: note }),
      el('div', { class: 'sum-wrap' }, table)
    ]);
  }

  // ---------- 書き出し ----------

  function isExcluded(m) { const c = catById(m.cls.main.categoryId, 'main'); return !!(c && c.exclude); }

  function exportRows(scope, incExcluded) {
    let rows = scope === 'all' ? state.mails.slice() : scope === 'selected' ? state.view.filter((m) => state.selected.has(m.id)) : state.view.slice();
    if (scope === 'selected' && rows.length < state.selected.size) rows = state.mails.filter((m) => state.selected.has(m.id));
    if (!incExcluded) rows = rows.filter((m) => !isExcluded(m));
    return rows;
  }
  function updateExportCount() {
    const scope = document.querySelector('input[name=scope]:checked').value;
    const inc = $('incExcluded').checked;
    $('cntFiltered').textContent = state.view.length;
    $('cntSelected').textContent = state.selected.size;
    $('cntAll').textContent = state.mails.length;
    const rows = exportRows(scope, inc);
    const base = exportRows(scope, true).length;
    $('exportCount').textContent = `${rows.length} 件を書き出します` + (base - rows.length ? `（「書き出しから外す」カテゴリの ${base - rows.length} 件を除く）` : '');
  }
  function doExport(fmt) {
    const scope = document.querySelector('input[name=scope]:checked').value;
    const rows = exportRows(scope, $('incExcluded').checked);
    if (!rows.length) { $('exportCount').textContent = '書き出すメールがありません'; return; }
    const name = 'mails-' + stamp();
    if (fmt === 'csv') download(name + '.csv', Exp.toCsv(rows, EXPORT_INFO), 'text/csv;charset=utf-8');
    else if (fmt === 'json') download(name + '.json', Exp.toJson(rows, EXPORT_INFO), 'application/json');
    else download(name + '.html', Exp.toHtml(rows, EXPORT_INFO, axis('main').categories.map((c) => c.name).concat('未分類')), 'text/html;charset=utf-8');
  }

  // ---------- イベント ----------

  function bind() {
    $('pickFiles').addEventListener('change', (ev) => {
      addFiles([...ev.target.files].map((f) => ({ file: f, path: f.name })));
      ev.target.value = '';
    });
    $('pickDir').addEventListener('change', (ev) => {
      addFiles([...ev.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
      ev.target.value = '';
    });
    document.addEventListener('dragover', (ev) => { ev.preventDefault(); document.body.classList.add('dragging'); });
    document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) document.body.classList.remove('dragging'); });
    document.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      document.body.classList.remove('dragging');
      const items = [...(ev.dataTransfer.items || [])];
      const out = [];
      const entries = items.length && items[0].webkitGetAsEntry ? items.map((it) => it.webkitGetAsEntry()).filter(Boolean) : [];
      if (entries.length) {
        showProgress('ファイルを集めています…', 0);
        for (const e of entries) await readEntry(e, out);
      } else {
        for (const f of ev.dataTransfer.files) out.push({ file: f, path: f.name });
      }
      addFiles(out);
    });

    $('clearAll').addEventListener('click', () => {
      state.mails = []; state.selected.clear(); closeDetail(); render();
    });

    const setFilter = (k) => (ev) => { state.filter[k] = ev.target.value; state.page = 0; render(); };
    let qTimer = null;
    $('q').addEventListener('input', (ev) => { clearTimeout(qTimer); qTimer = setTimeout(() => setFilter('q')(ev), 200); });
    $('fromQ').addEventListener('input', (ev) => { clearTimeout(qTimer); qTimer = setTimeout(() => setFilter('from')(ev), 200); });
    $('dateFrom').addEventListener('change', setFilter('dateFrom'));
    $('dateTo').addEventListener('change', setFilter('dateTo'));
    $('attQ').addEventListener('change', setFilter('att'));
    $('subQ').addEventListener('change', setFilter('sub'));
    $('hideExcl').addEventListener('change', (ev) => { state.filter.hideExcl = ev.target.checked; state.page = 0; render(); });
    $('ssQ').addEventListener('change', setFilter('ss'));
    $('resetFilter').addEventListener('click', () => {
      state.filter = { cat: state.filter.cat, sub: '', ss: '', q: '', from: '', dateFrom: '', dateTo: '', att: '', hideExcl: false };
      syncFilterInputs();
      state.page = 0; render();
    });
    $('tabList').addEventListener('click', () => { state.mode = 'list'; render(); });
    $('tabSummary').addEventListener('click', () => { state.mode = 'summary'; if (state.current != null) closeDetail(); render(); });

    for (const th of document.querySelectorAll('th.sort')) {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (state.sort.key === k) state.sort.dir *= -1; else state.sort = { key: k, dir: k === 'date' ? -1 : 1 };
        render();
      });
    }

    $('chkPage').addEventListener('change', (ev) => {
      const pageRows = state.view.slice(state.page * PAGE, state.page * PAGE + PAGE);
      for (const m of pageRows) ev.target.checked ? state.selected.add(m.id) : state.selected.delete(m.id);
      renderList(); renderBulk();
    });
    $('bulkAxis').addEventListener('change', renderBulk);
    $('bulkApply').addEventListener('click', () => {
      const cat = $('bulkCat').value;
      const a = $('bulkAxis').value;
      if (!cat) return;
      for (const m of state.mails) if (state.selected.has(m.id)) setManual(m.key, a, cat);
      state.selected.clear();
      saveSettings(); reclassify(); render();
    });
    $('bulkAuto').addEventListener('click', () => {
      const a = $('bulkAxis').value;
      for (const m of state.mails) if (state.selected.has(m.id)) setManual(m.key, a, null);
      state.selected.clear();
      saveSettings(); reclassify(); render();
    });
    $('bulkClear').addEventListener('click', () => { state.selected.clear(); render(); });

    const onDetail = (field, get) => (ev) => {
      const m = state.mails.find((x) => x.id === state.current);
      if (!m) return;
      setManual(m.key, field, get(ev));
      saveSettings(); reclassify(); render();
      openDetail(m.id);
    };
    $('detailCat').addEventListener('change', onDetail('main', (ev) => ev.target.value));
    $('detailSub').addEventListener('change', onDetail('sub', (ev) => ev.target.value));
    $('detailSs').addEventListener('change', onDetail('ss', (ev) => Fields.normalizeSs(ev.target.value)));
    $('closeDetail').addEventListener('click', closeDetail);
    $('prevMail').addEventListener('click', () => moveDetail(-1));
    $('nextMail').addEventListener('click', () => moveDetail(1));
    document.addEventListener('keydown', (ev) => {
      if (ev.target.closest('input, select, textarea, dialog')) return;
      if (ev.key === 'Escape' && state.current != null) closeDetail();
      else if (ev.key === 'j' || ev.key === 'ArrowDown') { if (state.current != null) { ev.preventDefault(); moveDetail(1); } }
      else if (ev.key === 'k' || ev.key === 'ArrowUp') { if (state.current != null) { ev.preventDefault(); moveDetail(-1); } }
    });

    $('openSettings').addEventListener('click', () => { renderSettings(); $('settings').showModal(); });
    for (const b of document.querySelectorAll('[data-stab]')) b.addEventListener('click', () => { state.settingsTab = b.dataset.stab; renderSettings(); });
    $('ssLabels').addEventListener('change', (ev) => {
      state.settings.ssLabels = ev.target.value.split(/[,、，]/).map((x) => x.trim()).filter(Boolean);
      settingsChanged(true);
    });
    $('addCat').addEventListener('click', () => {
      const cats = axis(state.settingsTab).categories;
      cats.push({ id: Cls.newId(state.settingsTab === 'sub' ? 's-' : 'c-'), name: '新しいカテゴリ', color: PALETTE[cats.length % PALETTE.length], exclude: false });
      settingsChanged(true);
      const inputs = $('catEdit').querySelectorAll('input.name');
      const last = inputs[inputs.length - 1];
      if (last) { last.focus(); last.select(); }
    });
    $('addRule').addEventListener('click', () => {
      axis(state.settingsTab).rules.push({ id: Cls.newId('r-'), categoryId: '', enabled: true, conditions: [{ field: 'any', op: 'contains', value: '' }] });
      settingsChanged(true);
      const vals = $('ruleEdit').querySelectorAll('input.val');
      if (vals.length) vals[vals.length - 1].focus();
    });
    $('exportSettings').addEventListener('click', () => {
      download('msg-settings-' + stamp() + '.json', JSON.stringify(Object.assign({}, state.settings, { manual: state.manual }), null, 2), 'application/json');
    });
    $('importSettings').addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      try {
        const s = JSON.parse(await f.text());
        if (!(s && (s.axes || Array.isArray(s.categories)))) throw new Error('設定ファイルの形式が違います');
        const r = Cls.migrate(s, s.manual || {});
        state.settings = r.settings; state.manual = r.manual;
        settingsChanged(true);
      } catch (e) {
        $('domainList').parentElement.insertAdjacentElement('afterend', el('p', { class: 'note err', text: '読み込めませんでした: ' + e.message }));
      }
    });
    $('resetSettings').addEventListener('click', () => {
      const keep = state.settings.ssLabels;
      state.settings = Cls.defaults();
      state.settings.ssLabels = keep;
      settingsChanged(true);
    });

    const save = $('saveTool');
    if (!STANDALONE) { save.disabled = true; save.title = '開発用の画面では使えません。node build.mjs で作った index.html から使ってください'; }
    save.addEventListener('click', () => download('msg-extract-tool.html', PRISTINE, 'text/html;charset=utf-8'));

    const openHelp = () => { $('helpDlg').showModal(); $('helpDlg').scrollTop = 0; };
    $('openHelp').addEventListener('click', openHelp);
    for (const b of document.querySelectorAll('[data-open-help]')) b.addEventListener('click', openHelp);
    // 目次は URL を変えずにダイアログ内をスクロールする
    for (const a of document.querySelectorAll('.help-toc a')) {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const t = document.getElementById(a.getAttribute('href').slice(1));
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    $('openExport').addEventListener('click', () => { updateExportCount(); $('exportDlg').showModal(); });
    for (const r of document.querySelectorAll('input[name=scope]')) r.addEventListener('change', updateExportCount);
    $('incExcluded').addEventListener('change', updateExportCount);
    for (const b of document.querySelectorAll('[data-fmt]')) b.addEventListener('click', () => doExport(b.dataset.fmt));
  }

  loadSettings().then(() => { bind(); reclassify(); render(); });
})();
