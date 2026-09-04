// ===========================================================================
// essen-app.js – Screens, Rendering, Events für die Essensbestellung.
// Redet nur über essenService. escapeHtml() kommt aus app.js (globaler Scope) –
// Gerichtnamen, Sonderwünsche, Notizen und Besteller-Namen sind Fremdeingaben
// aus Firebase und werden vor jedem innerHTML damit escaped.
// ===========================================================================

let esZustand = null;
let esBearbeitetesGerichtId = null;  // null = das Formular legt an, sonst ändert es dieses Gericht
let esImportVorschau = null;         // Ergebnis von parseImport(), wartet auf „Übernehmen"
let esMailAuswahl = "bezahlt";       // welche Bestellungen in die Sammelmail gehen
const esOffeneBestellungen = new Set();  // aufgeklappte Bestellungen im Admin-Bereich

// Der Warenkorb. Lebt NUR hier im Speicher – erst „Bestellung abschicken"
// schreibt ihn nach Firebase.
// ⚠️ Jede Zeile hat eine eigene lokale Id. Dasselbe Gericht darf zweimal im
// Korb liegen, wenn die Sonderwünsche verschieden sind („Pommes mit Ketchup"
// und „Pommes mit Spezialsoße" sind für die Küche zwei Dinge). Der Gerichtname
// taugt deshalb nicht als Schlüssel.
let esEntwurf = { bestellungId: null, positionen: [], notiz: "" };
let esLfdNr = 0;

function esEl(id) {
  return document.getElementById(id);
}

function esZeigeFehler(id, text) {
  const el = esEl(id);
  if (el) el.textContent = text || "";
}

function esZeigeView(id) {
  document.querySelectorAll("#tab-essen .sk-view").forEach((v) => v.classList.toggle("aktiv", v.id === id));
}

function esFesterName() {
  try {
    const k = window.__AGELAN_KONTO__;
    return (k && k.nickname) || "";
  } catch (e) {
    return "";
  }
}

function esKorbSummeCent() {
  if (!esZustand) return 0;
  return esEntwurf.positionen.reduce((summe, pos) => {
    const g = esZustand.karte.find((x) => x.id === pos.gerichtId);
    return summe + (g ? g.preisCent * pos.anzahl : 0);
  }, 0);
}

// --- Hauptrender -------------------------------------------------------------
function esRender(z) {
  esZustand = z;
  if (!z.vorhanden) {
    esZeigeView("es-kein-plan");
    // Gesperrte Datenbank sieht sonst aus wie "noch nichts angelegt".
    const warnung = esEl("es-regelwarnung");
    if (warnung) warnung.hidden = !z.zugriffFehler;
    const pinFeld = esEl("es-neu-pin");
    if (pinFeld && !pinFeld.value && z.vorhandenerPin) pinFeld.value = z.vorhandenerPin;
    const nameFeld = esEl("es-neu-besteller");
    if (nameFeld && !nameFeld.value) nameFeld.value = essenService.getGespeicherterName();
    return;
  }
  esZeigeView("es-plan");

  esRenderKopf(z);
  esRenderKarte(z);
  // ⚠️ Der Korb wird bei einem Live-Update NICHT neu gezeichnet, solange etwas
  // drin liegt: jemand tippt womöglich gerade einen Sonderwunsch, und ein
  // Neuzeichnen risse ihm den Cursor aus dem Feld. Ist der Korb leer, gibt es
  // nichts zu verlieren.
  if (!esEntwurf.positionen.length) esRenderKorb();
  esRenderMeine(z);
  esRenderAdmin(z);
}

function esRenderKopf(z) {
  esEl("es-titel").textContent = z.meta.titel;
  const zeilen = [];
  if (z.meta.lieferantName) zeilen.push("Bestellt wird bei " + z.meta.lieferantName + ".");
  zeilen.push(z.annahmeOffen
    ? "Die Bestellannahme ist offen."
    : "Die Bestellannahme ist gerade geschlossen – es läuft schon eine Sammelbestellung.");
  esEl("es-kopfzeile").textContent = zeilen.join(" ");
}

// --- Speisekarte -------------------------------------------------------------
function esRenderKarte(z) {
  const box = esEl("es-karte");
  if (!z.karte.length) {
    box.innerHTML = `<div class="karte-block"><p class="fr-leer-hinweis">Auf der Speisekarte steht noch nichts.${z.istAdmin ? " Leg unten Gerichte an oder importier eine Karte." : ""}</p></div>`;
    return;
  }

  const darfBestellen = z.annahmeOffen || z.istAdmin;
  box.innerHTML = `
    <div class="karte-block">
      <h3 class="es-abschnitt">Speisekarte</h3>
      ${!darfBestellen ? `<p class="hinweis-text">Gerade wird nichts angenommen. Du kannst die Karte ansehen.</p>` : ""}
      ${z.kategorien.map((gruppe) => `
        ${gruppe.kategorie ? `<div class="es-kategorie">${escapeHtml(gruppe.kategorie)}</div>` : ""}
        ${gruppe.gerichte.map((g) => `
          <div class="es-gericht">
            <div class="es-gericht-info">
              <div class="es-gericht-name">${escapeHtml(g.name)}</div>
              ${g.beschreibung ? `<div class="es-gericht-beschreibung">${escapeHtml(g.beschreibung)}</div>` : ""}
            </div>
            <div class="es-gericht-preis">${g.preisCent ? essenService.centLabel(g.preisCent) : "kostenlos"}</div>
            <button type="button" class="es-plus" data-es-hinzu="${escapeHtml(g.id)}"
              title="Auf die Bestellung setzen" aria-label="${escapeHtml(g.name)} auf die Bestellung setzen"
              ${darfBestellen ? "" : "disabled"}>+</button>
          </div>`).join("")}
      `).join("")}
    </div>`;

  box.querySelectorAll("[data-es-hinzu]").forEach((b) => {
    b.addEventListener("click", () => esLegeInKorb(b.dataset.esHinzu));
  });
}

