// ===========================================================================
// uebersicht-app.js – das Dashboard der AgeLan.
//
// Fasst zusammen, was gerade läuft: ob es gerade Essen gibt, welche Lieferung
// wann bestellt wurde und ob sie da ist, wie viel Frühstück bestellt ist, wer
// sein Essen noch nicht geholt hat und bei welchem Turnier man sich anmelden kann.
//
// ⚠️ Die Übersicht ist ein ANZEIGEBILDSCHIRM (Beamer/Fernseher, „das sehen
// hundert Leute“): immer nur EINE Kachel, groß, alle UB_WECHSEL_MS die nächste.
// Nichts Gerätebezogenes (Hell/Dunkel-Schalter steht unter Einstellungen).
//
// ⚠️ Seit 2026-10-01 OHNE Stream-Kachel (Michel: „komplett raus“). Welche
// Kacheln es gibt, stellen Veranstalter/Orga unter Einstellungen ein – für ALLE,
// gespeichert unter `uebersicht/kacheln` (siehe UB_KACHELN).
//
// ⚠️ GESAMMELTE Stände, nicht die eigenen: „Du hast bestellt" steht in den
// Bereichen selbst. Seit 2026-10-01 gibt es hier keine „Mein Essen"-Kachel mehr.
//
// ⚠️ NUR LESEND. Jede Kachel führt per Knopf in den Bereich, der die Sache
// wirklich kann. Ein zweiter Schreibweg neben dem eigentlichen Bereich wäre
// eine zweite Stelle, an der Rechte und Prüfungen mitgedacht werden müssten.
//
// ⚠️ Präfix `ub…` im geteilten Scope. `db` ist schon die Firebase-Datenbank
// (firebase-config.js), `ds`/`dsh` liest sich wie ein Service – also `ub`.
//
// ⚠️ Was hier steht, entscheidet sich an DREI verschiedenen Rechten, nicht an
// einem: Veranstalter/Orga sehen fremde Namen und Geld, Streamer sehen die
// Streamer-Nachfassliste, alle anderen Zahlen, Zeiten und den Ablauf.
// ===========================================================================

const UB_TAKT_MS = 30000;   // dieselbe Taktung wie das Essens-Zeitfenster
const UB_WECHSEL_MS = 15000; // so lange steht eine Kachel, dann kommt die nächste

// Welche Kachel gerade gezeigt wird – nach ID, nicht nach Position: fällt eine
// Kachel weg (Orga schaltet ab), springt die Anzeige nicht auf eine falsche.
let ubAktivId = null;
let ubWechselSeit = Date.now();
let ubSichtbareIds = [];

let ubTakt = null;
let ubGebunden = false;

function ubEl(id) {
  return document.getElementById(id);
}

// Die vier Bereiche sind eigenständig und können einzeln fehlen (Skript nicht
// geladen, Plan nicht angelegt). ⚠️ Jede Abfrage einzeln absichern: ein
// fehlender Bereich darf das ganze Dashboard nicht leeren.
function ubZustand(name) {
  try {
    const svc = {
      stream: typeof streamService !== "undefined" ? streamService : null,
      essen: typeof essenService !== "undefined" ? essenService : null,
      fruehstueck: typeof fruehstueckService !== "undefined" ? fruehstueckService : null,
      turnier: typeof turnierService !== "undefined" ? turnierService : null,
    }[name];
    return svc ? svc.getZustand() : null;
  } catch (e) {
    console.error("[Übersicht] " + name + " nicht lesbar:", e);
    return null;
  }
}

function ubIstVeranstalter() {
  try {
    return typeof kontoIstVeranstalter === "function" && kontoIstVeranstalter();
  } catch (e) {
    return false;
  }
}

// --- Zeit -------------------------------------------------------------------

function ubDauer(minuten) {
  const m = Math.max(0, Math.round(minuten));
  if (m < 60) return m + " Min";
  return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") + " h";
}

