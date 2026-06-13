# 🥁 DrumCoach

A browser-based drum-practice coach powered by Node.js. Play an acoustic or
electronic kit near your microphone and DrumCoach will:

- **Listen** to your microphone and detect drum onsets in real time
- **Classify** each hit as **kick, snare, tom 1/2/3, hi-hat, ride, or crash**
- **Notate** what you played on a live, scrolling standard drum staff
- **Measure your timing** — live BPM, steadiness, and how far you are drifting
- **Metronome** with visual + audible click so you can lock to a tempo
- **Score your accuracy** against a pattern you annotate on a 4 / 8 / 16-bar sheet

Inspired by [Tone.js' step sequencer](https://github.com/Tonejs/Tone.js/blob/main/examples/stepSequencer.html)
and [Chrome Music Lab: Rhythm](https://musiclab.chromeexperiments.com/Rhythm/).

> ⚠️ **On drum recognition:** classifying drum hits from a single microphone is a
> hard problem. DrumCoach uses lightweight spectral heuristics (onset detection +
> frequency-band energy + spectral centroid), which works well for isolated hits
> and practice, but is not a trained ML model. Calibration is provided to adapt to
> your kit and room.

---

## Quick start

```bash
# 1. Install the latest Node via Homebrew (one-time)
./setup.sh

# 2. Install dependencies
npm install

# 3. Run
npm start
# open the printed http://localhost:3000 and allow microphone access
```

A microphone and a modern Chromium-based browser (Chrome/Edge/Brave) are
recommended for the best Web Audio support.

---

## Project plan

The app is split into focused modules so each can be built and committed on its own:

| Module | File | Responsibility |
| ------ | ---- | -------------- |
| Server | `server.js` | Serves the static client over HTTP |
| Notation | `public/js/notation.js` | Draws the live scrolling drum staff |
| Audio engine | `public/js/audio-engine.js` | Mic capture, onset detection, drum classification |
| Timing | `public/js/timing.js` | BPM estimation + drift / steadiness analysis |
| Metronome | `public/js/metronome.js` | Scheduled click + visual beat indicator |
| Sequencer | `public/js/sequencer.js` | Annotate a 4/8/16-bar pattern, score the player |
| Drum synth | `public/js/drum-synth.js` | Web Audio drum-voice synth for the per-row sample previews |
| Kit profiles | `public/js/profiles-store.js` | Persist named calibration profiles to localStorage |
| App | `public/js/app.js` | Wires modules together and owns UI state |

### Architecture at a glance

```
microphone → AudioEngine (onset + classify) ──┐
                                               ├──► App (state) ──► Notation (draw)
metronome clock ──► Timing (BPM / drift) ──────┘                └─► Sequencer (score)
```

---

## ✅ TODO / progress

Commits are made as items are ticked off.

- [x] **T0** — Scaffold project: README, `package.json`, `.gitignore`, brew `setup.sh`, git init
- [x] **T1** — Node static server (`server.js`) + base HTML/CSS shell
- [x] **T2** — Drum staff notation renderer (live scrolling canvas)
- [x] **T3** — Microphone capture + onset detection
- [x] **T4** — Drum classification (kick / snare / toms / hi-hat / ride / crash) + calibration
- [x] **T5** — Timing engine: live BPM, steadiness, drift indicator
- [x] **T6** — Metronome with audible click + visual beat
- [x] **T7** — Pattern sequencer: annotate 4/8/16 bars and score accuracy
- [x] **T8** — Wire everything in `app.js` + polish UI
- [x] **T9a** — Persist named calibration **kit profiles** to localStorage (save / switch / delete / forget)
- [ ] **T9** — Stretch: persist patterns to localStorage, export MIDI, latency calibration wizard

---

## How the drum recognition works

1. **Onset detection** — the engine tracks short-term energy (spectral flux). A
   sharp rise above an adaptive threshold marks a new hit and starts a short
   capture window.
2. **Feature extraction** — for the captured window it computes total energy,
   per-band energy (sub/low/low-mid/mid/high/very-high), spectral centroid, and
   decay length.
3. **Classification** — a rule-based scorer maps those features to the most likely
   drum voice. Thresholds live in `DRUM_PROFILES` and can be nudged by the
   **Calibrate** panel so the app adapts to your kit.

| Voice | Dominant cue |
| ----- | ------------ |
| Kick | strong sub/low energy, low centroid |
| Snare | broadband + noisy, mid centroid, short decay |
| Tom 1/2/3 | tonal mid energy; centroid high→low picks 1→3 |
| Hi-hat | bright high/very-high energy, very short decay, highest centroid |
| Ride | high-band energy, longer decay, lower level |
| Crash | very-high broadband energy, loud, long decay |

### Kit profiles (saved calibration)

Calibration is stored as a named **kit profile** so you can keep one per drum
kit / room and switch between them. Profiles persist in the browser via
`localStorage` (key `drumcoach.kits.v1`), handled by `public/js/profiles-store.js`:

- **Save** the current calibration under a name (re-saving the same name updates it).
- Pick a saved kit from the **dropdown** to load it; the last-used kit is
  restored automatically on the next visit.
- **Delete** removes a saved kit; **Forget calibration** reverts the live engine
  to default profiles without touching anything you've saved.
- Calibrating a voice while a kit is active **auto-saves** into that kit.

### Voice rejection

Microphones pick up talking and singing, which can fire false hits. The
**Voice rejection** selector (in the Settings panel) filters these out
without touching drum detection:

| Mode | What it does |
| ---- | ------------ |
| **Off** | Pipeline unchanged — every onset is treated as a drum |
| **Moderate** | A 3-test gate: rejects an onset only when it is **sustained** (doesn't decay) **and** **harmonic** (low spectral flatness) **and** **speech-banded** (200–3400 Hz). All three are needed, so kick (wrong band), snare/cymbals (too noisy), and toms (decay too fast) are always kept |
| **Aggressive** *(default)* | The 3-test gate **plus** a voice-activity detector that also blocks pitched, speech-banded onsets struck while you're mid-talking |

The gate watches ~80 ms of decay before deciding, so a filtered-or-not note
appears ~90 ms later — but hits are timestamped at the **true onset**, so BPM,
drift, and scoring stay exact. Calibration bypasses the gate entirely.

---

## Timing & scoring

- **Live BPM** is derived from inter-onset intervals (median of recent hits,
  folded to a sensible 40–240 BPM range).
- **Drift** compares your hit times to the nearest metronome grid line; a running
  signed average tells you if you are rushing (ahead) or dragging (behind).
- **Pattern score** lines up detected hits against the annotated grid within a
  timing window and reports hits / misses / extra notes and an accuracy %.

---

## Scripts

| Command | Does |
| ------- | ---- |
| `npm start` | Start the server on `:3000` |
| `npm run dev` | Start with auto-reload (`node --watch`) |

---

## License

MIT
