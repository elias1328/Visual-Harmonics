# Visual Harmonics

**▶ Try it live: https://elias1328.github.io/Visual-Harmonics/**

Free, open experiments for *seeing* harmony, in the spirit of Chrome Music Lab. Here harmony is **calculated from the sound itself**. Every instrument is a stack of overtones. We measure them and work out, for every pitch, how roughly or smoothly it blends with the other notes (a Plomp–Levelt / Sethares dissonance model). Nothing comes from a music-theory table, so a bell, a piano and a sine wave each get their own map of what fits.

## Experiments

| Tab | What it is | Key controls |
|---|---|---|
| **Melody** | Draw melody layers over a chord track. Bright bands show the notes that fit each chord *for the chosen instrument*. | Draw on the bands; tap a chord to change it. Tools: Pen `P`, Line `L`, Notes `N`, Select `V`, Erase `E`. `S` toggles snap, `=` / `−` zooms pitch, `Space` plays or stops, `Ctrl+Z` / `Ctrl+Y` undo and redo. |
| **Babel** | An endless, zoomable map of sounds in eight biomes. Rare patterns sparkle, and 16 named Gems are hidden on it. | Click to hear, drag to scrub, wheel or `=` / `−` to zoom, Shift-drag or middle-drag to pan. **Dive** jumps to a rare find. **Detector** ticks faster near a Gem (after 10 Gems it also shows a compass). **★ Save** adds a sound to your library. |
| **Spiral** | Play the pitch spiral directly. Where overtones of different notes line up, they glow; a ring in the middle shows how consonant the notes are. | Drag to play (multi-touch works). Chords `1`–`6`. Keys `A W S E D F T G Y H U J K` play C4–C5. **Latch** (or Shift+click) holds notes; **Arpeggio** plays them in turn. |
| **Gallery** | Songs other people made in Melody. Open one to play and edit it; like or report it. | Sort by new or top, search by title or author. Publish your own from Melody (Settings > Export > Share). |
| **Archive** | The original prototypes: harmony maps (Hz × Hz, triads, Ford circles, spiral), the timbre lab and the morph map. | (each prototype has its own controls) |

Press **`?`** anywhere for the keyboard shortcuts of the current tab.

All experiments share one instrument picker: synths, sampled orchestral instruments, sounds you save from Babel, sounds you build in the synth editor, and your own imported recordings (drop an audio file on Melody or use "Your sounds").

### Melody in more detail

- **Layers:** up to 8, each with its own instrument and a line (glide) or notes mode; mixer with volume, mute and solo.
- **Sections and arrangement:** split a song into named sections (verse, chorus …), each with its own bars, key and chords, and play one section in a loop or the whole song.
- **Chords and keys:** a chord picker with Roman numerals for the key, chord regions inside a bar, random progressions and melodies (🎲), and auto-fit of a line when its chord changes.
- **Tension:** a dial that moves the bright bands from the smoothest notes toward tenser ones.
- **Scales and tunings:** modes and exotic scales, plus tunings beyond 12-TET (just intonation, Pythagorean, 19 / 24 / 31-TET, slendro, pelog), with optional pure intonation.
- **Synth:** a synth editor (oscillators, filter, envelopes, LFO) and a Tone section that derives a brighter or darker copy of any instrument.
- **Sound:** effects per layer and global reverb / delay, a drum lane with kits, a backing (drone) instrument with styles, humanize and a harmony magnet.
- **Automation:** lanes for volume, effects and other targets, with breakpoints and smooth or linear curves.
- **Backing track:** import a beat or song (≤ 6 minutes); the app detects its tempo, beats, chords and key, plays it in sync and can draw the harmony map from the audio itself.
- **Export and sharing:** MIDI, WAV and MP3 export, share links (the whole song in the URL), and publishing to the Gallery.
- **Map look:** themes and clarity / thickness / glow controls for the harmony map, and a 5-step first-visit tutorial.

## Run it locally

It is a static site with no build step. Opening `index.html` directly works for the synth sounds, but browsers block `fetch` on `file://`, so serve the folder to load the sampled instruments:

- **Windows:** double-click **`start.bat`**. It starts a server on port 8000 and opens the browser.
- **Anywhere:** `python -m http.server 8000`, then open http://localhost:8000/.

## Tests

- **Unit tests** (Node 18+), from the repo root: `node --test`
- **End-to-end tests** (Playwright; starts its own server on port 8971):
  ```sh
  cd e2e
  npm install
  npx playwright install chromium firefox
  npx playwright test --project=chromium --project=firefox
  ```
  WebKit also runs (`--project=webkit`), but Playwright's Windows WebKit has no Web Audio, so its audio checks are skipped.
- `test/ntest.js` and `test/otest.js` are optional CDP browser checks (synth editor, Gallery); see their headers.

## Publish on GitHub Pages

1. Push this folder to a GitHub repository.
2. On GitHub, open **Settings → Pages**, choose **Deploy from a branch**, pick your branch and the **/ (root)** folder.
3. The site appears at `https://<user>.github.io/<repo>/`.

All paths are relative, so the site works under a sub-path. `.nojekyll` turns off Jekyll, and `404.html` sends unknown URLs back to the app. The Gallery backend is a Supabase project (schema and policies in `docs/gallery.sql`, public anon key in `js/core/config.js`).

## Layout

See [PLAN.md](PLAN.md) for the architecture and conventions, and [js/exp/melody/MELODY.md](js/exp/melody/MELODY.md) for Melody's internals.

**Local-only samples:** `assets/samples-private/` holds a sample pack with no redistribution rights. It is ignored by git, and the app loads it only when present (its sounds are marked "local"). Never publish it.

## Credits

- Dissonance model after R. Plomp & W. J. M. Levelt and W. A. Sethares.
- Orchestral samples: VS Chamber Orchestra: Community Edition by Versilian Studios / Sam Gossner and Ivy Audio / Simon Dalzell. CC0 1.0. Homepage: vis.versilstudios.net/vsco-community.html. Requested: credit the authors; do not sell the samples directly. (See `assets/samples/CURATION.md` and `assets/samples/LICENSE`.)
- MP3 export: [lamejs](https://github.com/zhuker/lamejs) 1.2.1, a JavaScript port of [LAME](https://lame.sourceforge.net), licensed under the LGPL. It is vendored unmodified in `js/vendor/lamejs/` (with its `LICENSE` and `COPYING`) and loaded only when you export an MP3.
- Privacy: anonymous visit counts via GoatCounter; no cookies, no personal data.

## License

The code is released under the [MIT License](LICENSE) © 2026 Elias Berntsen. Third-party parts keep their own licenses: the samples in `assets/samples/` are CC0 (VSCO-2-CE), and `js/vendor/lamejs/` is LGPL.
