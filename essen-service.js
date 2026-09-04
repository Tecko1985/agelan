// ===========================================================================
// essen-service.js – Firebase-Kapsel für die Essensbestellung der AgeLan.
//
// Vierter Bereich neben Turnier, Streamplan und Frühstück. Der Ablauf ist der,
// den es auf der LAN wirklich gibt:
//
//   1. Der Veranstalter hinterlegt eine Speisekarte (von Hand oder per Import).
//   2. Ein Teilnehmer stellt sich eine Bestellung zusammen – je Gericht mit
//      eigenem Sonderwunsch („Pommes mit Spezialsoße").
//   3. Er kommt nach vorne und bezahlt        → Status „bezahlt".
//   4. Der Veranstalter bestellt beim Lieferanten (E-Mail aus der App)
//                                              → Status „bestellt".
//   5. Das Essen kommt, er holt es ab          → Status „abgeholt".
//
// ⚠️ NICHT nach dem Muster des Frühstücks gebaut. Dort ist eine Bestellung
// `bestellungen/$datum/$uid` – EINE je Person und Morgen. Hier bestellt
// dieselbe Person am Wochenende mehrfach (mittags, abends, am nächsten Tag),
// und jede Bestellung durchläuft ihren eigenen Status. Deshalb ist jede
// Bestellung ein eigener Vorgang mit eigener Id.
//
// Eigener Top-Level-Knoten, bewusst nicht unter turniere/… oder fruehstueck/…:
// das Essen gehört zur Veranstaltung und überlebt das Löschen eines Turniers.
//
// ⚠️ Ein NEUER Top-Level-Knoten erbt KEINE Regel. Ohne den `essen`-Block in der
// Firebase-Konsole gilt Firebases Grundeinstellung „alles verboten", und jeder
// Schreibversuch scheitert mit PERMISSION_DENIED. Die Regeln stehen in
// `database.rules.json` und müssen dort eingespielt werden.
//
// Datenmodell (ein aktiver Plan unter essen/aktuell):
//   meta            : { titel, hostId, adminPin, erstelltAm, annahmeOffen,
//                       lieferantName, lieferantEmail,
//                       bestellerName, bestellerTelefon, hinweis }
//   karte/$gid      : { name, beschreibung, preisCent, kategorie, sort, erstelltAm }
//   runden/$rid     : { nr, titel, erstelltAm }
//   bestellungen/$oid : { uid, name, status, orga, rundeId, notiz, erstelltAm,
//                         aktualisiertAm,
//                         positionen: { $pid: { gerichtId, name, preisCent,
//                                               anzahl, sonderwunsch, sort } } }
//
// ⚠️ `runden` sind die Sammelbestellungen, die an den Lieferanten rausgehen –
// an einem Tag mehrere, zu verschiedenen Uhrzeiten. `bestellungen/$oid/rundeId`
// sagt, in welcher Mail eine Bestellung mitgegangen ist; leer heißt: noch in
// keiner. Ohne diese Zuordnung ließe sich hinterher nicht sagen, welches Essen
// zu welcher Lieferung gehört und welche Lieferung wie viel gekostet hat.
//
// ⚠️ Name UND Preis stehen in der Position, nicht nur die gerichtId. Eine
// abgeschickte Bestellung ist ein Beleg: sie muss lesbar bleiben, wenn das
// Gericht später von der Karte fliegt, und ihr Preis darf sich nicht ändern,
// nachdem jemand dafür bezahlt hat. Die gerichtId bleibt trotzdem drin – für
// die Sammelliste, die gleiche Gerichte über alle Bestellungen zusammenzählt.
//
// ⚠️ Preise stehen als GANZE CENT. Fließkomma-Euro verrechnet sich beim
// Summieren um Zehntelcent; „8,50" wird einmal beim Speichern zu 850 und
// danach nie wieder geteilt.
// ===========================================================================

const ES_BASIS = "essen/aktuell";
const ES_PIN_KEY = "agelan_admin_pin";      // derselbe Schlüssel wie Turnier, Stream und Frühstück
const ES_NAME_KEY = "agelan_streamer_name"; // denselben Namen wie im Streamplan vorschlagen

const ES_MAX_GERICHTE = 150;      // eine echte Speisekarte ist lang – der Import soll sie fassen
const ES_MAX_POSITIONEN = 20;     // je Bestellung
const ES_MAX_STUECK = 9;          // je Position – schützt vor Vertippern
const ES_MAX_PREIS_CENT = 10000;  // 100 € für ein Gericht ist die Obergrenze der Vernunft
const ES_MAX_BESTELLUNGEN = 300;
const ES_MAX_SONDERWUNSCH = 120;
const ES_MAX_RUNDEN = 60;         // Sammelbestellungen, die an einem Wochenende rausgehen

// Die Kette, die eine Bestellung durchläuft. Die Reihenfolge im Array IST die
// Reihenfolge des Ablaufs – „weiter" und „zurück" rechnen darüber.
const ES_STATUS_KETTE = ["neu", "bezahlt", "bestellt", "abgeholt"];
const ES_STATUS_TEXT = {
  neu:      { kurz: "offen",    lang: "Noch nicht bezahlt" },
  bezahlt:  { kurz: "bezahlt",  lang: "Bezahlt – wird beim Lieferanten bestellt" },
  bestellt: { kurz: "bestellt", lang: "Beim Lieferanten bestellt" },
  abgeholt: { kurz: "abgeholt", lang: "Abgeholt – erledigt" },
};
// ⚠️ Eine Orga-Bestellung durchläuft dieselbe Kette, aber „bezahlt" hieße dort
// etwas Falsches – es gibt nichts zu kassieren. Nur die Worte ändern sich,
// nicht der Ablauf: eine zweite Kette müsste an jeder Stelle mitgedacht werden,
// an der die erste vorkommt.
const ES_ORGA_STATUS_TEXT = {
  neu:     { kurz: "offen", lang: "Orga-Essen – noch nicht freigegeben" },
  bezahlt: { kurz: "frei",  lang: "Orga-Essen – geht auf die Organisation" },
};

// Was der Veranstalter als Nächstes anklickt, wenn der Schritt getan ist.
const ES_STATUS_KNOPF = {
  neu:      "Hat bezahlt",
  bezahlt:  "Beim Lieferanten bestellt",
  bestellt: "Abgeholt",
};
const ES_ORGA_STATUS_KNOPF = {
  neu: "Freigeben",
};

function esStatusText(status, orga) {
  return (orga && ES_ORGA_STATUS_TEXT[status]) || ES_STATUS_TEXT[status];
}
function esStatusKnopf(status, orga) {
  if (orga && ES_ORGA_STATUS_KNOPF[status]) return ES_ORGA_STATUS_KNOPF[status];
  return ES_STATUS_KNOPF[status] || "";
}

// --- lokaler Zustand -------------------------------------------------------
let esEigeneUid = null;
let esRoh = null;            // roher { meta, karte, bestellungen }-Snapshot
let esListener = null;
// true, sobald Firebase das Lesen ablehnt – praktisch immer die fehlende Regel.
let esZugriffFehler = false;

const esAuthBereit = new Promise((resolve) => {
  auth.onAuthStateChanged((user) => {
    if (user) {
      esEigeneUid = user.uid;
      resolve(user.uid);
    }
  });
});

// --- Werte -----------------------------------------------------------------
function esZahl(wert, ersatz) {
  const n = Number(wert);
  return Number.isFinite(n) ? n : ersatz;
}

function esText(wert, maxLaenge) {
  return String(wert == null ? "" : wert).trim().slice(0, maxLaenge);
}