// --- Warenkorb ---------------------------------------------------------------

// Zweimal auf dasselbe „+" heißt „zwei davon", nicht „zwei Zeilen". Steht in
// der Zeile aber schon ein Sonderwunsch, ist sie etwas Eigenes und bekommt eine
// neue Zeile daneben.
function esLegeInKorb(gerichtId) {
  const vorhanden = esEntwurf.positionen.find((p) => p.gerichtId === gerichtId && !p.sonderwunsch);
  if (vorhanden) {
    if (vorhanden.anzahl < essenService.MAX_STUECK) vorhanden.anzahl += 1;
    esRenderKorb();
    return;
  }
  if (esEntwurf.positionen.length >= essenService.MAX_POSITIONEN) {
    esZeigeFehler("es-korb-fehler", "Mehr als " + essenService.MAX_POSITIONEN + " verschiedene Sachen gehen nicht auf eine Bestellung.");
    return;
  }
  esLfdNr += 1;
  const lid = "l" + esLfdNr;
  esEntwurf.positionen.push({ lid, gerichtId, anzahl: 1, sonderwunsch: "" });
  esRenderKorb();
  // Direkt in das Sonderwunsch-Feld der neuen Zeile: wer gerade „Pommes"
  // angeklickt hat, will als Nächstes die Spezialsoße dazuschreiben.
  const feld = document.querySelector('[data-es-wunsch="' + lid + '"]');
  if (feld) feld.focus();
}

function esEntferneAusKorb(lid) {
  esEntwurf.positionen = esEntwurf.positionen.filter((p) => p.lid !== lid);
  esRenderKorb();
}

// ⚠️ Ändert NUR die Zahl im DOM, kein Neuzeichnen des Korbs. Ein Neuzeichnen
// würde den Cursor aus einem Sonderwunsch-Feld werfen, in dem gerade jemand
// tippt – und genau daneben steht der Stepper.
function esAendereAnzahl(lid, delta) {
  const pos = esEntwurf.positionen.find((p) => p.lid === lid);
  if (!pos) return;
  pos.anzahl = Math.max(1, Math.min(essenService.MAX_STUECK, pos.anzahl + delta));

  const zeile = document.querySelector('[data-es-zeile="' + lid + '"]');
  if (zeile) {
    const zahl = zeile.querySelector(".fr-stepper-zahl");
    if (zahl) zahl.textContent = pos.anzahl;
    const minus = zeile.querySelector("[data-es-weniger]");
    const plus = zeile.querySelector("[data-es-mehr]");
    if (minus) minus.disabled = pos.anzahl <= 1;
    if (plus) plus.disabled = pos.anzahl >= essenService.MAX_STUECK;
    const gericht = esZustand.karte.find((g) => g.id === pos.gerichtId);
    const preis = zeile.querySelector(".es-korb-preis");
    if (preis && gericht) preis.textContent = essenService.centLabel(gericht.preisCent * pos.anzahl);
  }
  const summe = esEl("es-korb-summe");
  if (summe) summe.textContent = essenService.centLabel(esKorbSummeCent());
}

