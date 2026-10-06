import { initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { startAppCheck } from "./appCheck";
import { webConfig } from "./config";

let app: FirebaseApp | undefined;
let emulatorsConnected = false;

// Ports match firebase.json. Connected once, before first use of either service.
function connectEmulatorsOnce(a: FirebaseApp): void {
  if (emulatorsConnected || !webConfig().useEmulators) return;
  emulatorsConnected = true;
  connectAuthEmulator(getAuth(a), "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(getFirestore(a, webConfig().databaseId), "127.0.0.1", 8085);
}

/** Initialised on first use, so importing a module never throws on missing config. */
export function firebaseApp(): FirebaseApp {
  if (!app) {
    app = initializeApp(webConfig().firebase);
    // Before any Firestore call, so the first request already carries a token (#12). Off without a site key.
    startAppCheck(app, webConfig().appCheck, webConfig().useEmulators);
    connectEmulatorsOnce(app);
  }
  return app;
}

export function firebaseAuth(): Auth {
  return getAuth(firebaseApp());
}

export function firestore(): Firestore {
  return getFirestore(firebaseApp(), webConfig().databaseId);
}
