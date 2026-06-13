// drum-synth.js — tiny Web Audio drum-voice synthesizer for sample previews.
//
// Used to play a short "this is what a snare sounds like" when the player clicks
// the speaker icon next to a drum. We synthesize each voice with plain Web Audio
// (oscillators + filtered noise) rather than pulling in Tone.js: the project is
// dependency-free static ES modules, Tone's drum voices are themselves
// synthesized (not real samples), and this keeps everything offline.

export class DrumSynth {
  constructor() {
    this.ctx = null;
  }

  // Lazily create / resume the context. Always call from a user gesture.
  _ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  play(voice) {
    const ctx = this._ensure();
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(ctx.destination);

    switch (voice) {
      case "kick":  this._kick(ctx, t, out); break;
      case "snare": this._snare(ctx, t, out); break;
      case "tom1":  this._tom(ctx, t, out, 260); break;
      case "tom2":  this._tom(ctx, t, out, 190); break;
      case "tom3":  this._tom(ctx, t, out, 130); break;
      case "hihat": this._hat(ctx, t, out, 0.06); break;
      case "ride":  this._cymbal(ctx, t, out, 0.6, 0.32, 9000); break;
      case "crash": this._cymbal(ctx, t, out, 1.3, 0.5, 6000); break;
    }
  }

  _noise(ctx, dur) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  _kick(ctx, t, out) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.42);
  }

  _snare(ctx, t, out) {
    // Noisy crack.
    const noise = this._noise(ctx, 0.22);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1400;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.8, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    noise.connect(hp).connect(ng).connect(out);
    noise.start(t);
    noise.stop(t + 0.22);
    // Tonal body.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 180;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  _tom(ctx, t, out, freq) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  _hat(ctx, t, out, decay) {
    const noise = this._noise(ctx, decay + 0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    noise.connect(hp).connect(g).connect(out);
    noise.start(t);
    noise.stop(t + decay + 0.05);
  }

  _cymbal(ctx, t, out, decay, level, bpHz) {
    const noise = this._noise(ctx, decay + 0.1);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5000;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = bpHz;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    noise.connect(hp).connect(bp).connect(g).connect(out);
    noise.start(t);
    noise.stop(t + decay + 0.1);
  }
}
