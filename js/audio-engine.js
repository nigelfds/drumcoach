// audio-engine.js — microphone capture, onset detection, drum classification.
//
// Pipeline:
//   getUserMedia → AnalyserNode (polled per animation frame)
//   → spectral-flux onset detection
//   → per-band spectral features
//   → nearest-profile classification (defaults, refinable via calibration)
//
// Classifying drum voices from one mic is inherently fuzzy. We use band-energy
// fractions + spectral centroid compared against per-voice feature centroids.
// Calibration lets the user overwrite a voice's centroid with their own kit.

// Frequency band edges in Hz. Fractions of energy in these bands form the core
// of the feature vector.
const BANDS = [
  ["sub", 20, 60],
  ["low", 60, 120],
  ["lowMid", 120, 250],
  ["mid", 250, 2000],
  ["high", 2000, 6000],
  ["veryHigh", 6000, 16000],
];

const FEATURE_KEYS = ["sub", "low", "lowMid", "mid", "high", "veryHigh", "centroidN"];

// Default voice centroids in normalized feature space (band fractions sum ≈ 1,
// centroidN = spectral centroid / 8000, clamped 0..1). Hand-tuned starting
// points; calibration replaces these per voice.
export const DEFAULT_PROFILES = {
  kick:  { sub: 0.45, low: 0.35, lowMid: 0.12, mid: 0.06, high: 0.01, veryHigh: 0.01, centroidN: 0.03, level: 1, decay: 1 },
  hihat: { sub: 0.01, low: 0.02, lowMid: 0.05, mid: 0.12, high: 0.35, veryHigh: 0.45, centroidN: 0.62, level: 0.4, decay: 0.4 },
  snare: { sub: 0.05, low: 0.08, lowMid: 0.15, mid: 0.35, high: 0.22, veryHigh: 0.15, centroidN: 0.35, level: 1, decay: 1 },
  tom1:  { sub: 0.08, low: 0.18, lowMid: 0.40, mid: 0.25, high: 0.06, veryHigh: 0.03, centroidN: 0.12, level: 1, decay: 1 },
  tom2:  { sub: 0.12, low: 0.30, lowMid: 0.38, mid: 0.15, high: 0.03, veryHigh: 0.02, centroidN: 0.08, level: 1, decay: 1 },
  tom3:  { sub: 0.22, low: 0.40, lowMid: 0.28, mid: 0.07, high: 0.02, veryHigh: 0.01, centroidN: 0.05, level: 1, decay: 1 },
  ride:  { sub: 0.02, low: 0.03, lowMid: 0.07, mid: 0.20, high: 0.30, veryHigh: 0.38, centroidN: 0.55, level: 0.5, decay: 1.3 },
  crash: { sub: 0.03, low: 0.05, lowMid: 0.10, mid: 0.22, high: 0.30, veryHigh: 0.30, centroidN: 0.48, level: 1.0, decay: 2.0 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.running = false;

    this.fftSize = 2048;
    this.profiles = structuredClone(DEFAULT_PROFILES);

    // Onset state.
    this._prevSpectrum = null;
    this._fluxHistory = [];
    this._lastOnsetAt = 0;
    this._minOnsetGap = 0.06;        // seconds debounce between hits
    this.sensitivity = 1.0;          // user-adjustable multiplier (lower = more sensitive)
    this._energyFloor = null;        // per-signal ambient floor, for fair gating

    // Decay tracking for the in-progress hit.
    this._captureUntil = 0;
    this._peakLevel = 0;
    this._aboveHalfFrames = 0;

    // Listeners.
    this._onHit = null;              // (voice, info)
    this._onLevel = null;            // (level 0..1) for the meter
    this._onFeatures = null;         // (features) raw, used by calibration

    this._raf = null;
    this._tick = this._tick.bind(this);
  }

  onHit(fn) { this._onHit = fn; return this; }
  onLevel(fn) { this._onLevel = fn; return this; }
  onFeatures(fn) { this._onFeatures = fn; return this; }

  /** AudioContext clock — the single source of truth for timing. */
  now() { return this.ctx ? this.ctx.currentTime : performance.now() / 1000; }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0; // we want raw frames for flux
    source.connect(this.analyser);

    this._freq = new Float32Array(this.analyser.frequencyBinCount);
    this._binHz = this.ctx.sampleRate / this.fftSize;

    this._energyFloor = null;
    this._fluxHistory = [];
    this._prevSpectrum = null;
    this.running = true;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close();
    this.ctx = this.analyser = this.stream = null;
  }

  _tick() {
    if (!this.running) return;
    this.analyser.getFloatFrequencyData(this._freq); // dB values

    const feat = this._features(this._freq);
    if (this._onLevel) {
      // Log-scaled meter so quiet, high-frequency hits (hi-hat, ride) are
      // visible too — not just the bass-heavy kick.
      const meter = Math.max(0, Math.min(1, (Math.log10(feat.energy + 1e-9) + 6) / 6));
      this._onLevel(meter);
    }

    const flux = this._spectralFlux(this._freq);
    const t = this.now();

    // Track decay of the current hit window.
    if (t < this._captureUntil) {
      this._peakLevel = Math.max(this._peakLevel, feat.level);
      if (feat.level > this._peakLevel * 0.5) this._aboveHalfFrames++;
    }

    if (this._isOnset(flux, feat, t)) {
      this._lastOnsetAt = t;
      this._captureUntil = t + 0.18;
      this._peakLevel = feat.level;
      this._aboveHalfFrames = 1;

      // Defer classification by a couple frames so the spectrum settles, then
      // emit. We approximate "settled" by classifying on the onset frame; good
      // enough at 60fps for practice.
      const decayHint = this._aboveHalfFrames;
      const { voice, confidence, scores } = this.classify(feat, decayHint);
      if (this._onFeatures) this._onFeatures(feat);
      if (this._onHit) this._onHit(voice, { time: t, confidence, features: feat, scores });
    }

    this._raf = requestAnimationFrame(this._tick);
  }

  // --- feature extraction -------------------------------------------------

  _features(freqDb) {
    // Convert dB to linear magnitude and accumulate per band.
    const bandEnergy = Object.fromEntries(BANDS.map(([n]) => [n, 0]));
    let total = 0, centroidNum = 0, centroidDen = 0;

    for (let i = 1; i < freqDb.length; i++) {
      const hz = i * this._binHz;
      if (hz > 16000) break;
      const mag = Math.pow(10, freqDb[i] / 20); // dB → amplitude
      const e = mag * mag;
      total += e;
      centroidNum += hz * e;
      centroidDen += e;
      for (const [name, lo, hi] of BANDS) {
        if (hz >= lo && hz < hi) { bandEnergy[name] += e; break; }
      }
    }

    const safe = total || 1e-9;
    const frac = {};
    for (const [name] of BANDS) frac[name] = bandEnergy[name] / safe;
    const centroid = centroidDen ? centroidNum / centroidDen : 0;
    frac.centroidN = Math.min(1, centroid / 8000);
    frac.centroid = centroid;
    frac.energy = total;                // raw spectral energy (for fair gating)
    frac.level = Math.sqrt(total) / 40; // rough loudness proxy
    return frac;
  }

  _spectralFlux(freqDb) {
    if (!this._prevSpectrum) {
      this._prevSpectrum = freqDb.slice();
      return 0;
    }
    let flux = 0;
    for (let i = 1; i < freqDb.length; i++) {
      const cur = Math.pow(10, freqDb[i] / 20);
      const prev = Math.pow(10, this._prevSpectrum[i] / 20);
      const d = cur - prev;
      if (d > 0) flux += d;            // half-wave rectified
    }
    this._prevSpectrum.set(freqDb);
    return flux;
  }

  _isOnset(flux, feat, t) {
    // Adaptive threshold = mean + k·std of recent flux.
    this._fluxHistory.push(flux);
    if (this._fluxHistory.length > 43) this._fluxHistory.shift(); // ~0.7s @60fps
    const mean = this._fluxHistory.reduce((a, b) => a + b, 0) / this._fluxHistory.length;
    const variance = this._fluxHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / this._fluxHistory.length;
    const std = Math.sqrt(variance);
    const threshold = (mean + 2.0 * std) * this.sensitivity + 0.0004;

    // Per-signal relative energy floor. It rises slowly and drops instantly, so
    // it tracks the ambient / decay floor of whatever you're playing. A hit then
    // shows up as energy several times above that floor — which is true for a
    // quiet hi-hat just as much as a booming kick. This replaces the old
    // absolute level gate that only the bass-heavy kick could clear.
    const e = feat.energy;
    this._energyFloor = this._energyFloor == null
      ? e
      : Math.min(e, this._energyFloor * 1.06 + 1e-8);
    const aboveFloor = e > this._energyFloor * 3.5 && e > 2e-6;

    const debounced = t - this._lastOnsetAt > this._minOnsetGap;
    return flux > threshold && aboveFloor && debounced;
  }

  // --- classification -----------------------------------------------------

  /** Nearest-centroid classifier over normalized features. */
  classify(feat, decayHint = 1) {
    let best = null, bestDist = Infinity, second = Infinity;
    const scores = {};
    for (const [voice, p] of Object.entries(this.profiles)) {
      let d = 0;
      for (const k of FEATURE_KEYS) {
        const w = k === "centroidN" ? 1.5 : 1; // weight centroid a bit more
        d += w * (feat[k] - p[k]) ** 2;
      }
      const dist = Math.sqrt(d);
      scores[voice] = dist;
      if (dist < bestDist) { second = bestDist; bestDist = dist; best = voice; }
      else if (dist < second) { second = dist; }
    }

    // Confidence: how much closer the winner is than the runner-up.
    const confidence = second === Infinity ? 0.5
      : Math.max(0, Math.min(1, (second - bestDist) / (second + 1e-6)));
    return { voice: best, confidence, scores };
  }

  /** Replace one voice's profile centroid from an averaged feature sample. */
  calibrateVoice(voice, feat) {
    if (!this.profiles[voice]) return;
    const p = {};
    for (const k of FEATURE_KEYS) p[k] = feat[k];
    p.centroid = feat.centroid;
    p.level = this.profiles[voice].level;
    p.decay = this.profiles[voice].decay;
    this.profiles[voice] = p;
  }

  resetProfiles() { this.profiles = structuredClone(DEFAULT_PROFILES); }

  exportProfiles() { return structuredClone(this.profiles); }
  importProfiles(p) { if (p) this.profiles = structuredClone(p); }
}
