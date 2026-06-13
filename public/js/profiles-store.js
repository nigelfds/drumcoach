// profiles-store.js — persists named calibration "kit profiles" to localStorage.
//
// A kit profile is a name + the full per-voice profile set the classifier uses.
// Players can save one per drum kit / room and switch between them. Everything
// lives under a single versioned key so it's easy to evolve or clear.

const KEY = "drumcoach.kits.v1";

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ??
    `kit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);

export class ProfileStore {
  constructor(key = KEY) {
    this.key = key;
    this._data = this._load();
    this._onChange = null;
  }

  /** Notified after every persist — used by cloud sync to push changes. */
  onChange(fn) { this._onChange = fn; return this; }

  /** The raw id→kit map (for cloud sync). */
  records() { return this._data.kits; }

  /** Replace the kit map (used when applying cloud data). */
  setRecords(map) { this._data.kits = map || {}; this._persist(); }

  _load() {
    try {
      const raw = localStorage.getItem(this.key);
      const d = raw && JSON.parse(raw);
      if (d && d.kits) return d;
    } catch (e) {
      console.warn("DrumCoach: could not read saved kits", e);
    }
    return { kits: {}, activeId: null };
  }

  _persist() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this._data));
    } catch (e) {
      console.warn("DrumCoach: could not save kits", e);
    }
    if (this._onChange) this._onChange();
  }

  /** Saved kits, newest first. */
  list() {
    return Object.values(this._data.kits).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    );
  }

  get(id) { return this._data.kits[id] || null; }
  activeId() { return this._data.activeId; }
  setActive(id) { this._data.activeId = id || null; this._persist(); }

  findByName(name) {
    const n = (name || "").trim().toLowerCase();
    return Object.values(this._data.kits).find((k) => k.name.toLowerCase() === n) || null;
  }

  /** Create (or overwrite a same-named) kit, make it active, return it. */
  save(name, profiles) {
    name = (name || "").trim();
    if (!name) return null;
    const existing = this.findByName(name);
    const id = existing ? existing.id : newId();
    const rec = { id, name, profiles, updatedAt: Date.now() };
    this._data.kits[id] = rec;
    this._data.activeId = id;
    this._persist();
    return rec;
  }

  /** Update just the profiles of an existing kit (used to auto-save on calibrate). */
  updateProfiles(id, profiles) {
    const rec = this._data.kits[id];
    if (!rec) return null;
    rec.profiles = profiles;
    rec.updatedAt = Date.now();
    this._persist();
    return rec;
  }

  remove(id) {
    delete this._data.kits[id];
    if (this._data.activeId === id) this._data.activeId = null;
    this._persist();
  }
}
