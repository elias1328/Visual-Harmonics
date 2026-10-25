// Short share links + "My songs" (owner edit / remove), with the Supabase REST calls mocked (page.route): the live DB
// doesn't have the 2026-10 migration (docs/gallery.sql) until the owner pastes it, so these test the frontend only.
const { test: base, expect } = require('@playwright/test');
const crypto = require('crypto');

const test = base.extend({
  errors: [async ({ page }, use) => {
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if ((m.type() === 'error' || m.type() === 'warning') && !/goatcounter|AudioContext|favicon|samples-private/i.test(m.text() + (m.location().url || ''))) errs.push(m.text());
    });
    await use(errs);
    // The browser itself logs a failed (404) request as a console error: only those are allowed, and only in tests that ask.
    expect(errs.filter((e) => !(page._allow404 && /Failed to load resource.*(404|400)/.test(e))), 'page / console errors').toEqual([]);
  }, { auto: true }],
});

const ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const json = async (route, body, status = 200) => { await route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) }); return true; };
const missing = (route) => json(route, { code: 'PGRST202', message: 'Could not find the function' }, 404);

async function open(page, hash = '#melody') {
  await page.addInitScript(() => { try { localStorage.setItem('vh:melody.tutorial', '"done"'); } catch (_) { /* ignore */ } });
  await page.goto('/index.html' + hash);
  await page.waitForFunction(() => window.VH && VH.app && VH.app.current);
  if (/^#melody/.test(hash)) await page.waitForFunction(() => VH.melody.song && VH.melody.song());
}
// Routes every Supabase call to h(url, method, bodyText, route) -> true when handled; the rest answers an empty list.
async function mock(page, calls, h) {
  await page.route(/\/rest\/v1\//, async (route) => {
    const r = route.request(), url = r.url();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    calls.push({ url, method: r.method(), body: r.postData() });
    if (h && (await h(url, r.method(), r.postData(), route))) return;
    return json(route, []);
  });
}
const row = (over) => Object.assign({ id: ID, created_at: '2026-10-20T10:00:00Z', title: 'Mine', author: 'Me', meta: { bpm: 100, key: 'C', scale: 'major', sections: 1, layers: [], preview: { v: 2, c: 0, r: [], l: [] } }, likes: 2 }, over);
const shareNow = (page) => page.evaluate(() => VH.melody.ctx.share());

test.describe('short links', () => {
  test('Share gives #melody/l=<id> when create_share works', async ({ page }) => {
    const calls = [];
    await mock(page, calls, (u, m, b, route) => (/rpc\/create_share/.test(u) ? json(route, 'AbCd1234') : false));
    await open(page);
    await shareNow(page);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#melody/l=AbCd1234');
    const c = calls.find((x) => /create_share/.test(x.url));
    expect(JSON.parse(c.body).data).toMatch(/^[zj][A-Za-z0-9_-]+$/);
  });

  test('Share falls back to the long link when the migration is missing (404) or the answer is bad', async ({ page }) => {
    page._allow404 = true;
    const calls = [];
    await mock(page, calls, (u, m, b, route) => (/rpc\/create_share/.test(u) ? missing(route) : false));
    await open(page);
    await shareNow(page);
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#melody\/s=[zj]/);
    // remembered: a second Share doesn't call the server again
    const n = calls.filter((x) => /create_share/.test(x.url)).length;
    await shareNow(page);
    expect(calls.filter((x) => /create_share/.test(x.url)).length).toBe(n);
  });

  test('Share falls back when the server answers nonsense', async ({ page }) => {
    await mock(page, [], (u, m, b, route) => (/rpc\/create_share/.test(u) ? json(route, { x: 1 }) : false));
    await open(page);
    await shareNow(page);
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#melody\/s=[zj]/);
  });

  test('opening #melody/l=<id> calls get_share and loads the same song as the long link', async ({ page }) => {
    await mock(page, [], null);
    await open(page);
    // change the song a little so it differs from the default
    await page.evaluate(() => { VH.melody.ctx.setBpm ? VH.melody.ctx.setBpm(77) : null; });
    const code = await page.evaluate(() => VH.melody.ctx.shareCode());
    await page.evaluate(() => { try { localStorage.removeItem('vh:melody.song'); } catch (_) { /* ignore */ } });
    await page.goto('/index.html#melody/s=' + code);
    await page.reload();
    await page.waitForFunction(() => VH.melody.song && VH.melody.song());
    await page.waitForTimeout(600);
    const long = await page.evaluate(() => JSON.parse(VH.melody.song()));

    const calls = [];
    const p2 = await page.context().newPage();
    await mock(p2, calls, (u, m, b, route) => (/rpc\/get_share/.test(u) ? json(route, code) : false));
    await p2.addInitScript(() => { try { localStorage.setItem('vh:melody.tutorial', '"done"'); } catch (_) { /* ignore */ } });
    await p2.goto('/index.html#melody/l=AbCd1234');
    await p2.waitForFunction(() => VH.melody.song && VH.melody.song());
    await p2.waitForTimeout(600);
    expect(JSON.parse(calls.find((x) => /get_share/.test(x.url)).body)).toEqual({ id: 'AbCd1234' });
    const short = await p2.evaluate(() => JSON.parse(VH.melody.song()));
    expect(short).toEqual(long);
    await p2.close();
  });

  test('a broken short link shows a note and keeps the app alive', async ({ page }) => {
    await mock(page, [], (u, m, b, route) => (/rpc\/get_share/.test(u) ? json(route, null) : false));
    await open(page, '#melody/l=Zz9Zz9Zz');
    await expect(page.getByText('That short link couldn’t be loaded')).toBeVisible();
  });
});

