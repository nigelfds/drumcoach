// app.js — wires the redesigned (light, mobile-first) UI to the logic modules.

import { Notation } from "./notation.js";
import { AudioEngine } from "./audio-engine.js";
import { TimingAnalyzer } from "./timing.js";
import { Metronome } from "./metronome.js";
import { PatternSequencer } from "./sequencer.js";
import { ProfileStore } from "./profiles-store.js";
import { PatternStore } from "./pattern-store.js";
import { CloudSync } from "./cloud-sync.js";
import { DrumSynth } from "./drum-synth.js";
import { PatternPlayer } from "./pattern-player.js";

const $ = (id) => document.getElementById(id);

// --- modules ---------------------------------------------------------------
const notation = new Notation($("staff"), { windowSeconds: 4 });
const engine = new AudioEngine();
const timing = new TimingAnalyzer();
const metro = new Metronome();
const seq = new PatternSequencer();
const kits = new ProfileStore();
const patterns = new PatternStore();
const synth = new DrumSynth();
const player = new PatternPlayer(synth, seq, 88);
const cloud = new CloudSync({ kits, patterns });

// --- shared audio clock (so beat works without the mic, on one clock) -------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  synth.setContext(audioCtx);
  metro.setContext(audioCtx);
  return audioCtx;
}
const nowTime = () => (audioCtx ? audioCtx.currentTime : performance.now() / 1000);

// Loopback / debug, for the recognition self-test and e2e tests. With
// ?loopback=1 the mic is fed by the synth instead of getUserMedia (deterministic,
// no real mic). ?debug exposes a detected-hits log on window.__dc.
const PARAMS = new URLSearchParams(location.search);
const LOOPBACK = PARAMS.has("loopback");
const DEBUG = LOOPBACK || PARAMS.has("debug");
if (DEBUG) window.__dc = {
  hits: [], reset() { this.hits = []; }, loopback: LOOPBACK,
  active: () => [...seq.active].sort(),                       // current pattern cells
  dims: () => ({ bars: seq.bars, beatsPerBar: seq.beatsPerBar, stepsPerBeat: seq.stepsPerBeat }),
  play: (...voices) => { const t = synth.context().currentTime + 0.04; voices.forEach((v) => synth.playAt(v, t)); },
};

// --- voices -----------------------------------------------------------------
const VOICE_META = {
  hihat: { label: "Hi-hat", color: "#2E8B72" },
  crash: { label: "Crash", color: "#C8881F" },
  ride:  { label: "Ride",  color: "#3a9bd6" },
  tom1:  { label: "Tom 1", color: "#5a73e0" },
  tom2:  { label: "Tom 2", color: "#8a5ce0" },
  tom3:  { label: "Tom 3", color: "#b85ab8" },
  snare: { label: "Snare", color: "#FF5A36" },
  kick:  { label: "Kick",  color: "#15252A" },
};
const ORDER = ["hihat", "crash", "ride", "tom1", "tom2", "tom3", "snare", "kick"];
const DEFAULT_SHOWN = ["hihat", "snare", "kick"];
const EXTRA = ["crash", "ride", "tom1", "tom2", "tom3"];

// drum-type icons (from the existing app)
const SVG = (b) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">${b}</svg>`;
const ICONS = {
  kick:  SVG(`<circle cx="8" cy="8" r="6" stroke-width="1.3"/><circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none"/>`),
  snare: SVG(`<rect x="2.5" y="5" width="11" height="5.5" rx="1.6"/><ellipse cx="8" cy="5" rx="5.5" ry="1.8"/><path d="M4 12h8" stroke-width="0.9"/>`),
  tom:   SVG(`<rect x="3" y="3.8" width="10" height="8.2" rx="1.6"/><ellipse cx="8" cy="3.8" rx="5" ry="1.7"/>`),
  hihat: SVG(`<ellipse cx="8" cy="6" rx="6" ry="1.3"/><ellipse cx="8" cy="8.7" rx="6" ry="1.3"/><path d="M8 2.5v11" stroke-width="1"/>`),
  cymbal: SVG(`<ellipse cx="8" cy="5" rx="6.5" ry="1.6"/><circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none"/><path d="M8 5.4v8.6"/>`),
};
const iconFor = (v) => v === "kick" ? ICONS.kick : v === "snare" ? ICONS.snare
  : v.startsWith("tom") ? ICONS.tom : v === "hihat" ? ICONS.hihat : ICONS.cymbal;

// --- state ------------------------------------------------------------------
const state = {
  shown: new Set(DEFAULT_SHOWN),
  practice: false,
  calVoice: null, calibrating: null, calSamples: [], kitDirty: false,
};

