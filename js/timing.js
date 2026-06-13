// timing.js — tempo + timing analysis.
//
// Two jobs:
//   1. Estimate the player's live BPM from inter-onset intervals (no metronome
//      needed) — for free-play feedback.
//   2. When a metronome grid is supplied, measure how far each hit lands from
//      the nearest grid line and whether the player is rushing or dragging.

export class TimingAnalyzer {
  constructor() {
    this.onsets = [];            // recent onset times (seconds)
    this.maxOnsets = 32;
    this.errors = [];            // signed timing errors vs grid (seconds)
    this.maxErrors = 24;
  }

  reset() { this.onsets = []; this.errors = []; }

  /**
   * Register an onset. If grid info is given, also record drift.
   * @param {number} time onset time (AudioContext seconds)
   * @param {object} [grid] { bpm, startTime } describing the metronome
   */
  addOnset(time, grid) {
    this.onsets.push(time);
    if (this.onsets.length > this.maxOnsets) this.onsets.shift();

    if (grid && grid.bpm > 0) {
      const beat = 60 / grid.bpm;
      const rel = time - grid.startTime;
      const nearest = Math.round(rel / beat) * beat;
      const err = rel - nearest;          // + = late/dragging, − = early/rushing
      if (Math.abs(err) < beat * 0.5) {
        this.errors.push(err);
        if (this.errors.length > this.maxErrors) this.errors.shift();
      }
      return err;
    }
    return null;
  }

  /** Median inter-onset interval based BPM, folded into a musical range. */
  estimateBPM() {
    if (this.onsets.length < 4) return null;
    const iois = [];
    for (let i = 1; i < this.onsets.length; i++) {
      const d = this.onsets[i] - this.onsets[i - 1];
      if (d > 0.1 && d < 2.0) iois.push(d); // ignore flams & long gaps
    }
    if (iois.length < 3) return null;

    iois.sort((a, b) => a - b);
    let ioi = iois[Math.floor(iois.length / 2)]; // median

    // Fold into 40–240 BPM by doubling/halving the interval.
    let bpm = 60 / ioi;
    while (bpm < 40) bpm *= 2;
    while (bpm > 240) bpm /= 2;
    return Math.round(bpm);
  }

  /** 0..1 steadiness from the coefficient of variation of recent IOIs. */
  steadiness() {
    if (this.onsets.length < 5) return null;
    const iois = [];
    for (let i = 1; i < this.onsets.length; i++) {
      const d = this.onsets[i] - this.onsets[i - 1];
      if (d > 0.1 && d < 2.0) iois.push(d);
    }
    if (iois.length < 4) return null;
    const mean = iois.reduce((a, b) => a + b, 0) / iois.length;
    const variance = iois.reduce((a, b) => a + (b - mean) ** 2, 0) / iois.length;
    const cv = Math.sqrt(variance) / (mean || 1);
    return Math.max(0, Math.min(1, 1 - cv * 4)); // cv 0 → 1.0, cv 0.25 → 0
  }

  /**
   * Drift summary vs the metronome grid.
   * @returns {{ms:number, label:string} | null}
   */
  drift() {
    if (this.errors.length < 3) return null;
    const mean = this.errors.reduce((a, b) => a + b, 0) / this.errors.length;
    const ms = mean * 1000;
    let label = "on time";
    if (ms > 18) label = "dragging (behind)";
    else if (ms < -18) label = "rushing (ahead)";
    return { ms: Math.round(ms), label };
  }

  /** Spread of recent timing errors in ms (lower = tighter). */
  tightnessMs() {
    if (this.errors.length < 3) return null;
    const mean = this.errors.reduce((a, b) => a + b, 0) / this.errors.length;
    const variance = this.errors.reduce((a, b) => a + (b - mean) ** 2, 0) / this.errors.length;
    return Math.round(Math.sqrt(variance) * 1000);
  }
}