function esRenderKorb() {
  const box = esEl("es-korb");
  const z = esZustand;
  if (!box || !z || !z.vorhanden) return;

  if (!esEntwurf.positionen.length) {
    box.innerHTML = !z.karte.length ? "" : `
      <div class="karte-block es-korb-leer">
        <p class="fr-leer-hinweis">Deine Bestellung ist noch leer. Tipp oben bei einem Gericht auf <b>+</b>.</p>
      </div>`;
    return;
  }

  const name = esFesterName() || essenService.getGespeicherterName();
  box.innerHTML = `
    <div class="karte-block es-korb-karte">
      <h3 class="es-abschnitt">${esEntwurf.bestellungId ? "Bestellung ändern" : "Deine Bestellung"}</h3>

      ${esEntwurf.positionen.map((pos) => {
        const g = z.karte.find((x) => x.id === pos.gerichtId);
        const weg = !g;
        return `
        <div class="es-korb-zeile${weg ? " fehlt" : ""}" data-es-zeile="${escapeHtml(pos.lid)}">
          <div class="es-korb-kopf">
            <span class="es-korb-name">${escapeHtml(g ? g.name : "Gericht ist von der Karte")}</span>
            <span class="es-korb-preis">${g ? essenService.centLabel(g.preisCent * pos.anzahl) : ""}</span>
            <button type="button" class="mini-btn" data-es-raus="${escapeHtml(pos.lid)}" title="Wieder runter" aria-label="Wieder runter">🗑</button>
          </div>
          <div class="es-korb-unten">
            <div class="fr-stepper">
              <button type="button" data-es-weniger="${escapeHtml(pos.lid)}" ${pos.anzahl <= 1 ? "disabled" : ""}>−</button>
              <span class="fr-stepper-zahl">${pos.anzahl}</span>
              <button type="button" data-es-mehr="${escapeHtml(pos.lid)}" ${pos.anzahl >= essenService.MAX_STUECK ? "disabled" : ""}>+</button>
            </div>
            <input type="text" class="eingabe es-wunsch" data-es-wunsch="${escapeHtml(pos.lid)}"
              maxlength="${essenService.MAX_SONDERWUNSCH}" autocomplete="off"
              placeholder="Sonderwunsch, z. B. mit Spezialsoße" value="${escapeHtml(pos.sonderwunsch)}">
          </div>
        </div>`;
      }).join("")}

      <div class="fr-summe-zeile">
        <span>${esEntwurf.positionen.reduce((s, p) => s + p.anzahl, 0)} Stück</span>
        <span id="es-korb-summe">${essenService.centLabel(esKorbSummeCent())}</span>
      </div>

      ${name
        ? `<p class="fr-besteller">Bestellung für <b>${escapeHtml(name)}</b></p>`
        : `<label class="feld-label" for="es-korb-name">Dein Name</label>
           <input type="text" id="es-korb-name" class="eingabe" maxlength="40" autocomplete="off">`}

      <label class="feld-label" for="es-korb-notiz">Notiz für den Veranstalter (freiwillig)</label>
      <input type="text" id="es-korb-notiz" class="eingabe" maxlength="200" autocomplete="off"
        placeholder="z. B. hole ich erst um 20 Uhr ab" value="${escapeHtml(esEntwurf.notiz)}">

      <button class="btn btn-primary btn-grow" id="es-btn-abschicken">
        ${esEntwurf.bestellungId ? "Änderung speichern" : "Bestellung abschicken"}
      </button>
      <button class="btn btn-link" id="es-btn-korb-leeren">${esEntwurf.bestellungId ? "Änderung verwerfen" : "Bestellung verwerfen"}</button>
      <p class="hinweis-text">Danach kommst du nach vorne und bezahlst. Sobald bezahlt ist, lässt sie sich nicht mehr ändern.</p>
      <p class="hinweis-text fehler" id="es-korb-fehler"></p>
    </div>`;

  box.querySelectorAll("[data-es-mehr]").forEach((b) => b.addEventListener("click", () => esAendereAnzahl(b.dataset.esMehr, 1)));
  box.querySelectorAll("[data-es-weniger]").forEach((b) => b.addEventListener("click", () => esAendereAnzahl(b.dataset.esWeniger, -1)));
  box.querySelectorAll("[data-es-raus]").forEach((b) => b.addEventListener("click", () => esEntferneAusKorb(b.dataset.esRaus)));
  box.querySelectorAll("[data-es-wunsch]").forEach((feld) => {
    feld.addEventListener("input", () => {
      const pos = esEntwurf.positionen.find((p) => p.lid === feld.dataset.esWunsch);
      if (pos) pos.sonderwunsch = feld.value;
    });
  });
  const notiz = esEl("es-korb-notiz");
  if (notiz) notiz.addEventListener("input", () => { esEntwurf.notiz = notiz.value; });

  esEl("es-btn-abschicken").addEventListener("click", esSendeBestellung);
  esEl("es-btn-korb-leeren").addEventListener("click", () => {
    if (!confirm(esEntwurf.bestellungId ? "Die Änderung verwerfen?" : "Die ganze Bestellung verwerfen?")) return;
    esLeereKorb();
  });
}

function esLeereKorb() {
  esEntwurf = { bestellungId: null, positionen: [], notiz: "" };
  esRenderKorb();
}

async function esSendeBestellung() {
  const z = esZustand;
  // Ein Gericht kann verschwunden sein, während der Korb offen stand. Das muss
  // dranstehen – sonst käme nur ein „wähle etwas aus" ohne erkennbaren Grund.
  const fehlend = esEntwurf.positionen.filter((p) => !z.karte.some((g) => g.id === p.gerichtId));
  if (fehlend.length) {
    esZeigeFehler("es-korb-fehler", fehlend.length + " Gericht" + (fehlend.length === 1 ? " steht" : "e stehen") +
      " nicht mehr auf der Karte. Nimm es mit dem Papierkorb runter.");
    return;
  }

  const nameFeld = esEl("es-korb-name");
  const name = esFesterName() || (nameFeld ? nameFeld.value : "") || essenService.getGespeicherterName();

  const res = await essenService.bestelle({
    name,
    notiz: esEntwurf.notiz,
    bestellungId: esEntwurf.bestellungId,
    positionen: esEntwurf.positionen.map((p) => ({
      gerichtId: p.gerichtId,
      anzahl: p.anzahl,
      sonderwunsch: p.sonderwunsch,
    })),
  });
  if (!res.erfolg) { esZeigeFehler("es-korb-fehler", res.fehler); return; }
  esLeereKorb();
}

