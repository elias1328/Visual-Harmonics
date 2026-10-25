# Visual Harmonics: architecture & conventions

A static site (no build step, no framework, no CDN) hosted on GitHub Pages. Harmony is computed from each sound's own overtones (Plomp–Levelt / Sethares dissonance), never looked up in theory tables.

## 1. Module map

```
index.html              shell markup, About dialog, script load order (classic <script> tags, one global window.VH)
css/app.css             design tokens + shared components (dock, Settings panel, sheets, toasts, cards)
css/<exp>.css           one stylesheet per experiment
js/core/config.js       VH.config: public site config (Gallery URL + Supabase anon key)
js/core/harmony.js      VH.harmony: pure math. Dissonance, note names, scales, chord qualities, tunings
js/core/store.js        VH.store: localStorage (JSON), share codes, IndexedDB blobs, start-up housekeeping
js/core/analyze.js      VH.analyze: FFT, pitch + spectrum, loop finding, import analysis, backing-track analysis
js/core/synth.js        VH.synth: the "synth.v2" subtractive model (pure data)
js/core/audio.js        VH.audio: Web Audio engine (voices, sampler, limiter, offline rendering)
js/core/sounds.js       VH.sounds: the sound library (presets, samples, saved, imported, derived)
js/core/fx.js           VH.fx: effect units (reverb, delay, chorus, drive, lofi, filter)
js/app.js               VH.ui (shared widgets, sound picker, import, shortcut sheet) + router (VH.app)
js/core/synthed.js      VH.synthEditor: the synth editor dialog (needs VH.ui, so it loads after app.js)
js/exp/melody/          Melody, split into a core and parts. See js/exp/melody/MELODY.md
js/exp/babel.js         Babel (endless sound map, Gems, Detector)
js/exp/spiral.js        Spiral (pitch spiral, chords, latch, arpeggio, harmony meter)
js/exp/gallery.js       Gallery tab + the Publish dialog (Supabase PostgREST over fetch)
js/exp/lab.js           Archive tab (id/route `lab`): iframes of prototypes/
js/vendor/lamejs/       MP3 encoder (LGPL), lazy-loaded on the first MP3 export
assets/samples/         VSCO-2-CE samples + manifest.json (CC0). assets/samples-private/ is local-only and gitignored
docs/gallery.sql        Gallery schema, row-level security and RPCs
test/                   node:test unit tests (+ ntest.js / otest.js optional CDP browser checks)
e2e/                    Playwright smoke suite (Chromium, Firefox, WebKit)
```

Load order (index.html): config, harmony, store, analyze, synth, audio, sounds, fx, app, synthed, melody parts (model → main), babel, spiral, gallery, lab, then `VH.app.start()`.

## 2. Core API (summary)

