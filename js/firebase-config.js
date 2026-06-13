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
  apiKey: "",
  authDomain: "",        // usually <project-id>.firebaseapp.com
  projectId: "",
  appId: "",
};

export const syncEnabled = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
