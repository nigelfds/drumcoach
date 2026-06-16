// notation.js — live, scrolling standard drum-staff renderer.
//
// Draws a 5-line staff and scrolls noteheads from right (the "now" line) to the
// left as time passes. Cymbals use an "x" notehead, drums a filled oval, per
// standard percussion notation. Metronome beats are drawn as faint grid lines.

// Vertical staff positions are expressed as "steps" from the bottom staff line.
// One step = half the line spacing (i.e. a line or a space). Higher = up.
// These positions follow common drum-kit notation conventions.
export const VOICES = {
  hihat: { label: "Hi-hat", step: 12, head: "x", stem: "up" },
  crash: { label: "Crash", step: 11, head: "x", stem: "up" },
  ride:  { label: "Ride",  step: 10, head: "x", stem: "up" },
  tom1:  { label: "Tom 1", step: 8,  head: "o", stem: "up" },
  tom2:  { label: "Tom 2", step: 7,  head: "o", stem: "up" },
  snare: { label: "Snare", step: 6,  head: "o", stem: "up" },
  tom3:  { label: "Tom 3", step: 5,  head: "o", stem: "up" },
  kick:  { label: "Kick",  step: 2,  head: "o", stem: "down" },
};

const COLORS = {
  staff: "#33474f",
  now: "#FF5A36",
  grid: "rgba(150,180,170,0.16)",
  gridStrong: "rgba(150,180,170,0.36)",
  note: "#EAF1EE",
  perfect: "#9CFFE3",
  hit: "#56E0A6",
  early: "#EFC15A",
  late: "#6FB7E0",
  miss: "#FF5A36",
  ghost: "rgba(234,241,238,0.26)",
  label: "#8aa39b",
};

export class Notation {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {number} [opts.windowSeconds] visible time span across the staff
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.windowSeconds = opts.windowSeconds ?? 4;

    this.hits = [];          // { time, voice, judgement }
    this.beats = [];         // { time, strong }
    this.targets = [];       // ghost notes from a pattern: { time, voice }
    this.maxHits = 400;

    this._dpr = window.devicePixelRatio || 1;
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(280, rect.width);
    this.h = Math.max(200, rect.height);
    this.canvas.width = this.w * this._dpr;
    this.canvas.height = this.h * this._dpr;
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

    // Staff geometry. A wider line gap spreads the voices out so each notehead
    // sits clearly on / between the right staff line.
    this.lineGap = Math.min(26, this.h / 12);
    this.staffMidY = this.h * 0.47;
    this.leftPad = 64;            // room for voice labels
    this.nowX = this.w - 48;      // the "now" playhead
  }

  /** y pixel for a given vertical step (0 = bottom staff line). */
  _stepY(step) {
    // bottom line is step 0; top line is step 8 (5 lines, 4 gaps × 2 steps).
    const bottomLineY = this.staffMidY + 4 * (this.lineGap / 1);
    return bottomLineY - step * (this.lineGap / 2);
  }

  /** x pixel for an absolute time, given current clock `now`. */
  _timeX(time, now) {
    const dt = now - time;                       // seconds in the past
    const usable = this.nowX - this.leftPad;
    return this.nowX - (dt / this.windowSeconds) * usable;
  }

  addHit(time, voice, judgement = "plain") {
    if (!VOICES[voice]) return;
    this.hits.push({ time, voice, judgement });
    if (this.hits.length > this.maxHits) this.hits.shift();
  }

  setBeats(beats) { this.beats = beats ?? []; }
  setTargets(targets) { this.targets = targets ?? []; }
  clear() { this.hits = []; }

  render(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    this._drawStaff(ctx);
    this._drawBeatGrid(ctx, now);
    this._drawTargets(ctx, now);
    this._drawHits(ctx, now);
    this._drawNowLine(ctx);
  }

  _drawStaff(ctx) {
    ctx.strokeStyle = COLORS.staff;
    ctx.lineWidth = 1;
    for (let line = 0; line < 5; line++) {
      const y = this._stepY(line * 2);
      ctx.beginPath();
      ctx.moveTo(this.leftPad, y);
      ctx.lineTo(this.nowX + 24, y);
      ctx.stroke();
    }
    // Voice labels down the left edge.
    ctx.fillStyle = COLORS.label;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of Object.values(VOICES)) {
      ctx.fillText(v.label, this.leftPad - 8, this._stepY(v.step));
    }
    ctx.textAlign = "start";
  }

  _drawBeatGrid(ctx, now) {
    for (const b of this.beats) {
      const x = this._timeX(b.time, now);
      if (x < this.leftPad || x > this.nowX + 24) continue;
      ctx.strokeStyle = b.strong ? COLORS.gridStrong : COLORS.grid;
      ctx.lineWidth = b.strong ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, this._stepY(12));
      ctx.lineTo(x, this._stepY(-2));
      ctx.stroke();
    }
  }

  _drawTargets(ctx, now) {
    for (const t of this.targets) {
      const x = this._timeX(t.time, now);
      if (x < this.leftPad || x > this.nowX + 24) continue;
      const v = VOICES[t.voice];
      if (!v) continue;
      this._drawHead(ctx, x, this._stepY(v.step), v.head, COLORS.ghost, true);
    }
  }

  _drawHits(ctx, now) {
    for (const hit of this.hits) {
      const x = this._timeX(hit.time, now);
      if (x < this.leftPad - 12 || x > this.nowX + 24) continue;
      const v = VOICES[hit.voice];
      const color = this._judgementColor(hit.judgement);
      const y = this._stepY(v.step);
      this._drawHead(ctx, x, y, v.head, color, false);
      this._drawStem(ctx, x, y, v.stem, color);
    }
  }

  _judgementColor(j) {
    switch (j) {
      case "perfect": return COLORS.perfect;
      case "hit": return COLORS.hit;
      case "early": return COLORS.early;
      case "late": return COLORS.late;
      case "miss": return COLORS.miss;
      default: return COLORS.note;
    }
  }

  _drawHead(ctx, x, y, kind, color, ghost) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    const r = 5.5;
    if (kind === "x") {
      ctx.beginPath();
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(x, y, r + 1, r - 1, -0.35, 0, Math.PI * 2);
      if (ghost) ctx.stroke(); else ctx.fill();
    }
    ctx.restore();
  }

  _drawStem(ctx, x, y, dir, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    const len = this.lineGap * 3;
    const sx = x + 6;
    ctx.beginPath();
    if (dir === "up") { ctx.moveTo(sx, y); ctx.lineTo(sx, y - len); }
    else { ctx.moveTo(x - 6, y); ctx.lineTo(x - 6, y + len); }
    ctx.stroke();
    ctx.restore();
  }

  _drawNowLine(ctx) {
    ctx.strokeStyle = COLORS.now;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.nowX, this._stepY(13));
    ctx.lineTo(this.nowX, this._stepY(-3));
    ctx.stroke();
    ctx.fillStyle = COLORS.now;
    ctx.beginPath();
    ctx.moveTo(this.nowX, this._stepY(13));
    ctx.lineTo(this.nowX - 5, this._stepY(13) - 8);
    ctx.lineTo(this.nowX + 5, this._stepY(13) - 8);
    ctx.fill();
  }
}