// Auto-calibration ("Calibrate to the built-in kit") plumbing.
let autoCalCollector = null;   // (info) => void while an auto-cal voice is recording
let autoCalRunning = false;
let testCollector = null;      // (voice, info) => void during the recognition test
let testRunning = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTOCAL_ORDER = ["kick", "snare", "tom1", "tom2", "tom3", "hihat", "ride", "crash"];
function averageFeatures(samples) {
  const keys = ["sub", "low", "lowMid", "mid", "high", "veryHigh", "centroidN", "centroid", "level"];
  const avg = {};
  for (const k of keys) avg[k] = samples.reduce((s, f) => s + (f[k] ?? 0), 0) / samples.length;
  return avg;
}

// ===========================================================================
// MIC
// ===========================================================================
engine.onLevel((lvl) => { $("mic-level").style.width = `${Math.round(lvl * 100)}%`; });

engine.onHit((voice, info) => {
  if (DEBUG) { window.__dc.hits.push({ t: +info.time.toFixed(3), voice, conf: +info.confidence.toFixed(2) }); if (window.__dc.hits.length > 1000) window.__dc.hits.shift(); }
  if (autoCalCollector) { autoCalCollector(info); return; }
  if (state.calibrating) {
    state.calSamples.push(info.features);
    updateCalBanner();
    if (state.calSamples.length >= 16) stopCalibration();
    return;
  }
  if (testCollector) testCollector(voice, info); // additive: still notate below
  const grid = metro.getGrid();
  timing.addOnset(info.time, grid);
  let judgement = "plain";
  if (state.practice && grid) judgement = seq.judgeHit(voice, info.time);
  notation.addHit(info.time, voice, judgement);
});

async function startMic() {
  try {
    ensureAudio();
    if (LOOPBACK) {
      // Feed the engine from the synth instead of the real mic (deterministic).
      const dest = audioCtx.createMediaStreamDestination();
      synth.connectTap(dest);
      await engine.start(audioCtx, dest.stream);
    } else {
      await engine.start(audioCtx);
    }
    $("mic-bar").classList.add("on");
    $("mic-label").textContent = "Mic is listening";
    $("mic-btn").textContent = "Turn off";
    $("mic-sub").textContent = "Listening on this device only. Tap a drum to check it’s picking you up.";
  } catch (e) {
    alert("Couldn’t access the microphone: " + e.message);
  }
}
function stopMic() {
  if (state.calibrating) stopCalibration();
  engine.stop();
  $("mic-bar").classList.remove("on");
  $("mic-label").textContent = "Mic is off";
  $("mic-btn").textContent = "Turn on mic";
  $("mic-sub").textContent = "DrumCoach hears your drums through this device. Everything runs on your device — nothing is recorded or sent anywhere.";
  $("mic-level").style.width = "0%";
}
$("mic-btn").addEventListener("click", () => engine.running ? stopMic() : startMic());

// ===========================================================================
// METRONOME (Set your beat)
// ===========================================================================
let bpm = 88;
function setBpm(v) {
  bpm = Math.max(40, Math.min(208, Math.round(v)));
  $("bpm-num").textContent = bpm;
  $("pat-bpm").textContent = bpm;
  metro.setBpm(bpm);
  player.bpm = bpm;
}
$("bpm-down").addEventListener("click", () => setBpm(bpm - 2));
$("bpm-up").addEventListener("click", () => setBpm(bpm + 2));

function buildBeatDots() {
  const el = $("beat-dots"); el.innerHTML = "";
  for (let i = 0; i < metro.beatsPerBar; i++) {
    const d = document.createElement("span");
    d.className = "b" + (i === 0 ? " lead" : "");
    el.appendChild(d);
  }
}
metro.onBeat((index) => {
  const dots = $("beat-dots").children;
  for (const d of dots) d.classList.remove("active");
  const pos = index % metro.beatsPerBar;
  if (dots[pos]) dots[pos].classList.add("active");
});

$("metro-play").addEventListener("click", () => {
  ensureAudio();
  metro.setContext(audioCtx);
  metro.toggle();
  const b = $("metro-play");
  b.classList.toggle("playing", metro.running);
  b.textContent = metro.running ? "⏸ Stop the beat" : "▶ Start the beat";
  if (metro.running) revealMetrics();
  else for (const d of $("beat-dots").children) d.classList.remove("active");
});

$("beats-select").addEventListener("change", (e) => {
  const n = +e.target.value;
  metro.setBeatsPerBar(n);
  seq.setBeatsPerBar(n);
  buildBeatDots();
  pruneActive();
  buildGrid();
});
$("click-vol").addEventListener("input", (e) => { metro.volume = +e.target.value / 100; });

