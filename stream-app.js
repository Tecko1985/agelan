// ===========================================================================
// stream-app.js – Oberfläche des Streamkalenders (Tab "Stream").
//
// Redet ausschließlich über streamService, genau wie app.js über turnierService.
// Alle Bezeichner sind mit sk… benannt, weil app.js und turnier-service.js im
// selben globalen Scope liegen – ein doppelt vergebener Name wäre ein
// SyntaxError, der die ganze Seite stilllegt.
//
// Bewusst NICHT die Klasse .screen benutzt: app.js schaltet mit
// querySelectorAll(".screen") alle Screens der App um und würde die Ansichten
// hier mit ausblenden. Der Streamkalender hat mit .sk-view sein eigenes Toggle.
//
// Fremdeingaben (Streamer-Name, Titel, Notiz) laufen durch escapeHtml() aus
// app.js, bevor sie per innerHTML in den Kalender kommen.
// ===========================================================================

// Höhe einer Stunde im Raster; einzige Quelle für Blockhöhe, Stundenlinien und
// das Umrechnen beim Ziehen.
// ⚠️ 48 px waren zu eng: ein Programmpunkt über eine Stunde hat 42 px Innenraum,
// und sobald der Titel zweizeilig umbrach ("Turnier Ankündigung"), fiel die
// Streamer-Marke aus dem Block. Michel im Bild: "immer noch recht eng".
// Bei 72 px bleiben 66 px – Zeit, zwei Titelzeilen und die Marke passen zusammen.
const SK_STUNDE_PX = 72;
const SK_SCHRITT_UI = 15;

let skZustand = null;
let skAktiverTag = null;      // Datum des am Handy sichtbaren Tages
let skDialogSlotId = null;    // null = neue Belegung, sonst die bearbeitete
let skDialogNurLesen = false;
let skDialogEigenGesperrt = false;   // eigener Eintrag, aber ohne 🎥-Recht (nur lesen)
let skProgrammDialogId = null;
let skProgrammNurLesen = false;
// Zeitfenster, die der Veranstalter gerade umstellt, aber noch nicht
// gespeichert hat (Datum -> { von, bis }). ⚠️ skRenderAdmin baut die Liste bei
// JEDER Live-Änderung neu – ohne diesen Entwurf spränge die Auswahl zurück, und
// „Zeiten speichern“ schriebe den alten Wert mit „Gespeichert.“.
let skFensterEntwurf = {};

// --- kleine Helfer ---------------------------------------------------------
function skEl(id) {
  return document.getElementById(id);
}

function skZeigeFehler(id, text) {
  const el = skEl(id);
  if (el) el.textContent = text || "";
}

function skZeigeView(id) {
  document.querySelectorAll("#tab-stream .sk-view").forEach((el) => el.classList.toggle("aktiv", el.id === id));
}

// Füllt eine Uhrzeit-Auswahl mit Viertelstunden. Auswahllisten statt freier
// Eingabe: damit kann nichts außerhalb des Tagesfensters landen und die
// Nachtstunden (25:00 = 1:00) sind eindeutig beschriftet.
function skFuelleZeiten(select, von, bis, wert) {
  if (!select) return;
  const teile = [];
  // ⚠️ Das Ziehen rastet auf 5 Minuten (SK_ZIEH_SCHRITT). Liegt der gespeicherte
  // Wert zwischen zwei Viertelstunden, bekommt er eine eigene Option – sonst
  // fiele die Auswahl auf den ersten Eintrag, und „Speichern“ schriebe den
  // Tagesbeginn statt der gezogenen Zeit.
  const eigen = wert != null && isFinite(Number(wert)) ? Number(wert) : null;
  const eigenFehlt = eigen !== null && eigen >= von && eigen <= bis && (eigen - von) % SK_SCHRITT_UI !== 0;
  for (let m = von; m <= bis; m += SK_SCHRITT_UI) {
    if (eigenFehlt && eigen < m && eigen > m - SK_SCHRITT_UI) {
      teile.push('<option value="' + eigen + '">' + streamService.zeitLabelLang(eigen) + "</option>");
    }
    teile.push('<option value="' + m + '">' + streamService.zeitLabelLang(m) + "</option>");
  }
  if (eigenFehlt && eigen > von + Math.floor((bis - von) / SK_SCHRITT_UI) * SK_SCHRITT_UI) {
    teile.push('<option value="' + eigen + '">' + streamService.zeitLabelLang(eigen) + "</option>");
  }
  // ⚠️ Das Ende des Bereichs gehört immer dazu. Beginnt die Liste nicht im
  // Viertelstunden-Raster (gezogen auf 5 Minuten, z. B. 12:05), fiel sonst das
  // Tagesende heraus, und bis zum Schluss ließ sich nichts mehr eintragen
  // (Bugjagd 25.09.d T5b).
  if (bis > von && (bis - von) % SK_SCHRITT_UI !== 0 && !(eigenFehlt && eigen === bis)) {
    teile.push('<option value="' + bis + '">' + streamService.zeitLabelLang(bis) + "</option>");
  }
  select.innerHTML = teile.join("");
  if (wert != null) select.value = String(wert);
  if (!select.value && select.options.length) select.selectedIndex = 0;
}

// Welcher VERANSTALTUNGSTAG läuft gerade? ⚠️ Um 1 Uhr nachts ist das noch der
// Vortag, wenn sein Fenster über Mitternacht reicht (bis > 1440) – der Kalender
// sprang sonst nachts auf den Kalendertag statt auf den laufenden LAN-Tag
// (Bugjagd 25.09.d T5b). Gleiche Regel wie ubJetztStand in der Übersicht.
function skLanTagJetzt(z) {
  const jetzt = new Date();
  const minute = jetzt.getHours() * 60 + jetzt.getMinutes();
  const g = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() - 1);
  const gestern = g.getFullYear() + "-" + String(g.getMonth() + 1).padStart(2, "0") + "-" + String(g.getDate()).padStart(2, "0");
  const tagGestern = skTagVon(z, gestern);
  if (tagGestern && minute + 1440 <= tagGestern.bis) return gestern;
  const heute = streamService.heuteIso();
  return skTagVon(z, heute) ? heute : null;
}

function skTagVon(z, datum) {
  return z.tage.find((t) => t.datum === datum) || null;
}

// ===========================================================================
// Haupt-Render
// ===========================================================================
function skRender(z) {
  skZustand = z;
  if (!z.vorhanden) {
    skZeigeView("sk-kein-plan");
    skRenderKeinPlan(z);
    return;
  }
  // Aktiver Tag: beim ersten Rendern der heutige, wenn er im Plan liegt –
  // sonst der erste. Eine spätere Auswahl bleibt bestehen, solange es den Tag gibt.
  if (!skAktiverTag || !skTagVon(z, skAktiverTag)) {
    skAktiverTag = skLanTagJetzt(z) || z.tage[0].datum;
  }
  skZeigeView("sk-plan");
  skRenderPlan(z);
}

function skRenderKeinPlan(z) {
  // ⚠️ Lehnt die Datenbank schon das LESEN ab, sieht diese Ansicht aus wie
  // "noch kein Plan angelegt" – und das Anlegen scheitert danach genauso.
  // Der Grund gehoert deshalb sofort sichtbar ueber das Formular, nicht erst
  // nach einem Klick.
  skZeigeFehler("sk-neu-fehler", z.lesefehler || "");
  const pinFeld = skEl("sk-neu-pin");
  const pinHinweis = skEl("sk-neu-pin-hinweis");
  // Läuft schon ein Turnier und wir sind dort Veranstalter, übernimmt der
  // Streamplan denselben PIN – ein Geheimnis statt zwei.
  if (z.turnierPin && pinFeld && !pinFeld.value) {
    pinFeld.value = z.turnierPin;
    if (pinHinweis) pinHinweis.textContent = "Vorgeschlagen ist der Veranstalter-PIN des laufenden Turniers, damit du dir nur einen merken musst.";
  } else if (pinHinweis && !z.turnierPin) {
    pinHinweis.textContent = "Mit diesem PIN kommst du später an die Zeitfenster und kannst fremde Einträge korrigieren.";
  }
  const datum = skEl("sk-neu-start");
  if (datum && !datum.value) datum.value = streamService.heuteIso();
}

