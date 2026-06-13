// app.js — wires the modules together and owns UI state.

import { Notation, VOICES } from "./notation.js";
import { AudioEngine } from "./audio-engine.js";
import { TimingAnalyzer } from "./timing.js";
import { Metronome } from "./metronome.js";
import { PatternSequencer } from "./sequencer.js";
import { ProfileStore } from "./profiles-store.js";
import { DrumSynth } from "./drum-synth.js";
import { PatternPlayer } from "./pattern-player.js";
import { PatternStore } from "./pattern-store.js";

const $ = (id) => document.getElementById(id);

// --- module instances -----------------------------------------------------
const notation = new Notation($("staff"), { windowSeconds: 4 });
const engine = new AudioEngine();
const timing = new TimingAnalyzer();
const metro = new Metronome();
const seq = new PatternSequencer();
const kits = new ProfileStore();
const patterns = new PatternStore();
const synth = new DrumSynth();
const player = new PatternPlayer(synth, seq, () => metro.bpm);

// --- UI state --------------------------------------------------------------
const state = {
  practice: false,
  calVoice: null,           // voice selected for calibration (not yet recording)
  calibrating: null,        // voice currently being recorded
  calSamples: [],
  kitDirty: false,          // live calibration has unsaved changes
};

const VOICE_LABEL = Object.fromEntries(
  Object.entries(VOICES).map(([k, v]) => [k, v.label])
);

// ==========================================================================
// Microphone / audio engine
// ==========================================================================
engine.onLevel((lvl) => {
  $("level-fill").style.width = `${Math.round(lvl * 100)}%`;
});

engine.onHit((voice, info) => {
  // Calibration capture takes precedence over normal handling.
  if (state.calibrating) {
    state.calSamples.push(info.features);
    updateCalBanner();
    if (state.calSamples.length >= 16) stopCalibration(); // safety cap
    return;
  }

  const grid = metro.getGrid();
  timing.addOnset(info.time, grid);

  // Judge against the pattern if practising; else just notate.
  let judgement = "plain";
  if (state.practice && grid) {
    judgement = seq.judgeHit(voice, info.time);
  } else if (grid) {
    judgement = "plain";
  }

  notation.addHit(info.time, voice, judgement);

  $("last-voice").textContent = VOICE_LABEL[voice] ?? voice;
  $("last-conf").textContent = `${Math.round(info.confidence * 100)}%`;
});

$("mic-btn").addEventListener("click", async () => {
  if (engine.running) {
    if (state.calibrating) stopCalibration();
    engine.stop();
    metro.stop();
    $("mic-btn").textContent = "▶ Start mic";
    $("mic-btn").classList.add("btn-primary");
    return;
  }
  try {
    await engine.start();
    metro.setContext(engine.ctx);
    $("mic-btn").textContent = "■ Stop mic";
    $("mic-btn").classList.remove("btn-primary");
  } catch (err) {
    alert("Could not access the microphone: " + err.message);
  }
});

$("sens-range").addEventListener("input", (e) => {
  // Invert: a higher "sensitivity" slider should detect quieter hits, i.e. a
  // lower internal multiplier.
  const v = +e.target.value;
  engine.sensitivity = 1 / v;
});

// Voice-rejection mode (off / moderate / aggressive). Defaults to aggressive.
const voiceModeEl = $("voice-mode");
let voicesFiltered = 0;
const VOICE_HINTS = {
  off: "Off — every onset is treated as a drum.",
  moderate: "Moderate — filters sustained, pitched, speech-band sounds (~90 ms delay).",
  aggressive: "Aggressive — also detects talking and blocks the most voice.",
};
function updateVoiceHint(mode) {
  const base = VOICE_HINTS[mode] ?? "";
  $("voice-hint").textContent = voicesFiltered ? `${base}  •  ${voicesFiltered} filtered` : base;
}
for (const b of voiceModeEl.querySelectorAll(".seg-btn")) {
  b.addEventListener("click", () => {
    engine.setVoiceRejection(b.dataset.mode);
    for (const x of voiceModeEl.querySelectorAll(".seg-btn")) x.classList.toggle("active", x === b);
    updateVoiceHint(b.dataset.mode);
  });
}
engine.onVoiceReject(() => { voicesFiltered++; updateVoiceHint(engine.voiceRejection); });
updateVoiceHint(engine.voiceRejection);

// ==========================================================================
// Metronome
// ==========================================================================
const beatDots = $("beat-dots");

function rebuildBeatDots() {
  beatDots.innerHTML = "";
  for (let i = 0; i < metro.beatsPerBar; i++) {
    const d = document.createElement("div");
    d.className = "dot" + (i === 0 ? " strong" : "");
    beatDots.appendChild(d);
  }
}