// ===========================================================================
// PLAY ALONG (feedback)
// ===========================================================================
let metricsShown = false;
function revealMetrics() {
  if (metricsShown) return;
  metricsShown = true;
  $("fb-empty").hidden = true;
  $("fb-metrics").hidden = false;
}
function setMetric(id, html, cls) {
  const el = $(id);
  el.innerHTML = html;
  el.className = "v" + (cls ? " " + cls : "");
}
function updateStats() {
  if (!metricsShown) return;
  const b = timing.estimateBPM();
  setMetric("m-tempo", b ? `${b} <small>BPM</small>` : "—", b ? "" : "dim");

  const st = timing.steadiness();
  if (st == null) setMetric("m-intime", "—", "dim");
  else if (st >= 0.85) setMetric("m-intime", "Locked", "good");
  else if (st >= 0.6) setMetric("m-intime", "Steady", "good");
  else if (st >= 0.35) setMetric("m-intime", "Loose", "");
  else setMetric("m-intime", "Wobbly", "warn");

  const dr = timing.drift();
  if (!dr) setMetric("m-drift", "—", "dim");
  else setMetric("m-drift", `${dr.ms > 0 ? "+" : ""}${dr.ms} <small>ms</small>`,
    Math.abs(dr.ms) <= 18 ? "good" : "warn");

  const tt = timing.tightnessMs();
  setMetric("m-tight", tt == null ? "—" : `${tt} <small>ms</small>`, tt == null ? "dim" : "");
}

// tooltips
document.querySelectorAll(".info").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = "tip-" + btn.dataset.tip;
    document.querySelectorAll(".tip").forEach((t) => { if (t.id !== id) t.classList.remove("show"); });
    $(id).classList.toggle("show");
  });
});
document.addEventListener("click", () => document.querySelectorAll(".tip").forEach((t) => t.classList.remove("show")));

// ===========================================================================
// PATTERNS
// ===========================================================================
const gridEl = $("grid");

function pruneActive() {
  const n = seq.totalSteps;
  for (const key of [...seq.active]) {
    if (+key.split(":")[1] >= n) seq.active.delete(key);
  }
}

function shownVoices() { return ORDER.filter((v) => state.shown.has(v)); }

function buildGrid() {
  const n = seq.totalSteps, beatLen = seq.stepsPerBeat;
  gridEl.innerHTML = "";

  // count row
  const cr = document.createElement("div");
  cr.className = "grow countrow";
  const sp = document.createElement("div"); sp.className = "vlabel"; cr.appendChild(sp);
  for (let i = 0; i < n; i++) {
    const c = document.createElement("div"); c.className = "cell"; c.dataset.step = i;
    if (i % beatLen === 0) { c.classList.add("beatnum"); c.textContent = (i / beatLen) % seq.beatsPerBar + 1; }
    cr.appendChild(c);
  }
  gridEl.appendChild(cr);

  // voice rows
  for (const v of shownVoices()) {
    const row = document.createElement("div"); row.className = "grow";
    const lbl = document.createElement("div"); lbl.className = "vlabel";

    const play = document.createElement("button");
    play.className = "vplay"; play.title = `Play ${VOICE_META[v].label}`;
    play.style.color = VOICE_META[v].color; play.innerHTML = iconFor(v);
    play.onclick = () => { ensureAudio(); synth.play(v); play.classList.add("playing"); setTimeout(() => play.classList.remove("playing"), 150); };
    lbl.appendChild(play);

    const name = document.createElement("span"); name.className = "vname"; name.textContent = VOICE_META[v].label;
    lbl.appendChild(name);

    if (EXTRA.includes(v)) {
      const rm = document.createElement("button");
      rm.className = "vremove"; rm.title = "Remove row"; rm.textContent = "×";
      rm.onclick = () => toggleExtra(v, false);
      lbl.appendChild(rm);
    }
    row.appendChild(lbl);

    for (let i = 0; i < n; i++) {
      const c = document.createElement("button");
      c.className = "cell" + (i % beatLen === 0 ? " beat" : "");
      c.dataset.step = i; c.style.setProperty("--vc", VOICE_META[v].color);
      if (seq.isActive(v, i)) c.classList.add("on");
      c.onclick = () => c.classList.toggle("on", seq.toggle(v, i));
      row.appendChild(c);
    }
    gridEl.appendChild(row);
  }
}

// subdivision
$("sub-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $("sub-seg").querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
  b.classList.add("sel");
  seq.setStepsPerBeat(+b.dataset.sub);
  pruneActive(); buildGrid();
});

$("bars-select").addEventListener("change", (e) => {
  seq.setBars(+e.target.value); pruneActive(); buildGrid();
});
$("clear-pattern").addEventListener("click", () => { seq.clearPattern(); buildGrid(); });