function skRenderPlan(z) {
  skEl("sk-titel").textContent = z.meta.titel || "Streamplan";

  const ersterTag = z.tage[0];
  const letzterTag = z.tage[z.tage.length - 1];
  const spanne = z.tage.length > 1
    ? streamService.datumLabel(ersterTag.datum, false) + " bis " + streamService.datumLabel(letzterTag.datum, true)
    : streamService.datumLabel(ersterTag.datum, true);
  const belegt = z.slots.length;
  const prg = z.programm.length;
  // ⚠️ Die offenen Punkte gehoeren in die Kopfzeile, nicht nur an den einzelnen
  // Block: wer den Plan aufmacht, soll ohne Scrollen sehen, dass noch etwas
  // fehlt. Bei null offenen steht nichts – eine dauerhafte "0 offen" liest sich
  // nach einer Weile als Deko und wird uebersehen.
  const offen = z.programm.filter((p) => p.streamerFehlt).length;
  skEl("sk-zeitraum").textContent = spanne + " · " +
    (belegt === 1 ? "1 Stream" : belegt + " Streams") + " · " +
    (prg === 1 ? "1 Programmpunkt" : prg + " Programmpunkte") +
    (offen ? " · " + (offen === 1 ? "1 ohne Streamer" : offen + " ohne Streamer") : "");

  // Das Programm gibt die Veranstaltung vor – anlegen darf es nur der Veranstalter.
  skEl("sk-btn-programm").style.display = z.istAdmin ? "" : "none";
  // ⚠️ Der Knopf verschwindet fuer alle ohne Streamer-Freigabe. Ein sichtbarer
  // Knopf, der nur in eine Fehlermeldung fuehrt, ist schlechter als keiner -
  // die Schranke selbst sitzt im Service, nicht hier.
  skEl("sk-btn-belegen").style.display = z.darfEintragen ? "" : "none";

  skRenderChips(z);
  skRenderKalender(z);
  skZiehAnbinden();
  // ⚠️ Nach dem Neuzeichnen zeigt der Tipp auf ein Element, das es nicht mehr
  // gibt – und bliebe stehen, bis die Maus sich bewegt.
  skTippVerstecken();
  skRenderListe(z);
  skRenderAdmin(z);
}

// --- Tageswahl (nur am Handy sichtbar) -------------------------------------
function skRenderChips(z) {
  skEl("sk-tagchips").innerHTML = z.tage
    .map((t) => {
      const anzahl = z.slots.filter((s) => s.datum === t.datum).length;
      return '<button class="sk-chip' + (t.datum === skAktiverTag ? " aktiv" : "") + '" data-tag="' + t.datum + '">' +
        escapeHtml(t.label) + (anzahl ? ' <span class="sk-chip-zahl">' + anzahl + "</span>" : "") +
        "</button>";
    })
    .join("");
}

// --- Kalenderraster --------------------------------------------------------
// Alle Tage teilen sich eine Zeitachse von der frühesten bis zur spätesten
// Stunde aller Tagesfenster. Was außerhalb des eigenen Fensters eines Tages
// liegt, wird grau hinterlegt statt weggelassen – sonst stünden die Spalten
// gegeneinander versetzt und man könnte die Zeiten nicht mehr vergleichen.
function skRenderKalender(z) {
  const achseVon = Math.floor(z.achseVon / 60) * 60;
  const achseBis = Math.ceil(z.achseBis / 60) * 60;
  const hoehe = ((achseBis - achseVon) / 60) * SK_STUNDE_PX;

  const marken = [];
  for (let m = achseVon; m < achseBis; m += 60) {
    marken.push('<div class="sk-zeitmarke" style="height:' + SK_STUNDE_PX + 'px">' +
      '<span>' + streamService.zeitLabel(m) + "</span></div>");
  }

  // Je Tag zwei Spuren nebeneinander: links, was die Veranstaltung vorgibt,
  // rechts, was sich die Streamer buchen. Getrennt, weil ein Stream zeitgleich
  // zum Turnier laufen darf – nebeneinander, damit man genau das sieht.
  const spalten = z.tage.map((tag) => {
    const gesperrt = [];
    if (tag.von > achseVon) {
      gesperrt.push('<div class="sk-gesperrt" style="top:0;height:' + skPx(tag.von - achseVon) + 'px"></div>');
    }
    if (tag.bis < achseBis) {
      gesperrt.push('<div class="sk-gesperrt" style="top:' + skPx(tag.bis - achseVon) + "px;height:" + skPx(achseBis - tag.bis) + 'px"></div>');
    }

    const programm = z.programm.filter((p) => p.datum === tag.datum);
    const slots = z.slots.filter((s) => s.datum === tag.datum);
    skVerteileSpuren(programm);
    skVerteileSpuren(slots);

    const flaeche = (klasse, spur, inhalt) =>
      '<div class="sk-tagflaeche ' + klasse + '" data-tag="' + tag.datum + '" data-spur="' + spur + '"' +
      ' style="height:' + hoehe + "px;background-size:100% " + SK_STUNDE_PX + 'px">' +
      gesperrt.join("") + inhalt + "</div>";

    return '<div class="sk-tag' + (tag.datum === skAktiverTag ? " aktiv" : "") + '" data-tag="' + tag.datum + '">' +
      '<div class="sk-tagkopf">' + escapeHtml(tag.label) +
      '<span class="sk-tagzeit">' + streamService.zeitLabel(tag.von) + "–" + streamService.zeitLabel(tag.bis) + "</span></div>" +
      '<div class="sk-spurkopf"><span class="sk-spurname programm">Programm</span><span class="sk-spurname streams">Streams</span></div>' +
      '<div class="sk-spuren">' +
      flaeche("sk-programmflaeche", "programm", skFaerbeKetten(programm).map((p) => skProgrammBlock(p, achseVon)).join("")) +
      flaeche("sk-streamflaeche", "streams", skFaerbeKetten(slots).map((s) => skStreamBlock(s, achseVon)).join("")) +
      "</div></div>";
  });

  skEl("sk-kalender").innerHTML =
    '<div class="sk-raster">' +
    // ⚠️ Der Kopf ueber der Zeitleiste MUSS denselben Aufbau haben wie der
    // Tageskopf daneben - zwei Zeilen, nicht leer. visibility:hidden haelt zwar
    // Platz, aber nur den des tatsaechlichen Inhalts: ein leeres Div war 34 px
    // flacher, und dadurch standen SAEMTLICHE Bloecke 34 px unter ihrer
    // Stundenlinie. Von Michel im Bild gemeldet ("nicht ganz mittig").
    '<div class="sk-zeitspalte"><div class="sk-tagkopf sk-zeitkopf">&nbsp;<span class="sk-tagzeit">&nbsp;</span></div>' +
    '<div class="sk-spurkopf sk-zeitkopf"><span class="sk-spurname">&nbsp;</span></div>' +
    marken.join("") + "</div>" +
    spalten.join("") +
    "</div>";
}

// ⚠️ Zwei Bloecke, bei denen das Ende des einen der Beginn des naechsten ist,
// verschmelzen optisch zu EINEM Block - im Bild nicht zu unterscheiden. Deshalb
// bekommt jeder zweite einer solchen Kette einen dunkleren Ton. Verglichen wird
// bis auf die Minute; nur echte Nahtstellen zaehlen, eine Luecke bricht die Kette.
function skFaerbeKetten(liste) {
  const sortiert = liste.slice().sort((a, b) => a.von - b.von || a.bis - b.bis);
  let letztesEnde = null;
  let zweiter = false;
  sortiert.forEach((e) => {
    if (letztesEnde !== null && e.von === letztesEnde) zweiter = !zweiter;
    else zweiter = false;
    e.kettenZweiter = zweiter;
    letztesEnde = e.bis;
  });
  return liste;
}