// Aktuelle Minute seit Plan-Start und der VERANSTALTUNGSTAG dazu (für die Kopfzeile). ⚠️ Um 1 Uhr
// nachts ist das noch der Vortag (sein Fenster reicht über Mitternacht); aus
// Math.floor(abs / 1440) wurde dort der NÄCHSTE Tag – und am letzten Tag gar
// keiner, die Kopfzeile blieb leer (Bugjagd 25.09.d T5b).
function ubJetztStand(z) {
  if (!z || !z.vorhanden || !z.tage.length) return null;
  const jetzt = new Date();
  const heute = jetzt.getFullYear() + "-" +
    String(jetzt.getMonth() + 1).padStart(2, "0") + "-" +
    String(jetzt.getDate()).padStart(2, "0");
  const minute = jetzt.getHours() * 60 + jetzt.getMinutes();

  const tagHeute = z.tage.find((t) => t.datum === heute);

  // ⚠️ Vor Mitternacht hinaus: es ist 1 Uhr nachts, der Plan kennt diesen
  // Kalendertag nicht, aber der Vortag läuft noch bis 2:00 (= 1560). Ohne
  // diesen Zweig wäre der Streamplan in der Nacht scheinbar tot.
  const gestern = new Date(jetzt.getTime() - 24 * 3600 * 1000);
  const gesternIso = gestern.getFullYear() + "-" +
    String(gestern.getMonth() + 1).padStart(2, "0") + "-" +
    String(gestern.getDate()).padStart(2, "0");
  const tagGestern = z.tage.find((t) => t.datum === gesternIso);
  // ⚠️ Das Fenster des Vortags geht vor: um 1 Uhr nachts läuft noch „gestern“,
  // auch wenn der Kalendertag selbst schon im Plan steht.
  if (tagGestern && minute + 1440 <= tagGestern.bis) {
    return { abs: tagGestern.index * 1440 + minute + 1440, tag: tagGestern };
  }
  if (tagHeute) return { abs: tagHeute.index * 1440 + minute, tag: tagHeute };
  return null;
}

// --- Bausteine --------------------------------------------------------------

function ubKachel(klasse, titel, inhalt, knopf) {
  return '<section class="ub-kachel ' + klasse + '">' +
    '<h2 class="ub-kachel-titel">' + titel + "</h2>" +
    inhalt +
    (knopf || "") +
    "</section>";
}

function ubKnopf(tab, text) {
  return '<button type="button" class="btn btn-link ub-weiter" data-ziel="' + tab + '">' +
    escapeHtml(text) + " →</button>";
}

function ubLeer(text) {
  return '<p class="ub-leer">' + escapeHtml(text) + "</p>";
}

function ubZeile(marke, kopf, dazu, klasse) {
  return '<div class="ub-zeile' + (klasse ? " " + klasse : "") + '">' +
    (marke ? '<span class="ub-marke">' + escapeHtml(marke) + "</span>" : "") +
    '<span class="ub-zeile-kopf">' + escapeHtml(kopf) + "</span>" +
    (dazu ? '<span class="ub-zeile-dazu">' + escapeHtml(dazu) + "</span>" : "") +
    "</div>";
}

// --- Kachel: Essen (für alle) ----------------------------------------------

// Uhrzeit eines Zeitstempels: „18:40", an einem anderen Tag „Fr 18:40".
// ⚠️ Mit Wochentag, sobald es nicht heute ist – um 1 Uhr nachts ist „23:10"
// sonst nicht von einer Lieferung von morgen Abend zu unterscheiden.
function ubUhr(ms) {
  const d = new Date(ms);
  const uhr = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  return d.toDateString() === new Date().toDateString()
    ? uhr
    : ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getDay()] + " " + uhr;
}

// ⚠️ Die Übersicht zeigt GESAMMELTE Stände, nicht die eigene Bestellung
// (Michel am 2026-10-01: „nicht meine Infos, sondern wirklich gesammelte").
// Die eigene steht im Reiter Essen. Namen und Beträge bleiben in der
// Orga-Kachel – hier nur Zahlen und Uhrzeiten, die jede:r sehen darf.
// Großer Status oben in einer Kachel: „kann ich jetzt?“ auf einen Blick.
function ubStatus(an, titel, dazu) {
  return '<div class="ub-status ' + (an ? "ub-status-an" : "ub-status-aus") + '">' +
    '<span class="ub-status-titel">' + escapeHtml(titel) + "</span>" +
    (dazu ? '<span class="ub-status-dazu">' + escapeHtml(dazu) + "</span>" : "") +
    "</div>";
}

