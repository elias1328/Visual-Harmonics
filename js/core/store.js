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
  const fresh = new Set();   // blobs written in this session: never garbage-collected (their reference may not be saved yet)
  const putBlob = (key, blob) => { fresh.add(key); return tx('readwrite', (s) => s.put(blob, key)); };
  const getBlob = (key) => tx('readonly', (s) => s.get(key));
  const delBlob = (key) => tx('readwrite', (s) => s.delete(key));
  const blobKeys = () => tx('readonly', (s) => s.getAllKeys());

  // ---------- housekeeping (run once per start, while idle; see VH.app) ----------
  // Every key this app stores under 'vh:'. A 'vh:' key in one of the experiment namespaces below that is NOT listed is a
  // leftover from an older version and is removed by tidy(). test/store.test.js checks that every key the code uses is here.
  const KEYS = ['sounds', 'store.gc',
    'babel.view', 'babel.detector', 'babel.disc', 'babel.gems',
    'melody.song', 'melody.sound', 'melody.bpm', 'melody.countIn', 'melody.inbox', 'melody.look', 'melody.playMode',
    'melody.pureIntonation', 'melody.autofit', 'melody.showAuto', 'melody.showScale', 'melody.tones', 'melody.tutorial',
    'melody.kits', 'melody.view', 'melody.gen.density', 'melody.gen.range',
    'spiral.prefs', 'spiral.sound',
    'ui.phoneNotice'];   // (ui.* is never tidied; listed so the dismissal is a known key)
  const TIDY_NS = /^(babel|melody|spiral|lab)\./;   // other namespaces (ui.*, gallery.*) use dynamic keys: left alone
  function tidy() {
    const s = ls(), gone = [];
    if (!s) return gone;
    try {
      for (let i = s.length - 1; i >= 0; i--) {
        const k = s.key(i);
        if (k && k.startsWith(PREFIX) && TIDY_NS.test(k.slice(PREFIX.length)) && !KEYS.includes(k.slice(PREFIX.length))) gone.push(k);
      }
      gone.forEach((k) => s.removeItem(k));
    } catch (_) { /* storage blocked: nothing to tidy */ }
    return gone;
  }

  // Blob garbage collection. A blob is referenced when its key (or, for 'x:an' analysis blobs, 'x') appears anywhere in a
  // saved 'vh:' value (sounds, kits, autosaved song, inbox, ...) or in `live` (text of in-memory state such as the undo
  // history). Plain substring search: over-keeping is fine, deleting something in use is not. Safety rules:
  //  - no readable localStorage -> do nothing (the references may only live in memory);
  //  - blobs written in this session are kept;
  //  - an orphan is deleted only when it was already an orphan on an earlier run at least `graceMs` ago (pending marks are
  //    kept in 'vh:store.gc'), so another open tab that has just stored audio and not yet saved its song is safe.
  function planGc(keys, text, pending, now, graceMs, keep) {
    const del = [], next = {};
    for (const k of keys) {
      if (typeof k !== 'string' || !k || (keep && keep.has(k))) continue;
      const base = k.endsWith(':an') ? k.slice(0, -3) : k;
      if (text.includes(k) || (base && text.includes(base))) continue;
      const t = pending && typeof pending[k] === 'number' ? pending[k] : null;
      if (t != null && t <= now && now - t >= graceMs) del.push(k); else next[k] = t != null && t <= now ? t : now;
    }
    return { del, pending: next };
  }
  function savedText() {
    const s = ls();
    if (!s) return null;
    let text = '';
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX) && k !== PREFIX + 'store.gc') text += '\n' + s.getItem(k);
    }
    return text;
  }
  async function gcBlobs(o) {
    o = o || {};
    let text;
    try { text = savedText(); } catch (_) { return null; }
    if (text == null) return null;
    const keys = await blobKeys();
    const plan = planGc(keys, text + '\n' + (o.live || ''), get('store.gc', {}), o.now || Date.now(), o.graceMs == null ? 864e5 : o.graceMs, fresh);
    for (const k of plan.del) await delBlob(k);
    set('store.gc', plan.pending);
    return { deleted: plan.del, pending: Object.keys(plan.pending) };
  }

  const api = { get, set, remove, encodeShare, decodeShare, putBlob, getBlob, delBlob, blobKeys, tidy, gcBlobs, planGc, KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.VH = root.VH || {}).store = api;
})(this);