// --- Meine Bestellungen ------------------------------------------------------
function esRenderMeine(z) {
  const box = esEl("es-meine");
  if (!z.meine.length) { box.innerHTML = ""; return; }

  box.innerHTML = `
    <div class="karte-block">
      <h3 class="es-abschnitt">Deine Bestellungen</h3>
      ${z.meine.map((b) => `
        <div class="es-bestellung status-${escapeHtml(b.status)}">
          <div class="es-best-kopf">
            <span class="es-status-punkt" aria-hidden="true"></span>
            <span class="es-best-status">${escapeHtml(b.statusLang)}</span>
            ${b.orga
              ? `<span class="es-best-summe frei" title="Wert ${essenService.centLabel(b.summeCent)} – geht auf die Organisation">kostenlos</span>`
              : `<span class="es-best-summe">${essenService.centLabel(b.summeCent)}</span>`}
          </div>
          <div class="es-best-positionen">${b.positionen.map((p) =>
            p.anzahl + "× " + escapeHtml(p.name) + (p.sonderwunsch ? ` <i>(${escapeHtml(p.sonderwunsch)})</i>` : "")
          ).join("<br>")}</div>
          ${b.notiz ? `<div class="fr-liste-notiz">${escapeHtml(b.notiz)}</div>` : ""}
          ${b.aenderbar ? `
            <div class="es-best-aktionen">
              <button type="button" class="mini-btn" data-es-bearbeiten="${escapeHtml(b.id)}">Ändern</button>
              <button type="button" class="mini-btn" data-es-storno="${escapeHtml(b.id)}">Stornieren</button>
            </div>` : ""}
        </div>`).join("")}
    </div>`;

  box.querySelectorAll("[data-es-bearbeiten]").forEach((btn) => {
    btn.addEventListener("click", () => esLadeInKorb(btn.dataset.esBearbeiten));
  });
  box.querySelectorAll("[data-es-storno]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Diese Bestellung wirklich stornieren?")) return;
      const res = await essenService.storniere(btn.dataset.esStorno);
      if (!res.erfolg) alert(res.fehler);
    });
  });
}

function esLadeInKorb(bestellungId) {
  const b = esZustand.bestellungen.find((x) => x.id === bestellungId);
  if (!b) return;
  esEntwurf = {
    bestellungId: b.id,
    notiz: b.notiz,
    positionen: b.positionen.map((p) => {
      esLfdNr += 1;
      return { lid: "l" + esLfdNr, gerichtId: p.gerichtId, anzahl: p.anzahl, sonderwunsch: p.sonderwunsch };
    }),
  };
  esRenderKorb();
  esEl("es-korb").scrollIntoView({ block: "start", behavior: "smooth" });
}

// --- Admin -------------------------------------------------------------------
function esRenderAdmin(z) {
  esEl("es-admin-login").style.display = z.istAdmin ? "none" : "";
  esEl("es-admin").style.display = z.istAdmin ? "" : "none";
  if (!z.istAdmin) {
    // ⚠️ Ausblenden ist nicht Zurückhalten. `display:none` lässt die fremden
    // Bestellungen und den Mailtext im DOM stehen – ein Blick in die
    // Entwicklerwerkzeuge liest sie mit. Wer die Karte nicht verwalten darf,
    // bekommt diese Kästen deshalb geleert, nicht nur unsichtbar.
    ["es-admin-bestellungen", "es-sammelmail", "es-karte-verwalten"].forEach((id) => {
      const el = esEl(id);
      if (el) el.innerHTML = "";
    });
    return;
  }

  esRenderAdminBestellungen(z);
  esRenderSammelmail(z);
  esRenderKarteVerwalten(z);
  esRenderEinstellungen(z);
}