// add drums
function buildDrumAdder() {
  const el = $("drum-adder"); el.innerHTML = "";
  for (const v of EXTRA) {
    const chip = document.createElement("button");
    chip.className = "drum-chip" + (state.shown.has(v) ? " added" : "");
    chip.style.color = state.shown.has(v) ? "#fff" : VOICE_META[v].color;
    chip.innerHTML = `<span class="ic">${iconFor(v)}</span>${VOICE_META[v].label}`;
    chip.onclick = () => toggleExtra(v, !state.shown.has(v));
    el.appendChild(chip);
  }
}
function toggleExtra(v, on) {
  if (on) state.shown.add(v); else state.shown.delete(v);
  buildDrumAdder(); buildGrid();
}
$("add-drums").addEventListener("click", () => {
  const el = $("drum-adder");
  el.hidden = !el.hidden;
  $("add-drums").classList.toggle("on-ghost", !el.hidden);
});

// pattern playback
player.onStep = (step) => highlightCol(step);
player.onStop = () => { $("pattern-play").classList.remove("playing"); $("pattern-play").textContent = "▶ Play pattern"; highlightCol(null); };
function highlightCol(step) {
  gridEl.querySelectorAll(".cell.ph").forEach((c) => c.classList.remove("ph"));
  if (step == null) return;
  gridEl.querySelectorAll(`.cell[data-step="${step}"]`).forEach((c) => c.classList.add("ph"));
}
$("pattern-play").addEventListener("click", () => {
  ensureAudio();
  player.toggle();
  $("pattern-play").classList.toggle("playing", player.playing);
  $("pattern-play").textContent = player.playing ? "⏸ Playing pattern" : "▶ Play pattern";
  if (!player.playing) highlightCol(null);
});
$("loop-btn").addEventListener("click", function () {
  this.classList.toggle("on-ghost");
  player.loop = this.classList.contains("on-ghost");
});
player.loop = false;

// practice switch + score
$("practice-switch").addEventListener("click", function () {
  state.practice = this.classList.toggle("on");
  seq.resetScore();
  $("score").hidden = !state.practice;
  if (!state.practice) $("score").innerHTML = "";
});
function updateScore() {
  const acc = seq.accuracy();
  const el = $("score");
  if (!acc) { el.innerHTML = `<span class="pill">Play the pattern with the beat on…</span>`; return; }
  el.innerHTML =
    `<span class="pill big ${acc.percent >= 80 ? "good" : acc.percent >= 50 ? "" : "bad"}">${acc.percent}% accurate</span>` +
    `<span class="pill">✓ ${acc.hit}</span><span class="pill">⟨ ${acc.early}</span>` +
    `<span class="pill">⟩ ${acc.late}</span><span class="pill">✗ ${acc.miss}</span>`;
}

// ===========================================================================
// SAVED PATTERNS (per kit)
// ===========================================================================
function refreshPatternSelect() {
  const sel = $("pattern-select");
  const list = patterns.list(kits.activeId());
  const active = patterns.activeId();
  sel.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = list.length ? "— load a pattern —" : "— none saved —";
  sel.appendChild(blank);
  for (const p of list) {
    const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
  }
  sel.value = active && patterns.get(active) && sel.querySelector(`option[value="${active}"]`) ? active : "";
  $("pattern-delete").disabled = !sel.value;
}
function applyPattern(data) {
  seq.import(data);
  // sync UI to the loaded pattern's dimensions + voices
  metro.setBeatsPerBar(seq.beatsPerBar);
  $("beats-select").value = String(seq.beatsPerBar);
  $("bars-select").value = String(seq.bars);
  $("sub-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("sel", +x.dataset.sub === seq.stepsPerBeat));
  state.shown = new Set(DEFAULT_SHOWN);
  for (const key of seq.active) { const v = key.split(":")[0]; if (EXTRA.includes(v)) state.shown.add(v); }
  buildBeatDots(); buildDrumAdder(); buildGrid();
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
  if (!name) { $("pattern-store-status").textContent = "Type a name first, then Save."; $("pattern-name").focus(); return; }
  const rec = patterns.save(name, kits.activeId(), seq.export());
  refreshPatternSelect();
  $("pattern-store-status").textContent = `Saved “${rec.name}”.`;
});
let patDelArmed = false, patDelT;
$("pattern-delete").addEventListener("click", function () {
  const id = $("pattern-select").value; const rec = id && patterns.get(id); if (!rec) return;
  if (!patDelArmed) {
    patDelArmed = true; this.classList.add("armed"); this.textContent = "Tap again";
    patDelT = setTimeout(() => { patDelArmed = false; this.classList.remove("armed"); this.textContent = "Delete"; }, 2500);
    return;
  }
  clearTimeout(patDelT); patDelArmed = false; this.classList.remove("armed"); this.textContent = "Delete";
  patterns.remove(id); $("pattern-name").value = "";
  refreshPatternSelect();
  $("pattern-store-status").textContent = `Deleted “${rec.name}”.`;
});

