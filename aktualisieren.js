// ===========================================================================
// aktualisieren.js – Zwangsaktualisierung: neue Fassung online → Seite lädt neu.
//
// Jede Änderung zählt in index.html die Versionsnummer der geänderten Datei
// hoch (`essen-app.js?v=2.25`). Jedes Gerät holt deshalb jede Minute die
// aktuelle index.html und vergleicht ALLE `datei.js?v=…`/`datei.css?v=…` darin
// mit denen, mit denen es selbst gestartet ist. Weicht etwas ab, lädt es neu –
// Beamer und Handys auf der Essensseite brauchen dann kein Strg + F5 mehr.
//
// ⚠️ Nie mitten im Tippen: Steht der Fokus in einem Eingabefeld oder liegt auf
// der Essensseite ein angefangener Entwurf, wartet das Neuladen (oben steht ein
// Balken mit „Jetzt neu laden“). Sonst ginge eine halbe Bestellung verloren.
// ⚠️ Läuft schon im Vorraum (vor dem Passwort) – braucht nichts anderes.
// ⚠️ Beim Pushen also IMMER die ?v= der geänderten Datei in index.html erhöhen,
// sonst merkt kein Gerät etwas (Ausnahme: nur der Changelog in app.js).
// ===========================================================================

(function () {
  const PRUEF_MS = 60 * 1000;        // so oft nach einer neuen Fassung sehen
  const WARTE_MS = 5 * 1000;         // so oft prüfen, ob jetzt neu geladen werden darf
  const MUSTER = /[\w.-]+\.(?:js|css)\?v=[\w.]+/g;

  function fassung(html) {
    return (String(html).match(MUSTER) || []).filter((v, i, a) => a.indexOf(v) === i).sort().join(" ");
  }

  // Womit dieses Gerät gestartet ist: alle ?v= der geladenen Seite.
  // ⚠️ Erst nach DOMContentLoaded lesen – dieses Skript steht im <head>, die
  // Liste der App-Skripte (inline-Skript unten) wäre sonst noch nicht da.
  // Später hinzugefügte <script>-Tags tragen dieselben Namen, doppelte zählen einmal.
  let meine = "";
  function meineLesen() { if (!meine) meine = fassung(document.documentElement.outerHTML); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", meineLesen);
  else meineLesen();
  let neueGefunden = false;
  let balken = null;

  function darfJetzt() {
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return false;
    // Angefangene Essensbestellung (essen-app.js): nicht wegwerfen.
    try {
      if (typeof esEntwurf !== "undefined" && esEntwurf && esEntwurf.positionen && esEntwurf.positionen.length) return false;
    } catch (e) { /* Essen nicht geladen */ }
    // Geänderter Mailtext an den Lieferanten ebenso.
    try {
      if (typeof esMailBearbeitet !== "undefined" && esMailBearbeitet) return false;
    } catch (e) { /* Essen nicht geladen */ }
    return true;
  }

  function neuLaden() {
    location.reload();
  }

  function balkenZeigen() {
    if (balken || !document.body) return;
    balken = document.createElement("div");
    balken.className = "neu-balken";
    balken.setAttribute("role", "status");
    balken.innerHTML = '<span>🔄 Neue Version da – lädt neu, sobald du fertig bist.</span>' +
      '<button type="button">Jetzt neu laden</button>';
    balken.querySelector("button").addEventListener("click", neuLaden);
    document.body.appendChild(balken);
  }

  function versuchen() {
    if (!neueGefunden) return;
    if (darfJetzt()) neuLaden();
    else balkenZeigen();
  }

  // ⚠️ Sparsam: erst nur nachfragen (HEAD), ob sich index.html geändert hat –
  // die ETag von GitHub Pages wechselt mit jeder Veröffentlichung. Die ganze
  // Datei (gut 100 KB) wird nur geholt, wenn die ETag anders ist. Sonst zögen
  // 100 Geräte jede Minute je 100 KB durchs LAN-WLAN.
  let etagBekannt = null;

  async function etagHolen() {
    const antwort = await fetch(location.pathname + "?fassung=" + Date.now(), { method: "HEAD", cache: "no-store" });
    if (!antwort.ok) return null;
    return antwort.headers.get("ETag") || antwort.headers.get("Last-Modified") || "";
  }

  async function pruefen() {
    if (neueGefunden || !meine) return;
    try {
      const etag = await etagHolen();
      if (etag === null) return;
      // Beim ersten Mal immer ganz vergleichen: eine Fassung, die zwischen dem
      // Laden der Seite und dieser Prüfung kam, hätte sonst schon die „bekannte“ ETag.
      if (etag && etagBekannt !== null && etag === etagBekannt) return;   // nichts Neues
      const antwort = await fetch(location.pathname + "?fassung=" + Date.now(), { cache: "no-store" });
      if (!antwort.ok) return;
      const online = fassung(await antwort.text());
      // Leere/abgeschnittene Antwort (Funkloch, Fehlerseite) ist keine neue Fassung.
      if (!online || online.split(" ").length < meine.split(" ").length / 2) return;
      if (etag) etagBekannt = etag;
      // Geändert, aber keine Versionsnummer anders (nur Text): kein Neuladen nötig.
      if (online !== meine) {
        neueGefunden = true;
        versuchen();
      }
    } catch (e) { /* offline – nächstes Mal */ }
  }

  setInterval(pruefen, PRUEF_MS);
  setInterval(versuchen, WARTE_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pruefen();
  });
  // Fokus verlässt ein Feld: vielleicht darf jetzt neu geladen werden.
  document.addEventListener("focusout", () => setTimeout(versuchen, 300));

  window.agelanAktualisieren = { pruefen, fassung, meine: () => meine };
})();