// „8,50" und „8.50" und „8" führen alle auf 850 Cent. Leer heißt: kostenlos.
function esPreisNachCent(eingabe) {
  const roh = String(eingabe == null ? "" : eingabe).trim().replace(/€/g, "").replace(",", ".").trim();
  if (!roh) return 0;
  const n = Number(roh);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function esCentLabel(cent) {
  const c = Math.max(0, Math.round(esZahl(cent, 0)));
  return (c / 100).toFixed(2).replace(".", ",") + " €";
}

function esZeitLabel(ms) {
  const n = esZahl(ms, 0);
  if (!n) return "";
  const d = new Date(n);
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "., " +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function esNeueId(praefix) {
  return praefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

// --- Bestellzeitfenster ----------------------------------------------------
// Ein Punkt für „jetzt". Das Zeitfenster ist die einzige Stelle des Essens, an
// der die echte Uhr über Sichtbarkeit entscheidet – zum Durchspielen muss sie
// sich verstellen lassen, ohne dafür die Systemzeit anzufassen.
let esZeitVersatzMs = 0;
function esJetzt() {
  return Date.now() + esZeitVersatzMs;
}

// Minuten seit 0:00 des heutigen Tages.
function esMinuteJetzt() {
  const d = new Date(esJetzt());
  return d.getHours() * 60 + d.getMinutes();
}

function esUhrLabel(min) {
  const m = Math.max(0, Math.min(1439, Math.round(esZahl(min, 0))));
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

// null = kein Fenster gesetzt, dann gilt der ganze Tag.
function esFensterWert(wert) {
  const n = Math.round(esZahl(wert, -1));
  return (n >= 0 && n <= 1439) ? n : null;
}

// ⚠️ `von > bis` heißt ÜBER MITTERNACHT (z. B. 18:00–02:00). Auf einer LAN ist
// das der Normalfall, nicht die Ausnahme – ohne diesen Zweig wäre ein solches
// Fenster rund um die Uhr geschlossen.
function esImFenster(von, bis, minute) {
  if (von === null || bis === null) return true;   // kein Fenster = immer offen
  if (von === bis) return true;                    // 10:00–10:00 liest sich wie „ganztags"
  return von < bis ? (minute >= von && minute < bis) : (minute >= von || minute < bis);
}

// --- Admin-Status ----------------------------------------------------------
function esGespeicherterPin() {
  try {
    return localStorage.getItem(ES_PIN_KEY);
  } catch (e) {
    return null;
  }
}

function esIstAdmin() {
  // Ein Veranstalter-Konto gilt überall, auch ohne PIN und auf jedem Gerät.
  if (typeof kontoIstVeranstalter === "function" && kontoIstVeranstalter()) return true;
  const meta = esRoh && esRoh.meta;
  if (!meta) return false;
  if (meta.hostId && meta.hostId === esEigeneUid) return true;
  return !!(meta.adminPin && esGespeicherterPin() === meta.adminPin);
}

// Beim Anlegen den PIN vorschlagen, den Turnier oder Frühstück schon haben –
// es ist derselbe Veranstalter und derselbe Abend.
function esVorhandenerPin() {
  const gemerkt = esGespeicherterPin();
  if (gemerkt) return gemerkt;
  try {
    if (typeof fruehstueckService !== "undefined") {
      const z = fruehstueckService.getZustand();
      if (z && z.vorhanden && z.istAdmin && z.meta && z.meta.adminPin) return z.meta.adminPin;
    }
  } catch (e) { /* kein Frühstück */ }
  try {
    if (typeof turnierService !== "undefined" && turnierService.getZustand) {
      const z = turnierService.getZustand();
      if (z && z.vorhanden && z.istAdmin && z.meta && z.meta.adminPin) return z.meta.adminPin;
    }
  } catch (e) { /* kein Turnier */ }
  return "";
}

// ===========================================================================
// Zustands-Aufbereitung für die UI
// ===========================================================================

function esKarteListe(karteRoh) {
  const liste = Object.entries(karteRoh || {}).map(([id, g]) => ({
    id,
    name: esText(g && g.name, 80),
    beschreibung: esText(g && g.beschreibung, 200),
    kategorie: esText(g && g.kategorie, 40),
    preisCent: Math.max(0, Math.round(esZahl(g && g.preisCent, 0))),
    sort: esZahl(g && g.sort, 0),
    erstelltAm: esZahl(g && g.erstelltAm, 0),
  }));
  liste.sort((a, b) => (a.sort - b.sort) || (a.erstelltAm - b.erstelltAm) || a.name.localeCompare(b.name));
  return liste;
}

// Die Karte nach Kategorien gruppiert, in der Reihenfolge, in der die
// Kategorien zum ersten Mal vorkommen. ⚠️ Nicht alphabetisch sortieren: eine
// Speisekarte hat eine gewollte Reihenfolge (Vorspeisen vor Nachtisch), und
// genau die bringt der Import mit.
function esKarteNachKategorie(karte) {
  const gruppen = [];
  const index = new Map();
  karte.forEach((g) => {
    const schluessel = g.kategorie || "";
    if (!index.has(schluessel)) {
      index.set(schluessel, gruppen.length);
      gruppen.push({ kategorie: schluessel, gerichte: [] });
    }
    gruppen[index.get(schluessel)].gerichte.push(g);
  });
  return gruppen;
}

function esPositionenListe(positionenRoh) {
  const liste = Object.entries(positionenRoh || {}).map(([id, p]) => {
    const anzahl = Math.max(1, Math.min(ES_MAX_STUECK, Math.round(esZahl(p && p.anzahl, 1))));
    const preisCent = Math.max(0, Math.round(esZahl(p && p.preisCent, 0)));
    return {
      id,
      gerichtId: esText(p && p.gerichtId, 60),
      name: esText(p && p.name, 80) || "Gericht",
      sonderwunsch: esText(p && p.sonderwunsch, ES_MAX_SONDERWUNSCH),
      anzahl,
      preisCent,
      summeCent: preisCent * anzahl,
      sort: esZahl(p && p.sort, 0),
    };
  });
  liste.sort((a, b) => a.sort - b.sort);
  return liste;
}

function esBestellungenListe(bestellungenRoh) {
  const liste = [];
  Object.entries(bestellungenRoh || {}).forEach(([id, b]) => {
    const positionen = esPositionenListe(b && b.positionen);
    if (!positionen.length) return;   // eine Bestellung ohne Positionen ist keine
    const status = ES_STATUS_KETTE.indexOf(esText(b && b.status, 20)) >= 0 ? b.status : "neu";
    const orga = !!(b && b.orga);
    const summeCent = positionen.reduce((s, p) => s + p.summeCent, 0);
    liste.push({
      id,
      uid: esText(b && b.uid, 60),
      name: esText(b && b.name, 40) || "Ohne Namen",
      notiz: esText(b && b.notiz, 200),
      status,
      statusIndex: ES_STATUS_KETTE.indexOf(status),
      // ⚠️ Vorbelegung. Was wirklich dransteht und was als Nächstes anzuklicken
      // ist, setzt esSchritteSetzen() – erst dort ist bekannt, ob die Bestellung
      // schon in einer Sammelbestellung steckt.
      statusKurz: esStatusText(status, orga).kurz,
      statusLang: esStatusText(status, orga).lang,
      naechsterStatus: "",
      naechsterKnopf: "",
      zurueckStatus: "",
      zurueckKnopf: "",
      inRunde: false,
      // Gehört die Bestellung zur Organisation? Dann zahlt niemand dafür.
      // ⚠️ Steht in der Bestellung, nicht im Konto: was beim Abschicken galt,
      // gilt für diesen Beleg – und der Veranstalter kann es je Bestellung
      // umstellen, ohne jemandem das Merkmal wegzunehmen.
      orga,
      // Zu welcher Sammelbestellung an den Lieferanten gehört sie? "" heißt:
      // zu keiner – sie liegt noch im Stapel, aus dem die nächste
      // zusammengestellt wird.
      rundeId: esText(b && b.rundeId, 60),
      positionen,
      stueck: positionen.reduce((s, p) => s + p.anzahl, 0),
      summeCent,
      // Was wirklich kassiert wird. ⚠️ Immer diesen Wert summieren, nie
      // summeCent – sonst steht die Orga in der Kasse.
      zahltCent: orga ? 0 : summeCent,
      erstelltAm: esZahl(b && b.erstelltAm, 0),
      aktualisiertAm: esZahl(b && b.aktualisiertAm, 0),
      istEigene: esText(b && b.uid, 60) === esEigeneUid,
      // ⚠️ Bezahlt heißt eingefroren. Wer bezahlt hat, darf seine Bestellung
      // nicht mehr umbauen – sonst wäre der kassierte Betrag ein anderer als
      // der bestellte. Ab da ändert nur noch der Veranstalter. Den endgültigen
      // Wert setzt esSchritteSetzen(); rausgeschickt ist genauso eingefroren.
      aenderbar: status === "neu",
    });
  });
  // Älteste zuerst: die Reihenfolge, in der abgearbeitet wird.
  liste.sort((a, b) => (a.erstelltAm - b.erstelltAm) || a.name.localeCompare(b.name));
  return liste;
}

// Die Sammelliste für den Lieferanten: gleiche Gerichte mit gleichem
// Sonderwunsch zusammengezählt. ⚠️ Der Sonderwunsch gehört in den Schlüssel –
// „Pommes" und „Pommes mit Spezialsoße" sind für die Küche zwei Dinge.
function esSammelliste(bestellungen) {
  const nach = new Map();
  bestellungen.forEach((b) => {
    b.positionen.forEach((p) => {
      // Schluessel ueber JSON statt ueber ein Trennzeichen: ein Gerichtname
      // darf jedes Zeichen enthalten, und ein selbst gewaehltes Trennzeichen
      // waere genau dort die naechste Falle.
      const schluessel = JSON.stringify([p.gerichtId || p.name, p.sonderwunsch.toLowerCase()]);
      if (!nach.has(schluessel)) {
        nach.set(schluessel, {
          name: p.name,
          sonderwunsch: p.sonderwunsch,
          anzahl: 0,
          anzahlOrga: 0,        // wie viele davon gehen auf die Organisation
          preisCent: p.preisCent,
          preisEinheitlich: true,
          summeCent: 0,         // Warenwert aller Stücke
          zahltCent: 0,         // was davon wirklich zu zahlen ist
        });
      }
      const z = nach.get(schluessel);
      // ⚠️ Preise sind je Bestellung festgeschrieben. Hat sich die Karte
      // zwischendurch geändert, stecken in derselben Zeile zwei verschiedene
      // Stückpreise – dann darf kein „à X €" danebenstehen, das wäre gelogen.
      if (p.preisCent !== z.preisCent) z.preisEinheitlich = false;
      z.anzahl += p.anzahl;
      z.summeCent += p.summeCent;
      if (b.orga) z.anzahlOrga += p.anzahl;
      else z.zahltCent += p.summeCent;
    });
  });
  const liste = Array.from(nach.values());
  // Alphabetisch nach Gericht, und innerhalb eines Gerichts das schlichte vor
  // den Sonderwünschen – so stehen „3x Pommes" und „2x Pommes (mit Soße)"
  // untereinander und die Küche sieht auf einen Blick, was zusammengehört.
  liste.sort((a, b) =>
    (a.name.localeCompare(b.name)) ||
    (a.sonderwunsch ? 1 : 0) - (b.sonderwunsch ? 1 : 0) ||
    a.sonderwunsch.localeCompare(b.sonderwunsch)
  );
  return liste;
}

// ===========================================================================
// Bestellrunden – die Sammelbestellungen, die wirklich rausgehen
// ===========================================================================
//
// Michel am 2026-09-04: „es kann wirklich sein, dass an einem Tag zehn
// Bestellungen rausgehen, unterschiedliche zu unterschiedlichen Uhrzeiten, die
// dann auch zu unterschiedlichen Uhrzeiten geliefert werden und die müssen dann
// im Nachgang auch eindeutig zuzuweisen und eindeutig abzurechnen sein."
//
// ⚠️ Eine Runde entsteht in dem Moment, in dem die Mail rausgeht – nicht vorher.
// Vorher gibt es nur einen Stapel einzelner Bestellungen; was davon mitgeht,
// entscheidet sich erst beim Abschicken. Eine vorher angelegte Runde, in die
// man sich einträgt, wäre ein zweiter Ort, an dem gepflegt werden muss, wer
// mitisst – und der wäre beim Abschicken regelmäßig veraltet.
//
// ⚠️ Die Nummer kommt aus `meta.rundeZaehler` und wird NIE wieder vergeben,
// auch wenn eine Runde später leer wird und verschwindet. „Donnerstag 2" steht
// in einer Mail beim Lieferanten; zwei verschiedene Mails mit demselben Namen
// wären hinterher nicht mehr auseinanderzuhalten.
//
// ⚠️ Der Titel wird beim Anlegen festgeschrieben, nicht aus `meta.titel`
// gerechnet. Wird der Plan später umbenannt, heißt eine verschickte Runde
// weiter so, wie sie beim Lieferanten heißt.
function esRundenListe(rundenRoh, bestellungen) {
  const nachRunde = new Map();
  bestellungen.forEach((b) => {
    if (!b.rundeId) return;
    if (!nachRunde.has(b.rundeId)) nachRunde.set(b.rundeId, []);
    nachRunde.get(b.rundeId).push(b);
  });

  const liste = Object.entries(rundenRoh || {}).map(([id, r]) => {
    const mit = nachRunde.get(id) || [];
    const summeCent = mit.reduce((s, b) => s + b.summeCent, 0);
    const zahltCent = mit.reduce((s, b) => s + b.zahltCent, 0);
    // Was in dieser Runde noch hereinkommen muss. ⚠️ Über „auch unbezahlte"
    // geht auch Unbezahltes mit raus – dann steht hier, wem hinterherzulaufen
    // ist, und zwar je Runde und nicht nur als eine große Zahl oben.
    const offenCent = mit
      .filter((b) => b.status === "neu" && !b.orga)
      .reduce((s, b) => s + b.zahltCent, 0);
    const abgeholt = mit.filter((b) => b.status === "abgeholt").length;
    return {
      id,
      nr: Math.round(esZahl(r && r.nr, 0)),
      titel: esText(r && r.titel, 80) || "Bestellung",
      // Der Name des Plans, wie er beim Anlegen dieser Runde lautete – daran
      // hängt die Nummerierung, siehe esNaechsteRundeNr().
      tag: esText(r && r.tag, 60),
      erstelltAm: esZahl(r && r.erstelltAm, 0),
      // Wann zuletzt per Discord Bescheid gegeben wurde und wie viele es
      // bekamen. ⚠️ Steht in Firebase, nicht nur im Speicher: sonst ist nach
      // einem Neuladen nicht mehr zu sehen, ob überhaupt schon jemand
      // benachrichtigt wurde – und man schickt es zum zweiten Mal.
      bescheidAm: esZahl(r && r.bescheidAm, 0),
      bescheidErreicht: Math.max(0, Math.round(esZahl(r && r.bescheidErreicht, 0))),
      bestellungen: mit,
      anzahl: mit.length,
      stueck: mit.reduce((s, b) => s + b.stueck, 0),
      summeCent,
      zahltCent,
      orgaCent: summeCent - zahltCent,
      offenCent,
      abgeholt,
      fertig: mit.length > 0 && abgeholt === mit.length,
    };
  });
  // Die neueste zuerst: an ihr wird gearbeitet, die älteren sind Nachweis.
  // ⚠️ Nach der UHRZEIT sortiert, nicht nach der Nummer – die zählt je Tag neu,
  // und „Freitag 1" ist jünger als „Donnerstag 3".
  liste.sort((a, b) => (b.erstelltAm - a.erstelltAm) || (b.nr - a.nr));
  return liste;
}

// Was als Nächstes anzuklicken ist, hängt davon ab, OB die Bestellung schon
// beim Lieferanten liegt. Deshalb wird es erst gesetzt, wenn die Runden stehen –
// nicht schon beim Einlesen der Bestellung.
//
// ⚠️ In einer Runde ist „bestellt" bereits wahr. Ein Teilnehmer, der beim
// Rausschicken noch nicht bezahlt hatte, bleibt deshalb auf `neu` stehen und
// steckt trotzdem in der Runde. Würde er beim Abschicken auf „bestellt"
// gehoben, wäre danach nicht mehr erkennbar, dass er noch Geld schuldet – genau
// das ist beim Bauen aufgefallen: „noch zu kassieren" stand für immer auf 0,00 €.
// Sein „Hat bezahlt" springt dafür direkt auf „bestellt" und überspringt den
// Schritt, der schon passiert ist.
function esSchritteSetzen(b) {
  b.naechsterStatus = "";
  b.naechsterKnopf = "";
  b.zurueckStatus = "";
  b.zurueckKnopf = "";

  if (b.inRunde) {
    if (b.status === "neu") {
      // ⚠️ Zielt auf „bestellt", nicht auf „bezahlt": beim Lieferanten liegt
      // sie ja schon. Die Beschriftung bleibt trotzdem „Hat bezahlt" – das ist
      // die Handlung, die der Veranstalter gerade tut.
      b.naechsterStatus = "bestellt";
      b.naechsterKnopf = esStatusKnopf("neu", b.orga);
      b.statusKurz = b.orga ? "offen" : "unbezahlt";
      b.statusLang = b.orga
        ? "Orga-Essen – beim Lieferanten bestellt, noch nicht freigegeben"
        : "Beim Lieferanten bestellt – das Geld fehlt noch";
    } else if (b.status === "bezahlt") {
      b.naechsterStatus = "bestellt";
      b.naechsterKnopf = esStatusKnopf("bezahlt", b.orga);
    } else if (b.status === "bestellt") {
      b.naechsterStatus = "abgeholt";
      b.naechsterKnopf = esStatusKnopf("bestellt", b.orga);
    }
  } else if (b.status === "neu") {
    b.naechsterStatus = "bezahlt";
    b.naechsterKnopf = esStatusKnopf("neu", b.orga);
  } else if (b.status === "bezahlt") {
    // ⚠️ Im Stapel gibt es KEINEN „Beim Lieferanten bestellt"-Knopf mehr. Dieser
    // Schritt gehört zur Sammelbestellung – sonst entstünde eine Bestellung, die
    // auf „bestellt" steht und in keiner Mail vorkommt, und die hinterher weder
    // zuzuordnen noch abzurechnen wäre.
    b.naechsterKnopf = "";
  } else if (b.status === "bestellt") {
    // Altbestand aus der Zeit vor den Runden.
    b.naechsterStatus = "abgeholt";
    b.naechsterKnopf = esStatusKnopf("bestellt", b.orga);
  }

  // Der Rückweg. ⚠️ In einer Runde ist er GENAU die Umkehrung des Vorwärtswegs
  // und lässt die Bestellung in der Lieferung: „abgeholt" zurück auf „bestellt",
  // „bestellt" zurück auf „neu" (also unbezahlt). Michel am 04.09.2026: „ich
  // brauche auch einen rückweg wenn jemand aus versehen abgeholt angeklickt
  // hat." Vorher gab es dort nur „herausnehmen" – das hätte die Bestellung aus
  // der Sammelbestellung gerissen, statt bloß einen Fehlklick zurückzunehmen.
  //
  // ⚠️ Aus `neu` heraus gibt es in einer Runde keinen Schritt zurück: das ist
  // dort der Anfangszustand. Wer die Bestellung ganz aus der Lieferung nehmen
  // will, nimmt „herausnehmen".
  if (b.inRunde) {
    if (b.status === "abgeholt") {
      b.zurueckStatus = "bestellt";
      b.zurueckKnopf = "↺ doch nicht abgeholt";
    } else if (b.status === "bestellt") {
      b.zurueckStatus = "neu";
      b.zurueckKnopf = b.orga ? "↺ doch nicht freigegeben" : "↺ doch nicht bezahlt";
    }
  } else if (b.statusIndex > 0) {
    b.zurueckStatus = ES_STATUS_KETTE[b.statusIndex - 1];
    b.zurueckKnopf = b.status === "bezahlt"
      ? (b.orga ? "↺ doch nicht freigegeben" : "↺ doch nicht bezahlt")
      : "↺ zurück";
  }

  // ⚠️ Wer schon beim Lieferanten liegt, darf seine Bestellung nicht mehr
  // umbauen – auch dann nicht, wenn er noch auf `neu` steht, weil er nicht
  // bezahlt hat. Das Essen ist ja bestellt.
  b.aenderbar = b.status === "neu" && !b.inRunde;
}

// ⚠️ Die Nummer zählt JE TAG neu. Michel: „Donnerstag eins, zwei, drei, vier –
// und wenn dann der Freitag ist, Freitag eins zwei drei vier." Maßgeblich ist
// der Name des Plans: heißt er anders als beim letzten Rausschicken
// (`meta.rundeTag`), fängt die Zählung wieder bei 1 an.
//
// ⚠️ Der Zähler in `meta` ist die Wahrheit, die höchste vergebene Nummer
// desselben Tages nur die Absicherung: verschwindet die letzte Runde wieder,
// darf ihre Nummer trotzdem nicht ein zweites Mal an eine andere Mail gehen.
// Und wer den Plan zurückbenennt, darf keine zweite „Donnerstag 2" bekommen.
function esNaechsteRundeNr() {
  const meta = (esRoh && esRoh.meta) || {};
  const tag = esText(meta.titel, 60);
  let hoechste = esText(meta.rundeTag, 60) === tag
    ? Math.max(0, Math.round(esZahl(meta.rundeZaehler, 0)))
    : 0;
  Object.values((esRoh && esRoh.runden) || {}).forEach((r) => {
    if (esText(r && r.tag, 60) !== tag) return;
    hoechste = Math.max(hoechste, Math.round(esZahl(r && r.nr, 0)));
  });
  return hoechste + 1;
}

// ===========================================================================
// Statistik: wer am meisten bestellt hat, was am meisten bestellt wurde
// ===========================================================================
//
// ⚠️ Gruppiert nach NAMEN, nicht nach `uid`. Der Name kommt aus dem
// angemeldeten Konto und ist auf der Veranstaltung eindeutig; die `uid` waere
// hier die schlechtere Wahl, weil dieselbe Person auf Handy und Notebook zwei
// davon hat und dann zweimal in der Liste stuende. Derselbe Schluessel wie beim
// Discord-Sammelversand.
//
// ⚠️ Die Betraege sind WARENWERT, nicht das kassierte Geld. Die Frage ist „wer
// hat am meisten bestellt", nicht „wer hat am meisten bezahlt" – Orga-Essen
// zaehlt mit und steht als Marke daneben. Wer das verwechselt, liest die Liste
// als Kassenstand.
// ⚠️ Gleicher Wert heisst gleicher Platz, und der naechste Platz ueberspringt
// die geteilten. Ohne das haette bei zwei Leuten mit je vier Bestellungen einer
// „Platz 2" und koennte sich zu Recht beschweren. Die Liste muss schon sortiert
// sein.
function esPlaetzeSetzen(liste) {
  let platz = 0;
  let vorher = null;
  liste.forEach((eintrag, i) => {
    if (eintrag.anzahl !== vorher) { platz = i + 1; vorher = eintrag.anzahl; }
    eintrag.platz = platz;
  });
}

function esStatistik(bestellungen, runden) {
  const liste = bestellungen || [];

  const nachPerson = new Map();
  liste.forEach((b) => {
    const schluessel = b.name.trim().toLowerCase();
    if (!schluessel) return;
    if (!nachPerson.has(schluessel)) {
      nachPerson.set(schluessel, {
        name: b.name.trim(),
        anzahl: 0, stueck: 0, summeCent: 0, zahltCent: 0, orgaAnzahl: 0,
      });
    }
    const p = nachPerson.get(schluessel);
    p.anzahl += 1;
    p.stueck += b.stueck;
    p.summeCent += b.summeCent;
    p.zahltCent += b.zahltCent;
    if (b.orga) p.orgaAnzahl += 1;
  });

  const leute = Array.from(nachPerson.values());
  leute.sort((a, b) =>
    (b.anzahl - a.anzahl) || (b.stueck - a.stueck) ||
    (b.summeCent - a.summeCent) || a.name.localeCompare(b.name)
  );
  esPlaetzeSetzen(leute);

  const nachGericht = new Map();
  liste.forEach((b) => b.positionen.forEach((pos) => {
    // ⚠️ Ohne den Sonderwunsch im Schluessel: „Pommes" und „Pommes mit
    // Spezialsosse" sind hier EIN Gericht. Anders als in der Sammelliste fuer
    // die Kueche – dort sind es zwei Dinge, hier zaehlt, was gegessen wurde.
    const schluessel = pos.gerichtId || pos.name.toLowerCase();
    if (!nachGericht.has(schluessel)) {
      nachGericht.set(schluessel, { name: pos.name, anzahl: 0, summeCent: 0 });
    }
    const g = nachGericht.get(schluessel);
    g.anzahl += pos.anzahl;
    g.summeCent += pos.summeCent;
  }));
  const gerichte = Array.from(nachGericht.values());
  gerichte.sort((a, b) => (b.anzahl - a.anzahl) || a.name.localeCompare(b.name));
  // ⚠️ Auch hier gleicher Wert = gleicher Platz. Beim Bauen stand „5x Pommes"
  // auf Gold und „5x Salami" auf Silber, obwohl beide gleich oft bestellt
  // wurden – der Unterschied war allein die alphabetische Reihenfolge.
  esPlaetzeSetzen(gerichte);

  return {
    leute,
    gerichte,
    anzahlBestellungen: liste.length,
    anzahlLeute: leute.length,
    anzahlStueck: liste.reduce((s, b) => s + b.stueck, 0),
    summeCent: liste.reduce((s, b) => s + b.summeCent, 0),
    zahltCent: liste.reduce((s, b) => s + b.zahltCent, 0),
    anzahlRunden: (runden || []).length,
    spitzenwert: leute.length ? leute[0].anzahl : 0,
  };
}

function esGetZustand() {
  const meta = (esRoh && esRoh.meta) || null;
  if (!meta || !meta.titel) {
    return {
      vorhanden: false,
      meta: null,
      karte: [],
      kategorien: [],
      bestellungen: [],
      runden: [],
      ohneRunde: [],
      stapel: [],
      altbestand: [],
      naechsteRundeNr: 1,
      meine: [],
      istAdmin: false,
      eigeneUid: esEigeneUid,
      vorhandenerPin: esVorhandenerPin(),
      zugriffFehler: esZugriffFehler,
    };
  }
  const karte = esKarteListe(esRoh.karte);
  const bestellungen = esBestellungenListe(esRoh.bestellungen);
  const meine = bestellungen.filter((b) => b.istEigene);
  const runden = esRundenListe(esRoh.runden, bestellungen);
  // Der Stapel: alles, was noch in keiner verschickten Sammelbestellung steckt.
  // ⚠️ Eine Bestellung, deren `rundeId` auf eine Runde zeigt, die es nicht mehr
  // gibt, gehört hierher – sonst fiele sie aus jeder Ansicht heraus und wäre
  // weder abzurechnen noch abzuholen.
  const bekannteRunden = new Set(runden.map((r) => r.id));
  const ohneRunde = bestellungen.filter((b) => !b.rundeId || !bekannteRunden.has(b.rundeId));
  ohneRunde.forEach((b) => { b.inRunde = false; });
  runden.forEach((r) => r.bestellungen.forEach((b) => { b.inRunde = true; }));
  bestellungen.forEach(esSchritteSetzen);

  // ⚠️ „Noch nicht rausgeschickt" stimmt nicht für ALLES ohne Runde. Eine
  // Bestellung aus der Zeit vor den Sammelbestellungen steht auf „bestellt"
  // oder „abgeholt" und hat trotzdem keine – die gehört nicht unter eine
  // Überschrift, die das Gegenteil behauptet. Michel am 2026-09-04 im Bild:
  // seine Testbestellung stand als „bestellt" unter „noch nicht rausgeschickt".
  const grenze = ES_STATUS_KETTE.indexOf("bestellt");
  const stapel = ohneRunde.filter((b) => b.statusIndex < grenze);
  const altbestand = ohneRunde.filter((b) => b.statusIndex >= grenze);

  const zaehler = {};
  ES_STATUS_KETTE.forEach((s) => { zaehler[s] = 0; });
  bestellungen.forEach((b) => { zaehler[b.status] += 1; });

  // ⚠️ „Offen" ist Geld, das noch hereinkommen muss – Orga-Bestellungen gehören
  // da nicht hinein, sonst wartet man auf einen Betrag, den nie jemand bringt.
  const offeneCent = bestellungen
    .filter((b) => b.status === "neu" && !b.orga)
    .reduce((s, b) => s + b.zahltCent, 0);
  const orgaGesamtCent = bestellungen.filter((b) => b.orga).reduce((s, b) => s + b.summeCent, 0);

  // Zwei Dinge müssen stimmen, damit bestellt werden kann: der Schalter des
  // Veranstalters UND das Zeitfenster.
  // ⚠️ Getrennt gehalten, weil die Oberfläche verschieden erklären muss, warum
  // gerade nichts geht – „der Veranstalter hat zugemacht" ist etwas anderes als
  // „ab 10:00 wieder".
  const schalterAn = meta.annahmeOffen !== false;   // fehlt das Feld, ist offen der Normalfall
  const von = esFensterWert(meta.annahmeVon);
  const bis = esFensterWert(meta.annahmeBis);
  const imFenster = esImFenster(von, bis, esMinuteJetzt());

  return {
    vorhanden: true,
    meta,
    annahmeOffen: schalterAn && imFenster,
    schalterAn,
    imFenster,
    fensterVon: von,
    fensterBis: bis,
    fensterLabel: (von === null || bis === null || von === bis)
      ? "" : esUhrLabel(von) + "–" + esUhrLabel(bis) + " Uhr",
    karte,
    kategorien: esKarteNachKategorie(karte),
    bestellungen,
    runden,
    ohneRunde,
    stapel,
    altbestand,
    naechsteRundeNr: esNaechsteRundeNr(),
    meine,
    zaehler,
    summeGesamtCent: bestellungen.reduce((s, b) => s + b.summeCent, 0),
    zahltGesamtCent: bestellungen.reduce((s, b) => s + b.zahltCent, 0),
    orgaGesamtCent,
    anzahlOrga: bestellungen.filter((b) => b.orga).length,
    offeneCent,
    istAdmin: esIstAdmin(),
    eigeneUid: esEigeneUid,
    vorhandenerPin: esVorhandenerPin(),
    zugriffFehler: esZugriffFehler,
  };
}

// ===========================================================================
// Text für den Lieferanten
// ===========================================================================
//
// ⚠️ Es stehen KEINE Namen der Teilnehmer drin. Der Lieferant braucht Mengen
// und Sonderwünsche, sonst nichts – wer was bestellt hat, geht ihn nichts an
// und hat in einer E-Mail an einen Dritten nichts verloren. Das gilt auch für
// den Orga-Block: dort steht, DASS es Orga-Essen ist, nicht WESSEN.
function esBestelltext(bestellungen, meta) {
  // ⚠️ EINE Liste, nicht zwei Blöcke. Die Küche macht fünf Salami, egal wer sie
  // bezahlt – zwei Blöcke hätten daraus „4x Salami" und „1x Salami" gemacht und
  // jemanden zum Zusammenzählen gezwungen. Der Orga-Anteil steht stattdessen
  // als Vermerk an der Zeile, an der er hingehört.
  const liste = esSammelliste(bestellungen);
  const summeCent = liste.reduce((s, p) => s + p.summeCent, 0);
  const zahltCent = liste.reduce((s, p) => s + p.zahltCent, 0);
  const orgaCent = summeCent - zahltCent;

  const lieferant = esText(meta && meta.lieferantName, 80);
  const besteller = esText(meta && meta.bestellerName, 60);
  const telefon = esText(meta && meta.bestellerTelefon, 40);
  const hinweis = esText(meta && meta.hinweis, 400);

  const zeilen = [];
  zeilen.push(lieferant ? "Hallo " + lieferant + "," : "Hallo,");
  zeilen.push("");
  zeilen.push("wir möchten folgendes bestellen:");
  zeilen.push("");

  liste.forEach((p) => {
    // Kopfzeile: Menge, Gericht, Stückpreis, Zeilensumme.
    // Der Stückpreis entfällt, wenn die Zeile verschiedene Preise mischt.
    let kopf = p.anzahl + "x " + p.name;
    if (p.preisCent || p.summeCent) {
      kopf += p.preisEinheitlich
        ? " à " + esCentLabel(p.preisCent) + " = " + esCentLabel(p.summeCent)
        : " = " + esCentLabel(p.summeCent);
    }
    zeilen.push(kopf);

    if (p.sonderwunsch) zeilen.push("   Sonderwunsch: " + p.sonderwunsch);

    // ⚠️ Der Orga-Vermerk gehört an die Zeile, nicht nur in die Endsumme:
    // sonst müsste der Lieferant selbst herausfinden, welche der fünf Pizzen
    // gemeint sind.
    if (p.anzahlOrga > 0) {
      zeilen.push(p.anzahlOrga >= p.anzahl
        ? "   alles für die Organisation, dafür nichts zu zahlen"
        : "   davon " + p.anzahlOrga + "x für die Organisation, zu zahlen " + esCentLabel(p.zahltCent));
    }
  });

  zeilen.push("");
  zeilen.push(orgaCent
    ? "Zu zahlen: " + esCentLabel(zahltCent) +
      "  (Warenwert " + esCentLabel(summeCent) + ", davon " + esCentLabel(orgaCent) + " für die Organisation)"
    : "Zu zahlen: " + esCentLabel(zahltCent));

  if (hinweis) {
    zeilen.push("");
    zeilen.push(hinweis);
  }
  zeilen.push("");
  zeilen.push("Viele Grüße");
  if (besteller) zeilen.push(besteller);
  if (telefon) zeilen.push("Telefon: " + telefon);

  const betreff = "Sammelbestellung" + (besteller ? " – " + besteller : "");
  return {
    betreff,
    text: zeilen.join("\n"),
    anzahlBestellungen: bestellungen.length,
    anzahlPositionen: liste.reduce((s, p) => s + p.anzahl, 0),
    anzahlOrga: liste.reduce((s, p) => s + p.anzahlOrga, 0),
    summeCent,
    zahltCent,
    orgaCent,
    liste,
    empfaenger: esText(meta && meta.lieferantEmail, 120),
  };
}

// ===========================================================================
// Import der Speisekarte
// ===========================================================================
//
// Eingabeformat, absichtlich so, wie man eine Karte abtippt oder aus einem PDF
// kopiert:
//
//   # Pizza
//   Margherita | Tomate, Käse | 8,50
//   Salami | 9,50
//
// „#" beginnt eine Kategorie, alles andere ist ein Gericht. Trennzeichen sind
// „|", „;" oder ein Tabulator. Das LETZTE Feld gilt als Preis, wenn es sich als
// Zahl lesen lässt – sonst hat das Gericht keinen Preis und ist kostenlos.
//
// ⚠️ Reine Prüf-Funktion, sie schreibt nichts. Der Aufrufer zeigt erst die
// Vorschau und lässt bestätigen; ein Import, der die Karte still ersetzt, wäre
// bei einem Vertipper nicht mehr zurückzuholen.
function esParseImport(roh) {
  const zeilen = String(roh == null ? "" : roh).split(/\r?\n/);
  const gerichte = [];
  const fehler = [];
  let kategorie = "";

  zeilen.forEach((zeileRoh, i) => {
    const zeile = zeileRoh.trim();
    if (!zeile) return;

    if (zeile.startsWith("#")) {
      kategorie = esText(zeile.slice(1), 40);
      return;
    }

    const felder = zeile.split(/\t|\||;/).map((f) => f.trim());
    const name = esText(felder[0], 80);
    if (!name) {
      fehler.push("Zeile " + (i + 1) + ": kein Name.");
      return;
    }

    let preisCent = 0;
    let beschreibungsFelder = felder.slice(1);
    if (beschreibungsFelder.length) {
      const letztes = beschreibungsFelder[beschreibungsFelder.length - 1];
      const alsPreis = esPreisNachCent(letztes);
      // Ein leeres letztes Feld ist kein Preis von 0 €, sondern ein leeres Feld
      // („Pommes | | 3,00" hat drei Felder, „Pommes |" nur eine leere Beschreibung).
      if (letztes && alsPreis !== null) {
        preisCent = alsPreis;
        beschreibungsFelder = beschreibungsFelder.slice(0, -1);
      }
    }

    if (preisCent > ES_MAX_PREIS_CENT) {
      fehler.push("Zeile " + (i + 1) + " (" + name + "): " + esCentLabel(preisCent) + " ist zu viel.");
      return;
    }

    gerichte.push({
      name,
      beschreibung: esText(beschreibungsFelder.filter(Boolean).join(", "), 200),
      preisCent,
      kategorie,
    });
  });

  return { gerichte, fehler };
}

// --- Live-Anbindung --------------------------------------------------------
const esCallbacks = [];

function esMelde() {
  const z = esGetZustand();
  esCallbacks.forEach((cb) => {
    try {
      cb(z);
    } catch (e) {
      console.error("[Essen] Render-Fehler:", e);
    }
  });
}

function esOnZustandsAenderung(cb) {
  esCallbacks.push(cb);
  if (esRoh !== null) cb(esGetZustand());
  return cb;
}

esAuthBereit.then(() => {
  if (esListener) return;
  esListener = db.ref(ES_BASIS).on(
    "value",
    (snap) => {
      esZugriffFehler = false;
      esRoh = snap.val() || {};
      esMelde();
    },
    // ⚠️ Ohne diesen zweiten Rückruf scheitert das Lesen lautlos: `esRoh` bliebe
    // `null`, die Oberfläche zeigte für immer das leere Anlegen-Formular, und
    // erst der Klick auf „anlegen" liefe in einen Fehler. Der wahrscheinlichste
    // Grund ist genau einer – der `essen`-Block fehlt noch in den
    // Firebase-Regeln (ein neuer Top-Level-Knoten erbt keine). Das muss
    // dranstehen, sonst sucht man es im Code.
    (fehler) => {
      esZugriffFehler = true;
      esRoh = {};
      console.error("[Essen] Kein Zugriff auf " + ES_BASIS + ":", fehler && fehler.message);
      esMelde();
    }
  );
});

// ⚠️ Das Zeitfenster geht zu, ohne dass sich in Firebase etwas aendert. Ohne
// diesen Takt blieben Speisekarte und Bestellknopf offen, bis irgendwer anders
// etwas schreibt.
setInterval(() => {
  if (esRoh !== null) esMelde();
}, 30000);

// ===========================================================================
// Schreibende Aktionen
// ===========================================================================

async function esErstellePlan({ titel, lieferantName, lieferantEmail, bestellerName, bestellerTelefon, hinweis, adminPin }) {
  await esAuthBereit;
  if (esRoh && esRoh.meta && esRoh.meta.titel) {
    return { erfolg: false, fehler: "Es gibt schon eine Essensbestellung." };
  }

  const t = esText(titel, 60);
  if (!t) return { erfolg: false, fehler: "Bitte gib der Bestellung einen Namen." };

  const pin = esText(adminPin, 20);
  if (!pin) return { erfolg: false, fehler: "Bitte lege einen Veranstalter-PIN fest." };

  const mail = esText(lieferantEmail, 120);
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return { erfolg: false, fehler: "Die E-Mail-Adresse des Lieferanten sieht nicht richtig aus." };
  }

  await db.ref(ES_BASIS).update({
    meta: {
      titel: t,
      hostId: esEigeneUid,
      adminPin: pin,
      erstelltAm: firebase.database.ServerValue.TIMESTAMP,
      annahmeOffen: true,
      lieferantName: esText(lieferantName, 80),
      lieferantEmail: mail,
      bestellerName: esText(bestellerName, 60),
      bestellerTelefon: esText(bestellerTelefon, 40),
      hinweis: esText(hinweis, 400),
    },
  });
  try {
    localStorage.setItem(ES_PIN_KEY, pin);
  } catch (e) { /* privater Modus: dann zählt nur hostId */ }
  return { erfolg: true };
}

function esPruefeGericht({ name, beschreibung, kategorie, preis }) {
  const n = esText(name, 80);
  if (!n) return { erfolg: false, fehler: "Das Gericht braucht einen Namen." };
  const cent = esPreisNachCent(preis);
  if (cent === null) return { erfolg: false, fehler: "Der Preis ist keine gültige Zahl." };
  if (cent > ES_MAX_PREIS_CENT) {
    return { erfolg: false, fehler: "Mehr als " + esCentLabel(ES_MAX_PREIS_CENT) + " je Gericht geht nicht." };
  }
  return {
    erfolg: true,
    werte: {
      name: n,
      beschreibung: esText(beschreibung, 200),
      kategorie: esText(kategorie, 40),
      preisCent: cent,
    },
  };
}

async function esLegeGerichtAn(werte) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const z = esGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Es gibt noch keine Essensbestellung." };
  if (z.karte.length >= ES_MAX_GERICHTE) {
    return { erfolg: false, fehler: "Mehr als " + ES_MAX_GERICHTE + " Gerichte fasst die Karte nicht." };
  }

  const geprueft = esPruefeGericht(werte);
  if (!geprueft.erfolg) return geprueft;

  const id = esNeueId("ger");
  await db.ref(ES_BASIS + "/karte/" + id).update(
    Object.assign({}, geprueft.werte, {
      sort: z.karte.length,
      erstelltAm: firebase.database.ServerValue.TIMESTAMP,
    })
  );
  return { erfolg: true, id };
}

async function esAendereGericht(id, werte) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (!esGetZustand().karte.some((g) => g.id === id)) {
    return { erfolg: false, fehler: "Dieses Gericht gibt es nicht mehr." };
  }
  const geprueft = esPruefeGericht(werte);
  if (!geprueft.erfolg) return geprueft;

  // ⚠️ Bestehende Bestellungen bleiben unberührt: sie tragen Name und Preis
  // selbst. Wer für 8,50 € bestellt hat, schuldet 8,50 €, auch wenn die Karte
  // danach 9,50 € sagt.
  await db.ref(ES_BASIS + "/karte/" + id).update(geprueft.werte);
  return { erfolg: true };
}

async function esLoescheGericht(id) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (!esGetZustand().karte.some((g) => g.id === id)) {
    return { erfolg: false, fehler: "Dieses Gericht gibt es nicht mehr." };
  }
  // Anders als beim Frühstück werden hier KEINE Positionen mitgelöscht: eine
  // abgeschickte Bestellung ist ein Beleg und trägt Name und Preis selbst.
  await db.ref(ES_BASIS + "/karte/" + id).remove();
  return { erfolg: true };
}

