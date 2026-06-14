# 🥁 DrumCoach

A browser-based, **mobile-first** drum-practice coach — a static web app (Node is
only used to serve it locally). Play an acoustic or electronic kit near your
microphone and DrumCoach will:

- **Listen** to your microphone and detect drum onsets in real time
- **Classify** each hit as **kick, snare, tom 1/2/3, hi-hat, ride, or crash**
- **Notate** what you played on a live, scrolling standard drum staff
- **Measure your timing** — live BPM, steadiness, and how far you are drifting
- **Metronome** with visual + audible click so you can lock to a tempo
- **Build & score patterns** — opens with a 1-bar eighth-note rock beat (hi-hats throughout, snare on 2 & 4, kick on 1 & 3); add toms/ride/crash, change resolution, and score how cleanly you play it
- **Play your pattern back** through a built-in drum synth (the tempo follows the metronome), with an optional loop

Inspired by [Tone.js' step sequencer](https://github.com/Tonejs/Tone.js/blob/main/examples/stepSequencer.html)
and [Chrome Music Lab: Rhythm](https://musiclab.chromeexperiments.com/Rhythm/).

The UI is a light, mobile-first design (a kid plays with a phone/tablet by the
kit): `mic → 1 Set your beat → 2 Play along → Live staff → Patterns → Settings`,
with a guided onboarding sheet. The design template and rebuild plan live in
[`design/`](./design/) (`drumcoach-redesign.html` + `REDESIGN.md`).

> ⚠️ **On drum recognition:** classifying drum hits from a single microphone is a
> hard problem. DrumCoach uses lightweight spectral heuristics (onset detection +
> frequency-band energy + spectral centroid), which works well for isolated hits
> and practice, but is not a trained ML model. Calibration is provided to adapt to
> your kit and room.

---

## Quick start

```bash
# 1. Use the project's Node (pinned to 20 via .nvmrc)
nvm install && nvm use     # or ./setup.sh to install the latest Node via Homebrew

# 2. Install dependencies
npm install

# 3. Run
npm start
# open the printed http://localhost:3000 and allow microphone access
```

A microphone and a modern Chromium-based browser (Chrome/Edge/Brave) are
recommended for the best Web Audio support.

> The Node server (`server.js`) is only for local development — it serves the
> static client over `http://localhost`. In production the app is a fully static
> site (see Hosting below); it makes no server calls.

---

## Hosting (GitHub Pages)

The app is a static client (everything in `public/`), so it's hosted on
**GitHub Pages** from a `gh-pages` branch that mirrors the `public/` folder —
no server and no build step. The `gh-pages` branch is produced from `public/`
with `git subtree`, so `public/` stays the single source of truth.

Live URL: **<https://drumcoach.nig.fm>** (custom domain → GitHub Pages)

### One-time setup

1. **Point Pages at the branch** — repo **Settings → Pages → Build and
   deployment → Source → Deploy from a branch**, then choose **`gh-pages`** and
   folder **`/ (root)`**.
2. **Activate the deploy hook** in your local clone (git config isn't stored in
   the repo, so do this once per clone):
   ```bash
   git config core.hooksPath .githooks
   ```
3. **Seed the branch** (first deploy):
   ```bash
   git push --force origin "$(git subtree split --prefix public main):refs/heads/gh-pages"
   ```

### Deploying

Just push `main` — the tracked `pre-push` hook (`.githooks/pre-push`) deploys for
you:

```bash
git push origin main      # → also updates origin/gh-pages from public/
```

The hook splits the `public/` subtree and **force-pushes** it to `gh-pages`
(a generated branch, so force is intentional — it avoids "non-fast-forward"
rejections when `gh-pages` diverges, e.g. GitHub adding a `CNAME` commit). It
only fires for `main`/`master` pushed to `origin`, doesn't recurse on the inner
`gh-pages` push, and if the deploy fails it just warns (your `main` push still
goes through). To deploy manually at any time:

```bash
git push --force origin "$(git subtree split --prefix public main):refs/heads/gh-pages"
```

### Notes

- The microphone needs a secure context; GitHub Pages is served over **HTTPS**,
  so mic capture works.
- Kit profiles and patterns are saved in the browser's `localStorage`, so there's
  nothing to persist server-side.
- All asset paths are relative, so the app works whether it's served at the
  custom-domain root (`drumcoach.nig.fm`) or under a `/drumcoach/` project-page
  subpath.
- **Custom domain + subtree deploys:** because `git subtree push` overwrites the
  `gh-pages` branch, the GitHub Pages `CNAME` file must live in the repo at
  `public/CNAME` (containing `drumcoach.nig.fm`) so it survives each deploy.
  A DNS record alone won't keep it — without `public/CNAME`, the next deploy
  wipes the custom-domain setting and Pages falls back to the `github.io` URL.

---

## Cross-device sync (optional · Firebase)

By default DrumCoach stores kit profiles and patterns only in the browser's
`localStorage`. You can optionally enable **cross-device sync** backed by
Firebase. It's off until configured — the app works exactly the same without it.

How it behaves:
- On load you're signed in **anonymously**, so your kits/patterns back up to the
  cloud immediately — no login wall.
- The **☁ Sync across devices** button (top right) links that anonymous account
  to **Google** (one click). The same uid is kept, so your data carries over.
- On another device, click the button and sign in with the same Google account →
  the same kits/patterns appear.
- If that Google account was already used on another device, signing in **merges**
  this device's local data into the account (union by id, newest wins) — nothing
  is lost. `localStorage` stays the offline cache; only the data maps sync (your
  current selection stays per-device).

### Setup

1. Create a project at <https://console.firebase.google.com> and add a **Web app**.
2. **Authentication → Sign-in method:** enable **Anonymous** and **Google**.
3. **Authentication → Settings → Authorized domains:** add your Pages domain
   (`drumcoach.nig.fm`) so the Google popup works in production.
4. **Firestore Database:** create one (production mode) and set these rules so each
   user can only touch their own document:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```
5. Paste your web config into `public/js/firebase-config.js`
   (`apiKey`, `authDomain`, `projectId`, `appId`). The `apiKey` is **not a secret**
   — Firebase web config is public; security comes from the rules above.

Implementation: `public/js/cloud-sync.js` (loads the Firebase SDK from the CDN
only when configured) syncs `users/{uid}` ↔ the `ProfileStore`/`PatternStore`
maps. Known v1 limitations: simultaneous edits on two devices are last-write-wins,
and a delete can reappear if a long-offline device re-syncs stale data.

---

## Project plan

The app is split into focused modules so each can be built and committed on its own:

| Module | File | Responsibility |
| ------ | ---- | -------------- |
| Server | `server.js` | Serves the static client over HTTP (local dev only) |
| Notation | `public/js/notation.js` | Draws the live scrolling drum staff |
| Audio engine | `public/js/audio-engine.js` | Mic capture, onset detection, classification, sensitivity, voice rejection |
| Timing | `public/js/timing.js` | BPM estimation + drift / steadiness / tightness |
| Metronome | `public/js/metronome.js` | Scheduled click + visual beat indicator |
| Sequencer | `public/js/sequencer.js` | 1–16 bar pattern (quarter/eighth/sixteenth) + scoring |
| Drum synth | `public/js/drum-synth.js` | Web Audio drum-voice synth for previews + pattern playback |
| Pattern player | `public/js/pattern-player.js` | Lookahead scheduler that plays the pattern (looping optional) |
| Pattern store | `public/js/pattern-store.js` | Persist named patterns per kit to localStorage |
| Kit profiles | `public/js/profiles-store.js` | Persist named calibration profiles to localStorage |
| Cloud sync | `public/js/cloud-sync.js` + `firebase-config.js` | Optional cross-device sync via Firebase |
| App | `public/js/app.js` | Wires modules to the UI; owns view state |

### Architecture at a glance

```
            ┌─ shared AudioContext clock ─────────────────────────────┐
mic ─► AudioEngine (onset + classify)        Metronome ─► Timing (BPM/drift/tight)
            │                                     │
            └────────────► App (UI state) ◄───────┘
                              │   ├─► Live staff (Notation) + Play-along metrics
                              │   └─► Sequencer (grid + scoring) ─► PatternPlayer ─► DrumSynth
                              ▼
            ProfileStore / PatternStore ◄─► localStorage ◄─► CloudSync (Firebase, optional)
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
- [x] **T9b** — Play the pattern through a built-in **drum synth**, with an optional loop
- [x] **T9c** — Persist named **patterns per kit** to localStorage (save / load / delete, auto-restore)
- [x] **T9d** — Optional **cross-device sync** (Firebase anonymous auth → Google link, merge on conflict)
- [x] **T10** — Light, **mobile-first redesign** ([`design/REDESIGN.md`](design/REDESIGN.md)): onboarding sheet, plain-language metrics + ⓘ glosses, single shared tempo, add-drums (toms/ride/crash) to the pattern, subdivision selector, two-tap delete, drum-type icons + synth previews
- [x] **T11** — Recognition tuning: measured default profiles, a single **sensitivity** control (only-loud → catch-quiet), and **"Calibrate to the built-in kit"** auto-calibration
- [ ] **Stretch** — export MIDI, latency calibration wizard

---

## How the drum recognition works

1. **Onset detection** — the engine tracks short-term energy (spectral flux). A
   sharp rise above an adaptive threshold marks a new hit and starts a short
   capture window.
2. **Feature extraction** — for the captured window it computes total energy,
   per-band energy (sub/low/low-mid/mid/high/very-high), spectral centroid, and
   decay length.
3. **Classification** — a nearest-profile scorer compares those features to a
   per-voice profile and picks the closest. The defaults (`DEFAULT_PROFILES` in
   `audio-engine.js`) are **measured by FFT'ing each built-in DrumSynth voice**,
   so the pattern-maker's own sounds are recognised out of the box. Calibration
   overrides a voice's profile for your real kit.

### Sensitivity & calibration

- **Sensitivity** (Settings) is one slider, *Only loud hits → Catch quiet taps*.
  It tightens both gates together: how sharp the attack must be (flux vs the
  adaptive noise floor) and how far above the ambient floor a hit must be.
  Default leans strict, so soft taps and background noise are ignored.
- **Calibrate to the built-in kit** — one tap plays each synth voice through the
  speakers while the mic listens, learning the real speaker→room→mic path.
- **Calibrate to your real kit** — pick a drum, tap it a few times.
- **Voice rejection** (below) keeps talking/singing from firing false hits.

The classifier scores the **loudest (peak) frame** of each hit (more stable than
the rising edge) and adds a **kick-vs-floor-tom tiebreak** — the kick sweeps down
into the sub band over its decay while the floor tom doesn't. With those, the
built-in sounds recognise cleanly (~24/24 in the self-test). A real kit may
still want calibration for its own close pairs.

**Multiple drums at once:** kick and toms have no high-frequency energy of their
own, so a *sustained* high-band spike (≥6 kHz, over several frames — not a one-
frame attack click) on a low-drum hit means a cymbal/hat is layered on top, and
both are emitted (e.g. kick + hi-hat, tom + crash). Snare overlaps the cymbal
band, so snare + hi-hat reads as just the snare.

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

**Saved patterns** work the same way and are **scoped to the active kit**: name the
grid in the Pattern panel and **Save** it, pick one from the dropdown to load it,
**Delete** to remove it. The saved-pattern list follows whichever kit is active,
and the last pattern is restored on the next visit (stored under
`drumcoach.patterns.v1`, handled by `public/js/pattern-store.js`).

### Voice rejection

Microphones pick up talking and singing, which can fire false hits. The
**Voice rejection** selector (in the Settings panel) filters these out
without touching drum detection:

| Mode | What it does |
| ---- | ------------ |
| **Off** | Pipeline unchanged — every onset is treated as a drum |
| **Moderate** | A 3-test gate: rejects an onset only when it is **sustained** (doesn't decay) **and** **harmonic** (low spectral flatness) **and** **speech-banded** (200–3400 Hz). All three are needed, so kick (wrong band), snare/cymbals (too noisy), and toms (decay too fast) are always kept |
| **Aggressive** *(default)* | The 3-test gate **plus** a voice-activity detector that also blocks pitched, speech-banded onsets struck while you're mid-talking |

The classifier watches ~130 ms of each hit before deciding, so a note appears
~130 ms later — but hits are timestamped at the **true onset**, so BPM, drift,
and scoring stay exact. Calibration bypasses the voice gate entirely.

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
| `npm run test:e2e` | Run the Playwright end-to-end tests |

---

## Testing

The app is hard to test through a real microphone, so it has a **loopback audio
mode**: with `?loopback=1` the `AudioEngine` is fed by the `DrumSynth` (via a
`MediaStreamDestination`) instead of `getUserMedia`. The full
mic → onset → classify → staff pipeline then runs on synth audio, deterministically
and with no real mic. `?debug` (implied by loopback) exposes detected hits at
`window.__dc.hits` and the last self-test result at `window.__dc.lastTest`.
Loopback mode also skips cloud sync so runs are hermetic.

End-to-end tests live in `tests/` and use that mode:

```bash
npx playwright install chromium   # one-time
npm run test:e2e
```

> Requires **Node ≥ 18.19** (Playwright's ESM loader). The app itself runs on
> Node 18+.

---

## License

MIT
