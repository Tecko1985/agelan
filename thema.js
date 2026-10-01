// ===========================================================================
// thema.js – Hell/Dunkel für die AgeLan, wahlweise nach der Sonne in Volkmarsen.
//
// Drei Stellungen, je Gerät gemerkt (localStorage `agelan_thema`):
//   auto   – hell zwischen Sonnenaufgang und Sonnenuntergang in Volkmarsen,
//            sonst dunkel (Standard)
//   hell   – immer hell
//   dunkel – immer dunkel
//
// ⚠️ Läuft SYNCHRON im <head>, vor dem ersten Zeichnen – sonst blitzt die Seite
// nachts einmal hell auf. Deshalb auch keine Abhängigkeit von anderen Skripten.
// Das CSS hängt am Attribut `data-theme` auf <html> (seit 2026-10-01; vorher
// nur an der Systemeinstellung per prefers-color-scheme).
// ===========================================================================

(function () {
  const SCHLUESSEL = "agelan_thema";
  const MODI = ["auto", "hell", "dunkel"];
  // Volkmarsen (Landkreis Waldeck-Frankenberg)
  const BREITE = 51.4077;
  const LAENGE = 9.1167;

  // Was in DIESER Sitzung gewählt wurde, gilt vorrangig – falls localStorage
  // nicht schreibbar ist (privates Fenster), wirkt das Umschalten trotzdem.
  let gewaehlt = null;

  function modusLesen() {
    if (gewaehlt) return gewaehlt;
    try {
      const m = localStorage.getItem(SCHLUESSEL);
      return MODI.indexOf(m) >= 0 ? m : "auto";
    } catch (e) {
      return "auto";
    }
  }

  // Sonnenauf-/-untergang (Almanac-for-Computers-Verfahren, Zenit 90,833° =
  // oberer Sonnenrand am Horizont inkl. Brechung). Genau auf 1–2 Minuten.
  // Liefert ein Date oder null (Polartag/-nacht – in Volkmarsen nie).
  function sonne(datum, aufgang) {
    const rad = Math.PI / 180;
    const anfang = Date.UTC(datum.getFullYear(), 0, 0);
    const heute = Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate());
    const n = Math.round((heute - anfang) / 86400000);
    const lh = LAENGE / 15;
    const t = n + ((aufgang ? 6 : 18) - lh) / 24;
    const m = 0.9856 * t - 3.289;
    let l = m + 1.916 * Math.sin(m * rad) + 0.020 * Math.sin(2 * m * rad) + 282.634;
    l = ((l % 360) + 360) % 360;
    let ra = Math.atan(0.91764 * Math.tan(l * rad)) / rad;
    ra = ((ra % 360) + 360) % 360;
    ra = (ra + (Math.floor(l / 90) * 90 - Math.floor(ra / 90) * 90)) / 15;
    const sinDek = 0.39782 * Math.sin(l * rad);
    const cosDek = Math.cos(Math.asin(sinDek));
    const cosH = (Math.cos(90.833 * rad) - sinDek * Math.sin(BREITE * rad)) / (cosDek * Math.cos(BREITE * rad));
    if (cosH > 1 || cosH < -1) return null;
    const h = (aufgang ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
    const tt = h + ra - 0.06571 * t - 6.622;
    const ut = ((tt - lh) % 24 + 24) % 24;
    return new Date(heute + ut * 3600000);
  }

  function sonnenZeiten(jetzt) {
    return { auf: sonne(jetzt, true), unter: sonne(jetzt, false) };
  }

  function istTag(jetzt) {
    const z = sonnenZeiten(jetzt);
    if (!z.auf || !z.unter) return true;
    return jetzt >= z.auf && jetzt < z.unter;
  }

  function uhr(d) {
    return d ? String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") : "–";
  }

  function anwenden() {
    const modus = modusLesen();
    const jetzt = new Date();
    const dunkel = modus === "dunkel" || (modus === "auto" && !istTag(jetzt));
    const html = document.documentElement;
    html.setAttribute("data-theme", dunkel ? "dark" : "light");
    html.style.colorScheme = dunkel ? "dark" : "light";
    feldAktualisieren(modus, dunkel, jetzt);
  }

  // --- Das große Umschaltfeld (auf der Übersicht) ---------------------------
  // Jedes Element mit [data-thema-feld] wird zum Schalter: Tippen schaltet
  // Automatisch → Hell → Dunkel → Automatisch.
  function feldAktualisieren(modus, dunkel, jetzt) {
    const felder = document.querySelectorAll("[data-thema-feld]");
    if (!felder.length) return;
    const z = sonnenZeiten(jetzt);
    const titel = modus === "auto"
      ? (dunkel ? "🌙 Dunkel – automatisch nach der Sonne" : "☀️ Hell – automatisch nach der Sonne")
      : (modus === "dunkel" ? "🌙 Dunkel – fest eingestellt" : "☀️ Hell – fest eingestellt");
    let dazu;
    if (modus === "auto") {
      dazu = dunkel
        ? "Wird hell bei Sonnenaufgang in Volkmarsen (" + uhr(jetzt < z.auf ? z.auf : sonne(new Date(jetzt.getTime() + 86400000), true)) + " Uhr)"
        : "Wird dunkel bei Sonnenuntergang in Volkmarsen (" + uhr(z.unter) + " Uhr)";
    } else {
      dazu = "Sonne in Volkmarsen heute: ↑ " + uhr(z.auf) + " · ↓ " + uhr(z.unter) + " Uhr";
    }
    const naechster = { auto: "Hell", hell: "Dunkel", dunkel: "Automatisch" }[modus];
    felder.forEach((f) => {
      f.innerHTML =
        '<span class="thema-titel"></span><span class="thema-dazu"></span><span class="thema-weiter"></span>';
      f.querySelector(".thema-titel").textContent = titel;
      f.querySelector(".thema-dazu").textContent = dazu;
      f.querySelector(".thema-weiter").textContent = "Tippen: " + naechster;
      f.setAttribute("aria-label", titel + ". Tippen schaltet auf " + naechster + ".");
    });
  }

  function weiterschalten() {
    const modus = modusLesen();
    const neu = MODI[(MODI.indexOf(modus) + 1) % MODI.length];
    try {
      localStorage.setItem(SCHLUESSEL, neu);
    } catch (e) { /* privates Fenster: gilt dann nur bis zum Neuladen */ }
    gewaehlt = neu;
    anwenden();
  }

  anwenden();

  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-thema-feld]")) weiterschalten();
  });
  document.addEventListener("DOMContentLoaded", anwenden);
  // Jede Minute nachsehen: um 19:02 soll es auch ohne Neuladen dunkel werden.
  setInterval(anwenden, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") anwenden();
  });

  window.agelanThema = { anwenden, sonnenZeiten, istTag };
})();
