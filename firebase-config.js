// ---------------------------------------------------------------------------
// Firebase-Konfiguration für die Agelan-Turnier-App.
//
// Diese Werte sind NICHT geheim (der Schutz kommt über die Datenbank-Regeln in
// der Firebase-Konsole, nicht über diesen Schlüssel).
//
// Solange hier noch die Platzhalter (DEIN_...) stehen, läuft die App im lokalen
// Test-Modus über firebase-mock.js: alle Daten bleiben nur in diesem Browser,
// aber der komplette Ablauf ist durchspielbar (auch über mehrere Tabs).
//
// Für den Live-Betrieb: Werte aus der Firebase-Konsole eintragen
// (Projekteinstellungen → "Meine Apps" → Web-App → SDK-Konfiguration).
// Schritt-für-Schritt-Anleitung: siehe FIREBASE-SETUP.md
// ---------------------------------------------------------------------------

const firebaseConfig = {
  apiKey: "AIzaSyCOA-Ogseh13AKND3nGITSDWRbPBEKpIu0",
  authDomain: "agelan-ab042.firebaseapp.com",
  databaseURL: "https://agelan-ab042-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "agelan-ab042",
  storageBucket: "agelan-ab042.firebasestorage.app",
  messagingSenderId: "287110907221",
  appId: "1:287110907221:web:12eb625cf1944e95ca9bdc"
};

let db, auth;
const istPlatzhalterKonfig = !firebaseConfig.apiKey || firebaseConfig.apiKey.indexOf("DEIN_") === 0;

if (istPlatzhalterKonfig) {
  // Kein echtes Firebase-Projekt hinterlegt -> lokalen Mock aktivieren.
  window.firebase = window.createFirebaseMock();
  window.__AGELAN_MOCK__ = true;
  console.warn("[Agelan] Kein Firebase konfiguriert – lokaler Test-Modus (Daten bleiben in diesem Browser).");
}

firebase.initializeApp(firebaseConfig);
db = firebase.database();
auth = firebase.auth();
