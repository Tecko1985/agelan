// ===========================================================================
// fruehstueck-app.js – Screens, Rendering, Events für die Frühstücksbestellung.
// Redet nur über fruehstueckService. escapeHtml() kommt aus app.js (globaler
// Scope) – Namen, Paketnamen, Beschreibungen und Notizen sind Firebase-Fremd-
// eingaben und werden vor jedem innerHTML damit escaped.
// ===========================================================================

let frZustand = null;
let frAktiverTag = null;          // Datum des gerade angezeigten Morgens
let frEntwurf = null;             // { positionen:{pid:anzahl}, notiz } – laufende Bestellung vor dem Speichern
let frBearbeitetesPaketId = null; // null = "Neues Paket"-Formular legt an, sonst bearbeitet es dieses Paket
// ⚠️ Wer beim Kassieren eine Zeile abhakt, loest ein Live-Update aus und die
// Liste wird neu gezeichnet. Ohne dieses Merken klappte die Person dabei jedes
// Mal wieder zu – genau bei der Taetigkeit, fuer die die Liste da ist.
const frOffenePersonen = new Set();

function frEl(id) {
  return document.getElementById(id);
}

function frZeigeFehler(id, text) {
  const el = frEl(id);
  if (el) el.textContent = text || "";
}

function frZeigeView(id) {
  document.querySelectorAll("#tab-fruehstueck .sk-view").forEach((v) => v.classList.toggle("aktiv", v.id === id));
}

// Zeit "HH:MM" <-> Minuten seit 0:00. <input type="time"> liefert/braucht die
// Textform; das Datenmodell rechnet in Minuten wie beim Streamkalender.
function frZeitInputWert(minuten) {
  return fruehstueckService.zeitLabel(minuten);
}
function frMinutenAusZeitInput(wert, ersatz) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(wert || ""));
  if (!m) return ersatz;
  return Math.min(1439, Number(m[1]) * 60 + Number(m[2]));
}

// --- Hauptrender -------------------------------------------------------------
function frRender(z) {
  frZustand = z;
  if (!z.vorhanden) {
    frZeigeView("fr-kein-plan");
    return;
  }
  frZeigeView("fr-plan");

  frEl("fr-titel").textContent = z.meta.titel;
  frEl("fr-zeitraum").textContent = z.tage.length
    ? fruehstueckService.datumLabel(z.tage[0].datum, true) + (z.tage.length > 1 ? " – " + fruehstueckService.datumLabel(z.tage[z.tage.length - 1].datum, true) : "")
    : "";

  // Aktiven Tag festlegen: der zuletzt gewählte, sonst der erste noch offene,
  // sonst einfach der erste Morgen des Plans.
  if (!frAktiverTag || !z.tage.some((t) => t.datum === frAktiverTag)) {
    const offener = z.tage.find((t) => t.offen);
    frAktiverTag = (offener || z.tage[0] || {}).datum || null;
  }

  frRenderChips(z);
  frRenderTagInhalt(z);
  frRenderAdmin(z);
}

function frRenderChips(z) {
  const box = frEl("fr-tagchips");
  box.innerHTML = z.tage.map((t) => `
    <button class="sk-chip${t.datum === frAktiverTag ? " aktiv" : ""}" data-datum="${t.datum}">
      ${escapeHtml(t.label)}${t.vorbei ? " · zu" : ""}
    </button>`).join("");
  box.querySelectorAll("button[data-datum]").forEach((b) => {
    b.addEventListener("click", () => {
      frAktiverTag = b.dataset.datum;
      frEntwurf = null;
      frRenderChips(z);
      frRenderTagInhalt(z);
    });
  });
}

// Kurzform des gespeicherten Standes. Damit laesst sich erkennen, ob sich die
// Bestellung in Firebase geaendert hat, seit der Entwurf gebaut wurde.
function frBestellSchluessel(b) {
  if (!b) return "";
  return b.positionen.map((p) => p.paketId + ":" + p.anzahl).sort().join("|") + "#" + (b.notiz || "");
}

// Der Name des angemeldeten Kontos, falls eines da ist. Sonst leer - dann
// greift wie bisher das Eingabefeld.
function frFesterName() {
  try {
    const k = window.__AGELAN_KONTO__;
    return (k && k.nickname) || "";
  } catch (e) {
    return "";
  }
}

