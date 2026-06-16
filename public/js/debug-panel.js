// debug-panel.js — recognition debug overlay. Mounted only when ?debug is set.
//
// Three views to diagnose misclassification:
//   1. Profile comparison — overlay two voices' calibrated fingerprints to see
//      how close they are (e.g. kick vs floor tom) + the distance + sub levels.
//   2. Live hit inspector — for the last hit: its fingerprint, the distance to
//      every profile (the classifier's own scores), the chosen voice, the
//      sub-tail value, and any secondary (cymbal) emitted.
//   3. Onset log — recent detections with time/voice/confidence, so double-
//      triggers (e.g. a snare that also fires a hi-hat) are obvious.

const BANDS = ["sub", "low", "lowMid", "mid", "high", "veryHigh"];
const BAND_SHORT = ["sub", "low", "lMid", "mid", "high", "vHi"];
const FEATURE_KEYS = [...BANDS, "centroidN"];

/** Same distance the classifier uses (centroid weighted ×1.5). */
function dist(a, b) {
  let d = 0;
  for (const k of FEATURE_KEYS) {
    const w = k === "centroidN" ? 1.5 : 1;
    d += w * ((a[k] || 0) - (b[k] || 0)) ** 2;
  }
  return Math.sqrt(d);
}

const CSS = `
#dbg-panel{position:fixed;right:10px;bottom:10px;z-index:9999;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;color:#dfe6f2}
#dbg-panel .dbg-toggle{background:#11161f;color:#9fd0c0;border:1px solid #2a3650;border-radius:9px;padding:7px 11px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4)}
#dbg-panel.open .dbg-toggle{border-bottom-left-radius:0;border-bottom-right-radius:0}
#dbg-panel .dbg-body{display:none;width:340px;max-height:74vh;overflow:auto;background:#0c1018;border:1px solid #2a3650;border-top:none;border-radius:0 0 10px 10px;padding:10px}
#dbg-panel.open .dbg-body{display:block}
#dbg-panel h4{margin:2px 0 7px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#6f7d97;font-weight:700}
#dbg-panel .sec{padding:9px 0;border-top:1px solid #1b2233}
#dbg-panel .sec:first-child{border-top:none;padding-top:0}
#dbg-panel select{background:#11161f;color:#dfe6f2;border:1px solid #2a3650;border-radius:6px;font-family:inherit;font-size:11px;padding:3px 5px}
#dbg-panel .bars{display:flex;gap:3px;align-items:flex-end;height:42px;margin:5px 0}
#dbg-panel .bcol{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
#dbg-panel .bcol .bwrap{width:100%;display:flex;gap:1px;align-items:flex-end;height:100%}
#dbg-panel .bar{flex:1;min-height:1px;border-radius:2px 2px 0 0}
#dbg-panel .blabel{font-size:8.5px;color:#5a6783;margin-top:2px}
#dbg-panel .legend{display:flex;gap:12px;font-size:9.5px;margin-top:2px}
#dbg-panel .legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}
#dbg-panel .kv{display:flex;justify-content:space-between;color:#9aa6bd;margin:2px 0}
#dbg-panel .kv b{color:#dfe6f2;font-weight:500}
#dbg-panel .dist{display:flex;justify-content:space-between;padding:1.5px 0}
#dbg-panel .dist.win{color:#56e0a6}
#dbg-panel .dist.win::after{content:" ◀"}
#dbg-panel .tag{display:inline-block;background:#2a3650;border-radius:4px;padding:0 4px;color:#cfe1ff;font-size:9px;margin-left:5px}
#dbg-panel .tag.sec{background:#5a3a1a;color:#ffd9a8}
#dbg-panel .log{max-height:150px;overflow:auto}
#dbg-panel .lrow{display:grid;grid-template-columns:48px 1fr 40px;gap:6px;padding:1.5px 0;border-bottom:1px solid #141a27}
#dbg-panel .lrow .lv{color:#dfe6f2}
#dbg-panel .lrow .lt,#dbg-panel .lrow .lc{color:#6f7d97}
#dbg-panel .muted{color:#6f7d97}
`;

const COLOR_A = "#5aa0ff", COLOR_B = "#ff8a5a", COLOR_HIT = "#56e0a6";

export class DebugPanel {
  constructor({ getProfiles, voiceMeta, order }) {
    this.getProfiles = getProfiles;
    this.meta = voiceMeta;
    this.order = order;
    this.log = [];
    this.last = null;
    this.open = false;
    this.cmpA = "kick";
    this.cmpB = "tom3";
  }