function esRenderAdminBestellungen(z) {
  const box = esEl("es-admin-bestellungen");
  if (!z.bestellungen.length) {
    box.innerHTML = `<p class="fr-leer-hinweis">Noch keine Bestellungen.</p>`;
    return;
  }

  box.innerHTML = `
    <div class="es-zaehler">
      ${essenService.STATUS_KETTE.map((s) =>
        `<span class="es-zaehler-teil status-${s}"><b>${z.zaehler[s]}</b> ${escapeHtml(essenService.STATUS_TEXT[s].kurz)}</span>`
      ).join("")}
    </div>
    <div class="fr-summe-zeile es-geldzeile">
      <span>Noch zu kassieren</span>
      <span><b>${essenService.centLabel(z.offeneCent)}</b></span>
    </div>
    <p class="hinweis-text es-geldnote">Warenwert ${essenService.centLabel(z.summeGesamtCent)} – davon
      ${essenService.centLabel(z.zahltGesamtCent)} von Teilnehmern${z.anzahlOrga
        ? " und " + essenService.centLabel(z.orgaGesamtCent) + " auf die Organisation (" + z.anzahlOrga + " Bestellung" + (z.anzahlOrga === 1 ? "" : "en") + ")"
        : ""}.</p>
    ${z.bestellungen.map((b) => `
      <details class="es-admin-best status-${escapeHtml(b.status)}" data-es-offen="${escapeHtml(b.id)}"${esOffeneBestellungen.has(b.id) ? " open" : ""}>
        <summary>
          <span class="es-status-punkt" aria-hidden="true"></span>
          <span class="es-admin-name">${escapeHtml(b.name)}</span>
          <span class="es-admin-kurz">${b.stueck}× · ${essenService.centLabel(b.summeCent)}${b.orga ? " 🛠" : ""} · ${escapeHtml(b.statusKurz)}</span>
        </summary>
        <div class="es-admin-inhalt">
          <div class="es-best-positionen">${b.positionen.map((p) =>
            p.anzahl + "× " + escapeHtml(p.name) + (p.sonderwunsch ? ` <i>(${escapeHtml(p.sonderwunsch)})</i>` : "")
          ).join("<br>")}</div>
          ${b.notiz ? `<div class="fr-liste-notiz">${escapeHtml(b.notiz)}</div>` : ""}
          <div class="hinweis-text es-zeitstempel">Bestellt: ${escapeHtml(essenService.zeitLabel(b.erstelltAm))}</div>
          <div class="es-best-aktionen">
            ${b.naechsterKnopf
              ? `<button type="button" class="mini-btn primary" data-es-weiter="${escapeHtml(b.id)}">${escapeHtml(b.naechsterKnopf)}</button>`
              : ""}
            ${b.statusIndex > 0
              ? `<button type="button" class="mini-btn" data-es-zurueck="${escapeHtml(b.id)}" title="Einen Schritt zurück">↺ zurück</button>`
              : ""}
            <button type="button" class="mini-btn" data-es-orga="${escapeHtml(b.id)}"
              title="${b.orga ? "Doch zahlen lassen" : "Als Orga-Essen führen – kostet dann nichts"}">
              ${b.orga ? "🛠 → zahlt" : "→ 🛠 Orga"}</button>
            <button type="button" class="mini-btn" data-es-weg="${escapeHtml(b.id)}" title="Bestellung löschen">🗑</button>
          </div>
        </div>
      </details>`).join("")}`;

  box.querySelectorAll("[data-es-offen]").forEach((d) => {
    d.addEventListener("toggle", () => {
      // ⚠️ Ohne dieses Merken klappt jede Bestellung wieder zu, sobald irgendwo
      // ein Status gesetzt wird – genau bei der Tätigkeit, für die die Liste da ist.
      if (d.open) esOffeneBestellungen.add(d.dataset.esOffen);
      else esOffeneBestellungen.delete(d.dataset.esOffen);
    });
  });
  box.querySelectorAll("[data-es-weiter]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esWeiter);
      if (!b) return;
      const ziel = essenService.STATUS_KETTE[b.statusIndex + 1];
      if (!ziel) return;
      const res = await essenService.setzeStatus(b.id, ziel);
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-zurueck]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esZurueck);
      if (!b || b.statusIndex <= 0) return;
      const res = await essenService.setzeStatus(b.id, essenService.STATUS_KETTE[b.statusIndex - 1]);
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-orga]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esOrga);
      if (!b) return;
      if (b.orga && !confirm(b.name + " wird dann wieder zahlungspflichtig: " +
          essenService.centLabel(b.summeCent) + ". Weiter?")) return;
      const res = await essenService.setzeOrga(b.id, !b.orga);
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });

  box.querySelectorAll("[data-es-weg]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Diese Bestellung wirklich löschen?")) return;
      const res = await essenService.loescheBestellung(btn.dataset.esWeg);
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
}

// --- Sammelbestellung + E-Mail -----------------------------------------------

// Welche Bestellungen gehen in die Mail? „bezahlt" ist der Normalfall: erst
// zahlen, dann bestellen wir. Die zweite Wahl nimmt die noch nicht bezahlten
// mit – für den Fall, dass jemand später zahlt und das Essen trotzdem mit soll.
function esMailBestellungen(z) {
  if (esMailAuswahl === "offen") return z.bestellungen.filter((b) => b.status === "neu" || b.status === "bezahlt");
  return z.bestellungen.filter((b) => b.status === "bezahlt");
}

