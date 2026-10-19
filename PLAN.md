# Visual Harmonics: build plan

A free, open "experiments" website (in the spirit of Chrome Music Lab and Google Experiments) about *seeing* harmony. Static files only, no build step, hosted on GitHub Pages.

The hook: harmony is **calculated from the actual sound's overtones**, not looked up from music-theory tables. So every instrument, found sound or sample has its own "what fits" map.

## 1. Structure (target)
```
index.html             app shell: top bar + tabs (Melody · Babel · Spiral · Lab), hash routing (#melody …)
css/app.css            design tokens + shared components
js/core/harmony.js     (moved from /harmony.js) + new dissonanceSpectra()
js/core/audio.js       audio engine
js/core/sounds.js      shared Sound format + library
js/core/analyze.js     pitch + spectrum from an AudioBuffer (FFT)
js/core/store.js       localStorage + share links
js/app.js              shell / router
js/exp/melody.js, babel.js, spiral.js, lab.js
assets/samples/<instrument>/*.mp3 + assets/samples/manifest.json
prototypes/            the old pages, kept working (used by the Lab tab)
test/                  node:test unit tests
```
- Use classic `<script>` tags and one global namespace `window.VH` (no ES modules), so the page works from file://.
- Sample presets need HTTP (`python -m http.server`). On file://, show a small note instead of failing.

## 2. Shared contracts (all builders must follow these exactly)

**Experiment module:** `VH.registerExperiment({ id, title, icon, hint, mount(el), unmount() })`
- `unmount()` MUST stop all audio, cancel requestAnimationFrame and remove window/document listeners.

**Sound:**
```js
{ id, name, family, source: 'preset'|'babel'|'sample'|'import',
  kind: 'synth' | 'sampler',
  synth:   { partials: [[ratio, amp], ...], attack, decay, sustain, release, glide, noise, wobble },  // seconds; sustain 0..1; glide in semitones
  sampler: { zones: [{ url | blobKey, rootMidi }], release },
  spectrum: [[ratio, amp], ...] }   // <=16 entries, max amp 1. ALL harmony math uses this.
```

**Core API:**
- `VH.audio.ensure()`: only call it in gesture handlers. Master gain 0.3, with a limiter (DynamicsCompressor).
- `VH.audio.voice(sound, freq)` returns `{ setFreq(f, glideSec), setGain(g), stop(releaseSec) }` for sustained notes.
- `VH.audio.trigger(sound, freq, durSec)` plays a one-shot.
- The sampler picks the nearest zone by rootMidi, uses `playbackRate = freq / rootFreq`, and glides via playbackRate.
- `VH.harmony.dissonanceSpectra(freqs, spectrum)` sums pairDissonance over the spectrum partials of *different* notes.
- `VH.sounds`: `list()`, `get(id)`, `save(sound)`, `remove(id)`, `onChange(cb)`, `ready` (a Promise that resolves once the sample manifest has loaded, or failed gracefully).
  - Built-ins: ~8 synth presets (String, Sine, Clarinet, Bell, Organ, Pluck, Glass, Pad), plus sampler presets from the manifest.
  - Saved and imported sounds persist via VH.store. Imported audio goes in IndexedDB keyed by blobKey.
- `VH.analyze.fromBuffer(audioBuffer)` returns `{ rootHz, spectrum }`: pitch via autocorrelation or HPS, spectrum via FFT peak picking at harmonics and non-harmonic peaks.
- `VH.store`:
  - `get(k, def)` and `set(k, v)` with try/catch.
  - `encodeShare(obj)` and `decodeShare(str)`: JSON → deflate with CompressionStream when available → base64url, placed in the URL hash as `#melody/s=...`.

## 3. Design brief (the supervisor owns this; keep to it)
- Dark, calm, "museum exhibit" feel. The canvas is the hero, fills most of the viewport, and has minimal chrome.
- Top bar: "Visual Harmonics" wordmark on the left, pill tabs in the center, a ⓘ about button on the right.
- One floating **bottom dock** per experiment holds 3–6 primary controls (big, icon + label).
- Everything else goes in a **"⚙ More" drawer** that slides in from the right. Basic stays simple.
- A one-line hint per experiment appears on load and fades after the first interaction.
- Tokens:
  - bg `#0b0d12`, surface `#141824`, line `#262b3a`, text `#d8dce6`, muted `#7a8194`
  - accent `#6fa3ff`, glow `#9ff`
  - harmony palette: navy `#080a28` → violet `#611a8c` → cyan `#00bfdc` → white
  - radius 10px, system-ui font, no external fonts or CDNs
- Motion is subtle (150–250 ms ease). It must work at 400 px wide, with touch support. Show visible focus states.

## 4. Phases
- **Phase 1A (Foundation):** structure, core modules, design system, shell, Lab tab (iframes of `prototypes/`), and ports of melody, babel and spiral into experiment modules. Behaviour stays the same but they use core audio, the core style and the sound picker.
- **Phase 1B (Samples):** curate `C:\Users\elias\Documents\Dark Fantasy Samples` into `assets/samples` + `manifest.json` + `assets/samples/CURATION.md`. Runs in parallel with 1A.
- **Phase 2 (parallel, after 1A + 1B):**
  - **Melody upgrades:** chord preview on change, chord picker, more bars, per-layer instrument, note/rhythm mode, undo, share link.
  - **Babel upgrades:** new sound ingredients, rarity score + "rare find" markers, save to library.
  - **Spiral polish:** sound picker, sampler support.