metro.onBeat((index) => {
  const dots = beatDots.children;
  if (!dots.length) return;
  const pos = index % metro.beatsPerBar;
  for (const d of dots) d.classList.remove("on");
  if (dots[pos]) dots[pos].classList.add("on");
});

$("metro-btn").addEventListener("click", () => {
  if (!engine.ctx) { alert("Start the microphone first (it powers the audio clock)."); return; }
  metro.setContext(engine.ctx);
  metro.toggle();
  $("metro-btn").textContent = metro.running ? "■ Stop" : "▶ Start";
  $("metro-btn").classList.toggle("active", metro.running);
});

function setBpm(v) {
  v = Math.max(30, Math.min(300, Math.round(v)));
  metro.setBpm(v);
  $("bpm-input").value = v;
  $("bpm-range").value = Math.max(40, Math.min(220, v));
}
$("bpm-input").addEventListener("change", (e) => setBpm(+e.target.value));
$("bpm-range").addEventListener("input", (e) => setBpm(+e.target.value));
$("bpm-up").addEventListener("click", () => setBpm(metro.bpm + 1));
$("bpm-down").addEventListener("click", () => setBpm(metro.bpm - 1));

$("beats-select").addEventListener("change", (e) => {
  const n = +e.target.value;
  metro.setBeatsPerBar(n);
  seq.setBeatsPerBar(n);
  rebuildBeatDots();
  buildSequencer();
});

$("metro-vol").addEventListener("input", (e) => { metro.volume = +e.target.value; });

// ==========================================================================
// Pattern sequencer grid
// ==========================================================================
const seqEl = $("sequencer");

function buildSequencer() {
  seqEl.style.setProperty("--steps", seq.totalSteps);
  seqEl.innerHTML = "";

  for (const voice of seq.voiceKeys) {
    const row = document.createElement("div");
    row.className = "seq-row";

    const label = document.createElement("div");
    label.className = "seq-label";
    const play = document.createElement("button");
    play.className = "seq-play";
    play.title = `Play ${VOICE_LABEL[voice]} sample`;
    play.setAttribute("aria-label", `Play ${VOICE_LABEL[voice]} sample`);
    play.innerHTML =
      `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">` +
      `<path fill="currentColor" d="M2.5 6h2.2L8 3.3v9.4L4.7 10H2.5z"/>` +
      `<path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" ` +
      `d="M10.5 5.6a3.2 3.2 0 0 1 0 4.8"/></svg>`;
    play.addEventListener("click", () => {
      synth.play(voice);
      play.classList.add("playing");
      setTimeout(() => play.classList.remove("playing"), 160);
    });
    const name = document.createElement("span");
    name.className = "seq-name";
    name.textContent = VOICE_LABEL[voice];
    label.append(play, name);
    row.appendChild(label);

    const cells = document.createElement("div");
    cells.className = "seq-cells";
    cells.style.setProperty("--steps", seq.totalSteps);

    for (let step = 0; step < seq.totalSteps; step++) {
      const cell = document.createElement("button");
      cell.className = "cell";
      cell.dataset.voice = voice;
      cell.dataset.step = step;
      // Visual emphasis on beat / bar boundaries.
      if (step % seq.stepsPerBeat === 0) cell.classList.add("beat");
      if (step % seq.stepsPerBar === 0) cell.classList.add("bar");
      if (seq.isActive(voice, step)) cell.classList.add("on");
      cell.addEventListener("click", () => {
        const on = seq.toggle(voice, step);
        cell.classList.toggle("on", on);
      });
      cells.appendChild(cell);
    }
    row.appendChild(cells);
    seqEl.appendChild(row);
  }
}

$("bars-select").addEventListener("change", (e) => {
  seq.setBars(+e.target.value);
  buildSequencer();
});

$("clear-pattern").addEventListener("click", () => {
  seq.clearPattern();
  buildSequencer();
});

$("practice-btn").addEventListener("click", () => {
  state.practice = !state.practice;
  seq.resetScore();
  const btn = $("practice-btn");
  btn.textContent = state.practice ? "🎯 Practice on" : "🎯 Practice off";
  btn.classList.toggle("active", state.practice);
});

// --- Pattern playback (synth) ----------------------------------------------
function highlightPlayColumn(step) {
  for (const c of seqEl.querySelectorAll(".cell.playcol")) c.classList.remove("playcol");
  if (step == null || step < 0) return;
  for (const c of seqEl.querySelectorAll(`.cell[data-step="${step}"]`)) c.classList.add("playcol");
}