function skBlockStil(eintrag, achseVon) {
  const breite = 100 / eintrag.spurAnzahl;
  return [
    "top:" + skPx(eintrag.von - achseVon) + "px",
    "height:" + Math.max(18, skPx(eintrag.bis - eintrag.von)) + "px",
    // ⚠️ Die 4 px Luft gehoeren zur HAELFTE nach links, sonst klebt der Block am
    // linken Rand seiner Spur und hat rechts die ganze Luecke. Gemessen: 1 px
    // links gegen 5 px rechts. Michel: "mittig ist es immer noch nicht".
    "left:calc(" + (eintrag.spur * breite) + "% + 2px)",
    "width:calc(" + breite + "% - 4px)",
  ].join(";");
}

function skStreamBlock(s, achseVon) {
  const klassen = ["sk-slot"];
  if (s.istEigener) klassen.push("eigen");
  if (s.kettenZweiter) klassen.push("kette");
  const titel = s.titel ? '<span class="sk-slot-titel">' + escapeHtml(s.titel) + "</span>" : "";
  return '<button type="button" class="' + klassen.join(" ") + '" data-slot="' + s.id + '" style="' + skBlockStil(s, achseVon) + '">' +
    '<span class="sk-slot-zeit">' + streamService.zeitLabel(s.von) + "–" + streamService.zeitLabel(s.bis) + "</span>" +
    '<span class="sk-slot-name">' + escapeHtml(s.streamer) + "</span>" +
    titel +
    "</button>";
}

// Ab dieser Dauer hat der Block Platz fuer eine eigene Marken-Zeile unter dem
// Titel. ⚠️ Gemessen bei SK_STUNDE_PX = 72: 45 Min = 54 px, die Marke endet bei
// 51 px. Darunter wuerde `overflow: hidden` sie abschneiden – der rote Rahmen
// bliebe, der Grund dafuer waere aber unsichtbar.
const SK_MARKE_AB_MIN = 45;

function skProgrammBlock(p, achseVon) {
  // Im Block ist wenig Platz: nur der Fehlt-Fall bekommt ein Zeichen, und zwar
  // ein auffaelliges. "Alles in Ordnung" braucht am Kalender keine Marke.
  const kurz = p.bis - p.von < SK_MARKE_AB_MIN;
  // ⚠️ Im kurzen Block wandert das Zeichen in die ZEIT-Zeile statt zu
  // verschwinden: eine eigene Zeile gibt es dort nicht, und ein roter Rahmen
  // ohne erkennbaren Grund laesst jeden raten.
  const marke = p.streamerFehlt && !kurz
    ? '<span class="sk-block-warnung" title="Hier fehlt noch ein Streamer">⚠ Streamer</span>'
    : "";
  const zeichen = p.streamerFehlt && kurz
    ? ' <span class="sk-zeit-warnung" title="Hier fehlt noch ein Streamer">⚠</span>'
    : "";
  return '<button type="button" class="sk-slot programm' + (p.kettenZweiter ? " kette" : "") +
    (p.streamerFehlt ? " streamer-fehlt" : "") + '" data-programm="' + p.id + '" style="' + skBlockStil(p, achseVon) + '">' +
    '<span class="sk-slot-zeit">' + streamService.zeitLabel(p.von) + "–" + streamService.zeitLabel(p.bis) + zeichen + "</span>" +
    '<span class="sk-slot-name">' + escapeHtml(p.titel) + "</span>" +
    marke +
    "</button>";
}

// "1:45 h" statt "105 Minuten" – gelesen wird das an einem Kalender.
function skDauerLabel(minuten) {
  const m = Math.max(0, Math.round(minuten));
  const std = Math.floor(m / 60);
  const rest = m % 60;
  if (!std) return rest + " Min";
  return std + ":" + String(rest).padStart(2, "0") + " h";
}

// Das Abzeichen am Programmpunkt. Drei Faelle, drei Aussagen:
// gar keiner gebraucht / einer gebraucht und da / einer gebraucht und fehlt.
// ⚠️ Der Fehlt-Fall MUSS die offene Zeit nennen – "Streamer fehlt" an einem
// Punkt, der zu drei Vierteln abgedeckt ist, schickt sonst jemanden auf die
// Suche nach einer Luecke, die er nicht sieht.
function skStreamerMarke(p, lang) {
  if (!p.streamerNoetig) {
    return '<span class="sk-marke kein-streamer" title="Dafuer wird kein Streamer gebraucht">kein Streamer</span>';
  }
  if (p.streamerFehlt) {
    return '<span class="sk-marke streamer-fehlt">Streamer fehlt' +
      (lang ? " · " + skDauerLabel(p.offeneMinuten) + " offen" : "") + "</span>";
  }
  return '<span class="sk-marke streamer-da">Streamer da</span>';
}

function skPx(minuten) {
  return Math.round((minuten / 60) * SK_STUNDE_PX);
}

// Überschneidungen sind seit 2026-09-15 ausdrücklich erlaubt (der Plan ist eine
// Vormerkung, kein Sendeplan). Zwei Streams auf derselben Zeit stehen deshalb
// nebeneinander statt sich gegenseitig zu verdecken – genau wie die
// Programmpunkte in der Spur links daneben.
function skVerteileSpuren(slots) {
  // ⚠️ Die Spurenzahl gilt JE GRUPPE sich überschneidender Blöcke, nicht für den
  // ganzen Tag. Bis zum 16.09.2026 stand hier eine Zahl für alle: zwei Streams
  // um 20 Uhr machten auch den einsamen Stream um 10 Uhr halb so breit
  // (Bugjagd A4). Eine Gruppe endet, sobald ein Block erst NACH dem Ende aller
  // bisherigen beginnt (Berührung Ende == Beginn zählt nicht als Überschneidung).
  // Sortiert wird eine Kopie – die Reihenfolge des Arrays gehört dem Aufrufer.
  const reihe = slots.slice().sort((a, b) => a.von - b.von || a.bis - b.bis);
  let gruppe = [];
  let spurEnde = [];
  let gruppeBis = -Infinity;
  const schliesse = () => {
    const anzahl = Math.max(1, spurEnde.length);
    gruppe.forEach((s) => { s.spurAnzahl = anzahl; });
    gruppe = [];
    spurEnde = [];
  };
  reihe.forEach((s) => {
    if (gruppe.length && s.von >= gruppeBis) schliesse();
    let spur = spurEnde.findIndex((ende) => ende <= s.von);
    if (spur === -1) {
      spurEnde.push(s.bis);
      spur = spurEnde.length - 1;
    } else {
      spurEnde[spur] = s.bis;
    }
    s.spur = spur;
    gruppe.push(s);
    gruppeBis = gruppe.length === 1 ? s.bis : Math.max(gruppeBis, s.bis);
  });
  if (gruppe.length) schliesse();
}

