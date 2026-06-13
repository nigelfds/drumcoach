// Firebase configuration for optional cross-device sync (kit profiles + patterns).
//
// Cloud sync is OFF until you fill this in — DrumCoach runs fully offline
// (localStorage only) with these blank. To enable sync, create a Firebase
// project and paste its web-app config here. See "Cross-device sync" in the
// README for the full setup (auth providers, Firestore rules, authorized domain).
//
// Note: the apiKey here is NOT a secret — Firebase web config is meant to ship
// in client code. Access is protected by Firestore security rules + the auth
// provider, not by hiding this key.
export const firebaseConfig = {

  apiKey: "AIzaSyDXw6LXjQua5HuP2sDYF7dHs9ZzWYjzoPY",

  authDomain: "drumcoach-9c1bb.firebaseapp.com",

  projectId: "drumcoach-9c1bb",

  storageBucket: "drumcoach-9c1bb.firebasestorage.app",

  messagingSenderId: "1064850813962",

  appId: "1:1064850813962:web:54c032c0a976fe44e69bf3",

  measurementId: "G-ZLPZN1QSDB"

};


export const syncEnabled = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