function esRenderSammelmail(z) {
  const box = esEl("es-sammelmail");
  const auswahl = esMailBestellungen(z);
  const brief = essenService.bestelltext(auswahl, z.meta);

  // Die Vorschau zeigt dieselbe Trennung wie der Brief: was die Teilnehmer
  // bezahlen und was auf die Organisation geht. ⚠️ Beides aus `brief`, nicht
  // noch einmal selbst gerechnet – zwei Rechenwege driften auseinander, und
  // dann verspricht die Vorschau etwas anderes als der Text darunter.
  const blockHtml = (titel, liste, summeCent, klasse) => !liste.length ? "" : `
    <p class="feld-label es-block-titel ${klasse}">${titel}</p>
    <div class="fr-einkaufsliste">
      ${liste.map((p) => `
        <div class="fr-einkauf-zeile">
          <span>${escapeHtml(p.name)}${p.sonderwunsch ? ` <i>(${escapeHtml(p.sonderwunsch)})</i>` : ""}</span>
          <b>${p.anzahl}×</b>
        </div>`).join("")}
    </div>
    <div class="fr-summe-zeile">
      <span>${liste.reduce((s, p) => s + p.anzahl, 0)} Stück</span>
      <span>${essenService.centLabel(summeCent)}</span>
    </div>`;

  // mailto: hat in der Praxis eine Längengrenze (je nach Mailprogramm ab etwa
  // 2000 Zeichen). Darüber kommt die Mail leer oder abgeschnitten an – deshalb
  // wird gewarnt statt so getan, als ginge es.
  const mailto = "mailto:" + encodeURIComponent(brief.empfaenger) +
    "?subject=" + encodeURIComponent(brief.betreff) +
    "&body=" + encodeURIComponent(brief.text);
  const zuLang = mailto.length > 1900;

  box.innerHTML = `
    <p class="feld-label">Sammelbestellung an den Lieferanten</p>

    <div class="es-mail-wahl">
      <label><input type="radio" name="es-mailwahl" value="bezahlt" ${esMailAuswahl === "bezahlt" ? "checked" : ""}> nur bezahlte (${z.zaehler.bezahlt})</label>
      <label><input type="radio" name="es-mailwahl" value="offen" ${esMailAuswahl === "offen" ? "checked" : ""}> auch unbezahlte (${z.zaehler.neu + z.zaehler.bezahlt})</label>
    </div>

    ${!auswahl.length ? `
      <p class="fr-leer-hinweis">Auf diesem Stand liegt gerade keine Bestellung.</p>
    ` : `
      ${blockHtml("Teilnehmer – wird bezahlt", brief.listeZahlend, brief.summeZahlendCent, "")}
      ${blockHtml("Organisation – zahlen die Teilnehmer nicht mit", brief.listeOrga, brief.summeOrgaCent, "orga")}
      <div class="fr-summe-zeile es-mail-gesamt">
        <span>${brief.anzahlBestellungen} Bestellung${brief.anzahlBestellungen === 1 ? "" : "en"}, ${brief.anzahlPositionen} Stück</span>
        <span><b>${essenService.centLabel(brief.summeCent)}</b></span>
      </div>

      <label class="feld-label" for="es-mail-text">E-Mail-Text</label>
      <textarea id="es-mail-text" class="eingabe es-mail-text" rows="12" spellcheck="false">${escapeHtml(brief.text)}</textarea>
      <p class="hinweis-text">Der Text lässt sich hier noch ändern, bevor er rausgeht. Namen der Besteller stehen bewusst nicht drin – der Lieferant braucht Mengen und Sonderwünsche.</p>

      <div class="es-mail-knoepfe">
        <button type="button" class="btn btn-secondary" id="es-btn-kopieren">Text kopieren</button>
        ${brief.empfaenger
          ? `<a class="btn btn-primary es-mail-link" id="es-mail-link" href="${escapeHtml(mailto)}">E-Mail öffnen</a>`
          : `<button type="button" class="btn btn-primary" disabled title="Erst die E-Mail-Adresse des Lieferanten eintragen">E-Mail öffnen</button>`}
      </div>
      ${!brief.empfaenger ? `<p class="hinweis-text">Für „E-Mail öffnen“ fehlt noch die Adresse des Lieferanten – trag sie unten bei den Einstellungen ein.</p>` : ""}
      ${zuLang ? `<p class="hinweis-text">⚠️ Der Text ist lang. Manche Mailprogramme schneiden ihn ab – wenn die Mail leer aufgeht, nimm „Text kopieren“ und füg ihn von Hand ein.</p>` : ""}

      <button class="btn btn-secondary btn-grow" id="es-btn-alle-bestellt">Diese ${auswahl.length} als „beim Lieferanten bestellt“ markieren</button>
      <p class="hinweis-text">Erst klicken, wenn die Mail wirklich raus ist.</p>
    `}
    <p class="hinweis-text fehler" id="es-mail-fehler"></p>`;

  box.querySelectorAll('input[name="es-mailwahl"]').forEach((r) => {
    r.addEventListener("change", () => {
      esMailAuswahl = r.value;
      esRenderSammelmail(esZustand);
    });
  });

  const kopieren = esEl("es-btn-kopieren");
  if (kopieren) kopieren.addEventListener("click", () => esKopiereMailText());

  const alleBtn = esEl("es-btn-alle-bestellt");
  if (alleBtn) alleBtn.addEventListener("click", async () => {
    if (!confirm("Alle " + auswahl.length + " Bestellungen auf „beim Lieferanten bestellt“ setzen?")) return;
    // Zwei Durchläufe, weil „auch unbezahlte" zwei Stände umfasst. Der Service
    // meldet einen leeren Durchlauf als Fehler – hier ist ein leerer der zweite
    // Normalfall, deshalb wird nur der Gesamt-Fehlschlag gemeldet.
    const stufen = esMailAuswahl === "offen" ? ["neu", "bezahlt"] : ["bezahlt"];
    let gesamt = 0;
    let letzterFehler = "";
    for (const stufe of stufen) {
      const res = await essenService.setzeStatusAlle(stufe, "bestellt");
      if (res.erfolg) gesamt += res.anzahl;
      else letzterFehler = res.fehler;
    }
    esZeigeFehler("es-mail-fehler", gesamt ? "" : (letzterFehler || "Es hat sich nichts geändert."));
  });
}

function esKopiereMailText() {
  const feld = esEl("es-mail-text");
  if (!feld) return;
  const melde = (text) => esZeigeFehler("es-mail-fehler", text);

  // ⚠️ navigator.clipboard gibt es auf älteren iOS-Geräten nicht und außerhalb
  // von https gar nicht. Der alte Weg über die Auswahl ist der Rückfall.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(feld.value)
      .then(() => melde("Text kopiert."))
      .catch(() => esKopiereUeberAuswahl(feld, melde));
    return;
  }
  esKopiereUeberAuswahl(feld, melde);
}

function esKopiereUeberAuswahl(feld, melde) {
  try {
    feld.focus();
    feld.setSelectionRange(0, feld.value.length);
    const ok = document.execCommand && document.execCommand("copy");
    melde(ok ? "Text kopiert." : "Kopieren ging nicht – markier den Text und kopier ihn von Hand.");
  } catch (e) {
    melde("Kopieren ging nicht – markier den Text und kopier ihn von Hand.");
  }
}

