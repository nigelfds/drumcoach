// cloud-sync.js — optional cross-device sync of kit profiles + patterns via
// Firebase (Anonymous auth, upgraded to Google sign-in for cross-device).
//
// Design:
//  - localStorage stays the offline cache / source of truth on each device
//    (ProfileStore / PatternStore are unchanged in how the app reads them).
//  - On boot we sign in ANONYMOUSLY so data backs up immediately, no login wall.
//  - "Sync across devices" LINKS that anonymous account to Google, keeping the
//    same uid (and data). On a second device, signing in with the same Google
//    account surfaces the same data.
//  - EDGE CASE: if the Google account was already used on another device,
//    linking fails with `credential-already-in-use`. We then sign into that
//    existing account and MERGE this device's local data into it (union by id,
//    newest `updatedAt` wins) so nothing is lost.
//
// Sync model: the user's Firestore doc `users/{uid}` holds { kits, patterns }.
// The first snapshot after attaching unions local+cloud (the claim/merge); after
// that the cloud is authoritative so edits and deletes propagate. Selection
// (activeId) is intentionally NOT synced — it's per-device UI state.

import { firebaseConfig, syncEnabled } from "./firebase-config.js";

// Bump if you want a newer SDK; loaded as ES modules straight from the CDN.
const FIREBASE_VERSION = "10.12.2";
const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

/** Union two id→record maps, keeping the record with the newer updatedAt. */
export function mergeById(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, rec] of Object.entries(b)) {
    const cur = out[id];
    if (!cur || (rec.updatedAt || 0) >= (cur.updatedAt || 0)) out[id] = rec;
  }
  return out;
}

export class CloudSync {
  constructor({ kits, patterns }) {
    this.kits = kits;
    this.patterns = patterns;
    this.enabled = syncEnabled;

    this.user = null;
    this._applyingRemote = false;   // guard: don't push while applying a snapshot
    this._initialMergeDone = false; // first snapshot per user = union merge
    this._pushTimer = null;
    this._lastPushed = "";
    this._unsub = null;
    this._docRef = null;
    this._fb = null;                // { auth, fs } module namespaces

    this._onStatus = () => {};
    this._onUpdate = () => {};
  }

  onStatus(fn) { this._onStatus = fn; return this; }
  onUpdate(fn) { this._onUpdate = fn; return this; }

  status() {
    if (!this.enabled) return { state: "disabled" };
    if (!this.user) return { state: "connecting" };
    return { state: this.user.isAnonymous ? "anonymous" : "signed-in", user: this.user };
  }

  async start() {
    if (!this.enabled) { this._onStatus(this.status()); return; }
    this._onStatus({ state: "connecting" });

    let auth, fs, initializeApp;
    try {
      [{ initializeApp }, auth, fs] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-firestore.js`),
      ]);
    } catch (e) {
      console.warn("DrumCoach: could not load Firebase SDK — sync disabled", e);
      this.enabled = false;
      this._onStatus(this.status());
      return;
    }

    const app = initializeApp(firebaseConfig);
    this._auth = auth.getAuth(app);
    this._db = fs.getFirestore(app);
    this._fb = { auth, fs };

    // Push local store changes up (debounced).
    this.kits.onChange(() => this._onLocalChange());
    this.patterns.onChange(() => this._onLocalChange());

    auth.onAuthStateChanged(this._auth, (user) => this._handleAuth(user));

    // Always have at least an anonymous session.
    try {
      if (!this._auth.currentUser) await auth.signInAnonymously(this._auth);
    } catch (e) {
      console.warn("DrumCoach: anonymous sign-in failed", e);
      this._onStatus({ state: "error", error: e });
    }
  }

  _handleAuth(user) {
    this.user = user;
    if (user) this._attachUser(user.uid);
    this._onStatus(this.status());
  }

  _attachUser(uid) {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._initialMergeDone = false;
    this._lastPushed = "";
    const { fs } = this._fb;
    this._docRef = fs.doc(this._db, "users", uid);
    this._unsub = fs.onSnapshot(
      this._docRef,
      (snap) => this._onRemote(snap),
      (err) => console.warn("DrumCoach: sync listener error", err)
    );
  }

  _onRemote(snap) {
    const data = snap.exists() ? snap.data() : {};
    const cloudKits = data.kits || {};
    const cloudPatterns = data.patterns || {};

    this._applyingRemote = true;
    if (!this._initialMergeDone) {
      // Claim/merge: union this device's local data with the account's cloud
      // data so an anonymous device signing into an existing account loses
      // nothing.
      this.kits.setRecords(mergeById(this.kits.records(), cloudKits));
      this.patterns.setRecords(mergeById(this.patterns.records(), cloudPatterns));
      this._initialMergeDone = true;
      this._applyingRemote = false;
      this._onUpdate();
      this._pushNow(); // send any local-only items up
    } else {
      // Ongoing: cloud is authoritative so edits/deletes from other devices win.
      this.kits.setRecords(cloudKits);
      this.patterns.setRecords(cloudPatterns);
      this._applyingRemote = false;
      this._onUpdate();
    }
  }

  _onLocalChange() {
    if (this._applyingRemote) return;
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._pushNow(), 400);
  }

  async _pushNow() {
    if (!this._docRef || !this._fb) return;
    const payload = { kits: this.kits.records(), patterns: this.patterns.records() };
    const json = JSON.stringify(payload);
    if (json === this._lastPushed) return; // nothing actually changed
    this._lastPushed = json;
    const { fs } = this._fb;
    try {
      await fs.setDoc(this._docRef, { ...payload, updatedAt: fs.serverTimestamp() }, { merge: true });
    } catch (e) {
      console.warn("DrumCoach: cloud push failed", e);
      this._lastPushed = ""; // allow a retry
    }
  }

  /** Upgrade the anonymous account to Google so data syncs across devices. */
  async signInWithGoogle() {
    if (!this.enabled || !this._auth) return;
    const { auth } = this._fb;
    const provider = new auth.GoogleAuthProvider();
    try {
      await auth.linkWithPopup(this._auth.currentUser, provider);
      // Same uid kept; data already in this user's doc. Done.
      this._onStatus(this.status());
    } catch (e) {
      if (e.code === "auth/credential-already-in-use") {
        // EDGE CASE: that Google account already exists (another device). Sign
        // into it; the next snapshot unions this device's local data into it.
        const cred = auth.GoogleAuthProvider.credentialFromError(e);
        try {
          await auth.signInWithCredential(this._auth, cred);
          // onAuthStateChanged → _attachUser → first snapshot performs the merge.
        } catch (e2) {
          console.warn("DrumCoach: sign-in after link conflict failed", e2);
          this._onStatus({ state: "error", error: e2 });
        }
      } else if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") {
        // user dismissed the popup — ignore
      } else {
        console.warn("DrumCoach: Google sign-in failed", e);
        this._onStatus({ state: "error", error: e });
      }
    }
  }

  /** Sign out to a fresh guest (data stays in localStorage, re-syncs on login). */
  async signOutToGuest() {
    if (!this._auth) return;
    const { auth } = this._fb;
    try {
      await auth.signOut(this._auth);
      await auth.signInAnonymously(this._auth);
    } catch (e) {
      console.warn("DrumCoach: sign-out failed", e);
    }
  }
}
