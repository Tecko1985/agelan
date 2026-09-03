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

const SK_STUNDE_PX = 48;      // Höhe einer Stunde im Raster; einzige Quelle für Höhe und Stundenlinien
const SK_SCHRITT_UI = 15;

let skZustand = null;
let skAktiverTag = null;      // Datum des am Handy sichtbaren Tages
let skDialogSlotId = null;    // null = neue Belegung, sonst die bearbeitete
let skDialogNurLesen = false;
let skProgrammDialogId = null;
let skProgrammNurLesen = false;

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
  for (let m = von; m <= bis; m += SK_SCHRITT_UI) {
    teile.push('<option value="' + m + '">' + streamService.zeitLabelLang(m) + "</option>");
  }
  select.innerHTML = teile.join("");
  if (wert != null) select.value = String(wert);
  if (!select.value && select.options.length) select.selectedIndex = 0;
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
    const heute = streamService.heuteIso();
    skAktiverTag = (skTagVon(z, heute) ? heute : z.tage[0].datum);
  }
  skZeigeView("sk-plan");
  skRenderPlan(z);
}

function skRenderKeinPlan(z) {
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
  skEl("sk-zeitraum").textContent = spanne + " · " +
    (belegt === 1 ? "1 Stream" : belegt + " Streams") + " · " +
    (prg === 1 ? "1 Programmpunkt" : prg + " Programmpunkte");

  // Das Programm gibt die Veranstaltung vor – anlegen darf es nur der Veranstalter.
  skEl("sk-btn-programm").style.display = z.istAdmin ? "" : "none";
  // ⚠️ Der Knopf verschwindet fuer alle ohne Streamer-Freigabe. Ein sichtbarer
  // Knopf, der nur in eine Fehlermeldung fuehrt, ist schlechter als keiner -
  // die Schranke selbst sitzt im Service, nicht hier.
  skEl("sk-btn-belegen").style.display = z.darfEintragen ? "" : "none";

  skRenderChips(z);
  skRenderKalender(z);
  skZiehAnbinden();
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
    '<div class="sk-zeitspalte"><div class="sk-tagkopf sk-zeitkopf"></div>' +
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
    "left:" + (eintrag.spur * breite) + "%",
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

function skProgrammBlock(p, achseVon) {
  return '<button type="button" class="sk-slot programm' + (p.kettenZweiter ? " kette" : "") + '" data-programm="' + p.id + '" style="' + skBlockStil(p, achseVon) + '">' +
    '<span class="sk-slot-zeit">' + streamService.zeitLabel(p.von) + "–" + streamService.zeitLabel(p.bis) + "</span>" +
    '<span class="sk-slot-name">' + escapeHtml(p.titel) + "</span>" +
    "</button>";
}

function skPx(minuten) {
  return Math.round((minuten / 60) * SK_STUNDE_PX);
}

// Überschneidungen sind beim Speichern gesperrt, können aber entstehen, wenn
// zwei Leute im selben Moment auf dieselbe Zeit speichern. Dann sollen die
// Blöcke nebeneinander stehen statt sich gegenseitig zu verdecken.
function skVerteileSpuren(slots) {
  const spurEnde = [];
  slots.forEach((s) => {
    let spur = spurEnde.findIndex((ende) => ende <= s.von);
    if (spur === -1) {
      spurEnde.push(s.bis);
      spur = spurEnde.length - 1;
    } else {
      spurEnde[spur] = s.bis;
    }
    s.spur = spur;
  });
  const anzahl = Math.max(1, spurEnde.length);
  slots.forEach((s) => { s.spurAnzahl = anzahl; });
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
        ? escapeHtml(e.titel)
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
    skFuelleZeiten(zeile.querySelector(".sk-fenster-von"), 0, 1440 - SK_SCHRITT_UI, t.von);
    skFuelleZeiten(zeile.querySelector(".sk-fenster-bis-sel"), SK_SCHRITT_UI, streamService.MAX_BIS, t.bis);
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
  skDialogSlotId = slot ? slot.id : null;
  skDialogNurLesen = !!slot && !slot.darfBearbeiten;

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
  skEl("sk-dlg-hinweis").textContent = skDialogNurLesen
    ? "Diesen Eintrag hat jemand anders gemacht."
    : "Es sendet immer nur einer – überschneidende Zeiten nimmt der Plan nicht an.";

  skEl("modal-stream").classList.add("aktiv");
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

  ["sk-prg-tag", "sk-prg-von", "sk-prg-bis", "sk-prg-was", "sk-prg-notiz"].forEach((id) => {
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
}

function skFuelleProgrammZeiten(tag, von, bis) {
  const gewaehltVon = Math.min(Math.max(skZahlAus(von, tag.von), tag.von), tag.bis - SK_SCHRITT_UI);
  skFuelleZeiten(skEl("sk-prg-von"), tag.von, tag.bis - SK_SCHRITT_UI, gewaehltVon);
  const gewaehltBis = Math.min(Math.max(skZahlAus(bis, gewaehltVon + SK_SCHRITT_UI), gewaehltVon + SK_SCHRITT_UI), tag.bis);
  skFuelleZeiten(skEl("sk-prg-bis"), gewaehltVon + SK_SCHRITT_UI, tag.bis, gewaehltBis);
}

function skSchliesseProgrammDialog() {
  skEl("modal-programm").classList.remove("aktiv");
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

function skZiehRaster(minuten) {
  return Math.round(minuten / SK_SCHRITT_UI) * SK_SCHRITT_UI;
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
  skZiehen.knopf.style.top = skPx(neuVon - skZiehen.tag.von) + "px";

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
    });
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

  skEl("sk-prg-speichern").addEventListener("click", async () => {
    const werte = {
      datum: skEl("sk-prg-tag").value,
      von: skEl("sk-prg-von").value,
      bis: skEl("sk-prg-bis").value,
      titel: skEl("sk-prg-was").value,
      notiz: skEl("sk-prg-notiz").value,
    };
    const res = skProgrammDialogId
      ? await streamService.aendereProgramm(skProgrammDialogId, werte)
      : await streamService.legeProgrammAn(werte);
    if (res.erfolg) skSchliesseProgrammDialog();
    else skZeigeFehler("sk-prg-fehler", res.fehler);
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
  skEl("sk-dlg-tag").addEventListener("change", () => {
    if (!skZustand) return;
    const tag = skTagVon(skZustand, skEl("sk-dlg-tag").value);
    if (tag) skFuelleDialogZeiten(tag, tag.von, tag.von + 120);
  });
  skEl("sk-dlg-von").addEventListener("change", () => {
    if (!skZustand) return;
    const tag = skTagVon(skZustand, skEl("sk-dlg-tag").value);
    if (!tag) return;
    const von = Number(skEl("sk-dlg-von").value);
    const bisAlt = Number(skEl("sk-dlg-bis").value);
    skFuelleZeiten(skEl("sk-dlg-bis"), von + SK_SCHRITT_UI, tag.bis, Math.max(bisAlt, von + SK_SCHRITT_UI));
  });

  skEl("sk-dlg-speichern").addEventListener("click", async () => {
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
  skEl("sk-btn-admin-anmelden").addEventListener("click", () => {
    const res = streamService.authentifiziereAlsAdmin(skEl("sk-admin-pin").value);
    skZeigeFehler("sk-admin-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) skEl("sk-admin-pin").value = "";
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
    if (res.erfolg) skZeigeFehler("sk-admin-panel-fehler", "Gespeichert.");
  });

  skEl("sk-btn-leeren").addEventListener("click", async () => {
    if (!confirm("Alle eingetragenen Streams entfernen? Der Plan und die Zeitfenster bleiben stehen.")) return;
    const res = await streamService.leereBelegungen();
    skZeigeFehler("sk-admin-panel-fehler", res.erfolg ? "" : res.fehler);
  });

  skEl("sk-btn-plan-loeschen").addEventListener("click", async () => {
    if (!confirm("Den kompletten Streamplan löschen? Alle Einträge und die Zeitfenster sind dann weg. Das lässt sich nicht rückgängig machen.")) return;
    const res = await streamService.loeschePlan();
    skZeigeFehler("sk-admin-panel-fehler", res.erfolg ? "" : res.fehler);
  });

  // Der Kalender braucht mehr Breite als die 560px der Turnier-Screens.
  // Über eine Klasse am Container statt über :has(), das auf älteren iPhones fehlt.
  document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => {
    b.addEventListener("click", () => {
      document.getElementById("app").classList.toggle("sk-breit", b.dataset.tab === "stream");
    });
  });
}

// --- Start ------------------------------------------------------------------
(function skInit() {
  skWireEvents();
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