async function esVerschiebeGericht(id, richtung) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const karte = esGetZustand().karte;
  const i = karte.findIndex((g) => g.id === id);
  if (i < 0) return { erfolg: false, fehler: "Dieses Gericht gibt es nicht mehr." };
  const j = i + (richtung < 0 ? -1 : 1);
  if (j < 0 || j >= karte.length) return { erfolg: true };

  const neu = karte.slice();
  neu.splice(j, 0, neu.splice(i, 1)[0]);
  // Immer die GANZE Liste neu nummerieren – einzelne sort-Werte zu tauschen
  // hinterlässt Lücken, sobald zwischendurch etwas gelöscht wurde.
  const updates = {};
  neu.forEach((g, idx) => { updates["karte/" + g.id + "/sort"] = idx; });
  await db.ref(ES_BASIS).update(updates);
  return { erfolg: true };
}

// gerichte = Ergebnis von esParseImport().gerichte
// ersetzen = true  -> die alte Karte fällt weg
// ersetzen = false -> die neuen hängen hinten an
async function esImportiereKarte(gerichte, ersetzen) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const z = esGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Es gibt noch keine Essensbestellung." };
  if (!Array.isArray(gerichte) || !gerichte.length) {
    return { erfolg: false, fehler: "Es steht nichts zum Übernehmen da." };
  }

  const behalten = ersetzen ? 0 : z.karte.length;
  if (behalten + gerichte.length > ES_MAX_GERICHTE) {
    return {
      erfolg: false,
      fehler: "Zusammen wären das " + (behalten + gerichte.length) +
        " Gerichte – mehr als " + ES_MAX_GERICHTE + " fasst die Karte nicht.",
    };
  }

  // Ein einziges update(): entweder liegt die neue Karte ganz da oder gar nicht.
  // Erst löschen und dann schreiben hinterließe bei einem Abbruch eine leere Karte.
  const updates = {};
  if (ersetzen) {
    z.karte.forEach((g) => { updates["karte/" + g.id] = null; });
  }
  const jetzt = Date.now();
  gerichte.forEach((g, idx) => {
    updates["karte/" + esNeueId("ger")] = {
      name: esText(g.name, 80),
      beschreibung: esText(g.beschreibung, 200),
      kategorie: esText(g.kategorie, 40),
      preisCent: Math.max(0, Math.min(ES_MAX_PREIS_CENT, Math.round(esZahl(g.preisCent, 0)))),
      sort: behalten + idx,
      // ⚠️ Hier KEIN ServerValue.TIMESTAMP: der Platzhalter wäre in allen
      // Einträgen derselbe Wert und die Reihenfolge innerhalb des Imports
      // ginge verloren. sort ist ohnehin der führende Schlüssel.
      erstelltAm: jetzt + idx,
    };
  });

  await db.ref(ES_BASIS).update(updates);
  return { erfolg: true, anzahl: gerichte.length };
}