function frStarteEntwurf(tag) {
  const positionen = {};
  (tag.meineBestellung ? tag.meineBestellung.positionen : []).forEach((p) => { positionen[p.paketId] = p.anzahl; });
  frEntwurf = {
    positionen,
    notiz: tag.meineBestellung ? tag.meineBestellung.notiz : "",
    // Erst wenn jemand wirklich etwas angefasst hat, ist der Entwurf schuetzenswert.
    beruehrt: false,
    stand: frBestellSchluessel(tag.meineBestellung),
  };
}

// ⚠️ Der Entwurf darf eine laufende Eingabe nicht ueberschreiben – er darf aber
// auch nicht auf einem veralteten Stand haengen bleiben. Genau das ist passiert:
// beim ersten Rendern stand die anonyme Firebase-Kennung noch nicht fest, die
// eigene Bestellung galt als "nicht vorhanden", der Entwurf wurde leer gebaut
// und zog danach nie nach. Wer schon bestellt hatte, sah lauter Nullen – und
// "Bestellung aktualisieren" haette sie geloescht.
function frEntwurfAuffrischen(tag) {
  if (!frEntwurf) { frStarteEntwurf(tag); return; }
  if (frEntwurf.beruehrt) return;                    // jemand tippt gerade
  const jetzt = frBestellSchluessel(tag.meineBestellung);
  if (jetzt !== frEntwurf.stand) frStarteEntwurf(tag);
}

function frRenderTagInhalt(z) {
  const box = frEl("fr-tag-inhalt");
  const tag = z.tage.find((t) => t.datum === frAktiverTag);
  if (!tag) { box.innerHTML = ""; return; }

  frEntwurfAuffrischen(tag);

  const bearbeitbar = tag.offen || z.istAdmin;
  const stueckGesamt = Object.values(frEntwurf.positionen).reduce((s, n) => s + (n || 0), 0);
  const summeCent = z.pakete.reduce((s, p) => s + p.preisCent * (frEntwurf.positionen[p.id] || 0), 0);

  const paketeHtml = z.pakete.length
    ? z.pakete.map((p) => {
        const anzahl = frEntwurf.positionen[p.id] || 0;
        return `
        <div class="fr-paket">
          <div class="fr-paket-info">
            <div class="fr-paket-name">${escapeHtml(p.name)}</div>
            ${p.beschreibung ? `<div class="fr-paket-beschreibung">${escapeHtml(p.beschreibung)}</div>` : ""}
            <div class="fr-paket-preis">${p.preisCent ? fruehstueckService.centLabel(p.preisCent) : "kostenlos"}</div>
          </div>
          <div class="fr-stepper">
            <button type="button" data-fr-weniger="${p.id}" ${!bearbeitbar || anzahl <= 0 ? "disabled" : ""}>−</button>
            <span class="fr-stepper-zahl">${anzahl}</span>
            <button type="button" data-fr-mehr="${p.id}" ${!bearbeitbar || anzahl >= fruehstueckService.MAX_STUECK ? "disabled" : ""}>+</button>
          </div>
        </div>`;
      }).join("")
    : `<p class="fr-leer-hinweis">Noch keine Pakete angelegt.</p>`;

  const eigeneAnzeige = tag.meineBestellung
    ? `<p class="fr-eigene-hinweis">Deine Bestellung ist gespeichert${tag.meineBestellung.abgeholt ? " – als abgeholt markiert" : ""}.</p>`
    : "";

  box.innerHTML = `
    <div class="fr-tagkarte">
      <h3>${escapeHtml(tag.tagLang)}, ${escapeHtml(tag.label)}</h3>
      <p class="fr-schluss${tag.vorbei ? " zu" : ""}">${tag.offen ? "Bestellschluss: " : "Bestellschluss war: "}${escapeHtml(tag.schlussLabel)}</p>

      ${!bearbeitbar ? `<p class="hinweis-text">Für diesen Morgen ist der Bestellschluss vorbei.</p>` : ""}

      ${paketeHtml}

      <div class="fr-summe-zeile">
        <span>${stueckGesamt ? stueckGesamt + " Stück" : '<span class="fr-summe-leer">Nichts ausgewählt</span>'}</span>
        <span>${summeCent ? fruehstueckService.centLabel(summeCent) : ""}</span>
      </div>

      ${bearbeitbar && z.pakete.length ? `
        ${frFesterName()
          // ⚠️ Angemeldet heißt: der Name steht fest. Ein Eingabefeld wäre nicht
          // nur überflüssig, es ließe auch Bestellungen unter fremdem Namen zu –
          // und genau der Name ist der Schlüssel der Abrechnung.
          ? `<p class="fr-besteller">Bestellung für <b>${escapeHtml(frFesterName())}</b></p>`
          : `<label class="feld-label" for="fr-best-name">Dein Name</label>
             <input type="text" id="fr-best-name" class="eingabe" maxlength="40" autocomplete="off" value="${escapeHtml(frEntwurf.name != null ? frEntwurf.name : (tag.meineBestellung ? tag.meineBestellung.name : fruehstueckService.getGespeicherterName()))}">`}

        <label class="feld-label" for="fr-best-notiz">Notiz (freiwillig)</label>
        <input type="text" id="fr-best-notiz" class="eingabe" maxlength="200" autocomplete="off" placeholder="z. B. ohne Milch" value="${escapeHtml(frEntwurf.notiz || "")}">

        <button class="btn btn-primary btn-grow" id="fr-btn-bestellen">${tag.meineBestellung ? "Bestellung aktualisieren" : "Bestellen"}</button>
        ${tag.meineBestellung ? `<button class="btn btn-link" id="fr-btn-stornieren">Bestellung stornieren</button>` : ""}
        <p class="hinweis-text fehler" id="fr-best-fehler"></p>
      ` : ""}

      ${eigeneAnzeige}

      <p class="hinweis-text">${tag.anzahlBesteller ? tag.anzahlBesteller + " Person" + (tag.anzahlBesteller === 1 ? " hat" : "en haben") + " bestellt, " + tag.stueckGesamt + " Stück insgesamt." : "Noch niemand hat für diesen Morgen bestellt."}</p>
    </div>

    ${z.istAdmin ? frEinkaufslisteHtml(tag, z.pakete) + frBestellerlisteHtml(tag) + frAbrechnungHtml(z) : ""}
  `;

  box.querySelectorAll("[data-fr-mehr]").forEach((b) => b.addEventListener("click", () => frAendereEntwurf(b.dataset.frMehr, 1)));
  box.querySelectorAll("[data-fr-weniger]").forEach((b) => b.addEventListener("click", () => frAendereEntwurf(b.dataset.frWeniger, -1)));

  const nameEl = frEl("fr-best-name");
  if (nameEl) nameEl.addEventListener("input", () => { frEntwurf.name = nameEl.value; frEntwurf.beruehrt = true; });
  const notizEl = frEl("fr-best-notiz");
  if (notizEl) notizEl.addEventListener("input", () => { frEntwurf.notiz = notizEl.value; frEntwurf.beruehrt = true; });

  const btnBestellen = frEl("fr-btn-bestellen");
  if (btnBestellen) btnBestellen.addEventListener("click", () => frSpeichereBestellung(tag));
  const btnStorno = frEl("fr-btn-stornieren");
  if (btnStorno) btnStorno.addEventListener("click", () => frStorniereBestellung(tag));

  frWireAbholButtons();
}