- **Experiment:** `VH.registerExperiment({ id, title, icon, hint, mount(el), unmount() })`. `unmount()` must stop all audio, cancel rAF and remove window/document listeners. Routes are `#<id>`; `VH.app.sub` holds the rest of the hash (e.g. `#melody/s=<code>`).
- **Sound:** `{ id, name, family, source: 'preset'|'sample'|'babel'|'import'|'custom', kind: 'synth'|'sampler', play: 'glide'|'hit', synth | sampler: { zones: [{ url | blobKey, rootMidi, loopStart?, loopEnd? }], release }, spectrum: [[ratio, amp]], tone?: { bright } }`. All harmony math uses `VH.sounds.spectrumOf(sound)` (tone applied).
- **VH.audio:** `ensure()` (only in gesture handlers), `voice(sound, hz, { gain, dest, when, tone })` → `{ setFreq, setGain, stop }`, `trigger(sound, hz, dur, opts)` → `{ stop }`, `withContext(offlineCtx, fn)` for export, `midiToHz`, `hzToMidi`, `stats()`.
- **VH.sounds:** `list`, `get`, `save`, `remove`, `onChange`, `ready`, `prepare(id)`, `spectrumOf`, `playOf`, `derive(baseId, { partials?, stretch?, roll?, tone? })`.
- **VH.harmony:** `NAMES`, `midiToHz`, `noteName`, `dissonanceSpectra`, `SCALES`, `scaleChords`, `romanOf`, `CHORD_IV` / `CHORD_Q` / `CHORD_SUFFIX` (the one chord-quality table; Melody's `model.QUALS`, Spiral and analyze.js derive from it), `TUNINGS` and helpers.
- **VH.store:** `get(k, def)` / `set(k, v)` / `remove(k)` (prefix `vh:`, memory fallback), `encodeShare` / `decodeShare` (JSON → deflate-raw → base64url, prefix `z` or `j`), `putBlob` / `getBlob` / `delBlob` / `blobKeys`, `tidy()`, `gcBlobs()`.
- **VH.ui:** `h`, `esc`, `dockButton`, `dockSelect`, `soundPicker` (groups Synths / Instruments / Your sounds / Local; `{ mode: 'line' }` splits by "Glides well" / "Best for notes"), `select`, `slider`, `drawer(el, dock, o)` (the Settings side panel; a bottom sheet on phones), `importSounds`, `manageSounds`, `deleteSound(id)` (also frees unshared audio), `wavBlob`, `noteName`, `shortcuts.register(expId, [{ keys, label }])` for the `?` sheet.

## 3. Conventions

- **File ownership:** each experiment owns its `js/exp/<id>*` and `css/<id>.css`; the core (`js/core`, `js/app.js`, `css/app.css`) is shared and changes must stay backward compatible. Melody parts edit only their own file and extend Melody through `M` hooks (MELODY.md); do not wrap `M.*` or `VH.audio.*` functions or patch another part's DOM.
- **Shared helpers live in core:** note names, Hz/MIDI conversion, chord tables, WAV encoding and option grouping come from `VH.harmony`, `VH.audio` and `VH.ui`. Small `clamp` one-liners stay local in files that must also load alone in Node (fx.js, model.js, export.js).
- **Storage keys:** every `vh:` key used in the `babel.` / `melody.` / `spiral.` / `lab.` namespaces must be listed in `VH.store.KEYS` (a unit test scans the sources). On start, `tidy()` removes unlisted keys there, i.e. leftovers of older versions (`babel.rarity`, `babel.radar`, old melody keys). `ui.*` and `gallery.*` keys are dynamic and left alone.
- **Shortcuts:** every key handler has a matching line in the experiment's `shortcuts.register` list, and tooltips name their key as `Name (Key): what it does`.
- **Design:** dark "museum exhibit" look; the canvas is the hero; one bottom dock with 3–6 primary controls; everything else in Settings. Tokens in css/app.css (bg `#0b0d12`, accent `#6fa3ff`, glow `#9ff`, radius 10px, system-ui). Works at 400 px wide, with touch and visible focus.
- **Performance:** rAF loops draw only when something changed (Spiral stops its loop when idle); Melody caches the harmony map and, during playback, the layer stack as bitmaps.

## 4. Storage

- **localStorage** (`vh:` prefix): preferences, the autosaved Melody song (`melody.song`), saved sounds (`sounds`), kits, tones, the cross-experiment inbox (`melody.inbox`). Undo history is in memory only.
- **IndexedDB** (`visual-harmonics` / `blobs`): imported audio, Babel sampler saves (`babel-…`), backing tracks (`track:…` and their analysis `track:…:an`).
- **Garbage collection** (`VH.store.gcBlobs`, run once per start while idle from `app.js`): a blob is kept when its key (or, for `…:an`, its track key) appears anywhere in a saved `vh:` value or in the live Melody state (song + undo history). The rules err on keeping: nothing happens without readable localStorage; blobs written this session are kept; an orphan is deleted only if it was already an orphan on a run at least a day earlier (marks in `vh:store.gc`), so another open tab is safe.

## 5. Share and Gallery data flow

1. **Share link:** Melody serializes the song (own editor synths travel in portable form via `VH.sounds.portable`; imported audio and the backing track do not) → `VH.store.encodeShare` → `#melody/s=<code>`. Opening the link decodes, installs missing synths and loads the song as one undo step.
2. **Publish:** Melody's Publish dialog (`VH.gallery.openPublish`) sends `{ title, author, code, meta }` to Supabase `songs` (meta = a small preview for the card: since v 2 a fixed grid of columns over the whole song, one char per column per lane, so long songs fit the same jsonb budget; v 1 rows with point lists still draw). Row-level security and RPCs (`like_song`, `report_song`) are in `docs/gallery.sql`; the browser holds only the public anon key.
3. **Browse and open:** the Gallery lists rows (`select=id,created_at,title,author,meta,likes`, new or top, search) and draws previews from `meta`. Opening a song fetches its `code`, pushes `{ type: 'song', code, title, author, from: 'gallery' }` to `vh:melody.inbox` and routes to `#melody`, which consumes the inbox.
4. Likes, reports and "mine" are remembered locally (`gallery.liked` / `gallery.reported` / `gallery.mine`).

## 6. Testing

- **Unit:** `node --test` (repo root). Pure modules (harmony, store, analyze, sounds, synth, melody model / export helpers, gallery helpers) load in Node via `module.exports`; `test/beatgen.js` makes synthetic beats for the backing-track analysis.
- **E2E:** `cd e2e && npx playwright test --project=chromium --project=firefox`. Each test fails on uncaught errors and unexpected console errors / warnings. Assertions use observable behaviour: DOM, `VH.audio.stats()`, `VH.melody.song()`, real downloads and IndexedDB.
- **Optional CDP checks:** `test/ntest.js` (synth editor) and `test/otest.js` (Gallery) against a headless Edge/Chrome; skipped under `node --test`.
- Keep both suites green; a test may change only when the user-visible behaviour it checks is unchanged.

## 7. Samples and licensing

- `assets/samples/`: CC0 VSCO-2-CE. Credit "Versilian Studios / Sam Gossner & Ivy Audio / Simon Dalzell" in About and the README; do not sell the samples directly.
- `assets/samples-private/`: local-only pack without redistribution rights, gitignored; loaded when present, sounds marked `private: true` ("local").
- Code: MIT. lamejs: LGPL, vendored unmodified.
