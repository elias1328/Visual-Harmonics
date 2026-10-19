# Visual Harmonics

**▶ Try it live: https://elias1328.github.io/Visual-Harmonics/**

Free, open experiments for *seeing* harmony, in the spirit of Chrome Music Lab. Here harmony is **calculated from the sound itself**. Every instrument is a stack of overtones. We measure them and work out, for every pitch, how roughly or smoothly it blends with the other notes (a Plomp–Levelt / Sethares dissonance model). Nothing comes from a music-theory table, so a bell, a piano and a sine wave each get their own map of what fits. Draw a melody on that map, explore an endless atlas of sounds, or play chords on a pitch spiral and watch the overtones line up.

## Experiments

| Tab | What it is | Key controls |
|---|---|---|
| **Melody** | Draw melody layers over a chord track. Bright bands show the notes that fit each chord *for the chosen instrument*. | Draw on the bands; tap a chord to change it. Tools: Pen `P`, Line `L`, Notes `N`, Select `V`, Erase `E`. `Space` plays or stops; `Ctrl+Z` / `Ctrl+Y` undo and redo. Also: mixer, share link, and MIDI / WAV / MP3 export. |
| **Babel** | An endless, zoomable map of sounds in eight biomes. Rare patterns sparkle, and 16 named Gems are hidden on it. | Drag to scrub; use the wheel or `+` / `−` to zoom; Shift-drag or middle-drag to pan. **Dive** jumps to a rare find. **Detector** ticks faster near a Gem, and after 10 Gems it also shows a compass arrow. **★ Save** sends a sound to your library. |
| **Spiral** | Play the pitch spiral directly. Where overtones of different notes line up, they glow. A ring in the middle shows how consonant the notes are. | Drag to play (multi-touch works). Chords: `1`–`6`. Keys `A W S E D F T G Y H U J K` play C4–C5. **Latch** (or Shift+click) holds notes; **Arpeggio** plays them in turn. |
| **Lab** | The original prototypes: harmony maps (Hz × Hz, triads, Ford circles, spiral), the timbre lab and the morph map. | (each prototype has its own controls) |

All experiments share one instrument picker, which offers synths, sampled instruments, and sounds you save from Babel.

## Run it locally

It is a static site with no build step. You can open `index.html` directly to try the synth sounds. Serve the folder instead so the sampled instruments can load, because browsers block `fetch` on `file://`:

On Windows, just double-click **`start.bat`**. It starts the server and opens the browser. Or run it yourself:

```sh
python -m http.server 8000
# then open http://localhost:8000/
```

Tests (Node 18+): `node --test`

## Publish on GitHub Pages

1. Push this folder to a GitHub repository.
2. On GitHub, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, pick your branch, and select the **/ (root)** folder. Save.
3. The site appears at `https://<user>.github.io/<repo>/`.

All paths are relative, so the site works under a sub-path. `.nojekyll` turns off Jekyll processing, and `404.html` sends unknown URLs back to the app.

## Layout

- `index.html`, `css/app.css`, `js/app.js`: app shell, hash routing (`#melody`, `#babel`, `#spiral`, `#lab`), shared UI
- `js/core/`: `harmony.js` (dissonance math), `audio.js` (engine), `sounds.js` (sound library), `analyze.js` (pitch and spectrum by FFT), `fx.js` (effects), `store.js` (local storage and share links)
- `js/exp/`: one module per experiment (`melody/` is split into parts)
- `assets/samples/`: sampled instruments, `manifest.json` and `CURATION.md`
- `prototypes/`: the original standalone pages (used by the Lab tab)
- `test/`: `node:test` unit tests

**Local-only samples:** `assets/samples-private/` holds a sample pack that has no redistribution rights. It is ignored by git (see `.gitignore`), and the app loads it only on a local dev server, where its sounds are marked "local". Never publish it.

## Credits

- Dissonance model after R. Plomp & W. J. M. Levelt and W. A. Sethares.
- Orchestral samples: VS Chamber Orchestra: Community Edition by Versilian Studios / Sam Gossner and Ivy Audio / Simon Dalzell. CC0 1.0. Homepage: vis.versilstudios.net/vsco-community.html. Requested: credit the authors; do not sell the samples directly. (See `assets/samples/CURATION.md` and `assets/samples/LICENSE`.)
- MP3 export: [lamejs](https://github.com/zhuker/lamejs) 1.2.1, a JavaScript port of [LAME](https://lame.sourceforge.net), licensed under the LGPL. It is vendored unmodified in `js/vendor/lamejs/` (with its `LICENSE` and `COPYING`) and loaded only when you export an MP3.

## Future work

- **Feed it a real sound.** Sing, whistle or drop in a recording. Extract its overtones (FFT peak picking) and show *that sound's* own harmony map to play on.
- **Timeline / melody layering.** Place sounds, chords and notes on a timeline in layers to build a melody. The harmony map shows where each moment lands as it plays back.

## License

The code is released under the [MIT License](LICENSE) © 2026 Elias Berntsen. Third-party parts keep their own licenses: the samples in `assets/samples/` are CC0 (VSCO-2-CE), and `js/vendor/lamejs/` is LGPL.
