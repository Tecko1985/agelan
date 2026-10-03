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
// Ab der ersten Eingabe in einem Einstellungsfeld gehört DIESES Feld dem
// Veranstalter, bis gespeichert ist (wie frEinstellungenBeruehrt beim Frühstück).
// ⚠️ Je Feld, nicht über alle acht: sonst fror die erste Eingabe auch die Felder
// ein, die niemand angefasst hat, und „Speichern“ schrieb einen inzwischen auf
// einem anderen Gerät geänderten Tag zurück (Bugjagd 25.09.d T5a-1c).
const esEinstellungenBeruehrt = new Set();
// Solange der Veranstalter im Mailtext etwas geändert hat: { basis } = der
// erzeugte Text, auf dem die Änderung beruht. ⚠️ Dann zeichnet ein Live-Update
// (30-s-Takt, fremde Bestellung) den Kasten NICHT neu – sonst wäre die Änderung
// weg, obwohl der Hinweis darunter zusagt, dass sie mitgeht.
let esMailBearbeitet = null;
// Sobald „E-Mail öffnen“ oder „Text kopieren“ geklickt ist: { basis } wie oben.
// ⚠️ Ab da ist der Kasten eingefroren wie bei einem geänderten Text. „Ist raus“
// hält sonst die Auswahl des LETZTEN Neuzeichnens fest – und das kann nach
// einem Live-Update (Kasse hakt ab, Besteller ändert) etwas anderes sein als
// das, was in der Mail stand (Bugjagd 25.09.d T5a-1a).
let esMailGeoeffnet = null;

// Vor einem Ansichtswechsel im Mail-Kasten: geänderten Text nicht still verwerfen.
function esMailVerwerfen() {
  if (esMailBearbeitet && !confirm("Deine Änderungen am E-Mail-Text gehen dabei verloren. Trotzdem wechseln?")) return false;
  esMailBearbeitet = null;
  esMailGeoeffnet = null;
  return true;
}

// Was von einer Bestellung in der Mail steht: Gerichte, Mengen, Preise,
// Sonderwünsche und ob sie auf die Organisation geht. ⚠️ Nicht nur
// `aktualisiertAm` vergleichen – das zeigt nur, dass geschrieben wurde, nicht
// ob sich am Mailtext etwas ändert, und fehlt bei Altbestand ganz.
function esMailFingerabdruck(b) {
  return JSON.stringify([!!b.orga, (b.positionen || []).map((p) =>
    [p.nummer, p.name, p.preisCent, p.anzahl, p.sonderwunsch])]);
}
const ES_EIN_FELDER = ["es-ein-titel", "es-ein-lieferant", "es-ein-email", "es-ein-besteller",
  "es-ein-telefon", "es-ein-hinweis", "es-ein-von", "es-ein-bis"];
const esOffeneBestellungen = new Set();  // aufgeklappte Bestellungen im Admin-Bereich
// Aufgeklappte Sammelbestellungen. ⚠️ Beim Laden LEER: alles ist zugeklappt,
// und nur was der Veranstalter selbst aufklappt, landet hier. Bis zum
// 04.09.2026 sprang jede nicht fertige Runde von allein auf; bei einem Abend
// mit acht Lieferungen ist das eine Bildschirmlänge, durch die man erst
// scrollen muss.
const esOffeneRunden = new Set();
// Suche und aufgeklappte Kategorien der Speisekarte. ⚠️ Beides lebt nur hier im
// Speicher: eine Suche gehört zum Moment, nicht in die Datenbank, und der
// Aufklapp-Zustand geht nach dem Neuladen bewusst wieder auf Anfang.
let esSuchtext = "";
const esOffeneKategorien = new Set();

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

// Stückpreis einer Korbzeile: Karte + gewählte Extras. Nur Anzeige – den
// echten Preis rechnet essenService.bestelle aus dem Sonderwunsch-Text.
function esPosStueckCent(pos, g) {
  return g ? g.preisCent + essenService.extrasCent(essenService.extrasText(pos.extras, "")) : 0;
}

// Wozu Extras keinen Sinn ergeben: Getränke, Salate (Dressing kommt mit), Desserts.
function esExtrasMoeglich(g) {
  return !!g && !/getr[äa]nk|drink|dessert|nachtisch|salat/i.test((g.kategorie || "") + " " + (g.name || ""));
}

