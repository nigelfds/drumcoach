// pattern-player.js — plays the annotated sequencer pattern through the
// DrumSynth, optionally looping. Uses the same lookahead-scheduling pattern as
// the metronome so step timing stays tight, and works independently of the
// microphone (it borrows the synth's own AudioContext as its clock).

export class PatternPlayer {
  /**
   * @param {object} synth  DrumSynth (provides context() + playAt(voice, time))
   * @param {object} seq    PatternSequencer (active cells + grid dimensions)
   * @param {number} [bpm]  initial playback tempo
   */
  constructor(synth, seq, bpm = 100) {
    this.synth = synth;
    this.seq = seq;
    this.bpm = bpm;

    this.loop = true;
    this.playing = false;

    this._lookahead = 0.1;   // seconds scheduled ahead
    this._interval = 25;     // ms scheduler tick
    this._timer = null;
    this._nextStep = 0;      // absolute step counter since start
    this._nextStepTime = 0;  // ctx time of the next step

    this.onStep = null;      // (stepInLoop) — for the visual playhead
    this.onStop = null;      // () — fired when playback ends
  }

  start() {
    if (this.playing) return;
    const ctx = this.synth.context();
    this.playing = true;
    this._ending = false;
    this._nextStep = 0;
    this._nextStepTime = ctx.currentTime + 0.12; // small lead-in
    this._timer = setInterval(() => this._schedule(ctx), this._interval);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this._ending = false;
    clearInterval(this._timer);
    this._timer = null;
    if (this.onStop) this.onStop();
  }

  toggle() { this.playing ? this.stop() : this.start(); }

  _schedule(ctx) {
    if (this._ending) return; // one-shot finished; awaiting the deferred stop()
    const bpm = this.bpm || 100;
    const stepDur = 60 / bpm / this.seq.stepsPerBeat;
    const total = this.seq.totalSteps;
    const horizon = ctx.currentTime + this._lookahead;

    while (this.playing && this._nextStepTime < horizon) {
      const stepInLoop = this._nextStep % total;
      const time = this._nextStepTime;

      // Sound every active voice on this step.
      for (const voice of this.seq.voiceKeys) {
        if (this.seq.isActive(voice, stepInLoop)) this.synth.playAt(voice, time);
      }

      // Drive the visual playhead, aligned to audio time.
      if (this.onStep) {
        const s = stepInLoop;
        const delay = Math.max(0, (time - ctx.currentTime) * 1000);
        setTimeout(() => { if (this.playing) this.onStep(s); }, delay);
      }

      this._nextStep++;
      this._nextStepTime += stepDur;

      // One-shot: stop right after the final step has sounded. The _ending flag
      // blocks any further scheduling until the deferred stop() runs, so no
      // extra wrapped note slips in at the loop boundary.
      if (!this.loop && this._nextStep >= total) {
        this._ending = true;
        const stopDelay = Math.max(0, (this._nextStepTime - ctx.currentTime) * 1000);
        setTimeout(() => this.stop(), stopDelay);
        return;
      }
    }
  }
}