// --- Liste unter dem Kalender ----------------------------------------------
// Programm und Streams in einer gemeinsamen Zeitleiste, damit man den Ablauf
// des Tages am Stück lesen kann statt in zwei Listen zu springen.
function skRenderListe(z) {
  const box = skEl("sk-liste");
  const alles = z.programm
    .map((p) => ({ art: "programm", e: p }))
    .concat(z.slots.map((s) => ({ art: "stream", e: s })))
    .sort((a, b) => a.e.absVon - b.e.absVon || (a.art === "programm" ? -1 : 1));

  if (!alles.length) {
    box.innerHTML = '<p class="hinweis-text">Noch ist nichts eingetragen. Trag dich ein, wann du senden willst.</p>';
    return;
  }

  box.innerHTML = alles
    .map(({ art, e }) => {
      const istProgramm = art === "programm";
      const marke = istProgramm
        ? '<span class="sk-marke programm">Programm</span>'
        : '<span class="sk-marke stream">Stream</span>';
      const wer = istProgramm
        ? escapeHtml(e.titel) + " " + skStreamerMarke(e, true)
        : escapeHtml(e.streamer) + (e.istEigener ? ' <span class="spieler-badge">(du)</span>' : "") +
          (e.titel ? ' <span class="sk-zeile-titel">' + escapeHtml(e.titel) + "</span>" : "");
      const knopf = e.darfBearbeiten
        ? '<button type="button" class="mini-btn" data-' + (istProgramm ? "programm" : "slot") + '="' + e.id + '">Ändern</button>'
        : "";
      return '<div class="sk-zeile">' +
        marke +
        '<span class="sk-zeile-zeit">' + escapeHtml(streamService.datumLabel(e.datum, false)) + " " +
        streamService.zeitLabel(e.von) + "–" + streamService.zeitLabel(e.bis) + "</span>" +
        '<span class="sk-zeile-wer">' + wer + "</span>" +
        knopf +
        "</div>";
    })
    .join("");
}

// --- Veranstalter-Bereich ---------------------------------------------------
function skRenderAdmin(z) {
  skEl("sk-admin-login").style.display = z.istAdmin ? "none" : "";
  skEl("sk-admin-panel").style.display = z.istAdmin ? "" : "none";
  if (!z.istAdmin) return;

  skEl("sk-fenster-liste").innerHTML = z.tage
    .map((t) =>
      '<div class="sk-fenster-zeile" data-tag="' + t.datum + '">' +
      '<span class="sk-fenster-tag">' + escapeHtml(t.label) + "</span>" +
      '<select class="eingabe sk-fenster-von" aria-label="Beginn ' + escapeHtml(t.label) + '"></select>' +
      '<span class="sk-fenster-bis">bis</span>' +
      '<select class="eingabe sk-fenster-bis-sel" aria-label="Ende ' + escapeHtml(t.label) + '"></select>' +
      "</div>"
    )
    .join("");

  // Optionen erst nach dem Einhängen füllen – die Listen sind lang und sollen
  // den geltenden Wert vorausgewählt zeigen.
  z.tage.forEach((t) => {
    const zeile = skEl("sk-fenster-liste").querySelector('[data-tag="' + t.datum + '"]');
    if (!zeile) return;
    const entwurf = skFensterEntwurf[t.datum];
    skFuelleZeiten(zeile.querySelector(".sk-fenster-von"), 0, 1440 - SK_SCHRITT_UI, entwurf ? entwurf.von : t.von);
    skFuelleZeiten(zeile.querySelector(".sk-fenster-bis-sel"), SK_SCHRITT_UI, streamService.MAX_BIS, entwurf ? entwurf.bis : t.bis);
  });
}

// ===========================================================================
// Dialog "Zeit belegen"
// ===========================================================================
function skOeffneDialog(slotId, vorbelegung) {
  // Bewusst den frischen Zustand holen statt skZustand: der Zwischenspeicher
  // wird nur bei einer Datenänderung neu gesetzt, der Veranstalter-Status hängt
  // aber auch am localStorage-PIN. Sonst entscheidet die Maske über Rechte,
  // die schon nicht mehr gelten.
  const z = streamService.getZustand();
  if (!z || !z.vorhanden) return;

  const slot = slotId ? z.slots.find((s) => s.id === slotId) : null;
  // ⚠️ Neu belegen nur mit Eintrag-Recht – wie beim Programm. Der Knopf ist
  // ohne Recht versteckt, aber ein Klick in die freie Stream-Spur öffnete sonst
  // einen offenen Dialog, dessen Speichern erst am Dienst scheiterte (Bugjagd
  // 25.09.d T5b).
  if (!slot && !z.darfEintragen) return;
  skDialogSlotId = slot ? slot.id : null;
  skDialogNurLesen = !!slot && !slot.darfBearbeiten;
  // ⚠️ Nur-Lesen hat zwei Gründe: fremder Eintrag ODER eigener, aber der
  // Streamer-Haken 🎥 fehlt. Im zweiten Fall stand bis 25.09.2026 „Diesen
  // Eintrag hat jemand anders gemacht.“ (Bugjagd 25.09.d T5b).
  skDialogEigenGesperrt = !!slot && skDialogNurLesen && !!slot.istEigener;

  const datum = slot ? slot.datum : ((vorbelegung && vorbelegung.datum) || skAktiverTag);
  const tag = skTagVon(z, datum) || z.tage[0];

  skEl("sk-dlg-titel-text").textContent = slot
    ? (skDialogNurLesen ? "Eingetragener Stream" : "Belegung ändern")
    : "Zeit belegen";

  // Tagesauswahl
  skEl("sk-dlg-tag").innerHTML = z.tage
    .map((t) => '<option value="' + t.datum + '">' + escapeHtml(t.label) + "</option>")
    .join("");
  skEl("sk-dlg-tag").value = tag.datum;

  const von = slot ? slot.von : skStartVorschlag(tag, vorbelegung);
  const bis = slot ? slot.bis : Math.min(tag.bis, von + 120);
  skFuelleDialogZeiten(tag, von, bis);

  skEl("sk-dlg-name").value = slot ? slot.streamer : streamService.getGespeicherterName();
  skEl("sk-dlg-was").value = slot ? slot.titel : "";
  skEl("sk-dlg-notiz").value = slot ? slot.notiz : "";

  // Nur-Ansicht heißt: die Felder sind gesperrt, nicht bloß der Speichern-Knopf.
  ["sk-dlg-tag", "sk-dlg-von", "sk-dlg-bis", "sk-dlg-name", "sk-dlg-was", "sk-dlg-notiz"].forEach((id) => {
    skEl(id).disabled = skDialogNurLesen;
  });
  skEl("sk-dlg-speichern").style.display = skDialogNurLesen ? "none" : "";
  skEl("sk-dlg-loeschen").style.display = slot && !skDialogNurLesen ? "" : "none";
  skEl("sk-dlg-abbrechen").textContent = skDialogNurLesen ? "Schließen" : "Abbrechen";
  skZeigeFehler("sk-dlg-fehler", "");
  skAktualisiereParallelHinweis();

  skEl("modal-stream").classList.add("aktiv");
  if (typeof dlgFokusRein === "function") dlgFokusRein("modal-stream");   // D-12, app.js
}

// ⚠️ Seit 2026-09-15 nimmt der Plan überschneidende Zeiten an. Weil dabei
// niemand mehr abgewiesen wird, MUSS die Maske vorher sagen, wer schon auf der
// Zeit steht – sonst merkt man es erst am fertigen Kalender, und dort sind zwei
// halbbreite Blöcke leicht zu übersehen. Läuft bei jeder Änderung an Tag,
// Beginn oder Ende neu; die Menge kommt aus dem Service, damit Maske und
// Kalender dieselbe Überschneidung meinen.
function skAktualisiereParallelHinweis() {
  const el = skEl("sk-dlg-hinweis");
  if (!el) return;
  if (skDialogNurLesen) {
    el.textContent = skDialogEigenGesperrt
      ? "Das ist dein Eintrag – ändern oder löschen geht nur mit dem Streamer-Haken 🎥. Melde dich bei Michel."
      : "Diesen Eintrag hat jemand anders gemacht.";
    return;
  }
  const andere = streamService.paralleleZu({
    datum: skEl("sk-dlg-tag").value,
    von: skEl("sk-dlg-von").value,
    bis: skEl("sk-dlg-bis").value,
  }, skDialogSlotId);
  if (!andere.length) {
    el.textContent = "Mehrere dürfen sich dieselbe Zeit nehmen – das hier ist eine Planung, kein Sendeplan.";
    return;
  }
  const namen = andere.map((s) => s.streamer || "jemand");
  el.textContent = (namen.length === 1 ? "In dieser Zeit steht schon " : "In dieser Zeit stehen schon ") +
    skUndListe(namen) + " im Plan. Das geht – ihr steht dann nebeneinander im Kalender.";
}

