/*
 * 設定の保存（IndexedDB）。保存するのはカテゴリ・ルール・手直しの結果だけで、メール本文は保存しない。
 * IndexedDB が使えない環境（file:// を制限するブラウザ）では localStorage、それも駄目ならメモリに置く。
 */
(function (g) {
  'use strict';

  var DB = 'msg-extract';
  var STORE = 'kv';
  var dbp = null;
  var mem = {};

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      // file:// などで応答が返らないことがあるため、待ちすぎたら諦めて localStorage を使う
      setTimeout(function () { resolve(null); }, 1500);
      try {
        var req = g.indexedDB.open(DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbp;
  }

  function lsGet(k) {
    try { var v = g.localStorage.getItem(DB + ':' + k); return v == null ? undefined : JSON.parse(v); } catch (e) { return mem[k]; }
  }
  function lsSet(k, v) {
    try { g.localStorage.setItem(DB + ':' + k, JSON.stringify(v)); } catch (e) { mem[k] = v; }
  }

  function idbGet(k) {
    return open().then(function (db) {
      if (!db) return undefined;
      return new Promise(function (resolve) {
        try {
          var r = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { resolve(undefined); };
        } catch (e) { resolve(undefined); }
      });
    });
  }
  function idbSet(k, rec) {
    return open().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(rec, k);
          tx.oncomplete = tx.onerror = tx.onabort = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    });
  }

  // 両方に {t: 保存時刻, v: 値} で保存し、読むときは新しい方を使う。
  // セッションによって片方しか使えなかった場合でも最新の設定を見失わないため
  function get(k) {
    var ls = lsGet(k);
    return idbGet(k).then(function (db) {
      var a = ls && ls.t ? ls : null, b = db && db.t ? db : null;
      var best = a && b ? (a.t >= b.t ? a : b) : (a || b);
      return best ? best.v : undefined;
    });
  }
  function set(k, v) {
    var rec = { t: Date.now(), v: v };
    lsSet(k, rec);
    return idbSet(k, rec);
  }

  g.MsgStore = { get: get, set: set };
})(typeof globalThis !== 'undefined' ? globalThis : this);