player.onStep = (step) => highlightPlayColumn(step);
player.onStop = () => {
  $("pattern-play").textContent = "▶ Play";
  $("pattern-play").classList.add("btn-accent");
  highlightPlayColumn(null);
};

$("pattern-play").addEventListener("click", () => {
  player.toggle();
  const playing = player.playing;
  $("pattern-play").textContent = playing ? "■ Stop" : "▶ Play";
  $("pattern-play").classList.toggle("btn-accent", !playing);
  if (!playing) highlightPlayColumn(null);
});

$("pattern-loop").addEventListener("change", (e) => { player.loop = e.target.checked; });

// --- Saved patterns (per kit, localStorage) --------------------------------
function activeKitLabel() {
  const rec = kits.activeId() && kits.get(kits.activeId());
  return rec ? `“${rec.name}”` : "the default kit";
}

function refreshPatternSelect() {
  const sel = $("pattern-select");
  const list = patterns.list(kits.activeId());
  const active = patterns.activeId();
  sel.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = list.length ? "— select a pattern —" : "— none saved —";
  sel.appendChild(blank);
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = active && patterns.get(active) && sel.querySelector(`option[value="${active}"]`) ? active : "";
  $("pattern-delete").disabled = !sel.value;
}

// Apply a saved pattern's data to the live grid + keep the UI in sync.
function applyPattern(data) {
  seq.import(data);
  metro.setBeatsPerBar(seq.beatsPerBar);
  $("beats-select").value = seq.beatsPerBar;
  $("bars-select").value = seq.bars;
  rebuildBeatDots();
  buildSequencer();
}

function loadPattern(id) {
  const rec = id && patterns.get(id);
  if (!rec) { patterns.setActive(null); refreshPatternSelect(); return; }
  applyPattern(rec.data);
  patterns.setActive(id);
  $("pattern-name").value = rec.name;
  refreshPatternSelect();
  $("pattern-store-status").textContent = `Loaded “${rec.name}”.`;
}

$("pattern-select").addEventListener("change", (e) => loadPattern(e.target.value));

$("pattern-save-btn").addEventListener("click", () => {
  const name = $("pattern-name").value.trim();
  if (!name) { $("pattern-store-status").textContent = "Type a name first, then press Save."; $("pattern-name").focus(); return; }
  const rec = patterns.save(name, kits.activeId(), seq.export());
  refreshPatternSelect();
  $("pattern-store-status").textContent = `Saved “${rec.name}” for ${activeKitLabel()}.`;
});

$("pattern-delete").addEventListener("click", () => {
  const id = $("pattern-select").value;
  const rec = id && patterns.get(id);
  if (!rec) return;
  if (!confirm(`Delete saved pattern “${rec.name}”?`)) return;
  patterns.remove(id);
  $("pattern-name").value = "";
  refreshPatternSelect();
  $("pattern-store-status").textContent = `Deleted “${rec.name}”.`;
});

// Patterns are kit-scoped, so when the active kit changes the saved-pattern
// list must follow it (without disturbing the current grid).
function onActiveKitChanged() {
  patterns.setActive(null);
  $("pattern-name").value = "";
  $("pattern-store-status").textContent = "";
  refreshPatternSelect();
}

// ==========================================================================
// Calibration
// ==========================================================================
const calGrid = $("cal-grid");
const calToggle = $("cal-toggle");

function buildCalibration() {
  calGrid.innerHTML = "";
  for (const voice of seq.voiceKeys) {
    const btn = document.createElement("button");
    btn.className = "cal-btn";
    btn.textContent = VOICE_LABEL[voice];
    btn.dataset.voice = voice;
    btn.addEventListener("click", () => selectCalVoice(voice));
    calGrid.appendChild(btn);
  }
}

// Step 1: choose which drum to calibrate (does not start recording yet).
function selectCalVoice(voice) {
  if (state.calibrating) return; // can't switch mid-recording
  state.calVoice = voice;
  for (const b of calGrid.children) b.classList.toggle("selected", b.dataset.voice === voice);
  calToggle.disabled = false;
  $("cal-status").textContent =
    `Ready to calibrate ${VOICE_LABEL[voice]} — press Start, then hit it a few times.`;
}

// Step 2: explicit Start / Stop so the player always knows the mode.
calToggle.addEventListener("click", () => {
  if (state.calibrating) stopCalibration();
  else startCalibration();
});

