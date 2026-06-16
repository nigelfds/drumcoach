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
// Measured from the built-in DrumSynth voices (FFT of each rendered voice
// through the same bands/centroid the classifier uses). These match the synth's
// actual spectra, so the pattern-maker sounds are recognised correctly out of
// the box. Calibrate to override per voice for a real kit.
export const DEFAULT_PROFILES = {
  kick:  { sub: 0.000, low: 0.433, lowMid: 0.567, mid: 0.000, high: 0.000, veryHigh: 0.000, centroidN: 0.015, level: 1, decay: 1 },
  hihat: { sub: 0.000, low: 0.000, lowMid: 0.000, mid: 0.000, high: 0.077, veryHigh: 0.923, centroidN: 1.000, level: 1, decay: 1 },
  snare: { sub: 0.000, low: 0.000, lowMid: 0.164, mid: 0.061, high: 0.227, veryHigh: 0.548, centroidN: 0.871, level: 1, decay: 1 },
  tom1:  { sub: 0.000, low: 0.000, lowMid: 0.591, mid: 0.409, high: 0.000, veryHigh: 0.000, centroidN: 0.031, level: 1, decay: 1 },
  tom2:  { sub: 0.000, low: 0.000, lowMid: 1.000, mid: 0.000, high: 0.000, veryHigh: 0.000, centroidN: 0.022, level: 1, decay: 1 },
  tom3:  { sub: 0.000, low: 0.363, lowMid: 0.637, mid: 0.000, high: 0.000, veryHigh: 0.000, centroidN: 0.015, level: 1, decay: 1 },
  ride:  { sub: 0.000, low: 0.000, lowMid: 0.000, mid: 0.000, high: 0.127, veryHigh: 0.873, centroidN: 1.000, level: 1, decay: 1 },
  crash: { sub: 0.000, low: 0.000, lowMid: 0.000, mid: 0.000, high: 0.211, veryHigh: 0.789, centroidN: 1.000, level: 1, decay: 1 },
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
    this._fluxK = 2.0;               // flux must be this many std above the mean
    this._floorMult = 3.5;           // hit energy must exceed this × the ambient floor
    this.setSensitivity(0.3);        // default: lean toward only loud, clear hits
    this._energyFloor = null;        // per-signal ambient floor, for fair gating
    this._vhFloor = null;            // high-band floor, for layered-cymbal detection

    // Voice rejection: "off" | "moderate" | "aggressive". The gate sits between
    // onset detection and hit emission, so "off" leaves the pipeline untouched.
    this.voiceRejection = "aggressive";
    this.suspendVoiceFilter = false;  // bypass while calibrating (no talking then)
    this._candidate = null;           // pending onset awaiting a short decay watch
    this._voiceRun = 0;               // consecutive voice-like frames (for VAD)
    this._voiceActive = false;        // VAD: are we mid-speech right now?

    // Listeners.
    this._onHit = null;              // (voice, info)
    this._onLevel = null;            // (level 0..1) for the meter
    this._onFeatures = null;         // (features) raw, used by calibration
    this._onVoiceReject = null;      // (info) fired when a hit is filtered as voice

    this._raf = null;
    this._tick = this._tick.bind(this);
  }

  onHit(fn) { this._onHit = fn; return this; }
  onLevel(fn) { this._onLevel = fn; return this; }
  onFeatures(fn) { this._onFeatures = fn; return this; }
  onVoiceReject(fn) { this._onVoiceReject = fn; return this; }

  /**
   * Detection sensitivity. t in [0,1]:
   *   0 = only loud, clear, sharp hits (ignores soft taps + background)
   *   1 = very sensitive (also catches quiet taps)
   * Drives both the flux threshold (how sharp the transient must be) and the
   * energy-floor gate (how far above the ambient floor a hit must be).
   */
  setSensitivity(t) {
    t = Math.max(0, Math.min(1, t));
    this._fluxK = 3.6 - 2.4 * t;     // 3.6 (strict) → 1.2 (loose)
    this._floorMult = 9 - 5.5 * t;   // 9× (strict) → 3.5× (loose)
  }

  setVoiceRejection(mode) {
    if (["off", "moderate", "aggressive"].includes(mode)) this.voiceRejection = mode;
  }

  /** AudioContext clock — the single source of truth for timing. */
  now() { return this.ctx ? this.ctx.currentTime : performance.now() / 1000; }

  async start(externalCtx, externalStream) {
    if (this.running) return;
    // A caller can inject a stream (e.g. a synth-fed loopback for testing); else
    // use the real microphone.
    if (externalStream) { this.stream = externalStream; this._ownStream = false; }
    else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      this._ownStream = true;
    }
    // Share the app's AudioContext when given, so onset timestamps and the
    // metronome grid use one clock. Otherwise create (and own) our own.
    if (externalCtx) { this.ctx = externalCtx; this._ownCtx = false; }
    else { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this._ownCtx = true; }
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0; // we want raw frames for flux
    source.connect(this.analyser);

    this._freq = new Float32Array(this.analyser.frequencyBinCount);
    this._binHz = this.ctx.sampleRate / this.fftSize;

    this._energyFloor = null;
    this._vhFloor = null;
    this._fluxHistory = [];
    this._prevSpectrum = null;
    this._candidate = null;
    this._voiceRun = 0;
    this._voiceActive = false;
    this.running = true;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.stream && this._ownStream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx && this._ownCtx) this.ctx.close(); // don't close a shared ctx
    this.analyser = this.stream = null;
    if (this._ownCtx) this.ctx = null;
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

    this._updateVad(feat);

    // High-band (cymbal/hat) floor + per-frame spike. Kick/toms have no energy
    // ≥6 kHz, so a spike there on a low-drum hit means a cymbal is layered on top.
    const vh = feat.vhAbs;
    this._vhFloor = this._vhFloor == null ? vh : Math.min(vh, this._vhFloor * 1.06 + 1e-9);
    const cymbalFrame = vh > this._vhFloor * 5 && vh > 1e-7;

    // Grow the in-flight candidate's decay-watch window.
    if (this._candidate) {
      this._candidate.frames.push(feat);
      this._candidate.peakEnergy = Math.max(this._candidate.peakEnergy, feat.energy);
      this._noteCymbal(this._candidate, feat, cymbalFrame);
    }

    if (this._isOnset(flux, feat, t)) {
      this._lastOnsetAt = t;
      // A new onset closes any in-progress candidate early, then opens a fresh
      // one. We keep classifying on the onset frame (unchanged), but defer the
      // emit decision until we've watched ~80 ms of decay.
      if (this._candidate) this._finalizeCandidate();
      this._candidate = {
        time: t,                        // true onset time — timing stays exact
        onsetFeat: feat,
        peakEnergy: feat.energy,
        frames: [feat],
        voiceActiveAtOnset: this._voiceActive,
        cymbal: false,
        endsAt: t + 0.13, // long enough to catch the kick's downsweep into sub
      };
      // NB: the onset frame is skipped for cymbal detection — a low drum's attack
      // is a broadband click that would look like a cymbal for one frame.
    }

    // Emit (or reject) a candidate once its decay window has elapsed.
    if (this._candidate && t >= this._candidate.endsAt) this._finalizeCandidate();

    this._raf = requestAnimationFrame(this._tick);
  }

  /** Decide whether a finished candidate is a real drum hit or a voice. */
  _finalizeCandidate() {
    const c = this._candidate;
    this._candidate = null;
    if (!c) return;

    const filter = !this.suspendVoiceFilter && this.voiceRejection !== "off";
    if (filter && this._looksLikeVoice(c)) {
      if (this._onVoiceReject) this._onVoiceReject({ time: c.time });
      return;
    }

    // Classify on the loudest frame of the candidate window (the body of the
    // hit), not the rising-edge onset frame. The peak frame is more stable and
    // matches the profiles (which are measured at the peak), and it decouples
    // classification from how early the onset fired (i.e. from sensitivity).
    let cf = c.onsetFeat, peakE = -Infinity;
    for (const f of c.frames) { if (f.energy > peakE) { peakE = f.energy; cf = f; } }

    let { voice, confidence, scores } = this.classify(cf, 1);

    const LOW_DRUMS = ["kick", "tom1", "tom2", "tom3"];

    // Kick vs floor-tom tiebreak. They're near-identical at the peak, but the
    // kick sweeps down into the sub band (≈45 Hz) over its decay while the floor
    // tom bottoms out higher. When those two are the closest match, decide by
    // how much sub-band energy showed up in the tail of the hit.
    const tail = c.frames.slice(-4);
    const subTail = tail.reduce((s, f) => s + (f.sub || 0), 0) / Math.max(1, tail.length);

    const ranked = Object.entries(scores).sort((a, b) => a[1] - b[1]);
    const top2 = ranked.slice(0, 2).map((e) => e[0]);
    let tiebreak = null;
    if (top2.includes("kick") && top2.includes("tom3")) {
      voice = subTail > 0.15 ? "kick" : "tom3";
      tiebreak = voice;
    }

    if (this._onFeatures) this._onFeatures(cf);
    if (this._onHit) this._onHit(voice, { time: c.time, confidence, features: cf, scores, subTail, tiebreak });

    // Multi-voice: a cymbal/hat layered over a low drum. Low drums have no
    // ≥6 kHz energy of their own, so a high-band spike means a separate cymbal —
    // emit it as a second hit at the same time. (Snare overlaps the cymbal band,
    // so we only do this for kick/toms, never for snare.)
    if (c.cymbal && LOW_DRUMS.includes(voice)) {
      const r = c.cymbalRatio ?? 0.9;
      const cym = r > 0.9 ? "hihat" : r > 0.83 ? "ride" : "crash";
      if (this._onHit) this._onHit(cym, { time: c.time, confidence: 0.5, features: cf, scores: {}, secondary: true, cymbalRatio: r });
    }
  }

  /**
   * Track high-band (cymbal) frames during a candidate. A real cymbal sustains
   * energy ≥6 kHz over multiple frames; a low drum's attack click is a single
   * frame, so we require ≥2 spike frames before believing a cymbal is present.
   */
  _noteCymbal(c, feat, cymbalFrame) {
    if (!cymbalFrame) return;
    c._cymCount = (c._cymCount || 0) + 1;
    if (c._cymCount >= 2) c.cymbal = true;
    if (feat.vhAbs > (c._cymPeak || 0)) {
      c._cymPeak = feat.vhAbs;
      c.cymbalRatio = feat.vhAbs / (feat.highAbs + feat.vhAbs + 1e-12);
    }
  }

  /**
   * Voice gate: reject only when the onset is *sustained* AND *harmonic* AND
   * *speech-banded*. This spares every drum — kick (wrong band), snare/cymbals
   * (too noisy), toms (decay too fast) — while catching held vowels/singing.
   */
  _looksLikeVoice(c) {
    const frames = c.frames;
    if (frames.length < 2) return false;

    const tail = frames.slice(-2);
    const tailEnergy = tail.reduce((s, f) => s + f.energy, 0) / tail.length;
    const sustainRatio = tailEnergy / (c.peakEnergy + 1e-12);
    const avgFlatness = frames.reduce((s, f) => s + f.flatness, 0) / frames.length;
    const avgVoiceBand = frames.reduce((s, f) => s + f.voiceBandFrac, 0) / frames.length;

    const cfg = this.voiceRejection === "aggressive"
      ? { sustain: 0.42, flat: 0.25, band: 0.55 }
      : { sustain: 0.50, flat: 0.20, band: 0.62 };

    const sustained = sustainRatio > cfg.sustain;
    const harmonic = avgFlatness < cfg.flat;
    const voiceBandHeavy = avgVoiceBand > cfg.band;

    const baseVoice = sustained && harmonic && voiceBandHeavy;
    if (this.voiceRejection === "moderate") return baseVoice;

    // Aggressive also rejects harmonic, speech-banded onsets struck while the
    // VAD says we're mid-talking — catches speech whose 80 ms decay looked
    // ambiguous. Non-harmonic hits (snare/cymbal) are still kept.
    return baseVoice || (c.voiceActiveAtOnset && harmonic && voiceBandHeavy);
  }

  /** Rolling voice-activity detector for the aggressive mode's VAD layer. */
  _updateVad(feat) {
    const aboveFloor = this._energyFloor != null && feat.energy > this._energyFloor * 2.5;
    const voiceFrame = aboveFloor && feat.flatness < 0.28 && feat.voiceBandFrac > 0.55;
    this._voiceRun = voiceFrame ? this._voiceRun + 1 : Math.max(0, this._voiceRun - 2);
    this._voiceActive = this._voiceRun > 9; // ~150 ms of continuous speech-like sound
  }

  // --- feature extraction -------------------------------------------------

  _features(freqDb) {
    // Convert dB to linear magnitude and accumulate per band.
    const bandEnergy = Object.fromEntries(BANDS.map(([n]) => [n, 0]));
    let total = 0, centroidNum = 0, centroidDen = 0;
    // Voice-discrimination accumulators.
    let voiceBandE = 0;                 // energy in the speech band (200–3400 Hz)
    let logMagSum = 0, magSum = 0, flatBins = 0; // spectral flatness (250–4000 Hz)

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
      if (hz >= 200 && hz < 3400) voiceBandE += e;
      if (hz >= 250 && hz < 4000) {
        logMagSum += Math.log(mag + 1e-9);
        magSum += mag;
        flatBins++;
      }
    }

    const safe = total || 1e-9;
    const frac = {};
    for (const [name] of BANDS) frac[name] = bandEnergy[name] / safe;
    const centroid = centroidDen ? centroidNum / centroidDen : 0;
    frac.centroidN = Math.min(1, centroid / 8000);
    frac.centroid = centroid;
    frac.energy = total;                // raw spectral energy (for fair gating)
    frac.vhAbs = bandEnergy["veryHigh"]; // absolute high-band (≥6 kHz) energy
    frac.highAbs = bandEnergy["high"];   // absolute 2–6 kHz energy
    frac.level = Math.sqrt(total) / 40; // rough loudness proxy
    frac.voiceBandFrac = voiceBandE / safe; // how speech-banded the frame is
    // Spectral flatness = geometric/arithmetic mean of magnitude: ~0 tonal
    // (voice/tom), ~1 noisy (snare/cymbal). A cheap harmonicity proxy.
    frac.flatness = flatBins
      ? Math.exp(logMagSum / flatBins) / ((magSum / flatBins) + 1e-12)
      : 0;
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
    const threshold = mean + this._fluxK * std + 0.0006;

    // Per-signal relative energy floor. It rises slowly and drops instantly, so
    // it tracks the ambient / decay floor of whatever you're playing. A hit then
    // shows up as energy several times above that floor — which is true for a
    // quiet hi-hat just as much as a booming kick. This replaces the old
    // absolute level gate that only the bass-heavy kick could clear.
    const e = feat.energy;
    this._energyFloor = this._energyFloor == null
      ? e
      : Math.min(e, this._energyFloor * 1.06 + 1e-8);
    const aboveFloor = e > this._energyFloor * this._floorMult && e > 2e-6;

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