// positionen = [{ gerichtId, anzahl, sonderwunsch }]
// Name und Preis holt der Service selbst aus der Karte – der Client darf sie
// nicht mitgeben, sonst könnte man sich seinen Preis selbst aussuchen.
async function esBestelle({ name, positionen, notiz, bestellungId }) {
  await esAuthBereit;
  const z = esGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Es gibt noch keine Essensbestellung." };

  const bisher = bestellungId ? z.bestellungen.find((b) => b.id === bestellungId) : null;
  if (bestellungId && !bisher) return { erfolg: false, fehler: "Diese Bestellung gibt es nicht mehr." };
  if (bisher && !bisher.istEigene && !z.istAdmin) {
    return { erfolg: false, fehler: "Das ist nicht deine Bestellung." };
  }
  if (bisher && !bisher.aenderbar && !z.istAdmin) {
    return { erfolg: false, fehler: "Die Bestellung ist bezahlt und lässt sich nicht mehr ändern. Sag dem Veranstalter Bescheid." };
  }
  if (!bisher && !z.annahmeOffen && !z.istAdmin) {
    // Warum zu ist, muss dranstehen – „geschlossen" ohne Grund laesst niemanden
    // wissen, ob es sich noch lohnt, spaeter nochmal zu schauen.
    return {
      erfolg: false,
      fehler: !z.schalterAn
        ? "Die Bestellannahme ist gerade geschlossen."
        : "Bestellt werden kann nur zwischen " + z.fensterLabel + ".",
    };
  }
  if (!bisher && z.bestellungen.length >= ES_MAX_BESTELLUNGEN) {
    return { erfolg: false, fehler: "Es liegen schon " + ES_MAX_BESTELLUNGEN + " Bestellungen vor." };
  }

  const n = esText(name, 40);
  if (!n) return { erfolg: false, fehler: "Bitte trag deinen Namen ein." };

  const sauber = {};
  let anzahlPositionen = 0;
  (positionen || []).forEach((pos) => {
    const gericht = z.karte.find((g) => g.id === (pos && pos.gerichtId));
    if (!gericht) return;   // Gericht ist von der Karte verschwunden
    const anzahl = Math.round(esZahl(pos && pos.anzahl, 0));
    if (anzahl <= 0) return;
    if (anzahlPositionen >= ES_MAX_POSITIONEN) return;
    sauber["pos" + anzahlPositionen] = {
      gerichtId: gericht.id,
      name: gericht.name,
      preisCent: gericht.preisCent,
      anzahl: Math.min(ES_MAX_STUECK, anzahl),
      sonderwunsch: esText(pos && pos.sonderwunsch, ES_MAX_SONDERWUNSCH),
      sort: anzahlPositionen,
    };
    anzahlPositionen += 1;
  });

  if (!anzahlPositionen) {
    return { erfolg: false, fehler: "Wähle mindestens ein Gericht aus." };
  }

  // Gehört die Bestellung zur Organisation? Das Merkmal folgt der PERSON, die
  // sie abgibt.
  // ⚠️ Bearbeitet der Veranstalter eine fremde Bestellung, zählt weiter der
  // Stand von dort – sonst würde jede Korrektur an einer fremden Bestellung
  // dessen eigenes Orga-Merkmal darauf übertragen und sie stillschweigend
  // kostenlos machen.
  const orgaJetzt = bisher && !bisher.istEigene
    ? bisher.orga
    : (typeof kontoIstOrga === "function" && kontoIstOrga());

  const id = bestellungId || esNeueId("best");
  // ⚠️ set() statt update(): weggenommene Positionen müssen wirklich
  // verschwinden. Der Status wird dabei mitgeschrieben, nicht zurückgesetzt –
  // er gehört dem Veranstalter, nicht dem Besteller.
  await db.ref(ES_BASIS + "/bestellungen/" + id).set({
    uid: bisher ? bisher.uid : esEigeneUid,
    name: n,
    orga: !!orgaJetzt,
    status: bisher ? bisher.status : "neu",
    notiz: esText(notiz, 200),
    positionen: sauber,
    erstelltAm: bisher ? bisher.erstelltAm : firebase.database.ServerValue.TIMESTAMP,
    aktualisiertAm: firebase.database.ServerValue.TIMESTAMP,
  });
  try {
    localStorage.setItem(ES_NAME_KEY, n);
  } catch (e) { /* privater Modus */ }
  return { erfolg: true, id };
}