function ubKachelLieferungen() {
  const z = ubZustand("essen");
  if (!z || !z.vorhanden) {
    return ubKachel("ub-lieferung ub-breit", "🍕 Essen",
      ubStatus(false, "🚫 Gerade gibt es kein Essen", "Es ist noch keine Essensbestellung angelegt."),
      ubKnopf("essen", "Zur Essensbestellung"));
  }

  const jetzt = Date.now();
  let inhalt = "";

  // ⚠️ Die wichtigste Frage zuerst und GROSS: gibt es gerade Essen? (Michel am
  // 2026-10-01: „wichtig ist Essen – dass man sieht, wenn es im Moment keins gibt“.)
  if (z.annahmeOffen) {
    inhalt += ubStatus(true, "✅ Jetzt Essen bestellen",
      z.fensterLabel ? "Bestellzeit " + z.fensterLabel : "Die Bestellung ist offen.");
  } else if (!z.schalterAn) {
    inhalt += ubStatus(false, "🚫 Gerade gibt es kein Essen", "Die Orga hat die Bestellung geschlossen.");
  } else {
    inhalt += ubStatus(false, "🚫 Gerade gibt es kein Essen",
      z.fensterLabel ? "Bestellen geht " + z.fensterLabel : "Außerhalb der Bestellzeit.");
  }

  // Gesammelt, aber noch nicht beim Lieferanten – die nächste Sammelbestellung.
  if (z.stapel.length) {
    const stueck = z.stapel.reduce((s, b) => s + b.stueck, 0);
    inhalt += ubZeile("gesammelt",
      z.stapel.length + " " + (z.stapel.length === 1 ? "Bestellung" : "Bestellungen") +
        " · " + stueck + " " + (stueck === 1 ? "Gericht" : "Gerichte"),
      "noch nicht beim Lieferanten");
  }

  // Jede Lieferung mit ihren Zeiten: wann beim Lieferanten bestellt, ob und
  // seit wann sie da ist, wie viel schon abgeholt ist.
  // ⚠️ „Da" ist `bescheidAm` – der Moment, in dem die Orga „Bescheid geben"
  // gedrückt hat. Einen eigenen Ankunftsstempel gibt es nicht.
  const unterwegs = z.runden.filter((r) => !r.fertig);
  if (unterwegs.length) {
    inhalt += '<div class="ub-block">' +
      '<p class="ub-block-titel">' +
      (unterwegs.length === 1 ? "1 Lieferung offen" : unterwegs.length + " Lieferungen offen") +
      "</p>" +
      unterwegs.map((r) => {
        const bestellt = r.erstelltAm ? "bestellt " + ubUhr(r.erstelltAm) : "";
        const zeit = r.bescheidAm
          ? "da seit " + ubUhr(r.bescheidAm) + " (" + ubDauer((jetzt - r.bescheidAm) / 60000) + ")"
          : (r.erstelltAm ? bestellt + " · wartet seit " + ubDauer((jetzt - r.erstelltAm) / 60000) : "beim Lieferanten bestellt");
        return ubZeile(
          r.bescheidAm ? "da" : "unterwegs",
          r.titel + " · " + r.stueck + " " + (r.stueck === 1 ? "Gericht" : "Gerichte"),
          zeit + " · " + r.abgeholt + " von " + r.anzahl + " abgeholt",
          r.bescheidAm ? "ub-live" : ""
        );
      }).join("") +
      "</div>";
  } else if (!z.runden.length && !z.stapel.length) {
    inhalt += ubLeer("Es ist noch nichts beim Lieferanten bestellt.");
  }

  // Die letzten erledigten Lieferungen als Verlauf – mit Lieferzeit, damit
  // die nächste Runde abschätzen kann, wie lange es dauert.
  const erledigt = z.runden.filter((r) => r.fertig).slice(0, 3);
  if (erledigt.length) {
    inhalt += '<div class="ub-block">' +
      '<p class="ub-block-titel">Zuletzt geliefert</p>' +
      erledigt.map((r) => ubZeile(
        "",
        r.titel + " · " + r.stueck + " " + (r.stueck === 1 ? "Gericht" : "Gerichte"),
        (r.erstelltAm ? "bestellt " + ubUhr(r.erstelltAm) : "") +
          (r.erstelltAm && r.bescheidAm && r.bescheidAm > r.erstelltAm
            ? " · da " + ubUhr(r.bescheidAm) + " (nach " + ubDauer((r.bescheidAm - r.erstelltAm) / 60000) + ")"
            : "") +
          " · alles abgeholt",
        "ub-still"
      )).join("") +
      "</div>";
  }

  return ubKachel("ub-lieferung ub-breit", "🍕 Essen", inhalt, ubKnopf("essen", "Zur Essensbestellung"));
}

// --- Kachel: offene Punkte (nur Veranstalter/Orga) --------------------------

