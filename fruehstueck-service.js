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
//   meta        : { titel, hostId, adminPin, erstelltAm, startDatum:"YYYY-MM-DD",
//                   anzahlTage, schlussUhr }
//   pakete/$pid : { name, beschreibung, preisCent, sort, erstelltAm }
//   bestellungen/$datum/$uid : { name, positionen:{pid:anzahl}, notiz,
//                                abgeholt, aktualisiertAm }
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
  if (!frRoh || !frRoh.meta) return false;
  const meta = frRoh.meta;
  if (meta.hostId && meta.hostId === frEigeneUid) return true;
  return !!meta.adminPin && frGespeicherterPin() === meta.adminPin;
}

// PIN des laufenden Turniers bzw. des Streamplans, damit ein neuer
// Frühstücksplan denselben PIN übernimmt und es nicht drei Geheimnisse für
// dieselbe Person gibt.
function frVorhandenerPin() {
  try {
    if (typeof streamService !== "undefined") {
      const s = streamService.getZustand();
      if (s && s.vorhanden && s.istAdmin && s.meta && s.meta.adminPin) return s.meta.adminPin;
    }
  } catch (e) { /* Streamplan noch nicht geladen */ }
  try {
    if (typeof turnierService !== "undefined") {
      const z = turnierService.getZustand();
      if (z && z.vorhanden && z.istAdmin && z.meta && z.meta.adminPin) return z.meta.adminPin;
    }
  } catch (e) { /* kein Turnier */ }
  return "";
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
function frPositionenListe(positionenRoh, pakete) {
  const positionen = [];
  Object.entries(positionenRoh || {}).forEach(([pid, anzahl]) => {
    const n = Math.round(frZahl(anzahl, 0));
    if (n <= 0) return;
    const paket = pakete.find((p) => p.id === pid);
    if (!paket) return;   // Paket wurde nachträglich gelöscht
    positionen.push({
      paketId: pid,
      name: paket.name,
      anzahl: Math.min(FR_MAX_STUECK, n),
      preisCent: paket.preisCent,
      summeCent: paket.preisCent * Math.min(FR_MAX_STUECK, n),
    });
  });
  positionen.sort((a, b) => pakete.findIndex((p) => p.id === a.paketId) - pakete.findIndex((p) => p.id === b.paketId));
  return positionen;
}

function frBestellungenEinesTages(bestellungenRoh, datum, pakete) {
  const roh = (bestellungenRoh || {})[datum] || {};
  const liste = [];
  Object.entries(roh).forEach(([uid, b]) => {
    const positionen = frPositionenListe(b && b.positionen, pakete);
    if (!positionen.length) return;
    liste.push({
      uid,
      name: frText(b && b.name, 40) || "Ohne Namen",
      notiz: frText(b && b.notiz, 200),
      abgeholt: !!(b && b.abgeholt),
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
      offen: jetzt < schlussMs,
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

function frGetZustand() {
  const meta = (frRoh && frRoh.meta) || null;
  if (!meta || !meta.startDatum) {
    return {
      vorhanden: false,
      meta: null,
      pakete: [],
      tage: [],
      istAdmin: false,
      eigeneUid: frEigeneUid,
      vorhandenerPin: frVorhandenerPin(),
    };
  }
  const pakete = frPaketListe(frRoh.pakete);
  const tage = frTageListe(meta, frRoh.bestellungen, pakete);
  return {
    vorhanden: true,
    meta,
    pakete,
    tage,
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

  await db.ref(FR_BASIS).update({
    meta: {
      titel: t,
      hostId: frEigeneUid,
      adminPin: pin,
      erstelltAm: firebase.database.ServerValue.TIMESTAMP,
      startDatum: startDatum,
      anzahlTage: tage,
      schlussUhr: uhr,
    },
  });
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
    return { erfolg: false, fehler: "Für " + tag.tagLang + " ist der Bestellschluss vorbei." };
  }

  const n = frText(name, 40);
  if (!n) return { erfolg: false, fehler: "Bitte trag deinen Namen ein." };

  const sauber = {};
  let stueck = 0;
  Object.entries(positionen || {}).forEach(([pid, anzahl]) => {
    if (!z.pakete.some((p) => p.id === pid)) return;
    const wert = Math.round(frZahl(anzahl, 0));
    if (wert <= 0) return;
    const begrenzt = Math.min(FR_MAX_STUECK, wert);
    sauber[pid] = begrenzt;
    stueck += begrenzt;
  });

  const pfad = FR_BASIS + "/bestellungen/" + datum + "/" + frEigeneUid;
  if (!stueck) {
    // Nichts ausgewählt heißt: abbestellen. Ein leerer Knoten wäre in der
    // Einkaufsliste ein Name ohne Ware.
    await db.ref(pfad).remove();
    return { erfolg: true, abbestellt: true };
  }

  await db.ref(pfad).set({
    name: n,
    positionen: sauber,
    notiz: frText(notiz, 200),
    abgeholt: false,
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
    return { erfolg: false, fehler: "Für " + tag.tagLang + " ist der Bestellschluss vorbei." };
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

async function frLoeschePlan() {
  await frAuthBereit;
  if (!frIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(FR_BASIS).remove();
  return { erfolg: true };
}

function frAuthentifiziereAlsAdmin(pin) {
  const eingabe = frText(pin, 20);
  if (!eingabe) return { erfolg: false, fehler: "Bitte gib den PIN ein." };
  if (!frRoh || !frRoh.meta || !frRoh.meta.adminPin) {
    return { erfolg: false, fehler: "Es gibt noch keine Frühstücksbestellung." };
  }
  if (eingabe !== frRoh.meta.adminPin) return { erfolg: false, fehler: "Der PIN stimmt nicht." };
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
  setzeEinstellungen: frSetzeEinstellungen,
  leereBestellungen: frLeereBestellungen,
  loeschePlan: frLoeschePlan,
  authentifiziereAlsAdmin: frAuthentifiziereAlsAdmin,
  centLabel: frCentLabel,
  zeitLabel: frZeitLabel,
  datumLabel: frDatumLabel,
  heuteIso: frHeuteIso,
  datumPlus: frDatumPlus,
  getGespeicherterName: () => {
    try {
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