async function esStorniere(bestellungId) {
  await esAuthBereit;
  const z = esGetZustand();
  const b = z.bestellungen.find((x) => x.id === bestellungId);
  if (!b) return { erfolg: false, fehler: "Diese Bestellung gibt es nicht mehr." };
  if (!b.istEigene && !z.istAdmin) return { erfolg: false, fehler: "Das ist nicht deine Bestellung." };
  if (!b.aenderbar && !z.istAdmin) {
    return { erfolg: false, fehler: "Die Bestellung ist bezahlt. Der Veranstalter muss sie entfernen." };
  }
  const updates = {};
  updates["bestellungen/" + bestellungId] = null;
  esRundeAufraeumen(updates, b.rundeId, bestellungId);
  await db.ref(ES_BASIS).update(updates);
  return { erfolg: true };
}

// Verlässt eine Bestellung ihre Runde und war sie die letzte darin, muss die
// Runde mit weg. ⚠️ Eine leere Runde stünde sonst für immer in der Liste und
// behauptete eine Mail, in der nichts mehr steht. Ihre Nummer ist trotzdem
// verbraucht – siehe esNaechsteRundeNr().
function esRundeAufraeumen(updates, rundeId, ohneBestellungId) {
  if (!rundeId) return;
  const rest = esGetZustand().bestellungen.filter(
    (b) => b.rundeId === rundeId && b.id !== ohneBestellungId
  );
  if (!rest.length) updates["runden/" + rundeId] = null;
}