// ⚠️ NUR für Veranstalter und Orga. Hier stehen fremde Namen und Beträge —
// wer was isst und wer noch schuldet, geht die übrigen Teilnehmer nichts an.
// Die Kachel wird für alle anderen gar nicht erst gebaut, nicht bloß versteckt.
function ubKachelOrga() {
  const z = ubZustand("essen");
  if (!z || !z.vorhanden) return "";
  // ⚠️ Veranstalter ist auch, wer im Essen per PIN oder als Ersteller (hostId)
  // Veranstalter ist – nicht nur ein Konto mit ⭐/🛠. Die Essensbestellung selbst
  // zeigt ihm Namen und Beträge ohnehin; nur hier fehlte die Kachel.
  if (!ubIstVeranstalter() && !z.istAdmin) return "";

  let inhalt = "";

  // Wer wartet noch auf sein Essen? Nach Lieferung getrennt, damit klar ist,
  // an welcher Ausgabe die Person steht.
  const wartet = [];
  z.runden.filter((r) => !r.fertig).forEach((r) => {
    r.bestellungen.filter((b) => b.status !== "abgeholt").forEach((b) => {
      wartet.push({ name: b.name, runde: r.titel, da: !!r.bescheidAm, bezahlt: b.status !== "neu" || b.orga });
    });
  });

  if (wartet.length) {
    inhalt += '<div class="ub-block ub-block-warn">' +
      '<p class="ub-block-titel">' +
      (wartet.length === 1 ? "1 Essen noch nicht abgeholt" : wartet.length + " Essen noch nicht abgeholt") +
      "</p>" +
      wartet.slice(0, 8).map((w) => ubZeile(
        w.da ? "liegt da" : "kommt noch",
        w.name,
        w.runde + (w.bezahlt ? "" : " · noch nicht bezahlt"),
        w.da ? "ub-warn" : ""
      )).join("") +
      (wartet.length > 8 ? ubLeer("… und " + (wartet.length - 8) + " weitere") : "") +
      "</div>";
  }

  if (z.offeneCent) {
    // ⚠️ Dieselbe Auswahl wie offeneCent im Dienst (neu UND nicht Orga) – mit
    // zaehler.neu stand „9,50 € · 2 offene Bestellungen“, obwohl eine davon ein
    // Orga-Essen ist, für das nie jemand zahlt.
    const offen = z.bestellungen.filter((b) => b.status === "neu" && !b.orga).length;
    inhalt += ubZeile("Kasse", essenService.centLabel(z.offeneCent) + " noch zu kassieren",
      offen + " offene " + (offen === 1 ? "Bestellung" : "Bestellungen"), "ub-warn");
  }

  if (z.stapel.length) {
    inhalt += ubZeile("Stapel", z.stapel.length + " " +
      (z.stapel.length === 1 ? "Bestellung wartet" : "Bestellungen warten"),
      "noch nicht beim Lieferanten");
  }

  if (!inhalt) inhalt = ubLeer("Nichts offen. Alles abgeholt und bezahlt.");

  return ubKachel("ub-orga", "🛠 Für die Orga", inhalt, ubKnopf("essen", "Zur Essensbestellung"));
}

// --- Kachel: Frühstück ------------------------------------------------------

// Die Frühstücks-Morgen, die noch kommen: oben groß, ob und bis wann bestellt
// werden kann; darunter je Morgen Besteller, Pakete und welche Pakete.
function ubKachelFruehstueck() {
  const z = ubZustand("fruehstueck");
  if (!z || !z.vorhanden) {
    return ubKachel("ub-fruehstueck ub-breit", "🥐 Frühstück",
      ubStatus(false, "🚫 Gerade kein Frühstück bestellbar", "Es ist noch keine Frühstücksbestellung angelegt."),
      ubKnopf("fruehstueck", "Zum Frühstück"));
  }

  const d = new Date();
  const heute = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  // ⚠️ Nach dem FRÜHSTÜCKSTAG gefiltert, nicht nach dem Bestellschluss: heute
  // Morgen ist der Schluss längst vorbei, die Pakete werden aber gerade verteilt.
  // Ab 12 Uhr ist das heutige Frühstück gegessen und fällt raus – sonst stand
  // nachmittags noch „Do 1.10. · Bestellschluss vorbei“ direkt unter dem grünen
  // Kasten für morgen, und es las sich, als sei die Bestellung für morgen zu.
  const vormittag = d.getHours() < 12;
  const kommende = z.tage.filter((t) => t.datum > heute || (t.datum === heute && vormittag)).slice(0, 3);
  const naechster = z.tage.find((t) => t.offen) || null;
  let inhalt = "";

  if (naechster) {
    inhalt += ubStatus(true, "✅ Frühstück für " + naechster.label + " bestellen",
      "Bestellschluss " + naechster.schlussLabel);
  } else {
    // ⚠️ Zwei Gründe, zwei Sätze – wie frWarumZu im Frühstück selbst: ist nur
    // der Schalter zu, kommt der Bestellschluss erst noch.
    const nochZeit = z.tage.some((t) => t.zeitOffen);
    inhalt += ubStatus(false, "🚫 Gerade kein Frühstück bestellbar",
      !z.schalterAn && nochZeit ? "Die Orga hat die Bestellung geschlossen." : "Für alle Tage ist der Bestellschluss vorbei.");
  }

  const paketName = {};
  (z.pakete || []).forEach((p) => { paketName[p.id] = p.name; });

  if (!kommende.length) {
    inhalt += ubLeer("Alle Frühstücks-Morgen sind vorbei.");
  } else {
    inhalt += kommende.map((t) => {
      const stand = t.anzahlBesteller + " Besteller · " + t.stueckGesamt + " " +
        (t.stueckGesamt === 1 ? "Paket" : "Pakete");
      // Welche Pakete – das ist die Einkaufsliste für diesen Morgen.
      const welche = Object.keys(t.gesamt || {})
        .filter((id) => t.gesamt[id] > 0)
        .map((id) => t.gesamt[id] + "× " + (paketName[id] || "Paket"))
        .join(", ");
      const schluss = t.offen
        ? "bestellbar bis " + t.schlussLabel
        : (t.datum === heute
          ? "Frühstück heute früh – bestellt wurde bis " + t.schlussLabel
          : (t.vorbei ? "Bestellung geschlossen seit " + t.schlussLabel : "Annahme gerade geschlossen"));
      return ubZeile(t.datum === heute ? "heute" : t.label, stand, (welche ? welche + " · " : "") + schluss, t.offen ? "ub-live" : "");
    }).join("");
  }

  return ubKachel("ub-fruehstueck ub-breit", "🥐 Frühstück", inhalt, ubKnopf("fruehstueck", "Zum Frühstück"));
}