// ===========================================================================
// SETTINGS — calibration
// ===========================================================================
const calGrid = $("cal-grid");
const calToggle = $("cal-toggle");
calToggle.classList.add("cal-toggle");
function buildCalGrid() {
  calGrid.innerHTML = "";
  for (const v of ORDER) {
    const chip = document.createElement("button");
    chip.className = "cal-chip"; chip.dataset.voice = v;
    chip.innerHTML = `<span style="color:${VOICE_META[v].color};display:inline-flex">${iconFor(v)}</span>${VOICE_META[v].label}`;
    chip.onclick = () => selectCalVoice(v);
    calGrid.appendChild(chip);
  }
}
function selectCalVoice(v) {
  if (state.calibrating) return;
  state.calVoice = v;
  for (const c of calGrid.children) c.classList.toggle("sel", c.dataset.voice === v);
  calToggle.disabled = false;
  $("cal-status").textContent = `Ready — press Start, then hit ${VOICE_META[v].label} a few times.`;
}
calToggle.addEventListener("click", () => state.calibrating ? stopCalibration() : startCalibration());
function startCalibration() {
  if (!engine.running) { alert("Turn on the mic first."); return; }
  if (!state.calVoice) { alert("Pick a drum to calibrate first."); return; }
  state.calibrating = state.calVoice; state.calSamples = []; engine.suspendVoiceFilter = true;
  calToggle.textContent = "■ Stop"; calToggle.classList.add("recording");
  for (const c of calGrid.children) c.disabled = true;
  $("cal-banner").hidden = false;
  $("cal-banner-text").textContent = `Recording ${VOICE_META[state.calibrating].label} — hit it a few times`;
  updateCalBanner();
}
function updateCalBanner() {
  const n = state.calSamples.length;
  $("cal-count").textContent = `${n} hit${n === 1 ? "" : "s"}`;
}
function stopCalibration() {
  if (!state.calibrating) return;
  const voice = state.calibrating, n = state.calSamples.length;
  calToggle.textContent = "● Start calibration"; calToggle.classList.remove("recording");
  for (const c of calGrid.children) c.disabled = false;
  $("cal-banner").hidden = true; state.calibrating = null; engine.suspendVoiceFilter = false;
  if (n === 0) { $("cal-status").textContent = `No hits heard for ${VOICE_META[voice].label}. Play a little louder and retry.`; return; }
  const avg = {}, keys = ["sub", "low", "lowMid", "mid", "high", "veryHigh", "centroidN", "centroid", "level"];
  for (const k of keys) avg[k] = state.calSamples.reduce((s, f) => s + (f[k] ?? 0), 0) / n;
  engine.calibrateVoice(voice, avg); state.calSamples = [];
  $("cal-status").textContent = `✓ ${VOICE_META[voice].label} calibrated from ${n} hit${n === 1 ? "" : "s"}.`;
  const activeId = kits.activeId();
  if (activeId && kits.get(activeId)) { kits.updateProfiles(activeId, engine.exportProfiles()); setKitStatus(`Saved ${VOICE_META[voice].label} into the active kit.`); }
  else { state.kitDirty = true; setKitStatus("Unsaved calibration — name a kit and Save to keep it."); }
}

// Auto-calibration: play each built-in voice through the speakers and learn it
// from what the mic hears (captures the real speaker→room→mic path).
async function autoCalibrate() {
  if (!engine.running) { alert("Turn on the mic first, and turn your volume up so DrumCoach can hear its sounds through your speakers."); return; }
  if (autoCalRunning || state.calibrating) return;
  ensureAudio();
  // Silence the click / pattern so only the test sounds are heard.
  if (metro.running) { metro.stop(); $("metro-play").classList.remove("playing"); $("metro-play").textContent = "▶ Start the beat"; for (const d of $("beat-dots").children) d.classList.remove("active"); }
  if (player.playing) { player.stop(); }

  autoCalRunning = true;
  const btn = $("auto-cal");
  const wasLabel = btn.textContent;
  btn.disabled = true; calToggle.disabled = true;
  for (const c of calGrid.children) c.disabled = true;
  engine.suspendVoiceFilter = true; // don't let voice rejection drop the sounds

  let got = 0;
  try {
    for (const v of AUTOCAL_ORDER) {
      const samples = [];
      autoCalCollector = (info) => samples.push(info.features);
      $("cal-status").textContent = `▶ Listening for ${VOICE_META[v].label}…`;
      for (let i = 0; i < 4; i++) { synth.play(v); await sleep(380); }
      await sleep(260);
      autoCalCollector = null;
      if (samples.length >= 2) {
        engine.calibrateVoice(v, averageFeatures(samples));
        got++;
        $("cal-status").textContent = `✓ ${VOICE_META[v].label} — heard ${samples.length}`;
      } else {
        $("cal-status").textContent = `⚠ ${VOICE_META[v].label} not heard — louder?`;
      }
      await sleep(450); // let decays die before the next voice
    }
  } finally {
    autoCalCollector = null;
    engine.suspendVoiceFilter = false;
    autoCalRunning = false;
    btn.disabled = false; btn.textContent = wasLabel;
    calToggle.disabled = !state.calVoice;
    for (const c of calGrid.children) c.disabled = false;
  }

  if (got === 0) { $("cal-status").textContent = "Couldn’t hear the sounds — turn your volume up and check the mic isn’t muted, then try again."; return; }
  $("cal-status").textContent = `Done — calibrated ${got}/${AUTOCAL_ORDER.length} drums from the built-in kit.`;
  const activeId = kits.activeId();
  if (activeId && kits.get(activeId)) { kits.updateProfiles(activeId, engine.exportProfiles()); setKitStatus("Built-in calibration saved into the active kit."); }
  else { state.kitDirty = true; setKitStatus("Calibrated to the built-in kit — name a kit and Save to keep it."); }
}
$("auto-cal").addEventListener("click", autoCalibrate);

