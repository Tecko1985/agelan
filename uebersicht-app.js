// ===========================================================================
// uebersicht-app.js – das Dashboard der AgeLan.
//
// Fasst zusammen, was gerade läuft: wer sendet, was als Nächstes ansteht, wo
// ein Streamer fehlt, welche Essenslieferung unterwegs oder da ist und wer
// sein Essen noch nicht geholt hat.
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
// Streamer-Nachfassliste, alle anderen nur sich selbst und den Ablauf.
// ===========================================================================

const UB_TAKT_MS = 30000;   // dieselbe Taktung wie das Essens-Zeitfenster

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

// „in 25 Min", „in 2:15 h", „seit 40 Min". ⚠️ Bewusst relativ: am zweiten
// LAN-Tag um drei Uhr nachts sagt „um 15:30" weniger als „in 12 Stunden".
function ubRelativ(minuten) {
  const m = Math.round(minuten);
  const abs = Math.abs(m);
  if (abs < 1) return "gerade eben";
  const text = abs < 60
    ? abs + " Min"
    : Math.floor(abs / 60) + ":" + String(abs % 60).padStart(2, "0") + " h";
  return m >= 0 ? "in " + text : "seit " + text;
}

function ubDauer(minuten) {
  const m = Math.max(0, Math.round(minuten));
  if (m < 60) return m + " Min";
  return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") + " h";
}

