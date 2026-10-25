const test = require('node:test');
const assert = require('node:assert');
const S = require('../js/core/store.js');

test('encodeShare / decodeShare round-trip', async () => {
  const obj = { v: 1, bars: [0, 5, 3, 4], layers: [[60.5, null, 62], []], name: 'Glöckchen ♪', x: -0.00123 };
  const s = await S.encodeShare(obj);
  assert.match(s, /^[zj][A-Za-z0-9_-]*$/);
  assert.deepStrictEqual(await S.decodeShare(s), obj);
});

test('decodeShare rejects junk', async () => {
  assert.strictEqual(await S.decodeShare('z!!!'), null);
  assert.strictEqual(await S.decodeShare(''), null);
});

test('get/set fall back to memory without localStorage', () => {
  assert.strictEqual(S.get('nope', 7), 7);
  S.set('k', { a: 1 });
  assert.deepStrictEqual(S.get('k'), { a: 1 });
});

test('planGc: referenced blobs survive, orphans go only after the grace period', () => {
  const text = JSON.stringify({ sounds: [{ sampler: { zones: [{ blobKey: 'imp-a' }] } }], song: { track: { blobKey: 'track:t1' } } });
  const keys = ['imp-a', 'track:t1', 'track:t1:an', 'babel-old', 'track:gone', 'track:gone:an', 'new-one'];
  const keep = new Set(['new-one']);   // written this session
  // first sighting: orphans are only marked
  let p = S.planGc(keys, text, {}, 1000, 500, keep);
  assert.deepStrictEqual(p.del, []);
  assert.deepStrictEqual(Object.keys(p.pending).sort(), ['babel-old', 'track:gone', 'track:gone:an']);
  // too soon: still kept
  assert.deepStrictEqual(S.planGc(keys, text, p.pending, 1400, 500, keep).del, []);
  // after the grace period: deleted; referenced, analysis-of-referenced and fresh blobs survive
  const q = S.planGc(keys, text, p.pending, 1600, 500, keep);
  assert.deepStrictEqual(q.del.sort(), ['babel-old', 'track:gone', 'track:gone:an']);
  // an orphan that becomes referenced again is unmarked
  p = S.planGc(['babel-old'], text + 'babel-old', { 'babel-old': 1 }, 1600, 0, null);
  assert.deepStrictEqual(p, { del: [], pending: {} });
  // a mark from the future (clock change) restarts the wait
  assert.deepStrictEqual(S.planGc(['x'], '', { x: 9e9 }, 1000, 0, null).del, []);
});

test('every localStorage key the code uses in a tidied namespace is in VH.store.KEYS', () => {
  const fs = require('node:fs'), path = require('node:path');
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== 'vendor') walk(p); } else if (f.name.endsWith('.js')) files.push(p);
    }
  })(path.join(__dirname, '..', 'js'));
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/['"]((?:babel|melody|spiral|lab)\.[A-Za-z][A-Za-z.]*)['"]/g)) if (!/\.(js|css|html)$/.test(m[1])) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !S.KEYS.includes(k));
  assert.deepStrictEqual(missing, []);
  assert.ok(used.has('melody.song') && used.has('babel.view'));
});

test('gallery.keys (owner secrets) is a known key and survives tidy()', () => {
  assert.ok(S.KEYS.includes('gallery.keys'));
  const m = new Map();   // store.js binds to `this`: run it in a vm context that has a localStorage
  const localStorage = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const ctx = vm.createContext({ localStorage, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'core', 'store.js'), 'utf8'), ctx);
  const st = ctx.VH.store;
  m.set('vh:gallery.keys', '[{"id":"x"}]'); m.set('vh:melody.oldkey', '1'); m.set('vh:melody.song', '{}');
  assert.deepStrictEqual(Array.from(st.tidy()), ['vh:melody.oldkey']);
  assert.ok(m.has('vh:gallery.keys') && m.has('vh:melody.song') && !m.has('vh:melody.oldkey'));
});