// Recognition self-test: play each built-in voice and check the engine hears it
// as the right drum. Production uses the acoustic path (speakers→mic); under
// ?loopback=1 it's deterministic. Sensitivity is briefly maxed so quiet voices
// still register — this measures *classification*, not loudness.
const TEST_VOICES = ["kick", "snare", "hihat", "tom1", "tom2", "tom3", "ride", "crash"];
async function runRecognitionTest() {
  if (!engine.running) { alert("Turn on the mic first (and turn your volume up if using your real speakers)."); return; }
  if (testRunning || autoCalRunning || state.calibrating) return;
  ensureAudio();
  if (metro.running) { metro.stop(); $("metro-play").classList.remove("playing"); $("metro-play").textContent = "▶ Start the beat"; for (const d of $("beat-dots").children) d.classList.remove("active"); }
  if (player.playing) { player.stop(); }

  testRunning = true;
  const btn = $("test-recog");
  btn.disabled = true; $("auto-cal").disabled = true;
  const savedT = +$("sens-range").value / 100;
  engine.setSensitivity(0.9);            // make sure quiet voices register
  engine.suspendVoiceFilter = true;
  notation.clear();

  const expected = [], detections = [];
  testCollector = (voice, info) => detections.push({ voice, time: info.time });
  $("test-results").hidden = false;

  try {
    for (const v of TEST_VOICES) {
      $("test-results").innerHTML = `<div class="tr-head">▶ Testing ${VOICE_META[v].label}…</div>`;
      for (let i = 0; i < 3; i++) {
        const t = nowTime() + 0.06;
        synth.playAt(v, t);
        expected.push({ voice: v, time: t });
        await sleep(330);
      }
      await sleep(360); // let the decay settle before the next voice
    }
    await sleep(400);
  } finally {
    testCollector = null;
    engine.suspendVoiceFilter = false;
    engine.setSensitivity(savedT);
    btn.disabled = false; $("auto-cal").disabled = false;
    testRunning = false;
  }
  renderTestResults(expected, detections);
}

function renderTestResults(expected, detections) {
  const WIN = 0.2; // ±200 ms to call a detection "the same hit"
  const used = new Set();
  const per = {};
  for (const v of TEST_VOICES) per[v] = { total: 0, correct: 0, miss: 0, confused: {} };
  for (const e of expected) {
    per[e.voice].total++;
    let best = -1, bestDt = WIN;
    for (let i = 0; i < detections.length; i++) {
      if (used.has(i)) continue;
      const dt = Math.abs(detections[i].time - e.time);
      if (dt <= bestDt) { best = i; bestDt = dt; }
    }
    if (best === -1) { per[e.voice].miss++; continue; }
    used.add(best);
    const dv = detections[best].voice;
    if (dv === e.voice) per[e.voice].correct++;
    else per[e.voice].confused[dv] = (per[e.voice].confused[dv] || 0) + 1;
  }
  const totalCorrect = TEST_VOICES.reduce((s, v) => s + per[v].correct, 0);
  const totalAll = TEST_VOICES.reduce((s, v) => s + per[v].total, 0);
  const rows = TEST_VOICES.map((v) => {
    const p = per[v], ok = p.correct === p.total;
    const conf = Object.entries(p.confused).map(([k, n]) => `${n}× ${VOICE_META[k].label}`).join(", ");
    const note = [conf, p.miss ? `${p.miss} not heard` : ""].filter(Boolean).join("; ");
    return `<div class="tr-row ${ok ? "ok" : "warn"}"><span>${ok ? "✓" : "⚠"} ${VOICE_META[v].label}</span><span>${p.correct}/${p.total}${note ? ` · ${note}` : ""}</span></div>`;
  }).join("");
  $("test-results").innerHTML =
    `<div class="tr-head">Recognition: ${totalCorrect}/${totalAll} correct</div>${rows}` +
    `<div class="tr-foot">If a drum is wrong, calibrate to the built-in kit (or your real kit) and re-test.</div>`;
  if (window.__dc) window.__dc.lastTest = { per, totalCorrect, totalAll };
}
$("test-recog").addEventListener("click", runRecognitionTest);