// --- Kachel: Turnier --------------------------------------------------------

function ubKachelTurnier() {
  if (typeof TURNIER_SICHTBAR !== "undefined" && !TURNIER_SICHTBAR) return "";
  const z = ubZustand("turnier");
  if (!z) return "";

  const liste = (z.liste || []).filter((t) => t.phase !== "beendet");
  const offen = liste.filter((t) => t.istOffen);
  let inhalt = "";

  // Die Turnieranmeldung steht unten noch einmal ausdrücklich da (Michel am
  // 2026-10-01): offene Anmeldungen zuerst und als großer Hinweis.
  if (offen.length) {
    inhalt += ubStatus(true, "✅ Turnieranmeldung offen",
      offen.length === 1 ? offen[0].name : offen.length + " Turniere – jetzt eintragen");
  }
  if (!liste.length) {
    inhalt += ubLeer("Gerade läuft kein Turnier.");
  } else {
    inhalt += offen.concat(liste.filter((t) => !t.istOffen)).slice(0, 6).map((t) => ubZeile(
      t.istOffen ? "Anmeldung" : (t.phase || "läuft"),
      t.name,
      t.spielerAnzahl + " Teilnehmer",
      t.istOffen ? "ub-live" : ""
    )).join("");
    if (liste.length > 6) inhalt += ubLeer("… und " + (liste.length - 6) + " weitere");
  }

  return ubKachel("ub-turnier ub-breit", "🏆 Turnier", inhalt,
    ubKnopf("turnier", offen.length ? "Zur Turnieranmeldung" : "Zu den Turnieren"));
}

// --- Kachel: allgemeine Infos ----------------------------------------------
//
// Freitext der Orga, gepflegt unter Einstellungen, gespeichert unter
// `uebersicht/infos` (ein String). Jede Zeile wird ein eigener Punkt; eine
// Zeile, die mit „#“ beginnt, wird eine Zwischenüberschrift. Ohne Text
// erscheint die Kachel gar nicht erst (kein leerer Punkt in der Leiste).
const UB_INFOS_MAX = 2000;
let ubInfosText = "";