// Absolute Minute seit Plan-Start – dieselbe Rechnung wie im Streamkalender,
// damit „Do 25:00" und „Fr 1:00" derselbe Zeitpunkt bleiben.
function ubJetztAbsolut(z) {
  if (!z || !z.vorhanden || !z.tage.length) return null;
  const jetzt = new Date();
  const heute = jetzt.getFullYear() + "-" +
    String(jetzt.getMonth() + 1).padStart(2, "0") + "-" +
    String(jetzt.getDate()).padStart(2, "0");
  const minute = jetzt.getHours() * 60 + jetzt.getMinutes();

  const tagHeute = z.tage.find((t) => t.datum === heute);
  if (tagHeute) return tagHeute.index * 1440 + minute;

  // ⚠️ Vor Mitternacht hinaus: es ist 1 Uhr nachts, der Plan kennt diesen
  // Kalendertag nicht, aber der Vortag läuft noch bis 2:00 (= 1560). Ohne
  // diesen Zweig wäre der Streamplan in der Nacht scheinbar tot.
  const gestern = new Date(jetzt.getTime() - 24 * 3600 * 1000);
  const gesternIso = gestern.getFullYear() + "-" +
    String(gestern.getMonth() + 1).padStart(2, "0") + "-" +
    String(gestern.getDate()).padStart(2, "0");
  const tagGestern = z.tage.find((t) => t.datum === gesternIso);
  if (tagGestern && minute + 1440 <= tagGestern.bis) {
    return tagGestern.index * 1440 + minute + 1440;
  }
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

// --- Kachel: Stream ---------------------------------------------------------

function ubKachelStream() {
  const z = ubZustand("stream");
  if (!z || !z.vorhanden) {
    return ubKachel("ub-stream", "📺 Stream",
      ubLeer("Es gibt noch keinen Streamplan."), ubKnopf("stream", "Zum Streamplan"));
  }

  const jetzt = ubJetztAbsolut(z);
  let inhalt = "";

  if (jetzt === null) {
    inhalt = ubLeer("Heute ist kein Veranstaltungstag.");
  } else {
    // ⚠️ ALLE laufenden, nicht nur der erste: zwei gleichzeitige Einträge kann
    // die Prüfung beim Speichern nicht verhindern (zwei Geräte im selben
    // Moment), und der Kalender zeigt sie nebeneinander. Hier fiel einer weg.
    const laufende = z.slots.filter((s) => s.absVon <= jetzt && s.absBis > jetzt).sort((a, b) => a.absVon - b.absVon);
    const laeuft = laufende[0] || null;
    const naechster = z.slots.filter((s) => s.absVon > jetzt).sort((a, b) => a.absVon - b.absVon)[0];

    if (laeuft) {
      laufende.forEach((l) => {
        inhalt += ubZeile("live", l.streamer + (l.titel ? " – " + l.titel : ""),
          "noch " + ubDauer(l.absBis - jetzt), "ub-live");
      });
    } else {
      inhalt += ubZeile("", "Gerade sendet niemand", "", "ub-still");
    }

    if (naechster) {
      inhalt += ubZeile("danach", naechster.streamer + (naechster.titel ? " – " + naechster.titel : ""),
        ubRelativ(naechster.absVon - jetzt) + " · " +
        streamService.zeitLabel(naechster.von) + "–" + streamService.zeitLabel(naechster.bis));
    } else if (!laeuft) {
      inhalt += ubLeer("Für den Rest der Veranstaltung ist kein Stream eingetragen.");
    }

    // Der laufende und der nächste Programmpunkt – das Programm sagt, WORUM es
    // gerade geht, der Slot nur, WER sendet.
    const prgLaeuft = z.programm.find((p) => p.absVon <= jetzt && p.absBis > jetzt);
    const prgNaechst = z.programm.filter((p) => p.absVon > jetzt).sort((a, b) => a.absVon - b.absVon)[0];
    if (prgLaeuft) {
      inhalt += ubZeile("Programm", prgLaeuft.titel, "noch " + ubDauer(prgLaeuft.absBis - jetzt));
    }
    if (prgNaechst) {
      inhalt += ubZeile("dann", prgNaechst.titel, ubRelativ(prgNaechst.absVon - jetzt));
    }
  }

  // ⚠️ Die offenen Programmpunkte sind der Grund, warum es das Häkchen gibt:
  // hier ist die Nachfassliste. Vergangene bleiben draußen – daran ist nichts
  // mehr zu retten, und eine Liste voller Vorwürfe liest niemand mehr.
  const offen = z.programm
    .filter((p) => p.streamerFehlt && (jetzt === null || p.absBis > jetzt))
    .sort((a, b) => a.absVon - b.absVon);
  if (offen.length) {
    inhalt += '<div class="ub-block ub-block-warn">' +
      '<p class="ub-block-titel">' +
      (offen.length === 1 ? "1 Programmpunkt ohne Streamer" : offen.length + " Programmpunkte ohne Streamer") +
      "</p>" +
      offen.slice(0, 4).map((p) => ubZeile(
        streamService.datumLabel(p.datum, false),
        p.titel,
        streamService.zeitLabel(p.von) + "–" + streamService.zeitLabel(p.bis) +
          " · " + ubDauer(p.offeneMinuten) + " offen"
      )).join("") +
      (offen.length > 4 ? ubLeer("… und " + (offen.length - 4) + " weitere") : "") +
      "</div>";
  }

  return ubKachel("ub-stream", "📺 Stream", inhalt,
    ubKnopf("stream", z.darfEintragen ? "Zeit belegen" : "Zum Streamplan"));
}

// --- Kachel: mein Essen -----------------------------------------------------

// ⚠️ Diese Kachel sieht JEDE:R und sie zeigt ausschließlich die EIGENEN
// Bestellungen. Fremde Namen stehen in der Veranstalter-Kachel weiter unten.
function ubKachelMeinEssen() {
  const z = ubZustand("essen");
  if (!z || !z.vorhanden) return "";

  const meine = z.meine.filter((b) => b.status !== "abgeholt");
  let inhalt = "";

  if (!meine.length) {
    inhalt = z.annahmeOffen
      ? ubLeer("Du hast gerade nichts bestellt.")
      : ubLeer("Du hast gerade nichts bestellt. Die Annahme ist zu.");
  } else {
    inhalt = meine.map((b) => {
      const runde = z.runden.find((r) => r.id === b.rundeId);
      const was = b.positionen.map((p) => p.anzahl + "x " + p.name).join(", ");
      // ⚠️ „bestellt" heißt beim Lieferanten bestellt, nicht abholbereit.
      // Abholbereit ist es, wenn die ganze Lieferung auf „bestellt" steht und
      // der Veranstalter Bescheid gegeben hat – das ist `bescheidAm`.
      const dran = b.status === "bestellt" && runde && runde.bescheidAm
        ? "Liegt bereit – abholen!"
        : b.statusLang;
      return ubZeile(b.status === "bestellt" && runde && runde.bescheidAm ? "abholen" : "",
        was, dran + (runde ? " · " + runde.titel : ""),
        b.status === "bestellt" && runde && runde.bescheidAm ? "ub-live" : "");
    }).join("");
  }

  const offen = meine.filter((b) => b.status === "neu" && !b.orga);
  if (offen.length) {
    const cent = offen.reduce((s, b) => s + b.zahltCent, 0);
    inhalt += ubZeile("zahlen", essenService.centLabel(cent) + " noch offen",
      "bei der Orga abgeben", "ub-warn");
  }

  return ubKachel("ub-essen", "🍕 Mein Essen", inhalt, ubKnopf("essen", "Zur Essensbestellung"));
}

// --- Kachel: Lieferungen (für alle) ----------------------------------------

function ubKachelLieferungen() {
  const z = ubZustand("essen");
  if (!z || !z.vorhanden) {
    return ubKachel("ub-lieferung", "🚚 Essen", ubLeer("Es gibt noch keine Essensbestellung."),
      ubKnopf("essen", "Zur Essensbestellung"));
  }

  let inhalt = "";

  // Annahme-Zustand: die Frage „kann ich jetzt bestellen?" ist die häufigste.
  if (z.annahmeOffen) {
    inhalt += ubZeile("offen", "Bestellen geht gerade",
      z.fensterLabel || "kein Zeitfenster gesetzt", "ub-live");
  } else if (!z.schalterAn) {
    inhalt += ubZeile("zu", "Der Veranstalter hat zugemacht", "", "ub-still");
  } else {
    inhalt += ubZeile("zu", "Außerhalb der Bestellzeit", z.fensterLabel, "ub-still");
  }

  const unterwegs = z.runden.filter((r) => !r.fertig);
  if (unterwegs.length) {
    inhalt += '<div class="ub-block">' +
      '<p class="ub-block-titel">' +
      (unterwegs.length === 1 ? "1 Lieferung unterwegs" : unterwegs.length + " Lieferungen unterwegs") +
      "</p>" +
      unterwegs.map((r) => ubZeile(
        r.bescheidAm ? "da" : "bestellt",
        r.titel,
        r.abgeholt + " von " + r.anzahl + " abgeholt",
        r.bescheidAm ? "ub-live" : ""
      )).join("") +
      "</div>";
  } else if (z.runden.length) {
    inhalt += ubLeer("Alles abgeholt.");
  } else {
    inhalt += ubLeer("Es ist noch nichts beim Lieferanten bestellt.");
  }

  return ubKachel("ub-lieferung", "🚚 Essen", inhalt, ubKnopf("essen", "Zur Essensbestellung"));
}

// --- Kachel: offene Punkte (nur Veranstalter/Orga) --------------------------

// ⚠️ NUR für Veranstalter und Orga. Hier stehen fremde Namen und Beträge —
// wer was isst und wer noch schuldet, geht die übrigen Teilnehmer nichts an.
// Die Kachel wird für alle anderen gar nicht erst gebaut, nicht bloß versteckt.
function ubKachelOrga() {
  if (!ubIstVeranstalter()) return "";
  const z = ubZustand("essen");
  if (!z || !z.vorhanden) return "";

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

function ubKachelFruehstueck() {
  const z = ubZustand("fruehstueck");
  if (!z || !z.vorhanden) return "";

  const naechster = z.tage.find((t) => t.offen) || null;
  let inhalt = "";

  if (!naechster) {
    // ⚠️ Zwei Gründe, zwei Sätze – wie frWarumZu im Frühstück selbst: ist nur
    // der Schalter zu, kommt der Bestellschluss erst noch.
    const nochZeit = z.tage.some((t) => t.zeitOffen);
    inhalt = ubLeer(!z.schalterAn && nochZeit
      ? "Die Bestellannahme ist gerade geschlossen."
      : "Für alle Tage ist der Bestellschluss vorbei.");
  } else {
    const eigene = naechster.bestellungen.find((b) => b.istEigene);
    inhalt += ubZeile(naechster.label, eigene ? "Du hast bestellt" : "Du hast noch nicht bestellt",
      "Schluss: " + naechster.schlussLabel, eigene ? "" : "ub-warn");
    const wieViele = naechster.bestellungen.length;
    inhalt += ubZeile("", wieViele + " " + (wieViele === 1 ? "Bestellung" : "Bestellungen") + " für diesen Morgen", "");
  }

  return ubKachel("ub-fruehstueck", "🥐 Frühstück", inhalt, ubKnopf("fruehstueck", "Zum Frühstück"));
}

// --- Kachel: Turnier --------------------------------------------------------

function ubKachelTurnier() {
  if (typeof TURNIER_SICHTBAR !== "undefined" && !TURNIER_SICHTBAR) return "";
  const z = ubZustand("turnier");
  if (!z) return "";

  const liste = (z.liste || []).filter((t) => t.phase !== "beendet");
  let inhalt = "";

  if (!liste.length) {
    inhalt = ubLeer("Gerade läuft kein Turnier.");
  } else {
    inhalt = liste.slice(0, 4).map((t) => ubZeile(
      t.istOffen ? "Anmeldung" : (t.phase || "läuft"),
      t.name,
      t.spielerAnzahl + " " + (t.spielerAnzahl === 1 ? "Teilnehmer" : "Teilnehmer") +
        (t.binIchDrin ? " · du bist dabei" : ""),
      t.istOffen ? "ub-live" : ""
    )).join("");
    if (liste.length > 4) inhalt += ubLeer("… und " + (liste.length - 4) + " weitere");
  }

  return ubKachel("ub-turnier", "🏆 Turnier", inhalt, ubKnopf("turnier", "Zu den Turnieren"));
}

// --- Aufbau -----------------------------------------------------------------

function ubRender() {
  const ziel = ubEl("ub-kacheln");
  if (!ziel) return;

  // Kopfzeile: welcher Tag der Veranstaltung ist gerade?
  const sz = ubZustand("stream");
  const titel = ubEl("ub-titel");
  const unter = ubEl("ub-untertitel");
  if (titel) titel.textContent = (sz && sz.vorhanden && sz.meta.titel) ? sz.meta.titel : "Übersicht";
  if (unter) {
    const jetzt = ubJetztAbsolut(sz);
    if (sz && sz.vorhanden && jetzt !== null) {
      const tag = sz.tage[Math.floor(jetzt / 1440)];
      unter.textContent = tag
        ? "Tag " + (tag.index + 1) + " von " + sz.tage.length + " · " + tag.label
        : "";
    } else {
      unter.textContent = "";
    }
  }

  // ⚠️ Reihenfolge nach Dringlichkeit, nicht nach Bereich: was den Einzelnen
  // JETZT betrifft (mein Essen), steht vor dem Überblick.
  ziel.innerHTML = [
    ubKachelStream(),
    ubKachelMeinEssen(),
    ubKachelOrga(),
    ubKachelLieferungen(),
    ubKachelFruehstueck(),
    ubKachelTurnier(),
  ].filter(Boolean).join("");
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

  // Die Knöpfe der Kacheln führen in den jeweiligen Bereich. Delegiert, weil
  // die Kacheln bei jedem Neuzeichnen neue Elemente sind.
  ziel.addEventListener("click", (e) => {
    const knopf = e.target.closest("[data-ziel]");
    if (!knopf) return;
    if (typeof activateTab === "function") activateTab(knopf.getAttribute("data-ziel"));
  });

  ubVielleichtRendern();
})();
