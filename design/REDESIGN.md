# DrumCoach redesign — plan & TODO

Rebuild the live app's UI to match the light, mobile-first design template at
[`design/drumcoach-redesign.html`](./drumcoach-redesign.html), while keeping all
existing functionality, and add the option to put the remaining drums (toms,
ride, crash) into the pattern.

## Goals

1. Adopt the template's **light theme**, **mobile-first** layout, and the flow
   from the design review: `mic → 1 Set your beat → 2 Play along → Patterns →
   Settings`, plus a replayable onboarding sheet.
2. Plain-language labels + ⓘ glosses; better empty states; **one tempo** shared
   by metronome and pattern; **two-tap delete**; a clear practice **switch**.
3. Keep every real feature working (mic detection, calibration, kit profiles,
   cloud sync, pattern save/load, metronome, scoring).
4. **New:** pattern starts with Kick / Snare / Hi-hat and the player can **add**
   Tom 1/2/3, Ride, Crash. Use the existing **drum-type icons** and the existing
   **DrumSynth** sounds for previews + pattern playback.

## Design tokens (from the template)

- Paper `#F4F6F2` · card `#FFFFFF` · ink `#15252A` · muted `#71807C` · line `#E2E7E1`
- Accent "beat" `#FF5A36` (+ soft `#FFE7DF`) · good `#2E8B72` · warn `#C8881F`
- Fonts: **Bricolage Grotesque** (headings), **Inter** (body), **JetBrains Mono** (numbers)
- Radius 18px; soft shadow; rounded "device" feel, full-bleed on phones.

## Architecture

The logic modules are presentation-agnostic and stay as-is: `audio-engine`,
`timing`, `metronome`, `sequencer`, `drum-synth`, `pattern-player`,
`profiles-store`, `pattern-store`, `cloud-sync`. The rebuild is **HTML + CSS +
the DOM-wiring half of `app.js`**.

### Template section → real data/feature

| Template section | Wires to |
| ---------------- | -------- |
| Mic bar | `AudioEngine` start/stop + level + reassurance copy |
| 1 · Set your beat | `Metronome` (BPM, beats/bar, click, beat dots) |
| 2 · Play along | `TimingAnalyzer`: tempo / in-time(steadiness) / drift / tightness(spread) + ⓘ tips |
| Patterns | `PatternSequencer` grid + `PatternPlayer` (tempo follows metronome) + scoring switch + `PatternStore` |
| Settings (disclosure) | calibration, `ProfileStore`, sensitivity, voice rejection, `CloudSync` |
| Onboarding sheet | first-run + ↺ replay |

### Decisions

- **Live notation staff is demoted.** The review flagged it as intimidating for
  true beginners; the template replaces it with plain metrics + a count-row
  playhead. We drop the always-on staff for now (could return as an optional
  view — see TODO).
- **One tempo.** Pattern playback reads the metronome BPM; the Patterns card
  shows "Tempo follows your beat above (currently N BPM)".
- **Calibration stays recommended, not a gate** (offered in onboarding + Settings).

## TODO

### Phase 0 — setup
- [x] Copy template into `design/drumcoach-redesign.html`
- [x] Write this design doc

### Phase 1 — visual shell
- [ ] New mobile-first `public/index.html` structure (header, mic, set-beat, play-along, patterns, settings disclosure, onboarding overlay, footer)
- [ ] New light `public/styles.css` (tokens + fonts above)

### Phase 2 — wire existing features to the new UI (`app.js`)
- [ ] Mic: toggle, level, reassurance copy
- [ ] Metronome: BPM steppers + number, beat dots, start/stop, beats-per-bar, volume
- [ ] Play-along: empty state → 4 metrics from `TimingAnalyzer`, ⓘ tooltips
- [ ] Patterns: grid + count-row playhead, Play, Loop, Practice switch, tempo-follows label
- [ ] Pattern store: Save / Load / Delete (two-tap), per active kit
- [ ] Settings: calibrate flow, kit profiles, sensitivity, voice rejection
- [ ] Cloud sync button
- [ ] Onboarding overlay (first-run + ↺ replay)

### Phase 3 — add the rest of the kit to patterns
- [ ] Default rows: Kick, Snare, Hi-hat
- [ ] "Add drums" control → Tom 1 / Tom 2 / Tom 3 / Ride / Crash
- [ ] Each row uses the existing drum-type SVG icon
- [ ] Row tap previews via `DrumSynth`; pattern playback sounds all voices via `DrumSynth`

### Phase 4 — pattern resolution
- [ ] Subdivision selector (♩ quarter / ♪ eighth / ♬ sixteenth) → `sequencer.stepsPerBeat`

### Phase 5 — polish & verify
- [ ] Verify on a mobile viewport (Playwright)
- [ ] Empty states, tooltip behaviour, tap-target sizes, contrast
- [ ] Confirm cloud-sync-off path still clean; no console errors
- [ ] (Optional/deferred) re-add the notation staff as a toggle

## Notes

- Fonts load from Google Fonts CDN (template uses them). They degrade to system
  fonts offline; acceptable for a hosted app.
- This is a large change touching `index.html` + `styles.css` + `app.js`
  together — each commit keeps the app coherent (no half-wired states).
