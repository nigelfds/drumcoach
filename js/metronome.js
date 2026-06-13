// metronome.js — a lookahead-scheduled metronome.
//
// Uses the classic Web Audio "tale of two clocks" pattern: a setInterval timer
// looks a short way into the future and schedules click sounds at precise
// AudioContext times, so timing stays rock-solid even if the JS thread stutters.

export class Metronome {
  constructor() {
    this.ctx = null;
    this.bpm = 100;
    this.beatsPerBar = 4;
    this.running = false;

    this.startTime = 0;          // ctx time of beat 0 of the current run
    this._nextBeat = 0;          // index of the next beat to schedule
    this._lookahead = 0.1;       // seconds to schedule ahead
    this._interval = 25;         // ms scheduler tick
    this._timer = null;
    this.volume = 0.6;

    this.scheduled = [];         // { time, index, strong } pending/recent beats
    this._onBeat = null;         // (index, time, strong) for visuals
  }

  setContext(ctx) { this.ctx = ctx; return this; }
  onBeat(fn) { this._onBeat = fn; return this; }

  setBpm(bpm) {
    bpm = Math.max(30, Math.min(300, Math.round(bpm)));
    if (this.running && this.ctx) {
      // Re-anchor so the phase is continuous from "now".
      const now = this.ctx.currentTime;
      const elapsedBeats = Math.round((now - this.startTime) / (60 / this.bpm));
      this.bpm = bpm;
      this.startTime = now - elapsedBeats * (60 / this.bpm);
    } else {
      this.bpm = bpm;
    }
  }

  setBeatsPerBar(n) { this.beatsPerBar = Math.max(1, Math.min(16, n | 0)); }

  /** The grid description the TimingAnalyzer consumes. */
  getGrid() { return this.running ? { bpm: this.bpm, startTime: this.startTime } : null; }

  start() {
    if (this.running || !this.ctx) return;
    this.running = true;
    this.startTime = this.ctx.currentTime + 0.12; // small lead-in
    this._nextBeat = 0;
    this.scheduled = [];
    this._timer = setInterval(() => this._schedule(), this._interval);
  }

  stop() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  toggle() { this.running ? this.stop() : this.start(); }

  _schedule() {
    if (!this.ctx) return;
    const beat = 60 / this.bpm;
    const horizon = this.ctx.currentTime + this._lookahead;
    while (this.startTime + this._nextBeat * beat < horizon) {
      const time = this.startTime + this._nextBeat * beat;
      const strong = this._nextBeat % this.beatsPerBar === 0;
      this._click(time, strong);
      this.scheduled.push({ time, index: this._nextBeat, strong });

      // Visual callback aligned to audio time.
      if (this._onBeat) {
        const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
        const idx = this._nextBeat, str = strong;
        setTimeout(() => this._onBeat(idx, time, str), delayMs);
      }
      this._nextBeat++;
    }
    // Trim old scheduled beats (keep a few seconds for the notation grid).
    const cutoff = this.ctx.currentTime - 6;
    this.scheduled = this.scheduled.filter((b) => b.time > cutoff);
  }

  _click(time, strong) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = strong ? 1500 : 900;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(this.volume * (strong ? 1 : 0.7), time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  /** Beat lines (incl. future) within a time window, for the notation grid. */
  beatsInWindow(now, windowSeconds) {
    if (!this.running) return [];
    const beat = 60 / this.bpm;
    const out = [];
    const from = now - windowSeconds;
    const to = now + 0.5;
    let i = Math.floor((from - this.startTime) / beat);
    if (i < 0) i = 0;
    for (let t = this.startTime + i * beat; t <= to; t += beat, i++) {
      out.push({ time: t, strong: i % this.beatsPerBar === 0 });
    }
    return out;
  }
}
