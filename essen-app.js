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
// Aufgeklappte Sammelbestellungen. ⚠️ Beim Laden LEER: alles ist zugeklappt,
// und nur was der Veranstalter selbst aufklappt, landet hier. Bis zum
// 04.09.2026 sprang jede nicht fertige Runde von allein auf; bei einem Abend
// mit acht Lieferungen ist das eine Bildschirmlänge, durch die man erst
// scrollen muss.
const esOffeneRunden = new Set();

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

// "HH:MM" -> Minuten seit 0:00. Leer heisst: kein Fenster (-1).
function esMinutenAusZeit(wert) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(wert || "").trim());
  if (!m) return -1;
  return Math.min(1439, Number(m[1]) * 60 + Number(m[2]));
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

  // ⚠️ Zwei verschiedene Gründe, warum gerade nichts geht – und beide brauchen
  // eine eigene Antwort. „Der Veranstalter hat zugemacht" heißt: heute nichts
  // mehr. „Außerhalb der Zeit" heißt: komm um 10 Uhr wieder. Ein gemeinsames
  // „geschlossen" ließe niemanden wissen, ob sich Warten lohnt.
  if (!z.schalterAn) {
    zeilen.push("Die Bestellannahme ist gerade geschlossen – es läuft schon eine Sammelbestellung.");
  } else if (!z.imFenster) {
    zeilen.push("Bestellt werden kann nur zwischen " + z.fensterLabel + ". Gerade ist zu.");
  } else if (z.fensterLabel) {
    zeilen.push("Bestellannahme offen, heute bis " + essenService.uhrLabel(z.fensterBis) + " Uhr.");
  } else {
    zeilen.push("Die Bestellannahme ist offen.");
  }
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
      ${!darfBestellen
        // Der Grund gehört auch hierher: hier klickt man auf das „+", nicht oben
        // in der Kopfzeile.
        ? `<p class="hinweis-text">${z.schalterAn && !z.imFenster
             ? "Bestellt werden kann nur zwischen " + escapeHtml(z.fensterLabel) + "."
             : "Gerade wird nichts angenommen."} Du kannst die Karte ansehen.</p>`
        : ""}
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
    ["es-admin-bestellungen", "es-statistik", "es-sammelmail", "es-karte-verwalten"].forEach((id) => {
      const el = esEl(id);
      if (el) el.innerHTML = "";
    });
    return;
  }

  esRenderAdminBestellungen(z);
  esRenderStatistik(z);
  esRenderSammelmail(z);
  esRenderKarteVerwalten(z);
  esRenderEinstellungen(z);
}

// Eine einzelne Bestellung als aufklappbarer Kasten. Wird an zwei Stellen
// gebraucht – im Stapel und innerhalb einer Runde – und steht deshalb einmal
// hier statt zweimal im selben Aufbau.
function esBestellungHtml(b) {
  return `
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
          <div class="hinweis-text es-zeitstempel">Bestellt: <b>${escapeHtml(essenService.zeitLabel(b.erstelltAm))}</b></div>
          <div class="es-best-aktionen">
            ${b.naechsterKnopf
              ? `<button type="button" class="mini-btn primary" data-es-weiter="${escapeHtml(b.id)}">${escapeHtml(b.naechsterKnopf)}</button>`
              : ""}
            ${b.zurueckStatus
              ? `<button type="button" class="mini-btn" data-es-zurueck="${escapeHtml(b.id)}"
                  title="${b.inRunde ? "Fehlklick zurücknehmen – die Bestellung bleibt in der Lieferung" : "Einen Schritt zurück"}">${escapeHtml(b.zurueckKnopf || "↺ zurück")}</button>`
              : ""}
            ${b.inRunde
              ? `<button type="button" class="mini-btn" data-es-raus="${escapeHtml(b.id)}"
                  title="Aus dieser Sammelbestellung nehmen – landet wieder im Stapel">↩ herausnehmen</button>`
              : ""}
            ${b.inRunde ? "" : `<button type="button" class="mini-btn" data-es-mail="${escapeHtml(b.id)}"
              title="Nur diese eine Bestellung an den Lieferanten schicken">✉ nur diese</button>`}
            <button type="button" class="mini-btn" data-es-orga="${escapeHtml(b.id)}"
              title="${b.orga ? "Doch zahlen lassen" : "Als Orga-Essen führen – kostet dann nichts"}">
              ${b.orga ? "🛠 → zahlt" : "→ 🛠 Orga"}</button>
            <button type="button" class="mini-btn" data-es-weg="${escapeHtml(b.id)}" title="Bestellung löschen">🗑</button>
          </div>
        </div>
      </details>`;
}