function ubKachelInfos() {
  const zeilen = String(ubInfosText || "").split(/\r?\n/).map((z) => z.trim()).filter(Boolean);
  if (!zeilen.length) return "";
  const inhalt = zeilen.map((z) => z.charAt(0) === "#"
    ? '<p class="ub-block-titel ub-info-kopf">' + escapeHtml(z.replace(/^#+\s*/, "")) + "</p>"
    : '<div class="ub-zeile ub-info"><span class="ub-zeile-kopf">' + escapeHtml(z) + "</span></div>"
  ).join("");
  return ubKachel("ub-infos ub-breit", "ℹ️ Infos", inhalt);
}

// --- Auswahl der Kacheln ----------------------------------------------------
//
// ⚠️ Gilt für ALLE, nicht je Gerät: Veranstalter/Orga stellen unter Einstellungen
// ein, was auf der Übersicht steht. Gespeichert unter `uebersicht/kacheln/<id>`
// (true/false); fehlt ein Wert, gilt `an`. Schreiben dürfen laut Regeln nur
// Konten mit ⭐/🛠 (Claim agelanOrga).
const UB_KACHELN = [
  { id: "essen", kurz: "🍕 Essen", label: "🍕 Essen", an: true, bau: () => ubKachelLieferungen() },
  { id: "fruehstueck", kurz: "🥐 Frühstück", label: "🥐 Frühstück", an: true, bau: () => ubKachelFruehstueck() },
  { id: "orga", kurz: "🛠 Orga", label: "🛠 Für die Orga (nur auf Geräten mit ⭐/🛠-Konto – nicht für den Beamer)", an: true, bau: () => ubKachelOrga() },
  { id: "turnier", kurz: "🏆 Turnier", label: "🏆 Turnier und Anmeldung", an: true, bau: () => ubKachelTurnier() },
  { id: "infos", kurz: "ℹ️ Infos", label: "ℹ️ Allgemeine Infos (Text unten)", an: true, bau: () => ubKachelInfos() },
];
let ubAuswahl = {};          // aus Firebase; leer = alles nach Standard
let ubAuswahlGebunden = false;

function ubKachelAn(id) {
  const k = UB_KACHELN.find((x) => x.id === id);
  return typeof ubAuswahl[id] === "boolean" ? ubAuswahl[id] : !!(k && k.an);
}

function ubEinstellungenZeichnen() {
  const box = ubEl("ub-einstellungen");
  if (!box) return;
  box.innerHTML = UB_KACHELN.map((k) =>
    '<label class="ub-wahl"><input type="checkbox" data-ub-kachel="' + k.id + '"' +
    (ubKachelAn(k.id) ? " checked" : "") + "> " + escapeHtml(k.label) + "</label>"
  ).join("");
}

// Schreiben mit der ⭐/🛠-Rolle. ⚠️ Die Rolle (Claim agelanOrga) holt das Gerät
// beim Laden und sie läuft ab; lehnt die Datenbank ab, wird sie EINMAL neu
// geholt und dann noch einmal geschrieben – wie in den anderen Bereichen
// (rolleNachAblehnung). Ohne das kam „PERMISSION_DENIED“, obwohl das Konto ⭐
// ist (Michel am 2026-10-01 bei den Infos).
async function ubMitRolleSchreiben(pfad, wert) {
  try {
    await db.ref(pfad).set(wert);
    return;
  } catch (err) {
    const abgelehnt = /permission/i.test(String(err && (err.code || err.message) || ""));
    if (!abgelehnt || typeof holeFirebaseRolle !== "function") throw err;
    const ok = await holeFirebaseRolle("abgelehnt");
    if (!ok) throw new Error(ubRolleGrund());
    await db.ref(pfad).set(wert);
  }
}

// Warum die Datenbank das Gerät nicht als ⭐/🛠 kennt – für die Fehlermeldung.
function ubRolleGrund() {
  const konto = typeof kontoIstVeranstalter === "function" && kontoIstVeranstalter();
  if (!konto) return "Dieses Gerät ist nicht mit einem ⭐/🛠-Konto angemeldet.";
  const stand = typeof rolleStand === "string" ? rolleStand : "";
  if (stand === "aus") return "Die Datenbank nimmt die ⭐/🛠-Rolle nicht an – sind die Regeln veröffentlicht?";
  if (stand === "holt") return "Die ⭐/🛠-Rolle wird gerade noch geholt – in ein paar Sekunden noch einmal speichern.";
  return "Die ⭐/🛠-Rolle ließ sich nicht holen (" + (stand || "unbekannt") + ") – Seite neu laden und noch einmal versuchen.";
}

function ubAuswahlBinden() {
  if (ubAuswahlGebunden || typeof db === "undefined" || typeof auth === "undefined") return;
  ubAuswahlGebunden = true;
  // ⚠️ Erst nach der (anonymen) Anmeldung lesen – vorher lehnen die Regeln ab
  // und der Listener wäre für immer tot.
  auth.onAuthStateChanged((user) => {
    if (!user || ubAuswahl.__gebunden) return;
    ubAuswahl.__gebunden = true;
    db.ref("uebersicht/kacheln").on("value", (snap) => {
      const v = snap.val() || {};
      ubAuswahl = { __gebunden: true };
      UB_KACHELN.forEach((k) => { if (typeof v[k.id] === "boolean") ubAuswahl[k.id] = v[k.id]; });
      ubEinstellungenZeichnen();
      ubVielleichtRendern();
    }, (e) => {
      // Regeln noch nicht veröffentlicht o. ä.: Standard zeigen, nicht leer.
      console.warn("[Übersicht] Auswahl nicht lesbar – Standard gilt:", e && e.message);
    });
    db.ref("uebersicht/infos").on("value", (snap) => {
      const v = snap.val();
      ubInfosText = typeof v === "string" ? v : "";
      const feld = ubEl("ub-infos-text");
      // ⚠️ Nicht überschreiben, während jemand gerade darin tippt – sonst
      // springt der Text unter den Fingern zurück, wenn ein anderes Gerät speichert.
      if (feld && document.activeElement !== feld) feld.value = ubInfosText;
      ubVielleichtRendern();
    }, (e) => {
      console.warn("[Übersicht] Infos nicht lesbar:", e && e.message);
    });
  });

  const knopfInfos = ubEl("ub-infos-speichern");
  if (knopfInfos) {
    knopfInfos.addEventListener("click", async () => {
      const feld = ubEl("ub-infos-text");
      const meldung = ubEl("ub-infos-meldung");
      const text = String(feld ? feld.value : "").slice(0, UB_INFOS_MAX);
      knopfInfos.disabled = true;
      if (meldung) meldung.textContent = "";
      try {
        await ubMitRolleSchreiben("uebersicht/infos", text);
        if (meldung) meldung.textContent = text.trim() ? "Gespeichert – steht jetzt auf der Übersicht." : "Geleert – die Kachel Infos ist ausgeblendet.";
      } catch (err) {
        if (meldung) {
          meldung.textContent = "Nicht gespeichert: " + (err && err.message || err);
        }
      } finally {
        knopfInfos.disabled = false;
      }
    });
  }

  const box = ubEl("ub-einstellungen");
  if (box) {
    box.addEventListener("change", async (e) => {
      const cb = e.target.closest("[data-ub-kachel]");
      if (!cb) return;
      const fehler = ubEl("ub-einstellungen-fehler");
      if (fehler) fehler.textContent = "";
      try {
        await ubMitRolleSchreiben("uebersicht/kacheln/" + cb.dataset.ubKachel, cb.checked);
      } catch (err) {
        cb.checked = !cb.checked;   // zurückdrehen, sonst behauptet der Haken etwas Falsches
        if (fehler) {
          fehler.textContent = "Nicht gespeichert: " + (err && err.message || err);
        }
      }
    });
  }
  ubEinstellungenZeichnen();
}

// --- Aufbau -----------------------------------------------------------------

function ubRender() {
  const ziel = ubEl("ub-kacheln");
  if (!ziel) return;

  // Kopfzeile: welcher Tag der Veranstaltung ist gerade?
  const sz = ubZustand("stream");
  const titel = ubEl("ub-titel");
  const unter = ubEl("ub-untertitel");
  // Der Name kommt aus dem Streamplan („AgeLan #3 Streamplan“) – das Wort
  // „Streamplan“ gehört auf den Anzeigebildschirm aber nicht mehr dazu.
  const name = (sz && sz.vorhanden && sz.meta.titel)
    ? String(sz.meta.titel).replace(/\s*[-–·]?\s*streamplan\s*$/i, "").trim() : "";
  if (titel) titel.textContent = name || "AgeLan";
  if (unter) {
    const stand = ubJetztStand(sz);
    if (sz && sz.vorhanden && stand) {
      const tag = stand.tag;
      unter.textContent = tag
        ? "Tag " + (tag.index + 1) + " von " + sz.tage.length + " · " + tag.label
        : "";
    } else {
      unter.textContent = "";
    }
  }

  // Reihenfolge fest: Essen, Frühstück, Orga, ganz unten das Turnier mit der
  // Anmeldung. Welche davon erscheinen, entscheidet die Auswahl (UB_KACHELN).
  const kacheln = UB_KACHELN.filter((k) => ubKachelAn(k.id)).map((k) => {
    try {
      return { id: k.id, kurz: k.kurz, html: k.bau() };
    } catch (e) {
      console.error("[Übersicht] Kachel " + k.id + " fehlgeschlagen:", e);
      return null;
    }
  }).filter((k) => k && k.html);
  ubSichtbareIds = kacheln.map((k) => k.id);

  if (!kacheln.length) {
    ziel.innerHTML = ubLeer("Die Orga hat alle Kacheln ausgeblendet.");
    return;
  }
  if (ubSichtbareIds.indexOf(ubAktivId) < 0) {
    ubAktivId = kacheln[0].id;
    ubWechselSeit = Date.now();
  }
  const aktiv = kacheln.find((k) => k.id === ubAktivId);

  // Unten die Leiste: welche Kachel gerade dran ist und ein Balken bis zur
  // nächsten. ⚠️ Der Balken läuft per negativer animation-delay WEITER, wenn
  // zwischendurch neu gezeichnet wird (neue Bestellung) – sonst finge er bei
  // jeder Änderung von vorn an und stimmte nicht mehr mit dem Wechsel überein.
  let leiste = "";
  if (kacheln.length > 1) {
    const vergangen = Math.min(UB_WECHSEL_MS, Date.now() - ubWechselSeit);
    leiste = '<div class="ub-leiste" role="tablist">' +
      kacheln.map((k) => '<button type="button" role="tab" class="ub-punkt' +
        (k.id === ubAktivId ? " aktiv" : "") + '" data-ub-zeige="' + k.id + '" aria-selected="' +
        (k.id === ubAktivId) + '">' + escapeHtml(k.kurz) + "</button>").join("") +
      "</div>" +
      '<div class="ub-fortschritt"><i style="animation-duration:' + UB_WECHSEL_MS +
      "ms;animation-delay:-" + vergangen + 'ms"></i></div>';
  }
  ziel.innerHTML = '<div class="ub-buehne">' + aktiv.html + "</div>" + leiste;
}

// Nächste Kachel. Läuft im Sekundentakt mit, gewechselt wird erst nach
// UB_WECHSEL_MS – so bleibt der Wechsel auch nach einem Klick auf die Leiste
// (der die Uhr neu startet) im richtigen Abstand.
function ubWechselPruefen() {
  if (!ubSichtbar() || ubSichtbareIds.length < 2) return;
  if (Date.now() - ubWechselSeit < UB_WECHSEL_MS) return;
  const i = ubSichtbareIds.indexOf(ubAktivId);
  ubAktivId = ubSichtbareIds[(i + 1) % ubSichtbareIds.length];
  ubWechselSeit = Date.now();
  ubRender();
}

// Nur zeichnen, wenn der Reiter auch offen ist – sonst rechnet das Dashboard
// bei jeder fremden Bestellung mit, ohne dass es jemand sieht.
function ubSichtbar() {
  const el = ubEl("tab-uebersicht");
  return !!el && el.classList.contains("active");
}

function ubVielleichtRendern() {
  if (ubSichtbar()) ubRender();
}

(function ubInit() {
  const ziel = ubEl("ub-kacheln");
  if (!ziel || ubGebunden) return;
  ubGebunden = true;

  // ⚠️ An ALLE vier Bereiche hängen: jede fremde Änderung kann eine Kachel
  // betreffen, und welche, ist von hier aus nicht zu unterscheiden.
  [
    typeof streamService !== "undefined" ? streamService : null,
    typeof essenService !== "undefined" ? essenService : null,
    typeof fruehstueckService !== "undefined" ? fruehstueckService : null,
    typeof turnierService !== "undefined" ? turnierService : null,
  ].forEach((svc) => {
    if (svc && typeof svc.onZustandsAenderung === "function") {
      try {
        svc.onZustandsAenderung(ubVielleichtRendern);
      } catch (e) {
        console.error("[Übersicht] Anbinden fehlgeschlagen:", e);
      }
    }
  });

  // ⚠️ Ein eigener Takt ist Pflicht: „in 25 Min" und „Bestellen geht gerade"
  // laufen ab, ohne dass irgendwer etwas nach Firebase schreibt. Ohne ihn
  // stünde die Übersicht still, bis zufällig jemand anders etwas ändert.
  // setInterval, NICHT requestAnimationFrame – das steht im versteckten Tab.
  if (ubTakt) clearInterval(ubTakt);
  ubTakt = setInterval(ubVielleichtRendern, UB_TAKT_MS);
  setInterval(ubWechselPruefen, 1000);

  // Die Knöpfe der Kacheln führen in den jeweiligen Bereich. Delegiert, weil
  // die Kacheln bei jedem Neuzeichnen neue Elemente sind.
  ziel.addEventListener("click", (e) => {
    // Klick auf die Leiste: diese Kachel zeigen, die 15 Sekunden laufen neu.
    const punkt = e.target.closest("[data-ub-zeige]");
    if (punkt) {
      ubAktivId = punkt.getAttribute("data-ub-zeige");
      ubWechselSeit = Date.now();
      ubRender();
      return;
    }
    const knopf = e.target.closest("[data-ziel]");
    if (!knopf) return;
    if (typeof activateTab === "function") activateTab(knopf.getAttribute("data-ziel"));
  });

  ubAuswahlBinden();
  ubVielleichtRendern();
})();