function esKorbSummeCent() {
  if (!esZustand) return 0;
  return esEntwurf.positionen.reduce((summe, pos) => {
    const g = esZustand.karte.find((x) => x.id === pos.gerichtId);
    return summe + esPosStueckCent(pos, g) * pos.anzahl;
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
  else esKorbPreiseAuffrischen();
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
// Salate kommen mit Essig und Öl oder Dressing nach Art des Hauses (Michel,
// 2026-10-01). Die Karte liegt in Firebase – darum hier für jedes Gericht,
// das „Salat“ im Namen oder in der Kategorie trägt, statt in jeder Beschreibung.
// Dressing-Auswahl bei Salaten (Michel am 01.10.2026), Standard Essig und Öl.
// ⚠️ Steht im Sonderwunsch VOR dem freien Text („Essig und Öl, ohne Zwiebeln“),
// so liest die Küche es in der Mail mit und es braucht kein neues
// Datenbankfeld. Beim Ändern einer Bestellung wird es von dort zurückgelesen –
// die Texte deshalb nie umformulieren, solange Bestellungen laufen.
const ES_DRESSINGS = ["Essig und Öl", "Dressing nach Art des Hauses"];

// Sonderwunsch-Rest → { dressing, rest }. Nur bei Salaten aufgerufen.
function esDressingZerlegen(text) {
  const t = String(text || "").trim();
  const d = ES_DRESSINGS.find((x) => t === x || t.startsWith(x + ", "));
  return d ? { dressing: d, rest: t.slice(d.length).replace(/^,\s*/, "") } : { dressing: ES_DRESSINGS[0], rest: t };
}

const ES_SALAT_HINWEIS = "Wahlweise mit Essig und Öl oder Dressing nach Art des Hauses – auswählen im Warenkorb.";
function esIstSalat(g) {
  return /salat/i.test((g.name || "") + " " + (g.kategorie || ""));
}

// Eine Zeile der Speisekarte.
function esGerichtHtml(g, darfBestellen) {
  return `
          <div class="es-gericht">
            ${g.nummer ? `<div class="es-gericht-nr">${escapeHtml(g.nummer)}</div>` : ""}
            <div class="es-gericht-info">
              <div class="es-gericht-name">${escapeHtml(g.name)}</div>
              ${g.beschreibung ? `<div class="es-gericht-beschreibung">${escapeHtml(g.beschreibung)}</div>` : ""}
              ${esIstSalat(g) ? `<div class="es-gericht-salat">🥗 ${ES_SALAT_HINWEIS}</div>` : ""}
            </div>
            <div class="es-gericht-preis">${g.preisCent ? essenService.centLabel(g.preisCent) : "kostenlos"}</div>
            <button type="button" class="es-plus" data-es-hinzu="${escapeHtml(g.id)}"
              title="Auf die Bestellung setzen" aria-label="${escapeHtml(g.nummer ? "Nummer " + g.nummer + ", " : "")}${escapeHtml(g.name)} auf die Bestellung setzen"
              ${darfBestellen ? "" : "disabled"}>+</button>
          </div>`;
}

function esRenderKarte(z) {
  const box = esEl("es-karte");
  if (!z.karte.length) {
    box.innerHTML = `<div class="karte-block"><p class="fr-leer-hinweis">Auf der Speisekarte steht noch nichts.${z.istAdmin ? " Leg unten Gerichte an oder importier eine Karte." : ""}</p></div>`;
    return;
  }

  // ⚠️ VOR dem Ersetzen des innerHTML merken, ob im Suchfeld getippt wird und
  // wo der Cursor steht. Ein `blur`-Merker taugt dafür nicht: das Entfernen des
  // alten Feldes löst selbst ein `blur` aus und würde den Merker gerade dann
  // löschen, wenn er gebraucht wird. Genau so beim Bauen gemessen – nach jedem
  // Buchstaben war der Fokus weg.
  const altesFeld = esEl("es-suche");
  const sucheAktiv = !!altesFeld && document.activeElement === altesFeld;
  const cursor = sucheAktiv ? altesFeld.selectionStart : null;

  const darfBestellen = z.annahmeOffen || z.istAdmin;
  // Ausgeblendete Gerichte (Auge in „Speisekarte verwalten“) stehen nicht zur Wahl.
  const treffer = essenService.sucheKarte(z.karte.filter((g) => !g.aus), esSuchtext);
  const gruppen = essenService.nachKategorie(treffer);
  const suchtLaeuft = !!esSuchtext.trim();

  // ⚠️ Gruppen sind zugeklappt, sobald es mehr als eine gibt. Bei einer
  // einzigen waere das Zuklappen nur ein zusätzlicher Klick vor der ganzen
  // Karte. Wird gesucht, gehen alle Treffergruppen auf – eine zugeklappte
  // Gruppe hinter einer Suche sieht aus wie „nichts gefunden".
  const aufGeklappt = (kategorie) =>
    suchtLaeuft || gruppen.length <= 1 || esOffeneKategorien.has(kategorie);

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

      <div class="es-suche-zeile">
        <input type="search" id="es-suche" class="eingabe es-suche" autocomplete="off" aria-label="Speisekarte durchsuchen"
          placeholder="Suchen – Nummer, Gericht, Zutat" value="${escapeHtml(esSuchtext)}">
        ${suchtLaeuft ? `<button type="button" class="mini-btn" id="es-suche-weg" title="Suche zurücksetzen">✕</button>` : ""}
      </div>
      ${suchtLaeuft
        ? `<p class="hinweis-text es-suche-stand">${treffer.length
            ? treffer.length + (treffer.length === 1 ? " Gericht gefunden." : " Gerichte gefunden.")
            : "Nichts gefunden. Andere Schreibweise oder nur ein Wort probieren."}</p>`
        : ""}

      ${gruppen.map((gruppe) => !gruppe.kategorie
        // Gerichte ohne Kategorie stehen ohne Aufklapper da – sonst hätte man
        // eine Gruppe mit leerer Überschrift.
        ? gruppe.gerichte.map((g) => esGerichtHtml(g, darfBestellen)).join("")
        : `<details class="es-gruppe"${aufGeklappt(gruppe.kategorie) ? " open" : ""} data-es-kat="${escapeHtml(gruppe.kategorie)}">
             <summary>
               <span class="es-kategorie">${escapeHtml(gruppe.kategorie)}</span>
               <span class="es-gruppe-kurz">${gruppe.gerichte.length}</span>
             </summary>
             ${gruppe.gerichte.map((g) => esGerichtHtml(g, darfBestellen)).join("")}
           </details>`).join("")}
    </div>`;

  box.querySelectorAll("[data-es-hinzu]").forEach((b) => {
    b.addEventListener("click", () => esLegeInKorb(b.dataset.esHinzu));
  });
  // ⚠️ Am `summary`-Klick hängen, NICHT am `toggle`-Ereignis. `toggle` feuert
  // auch für Gruppen, die eine laufende Suche von selbst aufgeklappt hat, und
  // zwar asynchron – danach galt jede Kategorie als „vom Benutzer geöffnet" und
  // nach dem Leeren der Suche blieb alles offen. Genau so beim Bauen gemessen.
  // Der Klick kommt nur von einer echten Bedienung (Maus wie Tastatur).
  // ⚠️ Beim Klick steht `open` noch auf dem ALTEN Wert – der Browser dreht ihn
  // erst danach um.
  box.querySelectorAll("[data-es-kat] > summary").forEach((s) => {
    s.addEventListener("click", () => {
      const d = s.parentElement;
      if (d.open) esOffeneKategorien.delete(d.dataset.esKat);
      else esOffeneKategorien.add(d.dataset.esKat);
    });
  });

  // Fokus und Cursor zurückholen – siehe oben.
  const feld = esEl("es-suche");
  if (feld) {
    if (sucheAktiv) {
      feld.focus();
      const pos = cursor === null ? feld.value.length : cursor;
      feld.setSelectionRange(pos, pos);
    }
    feld.addEventListener("input", () => {
      esSuchtext = feld.value;
      esRenderKarte(esZustand);
    });
  }
  const weg = esEl("es-suche-weg");
  if (weg) weg.addEventListener("click", () => {
    esSuchtext = "";
    esRenderKarte(esZustand);
  });
}

// --- Warenkorb ---------------------------------------------------------------

// Zweimal auf dasselbe „+" heißt „zwei davon", nicht „zwei Zeilen". Steht in
// der Zeile aber schon ein Sonderwunsch, ist sie etwas Eigenes und bekommt eine
// neue Zeile daneben.
function esLegeInKorb(gerichtId) {
  const vorhanden = esEntwurf.positionen.find((p) => p.gerichtId === gerichtId && !p.sonderwunsch && !p.extras.length &&
    (!p.dressing || p.dressing === ES_DRESSINGS[0]));
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
  const gericht = esZustand && esZustand.karte.find((x) => x.id === gerichtId);
  esEntwurf.positionen.push({ lid, gerichtId, anzahl: 1, sonderwunsch: "", extras: [],
    dressing: gericht && esIstSalat(gericht) ? ES_DRESSINGS[0] : "" });
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
    if (preis && gericht) preis.textContent = essenService.centLabel(esPosStueckCent(pos, gericht) * pos.anzahl);
  }
  const summe = esEl("es-korb-summe");
  if (summe) summe.textContent = essenService.centLabel(esKorbSummeCent());
  const stueck = esEl("es-korb-stueck");
  if (stueck) stueck.textContent = esEntwurf.positionen.reduce((s, p) => s + p.anzahl, 0) + " Stück";
}

// Preise im gefüllten Korb nachziehen, OHNE neu zu zeichnen (siehe esRender).
// ⚠️ Sonst zeigte der Korb nach einer Preisänderung weiter den alten Betrag,
// abgeschickt wurde aber mit dem neuen Kartenpreis (Bugjagd 25.09.d T5a, K1).
function esKorbPreiseAuffrischen() {
  if (!esZustand) return;
  esEntwurf.positionen.forEach((pos) => {
    const zeile = document.querySelector('[data-es-zeile="' + pos.lid + '"]');
    const preis = zeile && zeile.querySelector(".es-korb-preis");
    const gericht = esZustand.karte.find((g) => g.id === pos.gerichtId);
    if (preis && gericht) preis.textContent = essenService.centLabel(esPosStueckCent(pos, gericht) * pos.anzahl);
  });
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

  const name = (esEntwurf.bestellungId && esEntwurf.name) || esFesterName() || essenService.getGespeicherterName();
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
            <span class="es-korb-preis">${g ? essenService.centLabel(esPosStueckCent(pos, g) * pos.anzahl) : ""}</span>
            <button type="button" class="mini-btn" data-es-raus="${escapeHtml(pos.lid)}" title="Wieder runter" aria-label="Wieder runter">🗑</button>
          </div>
          <div class="es-korb-unten">
            <div class="fr-stepper">
              <button type="button" data-es-weniger="${escapeHtml(pos.lid)}" ${pos.anzahl <= 1 ? "disabled" : ""} title="Eins weniger" aria-label="Eins weniger von ${escapeHtml(g ? g.name : "diesem Gericht")}">−</button>
              <span class="fr-stepper-zahl">${pos.anzahl}</span>
              <button type="button" data-es-mehr="${escapeHtml(pos.lid)}" ${pos.anzahl >= essenService.MAX_STUECK ? "disabled" : ""} title="Eins mehr" aria-label="Eins mehr von ${escapeHtml(g ? g.name : "diesem Gericht")}">+</button>
            </div>
            ${g && esIstSalat(g) ? `<select class="eingabe es-extra-wahl es-dressing-wahl" data-es-dressing="${escapeHtml(pos.lid)}"
              aria-label="Dressing zu ${escapeHtml(g.name)}">
              ${ES_DRESSINGS.map((d) => `<option value="${escapeHtml(d)}"${(pos.dressing || ES_DRESSINGS[0]) === d ? " selected" : ""}>🥗 ${escapeHtml(d)}</option>`).join("")}
            </select>` : ""}
            ${esExtrasMoeglich(g) ? `<select class="eingabe es-extra-wahl" data-es-extra="${escapeHtml(pos.lid)}"
              aria-label="Extra zu ${escapeHtml(g.name)} dazunehmen" ${pos.extras.length >= essenService.MAX_EXTRAS ? "disabled" : ""}>
              <option value="">➕ Extra dazu …</option>
              ${essenService.EXTRAS.filter((e) => !pos.extras.includes(e.name)).map((e) =>
                `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)} (+${essenService.centLabel(e.cent)})</option>`).join("")}
            </select>` : ""}
            <input type="text" class="eingabe es-wunsch" data-es-wunsch="${escapeHtml(pos.lid)}"
              maxlength="${essenService.MAX_WUNSCH_FREI}" autocomplete="off"
              placeholder="Sonstiges, z. B. ohne Zwiebeln" value="${escapeHtml(pos.sonderwunsch)}"
              aria-label="Sonderwunsch zu ${escapeHtml(g ? g.name : "diesem Gericht")}">
          </div>
          ${pos.extras.length ? `<div class="es-extras">${pos.extras.map((name) => {
            const e = essenService.EXTRAS.find((x) => x.name === name);
            return `<button type="button" class="es-extra-chip" data-es-extra-weg="${escapeHtml(pos.lid)}" data-name="${escapeHtml(name)}"
              title="${escapeHtml(name)} wieder weg">+ ${escapeHtml(name)} <span>${e ? essenService.centLabel(e.cent) : ""}</span> ✕</button>`;
          }).join("")}</div>` : ""}
        </div>`;
      }).join("")}

      <div class="fr-summe-zeile">
        <span id="es-korb-stueck">${esEntwurf.positionen.reduce((s, p) => s + p.anzahl, 0)} Stück</span>
        <span id="es-korb-summe">${essenService.centLabel(esKorbSummeCent())}</span>
      </div>

      ${name
        ? `<p class="fr-besteller">Bestellung für <b>${escapeHtml(name)}</b></p>`
        : `<label class="feld-label" for="es-korb-name">Dein Name</label>
           <input type="text" id="es-korb-name" class="eingabe" maxlength="40" autocomplete="off" value="${escapeHtml(esEntwurf.name || "")}">`}

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
  // ⚠️ Extras zeichnen den Korb neu (Auswahlliste und Preis ändern sich). Ein
  // gerade getippter Sonstiges-Text steht da schon in esEntwurf – geht nichts verloren.
  // Dressing ändert keinen Preis – kein Neuzeichnen nötig.
  box.querySelectorAll("[data-es-dressing]").forEach((wahl) => {
    wahl.addEventListener("change", () => {
      const pos = esEntwurf.positionen.find((p) => p.lid === wahl.dataset.esDressing);
      if (pos) pos.dressing = wahl.value;
    });
  });
  box.querySelectorAll("[data-es-extra]").forEach((wahl) => {
    wahl.addEventListener("change", () => {
      const pos = esEntwurf.positionen.find((p) => p.lid === wahl.dataset.esExtra);
      if (pos && wahl.value && !pos.extras.includes(wahl.value) && pos.extras.length < essenService.MAX_EXTRAS) {
        pos.extras.push(wahl.value);
      }
      esRenderKorb();
    });
  });
  box.querySelectorAll("[data-es-extra-weg]").forEach((b) => {
    b.addEventListener("click", () => {
      const pos = esEntwurf.positionen.find((p) => p.lid === b.dataset.esExtraWeg);
      if (pos) pos.extras = pos.extras.filter((n) => n !== b.dataset.name);
      esRenderKorb();
    });
  });
  box.querySelectorAll("[data-es-wunsch]").forEach((feld) => {
    feld.addEventListener("input", () => {
      const pos = esEntwurf.positionen.find((p) => p.lid === feld.dataset.esWunsch);
      if (pos) pos.sonderwunsch = feld.value;
    });
  });
  const notiz = esEl("es-korb-notiz");
  if (notiz) notiz.addEventListener("input", () => { esEntwurf.notiz = notiz.value; });
  // ⚠️ Auch den Namen im Entwurf merken: der Korb zeichnet sich bei jedem Extra,
  // jedem 🗑 und jedem weiteren Gericht neu – ein getippter Name war dann weg.
  const nameEin = esEl("es-korb-name");
  if (nameEin) nameEin.addEventListener("input", () => { esEntwurf.name = nameEin.value; });

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

// ⚠️ Bugjagd 01.10.2026: ein Doppelklick auf „Abschicken“ legte zwei
// Bestellungen an – während das erste set() läuft, ist bestellungId noch null,
// und der zweite Klick erzeugt eine neue id. Darum Sperre + Knopf aus.
let esSendetGerade = false;

async function esSendeBestellung() {
  if (esSendetGerade) return;
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
  const name = (esEntwurf.bestellungId && esEntwurf.name) ||
    esFesterName() || (nameFeld ? nameFeld.value : "") || essenService.getGespeicherterName();

  esSendetGerade = true;
  const knopf = esEl("es-btn-abschicken");
  if (knopf) knopf.disabled = true;
  let res;
  try {
    res = await essenService.bestelle({
      name,
      notiz: esEntwurf.notiz,
      bestellungId: esEntwurf.bestellungId,
      positionen: esEntwurf.positionen.map((p) => ({
        gerichtId: p.gerichtId,
        anzahl: p.anzahl,
        sonderwunsch: essenService.extrasText(p.extras,
          [p.dressing, String(p.sonderwunsch || "").trim()].filter(Boolean).join(", ")),
      })),
    });
  } catch (e) {
    res = { erfolg: false, fehler: "Das ließ sich gerade nicht speichern. Bitte versuch es noch einmal." };
  } finally {
    esSendetGerade = false;
    // ⚠️ Frisch holen: der Korb kann inzwischen neu gezeichnet worden sein.
    const k = esEl("es-btn-abschicken");
    if (k) k.disabled = false;
  }
  if (!res.erfolg) { esZeigeFehler("es-korb-fehler", res.fehler); return; }
  esLeereKorb();
}

// --- Meine Bestellungen ------------------------------------------------------
// Michel am 01.10.2026: dazuschreiben, welche Bestellung das war – also mit
// welcher Sammelbestellung („Bestellung 2 am Donnerstag“) sie zum Lieferanten
// ging, und wann sie abgegeben wurde. Gleiche Benennung wie im Mail-Betreff.
function esWelcheBestellung(z, b) {
  const runde = b.rundeId ? z.runden.find((r) => r.id === b.rundeId) : null;
  const wann = "abgegeben " + escapeHtml(essenService.zeitLabel(b.erstelltAm));
  return runde
    ? "📦 <b>" + escapeHtml(esMailBetreff(z, runde)) + "</b> · " + wann
    : "Noch in keiner Sammelbestellung · " + wann;
}

// Die Bestellnummer der Karte vor dem Gericht („Nr. 12 Bolognese“) – an der
// Kasse und beim Ausgeben sucht man danach, nicht nach dem Namen.
function esNrHtml(p) {
  return p.nummer ? `<span class="es-pos-nr">Nr. ${escapeHtml(p.nummer)}</span> ` : "";
}

// „Deine Bestellungen“ einklappbar (Michel am 03.10.2026): der ganze Block
// und darin die schon abgeholten als eigener, anfangs zugeklappter Teil.
// Gemerkt je Gerät – nur beim Klick, nicht über das toggle-Ereignis (das feuert
// auch beim Neuzeichnen mit „open“).
function esMeineLies(schluessel, standard) {
  try { const w = localStorage.getItem(schluessel); return w === null ? standard : w === "1"; } catch (e) { return standard; }
}
function esMeineMerke(schluessel, offen) {
  try { localStorage.setItem(schluessel, offen ? "1" : "0"); } catch (e) { /* privater Modus */ }
}

function esRenderMeine(z) {
  const box = esEl("es-meine");
  if (!z.meine.length) { box.innerHTML = ""; return; }

  const laufend = z.meine.filter((b) => b.status !== "abgeholt");
  const erledigt = z.meine.filter((b) => b.status === "abgeholt");
  const blockOffen = esMeineLies("agelan_es_meine_offen", true);
  const erledigtOffen = esMeineLies("agelan_es_meine_erledigt_offen", false);
  const kurz = [laufend.length ? laufend.length + " laufend" : "", erledigt.length ? erledigt.length + " erledigt" : ""].filter(Boolean).join(" · ");

  const karte = (b) => `
        <div class="es-bestellung status-${escapeHtml(b.status)}">
          <div class="es-best-kopf">
            <span class="es-status-punkt" aria-hidden="true"></span>
            <span class="es-best-status">${escapeHtml(b.statusLang)}</span>
            ${b.orga
              ? `<span class="es-best-summe frei" title="Wert ${essenService.centLabel(b.summeCent)} – geht auf die Organisation">kostenlos</span>`
              : `<span class="es-best-summe">${essenService.centLabel(b.summeCent)}</span>`}
          </div>
          <div class="es-best-positionen">${b.positionen.map((p) =>
            p.anzahl + "× " + esNrHtml(p) + escapeHtml(p.name) + (p.sonderwunsch ? ` <i>(${escapeHtml(p.sonderwunsch)})</i>` : "")
          ).join("<br>")}</div>
          ${b.notiz ? `<div class="fr-liste-notiz">${escapeHtml(b.notiz)}</div>` : ""}
          <div class="hinweis-text es-best-welche">${esWelcheBestellung(z, b)}</div>
          ${b.aenderbar ? `
            <div class="es-best-aktionen">
              <button type="button" class="mini-btn" data-es-bearbeiten="${escapeHtml(b.id)}">Ändern</button>
              <button type="button" class="mini-btn" data-es-storno="${escapeHtml(b.id)}">Stornieren</button>
            </div>` : ""}
        </div>`;

  box.innerHTML = `
    <div class="karte-block">
      <details class="es-meine-klapp" data-es-meine-klapp="agelan_es_meine_offen"${blockOffen ? " open" : ""}>
        <summary><h3 class="es-abschnitt">Deine Bestellungen</h3><span class="runde-zaehler">${escapeHtml(kurz)}</span></summary>
        ${laufend.map(karte).join("")}
        ${erledigt.length ? `
          <details class="es-meine-klapp es-meine-erledigt" data-es-meine-klapp="agelan_es_meine_erledigt_offen"${erledigtOffen ? " open" : ""}>
            <summary><span class="feld-label">Abgeholt – erledigt (${erledigt.length})</span></summary>
            ${erledigt.map(karte).join("")}
          </details>` : ""}
      </details>
    </div>`;

  box.querySelectorAll("details[data-es-meine-klapp] > summary").forEach((kopf) => {
    kopf.addEventListener("click", () => {
      const d = kopf.parentElement;
      esMeineMerke(d.dataset.esMeineKlapp, !d.open);
    });
  });

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
  // ⚠️ Ein gefüllter, noch nicht abgeschickter Korb wird sonst still ersetzt
  // (Bugjagd 25.09.d T5a, K2).
  if (esEntwurf.positionen.length && esEntwurf.bestellungId !== b.id &&
      !confirm("In deinem Korb liegt noch etwas, das nicht abgeschickt ist. Verwerfen und diese Bestellung zum Ändern laden?")) return;
  esEntwurf = {
    bestellungId: b.id,
    // ⚠️ Ändert der Veranstalter eine FREMDE Bestellung, bleibt sie auf deren
    // Namen – vorher landete sie still unter seinem eigenen Spitznamen.
    name: b.name,
    notiz: b.notiz,
    positionen: b.positionen.map((p) => {
      esLfdNr += 1;
      const w = essenService.extrasZerlegen(p.sonderwunsch);
      const g = esZustand.karte.find((x) => x.id === p.gerichtId);
      const d = g && esIstSalat(g) ? esDressingZerlegen(w.rest) : { dressing: "", rest: w.rest };
      return { lid: "l" + esLfdNr, gerichtId: p.gerichtId, anzahl: p.anzahl, sonderwunsch: d.rest, extras: w.extras, dressing: d.dressing };
    }),
  };
  esRenderKorb();
  esEl("es-korb").scrollIntoView({ block: "start", behavior: "smooth" });
}

// --- Admin -------------------------------------------------------------------
function esRenderAdmin(z) {
  esEl("es-admin-login").style.display = z.istAdmin ? "none" : "";
  // A3-01: wer nur per Konto (⭐/🛠) Veranstalter ist, braucht hier den PIN.
  if (typeof zeigeKontoPinHinweis === "function") zeigeKontoPinHinweis("es-admin-konto-hinweis");
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
// Sortieren nach Kartennummer (Michel am 01.10.2026): an der Ausgabe sucht man
// nach der Nummer. Natürlich sortiert – „3“ vor „12“, „12a“ nach „12“. Ohne
// Nummer ans Ende, dort nach Name.
const ES_NR_SORT = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
function esNachNummer(a, b) {
  if (!a.nummer !== !b.nummer) return a.nummer ? -1 : 1;
  return ES_NR_SORT.compare(a.nummer || "", b.nummer || "") || ES_NR_SORT.compare(a.name || "", b.name || "");
}
// Bestellungen einer Lieferung nach ihrer kleinsten Nummer, dann nach Besteller.
function esBestellungNachNummer(a, b) {
  const kleinste = (x) => x.positionen.slice().sort(esNachNummer)[0] || {};
  return esNachNummer(kleinste(a), kleinste(b)) || ES_NR_SORT.compare(a.name, b.name);
}

// Kurze Sperre für Status-Knöpfe. Liefert true, wenn der Klick verworfen wird.
// ⚠️ Bugjagd 01.10.2026: die Liste zeichnet sich nach jedem Status-Schreiben live
// neu, und unter dem Mauszeiger liegt dann der NÄCHSTE Knopf („Hat bezahlt“ →
// „abgeholt“). Ein Doppelklick schaltete so zwei Schritte weiter. Global statt
// je Knopf, weil der zweite Klick ein frisch gezeichnetes Element trifft.
let esStatusSperreBis = 0;
function esKlickSperre() {
  const jetzt = Date.now();
  if (jetzt < esStatusSperreBis) return true;
  esStatusSperreBis = jetzt + 700;
  return false;
}
// Nach dem Schreiben noch einmal 700 ms: bei langsamem Netz kommt das Neuzeichnen
// erst mit der Antwort, und erst dann liegt der nächste Knopf unter der Maus.
function esKlickSperreHalten() {
  esStatusSperreBis = Math.max(esStatusSperreBis, Date.now() + 700);
}

// Häkchen „abgeholt“ direkt in der zugeklappten Zeile einer Lieferung
// (Michel am 01.10.2026: „macht es einfacher und schneller“) – ohne Aufklappen.
// ⚠️ Nur für bezahlte bzw. freigegebene Bestellungen („bestellt“/„abgeholt“):
// wer noch nicht bezahlt hat, bekommt sein Essen nicht per Haken, dafür bleibt
// der Knopf „Hat bezahlt“ in der aufgeklappten Bestellung.
function esAbholHakenHtml(b) {
  if (!b.inRunde || (b.status !== "bestellt" && b.status !== "abgeholt")) {
    return b.inRunde ? `<span class="es-abhol-platz" aria-hidden="true"></span>` : "";
  }
  const an = b.status === "abgeholt";
  return `<input type="checkbox" class="es-abhol-haken" data-es-abgeholt="${escapeHtml(b.id)}"${an ? " checked" : ""}
    title="${an ? "Doch nicht abgeholt" : "Abgeholt"}" aria-label="${escapeHtml(b.name)} hat abgeholt">`;
}

// Die Kartennummern einer Bestellung für die zugeklappte Zeile: „Nr. 12 · 2× Nr. 7“.
// So findet man an der Ausgabe die Tüte, ohne jede Bestellung aufzuklappen.
function esNummernKurz(b) {
  const teile = b.positionen.filter((p) => p.nummer).sort(esNachNummer).map((p) => (p.anzahl > 1 ? p.anzahl + "× " : "") + "Nr. " + p.nummer);
  return teile.length ? `<span class="es-admin-nrn" title="Nummern auf der Speisekarte">${escapeHtml(teile.join(" · "))}</span>` : "";
}

function esBestellungHtml(b) {
  return `
      <details class="es-admin-best status-${escapeHtml(b.status)}" data-es-offen="${escapeHtml(b.id)}"${esOffeneBestellungen.has(b.id) ? " open" : ""}>
        <summary>
          ${esAbholHakenHtml(b)}
          <span class="es-status-punkt" aria-hidden="true"></span>
          <span class="es-admin-name">${escapeHtml(b.name)}</span>
          ${esNummernKurz(b)}
          <span class="es-admin-kurz">${b.stueck}× · ${b.orga
            // ⚠️ Bugjagd 01.10.2026: beim Orga-Essen stand der volle Preis da – an der
            // Kasse las sich das wie „schuldet X €“. Der Warenwert bleibt im title.
            ? `<span title="Warenwert ${escapeHtml(essenService.centLabel(b.summeCent))} – geht auf die Organisation">kostenlos 🛠</span>`
            : essenService.centLabel(b.summeCent)} · ${escapeHtml(b.statusKurz)}</span>
        </summary>
        <div class="es-admin-inhalt">
          <div class="es-best-positionen">${b.positionen.map((p) =>
            p.anzahl + "× " + esNrHtml(p) + escapeHtml(p.name) + (p.sonderwunsch ? ` <i>(${escapeHtml(p.sonderwunsch)})</i>` : "")
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

// --- Lieferung prüfen (Abhakliste) ------------------------------------------
// Michel am 01.10.2026: über den Bestellungen einer Lieferung alle Positionen
// zusammengefasst zum Abhaken, wenn der Fahrer da ist – fehlt etwas?
// ⚠️ Die Haken leben nur auf DIESEM Gerät (localStorage): abgehakt wird an
// einem Gerät an der Tür, und so braucht es keine neue Datenbankregel. Die
// Liste zeichnet sich bei jeder Änderung neu, darum stehen die Haken nicht im
// DOM, sondern werden je Lieferung gemerkt.
const ES_HAKEN_KEY = "agelan_es_haken";

function esHakenLesen() {
  try { return JSON.parse(localStorage.getItem(ES_HAKEN_KEY) || "{}") || {}; } catch (e) { return {}; }
}

function esHakenSetzen(rundeId, schluessel, an) {
  const alle = esHakenLesen();
  const liste = new Set(alle[rundeId] || []);
  if (an) liste.add(schluessel); else liste.delete(schluessel);
  alle[rundeId] = Array.from(liste);
  try { localStorage.setItem(ES_HAKEN_KEY, JSON.stringify(alle)); } catch (e) { /* privater Modus */ }
}

function esHakenSchluessel(p) {
  return JSON.stringify([p.gerichtId || "", p.nummer || "", p.name, (p.sonderwunsch || "").toLowerCase()]);
}

// Haken von Lieferungen, die es nicht mehr gibt, wegräumen – sonst wächst der
// Eintrag über jede LAN weiter.
function esHakenAufraeumen(runden) {
  const alle = esHakenLesen();
  const da = new Set((runden || []).map((r) => r.id));
  const weg = Object.keys(alle).filter((id) => !da.has(id));
  if (!weg.length) return;
  weg.forEach((id) => delete alle[id]);
  try { localStorage.setItem(ES_HAKEN_KEY, JSON.stringify(alle)); } catch (e) { /* privater Modus */ }
}

// Ist alles abgehakt, klappt die Liste zu und sagt „Bestellung vollständig“
// (Michel am 03.10.2026). Wer sie wieder aufmacht (z. B. um einen Haken zu
// lösen), behält sie offen – auch über das Neuzeichnen hinweg.
const esPruefAuf = new Set();
function esPruefKopf(an, alle) {
  return an === alle
    ? { titel: "✅ Bestellung vollständig", stand: alle + " / " + alle }
    : { titel: "📋 Lieferung prüfen", stand: an + " / " + alle + " abgehakt" };
}

function esPruefListeHtml(r) {
  const liste = essenService.sammelliste(r.bestellungen).sort(esNachNummer);
  if (!liste.length) return "";
  const haken = new Set(esHakenLesen()[r.id] || []);
  const erledigt = liste.filter((p) => haken.has(esHakenSchluessel(p))).length;
  const alles = erledigt === liste.length;
  const kopf = esPruefKopf(erledigt, liste.length);
  return `
        <details class="es-pruefliste${alles ? " komplett" : ""}" data-es-pruef="${escapeHtml(r.id)}"${!alles || esPruefAuf.has(r.id) ? " open" : ""}>
          <summary class="es-pruef-kopf">
            <b class="es-pruef-titel">${kopf.titel}</b>
            <span class="es-pruef-stand">${kopf.stand}</span>
          </summary>
          ${liste.map((p) => {
            const k = esHakenSchluessel(p);
            return `<label class="es-pruef-zeile${haken.has(k) ? " ok" : ""}">
              <input type="checkbox" data-es-haken="${escapeHtml(k)}"${haken.has(k) ? " checked" : ""}>
              <span><b>${p.anzahl}×</b> ${esNrHtml(p)}${escapeHtml(p.name)}${p.sonderwunsch ? ` <i>(${escapeHtml(p.sonderwunsch)})</i>` : ""}</span>
            </label>`;
          }).join("")}
        </details>`;
}

document.addEventListener("click", (ev) => {
  const kopf = ev.target && ev.target.closest && ev.target.closest("details.es-pruefliste > summary");
  if (!kopf) return;
  const d = kopf.parentElement;
  if (d.open) esPruefAuf.delete(d.dataset.esPruef); else esPruefAuf.add(d.dataset.esPruef);
});

// Ein Listener für alle Prüflisten – sie werden ständig neu gezeichnet.
// ⚠️ Nur Anzeige nachziehen, nicht die ganze Seite neu zeichnen: beim Abhaken
// an der Tür soll nichts springen.
document.addEventListener("change", (ev) => {
  const box = ev.target && ev.target.closest && ev.target.closest("[data-es-pruef]");
  if (!box || !ev.target.matches("[data-es-haken]")) return;
  esHakenSetzen(box.dataset.esPruef, ev.target.dataset.esHaken, ev.target.checked);
  ev.target.closest(".es-pruef-zeile").classList.toggle("ok", ev.target.checked);
  const alle = box.querySelectorAll("[data-es-haken]");
  const an = box.querySelectorAll("[data-es-haken]:checked").length;
  const kopf = esPruefKopf(an, alle.length);
  box.classList.toggle("komplett", an === alle.length);
  box.querySelector(".es-pruef-titel").textContent = kopf.titel;
  box.querySelector(".es-pruef-stand").textContent = kopf.stand;
  // Letzter Haken gesetzt: kurz stehen lassen, dann zuklappen.
  if (an === alle.length && ev.target.checked) {
    esPruefAuf.delete(box.dataset.esPruef);
    setTimeout(() => { if (box.isConnected && box.classList.contains("komplett")) box.open = false; }, 600);
  }
});

// Eine Sammelbestellung, die schon beim Lieferanten ist: „Donnerstag 1",
// „Donnerstag 2" … Darin die Bestellungen, die in genau dieser Mail standen,
// darüber die Rechnung für genau diese Lieferung.
// Filter für „Beim Lieferanten“ (Michel am 03.10.2026): abgeschlossene
// Lieferungen (alles abgeholt) ausblenden. Gemerkt je Gerät.
let esRundenFilter = (() => {
  try { const w = localStorage.getItem("agelan_es_rundenfilter"); return w === "offen" || w === "fertig" ? w : "alle"; }
  catch (e) { return "alle"; }
})();
function esRundeSichtbar(r) {
  if (esRundenFilter === "offen") return !r.fertig;
  if (esRundenFilter === "fertig") return !!r.fertig;
  return true;
}
function esRundenFilterHtml(runden) {
  const fertig = runden.filter((r) => r.fertig).length;
  const knopf = (wert, text, zahl) => `<button type="button" class="es-filter-chip${esRundenFilter === wert ? " aktiv" : ""}"
    data-es-rundenfilter="${wert}" aria-pressed="${esRundenFilter === wert}">${text} (${zahl})</button>`;
  return `<div class="es-rundenfilter" role="group" aria-label="Lieferungen filtern">
    ${knopf("alle", "Alle", runden.length)}${knopf("offen", "Nicht abgeschlossen", runden.length - fertig)}${knopf("fertig", "Abgeschlossen", fertig)}
  </div>`;
}

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
        ${esBestelltHtml(r)}
        ${esBescheidHtml(r)}
        ${!r.fertig && !esDarfBescheid() ? `<p class="hinweis-text">📣 Bescheid per Discord geht nur mit einem Veranstalter- oder Orga-Konto (⭐/🛠) – mit dem PIN allein lehnt der Bot ab.</p>` : ""}
        <div class="es-best-aktionen es-runde-knoepfe">
          <button type="button" class="mini-btn" data-es-runde-mail="${escapeHtml(r.id)}"
            title="Den Text dieser Sammelbestellung noch einmal ansehen">✉ Mailtext</button>
          ${r.fertig || !esDarfBescheid() ? "" : `<button type="button" class="mini-btn" data-es-runde-bescheid="${escapeHtml(r.id)}"
            title="${esSchonBescheid(r)
              ? "Noch einmal anstupsen – wer schon abgeholt hat, bekommt nichts"
              : "Allen Bestellern dieser Lieferung per Discord sagen, dass ihr Essen bereitliegt"}">📣 ${esSchonBescheid(r) ? "Nochmal Bescheid" : "Bescheid geben"}</button>`}
          ${r.fertig
            // ⚠️ Auch die ganze Lieferung braucht einen Rückweg. Ohne ihn müsste
            // man nach einem Fehlklick auf „Alle abgeholt" jede Bestellung
            // einzeln aufklappen und zurücksetzen.
            ? `<button type="button" class="mini-btn" data-es-runde-zurueck="${escapeHtml(r.id)}"
                title="Doch nicht abgeholt – alle wieder auf „beim Lieferanten bestellt“">↺ doch nicht abgeholt</button>`
            : `<button type="button" class="mini-btn primary" data-es-runde-da="${escapeHtml(r.id)}"
                title="Das Essen ist da und alle haben es geholt">Alle abgeholt</button>`}
        </div>
        ${esPruefListeHtml(r)}
        ${r.bestellungen.slice().sort(esBestellungNachNummer).map(esBestellungHtml).join("")}
      </div>
    </details>`;
}

// Das Ergebnis des letzten Bescheid-Laufs, je Lieferung gemerkt.
// \u26a0\ufe0f Als Modul-Variable, nicht als Text irgendwo im DOM: die Bestellliste
// zeichnet sich bei jeder \u00c4nderung neu, und die Nachfassliste w\u00e4re dann sofort
// wieder weg - genau die Liste, wegen der man den Knopf gedr\u00fcckt hat.
let esBescheidStand = {};

// Filter über den Zählern „offen / bezahlt / bestellt / abgeholt“ (2026-10-01).
// null = alles in den gewohnten Gruppen (Stapel, Ohne Sammelbestellung, Beim
// Lieferanten); sonst EINE Liste mit allen Bestellungen dieses Stands, egal in
// welcher Gruppe sie stecken. Nicht gespeichert – gilt bis zum Neuladen.
let esStatusFilter = null;

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
  // A3-02: raus, aber ohne gespeicherten Zeitpunkt - das muss neben der Liste stehen,
  // nicht nur oben im Kasten, sonst drueckt man ein zweites Mal.
  const zeit = e.zeitFehler ? `<p class="hinweis-text fehler">${escapeHtml(e.zeitFehler)}</p>` : "";

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
  return wann + zeit + `<p class="hinweis-text es-bescheid${e.offen && e.offen.length ? " es-bescheid-luecke" : ""}">${gut}${ohne}${schlecht}</p>`;
}

// Ist fuer diese Lieferung schon Bescheid gegeben worden? Gespeichert (bescheidAm) ODER
// in dieser Sitzung verschickt - auch wenn das Festhalten danach scheiterte (A3-02).
function esSchonBescheid(r) {
  const e = esBescheidStand[r.id];
  return !!(r.bescheidAm || (e && e.geschickt !== undefined));
}

// "Dein Essen ist da" an alle Besteller dieser Lieferung.
//
// \u26a0\ufe0f Der Client schickt NAMEN, keine Discord-IDs - die kennt er gar nicht und
// soll er auch nicht kennen. Nachgeschlagen wird im Worker.
// ⚠️ Den Discord-Versand nimmt der Worker nur von einem ⭐- oder 🛠-Konto an
// (veranstalterOk). Wer per PIN oder als Anleger Veranstalter ist, bekam den
// Knopf trotzdem und danach „Nur der Veranstalter.“ in Rot (Bugjagd 25.09.d T5a-3a).
function esDarfBescheid() {
  return typeof kontoIstVeranstalter === "function" && kontoIstVeranstalter();
}

// --- Age Lan Bot (vormals Foodbot): „bestellt“ ----------------------------------------------------
// Michel am 02.10.2026: Sobald eine Sammelbestellung rausgeht, bekommt jede:r
// darin per Discord „Deine Bestellung wurde soeben beim Pizzalieferanten
// bestellt – Bestellung 8 am Freitag“ samt der eigenen Posten. Läuft von selbst
// nach „Ist raus – … festhalten“; das Ergebnis steht an der Lieferung, mit
// „erneut senden“, falls etwas schiefging.
// ⚠️ Eigene Worker-Aktion „discord-bestellt“. Kennt der Worker sie noch nicht,
// kommt „Unbekannte Aktion“ zurück – es geht dann NICHTS raus, insbesondere
// kein falsches „Dein Essen ist da“.
let esBestelltStand = {};

function esBestelltLeute(runde) {
  const leute = new Map();
  runde.bestellungen.forEach((b) => {
    const roh = String(b.name || "").trim();
    const k = roh.toLowerCase();
    if (!k) return;
    if (!leute.has(k)) leute.set(k, { name: roh, posten: [] });
    b.positionen.forEach((p) => leute.get(k).posten.push({
      anzahl: p.anzahl,
      gericht: (p.nummer ? "Nr. " + p.nummer + " " : "") + p.name,
      sonderwunsch: p.sonderwunsch,
    }));
  });
  return Array.from(leute.values());
}

async function esBestelltMelden(rundeId) {
  if (!esDarfBescheid()) {
    esBestelltStand[rundeId] = { fehler: "Age Lan Bot hat nicht verschickt – geht nur mit einem ⭐/🛠-Konto." };
    esRender(esZustand);
    return;
  }
  // Die Runde steht nach dem Schreiben sofort im lokalen Stand; zur Sicherheit kurz warten.
  let runde = null;
  for (let i = 0; i < 20 && !runde; i++) {
    runde = (esZustand.runden || []).find((r) => r.id === rundeId);
    if (!runde) await new Promise((r) => setTimeout(r, 150));
  }
  if (!runde) return;
  const leute = esBestelltLeute(runde);
  if (!leute.length) return;
  esBestelltStand[rundeId] = { laeuft: true };
  esRender(esZustand);
  const titel = esMailBetreff(esZustand, runde);
  const um = essenService.zeitLabel(runde.erstelltAm || Date.now());
  const ergebnis = { geschickt: 0, offen: [] };
  try {
    let schlange = leute.slice();
    for (let lauf = 0; schlange.length && lauf < 10; lauf++) {
      const happen = schlange.slice(0, 24);
      schlange = schlange.slice(24);
      const d = await kontenRufe("discord-bestellt", { leute: happen, titel, um });
      ergebnis.geschickt += d.geschickt || 0;
      const nochmal = [];
      (d.offen || []).forEach((o) => {
        const l = o && o.nichtVersucht && happen.find((x) => x.name.toLowerCase() === String(o.nickname || "").toLowerCase());
        if (l) nochmal.push(l); else ergebnis.offen.push(o);
      });
      if (nochmal.length === happen.length) { nochmal.forEach((l) => ergebnis.offen.push({ nickname: l.name, grund: "Nicht versucht." })); break; }
      schlange = nochmal.concat(schlange);
    }
    esBestelltStand[rundeId] = ergebnis;
  } catch (e) {
    const unbekannt = /Unbekannte Aktion/i.test(String(e && e.message));
    esBestelltStand[rundeId] = { fehler: unbekannt
      ? "Age Lan Bot hat nicht verschickt – der Worker kennt die Nachricht „bestellt“ noch nicht (Worker aktualisieren)."
      : "Age Lan Bot hat nicht verschickt: " + (e && e.message ? e.message : "Fehler") };
  }
  esRender(esZustand);
}

function esBestelltHtml(r) {
  const e = esBestelltStand[r.id];
  if (!e) return "";
  if (e.laeuft) return `<p class="hinweis-text">🍕 Age Lan Bot meldet „bestellt“ …</p>`;
  const nochmal = esDarfBescheid() ? ` <button type="button" class="mini-btn" data-es-bestellt-nochmal="${escapeHtml(r.id)}">erneut senden</button>` : "";
  if (e.fehler) return `<p class="hinweis-text fehler">${escapeHtml(e.fehler)}${nochmal}</p>`;
  const ohne = e.offen && e.offen.length
    ? " · nicht erreicht: " + e.offen.map((o) => escapeHtml(o.nickname || "?") + " (" + escapeHtml(o.grund || "") + ")").join(", ")
    : "";
  return `<p class="hinweis-text">🍕 Age Lan Bot: ${e.geschickt || 0} über „bestellt“ informiert${ohne}</p>`;
}

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
  const bestelltAm = new Map();
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
    // ⚠️ Die FRÜHESTE Bestellung der Person zählt: wer zweimal bestellt hat,
    // wartet seit dem ersten Mal. `bestellungen` ist zwar nach Zeit sortiert,
    // aber darauf verlassen sich hier zwei Zeilen weniger gut als ein Vergleich.
    const bisher = bestelltAm.get(k);
    if (!bisher || b.erstelltAm < bisher) bestelltAm.set(k, b.erstelltAm);
    b.positionen.forEach((p) => {
      // Die Bestellnummer gehört mit in die Nachricht: danach fragt man vorn
      // an der Ausgabe, nicht nach dem Namen.
      posten.get(k).push({
        anzahl: p.anzahl,
        gericht: (p.nummer ? "Nr. " + p.nummer + " " : "") + p.name,
        sonderwunsch: p.sonderwunsch,
      });
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
    // ⚠️ Die Zeiten gehen FERTIG FORMATIERT raus, nicht als Zeitstempel: der
    // Worker läuft in UTC und würde daraus eine Uhrzeit machen, die zwei
    // Stunden danebenliegt. Der Browser steht dort, wo die Veranstaltung ist.
    // ⚠️ Bugjagd 28.09. F9: in Haeppchen zu hoechstens ES_BESCHEID_JE_LAUF Leuten. Ein
    // Worker-Aufruf darf nur 50 Unteranfragen machen (2 je Person); vorher bekam ab
    // Person 26 niemand mehr Bescheid. Wen der Worker mit `nichtVersucht` zurueckgibt,
    // schickt der naechste Durchgang noch einmal - ohne die schon Erreichten erneut
    // anzuschreiben.
    // So viele Leute je Worker-Aufruf: 24 x 2 Unteranfragen passen in 50.
    const ES_BESCHEID_JE_LAUF = 24;
    const ES_BESCHEID_DURCHGAENGE_MAX = 10;
    const daSeit = essenService.zeitLabel(Date.now());
    let warteschlange = namen.map((n) => ({
      name: n,
      posten: posten.get(n.toLowerCase()) || [],
      bestelltAm: essenService.zeitLabel(bestelltAm.get(n.toLowerCase())),
    }));
    const daten = { geschickt: 0, offen: [] };
    for (let durchgang = 0; warteschlange.length; durchgang++) {
      const happen = warteschlange.slice(0, ES_BESCHEID_JE_LAUF);
      warteschlange = warteschlange.slice(ES_BESCHEID_JE_LAUF);
      if (durchgang >= ES_BESCHEID_DURCHGAENGE_MAX) {
        happen.concat(warteschlange).forEach((l) => daten.offen.push({ nickname: l.name, grund: "Nicht versucht – zu viele Durchgänge auf einmal." }));
        break;
      }
      let d;
      try {
        d = await kontenRufe("discord-sammel", {
          leute: happen,
          nicknames: happen.map((l) => l.name),
          titel: runde.titel,
          daSeit: daSeit,
        });
      } catch (e) {
        // Schon im ersten Durchgang gescheitert: wie bisher als Fehler zeigen.
        if (durchgang === 0) throw e;
        happen.concat(warteschlange).forEach((l) => daten.offen.push({ nickname: l.name, grund: "Nicht verschickt: " + e.message }));
        break;
      }
      daten.geschickt += d.geschickt || 0;
      const nochmal = [];
      (d.offen || []).forEach((o) => {
        const l = o && o.nichtVersucht && happen.find((x) => x.name.toLowerCase() === String(o.nickname || "").toLowerCase());
        if (l) nochmal.push({ l, o });
        else daten.offen.push(o);
      });
      // Kein Fortschritt (der Worker hat niemanden versucht): nicht im Kreis schicken.
      if (nochmal.length && nochmal.length === happen.length) {
        nochmal.forEach((x) => daten.offen.push(x.o));
      } else {
        warteschlange = nochmal.map((x) => x.l).concat(warteschlange);
      }
    }
    esBescheidStand[runde.id] = {
      geschickt: daten.geschickt || 0,
      offen: daten.offen || [],
      uebersprungen: wirklichSchonDa,
    };
    // Uhrzeit festhalten, damit sie ein Neuladen überlebt. ⚠️ Erst NACH dem
    // Versand – vorher stünde dort eine Zeit, obwohl nichts rausging.
    // ⚠️ Eigenes try (Fixprüfung 26.09.2026, A3-02): scheitert NUR das Festhalten, sind die
    // Nachrichten trotzdem raus. Die Nachfassliste bleibt stehen, daneben der Hinweis.
    let merk;
    try {
      merk = await essenService.setzeBescheid(runde.id, daten.geschickt || 0);
    } catch (e2) {
      merk = { erfolg: false, fehler: "Die Nachrichten sind raus, der Zeitpunkt ließ sich aber nicht speichern." };
    }
    if (!merk.erfolg) {
      esBescheidStand[runde.id].zeitFehler = merk.fehler;
      esZeigeFehler("es-admin-fehler", merk.fehler);
    }
  } catch (e) {
    esBescheidStand[runde.id] = { fehler: e.message };
  }
  esRender(esZustand);
}

function esRenderAdminBestellungen(z) {
  const box = esEl("es-admin-bestellungen");
  // ⚠️ Nur aufräumen, wenn Lieferungen geladen sind – beim allerersten Zeichnen
  // ist die Liste noch leer und würde sonst alle Haken wegwerfen.
  if (z.vorhanden && z.runden.length) esHakenAufraeumen(z.runden);
  if (!z.bestellungen.length) {
    box.innerHTML = `<p class="fr-leer-hinweis">Noch keine Bestellungen.</p>`;
    return;
  }

  if (esStatusFilter && !essenService.STATUS_KETTE.includes(esStatusFilter)) esStatusFilter = null;
  const gefiltert = esStatusFilter ? z.bestellungen.filter((b) => b.status === esStatusFilter) : null;

  box.innerHTML = `
    <div class="es-zaehler" role="group" aria-label="Bestellungen filtern">
      <button type="button" class="es-zaehler-teil es-filter-alle${esStatusFilter ? "" : " aktiv"}" data-es-filter=""
        aria-pressed="${!esStatusFilter}"><b>${z.bestellungen.length}</b> alle</button>
      ${essenService.STATUS_KETTE.map((s) =>
        `<button type="button" class="es-zaehler-teil status-${s}${esStatusFilter === s ? " aktiv" : ""}" data-es-filter="${s}"
          aria-pressed="${esStatusFilter === s}"><b>${z.zaehler[s]}</b> ${escapeHtml(essenService.STATUS_TEXT[s].kurz)}</button>`
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

    ${gefiltert ? `
    <p class="feld-label es-gruppe-titel">Nur „${escapeHtml(essenService.STATUS_TEXT[esStatusFilter].kurz)}“ (${gefiltert.length})</p>
    ${gefiltert.length
      ? gefiltert.map(esBestellungHtml).join("")
      : `<p class="fr-leer-hinweis">Keine Bestellung mit diesem Stand.</p>`}
    ` : `
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

    ${z.runden.length ? `<p class="feld-label es-gruppe-titel">Beim Lieferanten (${z.runden.length})</p>
      ${esRundenFilterHtml(z.runden)}` : ""}
    ${(() => {
      const sichtbar = z.runden.filter(esRundeSichtbar);
      return sichtbar.length || !z.runden.length
        ? sichtbar.map(esRundeHtml).join("")
        : `<p class="fr-leer-hinweis">${esRundenFilter === "offen" ? "Alle Lieferungen sind abgeschlossen." : "Noch keine Lieferung abgeschlossen."}</p>`;
    })()}`}`;

  box.querySelectorAll("[data-es-rundenfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      esRundenFilter = btn.dataset.esRundenfilter;
      try { localStorage.setItem("agelan_es_rundenfilter", esRundenFilter); } catch (e) { /* privater Modus */ }
      esRenderAdminBestellungen(esZustand);
    });
  });

  // Klick auf einen Zähler filtert; derselbe noch einmal (oder „alle“) hebt auf.
  box.querySelectorAll("[data-es-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = btn.dataset.esFilter || null;
      esStatusFilter = esStatusFilter === s ? null : s;
      esRenderAdminBestellungen(esZustand);
    });
  });

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
  box.querySelectorAll("[data-es-bestellt-nochmal]").forEach((btn) => {
    btn.addEventListener("click", () => esBestelltMelden(btn.dataset.esBestelltNochmal));
  });
  box.querySelectorAll("[data-es-runde-mail]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!esMailVerwerfen()) return;
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
      if (esKlickSperre()) return;
      const r = esZustand.runden.find((x) => x.id === btn.dataset.esRundeZurueck);
      if (!r) return;
      if (!confirm("Alle " + r.anzahl + " Bestellungen aus „" + r.titel + "“ wieder auf „beim Lieferanten bestellt“ setzen?")) return;
      const res = await essenService.setzeRundeStatus(r.id, "bestellt");
      esKlickSperreHalten();
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-runde-da]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (esKlickSperre()) return;
      const r = esZustand.runden.find((x) => x.id === btn.dataset.esRundeDa);
      if (!r) return;
      if (!confirm("Alle " + r.anzahl + " Bestellungen aus „" + r.titel + "“ als abgeholt eintragen?")) return;
      const res = await essenService.setzeRundeStatus(r.id, "abgeholt");
      esKlickSperreHalten();
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
      // ⚠️ Wer noch nicht bezahlt hat, wird nicht mit abgehakt. Das muss
      // dranstehen, sonst sieht es aus, als hätte der Knopf nur halb gewirkt.
      else if ((res.offen && res.offen.length) || (res.offenOrga && res.offenOrga.length)) {
        const teile = [];
        if (res.offen && res.offen.length) teile.push("Ohne " + res.offen.join(", ") + " – da fehlt noch das Geld.");
        if (res.offenOrga && res.offenOrga.length) teile.push("Ohne " + res.offenOrga.join(", ") + " – Orga-Essen noch nicht freigegeben.");
        esZeigeFehler("es-admin-fehler", teile.join(" "));
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
  // ⚠️ Der Haken sitzt im <summary>: ohne stopPropagation/preventDefault am
  // Klick klappte jeder Haken die Bestellung zusätzlich auf oder zu.
  box.querySelectorAll("[data-es-abgeholt]").forEach((haken) => {
    haken.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (esKlickSperre()) return;
      const b = esZustand.bestellungen.find((x) => x.id === haken.dataset.esAbgeholt);
      if (!b) return;
      haken.disabled = true;
      let res;
      try {
        res = await essenService.setzeStatus(b.id, b.status === "abgeholt" ? "bestellt" : "abgeholt");
      } catch (e) {
        res = { erfolg: false, fehler: "Speichern abgelehnt – Veranstalter-Rechte prüfen (neu anmelden oder PIN eingeben)." };
      } finally {
        // ⚠️ Immer wieder frei – sonst blieb der Haken nach einer Ablehnung tot.
        haken.disabled = false;
        esKlickSperreHalten();
      }
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-weiter]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (esKlickSperre()) return;
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esWeiter);
      if (!b || !b.naechsterStatus) return;
      const res = await essenService.setzeStatus(b.id, b.naechsterStatus);
      esKlickSperreHalten();
      if (!res.erfolg) esZeigeFehler("es-admin-fehler", res.fehler);
    });
  });
  box.querySelectorAll("[data-es-zurueck]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (esKlickSperre()) return;
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esZurueck);
      if (!b || !b.zurueckStatus) return;
      const res = await essenService.setzeStatus(b.id, b.zurueckStatus);
      esKlickSperreHalten();
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
      if (!esMailVerwerfen()) return;
      esMailAuswahl = "einzeln:" + btn.dataset.esMail;
      esRenderSammelmail(esZustand);
      esEl("es-sammelmail").scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });

  box.querySelectorAll("[data-es-orga]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = esZustand.bestellungen.find((x) => x.id === btn.dataset.esOrga);
      if (!b) return;
      if (esKlickSperre()) return;
      // ⚠️ Bugjagd 01.10.2026: der Service setzt die Bestellung dabei zurück auf
      // „offen“ (noch zu kassieren) – das muss im Hinweis stehen. Bei „abgeholt“
      // lehnt er ab; dort erst gar nicht fragen, die Meldung kommt aus dem Service.
      if (b.orga && b.status !== "abgeholt" && !confirm(b.name + " wird dann wieder zahlungspflichtig: " +
          essenService.centLabel(b.summeCent) +
          (b.status !== "neu" ? ". Die Bestellung steht danach wieder auf „offen“ (noch zu kassieren)" : "") +
          ". Weiter?")) return;
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

// Betreff der Mail an den Lieferanten: „Bestellung 1 am Donnerstag“ – ohne
// Namen (Michel am 2026-10-01: „lass das Michel weg“; der steht ja als Absender
// und unter dem Gruß).
// Gezählt wird JE KALENDERTAG nach dem Zeitpunkt, an dem eine Sammelbestellung
// festgehalten wurde (erstelltAm) – Michel am 2026-10-01: „nummeriere sie mit
// Bestellung 1 am Donnerstag usw“. Eine schon verschickte Runde behält ihre
// Nummer; eine neue bekommt die nächste des heutigen Tages.
// ⚠️ Unabhängig von runde.nr/runde.titel („AgeLan #3 Foodservice 1“) – die
// zählen über die ganze Veranstaltung und stehen so in der App.
const ES_WOCHENTAGE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

function esMailBetreff(z, runde) {
  const tagVon = (ms) => new Date(ms).toDateString();
  const zeitpunkt = runde && runde.erstelltAm ? runde.erstelltAm : Date.now();
  const tag = tagVon(zeitpunkt);
  const amTag = z.runden.filter((r) => r.erstelltAm && tagVon(r.erstelltAm) === tag);
  const nr = runde
    ? amTag.filter((r) => r.erstelltAm < runde.erstelltAm || (r.erstelltAm === runde.erstelltAm && r.nr <= runde.nr)).length
    : amTag.length + 1;
  return "Bestellung " + Math.max(1, nr) + " am " + ES_WOCHENTAGE[new Date(zeitpunkt).getDay()];
}

function esRenderSammelmail(z) {
  const box = esEl("es-sammelmail");
  // Geänderter oder schon geöffneter Mailtext: nicht neu zeichnen (siehe
  // esMailBearbeitet, esMailGeoeffnet). Nur sagen, wenn sich die Bestellungen
  // darunter inzwischen geändert haben.
  const eingefroren = esMailBearbeitet || esMailGeoeffnet;
  if (eingefroren && esEl("es-mail-text")) {
    const jetzt = essenService.bestelltext(esMailBestellungen(z), z.meta).text;
    const hinweis = esEl("es-mail-veraltet");
    if (hinweis) hinweis.style.display = jetzt === eingefroren.basis ? "none" : "";
    return;
  }
  esMailBearbeitet = null;
  esMailGeoeffnet = null;
  // ⚠️ Die einzeln gewählte Bestellung kann inzwischen weg sein (gelöscht oder
  // vom Besteller storniert). Dann zurück auf den Sammelweg, statt einen leeren
  // Kasten mit dem Namen eines Geistes zu zeigen.
  if ((esEinzelId() || esRundeAuswahlId()) && !esMailBestellungen(z).length) esMailAuswahl = "bezahlt";
  const auswahl = esMailBestellungen(z);
  const einzeln = esEinzelId() ? auswahl[0] : null;
  const runde = esRundeAuswahlId() ? z.runden.find((x) => x.id === esRundeAuswahlId()) : null;
  const brief = essenService.bestelltext(auswahl, z.meta);
  brief.betreff = esMailBetreff(z, runde);
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
            <b>${p.anzahl}×</b> ${esNrHtml(p)}${escapeHtml(p.name)}${p.sonderwunsch ? ` <i>(${escapeHtml(p.sonderwunsch)})</i>` : ""}
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
      <!-- ⚠️ Auffällig, nicht als graue Fußnote (2026-10-01): der Text bleibt nach
           „E-Mail öffnen“/„Kopieren“ absichtlich stehen, neue Bestellungen fehlen
           dann darin – das muss man sehen, bevor die Mail rausgeht. -->
      <div class="es-mail-veraltet" id="es-mail-veraltet" style="display:none" role="alert">
        <span>⚠️ <b>Neue oder geänderte Bestellungen</b> – sie fehlen im Text oben.</span>
        <button type="button" class="btn btn-primary" id="es-btn-mail-neu">Text mit allen Bestellungen neu erzeugen</button>
      </div>
      <p class="hinweis-text">Der Text lässt sich hier noch ändern, bevor er rausgeht. Namen der Besteller stehen bewusst nicht drin. Bei Gerichten, von denen welche auf die Organisation gehen, steht dabei, wie viele – und was dafür wirklich zu zahlen ist.</p>

      <div class="es-mail-knoepfe">
        <button type="button" class="btn btn-secondary" id="es-btn-kopieren">Text kopieren</button>
        ${brief.empfaenger
          ? `<a class="btn btn-primary es-mail-link" id="es-mail-link" href="${escapeHtml(mailto)}">E-Mail öffnen</a>`
          : `<button type="button" class="btn btn-primary" disabled title="Erst die E-Mail-Adresse des Lieferanten eintragen">E-Mail öffnen</button>`}
      </div>
      ${!brief.empfaenger ? (z.orgaLesbar === false
        // A3-02: essenOrga ist (noch) nicht lesbar - dann fehlt die Adresse nicht, sie ist nur verborgen.
        ? `<p class="hinweis-text">Für „E-Mail öffnen“ fehlt die Adresse des Lieferanten: Telefon und Mail sind nur mit dem PIN dieses Bereichs lesbar.</p>`
        : `<p class="hinweis-text">Für „E-Mail öffnen“ fehlt noch die Adresse des Lieferanten – trag sie unten bei den Einstellungen ein.</p>`) : ""}
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
      if (!esMailVerwerfen()) {
        box.querySelectorAll('input[name="es-mailwahl"]').forEach((x) => { x.checked = x.value === esMailAuswahl; });
        return;
      }
      esMailAuswahl = r.value;
      esRenderSammelmail(esZustand);
    });
  });

  const textFeld = esEl("es-mail-text");
  if (textFeld) textFeld.addEventListener("input", () => {
    if (!esMailBearbeitet) esMailBearbeitet = { basis: brief.text };
  });
  const neuBtn = esEl("es-btn-mail-neu");
  if (neuBtn) neuBtn.addEventListener("click", () => {
    if (!esMailVerwerfen()) return;
    esRenderSammelmail(esZustand);
  });
  // ⚠️ Der Link wird beim KLICK aus dem Textfeld gebaut, nicht beim Zeichnen
  // aus brief.text – sonst ginge eine Änderung am Text nie in die Mail.
  // ⚠️ Ab hier ist der Text beim Lieferanten (oder auf dem Weg dorthin): den
  // Kasten einfrieren, damit „Ist raus“ genau diese Auswahl festhält. Bei einer
  // schon verschickten Runde gibt es nichts festzuhalten, dort bleibt alles live.
  const merkeGeoeffnet = () => {
    if (!runde && !esMailGeoeffnet) esMailGeoeffnet = { basis: brief.text };
  };
  const mailLink = esEl("es-mail-link");
  if (mailLink) mailLink.addEventListener("click", () => {
    const feld = esEl("es-mail-text");
    if (!feld) return;
    merkeGeoeffnet();
    mailLink.href = "mailto:" + encodeURIComponent(brief.empfaenger) +
      "?subject=" + encodeURIComponent(brief.betreff) +
      "&body=" + encodeURIComponent(feld.value);
  });

  const kopieren = esEl("es-btn-kopieren");
  if (kopieren) kopieren.addEventListener("click", () => { merkeGeoeffnet(); esKopiereMailText(); });

  const zurueckBtn = esEl("es-btn-alle-zeigen");
  if (zurueckBtn) zurueckBtn.addEventListener("click", () => {
    if (!esMailVerwerfen()) return;
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
    if (!esMailVerwerfen()) return;
    // Steht im Stapel nur Unbezahltes, sonst landet man auf einem leeren Kasten.
    esMailAuswahl = esZustand.stapel.some((b) => b.status === "bezahlt") ? "bezahlt" : "offen";
    esRenderSammelmail(esZustand);
    esEl("es-sammelmail").scrollIntoView({ block: "start", behavior: "smooth" });
  });

  const alleBtn = esEl("es-btn-alle-bestellt");
  if (alleBtn) alleBtn.addEventListener("click", async () => {
    const vorher = esMailAuswahl;
    const ids = auswahl.map((b) => b.id);
    // ⚠️ `auswahl` ist der Stand, aus dem der Text im Kasten entstand. Hat sich
    // eine dieser Bestellungen seitdem geändert oder ist sie aus dem Stapel
    // verschwunden, entspräche die Runde nicht mehr der Mail – dann sagen,
    // welche, und nachfragen. Was seitdem neu dazukam, bleibt einfach im Stapel.
    const aktuell = new Map(((esZustand && esZustand.ohneRunde) || []).map((b) => [b.id, b]));
    const abweichend = [];
    auswahl.forEach((b) => {
      const neu = aktuell.get(b.id);
      if (!neu) abweichend.push("• " + b.name + ": nicht mehr im Stapel");
      else if (esMailFingerabdruck(neu) !== esMailFingerabdruck(b)) abweichend.push("• " + b.name + ": seit dem Text geändert");
    });
    if (abweichend.length) {
      if (!confirm("Seit dem Mailtext hat sich etwas geändert:\n" + abweichend.join("\n") +
          "\n\nDie Sammelbestellung wiche dann von der Mail ab. Trotzdem so festhalten?\n" +
          "(Abbrechen, dann „Text neu erzeugen“ und die Änderung dem Lieferanten nachschicken.)")) return;
    } else if (!einzeln && !confirm("Diese " + ids.length + " Bestellungen als eine Sammelbestellung festhalten?")) return;
    // ⚠️ Die Ansicht VOR dem Schreiben zurückstellen. Das Schreiben löst über
    // Firebase sofort ein Neuzeichnen aus – käme die Umstellung erst danach,
    // stünde dort weiter „Nur die Bestellung von …" mit einer Bestellung, die
    // schon durch ist. Genau so beim Bauen gesehen.
    esMailAuswahl = "bezahlt";
    // Die Mail ist raus – ein geänderter Text hat damit seinen Zweck erfüllt und
    // darf das Neuzeichnen nach dem Schreiben nicht mehr aufhalten.
    const bearbeitetVorher = esMailBearbeitet;
    const geoeffnetVorher = esMailGeoeffnet;
    esMailBearbeitet = null;
    esMailGeoeffnet = null;
    // Ein Aufruf für beide Fälle: eine einzelne Bestellung ist eine
    // Sammelbestellung mit genau einer Zeile. Zwei Wege wären zwei Stellen, an
    // denen die Runde entstehen kann – und eine davon würde irgendwann anders
    // funktionieren als die andere.
    const res = await essenService.schickeRunde(ids);
    if (!res.erfolg) {
      esMailAuswahl = vorher;   // hat nicht geklappt, also zurück in die alte Sicht
      // Der geänderte Text steht noch im Feld – nicht durch Neuzeichnen verwerfen.
      esMailBearbeitet = bearbeitetVorher;
      esMailGeoeffnet = geoeffnetVorher;
      if (!esMailBearbeitet && !esMailGeoeffnet) esRenderSammelmail(esZustand);
      esZeigeFehler("es-mail-fehler", res.fehler);
    } else if (res.id) {
      // Age Lan Bot: allen in dieser Lieferung „bestellt“ melden. Ohne await – die
      // Ansicht soll nicht auf Discord warten.
      esBestelltMelden(res.id);
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
  // ⚠️ Die Zahl gehoert in die zugeklappte Zeile: sonst muss man aufklappen,
  // nur um zu sehen, ob die Karte ueberhaupt schon steht.
  const anzahl = esEl("es-karte-anzahl");
  if (anzahl) {
    const aus = z.karte.filter((g) => g.aus).length;
    anzahl.textContent = z.karte.length
      ? z.karte.length + (z.karte.length === 1 ? " Gericht" : " Gerichte") + (aus ? " · " + aus + " ausgeblendet" : "")
      : "noch leer";
  }
  const box = esEl("es-karte-verwalten");
  box.innerHTML = z.karte.length
    ? z.karte.map((g, i) => `
        <div class="fr-paket-verwalten${g.aus ? " es-ger-aus" : ""}">
          <div class="fr-pv-info">
            <div class="fr-pv-name">${g.nummer ? `<span class="es-pv-nr">${escapeHtml(g.nummer)}</span> ` : ""}${escapeHtml(g.name)}${g.aus ? ' <span class="es-aus-marke">ausgeblendet</span>' : ""}</div>
            <div class="fr-pv-preis">${g.preisCent ? essenService.centLabel(g.preisCent) : "kostenlos"}${g.kategorie ? " · " + escapeHtml(g.kategorie) : ""}${g.beschreibung ? " · " + escapeHtml(g.beschreibung) : ""}</div>
          </div>
          <div class="fr-pv-aktionen">
            <button type="button" class="mini-btn" data-es-hoch="${escapeHtml(g.id)}" ${i === 0 ? "disabled" : ""} title="Nach oben" aria-label="${escapeHtml(g.name)} nach oben">▲</button>
            <button type="button" class="mini-btn" data-es-runter="${escapeHtml(g.id)}" ${i === z.karte.length - 1 ? "disabled" : ""} title="Nach unten" aria-label="${escapeHtml(g.name)} nach unten">▼</button>
            <button type="button" class="mini-btn${g.aus ? " es-auge-aus" : ""}" data-es-auge="${escapeHtml(g.id)}" aria-pressed="${g.aus}"
              title="${g.aus ? "Ausgeblendet – wieder anzeigen" : "Vorübergehend ausblenden"}" aria-label="${escapeHtml(g.name)} ${g.aus ? "wieder anzeigen" : "ausblenden"}">${g.aus ? "🙈" : "👁"}</button>
            <button type="button" class="mini-btn" data-es-edit="${escapeHtml(g.id)}" title="Bearbeiten" aria-label="${escapeHtml(g.name)} bearbeiten">✎</button>
            <button type="button" class="mini-btn" data-es-loeschen="${escapeHtml(g.id)}" title="Löschen" aria-label="${escapeHtml(g.name)} löschen">🗑</button>
          </div>
        </div>`).join("")
    : `<p class="fr-leer-hinweis">Noch keine Gerichte.</p>`;

  // ⚠️ Bugjagd 01.10.2026: Ergebnis auswerten – eine Ablehnung verpuffte hier still.
  const esVerschiebe = async (id, richtung) => {
    const res = await essenService.verschiebeGericht(id, richtung);
    if (!res.erfolg) esZeigeFehler("es-gericht-fehler", res.fehler);
  };
  box.querySelectorAll("[data-es-hoch]").forEach((b) => b.addEventListener("click", () => esVerschiebe(b.dataset.esHoch, -1)));
  box.querySelectorAll("[data-es-runter]").forEach((b) => b.addEventListener("click", () => esVerschiebe(b.dataset.esRunter, 1)));
  box.querySelectorAll("[data-es-auge]").forEach((b) => b.addEventListener("click", async () => {
    const g = esZustand.karte.find((x) => x.id === b.dataset.esAuge);
    if (!g) return;
    b.disabled = true;
    const res = await essenService.setzeGerichtAus(g.id, !g.aus);
    b.disabled = false;
    if (!res.erfolg) esZeigeFehler("es-gericht-fehler", res.fehler);
  }));
  box.querySelectorAll("[data-es-loeschen]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Dieses Gericht von der Karte nehmen? Schon abgeschickte Bestellungen bleiben, wie sie sind.")) return;
    const res = await essenService.loescheGericht(b.dataset.esLoeschen);
    if (!res.erfolg) esZeigeFehler("es-gericht-fehler", res.fehler);
  }));
  box.querySelectorAll("[data-es-edit]").forEach((b) => b.addEventListener("click", () => {
    const g = esZustand.karte.find((x) => x.id === b.dataset.esEdit);
    if (!g) return;
    esBearbeitetesGerichtId = g.id;
    esEl("es-ger-nummer").value = g.nummer;
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
    nummer: esEl("es-ger-nummer").value,
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
  ["es-ger-nummer", "es-ger-name", "es-ger-beschreibung", "es-ger-preis"].forEach((id) => { esEl(id).value = ""; });
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
  // ⚠️ Wie viele Bestellnummern erkannt wurden, muss VOR dem Übernehmen
  // dastehen. Steht dort 0, ist das Format falsch - und das fällt sonst erst
  // auf, wenn die Karte schon drin ist.
  const mitNummer = ergebnis.gerichte.filter((g) => g.nummer).length;

  box.innerHTML = `
    <div class="es-import-kopf">
      <b>${ergebnis.gerichte.length} Gericht${ergebnis.gerichte.length === 1 ? "" : "e"}</b>
      ${kategorien.size ? " in " + kategorien.size + " Kategorie" + (kategorien.size === 1 ? "" : "n") : " ohne Kategorie"}
      ${ohnePreis ? " · " + ohnePreis + " ohne Preis" : ""}
      ${mitNummer ? " · " + mitNummer + " mit Bestellnummer" : " · keine Bestellnummern erkannt"}
    </div>
    <div class="es-import-liste">
      ${ergebnis.gerichte.map((g) => `
        <div class="es-import-zeile">
          <span>${g.kategorie ? `<span class="es-import-kat">${escapeHtml(g.kategorie)}</span> ` : ""}${g.nummer ? `<span class="es-pv-nr">${escapeHtml(g.nummer)}</span> ` : ""}${escapeHtml(g.name)}${g.beschreibung ? ` <i>${escapeHtml(g.beschreibung)}</i>` : ""}</span>
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
  // ⚠️ Der Fokus allein reicht nicht: wer nach dem Lieferanten ins Telefonfeld
  // wechselt, hat den Lieferanten nicht mehr im Fokus – der 30-s-Takt schrieb
  // den alten Wert zurück, und „Speichern“ übernahm ihn mit „Gespeichert.“.
  // Deshalb der Merker je Feld: ein angefasstes Feld bleibt, die übrigen ziehen
  // weiter nach, damit „Speichern“ dort den aktuellen Stand schreibt.
  const setze = (id, wert) => {
    const el = esEl(id);
    if (el && !esEinstellungenBeruehrt.has(id) && document.activeElement !== el) el.value = wert || "";
  };
  setze("es-ein-titel", z.meta.titel);
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

  // ⚠️ In der zugeklappten Zeile muss stehen, ob gerade bestellt werden kann –
  // sonst klappt man den Kasten nur auf, um nachzusehen.
  const kurz = esEl("es-ein-kurz");
  if (kurz) {
    kurz.textContent = z.annahmeOffen
      ? "Annahme offen"
      : (!z.schalterAn ? "Annahme zu" : "außerhalb der Zeit");
  }

  // ⚠️ Der Beleg, dass der Tageswechsel gewirkt hat. Ohne ihn muss man erst
  // eine Bestellung durchschicken, um zu sehen, wie die nächste Lieferung heißt.
  const tagstand = esEl("es-ein-tagstand");
  if (tagstand) {
    const bisher = z.runden.filter((r) => r.tag === z.meta.titel).length;
    tagstand.textContent = "Die nächste Sammelbestellung heißt „" + z.meta.titel + " " + z.naechsteRundeNr + "“."
      + (bisher ? " Bisher an diesem Tag: " + bisher + "." : "");
  }

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

  // ⚠️ await: der PIN wird seit dem 15.09.2026 dem SERVER bewiesen, nicht im
  // Browser verglichen. Ohne await waere `res` ein Promise, `res.erfolg`
  // undefined -- die Anmeldung saehe dann bei JEDER Eingabe nach Fehlschlag
  // aus, auch beim richtigen PIN, und die Meldung waere leer.
  esEl("es-btn-admin-anmelden").addEventListener("click", async () => {
    const knopf = esEl("es-btn-admin-anmelden");
    knopf.disabled = true;
    try {
      const res = await essenService.authentifiziereAlsAdmin(esEl("es-admin-pin").value);
      esZeigeFehler("es-admin-login-fehler", res.erfolg ? "" : res.fehler);
      if (res.erfolg) esEl("es-admin-pin").value = "";
    } finally {
      knopf.disabled = false;
    }
  });

  ES_EIN_FELDER.forEach((id) => {
    const el = esEl(id);
    if (el) el.addEventListener("input", () => { esEinstellungenBeruehrt.add(id); });
  });

  esEl("es-ein-annahme").addEventListener("change", async () => {
    const res = await essenService.setzeAnnahme(esEl("es-ein-annahme").checked);
    esZeigeFehler("es-ein-fehler", res.erfolg ? "" : res.fehler);
  });

  esEl("es-btn-ein-speichern").addEventListener("click", async () => {
    const res = await essenService.setzeEinstellungen({
      titel: esEl("es-ein-titel").value,
      lieferantName: esEl("es-ein-lieferant").value,
      lieferantEmail: esEl("es-ein-email").value,
      bestellerName: esEl("es-ein-besteller").value,
      bestellerTelefon: esEl("es-ein-telefon").value,
      hinweis: esEl("es-ein-hinweis").value,
      annahmeOffen: esEl("es-ein-annahme").checked,
      annahmeVon: esMinutenAusZeit(esEl("es-ein-von").value),
      annahmeBis: esMinutenAusZeit(esEl("es-ein-bis").value),
    });
    // Erst wenn es wirklich drin steht, darf das nächste Update die Felder
    // wieder befüllen. Bei einem Fehler bleibt der Entwurf stehen.
    if (res.erfolg) esEinstellungenBeruehrt.clear();
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
    // ⚠️ Die Warnung auf den Anlege-Schirm, nicht in den Admin-Kasten: der
    // verschwindet mit dem Plan, und die Meldung gleich mit.
    if (res.warnung) esZeigeFehler("es-neu-fehler", res.warnung);
  });
}

// --- Start -----------------------------------------------------------------------
(function esInit() {
  esWireEvents();
  essenService.onZustandsAenderung(esRender);
})();

