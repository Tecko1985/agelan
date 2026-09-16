// ===========================================================================
// fruehstueck-service.js – Firebase-Kapsel für die Frühstücksbestellung der AgeLan.
//
// Dritter Bereich der Seite neben Turnier und Streamplan. Der Veranstalter legt
// Frühstückspakete an, die Teilnehmer buchen sie am Abend VORHER für den
// nächsten Morgen – damit am Morgen eingekauft und bereitgestellt ist, was auch
// wirklich gebraucht wird.
//
// Eigener Top-Level-Knoten, BEWUSST nicht unter turniere/…: dort fährt
// loescheTurnier() ein remove() auf den ganzen Baum. Das Frühstück gehört zur
// Veranstaltung, nicht zu einem einzelnen Turnier, und überlebt dessen Löschung
// – genauso wie der Streamplan.
//
// Datenmodell (ein aktiver Plan unter fruehstueck/aktuell):
//   meta        : { titel, hostId, erstelltAm, startDatum:"YYYY-MM-DD",
//                   (⚠️ KEIN adminPin mehr - der liegt seit dem 15.09.2026
//                    als Hash unter fruehstueckGeheim/fruehstueck-aktuell)
//                   anzahlTage, schlussUhr, annahmeOffen }
//   pakete/$pid : { name, beschreibung, preisCent, sort, erstelltAm }
//   bestellungen/$datum/$uid : { name, positionen:{pid:anzahl},
//                                preise:{pid:{name,preisCent}}, notiz,
//                                abgeholt, bezahlt, aktualisiertAm }
//
// ⚠️ preise ist der BELEG zur Bestellung: Name und Preis, wie sie beim
// Abschicken galten. Die Anzeige rechnet damit, nicht mit dem aktuellen Paket –
// sonst würde eine spätere Preisänderung schon kassierte Bestellungen
// rückwirkend umrechnen. Altbestand ohne preise fällt aufs Paket zurück.
//
// startDatum ist der erste FRÜHSTÜCKSMORGEN, nicht der Anreisetag.
//
// ⚠️ Preise stehen als GANZE CENT in preisCent. Fließkomma-Euro würde sich beim
// Summieren um Zehntelcent verrechnen; die Eingabe „2,50" wird einmal beim
// Speichern in 250 umgerechnet und danach nie wieder geteilt.
//
// ⚠️ schlussUhr sind Minuten seit 0:00 AM VORTAG des jeweiligen Frühstücks
// (Standard 1200 = 20:00). Anders als im Streamkalender gibt es hier keine
// Werte über 1440: der Bestellschluss liegt immer am Abend davor, und was
// nach Mitternacht bestellt würde, wäre für den Einkauf zu spät.
// ===========================================================================

const FR_BASIS = "fruehstueck/aktuell";
const FR_PIN_KEY = "agelan_admin_pin";      // derselbe Schlüssel wie Turnier und Streamplan

// ⚠️ Der Admin-PIN steht NICHT mehr in meta. fruehstueck/<pid> trägt
// ".read": true – der PIN lag dort bis zum 15.09.2026 im Klartext offen im
// Netz, abrufbar ohne Konto und ohne Browser, mit einem blanken Aufruf der
// Datenbankadresse. Er liegt jetzt als SHA-256-Hash unter
// fruehstueckGeheim/fruehstueck-aktuell/adminPinHash – ein Knoten ganz ohne Leserecht.
// Geprüft wird über frBeweisePin(), denselben Weg wie Turnier und Streamplan.
// ⚠️ NICHT "aktuell" -- siehe ES_PID in essen-service.js: dieser Wert ist
// zugleich Pfadteil UND Salz des Hashes. Zwei Bereiche mit demselben Salz
// haetten bei demselben PIN denselben Hash.
const FR_PID         = "fruehstueck-aktuell";
const FR_GEHEIM_PFAD = "fruehstueckGeheim";    // <pid>/adminPinHash – kein Leserecht
const FR_PROBE_PFAD  = "fruehstueckPinProbe";  // <pid>/<uid> – Beweisablage, kein Leserecht
const FR_NAME_KEY = "agelan_streamer_name"; // denselben Namen wie im Streamplan vorschlagen

const FR_MAX_TAGE = 7;
const FR_MAX_PAKETE = 20;
const FR_MAX_STUECK = 9;          // je Paket und Person – schützt vor Vertippern
const FR_MAX_PREIS_CENT = 5000;   // 50 € je Paket ist für ein Frühstück reichlich
const FR_STANDARD_SCHLUSS = 1200; // 20:00 am Vortag
const FR_TAG_LANG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

// --- lokaler Zustand -------------------------------------------------------
let frEigeneUid = null;
let frRoh = null;             // roher { meta, pakete, bestellungen }-Snapshot
// Steht frPinOk auf true, hat der SERVER den gemerkten PIN bestätigt – nicht
// der Browser.
let frPinOk = false;
let frPinLaeuft = false;
let frListener = null;

const frAuthBereit = new Promise((resolve) => {
  auth.onAuthStateChanged((user) => {
    if (user) {
      frEigeneUid = user.uid;
      resolve(user.uid);
    }
  });
});

// Ein Punkt für „jetzt". Der Bestellschluss ist die einzige Stelle der App, an
// der die echte Uhr über Sichtbarkeit entscheidet – zum Durchspielen eines
// ganzen LAN-Wochenendes muss sie sich verstellen lassen, ohne dass dafür die
// Systemzeit angefasst wird.
let frZeitVersatzMs = 0;
function frJetzt() {
  return Date.now() + frZeitVersatzMs;
}