// „Anna, Ben und Carl" – ein Komma vor dem letzten Namen liest sich wie eine
// abgebrochene Liste.
function skUndListe(namen) {
  if (namen.length < 2) return namen[0] || "";
  return namen.slice(0, -1).join(", ") + " und " + namen[namen.length - 1];
}

// Startvorschlag: die angeklickte Zeit, sonst der nächste freie Viertelstunden-
// Beginn ab jetzt bzw. der Tagesbeginn.
function skStartVorschlag(tag, vorbelegung) {
  if (vorbelegung && vorbelegung.von != null) {
    return Math.min(Math.max(vorbelegung.von, tag.von), tag.bis - SK_SCHRITT_UI);
  }
  return tag.von;
}

function skFuelleDialogZeiten(tag, von, bis) {
  const vonSel = skEl("sk-dlg-von");
  const bisSel = skEl("sk-dlg-bis");
  const gewaehltVon = Math.min(Math.max(skZahlAus(von, tag.von), tag.von), tag.bis - SK_SCHRITT_UI);
  skFuelleZeiten(vonSel, tag.von, tag.bis - SK_SCHRITT_UI, gewaehltVon);
  const gewaehltBis = Math.min(Math.max(skZahlAus(bis, gewaehltVon + SK_SCHRITT_UI), gewaehltVon + SK_SCHRITT_UI), tag.bis);
  skFuelleZeiten(bisSel, gewaehltVon + SK_SCHRITT_UI, tag.bis, gewaehltBis);
}

function skZahlAus(wert, ersatz) {
  const n = Number(wert);
  return isFinite(n) ? n : ersatz;
}

function skSchliesseDialog() {
  skEl("modal-stream").classList.remove("aktiv");
  if (typeof dlgFokusZurueck === "function") dlgFokusZurueck("modal-stream");   // D-12
  skDialogSlotId = null;
  skDialogNurLesen = false;
}

// ===========================================================================
// Dialog "Programmpunkt" (Veranstalter; für alle anderen nur zum Nachlesen)
// ===========================================================================
function skOeffneProgrammDialog(programmId, vorbelegung) {
  const z = streamService.getZustand();   // frisch, siehe skOeffneDialog
  if (!z || !z.vorhanden) return;

  const punkt = programmId ? z.programm.find((p) => p.id === programmId) : null;
  if (!punkt && !z.istAdmin) return;   // Anlegen ist Veranstaltersache
  skProgrammDialogId = punkt ? punkt.id : null;
  skProgrammNurLesen = !z.istAdmin;

  const datum = punkt ? punkt.datum : ((vorbelegung && vorbelegung.datum) || skAktiverTag);
  const tag = skTagVon(z, datum) || z.tage[0];

  skEl("sk-prg-titel-text").textContent = punkt
    ? (skProgrammNurLesen ? "Programmpunkt" : "Programmpunkt ändern")
    : "Programmpunkt anlegen";

  skEl("sk-prg-tag").innerHTML = z.tage
    .map((t) => '<option value="' + t.datum + '">' + escapeHtml(t.label) + "</option>")
    .join("");
  skEl("sk-prg-tag").value = tag.datum;

  const von = punkt ? punkt.von : skStartVorschlag(tag, vorbelegung);
  const bis = punkt ? punkt.bis : Math.min(tag.bis, von + 120);
  skFuelleProgrammZeiten(tag, von, bis);

  skEl("sk-prg-was").value = punkt ? punkt.titel : "";
  skEl("sk-prg-notiz").value = punkt ? punkt.notiz : "";
  // ⚠️ Neue Punkte starten mit gesetztem Haken. Der Normalfall ist, dass die
  // Veranstaltung gestreamt werden soll; die Ausnahme klickt man weg.
  skEl("sk-prg-streamer").checked = punkt ? !!punkt.streamerNoetig : true;
  skEl("sk-prg-streamer-hinweis").textContent = skProgrammStreamerHinweis(punkt);

  ["sk-prg-tag", "sk-prg-von", "sk-prg-bis", "sk-prg-was", "sk-prg-notiz", "sk-prg-streamer"].forEach((id) => {
    skEl(id).disabled = skProgrammNurLesen;
  });
  skEl("sk-prg-speichern").style.display = skProgrammNurLesen ? "none" : "";
  skEl("sk-prg-loeschen").style.display = punkt && !skProgrammNurLesen ? "" : "none";
  skEl("sk-prg-abbrechen").textContent = skProgrammNurLesen ? "Schließen" : "Abbrechen";
  skZeigeFehler("sk-prg-fehler", "");
  skEl("sk-prg-hinweis").textContent = skProgrammNurLesen
    ? "Das Programm gibt die Veranstaltung vor."
    : "Steht links neben den Streams. Programmpunkte dürfen sich überschneiden und blockieren keine Streamzeit.";

  skEl("modal-programm").classList.add("aktiv");
  if (typeof dlgFokusRein === "function") dlgFokusRein("modal-programm");   // D-12, app.js
}

// Steht der Haken, sagt der Satz darunter, ob schon jemand sendet. Ohne das
// waere der Haken eine Zusage ohne Kontrolle – man setzt ihn und weiss weiter
// nicht, ob die Zeit belegt ist.
function skProgrammStreamerHinweis(punkt) {
  if (!punkt || !punkt.streamerNoetig) {
    return "Ohne Haken erscheint der Punkt als „kein Streamer“ und wird nicht angemahnt.";
  }
  if (!punkt.streamerFehlt) return "Für diese Zeit hat sich schon jemand eingetragen.";
  return "Noch " + skDauerLabel(punkt.offeneMinuten) + " ohne Stream – der Punkt steht als offen im Plan.";
}

function skFuelleProgrammZeiten(tag, von, bis) {
  const gewaehltVon = Math.min(Math.max(skZahlAus(von, tag.von), tag.von), tag.bis - SK_SCHRITT_UI);
  skFuelleZeiten(skEl("sk-prg-von"), tag.von, tag.bis - SK_SCHRITT_UI, gewaehltVon);
  const gewaehltBis = Math.min(Math.max(skZahlAus(bis, gewaehltVon + SK_SCHRITT_UI), gewaehltVon + SK_SCHRITT_UI), tag.bis);
  skFuelleZeiten(skEl("sk-prg-bis"), gewaehltVon + SK_SCHRITT_UI, tag.bis, gewaehltBis);
}

function skSchliesseProgrammDialog() {
  skEl("modal-programm").classList.remove("aktiv");
  if (typeof dlgFokusZurueck === "function") dlgFokusZurueck("modal-programm");   // D-12
  skProgrammDialogId = null;
  skProgrammNurLesen = false;
}

// ===========================================================================
// Events
// ===========================================================================

// ---------- Termine mit der Maus verschieben ----------
// ⚠️ BEWUSST NUR MIT DER MAUS (pointerType === "mouse"). Am Handy müsste der
// Block „touch-action: none" tragen, und dann liesse sich über dem Kalender
// nicht mehr scrollen – man käme an die unteren Stunden nicht mehr heran.
// Am Handy bleibt der Weg über den Dialog (Zeiten auswählen).
//
// ⚠️ Ein Klick MUSS weiterhin den Dialog öffnen. Deshalb gilt erst als
// Verschieben, wer sich mehr als SK_ZIEH_SCHWELLE Pixel bewegt hat; darunter
// läuft der normale Klick.
const SK_ZIEH_SCHWELLE = 4;
let skZiehen = null;