async function esSetzeStatus(bestellungId, status) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (ES_STATUS_KETTE.indexOf(status) < 0) return { erfolg: false, fehler: "Diesen Stand gibt es nicht." };
  const b = esGetZustand().bestellungen.find((x) => x.id === bestellungId);
  if (!b) return { erfolg: false, fehler: "Diese Bestellung gibt es nicht mehr." };

  await db.ref(ES_BASIS + "/bestellungen/" + bestellungId).update({
    status,
    aktualisiertAm: firebase.database.ServerValue.TIMESTAMP,
  });
  return { erfolg: true };
}

// Eine Bestellung wieder aus ihrer Sammelbestellung lösen – der Weg für „die
// hätte da nicht mit rein sollen".
// ⚠️ Der EINZIGE Ausstieg aus einer Runde. Über die Statuskette geht es
// bewusst nicht: `neu` ist in einer Runde ein gültiger Zustand („bestellt,
// aber noch nicht bezahlt"), und ein Schritt zurück in der Kette dürfte deshalb
// nicht nebenbei eine verschickte Mail aus dem Nachweis nehmen.
async function esNimmAusRunde(bestellungId) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const b = esGetZustand().bestellungen.find((x) => x.id === bestellungId);
  if (!b) return { erfolg: false, fehler: "Diese Bestellung gibt es nicht mehr." };
  if (!b.rundeId) return { erfolg: false, fehler: "Die steckt in keiner Sammelbestellung." };

  const updates = {};
  updates["bestellungen/" + bestellungId + "/rundeId"] = null;
  // Wer nichts bezahlt hat, ist danach wieder offen; alle anderen liegen wieder
  // als bezahlt im Stapel und können in die nächste Sammelbestellung.
  updates["bestellungen/" + bestellungId + "/status"] = b.status === "neu" ? "neu" : "bezahlt";
  updates["bestellungen/" + bestellungId + "/aktualisiertAm"] = firebase.database.ServerValue.TIMESTAMP;
  esRundeAufraeumen(updates, b.rundeId, bestellungId);
  await db.ref(ES_BASIS).update(updates);
  return { erfolg: true };
}