// --- Datum & Zeit ----------------------------------------------------------
function frHeuteIso() {
  const d = new Date(frJetzt());
  return frIsoVon(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function frIsoVon(jahr, monat, tag) {
  return jahr + "-" + String(monat).padStart(2, "0") + "-" + String(tag).padStart(2, "0");
}

function frDatumPlus(iso, n) {
  const teile = String(iso).split("-").map(Number);
  const d = new Date(teile[0], teile[1] - 1, teile[2]);
  d.setDate(d.getDate() + n);
  return frIsoVon(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function frDatumObjekt(iso) {
  const teile = String(iso).split("-").map(Number);
  return new Date(teile[0], teile[1] - 1, teile[2]);
}

function frZeitLabel(min) {
  const m = Math.max(0, Math.round(frZahl(min, 0)));
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function frDatumLabel(iso, mitJahr) {
  const d = frDatumObjekt(iso);
  const kurz = FR_TAG_LANG[d.getDay()].slice(0, 2);
  const rest = d.getDate() + "." + (d.getMonth() + 1) + ".";
  return kurz + " " + rest + (mitJahr ? d.getFullYear() : "");
}

function frTagLang(iso) {
  return FR_TAG_LANG[frDatumObjekt(iso).getDay()];
}

// --- Werte -----------------------------------------------------------------
function frZahl(wert, ersatz) {
  const n = Number(wert);
  return Number.isFinite(n) ? n : ersatz;
}

function frText(wert, maxLaenge) {
  return String(wert == null ? "" : wert).trim().slice(0, maxLaenge);
}

// „2,50" und „2.50" und „2" führen alle auf 250 Cent. Leer heißt: kostenlos.
function frPreisNachCent(eingabe) {
  const roh = String(eingabe == null ? "" : eingabe).trim().replace(",", ".");
  if (!roh) return 0;
  const n = Number(roh);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function frCentLabel(cent) {
  const c = Math.max(0, Math.round(frZahl(cent, 0)));
  return (c / 100).toFixed(2).replace(".", ",") + " €";
}

// --- Admin-Status ----------------------------------------------------------
function frGespeicherterPin() {
  try {
    return localStorage.getItem(FR_PIN_KEY);
  } catch (e) {
    return null;
  }
}

function frIstAdmin() {
  // Ein Veranstalter-Konto gilt ueberall, auch ohne PIN und auf jedem Geraet.
  if (typeof kontoIstVeranstalter === "function" && kontoIstVeranstalter()) return true;
  if (!frRoh || !frRoh.meta) return false;
  const meta = frRoh.meta;
  if (meta.hostId && meta.hostId === frEigeneUid) return true;
  return frPinOk;
}

// turnier-service.js wird VOR dieser Datei geladen und stellt den Beweisweg
// bereit.
function frBeweisWegDa() {
  return typeof beweisePinAn === "function" && typeof pinHashMoeglich === "function";
}

function frBeweisePin(pin) {
  if (!frBeweisWegDa()) return Promise.resolve(false);
  return beweisePinAn(FR_GEHEIM_PFAD, FR_PROBE_PFAD, FR_PID, frEigeneUid, pin);
}

// Altbestand: Pläne aus der Zeit, als der PIN im Klartext in meta stand.
async function frHeileAltenPin(pin) {
  const alt = frRoh && frRoh.meta && frRoh.meta.adminPin;
  if (!alt || alt !== pin || !frBeweisWegDa() || !pinHashMoeglich()) return false;
  try {
    const h = await pinHash(FR_PID, alt);
    await db.ref(FR_GEHEIM_PFAD + "/" + FR_PID + "/adminPinHash").set(h);
    await legeBeweisAb(FR_PROBE_PFAD, FR_PID, frEigeneUid, h);
    await db.ref(FR_BASIS + "/meta/adminPin").remove();
    frPinOk = true;
    return true;
  } catch (e) {
    console.error("Frühstück: PIN-Umzug fehlgeschlagen:", e);
    return false;
  }
}

// Läuft einmal, sobald der Plan da ist: den gemerkten PIN gegen den Server
// halten. Erst danach zeigt die Oberfläche die Veranstalter-Knöpfe.
async function frPruefeGemerktenPin() {
  if (frPinOk || frPinLaeuft) return;
  const pin = frGespeicherterPin();
  if (!pin || !frRoh || !frRoh.meta) return;
  frPinLaeuft = true;
  try {
    if (await frBeweisePin(pin)) frPinOk = true;
    else if (await frHeileAltenPin(pin)) frPinOk = true;
    // Siehe frAuthentifiziereAlsAdmin: solange die Regeln nicht stehen, ist
    // der Klartext der einzige Weg.
    else if (frRoh.meta.adminPin && frRoh.meta.adminPin === pin) frPinOk = true;
    if (frPinOk) frMelde();
  } finally {
    frPinLaeuft = false;
  }
}

// PIN des laufenden Turniers bzw. des Streamplans, damit ein neuer
// Frühstücksplan denselben PIN übernimmt und es nicht drei Geheimnisse für
// dieselbe Person gibt.
function frVorhandenerPin() {
  // ⚠️ Seit dem 15.09.2026 NUR noch aus dem eigenen Gerät. Vorher stand hier
  // ein Blick in fremdes meta.adminPin – das Feld gibt es nirgends mehr, der
  // Vorschlag wäre also ohnehin immer leer geblieben. Aus dem Hash lässt sich
  // der PIN nicht zurückrechnen; das ist sein Zweck.
  return frGespeicherterPin() || "";
}

// ===========================================================================
// Zustands-Aufbereitung für die UI
// ===========================================================================

function frPaketListe(paketeRoh) {
  const liste = Object.entries(paketeRoh || {}).map(([id, p]) => ({
    id,
    name: frText(p && p.name, 60),
    beschreibung: frText(p && p.beschreibung, 200),
    preisCent: Math.max(0, Math.round(frZahl(p && p.preisCent, 0))),
    sort: frZahl(p && p.sort, 0),
    erstelltAm: frZahl(p && p.erstelltAm, 0),
  }));
  liste.sort((a, b) => (a.sort - b.sort) || (a.erstelltAm - b.erstelltAm) || a.name.localeCompare(b.name));
  return liste;
}

// Der Bestellschluss eines Frühstückstages liegt am Abend VORHER.
function frSchlussZeitpunkt(datum, schlussUhr) {
  const d = frDatumObjekt(frDatumPlus(datum, -1));
  d.setMinutes(d.getMinutes() + Math.max(0, Math.round(frZahl(schlussUhr, FR_STANDARD_SCHLUSS))));
  return d.getTime();
}

// Eine Bestellung ohne Positionen ist keine Bestellung – sie entsteht z. B.,
// wenn jemand alle Zähler wieder auf 0 stellt. Sie wird beim Speichern entfernt,
// hier aber zusätzlich ausgefiltert, damit ein Rest im Baum nicht als „hat
// bestellt" durchgeht.
function frPositionenListe(positionenRoh, pakete, preiseRoh) {
  const positionen = [];
  Object.entries(positionenRoh || {}).forEach(([pid, anzahl]) => {
    const n = Math.round(frZahl(anzahl, 0));
    if (n <= 0) return;
    const paket = pakete.find((p) => p.id === pid);
    // ⚠️ Name und Preis kommen aus dem Beleg, den frBestelle beim Abschicken
    // festgeschrieben hat – NICHT aus dem Paket. Eine abgegebene Bestellung
    // ist ein Beleg: ihr Betrag darf sich nicht ändern, nur weil der
    // Veranstalter den Preis nachträglich anpasst. Sonst stünde in der
    // Abrechnung neben einem gesetzten „bezahlt"-Haken plötzlich eine andere
    // Summe. (Genauso hält es das Essens-Modul, siehe essen-service.js.)
    // Nur Altbestand ohne Beleg fällt auf das Paket zurück.
    const fest = (preiseRoh || {})[pid];
    const name = fest ? frText(fest && fest.name, 60) : (paket ? paket.name : "");
    const preisCent = fest
      ? Math.max(0, Math.round(frZahl(fest && fest.preisCent, 0)))
      : (paket ? paket.preisCent : null);
    if (!name || preisCent === null) return;   // Paket gelöscht und kein Beleg da
    positionen.push({
      paketId: pid,
      name,
      anzahl: Math.min(FR_MAX_STUECK, n),
      preisCent,
      summeCent: preisCent * Math.min(FR_MAX_STUECK, n),
    });
  });
  positionen.sort((a, b) => pakete.findIndex((p) => p.id === a.paketId) - pakete.findIndex((p) => p.id === b.paketId));
  return positionen;
}

function frBestellungenEinesTages(bestellungenRoh, datum, pakete) {
  const roh = (bestellungenRoh || {})[datum] || {};
  const liste = [];
  Object.entries(roh).forEach(([uid, b]) => {
    const positionen = frPositionenListe(b && b.positionen, pakete, b && b.preise);
    if (!positionen.length) return;
    liste.push({
      uid,
      name: frText(b && b.name, 40) || "Ohne Namen",
      notiz: frText(b && b.notiz, 200),
      abgeholt: !!(b && b.abgeholt),
      bezahlt: !!(b && b.bezahlt),
      positionen,
      stueck: positionen.reduce((s, p) => s + p.anzahl, 0),
      summeCent: positionen.reduce((s, p) => s + p.summeCent, 0),
      istEigene: uid === frEigeneUid,
    });
  });
  liste.sort((a, b) => a.name.localeCompare(b.name));
  return liste;
}

function frTageListe(meta, bestellungenRoh, pakete) {
  const anzahl = Math.min(FR_MAX_TAGE, Math.max(1, Math.round(frZahl(meta.anzahlTage, 1))));
  const schlussUhr = Math.max(0, Math.min(1439, Math.round(frZahl(meta.schlussUhr, FR_STANDARD_SCHLUSS))));
  const jetzt = frJetzt();
  // ⚠️ Fehlt das Feld, ist offen der Normalfall. Ein Plan, der vor dem
  // Schalter angelegt wurde, darf nicht dadurch zumachen, dass es ihn jetzt gibt.
  const schalterAn = meta.annahmeOffen !== false;
  const liste = [];

  for (let i = 0; i < anzahl; i++) {
    const datum = frDatumPlus(meta.startDatum, i);
    const bestellungen = frBestellungenEinesTages(bestellungenRoh, datum, pakete);
    const schlussMs = frSchlussZeitpunkt(datum, schlussUhr);
    const eigene = bestellungen.find((b) => b.istEigene) || null;

    // Sammelmengen je Paket – das ist die Einkaufsliste.
    const gesamt = {};
    pakete.forEach((p) => { gesamt[p.id] = 0; });
    bestellungen.forEach((b) => {
      b.positionen.forEach((pos) => { gesamt[pos.paketId] = (gesamt[pos.paketId] || 0) + pos.anzahl; });
    });

    liste.push({
      datum,
      index: i,
      label: frDatumLabel(datum),
      tagLang: frTagLang(datum),
      schlussUhr,
      schlussMs,
      schlussLabel: frDatumLabel(frDatumPlus(datum, -1)) + ", " + frZeitLabel(schlussUhr) + " Uhr",
      // ⚠️ Drei getrennte Werte, weil die Oberfläche verschieden erklären muss,
      // warum gerade nichts geht. `vorbei` ist allein die Uhr – sonst stünde bei
      // zugedrehtem Schalter „Bestellschluss war", obwohl er erst noch kommt.
      zeitOffen: jetzt < schlussMs,
      offen: schalterAn && jetzt < schlussMs,
      vorbei: jetzt >= schlussMs,
      bestellungen,
      meineBestellung: eigene,
      anzahlBesteller: bestellungen.length,
      gesamt,
      stueckGesamt: bestellungen.reduce((s, b) => s + b.stueck, 0),
      summeCentGesamt: bestellungen.reduce((s, b) => s + b.summeCent, 0),
    });
  }
  return liste;
}

// Abrechnung: was schuldet mir wer, ueber alle Morgen zusammen.
// ⚠️ Gruppiert wird nach NAME, nicht nach uid – kassiert wird bei einer Person,
// und wer vom Handy und vom Rechner bestellt, hat zwei uids. Der Name ist hier
// also bewusst nur ein Anzeige-Schluessel; jede Zeile behaelt ihre uid, damit
// der Bezahlt-Haken am richtigen Eintrag landet.
function frAbrechnung(tage) {
  const nachName = new Map();
  tage.forEach((tag) => {
    tag.bestellungen.forEach((b) => {
      const schluessel = b.name.toLowerCase();
      if (!nachName.has(schluessel)) {
        nachName.set(schluessel, { name: b.name, zeilen: [], summeCent: 0, offenCent: 0, stueck: 0 });
      }
      const person = nachName.get(schluessel);
      person.zeilen.push({
        datum: tag.datum,
        label: tag.label,
        tagLang: tag.tagLang,
        uid: b.uid,
        positionen: b.positionen,
        stueck: b.stueck,
        summeCent: b.summeCent,
        bezahlt: b.bezahlt,
        notiz: b.notiz,
      });
      person.summeCent += b.summeCent;
      person.stueck += b.stueck;
      if (!b.bezahlt) person.offenCent += b.summeCent;
    });
  });
  const liste = Array.from(nachName.values());
  liste.forEach((p) => { p.zeilen.sort((a, b) => a.datum.localeCompare(b.datum)); });
  // ⚠️ Alphabetisch, NICHT nach offenem Betrag: sonst springt beim Kassieren
  // die Person weg, die man gerade abhakt, weil sich ihre Position aendert.
  // Wer noch offen hat, ist am roten Betrag zu erkennen.
  liste.sort((a, b) => a.name.localeCompare(b.name));
  return liste;
}

function frGetZustand() {
  const meta = (frRoh && frRoh.meta) || null;
  if (!meta || !meta.startDatum) {
    return {
      vorhanden: false,
      meta: null,
      pakete: [],
      tage: [],
      schalterAn: false,
      istAdmin: false,
      eigeneUid: frEigeneUid,
      vorhandenerPin: frVorhandenerPin(),
    };
  }
  const pakete = frPaketListe(frRoh.pakete);
  const tage = frTageListe(meta, frRoh.bestellungen, pakete);
  const abrechnung = frAbrechnung(tage);
  return {
    vorhanden: true,
    meta,
    pakete,
    tage,
    // ⚠️ Der reine Schalter, ohne die Uhr. Die Oberfläche braucht ihn getrennt:
    // „geschlossen" ist etwas anderes als „Bestellschluss vorbei".
    schalterAn: meta.annahmeOffen !== false,
    abrechnung,
    summeGesamtCent: abrechnung.reduce((sum, p) => sum + p.summeCent, 0),
    offenGesamtCent: abrechnung.reduce((sum, p) => sum + p.offenCent, 0),
    istAdmin: frIstAdmin(),
    eigeneUid: frEigeneUid,
    vorhandenerPin: frVorhandenerPin(),
  };
}

// --- Live-Anbindung --------------------------------------------------------
const frCallbacks = [];

function frMelde() {
  const z = frGetZustand();
  frCallbacks.forEach((cb) => {
    try {
      cb(z);
    } catch (e) {
      console.error("[Frühstück] Render-Fehler:", e);
    }
  });
}

function frOnZustandsAenderung(cb) {
  frCallbacks.push(cb);
  if (frRoh !== null) cb(frGetZustand());
  return cb;
}

frAuthBereit.then(() => {
  if (frListener) return;
  frListener = db.ref(FR_BASIS).on("value", (snap) => {
    frRoh = snap.val() || {};
    frMelde();
    // ⚠️ Ohne await: der Beweis läuft über das Netz und darf das Rendern
    // nicht aufhalten. Ist er durch, meldet er selbst.
    frPruefeGemerktenPin();
  });
});

// Der Bestellschluss verschiebt sich mit der Uhr, ohne dass sich in Firebase
// etwas ändert. Ohne diesen Takt bliebe ein Tag optisch offen, bis irgendjemand
// anders etwas schreibt.
setInterval(() => {
  if (frRoh !== null) frMelde();
}, 30000);

// ===========================================================================
// Schreibende Aktionen
// ===========================================================================

function frNeueId(praefix) {
  return praefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

async function frErstellePlan({ titel, startDatum, anzahlTage, schlussUhr, adminPin }) {
  await frAuthBereit;
  if (frRoh && frRoh.meta) return { erfolg: false, fehler: "Es gibt schon eine Frühstücksbestellung." };

  const t = frText(titel, 60);
  if (!t) return { erfolg: false, fehler: "Bitte gib der Bestellung einen Namen." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDatum || ""))) {
    return { erfolg: false, fehler: "Bitte wähle den ersten Frühstücksmorgen." };
  }

  const tage = Math.round(frZahl(anzahlTage, 0));
  if (!(tage >= 1 && tage <= FR_MAX_TAGE)) {
    return { erfolg: false, fehler: "Es geht über 1 bis " + FR_MAX_TAGE + " Morgen." };
  }

  const uhr = Math.round(frZahl(schlussUhr, -1));
  if (!(uhr >= 0 && uhr <= 1439)) return { erfolg: false, fehler: "Bitte wähle einen Bestellschluss." };

  const pin = frText(adminPin, 20);
  if (!pin) return { erfolg: false, fehler: "Bitte lege einen Veranstalter-PIN fest." };
  if (pinZuKurz(pin)) return { erfolg: false, fehler: PIN_ZU_KURZ };
  if (!frBeweisWegDa() || !pinHashMoeglich()) {
    return { erfolg: false, fehler: typeof PIN_UNSICHER === "string" ? PIN_UNSICHER : "Dieses Gerät kann den PIN nicht sichern." };
  }
  // Hash VOR dem Anlegen bilden: scheitert er, gibt es keinen halben Plan
  // ohne jeden Veranstalter-Zugang.
  let pinH;
  try { pinH = await pinHash(FR_PID, pin); }
  catch (e) { return { erfolg: false, fehler: typeof PIN_UNSICHER === "string" ? PIN_UNSICHER : "Dieses Gerät kann den PIN nicht sichern." }; }

  // ⚠️⚠️ Der Hash geht VOR dem Plan in die Datenbank, nicht danach.
  //
  // Bis die neuen Regeln in der Firebase-Konsole veröffentlicht sind, gibt es
  // fruehstueckGeheim gar nicht und dieser Schreibvorgang scheitert. Stünde er HINTER
  // dem Plan, gäbe es danach einen Plan, dessen PIN nirgends hinterlegt ist —
  // weder als Hash noch (seit heute) als Klartext. Dann käme nur noch das
  // anlegende Gerät über hostId hinein, und auf jedem anderen wäre der
  // Veranstalter-Bereich dauerhaft zu. Scheitert es hier, entsteht schlicht
  // kein Plan, und die Meldung sagt warum.
  const hashRef = db.ref(FR_GEHEIM_PFAD + "/" + FR_PID + "/adminPinHash");
  let hashGeschrieben = false;
  try {
    await hashRef.set(pinH);
    hashGeschrieben = true;
  } catch (e) {
    // Liegt schon ein Hash (ein halber früherer Anlauf, ein nicht
    // ausgetragener PIN), darf die Regel ihn nur mit Beweis ersetzen. Ist es
    // der Hash zu GENAU DIESEM PIN, gelingt der Beweis – und es geht weiter
    // (Bugjagd 16.09.2026, A3).
    if (!(await frBeweisePin(pin))) {
      return { erfolg: false, fehler: "Der PIN ließ sich nicht sichern. Entweder ist von einer früheren Frühstücksbestellung noch ein anderer PIN hinterlegt – dann nimm den –, oder die Datenbank-Regeln sind noch nicht veröffentlicht." };
    }
  }
  // Beweisablage VOR dem Plan: scheitert der Plan gleich, braucht das
  // Zurücknehmen des Hashes sie (die Regel vergleicht damit). Beim Weg über
  // frBeweisePin() liegt sie schon. ⚠️ Mit try: ein Fehlschlag hier ist eine
  // Nebensache, nachgeholt wird sie beim nächsten Laden von frPruefeGemerktenPin().
  if (hashGeschrieben) {
    try {
      await legeBeweisAb(FR_PROBE_PFAD, FR_PID, frEigeneUid, pinH);
    } catch (e) { /* siehe oben */ }
  }

  try {
    await db.ref(FR_BASIS).update({
      meta: {
        titel: t,
        hostId: frEigeneUid,
        // ⚠️ KEIN adminPin mehr. Die Firebase-Regel weist das Feld seit dem
        // 15.09.2026 ab (".validate": false) – wer es hier wieder einträgt,
        // bekommt den ganzen Schreibvorgang zurückgewiesen, nicht nur das Feld.
        erstelltAm: firebase.database.ServerValue.TIMESTAMP,
        startDatum: startDatum,
        anzahlTage: tage,
        schlussUhr: uhr,
        annahmeOffen: true,
      },
    });
  } catch (e) {
    // Plan nicht angelegt: den eben hinterlegten Hash zurücknehmen, sonst
    // blockiert er den nächsten Anlauf mit einem anderen PIN. Scheitert auch
    // das, kommt derselbe PIN trotzdem durch (Beweisweg oben).
    if (hashGeschrieben) {
      try { await hashRef.remove(); } catch (e2) { /* siehe oben */ }
    }
    return { erfolg: false, fehler: "Die Frühstücksbestellung ließ sich nicht anlegen. Bitte versuch es noch einmal." };
  }
  frPinOk = true;
  try {
    localStorage.setItem(FR_PIN_KEY, pin);
  } catch (e) { /* privater Modus: dann zählt nur hostId */ }
  return { erfolg: true };
}

function frPruefePaket({ name, beschreibung, preis }) {
  const n = frText(name, 60);
  if (!n) return { erfolg: false, fehler: "Das Paket braucht einen Namen." };
  const cent = frPreisNachCent(preis);
  if (cent === null) return { erfolg: false, fehler: "Der Preis ist keine gültige Zahl." };
  if (cent > FR_MAX_PREIS_CENT) {
    return { erfolg: false, fehler: "Mehr als " + frCentLabel(FR_MAX_PREIS_CENT) + " je Paket geht nicht." };
  }
  return {
    erfolg: true,
    werte: { name: n, beschreibung: frText(beschreibung, 200), preisCent: cent },
  };
}

async function frLegePaketAn({ name, beschreibung, preis }) {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const z = frGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Es gibt noch keine Frühstücksbestellung." };
  if (z.pakete.length >= FR_MAX_PAKETE) {
    return { erfolg: false, fehler: "Mehr als " + FR_MAX_PAKETE + " Pakete werden unübersichtlich." };
  }

  const geprueft = frPruefePaket({ name, beschreibung, preis });
  if (!geprueft.erfolg) return geprueft;

  const id = frNeueId("pak");
  await db.ref(FR_BASIS + "/pakete/" + id).update(
    Object.assign({}, geprueft.werte, {
      sort: z.pakete.length,
      erstelltAm: firebase.database.ServerValue.TIMESTAMP,
    })
  );
  return { erfolg: true, id };
}

async function frAenderePaket(id, { name, beschreibung, preis }) {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (!frGetZustand().pakete.some((p) => p.id === id)) {
    return { erfolg: false, fehler: "Dieses Paket gibt es nicht mehr." };
  }

  const geprueft = frPruefePaket({ name, beschreibung, preis });
  if (!geprueft.erfolg) return geprueft;

  await db.ref(FR_BASIS + "/pakete/" + id).update(geprueft.werte);
  return { erfolg: true };
}

// Ein gelöschtes Paket lässt Bestellungen zurück, die darauf zeigen. Die
// Positionen werden deshalb mit weggeräumt – sonst stünde in der Einkaufsliste
// eine Menge ohne Ware, und die Summe stimmte nicht mehr.
async function frLoeschePaket(id) {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const z = frGetZustand();
  if (!z.pakete.some((p) => p.id === id)) return { erfolg: false, fehler: "Dieses Paket gibt es nicht mehr." };

  const updates = {};
  updates["pakete/" + id] = null;
  z.tage.forEach((tag) => {
    tag.bestellungen.forEach((b) => {
      if (b.positionen.some((pos) => pos.paketId === id)) {
        updates["bestellungen/" + tag.datum + "/" + b.uid + "/positionen/" + id] = null;
        updates["bestellungen/" + tag.datum + "/" + b.uid + "/preise/" + id] = null;
      }
    });
  });
  await db.ref(FR_BASIS).update(updates);
  return { erfolg: true };
}

async function frVerschiebePaket(id, richtung) {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const pakete = frGetZustand().pakete;
  const i = pakete.findIndex((p) => p.id === id);
  if (i < 0) return { erfolg: false, fehler: "Dieses Paket gibt es nicht mehr." };
  const j = i + (richtung < 0 ? -1 : 1);
  if (j < 0 || j >= pakete.length) return { erfolg: true };

  const neu = pakete.slice();
  neu.splice(j, 0, neu.splice(i, 1)[0]);
  // Immer die GANZE Liste neu nummerieren: einzelne sort-Werte zu tauschen
  // hinterlässt Lücken und Doppelungen, sobald zwischendurch etwas gelöscht wurde.
  const updates = {};
  neu.forEach((p, idx) => { updates["pakete/" + p.id + "/sort"] = idx; });
  await db.ref(FR_BASIS).update(updates);
  return { erfolg: true };
}

// Warum gerade nichts geht. Zwei Gründe, zwei Antworten: „geschlossen" heißt
// warten auf den Veranstalter, „vorbei" heißt für diesen Morgen ist Schluss.
// ⚠️ Die Uhr steht VOR dem Schalter. Ein Morgen, dessen Bestellschluss durch
// ist, bleibt zu, auch wenn der Veranstalter gleich wieder aufdreht – wer hier
// „geschlossen" liest, wartet sonst auf etwas, das für diesen Tag nie kommt.
function frWarumZu(z, tag) {
  if (!tag.zeitOffen) return "Für " + tag.tagLang + " ist der Bestellschluss vorbei.";
  return "Die Bestellannahme ist gerade geschlossen.";
}

// Eine Bestellung wird immer komplett geschrieben: positionen ersetzt, nicht
// gemischt. Ein „update" mit nur den geänderten Zählern ließe Reste von
// Paketen stehen, die gerade auf 0 gestellt wurden.
async function frBestelle(datum, { name, positionen, notiz }) {
  await frAuthBereit;
  const z = frGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Es gibt noch keine Frühstücksbestellung." };

  const tag = z.tage.find((t) => t.datum === datum);
  if (!tag) return { erfolg: false, fehler: "Diesen Morgen gibt es nicht." };
  if (!tag.offen && !z.istAdmin) {
    return { erfolg: false, fehler: frWarumZu(z, tag) };
  }

  const n = frText(name, 40);
  if (!n) return { erfolg: false, fehler: "Bitte trag deinen Namen ein." };

  const sauber = {};
  // ⚠️ Name und Preis werden beim Abschicken festgeschrieben, nicht erst beim
  // Anzeigen aus dem Paket geholt. Sonst rechnet eine spätere Preisänderung
  // alle schon abgehakten Bestellungen rückwirkend um.
  const feste = {};
  let stueck = 0;
  Object.entries(positionen || {}).forEach(([pid, anzahl]) => {
    const paket = z.pakete.find((p) => p.id === pid);
    if (!paket) return;
    const wert = Math.round(frZahl(anzahl, 0));
    if (wert <= 0) return;
    const begrenzt = Math.min(FR_MAX_STUECK, wert);
    sauber[pid] = begrenzt;
    feste[pid] = { name: paket.name, preisCent: paket.preisCent };
    stueck += begrenzt;
  });

  const pfad = FR_BASIS + "/bestellungen/" + datum + "/" + frEigeneUid;
  if (!stueck) {
    // Nichts ausgewählt heißt: abbestellen. Ein leerer Knoten wäre in der
    // Einkaufsliste ein Name ohne Ware.
    await db.ref(pfad).remove();
    return { erfolg: true, abbestellt: true };
  }

  // ⚠️ set() statt update(), damit weggeklickte Positionen wirklich verschwinden
  // – aber abgeholt/bezahlt sind Haken des VERANSTALTERS und dürfen nicht bei
  // jeder Änderung des Bestellers zurückfallen. Deshalb den bisherigen Stand
  // mitschreiben statt ihn auf false zu setzen.
  const bisher = tag.meineBestellung;
  await db.ref(pfad).set({
    name: n,
    positionen: sauber,
    preise: feste,
    notiz: frText(notiz, 200),
    abgeholt: !!(bisher && bisher.abgeholt),
    bezahlt: !!(bisher && bisher.bezahlt),
    aktualisiertAm: firebase.database.ServerValue.TIMESTAMP,
  });
  try {
    localStorage.setItem(FR_NAME_KEY, n);
  } catch (e) { /* privater Modus */ }
  return { erfolg: true };
}

async function frStorniere(datum) {
  await frAuthBereit;
  const z = frGetZustand();
  const tag = z.tage.find((t) => t.datum === datum);
  if (!tag) return { erfolg: false, fehler: "Diesen Morgen gibt es nicht." };
  if (!tag.offen && !z.istAdmin) {
    return { erfolg: false, fehler: frWarumZu(z, tag) };
  }
  await db.ref(FR_BASIS + "/bestellungen/" + datum + "/" + frEigeneUid).remove();
  return { erfolg: true };
}

// Zum Abhaken bei der Ausgabe am Morgen.
async function frSetzeAbgeholt(datum, uid, wert) {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(FR_BASIS + "/bestellungen/" + datum + "/" + uid + "/abgeholt").set(!!wert);
  return { erfolg: true };
}

// Zum Abhaken beim Kassieren.
async function frSetzeBezahlt(datum, uid, wert) {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(FR_BASIS + "/bestellungen/" + datum + "/" + uid + "/bezahlt").set(!!wert);
  return { erfolg: true };
}

// Der Griff für zwischendurch: alles dicht, ohne an den Bestellzeiten zu drehen.
// Steht bewusst NICHT in frSetzeEinstellungen – der Schalter wirkt sofort, die
// Felder daneben erst auf „Speichern".
async function frSetzeAnnahme(offen) {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(FR_BASIS + "/meta/annahmeOffen").set(!!offen);
  return { erfolg: true };
}

async function frSetzeEinstellungen({ anzahlTage, schlussUhr }) {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const tage = Math.round(frZahl(anzahlTage, 0));
  if (!(tage >= 1 && tage <= FR_MAX_TAGE)) {
    return { erfolg: false, fehler: "Es geht über 1 bis " + FR_MAX_TAGE + " Morgen." };
  }
  const uhr = Math.round(frZahl(schlussUhr, -1));
  if (!(uhr >= 0 && uhr <= 1439)) return { erfolg: false, fehler: "Bitte wähle einen Bestellschluss." };

  await db.ref(FR_BASIS + "/meta").update({ anzahlTage: tage, schlussUhr: uhr });
  return { erfolg: true };
}

async function frLeereBestellungen() {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(FR_BASIS + "/bestellungen").remove();
  return { erfolg: true };
}

// Den hinterlegten Hash austragen. Liefert true, wenn er weg ist.
// ⚠️ NUR das Kind adminPinHash: die Regel erlaubt Schreiben nur dort, ein
// remove() auf den ganzen Knoten <pid> weist sie ab. Bis zum 16.09.2026 stand
// hier genau das – still verschluckt, der alte Hash blieb, und jede neue
// Bestellung mit anderem PIN scheiterte (Bugjagd A2).
// ⚠️ Solange der eigene Beweis noch daneben liegt: die Regel vergleicht den
// Hash mit der Beweisablage dieses Geräts. Fehlt sie (Veranstalter-Konto oder
// hostId, ohne PIN angemeldet), wird sie mit dem gemerkten PIN nachgeholt.
async function frEntferneHash() {
  const ref = db.ref(FR_GEHEIM_PFAD + "/" + FR_PID + "/adminPinHash");
  try {
    await ref.remove();
    return true;
  } catch (e) { /* ohne Beweis abgewiesen – unten nachholen */ }
  const pin = frGespeicherterPin();
  if (!pin || !(await frBeweisePin(pin))) return false;
  try {
    await ref.remove();
    return true;
  } catch (e) {
    return false;
  }
}

async function frLoeschePlan() {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(FR_BASIS).remove();
  // ⚠️ Die Nebenknoten MIT wegräumen. Bliebe der alte Hash stehen, ließe sich
  // die nächste Bestellung nur mit dem PIN der vorigen aufmachen – und der ist
  // unter Umständen längst weitergereicht. Geheimnis zuerst, Beweisablage
  // danach: die Regel lässt das Löschen des Hashes nur mit Beweis zu.
  const hashWeg = await frEntferneHash();
  // Eine Beweisablage ohne Hash ist wertlos – bleibt sie liegen, schadet sie nicht.
  try { await db.ref(FR_PROBE_PFAD + "/" + FR_PID + "/" + frEigeneUid).remove(); } catch (e) {}
  frPinOk = false;
  if (!hashWeg) {
    // ⚠️ Nicht schweigen: sonst scheitert die nächste Bestellung mit einer
    // Meldung, die niemand mit diesem Löschen in Verbindung bringt.
    return {
      erfolg: true,
      warnung: "Die Frühstücksbestellung ist gelöscht. Ihr PIN ließ sich aber nicht austragen – eine neue Frühstücksbestellung geht deshalb nur mit demselben PIN wie bisher.",
    };
  }
  return { erfolg: true };
}

// ⚠️ Jetzt async: der PIN wird nicht mehr im Browser verglichen, sondern dem
// SERVER bewiesen. Die Aufrufer in fruehstueck-app.js müssen darauf warten.
async function frAuthentifiziereAlsAdmin(pin) {
  const eingabe = frText(pin, 20);
  if (!eingabe) return { erfolg: false, fehler: "Bitte gib den PIN ein." };
  if (!frRoh || !frRoh.meta) {
    return { erfolg: false, fehler: "Es gibt noch keine Frühstücksbestellung." };
  }
  if (!frBeweisWegDa() || !pinHashMoeglich()) {
    return { erfolg: false, fehler: typeof PIN_UNSICHER === "string" ? PIN_UNSICHER : "Dieses Gerät kann den PIN nicht prüfen." };
  }
  let ok = await frBeweisePin(eingabe);
  // Altbestand: Plan von vor dem 15.09.2026, Hash noch nicht hinterlegt.
  if (!ok) ok = await frHeileAltenPin(eingabe);
  // ⚠️⚠️ Altbestand-Rueckfall auf den KLARTEXT. Turnier und Streamplan machen
  // dasselbe (authentifiziereAlsAdmin dort) und aus demselben Grund: die neuen
  // Regeln muessen in der Firebase-Konsole von Hand veroeffentlicht werden.
  // Bis dahin gibt es die Knoten fruehstueckGeheim/fruehstueckPinProbe gar nicht, beide
  // Schreibvorgaenge oben scheitern, und OHNE diesen Zweig kaeme niemand mehr
  // an den Veranstalter-Bereich -- an einen Bereich, hinter dem Telefonnummer,
  // Lieferantenmail und alle Bestellungen liegen, mitten in der Veranstaltung.
  //
  // Der Zweig wird von selbst bedeutungslos: sobald die Regeln stehen, zieht
  // frHeileAltenPin() den Klartext weg, und danach ist `alt` immer leer.
  if (!ok) {
    const alt = frRoh.meta.adminPin;
    if (alt && eingabe === alt) ok = true;
  }
  if (!ok) return { erfolg: false, fehler: "Der PIN stimmt nicht." };
  frPinOk = true;
  try {
    localStorage.setItem(FR_PIN_KEY, eingabe);
  } catch (e) { /* privater Modus */ }
  frMelde();
  return { erfolg: true };
}

// ===========================================================================
const fruehstueckService = {
  MAX_TAGE: FR_MAX_TAGE,
  MAX_PAKETE: FR_MAX_PAKETE,
  MAX_STUECK: FR_MAX_STUECK,
  STANDARD_SCHLUSS: FR_STANDARD_SCHLUSS,
  onZustandsAenderung: frOnZustandsAenderung,
  getZustand: frGetZustand,
  erstellePlan: frErstellePlan,
  legePaketAn: frLegePaketAn,
  aenderePaket: frAenderePaket,
  loeschePaket: frLoeschePaket,
  verschiebePaket: frVerschiebePaket,
  bestelle: frBestelle,
  storniere: frStorniere,
  setzeAbgeholt: frSetzeAbgeholt,
  setzeBezahlt: frSetzeBezahlt,
  setzeAnnahme: frSetzeAnnahme,
  setzeEinstellungen: frSetzeEinstellungen,
  leereBestellungen: frLeereBestellungen,
  loeschePlan: frLoeschePlan,
  authentifiziereAlsAdmin: frAuthentifiziereAlsAdmin,
  centLabel: frCentLabel,
  zeitLabel: frZeitLabel,
  datumLabel: frDatumLabel,
  heuteIso: frHeuteIso,
  datumPlus: frDatumPlus,
  // ⚠️ Das angemeldete Konto schlaegt jeden gemerkten Namen: es ist der Name,
  // unter dem abgerechnet wird. Steht kein Konto bereit (aeltere Anmeldung,
  // privater Modus), gilt weiter der zuletzt benutzte Name.
  getGespeicherterName: () => {
    try {
      const konto = window.__AGELAN_KONTO__;
      if (konto && konto.nickname) return konto.nickname;
      return localStorage.getItem(FR_NAME_KEY) || localStorage.getItem("agelan_spieler_name") || "";
    } catch (e) {
      return "";
    }
  },
  // Nur für den Test: die Uhr um n Stunden verstellen, damit sich ein
  // Bestellschluss ohne Systemzeit-Eingriff überschreiten lässt.
  _setzeZeitversatzStunden: (h) => {
    frZeitVersatzMs = frZahl(h, 0) * 3600000;
    frMelde();
  },
};