function frAendereEntwurf(paketId, delta) {
  const bisher = frEntwurf.positionen[paketId] || 0;
  const neu = Math.max(0, Math.min(fruehstueckService.MAX_STUECK, bisher + delta));
  frEntwurf.positionen = Object.assign({}, frEntwurf.positionen, { [paketId]: neu });
  frEntwurf.beruehrt = true;
  frRenderTagInhalt(frZustand);
}

async function frSpeichereBestellung(tag) {
  // Angemeldet: der Konto-Name gilt, egal was in einem Feld stehen könnte.
  const name = frFesterName()
    || (frEntwurf.name != null ? frEntwurf.name : (tag.meineBestellung ? tag.meineBestellung.name : fruehstueckService.getGespeicherterName()));
  const res = await fruehstueckService.bestelle(tag.datum, {
    name,
    positionen: frEntwurf.positionen,
    notiz: frEntwurf.notiz || "",
  });
  if (!res.erfolg) { frZeigeFehler("fr-best-fehler", res.fehler); return; }
  frEntwurf = null;
}

async function frStorniereBestellung(tag) {
  if (!confirm("Deine Bestellung für " + tag.tagLang + " wirklich entfernen?")) return;
  const res = await fruehstueckService.storniere(tag.datum);
  if (!res.erfolg) { frZeigeFehler("fr-best-fehler", res.fehler); return; }
  frEntwurf = null;
}

