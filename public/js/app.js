// app.js — wires the modules together and owns UI state.

import { Notation, VOICES } from "./notation.js";
import { AudioEngine } from "./audio-engine.js";
import { TimingAnalyzer } from "./timing.js";
import { Metronome } from "./metronome.js";
import { PatternSequencer } from "./sequencer.js";

const $ = (id) => document.getElementById(id);

// --- module instances -----------------------------------------------------
const notation = new Notation($("staff"), { windowSeconds: 4 });
const engine = new AudioEngine();
const timing = new TimingAnalyzer();
const metro = new Metronome();
const seq = new PatternSequencer();

// --- UI state --------------------------------------------------------------
const state = {
  practice: false,
  calVoice: null,           // voice selected for calibration (not yet recording)
  calibrating: null,        // voice currently being recorded
  calSamples: [],
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
    label.textContent = VOICE_LABEL[voice];
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
}

$("reset-cal").addEventListener("click", () => {
  if (state.calibrating) stopCalibration();
  engine.resetProfiles();
  $("cal-status").textContent = "Profiles reset to defaults.";
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
requestAnimationFrame(render);