function startCalibration() {
  if (!engine.running) { alert("Start the microphone first."); return; }
  if (!state.calVoice) { alert("Pick a drum to calibrate first."); return; }

  state.calibrating = state.calVoice;
  state.calSamples = [];
  engine.suspendVoiceFilter = true; // capture every drum hit during calibration

  calToggle.textContent = "■ Stop calibration";
  calToggle.classList.remove("cal-start");
  calToggle.classList.add("recording");
  for (const b of calGrid.children) b.disabled = true; // lock selection

  $("cal-status").textContent = "";
  $("cal-banner").hidden = false;
  $("cal-banner-text").textContent =
    `Recording ${VOICE_LABEL[state.calibrating]} — hit it a few times, then press Stop`;
  updateCalBanner();
}

function updateCalBanner() {
  const n = state.calSamples.length;
  $("cal-count").textContent = `${n} hit${n === 1 ? "" : "s"} captured`;
}

function stopCalibration() {
  const voice = state.calibrating;
  const n = state.calSamples.length;

  calToggle.textContent = "● Start calibration";
  calToggle.classList.add("cal-start");
  calToggle.classList.remove("recording");
  for (const b of calGrid.children) b.disabled = false;
  $("cal-banner").hidden = true;
  state.calibrating = null;
  engine.suspendVoiceFilter = false;

  if (n === 0) {
    $("cal-status").textContent =
      `No hits detected for ${VOICE_LABEL[voice]}. Drag sensitivity left and play a little louder, then retry.`;
    return;
  }

  // Average the collected feature samples into the voice's profile centroid.
  const avg = {};
  const keys = ["sub", "low", "lowMid", "mid", "high", "veryHigh", "centroidN", "centroid", "level"];
  for (const k of keys) avg[k] = state.calSamples.reduce((s, f) => s + (f[k] ?? 0), 0) / n;
  engine.calibrateVoice(voice, avg);
  state.calSamples = [];
  $("cal-status").textContent = `✓ ${VOICE_LABEL[voice]} calibrated from ${n} hit${n === 1 ? "" : "s"}.`;

  // Persist: if a named kit is active, auto-save into it; otherwise mark the
  // live calibration as unsaved so the player can name + Save it as a new kit.
  const activeId = kits.activeId();
  if (activeId && kits.get(activeId)) {
    const rec = kits.updateProfiles(activeId, engine.exportProfiles());
    setKitStatus(`Saved ${VOICE_LABEL[voice]} into kit “${rec.name}”.`);
  } else {
    state.kitDirty = true;
    setKitStatus("Unsaved calibration — name this kit and press Save to keep it.");
  }
}

// --- Kit profiles (localStorage-persisted calibration sets) ----------------
function refreshKitSelect() {
  const sel = $("kit-select");
  const activeId = kits.activeId();
  sel.innerHTML = "";

  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Default (uncalibrated)";
  sel.appendChild(def);

  for (const k of kits.list()) {
    const o = document.createElement("option");
    o.value = k.id;
    o.textContent = k.name;
    sel.appendChild(o);
  }
  sel.value = activeId && kits.get(activeId) ? activeId : "";
  $("kit-delete").disabled = !sel.value;
}

function setKitStatus(msg) { $("kit-status").textContent = msg; }

// Load a kit by id ("" = default/uncalibrated) into the live engine.
function loadKit(id) {
  if (!id) {
    engine.resetProfiles();
    kits.setActive(null);
    state.kitDirty = false;
    refreshKitSelect();
    onActiveKitChanged();
    setKitStatus("Using default (uncalibrated) profiles.");
    return;
  }
  const rec = kits.get(id);
  if (!rec) { refreshKitSelect(); return; }
  engine.importProfiles(rec.profiles);
  kits.setActive(id);
  state.kitDirty = false;
  $("kit-name").value = rec.name;
  refreshKitSelect();
  onActiveKitChanged();
  setKitStatus(`Loaded kit “${rec.name}”.`);
}

$("kit-select").addEventListener("change", (e) => loadKit(e.target.value));

$("kit-save").addEventListener("click", () => {
  const name = $("kit-name").value.trim();
  if (!name) { setKitStatus("Type a name first, then press Save."); $("kit-name").focus(); return; }
  const rec = kits.save(name, engine.exportProfiles());
  state.kitDirty = false;
  refreshKitSelect();
  onActiveKitChanged(); // the new kit is now active → its (empty) pattern list
  setKitStatus(`Saved kit “${rec.name}”. It will load automatically next time.`);
});