// --- Admin: Einkaufsliste + Bestellerliste je Tag ---------------------------
function frEinkaufslisteHtml(tag, pakete) {
  const zeilen = pakete
    .map((p) => ({ name: p.name, anzahl: tag.gesamt[p.id] || 0 }))
    .filter((z) => z.anzahl > 0);
  if (!zeilen.length) return "";
  return `
    <div class="karte-block">
      <p class="feld-label">Einkaufsliste – ${escapeHtml(tag.tagLang)}</p>
      <div class="fr-einkaufsliste">
        ${zeilen.map((z) => `<div class="fr-einkauf-zeile"><span>${escapeHtml(z.name)}</span><b>${z.anzahl}×</b></div>`).join("")}
      </div>
    </div>`;
}

function frBestellerlisteHtml(tag) {
  if (!tag.bestellungen.length) return "";
  return `
    <div class="karte-block">
      <p class="feld-label">Bestellungen – ${escapeHtml(tag.tagLang)}</p>
      ${tag.bestellungen.map((b) => `
        <div class="fr-liste-eintrag${b.abgeholt ? " abgeholt" : ""}">
          <div style="flex:1 1 auto; min-width:0">
            <div class="fr-liste-name">${escapeHtml(b.name)}<span class="fr-liste-summe">${fruehstueckService.centLabel(b.summeCent)}</span></div>
            <div class="fr-liste-positionen">${b.positionen.map((p) =>
              p.anzahl + "× " + escapeHtml(p.name) + (p.preisCent ? " (" + fruehstueckService.centLabel(p.summeCent) + ")" : "")
            ).join(", ")}</div>
            ${b.notiz ? `<div class="fr-liste-notiz">${escapeHtml(b.notiz)}</div>` : ""}
          </div>
          <div class="fr-liste-haken">
            <label class="fr-liste-abholen">
              <input type="checkbox" data-fr-abgeholt="${tag.datum}|${b.uid}" ${b.abgeholt ? "checked" : ""}>
              abgeholt
            </label>
            <label class="fr-liste-abholen">
              <input type="checkbox" data-fr-bezahlt="${tag.datum}|${b.uid}" ${b.bezahlt ? "checked" : ""}>
              bezahlt
            </label>
          </div>
        </div>`).join("")}
      <div class="fr-summe-zeile">
        <span>${tag.stueckGesamt} Stück</span>
        <span>${fruehstueckService.centLabel(tag.summeCentGesamt)}</span>
      </div>
    </div>`;
}

// Abrechnung über alle Morgen: die Liste, mit der kassiert wird.
function frAbrechnungHtml(z) {
  if (!z.abrechnung.length) return "";
  return `
    <div class="karte-block">
      <p class="feld-label">Abrechnung – alle Morgen zusammen</p>
      ${z.abrechnung.map((person) => `
        <details class="fr-abr-person${person.offenCent ? "" : " bezahlt"}" data-fr-person="${escapeHtml(person.name)}"${frOffenePersonen.has(person.name) ? " open" : ""}>
          <summary>
            <span class="fr-abr-name">${escapeHtml(person.name)}</span>
            <span class="fr-abr-betrag">
              ${person.offenCent
                ? `<b>${fruehstueckService.centLabel(person.offenCent)}</b> offen`
                : `<span class="fr-abr-ok">bezahlt</span>`}
            </span>
          </summary>
          <div class="fr-abr-zeilen">
            ${person.zeilen.map((zeile) => `
              <label class="fr-abr-zeile${zeile.bezahlt ? " bezahlt" : ""}">
                <input type="checkbox" data-fr-bezahlt="${zeile.datum}|${zeile.uid}" ${zeile.bezahlt ? "checked" : ""}>
                <span class="fr-abr-tag">${escapeHtml(zeile.label)}</span>
                <span class="fr-abr-was">${zeile.positionen.map((p) => p.anzahl + "× " + escapeHtml(p.name)).join(", ")}</span>
                <span class="fr-abr-preis">${fruehstueckService.centLabel(zeile.summeCent)}</span>
              </label>`).join("")}
            <div class="fr-abr-gesamt">Gesamt: ${fruehstueckService.centLabel(person.summeCent)}</div>
          </div>
        </details>`).join("")}
      <div class="fr-summe-zeile">
        <span>Noch offen</span>
        <span>${fruehstueckService.centLabel(z.offenGesamtCent)} von ${fruehstueckService.centLabel(z.summeGesamtCent)}</span>
      </div>
    </div>`;
}