// --- Admin: Speisekarte verwalten --------------------------------------------
function esRenderKarteVerwalten(z) {
  const box = esEl("es-karte-verwalten");
  box.innerHTML = z.karte.length
    ? z.karte.map((g, i) => `
        <div class="fr-paket-verwalten">
          <div class="fr-pv-info">
            <div class="fr-pv-name">${escapeHtml(g.name)}</div>
            <div class="fr-pv-preis">${g.preisCent ? essenService.centLabel(g.preisCent) : "kostenlos"}${g.kategorie ? " · " + escapeHtml(g.kategorie) : ""}${g.beschreibung ? " · " + escapeHtml(g.beschreibung) : ""}</div>
          </div>
          <div class="fr-pv-aktionen">
            <button type="button" class="mini-btn" data-es-hoch="${escapeHtml(g.id)}" ${i === 0 ? "disabled" : ""}>▲</button>
            <button type="button" class="mini-btn" data-es-runter="${escapeHtml(g.id)}" ${i === z.karte.length - 1 ? "disabled" : ""}>▼</button>
            <button type="button" class="mini-btn" data-es-edit="${escapeHtml(g.id)}">✎</button>
            <button type="button" class="mini-btn" data-es-loeschen="${escapeHtml(g.id)}">🗑</button>
          </div>
        </div>`).join("")
    : `<p class="fr-leer-hinweis">Noch keine Gerichte.</p>`;

  box.querySelectorAll("[data-es-hoch]").forEach((b) => b.addEventListener("click", () => essenService.verschiebeGericht(b.dataset.esHoch, -1)));
  box.querySelectorAll("[data-es-runter]").forEach((b) => b.addEventListener("click", () => essenService.verschiebeGericht(b.dataset.esRunter, 1)));
  box.querySelectorAll("[data-es-loeschen]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Dieses Gericht von der Karte nehmen? Schon abgeschickte Bestellungen bleiben, wie sie sind.")) return;
    const res = await essenService.loescheGericht(b.dataset.esLoeschen);
    if (!res.erfolg) esZeigeFehler("es-gericht-fehler", res.fehler);
  }));
  box.querySelectorAll("[data-es-edit]").forEach((b) => b.addEventListener("click", () => {
    const g = esZustand.karte.find((x) => x.id === b.dataset.esEdit);
    if (!g) return;
    esBearbeitetesGerichtId = g.id;
    esEl("es-ger-name").value = g.name;
    esEl("es-ger-beschreibung").value = g.beschreibung;
    esEl("es-ger-kategorie").value = g.kategorie;
    esEl("es-ger-preis").value = g.preisCent ? (g.preisCent / 100).toFixed(2).replace(".", ",") : "";
    esEl("es-btn-ger-anlegen").textContent = "Gericht speichern";
    esEl("es-ger-name").scrollIntoView({ block: "center", behavior: "smooth" });
  }));
}

async function esSpeichereGericht() {
  const werte = {
    name: esEl("es-ger-name").value,
    beschreibung: esEl("es-ger-beschreibung").value,
    kategorie: esEl("es-ger-kategorie").value,
    preis: esEl("es-ger-preis").value,
  };
  const res = esBearbeitetesGerichtId
    ? await essenService.aendereGericht(esBearbeitetesGerichtId, werte)
    : await essenService.legeGerichtAn(werte);

  if (!res.erfolg) { esZeigeFehler("es-gericht-fehler", res.fehler); return; }
  esZeigeFehler("es-gericht-fehler", "");
  esBearbeitetesGerichtId = null;
  ["es-ger-name", "es-ger-beschreibung", "es-ger-preis"].forEach((id) => { esEl(id).value = ""; });
  // ⚠️ Die Kategorie bleibt stehen: wer eine Karte abtippt, legt mehrere
  // Gerichte derselben Kategorie hintereinander an.
  esEl("es-btn-ger-anlegen").textContent = "Gericht hinzufügen";
}

// --- Admin: Import ------------------------------------------------------------
function esPruefeImport() {
  const roh = esEl("es-import-text").value;
  const ergebnis = essenService.parseImport(roh);
  esImportVorschau = ergebnis.gerichte;

  const box = esEl("es-import-vorschau");
  if (!ergebnis.gerichte.length) {
    esImportVorschau = null;
    box.innerHTML = `<p class="fr-leer-hinweis">Daraus konnte ich kein Gericht lesen. Ein Gericht je Zeile, Felder mit „|“ getrennt.</p>`;
    return;
  }

  const kategorien = new Set(ergebnis.gerichte.map((g) => g.kategorie).filter(Boolean));
  const ohnePreis = ergebnis.gerichte.filter((g) => !g.preisCent).length;

  box.innerHTML = `
    <div class="es-import-kopf">
      <b>${ergebnis.gerichte.length} Gericht${ergebnis.gerichte.length === 1 ? "" : "e"}</b>
      ${kategorien.size ? " in " + kategorien.size + " Kategorie" + (kategorien.size === 1 ? "" : "n") : " ohne Kategorie"}
      ${ohnePreis ? " · " + ohnePreis + " ohne Preis" : ""}
    </div>
    <div class="es-import-liste">
      ${ergebnis.gerichte.map((g) => `
        <div class="es-import-zeile">
          <span>${g.kategorie ? `<span class="es-import-kat">${escapeHtml(g.kategorie)}</span> ` : ""}${escapeHtml(g.name)}${g.beschreibung ? ` <i>${escapeHtml(g.beschreibung)}</i>` : ""}</span>
          <b>${g.preisCent ? essenService.centLabel(g.preisCent) : "–"}</b>
        </div>`).join("")}
    </div>
    ${ergebnis.fehler.length ? `<p class="hinweis-text fehler">${ergebnis.fehler.map(escapeHtml).join("<br>")}</p>` : ""}
    <div class="es-import-knoepfe">
      <button type="button" class="btn btn-secondary" id="es-btn-import-anhaengen">An die Karte anhängen</button>
      <button type="button" class="btn btn-danger" id="es-btn-import-ersetzen">Karte ersetzen</button>
    </div>`;

  esEl("es-btn-import-anhaengen").addEventListener("click", () => esFuehreImportAus(false));
  esEl("es-btn-import-ersetzen").addEventListener("click", () => esFuehreImportAus(true));
}

