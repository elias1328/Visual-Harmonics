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