// ⚠️ Beim Ziehen wird auf 5 Minuten gerastet, NICHT auf die Viertelstunden der
// Auswahllisten. Mit 15 lag ein Zug um 25 Minuten bei 30 - das fuehlt sich an,
// als wuerde der Block der Maus nicht folgen.
const SK_ZIEH_SCHRITT = 5;
function skZiehRaster(minuten) {
  return Math.round(minuten / SK_ZIEH_SCHRITT) * SK_ZIEH_SCHRITT;
}

// Darf diese Person diesen Block verschieben? Gleiche Regel wie fürs Bearbeiten:
// der Dialog würde es sonst gleich wieder ablehnen.
function skZiehErlaubt(eintrag, istProgramm, z) {
  if (istProgramm) return !!z.istAdmin;
  return !!(eintrag && eintrag.darfBearbeiten);
}

function skZiehStart(e, knopf, istProgramm) {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  const z = streamService.getZustand();
  if (!z.vorhanden) return;

  const id = istProgramm ? knopf.dataset.programm : knopf.dataset.slot;
  const eintrag = (istProgramm ? z.programm : z.slots).find((x) => x.id === id);
  if (!skZiehErlaubt(eintrag, istProgramm, z)) return;

  const tag = z.tage.find((t) => t.datum === eintrag.datum);
  if (!tag) return;

  skZiehen = {
    knopf,
    id,
    istProgramm,
    eintrag,
    tag,
    // ⚠️ Die Bloecke werden gegen die ACHSE positioniert, nicht gegen den
    // Tagesbeginn (skBlockStil: top = skPx(von - achseVon)). Beginnt ein Tag
    // spaeter als die Achse, sind das zwei verschiedene Nullpunkte - der Block
    // sprang beim ersten Ziehen um die Differenz nach oben und lag danach
    // dauerhaft ueber dem Mauszeiger. Michel: "die Hand ist ein, zwei
    // Zentimeter unter dem Feld".
    achseVon: Math.floor(z.achseVon / 60) * 60,
    startY: e.clientY,
    startOben: parseFloat(knopf.style.top) || 0,
    bewegt: false,
  };
  knopf.setPointerCapture(e.pointerId);
}

function skZiehBewegung(e) {
  if (!skZiehen) return;
  const dy = e.clientY - skZiehen.startY;
  if (!skZiehen.bewegt && Math.abs(dy) < SK_ZIEH_SCHWELLE) return;
  skZiehen.bewegt = true;
  skZiehen.knopf.classList.add("zieht");

  // Pixel zurück in Minuten, auf das Viertelstunden-Raster gerundet.
  const dauer = skZiehen.eintrag.bis - skZiehen.eintrag.von;
  const rohVon = skZiehen.eintrag.von + (dy / SK_STUNDE_PX) * 60;
  let neuVon = skZiehRaster(rohVon);

  // Innerhalb des Tagesfensters bleiben – sonst landet der Block im Nichts.
  neuVon = Math.max(skZiehen.tag.von, Math.min(neuVon, skZiehen.tag.bis - dauer));
  skZiehen.neuVon = neuVon;
  skZiehen.knopf.style.top = skPx(neuVon - skZiehen.achseVon) + "px";

  const zeit = skZiehen.knopf.querySelector(".sk-slot-zeit");
  if (zeit) zeit.textContent = streamService.zeitLabel(neuVon) + "–" + streamService.zeitLabel(neuVon + dauer);
}

async function skZiehEnde(e) {
  const zieh = skZiehen;
  skZiehen = null;
  if (!zieh) return;
  try { zieh.knopf.releasePointerCapture(e.pointerId); } catch (err) { /* schon weg */ }
  zieh.knopf.classList.remove("zieht");
  // Merker fuer den gleich folgenden click: ein Verschieben ist kein Klick.
  if (zieh.bewegt) zieh.knopf.dataset.wurdeGezogen = "1";

  // Nicht wirklich bewegt: das war ein Klick, der Dialog übernimmt.
  if (!zieh.bewegt || zieh.neuVon === undefined || zieh.neuVon === zieh.eintrag.von) {
    zieh.knopf.style.top = zieh.startOben + "px";
    return;
  }

  const dauer = zieh.eintrag.bis - zieh.eintrag.von;
  const werte = {
    datum: zieh.eintrag.datum,
    von: zieh.neuVon,
    bis: zieh.neuVon + dauer,
    titel: zieh.eintrag.titel,
    notiz: zieh.eintrag.notiz,
  };
  if (!zieh.istProgramm) werte.streamer = zieh.eintrag.streamer;
  // ⚠️ Ohne diese Zeile macht skPruefeProgramm aus dem fehlenden Feld
  // „Streamer nötig“ (undefined !== false) – ein Zug würde den Haken still setzen.
  if (zieh.istProgramm) werte.streamerNoetig = zieh.eintrag.streamerNoetig !== false;

  const res = zieh.istProgramm
    ? await streamService.aendereProgramm(zieh.id, werte)
    : await streamService.aendereSlot(zieh.id, werte);

  if (!res.erfolg) {
    // ⚠️ Zurücksetzen ist Pflicht: sonst bleibt der Block optisch verschoben,
    // während gespeichert die alte Zeit steht – und niemand merkt es.
    zieh.knopf.style.top = zieh.startOben + "px";
    alert(res.fehler || "Verschieben hat nicht geklappt.");
    skRender(streamService.getZustand());
  }
  // Bei Erfolg zeichnet das Live-Update von Firebase ohnehin neu.
}

// Wird nach jedem Neuzeichnen des Kalenders aufgerufen – die Blöcke sind dann
// neue Elemente und tragen die alten Lauscher nicht mehr.
function skZiehAnbinden() {
  document.querySelectorAll("#sk-kalender [data-slot], #sk-kalender [data-programm]").forEach((k) => {
    const istProgramm = !!k.dataset.programm;
    k.addEventListener("pointerdown", (e) => skZiehStart(e, k, istProgramm));
    k.addEventListener("pointermove", skZiehBewegung);
    k.addEventListener("pointerup", skZiehEnde);
    k.addEventListener("pointercancel", skZiehEnde);
    // Ein echtes Verschieben darf den Dialog NICHT öffnen.
    k.addEventListener("click", (e) => {
      if (k.dataset.wurdeGezogen === "1") {
        e.stopImmediatePropagation();
        e.preventDefault();
        delete k.dataset.wurdeGezogen;
      }
    }, true);
  });
}

// ===========================================================================
// Tipp am Mauszeiger
// ---------------------------------------------------------------------------
// Ein 30-Minuten-Block ist 15 px hoch; Zeit, Titel und Notiz passen da nicht
// hinein und werden abgeschnitten. Der Tipp zeigt sie, ohne dass man den Block
// anklicken und den Dialog wieder schliessen muss.
// ===========================================================================
const SK_TIPP_ABSTAND = 14;   // Luft zwischen Zeiger und Kasten

function skTippInhalt(el) {
  const z = skZustand;
  if (!z || !z.vorhanden) return "";
  const prgId = el.getAttribute("data-programm");
  const e = prgId
    ? z.programm.find((p) => p.id === prgId)
    : z.slots.find((x) => x.id === el.getAttribute("data-slot"));
  if (!e) return "";

  const kopf = '<span class="t-zeit">' +
    escapeHtml(streamService.datumLabel(e.datum, false)) + " " +
    streamService.zeitLabel(e.von) + "–" + streamService.zeitLabel(e.bis) + "</span>";

  if (prgId) {
    // ⚠️ Der Streamer-Stand gehoert in den Tipp: am Block steht er nur im
    // Fehlt-Fall und auch dann abgeschnitten, sobald der Block kurz ist.
    const status = !e.streamerNoetig
      ? '<span class="t-status keiner">Kein Streamer nötig</span>'
      : e.streamerFehlt
        ? '<span class="t-status fehlt">Streamer fehlt – ' + skDauerLabel(e.offeneMinuten) + " offen</span>"
        : '<span class="t-status da">Streamer ist eingetragen</span>';
    return kopf +
      '<span class="t-name">' + escapeHtml(e.titel) + "</span>" +
      (e.notiz ? '<span class="t-zusatz">' + escapeHtml(e.notiz) + "</span>" : "") +
      status;
  }

  return kopf +
    '<span class="t-name">' + escapeHtml(e.streamer) + (e.istEigener ? " (du)" : "") + "</span>" +
    (e.titel ? '<span class="t-zusatz">' + escapeHtml(e.titel) + "</span>" : "") +
    (e.notiz ? '<span class="t-zusatz">' + escapeHtml(e.notiz) + "</span>" : "");
}