$("kit-delete").addEventListener("click", () => {
  const id = $("kit-select").value;
  const rec = id && kits.get(id);
  if (!rec) return;
  if (!confirm(`Delete saved kit “${rec.name}”? This cannot be undone.`)) return;
  kits.remove(id);
  patterns.removeForKit(id); // drop the deleted kit's patterns too
  engine.resetProfiles();
  $("kit-name").value = "";
  state.kitDirty = false;
  refreshKitSelect();
  onActiveKitChanged();
  setKitStatus(`Deleted “${rec.name}”. Back to default profiles.`);
});

// "Forget calibration": revert the live engine to defaults without deleting any
// saved kits. Just drops the current (possibly unsaved) calibration.
$("forget-cal").addEventListener("click", () => {
  if (state.calibrating) stopCalibration();
  engine.resetProfiles();
  kits.setActive(null);
  state.kitDirty = false;
  $("kit-name").value = "";
  refreshKitSelect();
  onActiveKitChanged();
  setKitStatus("Calibration forgotten — using default profiles. Saved kits are untouched.");
  $("cal-status").textContent = "Pick a drum to calibrate.";
});

// ==========================================================================
// Render loop — drives notation + live stat readouts
// ==========================================================================
function render() {
  const now = engine.now();

  // Notation: beats grid + pattern ghosts.
  notation.setBeats(metro.beatsInWindow(now, notation.windowSeconds));
  const grid = metro.getGrid();
  notation.setTargets(grid ? seq.targetsInWindow(now, grid, notation.windowSeconds, 0) : []);
  notation.render(now);

  // Scoring bookkeeping.
  if (state.practice && grid) {
    seq.update(now, grid);
    updateScore();
  }

  updateStats();
  requestAnimationFrame(render);
}

function updateStats() {
  const bpm = timing.estimateBPM();
  $("bpm-value").textContent = bpm ?? "—";

  const steady = timing.steadiness();
  $("steady-value").textContent = steady == null ? "—" : `${Math.round(steady * 100)}%`;

  const drift = timing.drift();
  const driftEl = $("drift-value");
  if (!drift) {
    driftEl.textContent = "—";
    driftEl.className = "stat-value";
    $("drift-hint").textContent = metro.running
      ? "Keep playing — gathering timing data…"
      : "Play along with the metronome to see drift.";
  } else {
    driftEl.textContent = `${drift.ms > 0 ? "+" : ""}${drift.ms} ms`;
    driftEl.className = "stat-value " +
      (Math.abs(drift.ms) <= 18 ? "good" : drift.ms > 0 ? "late" : "early");
    $("drift-hint").textContent =
      drift.label === "on time" ? "Nicely locked in! 🎯" :
      `You are ${drift.label}. Aim ${drift.ms > 0 ? "slightly earlier" : "slightly later"}.`;
  }

  const tight = timing.tightnessMs();
  $("tight-value").textContent = tight == null ? "—" : tight;
}

function updateScore() {
  const acc = seq.accuracy();
  const el = $("score");
  if (!acc) {
    el.innerHTML = `<span class="score-pill">Listening… play the pattern with the metronome.</span>`;
    return;
  }
  el.innerHTML = `
    <span class="score-pill big ${acc.percent >= 80 ? "good" : acc.percent >= 50 ? "ok" : "bad"}">
      ${acc.percent}% accurate
    </span>
    <span class="score-pill">✓ ${acc.hit} clean</span>
    <span class="score-pill early">⟨ ${acc.early} early</span>
    <span class="score-pill late">⟩ ${acc.late} late</span>
    <span class="score-pill miss">✗ ${acc.miss} missed</span>
    <span class="score-pill">＋ ${acc.extra} extra</span>
  `;
}

// ==========================================================================
// Boot
// ==========================================================================
rebuildBeatDots();
buildSequencer();
buildCalibration();

// Restore the last-used kit profile from localStorage, if any.
(function restoreKit() {
  const activeId = kits.activeId();
  const rec = activeId && kits.get(activeId);
  if (rec) {
    engine.importProfiles(rec.profiles);
    $("kit-name").value = rec.name;
    setKitStatus(`Loaded saved kit “${rec.name}”.`);
  }
  refreshKitSelect();
})();

// Restore the last-used pattern, but only if it belongs to the active kit.
(function restorePattern() {
  const activeId = patterns.activeId();
  const rec = activeId && patterns.get(activeId);
  if (rec && (rec.kitId || null) === (kits.activeId() || null)) {
    applyPattern(rec.data);
    $("pattern-name").value = rec.name;
    $("pattern-store-status").textContent = `Restored “${rec.name}”.`;
  } else if (rec) {
    patterns.setActive(null); // last pattern was for a different kit
  }
  refreshPatternSelect();
})();

requestAnimationFrame(render);