// Eine einzelne Bestellung auf Orga umstellen oder zurück.
// ⚠️ Der Weg für Irrtümer: das Merkmal kommt beim Abschicken aus dem Konto des
// Bestellers, und das steht in dessen Browser. Wer sich dort etwas verstellt,
// hätte sonst ein kostenloses Essen, das niemand mehr korrigieren kann. Der
// Veranstalter sieht in der Liste, was als Orga eingetragen ist, und dreht es
// hier je Bestellung um – ohne jemandem das Konto-Merkmal zu nehmen.
async function esSetzeOrga(bestellungId, wert) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const b = esGetZustand().bestellungen.find((x) => x.id === bestellungId);
  if (!b) return { erfolg: false, fehler: "Diese Bestellung gibt es nicht mehr." };
  await db.ref(ES_BASIS + "/bestellungen/" + bestellungId).update({
    orga: !!wert,
    aktualisiertAm: firebase.database.ServerValue.TIMESTAMP,
  });
  return { erfolg: true };
}

// Die ausgewählten Bestellungen zu EINER Sammelbestellung zusammenfassen. Das
// ist der Klick, der kommt, nachdem die Mail wirklich raus ist.
async function esSchickeRunde(bestellungIds) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const z = esGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Es gibt noch keine Essensbestellung." };
  if (z.runden.length >= ES_MAX_RUNDEN) {
    return { erfolg: false, fehler: "Mehr als " + ES_MAX_RUNDEN + " Sammelbestellungen gehen nicht." };
  }

  const ids = Array.isArray(bestellungIds) ? bestellungIds : [];
  // ⚠️ Nur aus dem Stapel. Eine Bestellung, die schon in einer Runde steckt,
  // darf nicht in eine zweite wandern – sie wäre dann in zwei Mails gezählt
  // und beim Abrechnen doppelt drin.
  const mit = z.ohneRunde.filter((b) => ids.indexOf(b.id) >= 0);
  // ⚠️ Kein stiller Erfolg bei null Treffern: „nichts passiert" und „hat
  // geklappt" sehen am Bildschirm sonst gleich aus.
  if (!mit.length) {
    return { erfolg: false, fehler: "Da ist keine Bestellung dabei, die noch nicht rausgeschickt wurde." };
  }

  const nr = esNaechsteRundeNr();
  const tag = esText(z.meta && z.meta.titel, 60) || "Bestellung";
  const titel = tag + " " + nr;
  const rid = esNeueId("rd");
  const updates = {};
  updates["runden/" + rid] = {
    nr,
    tag,
    titel,
    erstelltAm: firebase.database.ServerValue.TIMESTAMP,
  };
  updates["meta/rundeZaehler"] = nr;
  updates["meta/rundeTag"] = tag;
  mit.forEach((b) => {
    updates["bestellungen/" + b.id + "/rundeId"] = rid;
    // ⚠️ Wer noch nicht bezahlt hat, BLEIBT auf `neu` – er steckt trotzdem in
    // der Runde. Würde er hier auf „bestellt" gehoben, wäre danach nicht mehr
    // zu sehen, dass er noch Geld schuldet, und „noch zu kassieren" stünde für
    // immer auf 0,00 €. Orga-Bestellungen zählen als erledigt: da ist nichts
    // zu holen.
    // ⚠️ Wer schon weiter ist als „bestellt" (Altbestand, der nachgetragen
    // wird), behält seinen Stand. Ein nachgetragenes „abgeholt" wieder auf
    // „bestellt" zu setzen wäre ein Rückschritt, den niemand gewollt hat.
    const zielIndex = ES_STATUS_KETTE.indexOf("bestellt");
    if (b.statusIndex < zielIndex && (b.status !== "neu" || b.orga)) {
      updates["bestellungen/" + b.id + "/status"] = "bestellt";
    }
    updates["bestellungen/" + b.id + "/aktualisiertAm"] = firebase.database.ServerValue.TIMESTAMP;
  });
  // ⚠️ EIN update(): entweder die Runde entsteht mitsamt ihren Bestellungen
  // oder gar nicht. Zwei Schreibvorgänge könnten eine leere Runde hinterlassen
  // oder Bestellungen, die auf eine Runde zeigen, die es nicht gibt.
  await db.ref(ES_BASIS).update(updates);
  return { erfolg: true, id: rid, nr, titel, anzahl: mit.length };
}

