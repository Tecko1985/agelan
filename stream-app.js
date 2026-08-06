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
  skEl("sk-zeitraum").textContent = spanne + " · " + (belegt === 1 ? "1 Stream eingetragen" : belegt + " Streams eingetragen");

  skRenderChips(z);
  skRenderKalender(z);
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

  const spalten = z.tage.map((tag) => {
    const slots = z.slots.filter((s) => s.datum === tag.datum);
    skVerteileSpuren(slots);

    const gesperrt = [];
    if (tag.von > achseVon) {
      gesperrt.push('<div class="sk-gesperrt" style="top:0;height:' + skPx(tag.von - achseVon) + 'px"></div>');
    }
    if (tag.bis < achseBis) {
      gesperrt.push('<div class="sk-gesperrt" style="top:' + skPx(tag.bis - achseVon) + "px;height:" + skPx(achseBis - tag.bis) + 'px"></div>');
    }

    const bloecke = slots.map((s) => {
      const breite = 100 / s.spurAnzahl;
      const stil = [
        "top:" + skPx(s.von - achseVon) + "px",
        "height:" + Math.max(18, skPx(s.bis - s.von)) + "px",
        "left:" + (s.spur * breite) + "%",
        "width:calc(" + breite + "% - 4px)",
      ].join(";");
      const klassen = ["sk-slot"];
      if (s.istEigener) klassen.push("eigen");
      if (s.darfBearbeiten) klassen.push("bearbeitbar");
      const titel = s.titel ? '<span class="sk-slot-titel">' + escapeHtml(s.titel) + "</span>" : "";
      return '<button type="button" class="' + klassen.join(" ") + '" data-slot="' + s.id + '" style="' + stil + '">' +
        '<span class="sk-slot-zeit">' + streamService.zeitLabel(s.von) + "–" + streamService.zeitLabel(s.bis) + "</span>" +
        '<span class="sk-slot-name">' + escapeHtml(s.streamer) + "</span>" +
        titel +
        "</button>";
    });

    return '<div class="sk-tag' + (tag.datum === skAktiverTag ? " aktiv" : "") + '" data-tag="' + tag.datum + '">' +
      '<div class="sk-tagkopf">' + escapeHtml(tag.label) +
      '<span class="sk-tagzeit">' + streamService.zeitLabel(tag.von) + "–" + streamService.zeitLabel(tag.bis) + "</span></div>" +
      '<div class="sk-tagflaeche" data-tag="' + tag.datum + '" style="height:' + hoehe + "px;background-size:100% " + SK_STUNDE_PX + 'px">' +
      gesperrt.join("") + bloecke.join("") +
      "</div></div>";
  });

  skEl("sk-kalender").innerHTML =
    '<div class="sk-raster">' +
    '<div class="sk-zeitspalte"><div class="sk-tagkopf sk-zeitkopf"></div>' + marken.join("") + "</div>" +
    spalten.join("") +
    "</div>";
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
function skRenderListe(z) {
  const box = skEl("sk-liste");
  if (!z.slots.length) {
    box.innerHTML = '<p class="hinweis-text">Noch ist nichts belegt. Trag dich ein, wann du senden willst.</p>';
    return;
  }
  box.innerHTML = z.slots
    .map((s) => {
      const wer = escapeHtml(s.streamer) + (s.istEigener ? ' <span class="spieler-badge">(du)</span>' : "");
      const was = s.titel ? ' <span class="sk-zeile-titel">' + escapeHtml(s.titel) + "</span>" : "";
      const knopf = s.darfBearbeiten
        ? '<button type="button" class="mini-btn" data-slot="' + s.id + '">Ändern</button>'
        : "";
      return '<div class="sk-zeile">' +
        '<span class="sk-zeile-zeit">' + escapeHtml(streamService.datumLabel(s.datum, false)) + " " +
        streamService.zeitLabel(s.von) + "–" + streamService.zeitLabel(s.bis) + "</span>" +
        '<span class="sk-zeile-wer">' + wer + was + "</span>" +
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
  const z = skZustand;
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
// Events
// ===========================================================================
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

  // Klick in den Kalender: auf einen Block -> öffnen, auf freie Fläche ->
  // neue Belegung ab der angeklickten Viertelstunde.
  skEl("sk-kalender").addEventListener("click", (e) => {
    const block = e.target.closest(".sk-slot");
    if (block) return skOeffneDialog(block.getAttribute("data-slot"), null);

    const flaeche = e.target.closest(".sk-tagflaeche");
    if (!flaeche || !skZustand) return;
    const datum = flaeche.getAttribute("data-tag");
    const tag = skTagVon(skZustand, datum);
    if (!tag) return;
    const achseVon = Math.floor(skZustand.achseVon / 60) * 60;
    const rechteck = flaeche.getBoundingClientRect();
    const minute = achseVon + ((e.clientY - rechteck.top) / SK_STUNDE_PX) * 60;
    const gerundet = Math.round(minute / SK_SCHRITT_UI) * SK_SCHRITT_UI;
    skOeffneDialog(null, { datum, von: gerundet });
  });

  // Liste: "Ändern"
  skEl("sk-liste").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-slot]");
    if (btn) skOeffneDialog(btn.getAttribute("data-slot"), null);
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