test.describe('my songs', () => {
  test('Publish stores {id, secret} locally and sends only the SHA-256', async ({ page }) => {
    const calls = [];
    await mock(page, calls, (u, m, b, route) => (m === 'POST' && /\/rest\/v1\/songs$/.test(u) ? json(route, [row({ id: ID, title: 'Hello' })], 201) : false));
    await open(page);
    await page.evaluate(() => VH.melody.ctx.publish());
    await page.locator('.gl-title-in').fill('Hello');
    await page.locator('.gl-pub-go').click();
    await expect.poll(() => calls.some((x) => x.method === 'POST')).toBe(true);
    const post = calls.find((x) => x.method === 'POST');
    const body = JSON.parse(post.body);
    expect(body.owner_hash).toMatch(/^[0-9a-f]{64}$/);
    const keys = await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vh:gallery.keys') || '[]'))).toHaveLength(1).then(() => page.evaluate(() => JSON.parse(localStorage.getItem('vh:gallery.keys'))));
    expect(keys[0].id).toBe(ID);
    expect(keys[0].secret).toMatch(/^[0-9a-f]{32}$/);
    expect(post.body).not.toContain(keys[0].secret);
    expect(crypto.createHash('sha256').update(keys[0].secret).digest('hex')).toBe(body.owner_hash);
  });

  test('Publish without the migration (unknown column) posts unowned and stores no key', async ({ page }) => {
    page._allow404 = true;
    const calls = [];
    await mock(page, calls, (u, m, b, route) => {
      if (m !== 'POST' || !/\/rest\/v1\/songs$/.test(u)) return false;
      if (b.includes('owner_hash')) return json(route, { code: 'PGRST204', message: "Could not find the 'owner_hash' column" }, 400);
      return json(route, [row({ title: 'Plain' })], 201);
    });
    await open(page);
    await page.evaluate(() => VH.melody.ctx.publish());
    await page.locator('.gl-title-in').fill('Plain');
    await page.locator('.gl-pub-go').click();
    await expect.poll(() => calls.filter((x) => x.method === 'POST').length).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem('vh:gallery.keys'))).toBeNull();
  });

  const SECRET = 'a'.repeat(32);
  const seed = (page) => page.addInitScript(([id, secret]) => {
    if (!localStorage.getItem('vh:gallery.keys')) localStorage.setItem('vh:gallery.keys', JSON.stringify([{ id, secret, title: 'Mine', date: 1 }]));
  }, [ID, SECRET]);
  const byIds = (u, m, b, route) => (m === 'GET' && /id=in\./.test(u) ? json(route, [row()]) : false);

  test('My songs lists own songs; Update, Rename and Remove call the RPCs with the secret', async ({ page }) => {
    const calls = [];
    await seed(page);
    await mock(page, calls, (u, m, b, route) => (/rpc\/(update_own_song|delete_own_song)/.test(u) ? json(route, true) : /\/code$|select=code/.test(u) ? json(route, [{ code: 'zAAAAAAAAAAAA' }]) : byIds(u, m, b, route)));
    await open(page);   // gives Melody an autosave to update from
    await page.waitForTimeout(500);
    await page.evaluate(() => { location.hash = '#gallery'; });
    await page.waitForFunction(() => VH.app.current === 'gallery');
    await page.locator('[data-scope="mine"]').click();
    await expect(page.locator('.gl-mine-note')).toContainText('Only this browser can edit these');
    const card = page.locator('.gl-card[data-id="' + ID + '"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Mine');

    await card.locator('.gl-upd').click();
    await card.locator('.gl-ask-ok').click();
    await expect(card).toContainText('Updated');
    const up = JSON.parse(calls.find((x) => /update_own_song/.test(x.url)).body);
    expect(up).toMatchObject({ song_id: ID, secret: SECRET, title: 'Mine' });
    expect(up.data).toMatch(/^[zj]/); expect(typeof up.meta).toBe('object');

    await card.locator('.gl-ren').click();
    await card.locator('.gl-ask-in').fill('Renamed');
    await card.locator('.gl-ask-ok').click();
    await expect(card.locator('.gl-title')).toHaveText('Renamed');
    const ups = calls.filter((x) => /update_own_song/.test(x.url));
    expect(JSON.parse(ups[1].body)).toMatchObject({ song_id: ID, secret: SECRET, title: 'Renamed', data: 'zAAAAAAAAAAAA' });

    await card.locator('.gl-rm').click();
    await card.locator('.gl-ask-ok').click();
    await expect(page.locator('.gl-card[data-id="' + ID + '"]')).toHaveCount(0);
    expect(JSON.parse(calls.find((x) => /delete_own_song/.test(x.url)).body)).toEqual({ song_id: ID, secret: SECRET });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vh:gallery.keys')))).toEqual([]);
  });

  test('edit buttons are hidden when the RPCs are missing (migration not run)', async ({ page }) => {
    page._allow404 = true;
    await seed(page);
    await mock(page, [], (u, m, b, route) => (/rpc\/(update_own_song|delete_own_song)/.test(u) ? missing(route) : byIds(u, m, b, route)));
    await open(page, '#gallery');
    await page.waitForFunction(() => VH.app.current === 'gallery');
    await page.locator('[data-scope="mine"]').click();
    const card = page.locator('.gl-card[data-id="' + ID + '"]');
    await expect(card.locator('.gl-rm')).toBeVisible();
    await card.locator('.gl-rm').click();
    await card.locator('.gl-ask-ok').click();
    await expect(card.locator('.gl-open')).toBeVisible();
    await expect(page.locator('.gl-card .gl-rm, .gl-card .gl-upd, .gl-card .gl-ren')).toHaveCount(0);
    await expect(card).toContainText('Editing isn’t available yet');
  });

  test('keys can be exported and imported', async ({ page }) => {
    await seed(page);
    await mock(page, [], byIds);
    await open(page, '#gallery');
    await page.waitForFunction(() => VH.app.current === 'gallery');
    await page.locator('[data-scope="mine"]').click();
    await page.evaluate(() => { localStorage.removeItem('vh:gallery.keys'); });
    await page.locator('.gl-mine-imp').click();
    await page.locator('.gl-keys-ta').fill(JSON.stringify([{ id: ID, secret: SECRET, title: 'Back', date: 2 }]));
    await page.locator('.gl-keys-go').click();
    await expect(page.locator('.gl-card[data-id="' + ID + '"]')).toBeVisible();
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('vh:gallery.keys'))))[0].secret).toBe(SECRET);
  });
});