function skTippVerstecken() {
  const t = skEl("sk-tipp");
  if (t) t.hidden = true;
}

// ⚠️ Erst einblenden, DANN messen und setzen: an einem versteckten Element
// liefert getBoundingClientRect() eine Groesse von 0 und der Kasten landet
// beim ersten Erscheinen immer unten rechts, egal wo der Zeiger steht.
function skTippSetzen(x, y) {
  const t = skEl("sk-tipp");
  if (!t || t.hidden) return;
  const kasten = t.getBoundingClientRect();
  let links = x + SK_TIPP_ABSTAND;
  let oben = y + SK_TIPP_ABSTAND;
  if (links + kasten.width > window.innerWidth - 8) links = x - SK_TIPP_ABSTAND - kasten.width;
  if (oben + kasten.height > window.innerHeight - 8) oben = y - SK_TIPP_ABSTAND - kasten.height;
  t.style.left = Math.max(8, links) + "px";
  t.style.top = Math.max(8, oben) + "px";
}

function skTippAnbinden() {
  const kal = skEl("sk-kalender");
  const tipp = skEl("sk-tipp");
  if (!kal || !tipp) return;
  let aktiv = null;

  kal.addEventListener("mousemove", (e) => {
    // ⚠️ Waehrend eines Zuges bleibt der Tipp weg: er haengt sonst als Fahne am
    // Zeiger und verdeckt genau die Zeile, auf die gezogen wird.
    if (document.querySelector(".sk-slot.zieht")) { aktiv = null; skTippVerstecken(); return; }
    const block = e.target.closest(".sk-slot");
    if (!block) { aktiv = null; skTippVerstecken(); return; }
    if (block !== aktiv) {
      const inhalt = skTippInhalt(block);
      if (!inhalt) { aktiv = null; skTippVerstecken(); return; }
      aktiv = block;
      tipp.innerHTML = inhalt;
      tipp.hidden = false;
    }
    skTippSetzen(e.clientX, e.clientY);
  });

  // ⚠️ Zwei Ausstiege: die Maus kann den Kalender verlassen, und der Kalender
  // kann unter der stehenden Maus weggescrollt werden.
  kal.addEventListener("mouseleave", () => { aktiv = null; skTippVerstecken(); });
  kal.addEventListener("scroll", () => { aktiv = null; skTippVerstecken(); }, true);
  window.addEventListener("blur", () => { aktiv = null; skTippVerstecken(); });
}