function frWireAbholButtons() {
  document.querySelectorAll("[data-fr-abgeholt]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const [datum, uid] = cb.dataset.frAbgeholt.split("|");
      fruehstueckService.setzeAbgeholt(datum, uid, cb.checked);
    });
  });
  document.querySelectorAll("[data-fr-bezahlt]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const [datum, uid] = cb.dataset.frBezahlt.split("|");
      fruehstueckService.setzeBezahlt(datum, uid, cb.checked);
    });
  });
  document.querySelectorAll("[data-fr-person]").forEach((d) => {
    d.addEventListener("toggle", () => {
      const name = d.dataset.frPerson;
      if (d.open) frOffenePersonen.add(name);
      else frOffenePersonen.delete(name);
    });
  });
}

// --- Anlegen -----------------------------------------------------------------

// „3 Tage" sagt niemandem, welche Tage das sind – und „Morgen" als Feldname war
// von „morgen" (dem Tag nach heute) nicht zu unterscheiden. Deshalb rechnet die
// Eingabe hier sofort in echte Tage um.
function frAktualisiereVorschau() {
  const ziel = frEl("fr-neu-vorschau");
  if (!ziel) return;
  const start = frEl("fr-neu-start").value;
  const anzahl = Math.round(Number(frEl("fr-neu-tage").value));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !(anzahl >= 1 && anzahl <= fruehstueckService.MAX_TAGE)) {
    ziel.textContent = "";
    return;
  }
  const tage = [];
  for (let i = 0; i < anzahl; i++) tage.push(fruehstueckService.datumLabel(fruehstueckService.datumPlus(start, i)));
  // Kein Satzpunkt am Ende: die Datumskürzel enden selbst schon auf einen Punkt
  // („So 6.9.") und es stünden sonst zwei nebeneinander.
  ziel.textContent = "Frühstück gibt es an " + anzahl + " Morgen: " + tage.join(", ");
}

async function frErstellePlan() {
  const titel = frEl("fr-neu-titel").value;
  const startDatum = frEl("fr-neu-start").value;
  const anzahlTage = frEl("fr-neu-tage").value;
  const schlussUhr = frMinutenAusZeitInput(frEl("fr-neu-schluss").value, fruehstueckService.STANDARD_SCHLUSS);
  const adminPin = frEl("fr-neu-pin").value;

  const res = await fruehstueckService.erstellePlan({ titel, startDatum, anzahlTage, schlussUhr, adminPin });
  if (!res.erfolg) { frZeigeFehler("fr-neu-fehler", res.fehler); return; }
  frZeigeFehler("fr-neu-fehler", "");
}

// --- Admin-Anmeldung ---------------------------------------------------------
function frRenderAdmin(z) {
  frEl("fr-admin-login").style.display = z.istAdmin ? "none" : "";
  frEl("fr-admin-panel").style.display = z.istAdmin ? "" : "none";
  if (!z.istAdmin) return;

  frEl("fr-ein-tage").value = z.meta.anzahlTage;
  frEl("fr-ein-schluss").value = frZeitInputWert(z.meta.schlussUhr);

  frRenderPaketeVerwalten(z);
}

function frRenderPaketeVerwalten(z) {
  const box = frEl("fr-pakete-verwalten");
  box.innerHTML = z.pakete.length
    ? z.pakete.map((p, i) => `
        <div class="fr-paket-verwalten">
          <div class="fr-pv-info">
            <div class="fr-pv-name">${escapeHtml(p.name)}</div>
            <div class="fr-pv-preis">${p.preisCent ? fruehstueckService.centLabel(p.preisCent) : "kostenlos"}${p.beschreibung ? " · " + escapeHtml(p.beschreibung) : ""}</div>
          </div>
          <div class="fr-pv-aktionen">
            <button type="button" class="mini-btn" data-fr-hoch="${p.id}" ${i === 0 ? "disabled" : ""}>▲</button>
            <button type="button" class="mini-btn" data-fr-runter="${p.id}" ${i === z.pakete.length - 1 ? "disabled" : ""}>▼</button>
            <button type="button" class="mini-btn" data-fr-bearbeiten="${p.id}">✎</button>
            <button type="button" class="mini-btn" data-fr-loeschen="${p.id}">🗑</button>
          </div>
        </div>`).join("")
    : `<p class="fr-leer-hinweis">Noch keine Pakete.</p>`;

  box.querySelectorAll("[data-fr-hoch]").forEach((b) => b.addEventListener("click", () => fruehstueckService.verschiebePaket(b.dataset.frHoch, -1)));
  box.querySelectorAll("[data-fr-runter]").forEach((b) => b.addEventListener("click", () => fruehstueckService.verschiebePaket(b.dataset.frRunter, 1)));
  box.querySelectorAll("[data-fr-loeschen]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Dieses Paket wirklich löschen? Bestehende Bestellungen dieses Pakets fallen dabei weg.")) return;
    await fruehstueckService.loeschePaket(b.dataset.frLoeschen);
  }));
  box.querySelectorAll("[data-fr-bearbeiten]").forEach((b) => b.addEventListener("click", () => {
    const p = frZustand.pakete.find((x) => x.id === b.dataset.frBearbeiten);
    if (!p) return;
    frBearbeitetesPaketId = p.id;
    frEl("fr-pak-name").value = p.name;
    frEl("fr-pak-beschreibung").value = p.beschreibung;
    frEl("fr-pak-preis").value = p.preisCent ? (p.preisCent / 100).toFixed(2).replace(".", ",") : "";
    frEl("fr-btn-pak-anlegen").textContent = "Paket speichern";
    frEl("fr-pak-name").scrollIntoView({ block: "center", behavior: "smooth" });
  }));
}