// ===========================================================================
// SETTINGS — kit profiles
// ===========================================================================
function setKitStatus(m) { $("kit-status").textContent = m; }
function refreshKitSelect() {
  const sel = $("kit-select"), activeId = kits.activeId();
  sel.innerHTML = "";
  const def = document.createElement("option"); def.value = ""; def.textContent = "Default (uncalibrated)"; sel.appendChild(def);
  for (const k of kits.list()) { const o = document.createElement("option"); o.value = k.id; o.textContent = k.name; sel.appendChild(o); }
  sel.value = activeId && kits.get(activeId) ? activeId : "";
  $("kit-delete").disabled = !sel.value;
}
function onActiveKitChanged() {
  patterns.setActive(null); $("pattern-name").value = ""; $("pattern-store-status").textContent = ""; refreshPatternSelect();
}
function loadKit(id) {
  if (!id) { engine.resetProfiles(); kits.setActive(null); state.kitDirty = false; refreshKitSelect(); onActiveKitChanged(); setKitStatus("Using default (uncalibrated) profiles."); return; }
  const rec = kits.get(id); if (!rec) { refreshKitSelect(); return; }
  engine.importProfiles(rec.profiles); kits.setActive(id); state.kitDirty = false;
  $("kit-name").value = rec.name; refreshKitSelect(); onActiveKitChanged(); setKitStatus(`Loaded kit “${rec.name}”.`);
}
$("kit-select").addEventListener("change", (e) => loadKit(e.target.value));
$("kit-save").addEventListener("click", () => {
  const name = $("kit-name").value.trim(); if (!name) { setKitStatus("Type a name first, then Save."); $("kit-name").focus(); return; }
  const rec = kits.save(name, engine.exportProfiles()); state.kitDirty = false; refreshKitSelect(); onActiveKitChanged();
  setKitStatus(`Saved kit “${rec.name}”. It loads automatically next time.`);
});
$("kit-delete").addEventListener("click", () => {
  const id = $("kit-select").value, rec = id && kits.get(id); if (!rec) return;
  if (!confirm(`Delete saved kit “${rec.name}”?`)) return;
  kits.remove(id); patterns.removeForKit(id); engine.resetProfiles(); $("kit-name").value = "";
  refreshKitSelect(); onActiveKitChanged(); setKitStatus(`Deleted “${rec.name}”. Back to default profiles.`);
});
$("forget-cal").addEventListener("click", () => {
  if (state.calibrating) stopCalibration();
  engine.resetProfiles(); kits.setActive(null); $("kit-name").value = "";
  refreshKitSelect(); onActiveKitChanged(); setKitStatus("Reverted to default profiles. Saved kits are untouched.");
});

// ===========================================================================
// SETTINGS — detection
// ===========================================================================
// Slider 0..100, left = strict (only loud hits), right = sensitive.
$("sens-range").addEventListener("input", (e) => { engine.setSensitivity(+e.target.value / 100); });
$("voice-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $("voice-mode").querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
  b.classList.add("sel"); engine.setVoiceRejection(b.dataset.mode);
});

// ===========================================================================
// CLOUD SYNC
// ===========================================================================
function onCloudData() {
  refreshKitSelect(); refreshPatternSelect();
  const id = kits.activeId(), rec = id && kits.get(id);
  if (rec) engine.importProfiles(rec.profiles);
}
function updateSyncUi(status) {
  const btn = $("sync-btn");
  if (status.state === "disabled") { btn.hidden = true; return; }
  btn.hidden = false;
  if (status.state === "connecting") { btn.textContent = "☁ …"; btn.disabled = true; return; }
  btn.disabled = false;
  if (status.state === "anonymous") { btn.textContent = "☁ Sync"; btn.title = "Save & sync your kits and patterns to your Google account"; }
  else if (status.state === "signed-in") { btn.textContent = `☁ ${status.user?.displayName || "Synced"}`; btn.title = "Synced · tap to sign out"; }
  else if (status.state === "error") { btn.textContent = "☁ Retry"; }
}
$("sync-btn").addEventListener("click", () => {
  const st = cloud.status();
  if (st.state === "anonymous" || st.state === "error") cloud.signInWithGoogle();
  else if (st.state === "signed-in") { if (confirm("Sign out of sync? Your data stays on this device.")) cloud.signOutToGuest(); }
});