// Eine ganze Runde weiterschalten – „das Essen von Donnerstag 2 ist da".
async function esSetzeRundeStatus(rundeId, status) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  // ⚠️ Nur „bestellt" und „abgeholt". Alles darunter löst die Bestellungen aus
  // der Runde, und das gehört einzeln entschieden – im Rudel wäre eine ganze
  // verschickte Mail mit einem Klick aus dem Nachweis verschwunden.
  if (status !== "bestellt" && status !== "abgeholt") {
    return { erfolg: false, fehler: "Für die ganze Runde geht nur „bestellt“ und „abgeholt“." };
  }
  const runde = esGetZustand().runden.find((r) => r.id === rundeId);
  if (!runde) return { erfolg: false, fehler: "Diese Sammelbestellung gibt es nicht mehr." };
  // ⚠️ Wer noch nicht bezahlt hat, wird NICHT mitgeschaltet. „Alle abgeholt"
  // würde sonst nebenbei eine offene Rechnung verschwinden lassen – und danach
  // weiß niemand mehr, dass da noch Geld fehlt.
  const offen = runde.bestellungen.filter((b) => b.status === "neu");
  const treffer = runde.bestellungen.filter((b) => b.status !== status && b.status !== "neu");
  if (!treffer.length) {
    return {
      erfolg: false,
      fehler: offen.length
        ? "Da fehlt noch Geld: " + offen.map((b) => b.name).join(", ") + ". Erst kassieren, dann abhaken."
        : "Da steht schon alles auf diesem Stand.",
    };
  }

  const updates = {};
  treffer.forEach((b) => {
    updates["bestellungen/" + b.id + "/status"] = status;
    updates["bestellungen/" + b.id + "/aktualisiertAm"] = firebase.database.ServerValue.TIMESTAMP;
  });
  await db.ref(ES_BASIS).update(updates);
  return {
    erfolg: true,
    anzahl: treffer.length,
    offen: offen.map((b) => b.name),
  };
}

// Festhalten, dass fuer eine Lieferung Bescheid gegeben wurde.
// ⚠️ Wird NACH dem Versand gerufen, nicht davor: sonst stuende dort eine
// Uhrzeit, obwohl keine einzige Nachricht rausging.
async function esSetzeBescheid(rundeId, erreicht) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const runde = esGetZustand().runden.find((r) => r.id === rundeId);
  if (!runde) return { erfolg: false, fehler: "Diese Sammelbestellung gibt es nicht mehr." };
  await db.ref(ES_BASIS + "/runden/" + rundeId).update({
    bescheidAm: firebase.database.ServerValue.TIMESTAMP,
    bescheidErreicht: Math.max(0, Math.round(esZahl(erreicht, 0))),
  });
  return { erfolg: true };
}

async function esLoescheBestellung(bestellungId) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const b = esGetZustand().bestellungen.find((x) => x.id === bestellungId);
  const updates = {};
  updates["bestellungen/" + bestellungId] = null;
  if (b) esRundeAufraeumen(updates, b.rundeId, bestellungId);
  await db.ref(ES_BASIS).update(updates);
  return { erfolg: true };
}

async function esSetzeEinstellungen({ titel, lieferantName, lieferantEmail, bestellerName, bestellerTelefon, hinweis, annahmeOffen, annahmeVon, annahmeBis }) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  // ⚠️ Der Titel ist der TAG, und ihn zu ändern ist der einzige Weg in einen
  // neuen Tag, ohne die alten Daten zu verlieren: `esNaechsteRundeNr()` fängt
  // bei einem anderen Namen wieder bei 1 an, die verschickten Runden behalten
  // ihren eingefrorenen Titel. Leer ist er nie – sonst verschwände die
  // Essensbestellung, weil `esGetZustand()` einen Plan ohne `titel` als „gibt es
  // nicht" liest.
  const t = esText(titel, 60);
  if (!t) return { erfolg: false, fehler: "Der Tag braucht einen Namen." };
  const mail = esText(lieferantEmail, 120);
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return { erfolg: false, fehler: "Die E-Mail-Adresse des Lieferanten sieht nicht richtig aus." };
  }
  // ⚠️ Nur eine der beiden Zeiten gesetzt waere ein halbes Fenster – das sieht
  // in der Maske eingerichtet aus und wirkt nicht. Also beide oder keine.
  const von = esFensterWert(annahmeVon);
  const bis = esFensterWert(annahmeBis);
  if ((von === null) !== (bis === null)) {
    return { erfolg: false, fehler: "Beim Zeitfenster brauche ich Anfang UND Ende – oder beides leer." };
  }
  await db.ref(ES_BASIS + "/meta").update({
    // -1 statt null: Firebase loescht ein null-Feld, und dann liesse sich ein
    // gesetztes Fenster nie wieder wegnehmen, ohne den Knoten anzufassen.
    annahmeVon: von === null ? -1 : von,
    annahmeBis: bis === null ? -1 : bis,
    titel: t,
    lieferantName: esText(lieferantName, 80),
    lieferantEmail: mail,
    bestellerName: esText(bestellerName, 60),
    bestellerTelefon: esText(bestellerTelefon, 40),
    hinweis: esText(hinweis, 400),
    annahmeOffen: !!annahmeOffen,
  });
  return { erfolg: true };
}

async function esSetzeAnnahme(offen) {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(ES_BASIS + "/meta/annahmeOffen").set(!!offen);
  return { erfolg: true };
}

async function esLeereBestellungen() {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  // ⚠️ Die Runden müssen mit weg – ohne ihre Bestellungen wären sie leere
  // Hüllen. Der Zähler in `meta` bleibt bewusst stehen: die nächste Runde heißt
  // dann „Donnerstag 4" und nicht noch einmal „Donnerstag 1", obwohl es ein
  // „Donnerstag 1" beim Lieferanten schon gab.
  const updates = {};
  updates["bestellungen"] = null;
  updates["runden"] = null;
  await db.ref(ES_BASIS).update(updates);
  return { erfolg: true };
}

async function esLoeschePlan() {
  await esAuthBereit;
  if (!esIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(ES_BASIS).remove();
  return { erfolg: true };
}

function esAuthentifiziereAlsAdmin(pin) {
  const eingabe = esText(pin, 20);
  if (!eingabe) return { erfolg: false, fehler: "Bitte gib den PIN ein." };
  if (!esRoh || !esRoh.meta || !esRoh.meta.adminPin) {
    return { erfolg: false, fehler: "Es gibt noch keine Essensbestellung." };
  }
  if (eingabe !== esRoh.meta.adminPin) return { erfolg: false, fehler: "Der PIN stimmt nicht." };
  try {
    localStorage.setItem(ES_PIN_KEY, eingabe);
  } catch (e) { /* privater Modus */ }
  esMelde();
  return { erfolg: true };
}

// ===========================================================================
const essenService = {
  MAX_GERICHTE: ES_MAX_GERICHTE,
  MAX_POSITIONEN: ES_MAX_POSITIONEN,
  MAX_STUECK: ES_MAX_STUECK,
  MAX_SONDERWUNSCH: ES_MAX_SONDERWUNSCH,
  STATUS_KETTE: ES_STATUS_KETTE,
  STATUS_TEXT: ES_STATUS_TEXT,
  onZustandsAenderung: esOnZustandsAenderung,
  getZustand: esGetZustand,
  erstellePlan: esErstellePlan,
  legeGerichtAn: esLegeGerichtAn,
  aendereGericht: esAendereGericht,
  loescheGericht: esLoescheGericht,
  verschiebeGericht: esVerschiebeGericht,
  parseImport: esParseImport,
  importiereKarte: esImportiereKarte,
  bestelle: esBestelle,
  storniere: esStorniere,
  setzeStatus: esSetzeStatus,
  schickeRunde: esSchickeRunde,
  setzeRundeStatus: esSetzeRundeStatus,
  setzeBescheid: esSetzeBescheid,
  nimmAusRunde: esNimmAusRunde,
  setzeOrga: esSetzeOrga,
  loescheBestellung: esLoescheBestellung,
  setzeEinstellungen: esSetzeEinstellungen,
  setzeAnnahme: esSetzeAnnahme,
  leereBestellungen: esLeereBestellungen,
  loeschePlan: esLoeschePlan,
  authentifiziereAlsAdmin: esAuthentifiziereAlsAdmin,
  sammelliste: esSammelliste,
  statistik: esStatistik,
  bestelltext: esBestelltext,
  centLabel: esCentLabel,
  zeitLabel: esZeitLabel,
  uhrLabel: esUhrLabel,
  // Nur für den Test: die Uhr um n Stunden verstellen, damit sich ein
  // Zeitfenster ohne Systemzeit-Eingriff überschreiten lässt.
  _setzeZeitversatzStunden: (h) => {
    esZeitVersatzMs = esZahl(h, 0) * 3600000;
    esMelde();
  },
  // ⚠️ Das angemeldete Konto schlägt jeden gemerkten Namen: unter ihm wird
  // kassiert und abgeholt.
  getGespeicherterName: () => {
    try {
      const konto = window.__AGELAN_KONTO__;
      if (konto && konto.nickname) return konto.nickname;
      return localStorage.getItem(ES_NAME_KEY) || localStorage.getItem("agelan_spieler_name") || "";
    } catch (e) {
      return "";
    }
  },
};
