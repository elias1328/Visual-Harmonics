// Pure gallery helpers: query builder (search encoding), meta / preview builder (size cap, downsampling), row checks.
const test = require('node:test');
const assert = require('node:assert');
const G = require('../js/exp/gallery.js');

test('listPath: sort, paging, limit', () => {
  assert.strictEqual(G.listPath({}), '/rest/v1/songs?select=id,created_at,title,author,meta,likes&order=created_at.desc&limit=24&offset=0');
  const top = G.listPath({ sort: 'top', offset: 48 });
  assert.match(top, /&order=likes\.desc,created_at\.desc&/);
  assert.match(top, /&limit=24&offset=48$/);
  assert.match(G.listPath({ offset: -5, limit: 500 }), /&limit=100&offset=0$/);
});

test('listPath: search is cleaned and URL-encoded', () => {
  const p = G.listPath({ q: '  Moon  river ' });
  const or = decodeURIComponent(p.split('&or=')[1]);
  assert.strictEqual(or, '(title.ilike."*Moon river*",author.ilike."*Moon river*")');
  assert.ok(!/[ "*(),]/.test(p.split('&or=')[1]), 'encoded');
  // filter-syntax characters can't break out of the filter
  const evil = G.listPath({ q: 'a*),hidden.eq.true,(b"\\%' });
  const dec = decodeURIComponent(evil.split('&or=')[1]);
  assert.strictEqual(dec, '(title.ilike."*a*hidden.eq.true*b*",author.ilike."*a*hidden.eq.true*b*")');
  assert.strictEqual(G.cleanSearch('O1 test (auto-hidden)'), 'O1 test*auto-hidden');   // special characters = wildcards
  assert.strictEqual(G.cleanSearch(' ( ) '), '');
  assert.ok(!/&|#|\+| /.test(evil.split('&or=')[1]));
  assert.strictEqual(G.listPath({ q: '***' }).includes('&or='), false);
  assert.strictEqual(G.cleanSearch('x'.repeat(100)).length, 60);
  assert.match(G.listPath({ q: 'a&b=c #1+' }), /&or=[^&#+ ]+$/);
});

test('codePath only takes the id, encoded', () => {
  assert.strictEqual(G.codePath('1b4e28ba-2fa1-11d2-883f-0016d3cca427'), '/rest/v1/songs?id=eq.1b4e28ba-2fa1-11d2-883f-0016d3cca427&select=code');
});

test('cleanRow keeps good rows, normalises and drops malformed ones', () => {
  const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  const r = G.cleanRow({ id, created_at: '2026-10-20T10:00:00Z', title: ' Hi ', author: '', meta: null, likes: '3' });
  assert.deepStrictEqual(r, { id, title: 'Hi', author: 'Anonymous', created: Date.parse('2026-10-20T10:00:00Z'), meta: {}, likes: 3 });
  assert.strictEqual(G.cleanRow(null), null);
  assert.strictEqual(G.cleanRow({ id: 'x', title: 'a' }), null);
  assert.strictEqual(G.cleanRow({ id, title: '' }), null);
  assert.strictEqual(G.cleanRow({ id, title: 'x'.repeat(61) }), null);
  assert.strictEqual(G.cleanRow({ id, title: 7 }), null);
  assert.strictEqual(G.cleanRow({ id, title: 'ok', meta: [1, 2] }).meta.constructor, Object);
});

test('checkPublish validates lengths', () => {
  assert.match(G.checkPublish('   ', 'x').error, /title/);
  assert.match(G.checkPublish('x'.repeat(61), '').error, /60/);
  assert.match(G.checkPublish('ok', 'y'.repeat(31)).error, /30/);
  assert.deepStrictEqual(G.checkPublish(' Song ', ' '), { title: 'Song', author: 'Anonymous', error: '' });
});

test('downsample keeps ends and caps the count', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => [i / 999, 60 + Math.sin(i / 30)]);
  const d = G.downsample(pts, 80);
  assert.strictEqual(d.length, 80);
  assert.strictEqual(d[0], pts[0]);
  assert.strictEqual(d[79], pts[999]);
  assert.deepStrictEqual(G.downsample(pts.slice(0, 5), 80), pts.slice(0, 5));
});

function bigSong(nLayers, strokes, ptsPer, notes) {
  return {
    bpm: 112.4, key: 'F#', scale: 'dorian', sections: 4, regions: Array.from({ length: 63 }, (_, i) => (i + 1) / 64),
    layers: Array.from({ length: nLayers }, (_, L) => ({
      color: ['#FFC93C', '#ff6fa3', 'bad', '#6fffb0', '#c08bff', '#ff9f43', '#4fd1ff', '#ffffff'][L],
      runs: Array.from({ length: strokes }, (_, s) => Array.from({ length: ptsPer }, (_, i) => [(s + i / ptsPer) / strokes, 55 + L + 10 * Math.sin(i / 17)])),
      notes: Array.from({ length: notes }, (_, i) => [i / notes, (i + 0.5) / notes, 60 + (i % 12)]),
    })),
  };
}

test('buildMeta: a small song gets the finest whole-song grid', () => {
  const m = G.buildMeta(bigSong(1, 1, 300, 4));
  assert.strictEqual(m.bpm, 112);
  assert.strictEqual(m.key, 'F#');
  assert.strictEqual(m.scale, 'dorian');
  assert.strictEqual(m.sections, 4);
  assert.deepStrictEqual(m.layers, ['#ffc93c']);
  const pv = m.preview;
  assert.strictEqual(pv.v, 2);
  assert.strictEqual(pv.c, 192);
  assert.strictEqual(pv.l[0].s.length, 1, 'one stroke, one lane');
  assert.ok(pv.l[0].s[0].length > 180 && /^[A-Za-z0-9_-]+$/.test(pv.l[0].s[0]), 'the stroke spans the song: ' + pv.l[0].s[0]);
  assert.strictEqual(pv.l[0].n.length, 1, 'notes in one lane');
  assert.strictEqual(pv.l[0].n[0].replace(/\./g, '').length, 96, 'the 4 notes (each half of its quarter) are spread over the song');
  assert.ok(pv.lo <= 45 && pv.hi >= 65, pv.lo + '..' + pv.hi);
  assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 3500);
});

test('buildMeta: huge songs are downsampled under the caps (JSON text and jsonb estimate)', () => {
  for (const [L, s, n, notes] of [[8, 8, 2000, 300], [8, 16, 400, 0], [3, 2, 5000, 1000], [8, 1, 10, 500]]) {
    const m = G.buildMeta(bigSong(L, s, n, notes));
    const bytes = Buffer.byteLength(JSON.stringify(m));
    assert.ok(bytes <= 3500, 'text ' + bytes);
    assert.ok(G.jsonbBytes(m) <= G.META_JSONB_MAX, 'jsonb ' + G.jsonbBytes(m));
    assert.strictEqual(m.layers.length, L);
    assert.strictEqual(m.layers[2], L > 2 ? '#6fa3ff' : m.layers[2]);   // invalid colour replaced
    assert.ok(m.preview.l.some((l) => l.s.length || l.n.length), 'still has a preview');
  }
  // a long song keeps its whole length (not just its first strokes): 10 sections of strokes reach the last column
  const long = G.buildMeta(Object.assign(bigSong(4, 60, 200, 200), { regions: Array.from({ length: 159 }, (_, i) => (i + 1) / 160), secs: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] }));
  assert.strictEqual(long.preview.v, 2);
  const c = long.preview.c, reach = Math.max(...long.preview.l.map((l) => Math.max(...l.s.map((x) => x.length))));
  assert.ok(c >= 48 && reach >= c - 1, 'grid ' + c + ', lanes reach ' + reach);
  assert.deepStrictEqual(long.preview.r, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], 'too many regions: tint the sections');
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 3500 && G.jsonbBytes(long) <= G.META_JSONB_MAX);
  // a custom tighter cap downsamples harder
  const small = G.buildMeta(bigSong(2, 2, 500, 50), 600);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 600);
});

test('buildMeta ignores junk input', () => {
  const m = G.buildMeta({ bpm: NaN, layers: [null, { runs: [[[NaN, 1], [0.5, 60]], 'x'], notes: [[0, 1]] }], regions: [0, 2, 0.5, 'a'] });
  assert.strictEqual(m.bpm, 0);
  assert.deepStrictEqual(m.preview.r, [0.5]);
  assert.strictEqual(m.preview.l[1].s.length, 1);   // the one good point, in the middle column
  assert.strictEqual(m.preview.l[1].s[0].length, m.preview.c / 2 + 1);
  assert.deepStrictEqual(m.preview.l[1].n, []);
  assert.deepStrictEqual(G.buildMeta(undefined).preview, { v: 2, c: 0, r: [], l: [] });
});
