// sequencer.js — annotate a pattern on a step grid (à la Tone.js step sequencer
// / Chrome Music Lab Rhythm) and score the player against it in real time.
//
// The grid is voices (rows) × steps (columns). With a running metronome we map
// each active step to absolute AudioContext times (looping), expose those as
// "targets" for the notation ghost notes, and judge incoming hits against them.

import { VOICES } from "./notation.js";

export class PatternSequencer {
  constructor() {
    this.voiceKeys = Object.keys(VOICES); // crash, ride, tom1, tom2, snare, tom3, kick
    this.bars = 4;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4;       // 16th notes
    this.active = new Set();     // "voice:step"

    this.scoringWindow = 0.12;   // ± seconds counted as a match
    this.tightWindow = 0.045;    // within this = clean "hit", else early/late

    this._instances = new Map(); // id → { voice, time, resolved, judgement }
    this.results = this._emptyResults();
  }

  _emptyResults() {
    return { hit: 0, early: 0, late: 0, miss: 0, extra: 0, total: 0 };
  }

  get stepsPerBar() { return this.beatsPerBar * this.stepsPerBeat; }
  get totalSteps() { return this.bars * this.stepsPerBar; }

  setBars(n) { this.bars = [4, 8, 16].includes(n) ? n : this.bars; this.resetScore(); }
  setBeatsPerBar(n) { this.beatsPerBar = Math.max(1, Math.min(16, n | 0)); this.resetScore(); }

  toggle(voice, step) {
    const key = `${voice}:${step}`;
    if (this.active.has(key)) this.active.delete(key); else this.active.add(key);
    return this.active.has(key);
  }
  isActive(voice, step) { return this.active.has(`${voice}:${step}`); }
  clearPattern() { this.active.clear(); this.resetScore(); }

  resetScore() {
    this._instances.clear();
    this.results = this._emptyResults();
  }

  /** Step duration in seconds for a given tempo. */
  _stepDur(bpm) { return (60 / bpm) / this.stepsPerBeat; }
  _loopDur(bpm) { return this.totalSteps * this._stepDur(bpm); }

  /**
   * Target notes whose absolute time falls within [now - back, now + fwd].
   * Used both for drawing ghost notes and for scoring bookkeeping.
   */
  targetsInWindow(now, grid, back = 4, fwd = 0.6) {
    if (!grid || !grid.bpm) return [];
    const stepDur = this._stepDur(grid.bpm);
    const loopDur = this._loopDur(grid.bpm);
    const out = [];
    const from = now - back, to = now + fwd;

    const firstLoop = Math.floor((from - grid.startTime) / loopDur);
    const lastLoop = Math.ceil((to - grid.startTime) / loopDur);

    for (let loop = firstLoop; loop <= lastLoop; loop++) {
      const loopStart = grid.startTime + loop * loopDur;
      for (const key of this.active) {
        const [voice, stepStr] = key.split(":");
        const step = +stepStr;
        const time = loopStart + step * stepDur;
        if (time >= from && time <= to) {
          out.push({ voice, time, id: `${key}@${loop}` });
        }
      }
    }
    return out;
  }

  /**
   * Advance scoring bookkeeping: register newly-visible targets and finalize
   * any whose window has closed without a matching hit (a miss).
   */
  update(now, grid) {
    if (!grid || !grid.bpm) return;
    // Register upcoming/active target instances we haven't seen yet.
    for (const t of this.targetsInWindow(now, grid, 1.0, this.scoringWindow + 0.1)) {
      if (!this._instances.has(t.id)) {
        this._instances.set(t.id, { voice: t.voice, time: t.time, resolved: false, judgement: null });
      }
    }
    // Finalize misses.
    for (const [id, inst] of this._instances) {
      if (!inst.resolved && now > inst.time + this.scoringWindow) {
        inst.resolved = true;
        inst.judgement = "miss";
        this.results.miss++;
        this.results.total++;
      }
      // Forget very old instances to bound memory.
      if (now > inst.time + 3) this._instances.delete(id);
    }
  }

  /**
   * Judge an incoming hit against the nearest unresolved target of the same
   * voice. Returns the judgement string (used to colour the notehead).
   */
  judgeHit(voice, time) {
    let best = null, bestErr = Infinity;
    for (const inst of this._instances.values()) {
      if (inst.resolved || inst.voice !== voice) continue;
      const err = Math.abs(inst.time - time);
      if (err <= this.scoringWindow && err < bestErr) { best = inst; bestErr = err; }
    }
    if (!best) {
      this.results.extra++;
      return "plain"; // an extra note (not in pattern) — shown but not penalized harshly
    }
    best.resolved = true;
    const signed = time - best.time;
    let judgement;
    if (Math.abs(signed) <= this.tightWindow) judgement = "hit";
    else judgement = signed < 0 ? "early" : "late";
    best.judgement = judgement;
    this.results[judgement === "hit" ? "hit" : judgement === "early" ? "early" : "late"]++;
    this.results.total++;
    return judgement;
  }

  /** Accuracy summary for the UI. */
  accuracy() {
    const r = this.results;
    const scored = r.hit + r.early + r.late + r.miss;
    if (scored === 0) return null;
    const good = r.hit + (r.early + r.late) * 0.5; // partial credit for loose timing
    return {
      percent: Math.round((good / scored) * 100),
      ...r,
    };
  }

  export() {
    return { bars: this.bars, beatsPerBar: this.beatsPerBar, stepsPerBeat: this.stepsPerBeat, active: [...this.active] };
  }
  import(data) {
    if (!data) return;
    this.bars = data.bars ?? this.bars;
    this.beatsPerBar = data.beatsPerBar ?? this.beatsPerBar;
    this.stepsPerBeat = data.stepsPerBeat ?? this.stepsPerBeat;
    this.active = new Set(data.active ?? []);
    this.resetScore();
  }
}
