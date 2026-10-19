// store.js - localStorage (JSON, try/catch), share links, and an IndexedDB blob store for imported audio.
// Browser: window.VH.store. Node: module.exports (encodeShare/decodeShare work in Node 18+).
(function (root) {
  'use strict';
  const PREFIX = 'vh:';
  const mem = {};   // fallback when localStorage is blocked

  function ls() { try { return root.localStorage || null; } catch (_) { return null; } }
  function get(k, def) {
    try {
      const s = ls();
      const raw = s ? s.getItem(PREFIX + k) : mem[k];
      return raw == null ? def : JSON.parse(raw);
    } catch (_) { return def; }
  }
  function set(k, v) {
    const raw = JSON.stringify(v);
    mem[k] = raw;
    try { const s = ls(); if (s) s.setItem(PREFIX + k, raw); return true; } catch (_) { return false; }
  }
  function remove(k) { delete mem[k]; try { const s = ls(); if (s) s.removeItem(PREFIX + k); } catch (_) { /* ignore */ } }

  // ---------- share links: JSON -> deflate (when available) -> base64url ----------
  // Prefix 'z' = deflate-raw compressed, 'j' = plain UTF-8 JSON.
  function b64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const canZip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' &&
    typeof Blob === 'function' && typeof Response === 'function';
  async function pipe(bytes, Stream) {
    const s = new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function encodeShare(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (canZip()) { try { return 'z' + b64url(await pipe(bytes, CompressionStream)); } catch (_) { /* fall through */ } }
    return 'j' + b64url(bytes);
  }
  async function decodeShare(str) {
    if (!str || typeof str !== 'string') return null;
    try {
      let bytes = unb64url(str.slice(1));
      if (str[0] === 'z') { if (!canZip()) return null; bytes = await pipe(bytes, DecompressionStream); }
      else if (str[0] !== 'j') return null;
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) { return null; }
  }

  // ---------- IndexedDB blobs (imported audio, keyed by blobKey) ----------
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        if (!root.indexedDB) { rej(new Error('no IndexedDB')); return; }
        const r = root.indexedDB.open('visual-harmonics', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('blobs');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      dbp.catch(() => { dbp = null; });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('blobs', mode), req = fn(t.objectStore('blobs'));
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    });
  }
  const putBlob = (key, blob) => tx('readwrite', (s) => s.put(blob, key));
  const getBlob = (key) => tx('readonly', (s) => s.get(key));
  const delBlob = (key) => tx('readwrite', (s) => s.delete(key));

  const api = { get, set, remove, encodeShare, decodeShare, putBlob, getBlob, delBlob };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.VH = root.VH || {}).store = api;
})(this);