function skWireEvents() {
  // Plan anlegen
  skEl("sk-btn-erstellen").addEventListener("click", async () => {
    const res = await streamService.erstellePlan({
      titel: skEl("sk-neu-titel").value,
      startDatum: skEl("sk-neu-start").value,
      anzahlTage: skEl("sk-neu-tage").value,
      von: skEl("sk-neu-von").value,
      bis: skEl("sk-neu-bis").value,
      adminPin: skEl("sk-neu-pin").value,
    }).catch((e) => ({ erfolg: false, fehler: "Anlegen hat nicht geklappt: " + ((e && e.message) || e) }));
    skZeigeFehler("sk-neu-fehler", res.erfolg ? "" : res.fehler);
  });

  // Tageswahl am Handy
  skEl("sk-tagchips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tag]");
    if (!btn || !skZustand) return;
    skAktiverTag = btn.getAttribute("data-tag");
    skRenderChips(skZustand);
    document.querySelectorAll("#sk-kalender .sk-tag").forEach((el) => {
      el.classList.toggle("aktiv", el.getAttribute("data-tag") === skAktiverTag);
    });
  });

  skEl("sk-btn-belegen").addEventListener("click", () => skOeffneDialog(null, null));

  skEl("sk-btn-programm").addEventListener("click", () => skOeffneProgrammDialog(null, null));

  // Klick in den Kalender: auf einen Block -> öffnen, auf freie Fläche -> neuer
  // Eintrag ab der angeklickten Viertelstunde. Welche der beiden Spuren getroffen
  // wurde, steht an der Fläche – links Programm, rechts Streams.
  skEl("sk-kalender").addEventListener("click", (e) => {
    const block = e.target.closest(".sk-slot");
    if (block) {
      const prg = block.getAttribute("data-programm");
      return prg ? skOeffneProgrammDialog(prg, null) : skOeffneDialog(block.getAttribute("data-slot"), null);
    }

    const flaeche = e.target.closest(".sk-tagflaeche");
    if (!flaeche || !skZustand) return;
    const datum = flaeche.getAttribute("data-tag");
    const tag = skTagVon(skZustand, datum);
    if (!tag) return;
    const achseVon = Math.floor(skZustand.achseVon / 60) * 60;
    const rechteck = flaeche.getBoundingClientRect();
    const minute = achseVon + ((e.clientY - rechteck.top) / SK_STUNDE_PX) * 60;
    const gerundet = Math.round(minute / SK_SCHRITT_UI) * SK_SCHRITT_UI;
    if (flaeche.getAttribute("data-spur") === "programm") skOeffneProgrammDialog(null, { datum, von: gerundet });
    else skOeffneDialog(null, { datum, von: gerundet });
  });

  // Liste: "Ändern"
  skEl("sk-liste").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-slot],[data-programm]");
    if (!btn) return;
    const prg = btn.getAttribute("data-programm");
    if (prg) skOeffneProgrammDialog(prg, null);
    else skOeffneDialog(btn.getAttribute("data-slot"), null);
  });

  // Programm-Dialog
  skEl("sk-prg-tag").addEventListener("change", () => {
    if (!skZustand) return;
    const tag = skTagVon(skZustand, skEl("sk-prg-tag").value);
    if (tag) skFuelleProgrammZeiten(tag, tag.von, tag.von + 120);
  });
  skEl("sk-prg-von").addEventListener("change", () => {
    if (!skZustand) return;
    const tag = skTagVon(skZustand, skEl("sk-prg-tag").value);
    if (!tag) return;
    const von = Number(skEl("sk-prg-von").value);
    const bisAlt = Number(skEl("sk-prg-bis").value);
    skFuelleZeiten(skEl("sk-prg-bis"), von + SK_SCHRITT_UI, tag.bis, Math.max(bisAlt, von + SK_SCHRITT_UI));
  });

  // ⚠️ Doppelklick-Sperre: Firebase bestätigt erst nach dem Netz, bis dahin
  // legte ein zweiter Klick einen zweiten Eintrag an (Bugjagd 25.09.d T5b).
  let prgLaeuft = false;
  skEl("sk-prg-speichern").addEventListener("click", async () => {
    if (prgLaeuft) return;
    prgLaeuft = true;
    skEl("sk-prg-speichern").disabled = true;
    try {
    const werte = {
      datum: skEl("sk-prg-tag").value,
      von: skEl("sk-prg-von").value,
      bis: skEl("sk-prg-bis").value,
      titel: skEl("sk-prg-was").value,
      notiz: skEl("sk-prg-notiz").value,
      streamerNoetig: skEl("sk-prg-streamer").checked,
    };
    const res = skProgrammDialogId
      ? await streamService.aendereProgramm(skProgrammDialogId, werte)
      : await streamService.legeProgrammAn(werte);
    if (res.erfolg) skSchliesseProgrammDialog();
    else skZeigeFehler("sk-prg-fehler", res.fehler);
    } finally {
      prgLaeuft = false;
      skEl("sk-prg-speichern").disabled = false;
    }
  });

  skEl("sk-prg-loeschen").addEventListener("click", async () => {
    if (!skProgrammDialogId) return;
    if (!confirm("Diesen Programmpunkt wirklich entfernen?")) return;
    const res = await streamService.loescheProgramm(skProgrammDialogId);
    if (res.erfolg) skSchliesseProgrammDialog();
    else skZeigeFehler("sk-prg-fehler", res.fehler);
  });

  skEl("sk-prg-abbrechen").addEventListener("click", skSchliesseProgrammDialog);
  skEl("modal-programm").addEventListener("click", (e) => {
    if (e.target.id === "modal-programm") skSchliesseProgrammDialog();
  });

  // Dialog: Tageswechsel füllt die Zeiten neu (jeder Tag hat sein eigenes Fenster)
  // ⚠️ Jede der drei Zeit-Auswahlen zieht den Parallel-Hinweis nach. Fehlt das
  // an einer, steht dort der Satz zur vorherigen Zeit - schlimmer als gar
  // keiner, weil er wie eine geprüfte Aussage aussieht.
  skEl("sk-dlg-tag").addEventListener("change", () => {
    if (!skZustand) return;
    const tag = skTagVon(skZustand, skEl("sk-dlg-tag").value);
    if (tag) skFuelleDialogZeiten(tag, tag.von, tag.von + 120);
    skAktualisiereParallelHinweis();
  });
  skEl("sk-dlg-von").addEventListener("change", () => {
    if (!skZustand) return;
    const tag = skTagVon(skZustand, skEl("sk-dlg-tag").value);
    if (!tag) return;
    const von = Number(skEl("sk-dlg-von").value);
    const bisAlt = Number(skEl("sk-dlg-bis").value);
    skFuelleZeiten(skEl("sk-dlg-bis"), von + SK_SCHRITT_UI, tag.bis, Math.max(bisAlt, von + SK_SCHRITT_UI));
    skAktualisiereParallelHinweis();
  });
  skEl("sk-dlg-bis").addEventListener("change", skAktualisiereParallelHinweis);

  let dlgLaeuft = false;   // Doppelklick-Sperre wie beim Programm
  skEl("sk-dlg-speichern").addEventListener("click", async () => {
    if (dlgLaeuft) return;
    dlgLaeuft = true;
    skEl("sk-dlg-speichern").disabled = true;
    try {
    const werte = {
      datum: skEl("sk-dlg-tag").value,
      von: skEl("sk-dlg-von").value,
      bis: skEl("sk-dlg-bis").value,
      streamer: skEl("sk-dlg-name").value,
      titel: skEl("sk-dlg-was").value,
      notiz: skEl("sk-dlg-notiz").value,
    };
    const res = skDialogSlotId
      ? await streamService.aendereSlot(skDialogSlotId, werte)
      : await streamService.belegeZeit(werte);
    if (res.erfolg) skSchliesseDialog();
    else skZeigeFehler("sk-dlg-fehler", res.fehler);
    } finally {
      dlgLaeuft = false;
      skEl("sk-dlg-speichern").disabled = false;
    }
  });

  skEl("sk-dlg-loeschen").addEventListener("click", async () => {
    if (!skDialogSlotId) return;
    if (!confirm("Diese Belegung wirklich entfernen?")) return;
    const res = await streamService.loescheSlot(skDialogSlotId);
    if (res.erfolg) skSchliesseDialog();
    else skZeigeFehler("sk-dlg-fehler", res.fehler);
  });

  skEl("sk-dlg-abbrechen").addEventListener("click", skSchliesseDialog);
  skEl("modal-stream").addEventListener("click", (e) => {
    if (e.target.id === "modal-stream") skSchliesseDialog();
  });

  // Veranstalter
  // ⚠️ await: die Pruefung laeuft seit 2026-09-15 ueber den Server. Ohne await
  // waere res ein Promise - und `res.erfolg` damit immer undefined.
  skEl("sk-btn-admin-anmelden").addEventListener("click", async () => {
    const res = await streamService.authentifiziereAlsAdmin(skEl("sk-admin-pin").value);
    skZeigeFehler("sk-admin-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) skEl("sk-admin-pin").value = "";
  });

  skEl("sk-fenster-liste").addEventListener("change", (e) => {
    const zeile = e.target && e.target.closest ? e.target.closest(".sk-fenster-zeile") : null;
    if (!zeile) return;
    skFensterEntwurf[zeile.getAttribute("data-tag")] = {
      von: zeile.querySelector(".sk-fenster-von").value,
      bis: zeile.querySelector(".sk-fenster-bis-sel").value,
    };
  });

  skEl("sk-btn-fenster-speichern").addEventListener("click", async () => {
    const liste = Array.prototype.map.call(
      skEl("sk-fenster-liste").querySelectorAll(".sk-fenster-zeile"),
      (zeile) => ({
        datum: zeile.getAttribute("data-tag"),
        von: zeile.querySelector(".sk-fenster-von").value,
        bis: zeile.querySelector(".sk-fenster-bis-sel").value,
      })
    );
    const res = await streamService.setzeTagesfenster(liste);
    skZeigeFehler("sk-admin-panel-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) {
      skFensterEntwurf = {};
      skZeigeFehler("sk-admin-panel-fehler", "Gespeichert.");
    }
  });

  skEl("sk-btn-leeren").addEventListener("click", async () => {
    if (!confirm("Alle eingetragenen Streams entfernen? Der Plan und die Zeitfenster bleiben stehen.")) return;
    const res = await streamService.leereBelegungen();
    skZeigeFehler("sk-admin-panel-fehler", res.erfolg ? "" : res.fehler);
  });

  skEl("sk-btn-plan-loeschen").addEventListener("click", async () => {
    if (!confirm("Den kompletten Streamplan löschen? Alle Einträge und die Zeitfenster sind dann weg. Das lässt sich nicht rückgängig machen.")) return;
    let res;
    try {
      res = await streamService.loeschePlan();
    } catch (e) {
      res = { erfolg: false, fehler: "Löschen hat nicht geklappt: " + ((e && e.message) || e) };
    }
    skZeigeFehler("sk-admin-panel-fehler", res.erfolg ? "" : res.fehler);
    // ⚠️ Die Warnung auf den Anlege-Schirm, nicht in den Admin-Kasten: der
    // verschwindet mit dem Plan, und die Meldung gleich mit.
    if (res.warnung) skZeigeFehler("sk-neu-fehler", res.warnung);
  });

  // Die Breitenklasse "sk-breit" setzt seit dem 05.09.2026 activateTab() in
  // app.js selbst — dort greift sie für JEDEN Weg in den Reiter, auch für den
  // Vorraum und den Rückfall bei Rechteverlust. Der frühere Klickhorcher an
  // dieser Stelle kannte nur den Weg über die Reiterleiste.
}

// --- Start ------------------------------------------------------------------
(function skInit() {
  skWireEvents();
  skTippAnbinden();
  // Ist der Stream-Tab schon beim Laden aktiv (Turnierteil ausgeblendet), muss
  // die Breite gleich stimmen – sonst käme sie erst beim ersten Tabklick.
  document.getElementById("app").classList.toggle(
    "sk-breit",
    document.getElementById("tab-stream").classList.contains("active")
  );
  // Auswahllisten des Anlege-Formulars: der ganze erlaubte Rahmen, Vorschlag
  // 10:00 bis 2:00 nachts – der übliche Zuschnitt eines LAN-Tages.
  skFuelleZeiten(skEl("sk-neu-von"), 0, 1440 - SK_SCHRITT_UI, 600);
  skFuelleZeiten(skEl("sk-neu-bis"), SK_SCHRITT_UI, streamService.MAX_BIS, 1560);
  streamService.onZustandsAenderung(skRender);
})();