  mount() {
    if (document.getElementById("dbg-panel")) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const el = document.createElement("div");
    el.id = "dbg-panel";
    const opts = this.order.map((v) => `<option value="${v}">${this.meta[v].label}</option>`).join("");
    el.innerHTML = `
      <div class="dbg-toggle">🔧 recognition debug</div>
      <div class="dbg-body">
        <div class="sec" id="dbg-cmp">
          <h4>Profile comparison</h4>
          <div>
            <select id="dbg-a">${opts}</select> vs
            <select id="dbg-b">${opts}</select>
            <span id="dbg-cmp-dist" class="muted"></span>
          </div>
          <div id="dbg-cmp-bars"></div>
        </div>
        <div class="sec" id="dbg-hit"><h4>Last hit</h4><div id="dbg-hit-body" class="muted">play a drum…</div></div>
        <div class="sec"><h4>Onset log</h4><div class="log" id="dbg-log"></div></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    el.querySelector(".dbg-toggle").onclick = () => { this.open = !this.open; el.classList.toggle("open", this.open); if (this.open) this.render(); };
    const a = el.querySelector("#dbg-a"), b = el.querySelector("#dbg-b");
    a.value = this.cmpA; b.value = this.cmpB;
    a.onchange = () => { this.cmpA = a.value; this.renderCompare(); };
    b.onchange = () => { this.cmpB = b.value; this.renderCompare(); };
    this.render();
  }

  addHit(rec) {
    this.log.unshift(rec);
    if (this.log.length > 50) this.log.pop();
    this.last = rec;
    if (this.open) { this.renderHit(); this.renderLog(); }
  }

  render() { this.renderCompare(); this.renderHit(); this.renderLog(); }

  _barsHtml(series) {
    // series: [{ feats, color }]
    return `<div class="bars">${BANDS.map((band, i) => {
      const cols = series.map((s) => {
        const v = Math.max(0, Math.min(1, s.feats[band] || 0));
        return `<div class="bar" style="height:${(v * 100).toFixed(0)}%;background:${s.color}"></div>`;
      }).join("");
      return `<div class="bcol"><div class="bwrap">${cols}</div><div class="blabel">${BAND_SHORT[i]}</div></div>`;
    }).join("")}</div>`;
  }

  renderCompare() {
    if (!this.el) return;
    const p = this.getProfiles();
    const A = p[this.cmpA], B = p[this.cmpB];
    if (!A || !B) return;
    this.el.querySelector("#dbg-cmp-dist").textContent = `dist ${dist(A, B).toFixed(3)}`;
    this.el.querySelector("#dbg-cmp-bars").innerHTML =
      this._barsHtml([{ feats: A, color: COLOR_A }, { feats: B, color: COLOR_B }]) +
      `<div class="legend"><span><i style="background:${COLOR_A}"></i>${this.meta[this.cmpA].label}</span>` +
      `<span><i style="background:${COLOR_B}"></i>${this.meta[this.cmpB].label}</span></div>` +
      `<div class="kv"><span>centroidN</span><b>${(A.centroidN ?? 0).toFixed(3)} / ${(B.centroidN ?? 0).toFixed(3)}</b></div>` +
      `<div class="kv"><span>sub</span><b>${(A.sub ?? 0).toFixed(3)} / ${(B.sub ?? 0).toFixed(3)}</b></div>`;
  }

  renderHit() {
    if (!this.el) return;
    const h = this.last;
    const body = this.el.querySelector("#dbg-hit-body");
    if (!h) { body.innerHTML = `<span class="muted">play a drum…</span>`; return; }
    const f = h.features || {};
    const scores = Object.entries(h.scores || {}).sort((x, y) => x[1] - y[1]);
    const distRows = scores.map(([v, d], i) =>
      `<div class="dist ${i === 0 ? "win" : ""}"><span>${this.meta[v]?.label || v}</span><span>${d.toFixed(3)}</span></div>`
    ).join("") || `<span class="muted">(secondary — no score)</span>`;
    body.innerHTML =
      `<div class="kv"><span><b style="color:${COLOR_HIT}">${this.meta[h.voice]?.label || h.voice}</b>` +
      `${h.secondary ? `<span class="tag sec">2nd</span>` : ""}${h.tiebreak ? `<span class="tag">tiebreak→${h.tiebreak}</span>` : ""}</span>` +
      `<span class="muted">conf ${h.conf}</span></div>` +
      this._barsHtml([{ feats: f, color: COLOR_HIT }]) +
      `<div class="kv"><span>subTail</span><b>${(h.subTail ?? 0).toFixed(3)}</b><span class="muted">${(h.subTail ?? 0) > 0.15 ? "→kick-ish" : "→tom-ish"}</span></div>` +
      `<div style="margin-top:4px">${distRows}</div>`;
  }

  renderLog() {
    if (!this.el) return;
    this.el.querySelector("#dbg-log").innerHTML = this.log.map((h) => {
      const dom = BANDS.reduce((m, b) => ((h.features?.[b] || 0) > (h.features?.[m] || 0) ? b : m), "sub");
      return `<div class="lrow"><span class="lt">${h.t.toFixed(2)}</span>` +
        `<span class="lv">${this.meta[h.voice]?.label || h.voice}${h.secondary ? `<span class="tag sec">2nd</span>` : ""}` +
        `<span class="muted"> ${dom}</span></span><span class="lc">${h.conf}</span></div>`;
    }).join("");
  }
}