async function esFuehreImportAus(ersetzen) {
  if (!esImportVorschau) return;
  if (ersetzen && !confirm("Die bisherige Speisekarte wird dabei gelöscht und durch die " +
      esImportVorschau.length + " neuen Gerichte ersetzt. Schon abgeschickte Bestellungen bleiben, wie sie sind. Weiter?")) return;

  const res = await essenService.importiereKarte(esImportVorschau, ersetzen);
  if (!res.erfolg) { esZeigeFehler("es-import-fehler", res.fehler); return; }
  esZeigeFehler("es-import-fehler", res.anzahl + " Gerichte übernommen.");
  esImportVorschau = null;
  esEl("es-import-text").value = "";
  esEl("es-import-vorschau").innerHTML = "";
}

// --- Admin: Einstellungen -----------------------------------------------------
function esRenderEinstellungen(z) {
  // ⚠️ Nur befüllen, wenn das Feld gerade nicht bearbeitet wird – sonst
  // überschreibt ein Live-Update (irgendwer bestellt) die halb getippte Eingabe.
  const setze = (id, wert) => {
    const el = esEl(id);
    if (el && document.activeElement !== el) el.value = wert || "";
  };
  setze("es-ein-lieferant", z.meta.lieferantName);
  setze("es-ein-email", z.meta.lieferantEmail);
  setze("es-ein-besteller", z.meta.bestellerName);
  setze("es-ein-telefon", z.meta.bestellerTelefon);
  setze("es-ein-hinweis", z.meta.hinweis);

  const schalter = esEl("es-ein-annahme");
  if (schalter && document.activeElement !== schalter) schalter.checked = z.annahmeOffen;
}

// --- Anlegen -------------------------------------------------------------------
async function esFormularErstellePlan() {
  const res = await essenService.erstellePlan({
    titel: esEl("es-neu-titel").value,
    lieferantName: esEl("es-neu-lieferant").value,
    lieferantEmail: esEl("es-neu-email").value,
    bestellerName: esEl("es-neu-besteller").value,
    bestellerTelefon: esEl("es-neu-telefon").value,
    hinweis: "",
    adminPin: esEl("es-neu-pin").value,
  });
  if (!res.erfolg) { esZeigeFehler("es-neu-fehler", res.fehler); return; }
  esZeigeFehler("es-neu-fehler", "");
}

// --- Events ---------------------------------------------------------------------
function esWireEvents() {
  esEl("es-btn-erstellen").addEventListener("click", esFormularErstellePlan);
  esEl("es-btn-ger-anlegen").addEventListener("click", esSpeichereGericht);
  esEl("es-btn-import-pruefen").addEventListener("click", esPruefeImport);

  esEl("es-btn-admin-anmelden").addEventListener("click", () => {
    const res = essenService.authentifiziereAlsAdmin(esEl("es-admin-pin").value);
    esZeigeFehler("es-admin-login-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) esEl("es-admin-pin").value = "";
  });

  esEl("es-ein-annahme").addEventListener("change", async () => {
    const res = await essenService.setzeAnnahme(esEl("es-ein-annahme").checked);
    esZeigeFehler("es-ein-fehler", res.erfolg ? "" : res.fehler);
  });

  esEl("es-btn-ein-speichern").addEventListener("click", async () => {
    const res = await essenService.setzeEinstellungen({
      lieferantName: esEl("es-ein-lieferant").value,
      lieferantEmail: esEl("es-ein-email").value,
      bestellerName: esEl("es-ein-besteller").value,
      bestellerTelefon: esEl("es-ein-telefon").value,
      hinweis: esEl("es-ein-hinweis").value,
      annahmeOffen: esEl("es-ein-annahme").checked,
    });
    esZeigeFehler("es-ein-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) esZeigeFehler("es-ein-fehler", "Gespeichert.");
  });

  esEl("es-btn-leeren").addEventListener("click", async () => {
    if (!confirm("Alle Bestellungen entfernen? Die Speisekarte bleibt stehen.")) return;
    const res = await essenService.leereBestellungen();
    esZeigeFehler("es-admin-fehler", res.erfolg ? "" : res.fehler);
  });

  esEl("es-btn-plan-loeschen").addEventListener("click", async () => {
    if (!confirm("Die komplette Essensbestellung löschen? Speisekarte und alle Bestellungen sind dann weg. Das lässt sich nicht rückgängig machen.")) return;
    const res = await essenService.loeschePlan();
    esZeigeFehler("es-admin-fehler", res.erfolg ? "" : res.fehler);
  });
}

// --- Start -----------------------------------------------------------------------
(function esInit() {
  esWireEvents();
  essenService.onZustandsAenderung(esRender);
})();