- **Phase 3:** supervisor review, cross-experiment polish, README, GitHub Pages check.

## 4b. Phase 3: user feedback round (2026-10-19)

### Wave A (4 builders in parallel; file ownership is strict)
- **A1 Melody restructure + global UI** (owns `js/exp/melody*`, `css/melody.css`, `js/app.js`, `css/app.css`, `index.html`).
- **A2 Core audio** (owns `js/core/audio.js`, `sounds.js`, `analyze.js`, new `js/core/fx.js`, `test/`, and both `assets/*/manifest.json`).
- **A3 Babel v3** (owns `js/exp/babel.js`, `css/babel.css`).
- **A4 Spiral fixes** (owns `js/exp/spiral.js`, `css/spiral.css`).

### Wave B (after A1 + A2; parallel, on separate melody module files)
- **B1 Editing tools:** select, move, eraser, straight-line pen, vibrato on the selection, and auto-fit when a chord changes.
- **B2 Sound:** mixer + FX + drum lane + backing (drone) instrument and style.
- **B3 Export + generators:** MIDI/WAV/MP3 export, random progression/melody, and "harmony includes other layers".

### Core API additions (A2 implements; everyone may code against them; all are backward compatible)
**New Sound fields:**
- `play: 'glide' | 'hit'`
  - Synth presets and sustained families (strings, organ, flute, brass, tremolo, choir, pads) are `glide`.
  - Plucked, struck and percussive instruments (piano, harp, pizz, marimba, xylophone, glockenspiel, celesta, kalimba, babel percussive) are `hit`.
  - When the field is missing, derive it from `family`.

**Sampler zones** may carry `loopStart` and `loopEnd` (seconds).
- A2 computes them offline for glide-family instruments and writes them into both manifests.

**`voice(sound, freq, opts)` and `trigger(sound, freq, dur, opts)` options:**
- `gain`
- `dest`: an AudioNode to connect to; default is the master.
- `when`: an absolute ctx time.
- `tone`: `{ bright: -1..1 }`, a filter applied to any sound.

**`trigger` returns** `{ stop(rel) }`, which can cut the note early.

**Sampler voices are legato:**
- `setFreq` glides without retriggering.
- The sustain loops between the zone's loop points when they exist.
- The voice crossfades (~60 ms) to a better zone when it drifts more than 4 semitones from the current zone's root.

**New functions:**
- `VH.sounds.spectrumOf(sound, tone?)` returns the spectrum with the tone filter applied, so the harmony math stays truthful.
- `VH.sounds.derive(baseId, { partials?, stretch?, roll?, tone? })` saves a user sound named "<base> (custom)" with `source: 'custom'`.
  - Synths edit their partials.
  - Samplers can only take `tone`.
- `VH.audio.withContext(ctx, fn)` runs `fn` with `voice`/`trigger` targeting `ctx`, typically an OfflineAudioContext, for export rendering.
- `VH.audio.midiToHz` and `VH.audio.hzToMidi`.

**`VH.fx` (in `js/core/fx.js`):**
- `create(ctx, type, params)` returns `{ input, output, set(params), dispose() }`.
- Types: `reverb` (generated impulse; size, mix), `delay` (time, feedback, mix), `chorus`, `drive`, `lofi` (bits, rate), `filter` (cutoff, q).
- `chain(ctx, [fx...])` connects them in series.

### UI changes (A1)
- **Settings panel:** "⚙ More" becomes a "Settings" side panel that **pushes** the stage aside on desktop (≥ 900 px) instead of covering it. On phones it is a bottom sheet.
- **About:** the top-right ⓘ becomes a small text button "About", so it can't be confused with Settings.
- **Unified picker:** `VH.ui.soundPicker` groups sounds as Synths / Instruments / Your sounds / Local.
  - With `{ mode: 'line' }` it splits each group into "Glides well" and "Best for notes" (hit sounds are still selectable).

### Shared UI: shortcut sheet (E1, 2026-10-19)
- **"?"** (Shift+/) anywhere opens a keyboard-shortcut overlay (`.vh-sheet`): the current experiment's shortcuts plus the global ones ("?", Esc, Tab). Esc, the ✕ or a click on the backdrop closes it; experiment keys stay quiet while it is open.
- Experiments register their list once (at script load is fine):
  ```js
  const off = VH.ui.shortcuts.register('spiral', [{ keys: 'Space', label: 'Play / stop' }, { keys: 'Ctrl+Shift+Z / Ctrl+Y', label: 'Redo' }]);
  ```
  `keys`: `+` joins a combination, ` / ` separates alternatives. Registering again replaces the list; `off()` removes it.
- Also: `VH.ui.shortcuts.list(expId)`, `.global`, `.open()`, `.close()`, `.toggle()`, `.isOpen`.
- `VH.app.prev` is the id of the experiment mounted before the current one (e.g. to label inbox items).
- The Lab tab is labelled "Archive" (id and route stay `lab`).
- On file:// (sample library not loadable) a slim dismissible banner under the top bar says "Sampled instruments need a local server: double-click start.bat". Never on http(s).

## 5. Samples & licensing
- `assets/samples/`: the public **CC0 VSCO-2-CE** set. Credit "Versilian Studios / Sam Gossner & Ivy Audio / Simon Dalzell" in About and the README. Don't sell the samples directly.
- `assets/samples-private/`: the Dark Fantasy pack. It has no redistribution rights, so it is **local only and gitignored**. VH.sounds loads it if it's present and marks its sounds `private: true`.
