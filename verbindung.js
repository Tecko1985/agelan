// ===========================================================================
// verbindung.js – hält die Live-Verbindung zur Datenbank wach.
//
// Anlass (Michel am 2026-10-01): Jemand bestellt am Platz, kommt zum Bezahlen –
// und an der Kasse ist die Bestellung noch nicht zu sehen, erst nach dem
// Neuladen. Die Liste selbst zeichnet live (im Test sofort da); was abreißt,
// ist die Verbindung: Browser legen Tabs im Hintergrund schlafen (Outlook vorn,
// Laptop zugeklappt, WLAN kurz weg), der WebSocket stirbt still, und Firebase
// merkt es erst nach bis zu einer Minute. Neuladen baut sofort neu auf.
//
// Darum hier:
//  1. Tab kommt nach vorn / Fenster bekommt Fokus / Netz ist wieder da:
//     goOffline() + goOnline() – die Verbindung steht sofort neu, alle
//     Live-Abos bekommen den aktuellen Stand vom Server. Kein Neuladen.
//  2. `.info/connected` zeigt in der Kopfzeile „🔴 Keine Verbindung“, wenn sie
//     länger als ein paar Sekunden weg ist – statt still veralteter Listen.
//  3. Steht die Verbindung länger als WACHE_MS auf „weg“, wird ebenfalls neu
//     aufgebaut (falls Firebase selbst hängt).
//
// ⚠️ Lädt NACH firebase-config.js (braucht `db`). Im Test-Modus (Mock) gibt es
// weder goOffline noch .info/connected – dann tut die Datei nichts.
// ⚠️ goOffline/goOnline verliert nichts: Schreibvorgänge warten und gehen nach
// dem Wiederverbinden raus.
// ===========================================================================

(function () {
  if (typeof db === "undefined" || !db || typeof db.goOffline !== "function" || window.__AGELAN_MOCK__) return;

  const ANZEIGE_NACH_MS = 4000;       // so lange darf es ruckeln, bevor „keine Verbindung“ erscheint
  const WACHE_MS = 30000;             // so oft prüfen, ob die Verbindung hängt
  const BREMSE_MS = 5000;             // höchstens so oft neu aufbauen
  const WEG_MIN_MS = 15000;           // so lange muss die Seite weg gewesen sein

  let verbunden = false;
  let wegSeit = Date.now();
  let zuletztNeu = 0;
  let anzeigeTimer = null;
  let weggegangen = 0;                // wann die Seite in den Hintergrund ging / den Fokus verlor

  function anzeige() {
    const el = document.getElementById("sync-status");
    if (!el) return;
    if (verbunden) {
      // Nur wegräumen, was wir selbst hingeschrieben haben.
      if (el.dataset.verbindung === "weg") {
        el.hidden = true;
        el.textContent = "";
        el.dataset.verbindung = "";
      }
      return;
    }
    el.textContent = "🔴 Keine Verbindung – Daten evtl. nicht aktuell";
    el.style.color = "#fecaca";
    el.dataset.verbindung = "weg";
    el.hidden = false;
  }

  function neuVerbinden(anlass) {
    if (Date.now() - zuletztNeu < BREMSE_MS) return;
    zuletztNeu = Date.now();
    try {
      db.goOffline();
      db.goOnline();
    } catch (e) {
      console.warn("[Verbindung] Neuaufbau fehlgeschlagen (" + anlass + "):", e && e.message);
    }
  }

  db.ref(".info/connected").on("value", (snap) => {
    verbunden = snap.val() === true;
    if (!verbunden) wegSeit = Date.now();
    if (anzeigeTimer) clearTimeout(anzeigeTimer);
    // Kurzes Ruckeln (Neuaufbau dauert ~1 s) nicht anzeigen.
    if (verbunden) anzeige();
    else anzeigeTimer = setTimeout(anzeige, ANZEIGE_NACH_MS);
  });

  // Tab wieder vorn, Fenster wieder im Fokus, Netz wieder da: sofort frisch.
  // ⚠️ Nur nach echter Abwesenheit (oder ohne Verbindung): jeder Neuaufbau lädt
  // alle Live-Daten neu – bei jedem Klick ins Fenster wäre das bei 100 Geräten
  // unnötige Last im LAN-WLAN.
  function zurueck(anlass) {
    const lange = weggegangen && Date.now() - weggegangen > WEG_MIN_MS;
    weggegangen = 0;
    if (lange || !verbunden) neuVerbinden(anlass);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") zurueck("sichtbar");
    else if (!weggegangen) weggegangen = Date.now();
  });
  window.addEventListener("blur", () => { if (!weggegangen) weggegangen = Date.now(); });
  window.addEventListener("focus", () => zurueck("fokus"));
  window.addEventListener("online", () => neuVerbinden("online"));

  // Wache: hängt die Verbindung, obwohl die Seite offen ist, selbst nachhelfen.
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!verbunden && Date.now() - wegSeit > WACHE_MS) neuVerbinden("wache");
  }, WACHE_MS);

  window.agelanVerbindung = { neuVerbinden, verbunden: () => verbunden };
})();