async function frSpeicherePaket() {
  const werte = {
    name: frEl("fr-pak-name").value,
    beschreibung: frEl("fr-pak-beschreibung").value,
    preis: frEl("fr-pak-preis").value,
  };
  const res = frBearbeitetesPaketId
    ? await fruehstueckService.aenderePaket(frBearbeitetesPaketId, werte)
    : await fruehstueckService.legePaketAn(werte);

  if (!res.erfolg) { frZeigeFehler("fr-pak-fehler", res.fehler); return; }
  frZeigeFehler("fr-pak-fehler", "");
  frBearbeitetesPaketId = null;
  frEl("fr-pak-name").value = "";
  frEl("fr-pak-beschreibung").value = "";
  frEl("fr-pak-preis").value = "";
  frEl("fr-btn-pak-anlegen").textContent = "Paket hinzufügen";
}

// --- Events -------------------------------------------------------------------
function frWireEvents() {
  frEl("fr-btn-erstellen").addEventListener("click", frErstellePlan);
  frEl("fr-neu-start").addEventListener("input", frAktualisiereVorschau);
  frEl("fr-neu-tage").addEventListener("input", frAktualisiereVorschau);
  frEl("fr-btn-pak-anlegen").addEventListener("click", frSpeicherePaket);

  frEl("fr-btn-admin-anmelden").addEventListener("click", () => {
    const res = fruehstueckService.authentifiziereAlsAdmin(frEl("fr-admin-pin").value);
    frZeigeFehler("fr-admin-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) frEl("fr-admin-pin").value = "";
  });

  frEl("fr-btn-einstellungen-speichern").addEventListener("click", async () => {
    const res = await fruehstueckService.setzeEinstellungen({
      anzahlTage: frEl("fr-ein-tage").value,
      schlussUhr: frMinutenAusZeitInput(frEl("fr-ein-schluss").value, fruehstueckService.STANDARD_SCHLUSS),
    });
    frZeigeFehler("fr-einstellungen-fehler", res.erfolg ? "" : res.fehler);
  });

  frEl("fr-btn-leeren").addEventListener("click", async () => {
    if (!confirm("Alle Frühstücksbestellungen entfernen? Pakete und Einstellungen bleiben stehen.")) return;
    const res = await fruehstueckService.leereBestellungen();
    frZeigeFehler("fr-admin-panel-fehler", res.erfolg ? "" : res.fehler);
  });

  frEl("fr-btn-plan-loeschen").addEventListener("click", async () => {
    if (!confirm("Die komplette Frühstücksbestellung löschen? Pakete, Einstellungen und alle Bestellungen sind dann weg. Das lässt sich nicht rückgängig machen.")) return;
    const res = await fruehstueckService.loeschePlan();
    frZeigeFehler("fr-admin-panel-fehler", res.erfolg ? "" : res.fehler);
  });
}

// --- Start ---------------------------------------------------------------------
(function frInit() {
  frWireEvents();
  // Vorschlag für den Anlege-Screen: morgen als erster Frühstücksmorgen.
  frEl("fr-neu-start").value = fruehstueckService.datumPlus(fruehstueckService.heuteIso(), 1);
  frAktualisiereVorschau();
  fruehstueckService.onZustandsAenderung(frRender);
})();