// Eine Sammelbestellung, die schon beim Lieferanten ist: „Donnerstag 1",
// „Donnerstag 2" … Darin die Bestellungen, die in genau dieser Mail standen,
// darüber die Rechnung für genau diese Lieferung.
function esRundeHtml(r) {
  // ⚠️ Beim Laden ist ALLES zugeklappt (Michel am 04.09.2026: „beim erneuten
  // aufrufen können die bestellungen gerne geschlossen sein"). `esOffeneRunden`
  // ist beim Start leer und füllt sich nur durch echtes Aufklappen. Deshalb
  // müssen die Zahlen, auf die es beim Überfliegen ankommt – Uhrzeit, wie viele
  // schon abgeholt, was zu zahlen ist – in die zugeklappte Zeile.
  const note = [];
  if (r.orgaCent) {
    note.push("Warenwert " + essenService.centLabel(r.summeCent) + " – davon " +
      essenService.centLabel(r.orgaCent) + " auf die Organisation.");
  }
  if (r.offenCent) note.push("Davon noch " + essenService.centLabel(r.offenCent) + " zu kassieren.");

  return `
    <details class="es-runde status-${r.fertig ? "abgeholt" : "bestellt"}${r.fertig ? " fertig" : ""}" data-es-runde="${escapeHtml(r.id)}"${esOffeneRunden.has(r.id) ? " open" : ""}>
      <summary>
        <span class="es-runde-icon" aria-hidden="true">${r.fertig ? "✅" : "📦"}</span>
        <span class="es-runde-name">${escapeHtml(r.titel)}
          <span class="es-runde-zeit">${escapeHtml(essenService.zeitLabel(r.erstelltAm))}</span></span>
        <span class="es-runde-kurz">${r.abgeholt}/${r.anzahl} abgeholt · ${essenService.centLabel(r.zahltCent)}</span>
      </summary>
      <div class="es-runde-inhalt">
        <p class="hinweis-text es-zeitstempel">Rausgeschickt: <b>${escapeHtml(essenService.zeitLabel(r.erstelltAm))}</b> ·
          ${r.anzahl} Bestellung${r.anzahl === 1 ? "" : "en"}, ${r.stueck}× Essen</p>
        <div class="fr-summe-zeile es-geldzeile">
          <span>Zu zahlen für diese Lieferung</span>
          <span><b>${essenService.centLabel(r.zahltCent)}</b></span>
        </div>
        ${note.length ? `<p class="hinweis-text es-geldnote">${note.join(" ")}</p>` : ""}
        ${esBescheidHtml(r)}
        <div class="es-best-aktionen es-runde-knoepfe">
          <button type="button" class="mini-btn" data-es-runde-mail="${escapeHtml(r.id)}"
            title="Den Text dieser Sammelbestellung noch einmal ansehen">✉ Mailtext</button>
          ${r.fertig ? "" : `<button type="button" class="mini-btn" data-es-runde-bescheid="${escapeHtml(r.id)}"
            title="${r.bescheidAm
              ? "Noch einmal anstupsen – wer schon abgeholt hat, bekommt nichts"
              : "Allen Bestellern dieser Lieferung per Discord sagen, dass ihr Essen bereitliegt"}">📣 ${r.bescheidAm ? "Nochmal Bescheid" : "Bescheid geben"}</button>`}
          ${r.fertig
            // ⚠️ Auch die ganze Lieferung braucht einen Rückweg. Ohne ihn müsste
            // man nach einem Fehlklick auf „Alle abgeholt" jede Bestellung
            // einzeln aufklappen und zurücksetzen.
            ? `<button type="button" class="mini-btn" data-es-runde-zurueck="${escapeHtml(r.id)}"
                title="Doch nicht abgeholt – alle wieder auf „beim Lieferanten bestellt“">↺ doch nicht abgeholt</button>`
            : `<button type="button" class="mini-btn primary" data-es-runde-da="${escapeHtml(r.id)}"
                title="Das Essen ist da und alle haben es geholt">Alle abgeholt</button>`}
        </div>
        ${r.bestellungen.map(esBestellungHtml).join("")}
      </div>
    </details>`;
}

// Das Ergebnis des letzten Bescheid-Laufs, je Lieferung gemerkt.
// \u26a0\ufe0f Als Modul-Variable, nicht als Text irgendwo im DOM: die Bestellliste
// zeichnet sich bei jeder \u00c4nderung neu, und die Nachfassliste w\u00e4re dann sofort
// wieder weg - genau die Liste, wegen der man den Knopf gedr\u00fcckt hat.
let esBescheidStand = {};

function esBescheidHtml(r) {
  // \u26a0\ufe0f Die Uhrzeit kommt aus Firebase und steht deshalb auch nach einem
  // Neuladen noch da. Michel am 04.09.2026: \u201ebei bescheid geben auch den
  // zeitpunkt rein wann bescheid gegeben wurde." Ohne sie ist nicht zu
  // erkennen, ob ueberhaupt schon jemand benachrichtigt wurde.
  const wann = r.bescheidAm
    ? `<p class="hinweis-text es-bescheid-wann">\ud83d\udce3 Bescheid gegeben: <b>${escapeHtml(essenService.zeitLabel(r.bescheidAm))}</b>${
        r.bescheidErreicht ? " \u00b7 " + r.bescheidErreicht + " erreicht" : ""}</p>`
    : "";

  const e = esBescheidStand[r.id];
  if (!e) return wann;
  if (e.laeuft) return wann + `<p class="hinweis-text es-bescheid-lauf">Schicke Nachrichten \u2026</p>`;
  if (e.fehler) return wann + `<p class="hinweis-text fehler">${escapeHtml(e.fehler)}</p>`;

  const gut = e.geschickt
    ? `<b>\u2705 ${e.geschickt} benachrichtigt.</b>`
    : `<b>Niemand erreicht.</b>`;
  const ohne = e.uebersprungen && e.uebersprungen.length
    ? `<br>Ohne ${escapeHtml(e.uebersprungen.join(", "))} \u2013 schon abgeholt.`
    : "";
  // \u26a0\ufe0f Die Nachfassliste ist der Punkt der ganzen \u00dcbung. Ohne sie h\u00e4lt Michel
  // alle f\u00fcr informiert - und wer keine Nachricht bekam, holt sein Essen nie ab.
  const schlecht = e.offen && e.offen.length
    ? `<br><b>\u26a0\ufe0f ${e.offen.length} nicht erreicht \u2013 diesen Leuten selbst Bescheid sagen:</b><br>` +
      e.offen.map((o) => `\u2022 ${escapeHtml(o.nickname)} \u2013 ${escapeHtml(o.grund)}`).join("<br>")
    : "";
  return wann + `<p class="hinweis-text es-bescheid${e.offen && e.offen.length ? " es-bescheid-luecke" : ""}">${gut}${ohne}${schlecht}</p>`;
}

// "Dein Essen ist da" an alle Besteller dieser Lieferung.
//
// \u26a0\ufe0f Der Client schickt NAMEN, keine Discord-IDs - die kennt er gar nicht und
// soll er auch nicht kennen. Nachgeschlagen wird im Worker.
async function esBescheidGeben(runde, knopf) {
  // Dieselbe Person kann mehrere Bestellungen in einer Lieferung haben; der
  // Worker wirft Doppelte weg, aber die Zahl in der R\u00fcckfrage muss schon hier
  // stimmen, sonst steht dort eine Zahl, die niemand wiederfindet.
  //
  // ⚠️ Mitgeschickt wird auch, WAS die Person bestellt hat – Michel am
  // 04.09.2026: „nicht nur donnerstag 2 sondern auch das bestellte essen".
  // Hat jemand zwei Bestellungen in derselben Lieferung, werden deren Posten
  // hier zusammengelegt: eine Person, eine Nachricht, alle ihre Zeilen darin.
  //
  // \u26a0\ufe0f Wer sein Essen schon geholt hat, bekommt NICHTS mehr. Michel am
  // 04.09.2026: \u201eich denke es ist so gebaut das wenn abgeholt und ich erneut
  // bescheid gebe ich keine weitere nachricht bekomme, oder?" \u2013 war es nicht,
  // es ging an alle. Ein zweites \u201edein Essen ist da" an jemanden, der schon
  // gegessen hat, macht die Nachricht wertlos.
  const namen = [];
  const posten = new Map();
  const gesehen = new Set();
  const schonDa = [];
  runde.bestellungen.forEach((b) => {
    const roh = String(b.name || "").trim();
    const k = roh.toLowerCase();
    if (!k) return;
    if (b.status === "abgeholt") {
      if (schonDa.indexOf(roh) < 0) schonDa.push(roh);
      return;
    }
    if (!gesehen.has(k)) {
      gesehen.add(k);
      namen.push(roh);
      posten.set(k, []);
    }
    b.positionen.forEach((p) => {
      posten.get(k).push({ anzahl: p.anzahl, gericht: p.name, sonderwunsch: p.sonderwunsch });
    });
  });
  // Hat jemand zwei Bestellungen und nur eine davon abgeholt, gehoert er nicht
  // in die "schon da"-Liste \u2013 er wartet ja noch auf die andere.
  const wirklichSchonDa = schonDa.filter((n) => gesehen.has(n.toLowerCase()) === false);

  if (!namen.length) {
    esBescheidStand[runde.id] = {
      fehler: wirklichSchonDa.length
        ? "Alle haben ihr Essen schon geholt \u2013 da ist nichts mehr zu melden."
        : "In dieser Lieferung steht kein Name.",
    };
    esRender(esZustand);
    return;
  }
  if (!confirm(namen.length + (namen.length === 1 ? " Person" : " Leuten") + " per Discord sagen, dass das Essen da ist?" +
      (wirklichSchonDa.length ? "\n\nOhne " + wirklichSchonDa.join(", ") + " \u2013 schon abgeholt." : "") +
      "\n\nWer keine Discord-ID hinterlegt hat, bekommt nichts \u2013 die stehen danach in einer Liste zum Nachfassen.")) return;

  knopf.disabled = true;
  esBescheidStand[runde.id] = { laeuft: true };
  esRender(esZustand);
  try {
    // `nicknames` bleibt mit drin: rollt der Worker einmal zurueck, geht der
    // Bescheid weiterhin raus – nur ohne die Essensliste.
    const daten = await kontenRufe("discord-sammel", {
      leute: namen.map((n) => ({ name: n, posten: posten.get(n.toLowerCase()) || [] })),
      nicknames: namen,
      titel: runde.titel,
    });
    esBescheidStand[runde.id] = {
      geschickt: daten.geschickt || 0,
      offen: daten.offen || [],
      uebersprungen: wirklichSchonDa,
    };
    // Uhrzeit festhalten, damit sie ein Neuladen überlebt. ⚠️ Erst NACH dem
    // Versand – vorher stünde dort eine Zeit, obwohl nichts rausging.
    const merk = await essenService.setzeBescheid(runde.id, daten.geschickt || 0);
    if (!merk.erfolg) esZeigeFehler("es-admin-fehler", merk.fehler);
  } catch (e) {
    esBescheidStand[runde.id] = { fehler: e.message };
  }
  esRender(esZustand);
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

    <p class="feld-label es-gruppe-titel">Stapel – noch nicht rausgeschickt (${z.stapel.length})</p>
    ${z.stapel.length
      ? z.stapel.map(esBestellungHtml).join("")
      : `<p class="fr-leer-hinweis">Alles ist beim Lieferanten. Was neu bestellt wird, sammelt sich hier.</p>`}

    ${!z.altbestand.length ? "" : `
      <p class="feld-label es-gruppe-titel">Ohne Sammelbestellung (${z.altbestand.length})</p>
      <p class="hinweis-text es-altbestand-note">${z.altbestand.length === 1
        ? "Diese Bestellung ist beim Lieferanten, gehört aber zu keiner Sammelbestellung – sie stammt noch aus der Zeit davor. Trag sie nach, dann lässt sie sich mit abrechnen. Oder hak sie einfach ab."
        : "Diese Bestellungen sind beim Lieferanten, gehören aber zu keiner Sammelbestellung – sie stammen noch aus der Zeit davor. Trag sie nach, dann lassen sie sich mit abrechnen. Oder hak sie einfach ab."}</p>
      <div class="es-best-aktionen es-runde-knoepfe">
        <button type="button" class="mini-btn primary" id="es-btn-nachtragen"
          title="Als eigene Sammelbestellung eintragen">Als „${escapeHtml((z.meta && z.meta.titel ? z.meta.titel : "Bestellung") + " " + z.naechsteRundeNr)}“ nachtragen</button>
      </div>
      ${z.altbestand.map(esBestellungHtml).join("")}`}

    ${z.runden.length ? `<p class="feld-label es-gruppe-titel">Beim Lieferanten (${z.runden.length})</p>` : ""}
    ${z.runden.map(esRundeHtml).join("")}`;

  // Altbestand nachtragen: eine Sammelbestellung aus dem, was schon raus ist.
  // ⚠️ Der Stand bleibt dabei stehen – ein „abgeholt" darf nicht wieder auf
  // „bestellt" zurückfallen, siehe esSchickeRunde.
  const nachtragen = esEl("es-btn-nachtragen");
  if (nachtragen) nachtragen.addEventListener("click", async () => {
    const ids = esZustand.altbestand.map((b) => b.id);
    if (!ids.length) return;
    if (!confirm("Diese " + ids.length + (ids.length === 1 ? " Bestellung" : " Bestellungen") +
        " als eine Sammelbestellung eintragen?")) return;
    const res = await essenService.schickeRunde(ids);
    if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
  });

  box.querySelectorAll("[data-es-runde]").forEach((d) => {
    d.addEventListener("toggle", () => {
      if (d.open) esOffeneRunden.add(d.dataset.esRunde);
      else esOffeneRunden.delete(d.dataset.esRunde);
    });
  });
  box.querySelectorAll("[data-es-runde-mail]").forEach((btn) => {
    btn.addEventListener("click", () => {
      esMailAuswahl = "runde:" + btn.dataset.esRundeMail;
      esRenderSammelmail(esZustand);
      esEl("es-sammelmail").scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });
  box.querySelectorAll("[data-es-runde-bescheid]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = esZustand.runden.find((x) => x.id === btn.dataset.esRundeBescheid);
      if (r) esBescheidGeben(r, btn);
    });
  });

  box.querySelectorAll("[data-es-runde-zurueck]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const r = esZustand.runden.find((x) => x.id === btn.dataset.esRundeZurueck);
      if (!r) return;
      if (!confirm("Alle " + r.anzahl + " Bestellungen aus „" + r.titel + "“ wieder auf „beim Lieferanten bestellt“ setzen?")) return;
      const res = await essenService.setzeRundeStatus(r.id, "bestellt");
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-runde-da]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const r = esZustand.runden.find((x) => x.id === btn.dataset.esRundeDa);
      if (!r) return;
      if (!confirm("Alle " + r.anzahl + " Bestellungen aus „" + r.titel + "“ als abgeholt eintragen?")) return;
      const res = await essenService.setzeRundeStatus(r.id, "abgeholt");
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
      // ⚠️ Wer noch nicht bezahlt hat, wird nicht mit abgehakt. Das muss
      // dranstehen, sonst sieht es aus, als hätte der Knopf nur halb gewirkt.
      else if (res.offen && res.offen.length) {
        esZeigeFehler("es-admin-fehler",
          "Ohne " + res.offen.join(", ") + " – da fehlt noch das Geld.");
      }
    });
  });

  box.querySelectorAll("[data-es-offen]").forEach((d) => {
    d.addEventListener("toggle", () => {
      // ⚠️ Ohne dieses Merken klappt jede Bestellung wieder zu, sobald irgendwo
      // ein Status gesetzt wird – genau bei der Tätigkeit, für die die Liste da ist.
      if (d.open) esOffeneBestellungen.add(d.dataset.esOffen);
      else esOffeneBestellungen.delete(d.dataset.esOffen);
    });
  });
  // ⚠️ Ziel und Rückweg kommen aus dem Service (`naechsterStatus`,
  // `zurueckStatus`), nicht aus der Kette gerechnet: in einer Sammelbestellung
  // überspringt „Hat bezahlt" den Schritt „bestellt", der dort schon wahr ist.
  box.querySelectorAll("[data-es-weiter]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esWeiter);
      if (!b || !b.naechsterStatus) return;
      const res = await essenService.setzeStatus(b.id, b.naechsterStatus);
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-zurueck]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esZurueck);
      if (!b || !b.zurueckStatus) return;
      const res = await essenService.setzeStatus(b.id, b.zurueckStatus);
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-raus]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esRaus);
      if (!b) return;
      if (!confirm(b.name + " wieder aus der Sammelbestellung nehmen? Die Bestellung landet dann zurück im Stapel.")) return;
      const res = await essenService.nimmAusRunde(b.id);
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-mail]").forEach((btn) => {
    btn.addEventListener("click", () => {
      esMailAuswahl = "einzeln:" + btn.dataset.esMail;
      esRenderSammelmail(esZustand);
      esEl("es-sammelmail").scrollIntoView({ block: "start", behavior: "smooth" });
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

// --- Statistik ----------------------------------------------------------------

// Zugeklappt, weil sie zum Arbeiten nicht gebraucht wird. ⚠️ Der Zustand liegt
// hier und nicht am Element: der Kasten wird bei jeder Änderung neu gezeichnet
// und spränge sonst bei jeder fremden Bestellung wieder zu.
let esStatistikOffen = false;

function esRenderStatistik(z) {
  const box = esEl("es-statistik");
  if (!box) return;
  if (!z.bestellungen.length) {
    box.innerHTML = `<p class="feld-label">Statistik</p>
      <p class="fr-leer-hinweis">Sobald bestellt wird, steht hier, wer vorn liegt.</p>`;
    return;
  }

  const st = essenService.statistik(z.bestellungen, z.runden);
  // Der Balken macht den Abstand sichtbar. ⚠️ Prozent vom Spitzenwert, nicht von
  // der Gesamtzahl – sonst sind bei zehn Leuten alle Balken gleich kurz.
  const balken = (wert) => Math.max(4, Math.round((wert / (st.spitzenwert || 1)) * 100));
  const medaille = ["🥇", "🥈", "🥉"];

  box.innerHTML = `
    <details class="es-statistik"${esStatistikOffen ? " open" : ""}>
      <summary>
        <span class="es-statistik-icon" aria-hidden="true">📊</span>
        <span class="es-statistik-titel">Statistik</span>
        <span class="es-statistik-kurz">${st.anzahlBestellungen} Bestellung${st.anzahlBestellungen === 1 ? "" : "en"} von ${st.anzahlLeute} ${st.anzahlLeute === 1 ? "Person" : "Leuten"}</span>
      </summary>
      <div class="es-statistik-inhalt">
        <p class="feld-label">Wer am meisten bestellt hat</p>
        ${st.leute.map((p) => `
          <div class="es-stat-zeile">
            <span class="es-stat-platz">${p.platz <= 3 ? medaille[p.platz - 1] : p.platz + "."}</span>
            <span class="es-stat-mitte">
              <span class="es-stat-name">${escapeHtml(p.name)}${p.orgaAnzahl ? ` <span class="es-stat-orga" title="${p.orgaAnzahl} davon auf die Organisation">🛠</span>` : ""}</span>
              <span class="es-stat-balken"><i style="width:${balken(p.anzahl)}%"></i></span>
              <span class="es-stat-detail">${p.anzahl} Bestellung${p.anzahl === 1 ? "" : "en"} · ${p.stueck}× Essen</span>
            </span>
            <span class="es-stat-wert">${essenService.centLabel(p.summeCent)}</span>
          </div>`).join("")}

        <p class="feld-label">Was am meisten bestellt wurde</p>
        ${st.gerichte.map((g) => `
          <div class="es-stat-zeile">
            <span class="es-stat-platz">${g.platz <= 3 ? medaille[g.platz - 1] : g.platz + "."}</span>
            <span class="es-stat-mitte">
              <span class="es-stat-name">${escapeHtml(g.name)}</span>
              <span class="es-stat-balken"><i style="width:${Math.max(4, Math.round((g.anzahl / (st.gerichte[0].anzahl || 1)) * 100))}%"></i></span>
              <span class="es-stat-detail">${g.anzahl}× bestellt</span>
            </span>
            <span class="es-stat-wert">${essenService.centLabel(g.summeCent)}</span>
          </div>`).join("")}

        <div class="fr-summe-zeile es-geldzeile">
          <span>${st.anzahlStueck}× Essen${st.anzahlRunden
            ? " in " + st.anzahlRunden + " Lieferung" + (st.anzahlRunden === 1 ? "" : "en")
            : ", noch nichts rausgeschickt"}</span>
          <span><b>${essenService.centLabel(st.summeCent)}</b></span>
        </div>
        <p class="hinweis-text es-geldnote">Die Beträge sind der <b>Warenwert</b>, nicht das kassierte Geld – Orga-Essen (🛠) zählt mit.</p>
      </div>
    </details>`;

  const d = box.querySelector("details");
  if (d) d.addEventListener("toggle", () => { esStatistikOffen = d.open; });
}

// --- Sammelbestellung + E-Mail -----------------------------------------------

// Welche Bestellungen gehen in die Mail? „bezahlt" ist der Normalfall: erst
// zahlen, dann bestellen wir. Die zweite Wahl nimmt die noch nicht bezahlten
// mit – für den Fall, dass jemand später zahlt und das Essen trotzdem mit soll.
//
// ⚠️ Dritte Möglichkeit: `einzeln:<id>` – EINE Bestellung für sich allein.
// Michel am 2026-09-04: „jeder tag kann mehrere bestellungen haben, die einzeln
// abzuwickeln sind." Auf der LAN kommt nicht jeder gleichzeitig; wer um 18 Uhr
// bezahlt, soll nicht warten müssen, bis um 20 Uhr genug für eine Sammelmail
// zusammen ist. Der Sammelweg bleibt der Normalfall und ist unangetastet.
function esEinzelId() {
  return String(esMailAuswahl).indexOf("einzeln:") === 0 ? String(esMailAuswahl).slice(8) : null;
}

// Vierte Möglichkeit: `runde:<id>` – der Text einer Sammelbestellung, die schon
// raus ist. Zum Nachlesen und zum Nachschicken, wenn beim Lieferanten etwas
// untergegangen ist. ⚠️ Daraus entsteht KEINE neue Runde; sie ist ja schon eine.
function esRundeAuswahlId() {
  return String(esMailAuswahl).indexOf("runde:") === 0 ? String(esMailAuswahl).slice(6) : null;
}

// ⚠️ Alle drei Sammelwege greifen auf `ohneRunde` zu, nicht auf `bestellungen`.
// Was schon in einer Mail beim Lieferanten steht, darf nicht ein zweites Mal in
// eine neue Mail rutschen – das wäre doppelt bestellt und doppelt kassiert.
function esMailBestellungen(z) {
  const rid = esRundeAuswahlId();
  if (rid) {
    const r = z.runden.find((x) => x.id === rid);
    return r ? r.bestellungen : [];
  }
  const einzeln = esEinzelId();
  if (einzeln) return z.ohneRunde.filter((b) => b.id === einzeln);
  if (esMailAuswahl === "offen") return z.ohneRunde.filter((b) => b.status === "neu" || b.status === "bezahlt");
  return z.ohneRunde.filter((b) => b.status === "bezahlt");
}

function esRenderSammelmail(z) {
  const box = esEl("es-sammelmail");
  // ⚠️ Die einzeln gewählte Bestellung kann inzwischen weg sein (gelöscht oder
  // vom Besteller storniert). Dann zurück auf den Sammelweg, statt einen leeren
  // Kasten mit dem Namen eines Geistes zu zeigen.
  if ((esEinzelId() || esRundeAuswahlId()) && !esMailBestellungen(z).length) esMailAuswahl = "bezahlt";
  const auswahl = esMailBestellungen(z);
  const einzeln = esEinzelId() ? auswahl[0] : null;
  const runde = esRundeAuswahlId() ? z.runden.find((x) => x.id === esRundeAuswahlId()) : null;
  const brief = essenService.bestelltext(auswahl, z.meta);
  // Für die Radioknöpfe zählt nur der Stapel – die Zahl in Klammern muss zu
  // dem passen, was der Knopf darunter dann wirklich verschickt.
  const stapelBezahlt = z.ohneRunde.filter((b) => b.status === "bezahlt").length;
  const stapelNeu = z.ohneRunde.filter((b) => b.status === "neu").length;

  // Die Vorschau zeigt dieselbe Trennung wie der Brief: was die Teilnehmer
  // bezahlen und was auf die Organisation geht. ⚠️ Beides aus `brief`, nicht
  // noch einmal selbst gerechnet – zwei Rechenwege driften auseinander, und
  // dann verspricht die Vorschau etwas anderes als der Text darunter.
  // Eine Liste, wie im Brief: die Küche macht fünf Salami, egal wer sie zahlt.
  // ⚠️ Rechts steht, was ZU ZAHLEN ist, nicht der Warenwert. Für ein Orga-Essen
  // sind das 0,00 € – dort 10,00 € hinzuschreiben behauptete Geld, das niemand
  // bringt. Der Warenwert steht darunter als Nebensatz.
  const listeHtml = !brief.liste.length ? "" : `
    <div class="fr-einkaufsliste">
      ${brief.liste.map((p) => `
        <div class="fr-einkauf-zeile es-mail-zeile">
          <span>
            <b>${p.anzahl}×</b> ${escapeHtml(p.name)}${p.sonderwunsch ? ` <i>(${escapeHtml(p.sonderwunsch)})</i>` : ""}
            ${p.preisEinheitlich && p.preisCent ? `<span class="es-stueckpreis">à ${essenService.centLabel(p.preisCent)}</span>` : ""}
            ${p.anzahlOrga ? `<span class="es-orga-vermerk">${p.anzahlOrga >= p.anzahl ? "🛠 Organisation" : "davon " + p.anzahlOrga + "× 🛠 Organisation"}</span>` : ""}
          </span>
          <b class="${p.zahltCent ? "" : "es-nix-zu-zahlen"}">${essenService.centLabel(p.zahltCent)}</b>
        </div>`).join("")}
    </div>
    <div class="fr-summe-zeile es-mail-gesamt">
      <span>${brief.anzahlBestellungen} Bestellung${brief.anzahlBestellungen === 1 ? "" : "en"}, ${brief.anzahlPositionen} Stück</span>
      <span>zu zahlen <b>${essenService.centLabel(brief.zahltCent)}</b></span>
    </div>
    ${brief.orgaCent ? `<p class="hinweis-text es-geldnote">Warenwert ${essenService.centLabel(brief.summeCent)} –
      davon ${essenService.centLabel(brief.orgaCent)} für die Organisation, die nicht bezahlt werden.</p>` : ""}`;

  // mailto: hat in der Praxis eine Längengrenze (je nach Mailprogramm ab etwa
  // 2000 Zeichen). Darüber kommt die Mail leer oder abgeschnitten an – deshalb
  // wird gewarnt statt so getan, als ginge es.
  const mailto = "mailto:" + encodeURIComponent(brief.empfaenger) +
    "?subject=" + encodeURIComponent(brief.betreff) +
    "&body=" + encodeURIComponent(brief.text);
  const zuLang = mailto.length > 1900;

  box.innerHTML = `
    <p class="feld-label">Sammelbestellung an den Lieferanten</p>

    ${runde
      ? `<div class="es-mail-wahl">
           <span>Sammelbestellung <b>${escapeHtml(runde.titel)}</b> – am ${escapeHtml(essenService.zeitLabel(runde.erstelltAm))} rausgegangen</span>
           <button type="button" class="mini-btn" id="es-btn-alle-zeigen">← zurück zum Stapel${z.stapel.length ? " (" + z.stapel.length + ")" : ""}</button>
         </div>`
      : einzeln
      // Bewusst dieselbe Klasse wie die Radio-Zeile darunter: gleiche Zeile,
      // gleicher Platz, und es braucht keine neue Regel im Stylesheet.
      ? `<div class="es-mail-wahl">
           <span>Nur die Bestellung von <b>${escapeHtml(einzeln.name)}</b></span>
           <button type="button" class="mini-btn" id="es-btn-alle-zeigen">← alle zusammen</button>
         </div>`
      : `<div class="es-mail-wahl">
           <label><input type="radio" name="es-mailwahl" value="bezahlt" ${esMailAuswahl === "bezahlt" ? "checked" : ""}> nur bezahlte (${stapelBezahlt})</label>
           <label><input type="radio" name="es-mailwahl" value="offen" ${esMailAuswahl === "offen" ? "checked" : ""}> auch unbezahlte (${stapelNeu + stapelBezahlt})</label>
         </div>`}

    ${!auswahl.length ? `
      <p class="fr-leer-hinweis">${esMailAuswahl === "bezahlt" && stapelNeu
        // ⚠️ „Keine Bestellung" ist hier nur die halbe Wahrheit: es liegen
        // welche da, sie sind bloß nicht bezahlt. Ohne diesen Satz sieht es
        // aus, als ginge gerade gar nichts.
        ? "Keine bezahlte Bestellung im Stapel. Es " + (stapelNeu === 1 ? "wartet aber eine unbezahlte" : "warten aber " + stapelNeu + " unbezahlte") + " – nimm „auch unbezahlte“, wenn sie mit sollen."
        : "Auf diesem Stand liegt gerade keine Bestellung."}</p>
    ` : `
      ${listeHtml}

      <label class="feld-label" for="es-mail-text">E-Mail-Text</label>
      <textarea id="es-mail-text" class="eingabe es-mail-text" rows="12" spellcheck="false">${escapeHtml(brief.text)}</textarea>
      <p class="hinweis-text">Der Text lässt sich hier noch ändern, bevor er rausgeht. Namen der Besteller stehen bewusst nicht drin. Bei Gerichten, von denen welche auf die Organisation gehen, steht dabei, wie viele – und was dafür wirklich zu zahlen ist.</p>

      <div class="es-mail-knoepfe">
        <button type="button" class="btn btn-secondary" id="es-btn-kopieren">Text kopieren</button>
        ${brief.empfaenger
          ? `<a class="btn btn-primary es-mail-link" id="es-mail-link" href="${escapeHtml(mailto)}">E-Mail öffnen</a>`
          : `<button type="button" class="btn btn-primary" disabled title="Erst die E-Mail-Adresse des Lieferanten eintragen">E-Mail öffnen</button>`}
      </div>
      ${!brief.empfaenger ? `<p class="hinweis-text">Für „E-Mail öffnen“ fehlt noch die Adresse des Lieferanten – trag sie unten bei den Einstellungen ein.</p>` : ""}
      ${zuLang ? `<p class="hinweis-text">⚠️ Der Text ist lang. Manche Mailprogramme schneiden ihn ab – wenn die Mail leer aufgeht, nimm „Text kopieren“ und füg ihn von Hand ein.</p>` : ""}

      ${runde
        ? `<p class="hinweis-text">Diese Sammelbestellung ist schon raus. Der Text steht hier zum Nachlesen und zum Nachschicken – es entsteht daraus keine zweite Bestellung.</p>
           ${!z.stapel.length ? "" : `
             <button class="btn btn-secondary btn-grow" id="es-btn-naechste">Nächste Sammelbestellung: ${z.stapel.length} ${z.stapel.length === 1 ? "Bestellung wartet" : "Bestellungen warten"} im Stapel</button>
             <p class="hinweis-text">Die nächste kann sofort raus – die vorige muss dafür nicht geliefert sein.</p>`}`
        : `<button class="btn btn-secondary btn-grow" id="es-btn-alle-bestellt">Ist raus – als „${escapeHtml(
             (z.meta && z.meta.titel ? z.meta.titel : "Bestellung") + " " + z.naechsteRundeNr
           )}“ festhalten</button>
      <p class="hinweis-text">Erst klicken, wenn die Mail wirklich raus ist. ${einzeln ? "Diese eine Bestellung" : "Diese " + auswahl.length + " Bestellungen"} wandern dann zusammen in eine eigene Sammelbestellung, die du hinterher einzeln abrechnen kannst.</p>`}
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

  const zurueckBtn = esEl("es-btn-alle-zeigen");
  if (zurueckBtn) zurueckBtn.addEventListener("click", () => {
    esMailAuswahl = "bezahlt";
    esRenderSammelmail(esZustand);
  });

  // Aus der Ansicht einer schon verschickten Runde direkt in die nächste.
  // ⚠️ Der Weg dorthin war vorher nur der kleine Link ganz oben im Kasten –
  // Michel am 2026-09-04: „Es muss möglich sein, eine weitere Sammelbestellung
  // rauszujagen, obwohl die andere noch gar nicht da ist." Ging schon, war aber
  // von hier aus nicht zu sehen.
  const naechsteBtn = esEl("es-btn-naechste");
  if (naechsteBtn) naechsteBtn.addEventListener("click", () => {
    // Steht im Stapel nur Unbezahltes, sonst landet man auf einem leeren Kasten.
    esMailAuswahl = esZustand.stapel.some((b) => b.status === "bezahlt") ? "bezahlt" : "offen";
    esRenderSammelmail(esZustand);
    esEl("es-sammelmail").scrollIntoView({ block: "start", behavior: "smooth" });
  });

  const alleBtn = esEl("es-btn-alle-bestellt");
  if (alleBtn) alleBtn.addEventListener("click", async () => {
    const vorher = esMailAuswahl;
    const ids = auswahl.map((b) => b.id);
    if (!einzeln && !confirm("Diese " + ids.length + " Bestellungen als eine Sammelbestellung festhalten?")) return;
    // ⚠️ Die Ansicht VOR dem Schreiben zurückstellen. Das Schreiben löst über
    // Firebase sofort ein Neuzeichnen aus – käme die Umstellung erst danach,
    // stünde dort weiter „Nur die Bestellung von …" mit einer Bestellung, die
    // schon durch ist. Genau so beim Bauen gesehen.
    esMailAuswahl = "bezahlt";
    // Ein Aufruf für beide Fälle: eine einzelne Bestellung ist eine
    // Sammelbestellung mit genau einer Zeile. Zwei Wege wären zwei Stellen, an
    // denen die Runde entstehen kann – und eine davon würde irgendwann anders
    // funktionieren als die andere.
    const res = await essenService.schickeRunde(ids);
    if (!res.erfolg) {
      esMailAuswahl = vorher;   // hat nicht geklappt, also zurück in die alte Sicht
      esRenderSammelmail(esZustand);
      esZeigeFehler("es-mail-fehler", res.fehler);
    }
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
  // ⚠️ `annahmeOffen` im Zustand ist der Schalter UND das Zeitfenster zusammen.
  // Das Haekchen darf nur den SCHALTER zeigen, sonst springt es abends von
  // allein auf „zu" und der Veranstalter sucht den Fehler bei sich.
  setze("es-ein-von", z.fensterVon === null ? "" : essenService.uhrLabel(z.fensterVon));
  setze("es-ein-bis", z.fensterBis === null ? "" : essenService.uhrLabel(z.fensterBis));

  const schalter = esEl("es-ein-annahme");
  if (schalter && document.activeElement !== schalter) schalter.checked = z.schalterAn;

  const stand = esEl("es-ein-fensterstand");
  if (stand) {
    stand.textContent = !z.fensterLabel
      ? "Ohne Zeiten laeuft die Annahme rund um die Uhr."
      : (z.imFenster
          ? "Zeitfenster " + z.fensterLabel + " – gerade offen."
          : "Zeitfenster " + z.fensterLabel + " – gerade zu.");
  }
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
      annahmeVon: esMinutenAusZeit(esEl("es-ein-von").value),
      annahmeBis: esMinutenAusZeit(esEl("es-ein-bis").value),
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
