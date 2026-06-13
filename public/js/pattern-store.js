// pattern-store.js — persists named patterns to localStorage, scoped per kit.
//
// Each saved pattern belongs to a kit profile (by kit id; null = the default,
// uncalibrated kit), so the patterns you see follow whichever kit is active.
// Mirrors ProfileStore's shape for consistency.

const KEY = "drumcoach.patterns.v1";

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ??
    `pat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);

const norm = (kitId) => kitId || null;

export class PatternStore {
  constructor(key = KEY) {
    this.key = key;
    this._data = this._load();
    this._onChange = null;
  }

  /** Notified after every persist — used by cloud sync to push changes. */
  onChange(fn) { this._onChange = fn; return this; }

  /** The raw id→pattern map (for cloud sync). */
  records() { return this._data.patterns; }

  /** Replace the pattern map (used when applying cloud data). */
  setRecords(map) { this._data.patterns = map || {}; this._persist(); }

  _load() {
    try {
      const raw = localStorage.getItem(this.key);
      const d = raw && JSON.parse(raw);
      if (d && d.patterns) return d;
    } catch (e) {
      console.warn("DrumCoach: could not read saved patterns", e);
    }
    return { patterns: {}, activeId: null };
  }

  _persist() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this._data));
    } catch (e) {
      console.warn("DrumCoach: could not save patterns", e);
    }
    if (this._onChange) this._onChange();
  }

  /** Saved patterns for a given kit (newest first). */
  list(kitId) {
    const k = norm(kitId);
    return Object.values(this._data.patterns)
      .filter((p) => norm(p.kitId) === k)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id) { return this._data.patterns[id] || null; }
  activeId() { return this._data.activeId; }
  setActive(id) { this._data.activeId = id || null; this._persist(); }

  findByName(name, kitId) {
    const n = (name || "").trim().toLowerCase();
    const k = norm(kitId);
    return Object.values(this._data.patterns).find(
      (p) => norm(p.kitId) === k && p.name.toLowerCase() === n
    ) || null;
  }

  /** Create (or overwrite a same-named pattern in the same kit). */
  save(name, kitId, data) {
    name = (name || "").trim();
    if (!name) return null;
    const existing = this.findByName(name, kitId);
    const id = existing ? existing.id : newId();
    const rec = { id, name, kitId: norm(kitId), data, updatedAt: Date.now() };
    this._data.patterns[id] = rec;
    this._data.activeId = id;
    this._persist();
    return rec;
  }

  remove(id) {
    delete this._data.patterns[id];
    if (this._data.activeId === id) this._data.activeId = null;
    this._persist();
  }

  /** Drop every pattern that belonged to a (now-deleted) kit. */
  removeForKit(kitId) {
    const k = norm(kitId);
    for (const [id, p] of Object.entries(this._data.patterns)) {
      if (norm(p.kitId) === k) {
        delete this._data.patterns[id];
        if (this._data.activeId === id) this._data.activeId = null;
      }
    }
    this._persist();
  }
}