// ===========================================================================
// ONBOARDING
// ===========================================================================
const OB = [
  { icon: "🥁", h: "Hi! Ready to drum?", p: "DrumCoach listens while you play and shows whether your timing is steady. Three quick things and you’re off.", primary: "Next" },
  { icon: "🎙️", h: "Turn on your mic", p: "DrumCoach hears your drums through this device’s microphone. Everything happens on your device — nothing is recorded or sent anywhere.", tag: "Private by design", primary: "Turn on mic", ghost: "Skip" },
  { icon: "🎯", h: "Set a beat and play", p: "Pick a tempo, start the click, and play along. Watch the timing panel to see if you’re speeding up, slowing down, or right in the pocket. You can calibrate your kit any time for sharper feedback.", primary: "Start drumming" },
];
let obStep = 0;
function buildObDots() { const el = $("ob-dots"); el.innerHTML = ""; OB.forEach((_, i) => { const d = document.createElement("i"); if (i === 0) d.className = "on"; el.appendChild(d); }); }
function renderOb() {
  const s = OB[obStep];
  $("ob-content").innerHTML =
    `<div class="ob-icon">${s.icon}</div><h3>${s.h}</h3><p>${s.p}</p>` +
    (s.tag ? `<div class="center"><span class="tag">✓ ${s.tag}</span></div>` : "") +
    `<div class="ob-actions">${s.ghost ? `<button class="ghost" id="ob-ghost">${s.ghost}</button>` : ""}<button class="primary" id="ob-next">${s.primary}</button></div>`;
  [...$("ob-dots").children].forEach((d, i) => d.classList.toggle("on", i === obStep));
  $("ob-next").onclick = obNext;
  if (s.ghost) $("ob-ghost").onclick = obAdvance;
}
function obNext() { if (obStep === 1) startMic(); obAdvance(); }
function obAdvance() { if (obStep < OB.length - 1) { obStep++; renderOb(); } else closeOb(); }
function openOb() { obStep = 0; renderOb(); $("overlay").hidden = false; }
function closeOb() { $("overlay").hidden = true; localStorage.setItem("drumcoach.onboarded.v2", "1"); }
$("replay-btn").addEventListener("click", openOb);

// ===========================================================================
// RENDER LOOP
// ===========================================================================
function loop() {
  const now = nowTime();
  const grid = metro.getGrid();
  if (state.practice && grid) { seq.update(now, grid); updateScore(); }
  // live staff
  notation.setBeats(metro.beatsInWindow(now, notation.windowSeconds));
  notation.setTargets(grid ? seq.targetsInWindow(now, grid, notation.windowSeconds, 0) : []);
  notation.render(now);
  updateStats();
  requestAnimationFrame(loop);
}

// ===========================================================================
// DEFAULT PATTERN + BOOT
// ===========================================================================
function seedDefaultBeat() {
  // basic rock beat at eighths: hats every step, snare on 2&4, kick on 1&3
  seq.setStepsPerBeat(2); seq.setBeatsPerBar(4); seq.setBars(1);
  const sub = seq.stepsPerBeat;
  for (let i = 0; i < seq.totalSteps; i++) seq.active.add(`hihat:${i}`);
  seq.active.add(`snare:${1 * sub}`); seq.active.add(`snare:${3 * sub}`);
  seq.active.add(`kick:${0 * sub}`); seq.active.add(`kick:${2 * sub}`);
}

buildBeatDots();
buildDrumAdder();
buildCalGrid();

(function restoreKit() {
  const id = kits.activeId(), rec = id && kits.get(id);
  if (rec) { engine.importProfiles(rec.profiles); $("kit-name").value = rec.name; setKitStatus(`Loaded saved kit “${rec.name}”.`); }
  refreshKitSelect();
})();

(function restorePattern() {
  const id = patterns.activeId(), rec = id && patterns.get(id);
  if (rec && (rec.kitId || null) === (kits.activeId() || null)) {
    applyPattern(rec.data); $("pattern-name").value = rec.name; $("pattern-store-status").textContent = `Restored “${rec.name}”.`;
  } else {
    if (rec) patterns.setActive(null);
    seedDefaultBeat(); buildGrid();
  }
  refreshPatternSelect();
})();

setBpm(88);
cloud.onUpdate(onCloudData).onStatus(updateSyncUi);
// Skip cloud sync in loopback/test mode so e2e tests are hermetic (no real
// Firestore data leaking in and making runs non-deterministic).
if (LOOPBACK) updateSyncUi({ state: "disabled" });
else cloud.start();

if (!localStorage.getItem("drumcoach.onboarded.v2")) { buildObDots(); openOb(); }
else buildObDots();

requestAnimationFrame(loop);
