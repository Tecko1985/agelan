// ===========================================================================
// stream-service.js – Firebase-Kapsel für den Streamkalender der AgeLan.
//
// Eigener Top-Level-Knoten, BEWUSST nicht unter turniere/aktuell: dort fährt
// loescheTurnier() ein remove() auf den ganzen Baum und setzeTurnierZurueck()
// räumt Teams/Gruppen/Spiele weg. Der Streamplan überlebt beide und existiert
// auch ganz ohne Turnier.
//
// Datenmodell (Realtime Database, ein aktiver Plan unter streamplan/aktuell):
//   meta        : { titel, hostId, adminPin, erstelltAm, startDatum:"YYYY-MM-DD",
//                   anzahlTage, standardVon, standardBis }
//   tage/$datum : { von, bis }        // abweichendes Zeitfenster für einen Tag
//   slots/$sid  : { datum, von, bis, streamer, uid, titel, notiz, erstelltAm }
//
// Alle Uhrzeiten sind Minuten seit 0:00 DES JEWEILIGEN TAGES. Werte über 1440
// sind gewollt (LAN-Nächte): 1500 = 25:00 = 1:00 in der Nacht auf den Folgetag.
// Für jeden Vergleich über Tagesgrenzen hinweg wird daraus eine absolute Minute
// seit Plan-Start gerechnet (tagIndex * 1440 + minute) – nur so fällt auf, dass
// „Donnerstag 25:00" und „Freitag 1:00" derselbe Zeitpunkt sind.
// ===========================================================================

const SK_BASIS = "streamplan/aktuell";
const SK_PIN_KEY = "agelan_admin_pin";      // derselbe Schlüssel wie beim Turnier: ein PIN für beides
const SK_NAME_KEY = "agelan_streamer_name";

const SK_SCHRITT = 15;        // Raster der Zeitauswahl in Minuten
const SK_MIN_DAUER = 15;
const SK_MAX_BIS = 1800;      // 30:00 – weiter als 6 Uhr früh geht ein Tagesfenster nicht
const SK_MAX_TAGE = 7;
const SK_TAG_KURZ = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// --- lokaler Zustand -------------------------------------------------------
let skEigeneUid = null;
let skRoh = null;             // roher { meta, tage, slots }-Snapshot
let skListener = null;

const skAuthBereit = new Promise((resolve) => {
  auth.onAuthStateChanged((user) => {
    if (user) {
      skEigeneUid = user.uid;
      resolve(user.uid);
    }
  });
});

// --- Datum & Zeit ----------------------------------------------------------
function skHeuteIso() {
  const d = new Date();
  return skIsoVon(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function skIsoVon(jahr, monat, tag) {
  return jahr + "-" + String(monat).padStart(2, "0") + "-" + String(tag).padStart(2, "0");
}

// "YYYY-MM-DD" + n Tage. Bewusst über lokale Date-Arithmetik statt über
// Millisekunden-Addition, damit Sommer-/Winterzeit den Tag nicht verschiebt.
function skDatumPlus(iso, n) {
  const t = String(iso || "").split("-");
  const d = new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2]));
  if (isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + n);
  return skIsoVon(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function skDatumObjekt(iso) {
  const t = String(iso || "").split("-");
  return new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2]));
}

// Minuten über 1440 gehören optisch zum Folgetag: 1500 -> "01:00".
function skZeitLabel(min) {
  const m = ((Number(min) || 0) % 1440 + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

// Für Auswahllisten: macht die Nachtstunden als solche kenntlich, sonst steht
// "01:00" zweimal in derselben Liste und niemand weiß, welches gemeint ist.
function skZeitLabelLang(min) {
  return skZeitLabel(min) + (Number(min) >= 1440 ? " (Nacht)" : "");
}

function skDatumLabel(iso, mitJahr) {
  const d = skDatumObjekt(iso);
  if (isNaN(d.getTime())) return String(iso || "");
  const kurz = SK_TAG_KURZ[d.getDay()];
  const rest = d.getDate() + "." + (d.getMonth() + 1) + ".";
  return kurz + " " + rest + (mitJahr ? d.getFullYear() : "");
}

function skZahl(wert, ersatz) {
  const n = Number(wert);
  return isFinite(n) ? n : ersatz;
}

function skText(wert, maxLaenge) {
  return String(wert == null ? "" : wert).trim().slice(0, maxLaenge);
}

// --- Admin-Status ----------------------------------------------------------
function skGespeicherterPin() {
  try {
    return localStorage.getItem(SK_PIN_KEY);
  } catch (e) {
    return null;
  }
}

function skIstAdmin() {
  if (!skRoh || !skRoh.meta) return false;
  const meta = skRoh.meta;
  if (meta.hostId && meta.hostId === skEigeneUid) return true;
  return !!meta.adminPin && skGespeicherterPin() === meta.adminPin;
}

// PIN des laufenden Turniers, falls es eines gibt und wir dort Veranstalter
// sind. Damit übernimmt ein neuer Streamplan denselben PIN und es gibt nicht
// zwei Geheimnisse für dieselbe Person.
function skTurnierPin() {
  try {
    if (typeof turnierService === "undefined") return "";
    const z = turnierService.getZustand();
    if (!z || !z.vorhanden || !z.istAdmin || !z.meta) return "";
    return z.meta.adminPin || "";
  } catch (e) {
    return "";
  }
}

// ===========================================================================
// Zustands-Aufbereitung für die UI
// ===========================================================================

// Die Tage des Plans mit ihrem geltenden Zeitfenster. Ein Eintrag unter
// tage/$datum überschreibt das Standardfenster aus meta.
function skTageListe(meta, tageRoh) {
  const anzahl = Math.min(SK_MAX_TAGE, Math.max(1, skZahl(meta.anzahlTage, 1)));
  const liste = [];
  for (let i = 0; i < anzahl; i++) {
    const datum = skDatumPlus(meta.startDatum, i);
    const eigen = (tageRoh || {})[datum] || {};
    liste.push({
      index: i,
      datum,
      von: skZahl(eigen.von, skZahl(meta.standardVon, 600)),
      bis: skZahl(eigen.bis, skZahl(meta.standardBis, 1440)),
      label: skDatumLabel(datum, false),
      eigenesFenster: eigen.von != null || eigen.bis != null,
    });
  }
  return liste;
}

function skSlotListe(slotsRoh, tage) {
  const indexVon = {};
  tage.forEach((t) => { indexVon[t.datum] = t.index; });

  return Object.keys(slotsRoh || {})
    .map((id) => {
      const s = slotsRoh[id] || {};
      // Slots an einem Tag, den es nicht mehr gibt (Plan verkürzt), fallen raus:
      // sie hätten keine Spalte, in der sie stehen könnten.
      const tagIndex = indexVon[s.datum];
      if (tagIndex == null) return null;
      const von = skZahl(s.von, 0);
      const bis = skZahl(s.bis, 0);
      return {
        id,
        datum: s.datum,
        von,
        bis,
        tagIndex,
        absVon: tagIndex * 1440 + von,
        absBis: tagIndex * 1440 + bis,
        streamer: s.streamer || "",
        titel: s.titel || "",
        notiz: s.notiz || "",
        uid: s.uid || "",
        erstelltAm: s.erstelltAm || 0,
        istEigener: !!s.uid && s.uid === skEigeneUid,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.absVon - b.absVon || a.absBis - b.absBis);
}

function skGetZustand() {
  const meta = (skRoh && skRoh.meta) || null;
  if (!meta || !meta.startDatum) {
    return {
      vorhanden: false,
      meta: null,
      tage: [],
      slots: [],
      istAdmin: false,
      eigeneUid: skEigeneUid,
      turnierPin: skTurnierPin(),
    };
  }
  const tage = skTageListe(meta, skRoh.tage);
  const slots = skSlotListe(skRoh.slots, tage);
  const admin = skIstAdmin();
  slots.forEach((s) => { s.darfBearbeiten = admin || s.istEigener; });

  return {
    vorhanden: true,
    meta,
    tage,
    slots,
    istAdmin: admin,
    eigeneUid: skEigeneUid,
    turnierPin: skTurnierPin(),
    achseVon: Math.min.apply(null, tage.map((t) => t.von)),
    achseBis: Math.max.apply(null, tage.map((t) => t.bis)),
  };
}

// --- Live-Anbindung --------------------------------------------------------
const skCallbacks = [];

function skMelde() {
  const z = skGetZustand();
  skCallbacks.forEach((cb) => {
    try {
      cb(z);
    } catch (e) {
      console.error("[Streamplan] Render-Fehler:", e);
    }
  });
}

function skOnZustandsAenderung(cb) {
  skCallbacks.push(cb);
  if (skRoh !== null) cb(skGetZustand());
  return cb;
}

skAuthBereit.then(() => {
  if (skListener) return;
  skListener = db.ref(SK_BASIS).on("value", (snap) => {
    skRoh = snap.val() || {};
    skMelde();
  });
});

// ===========================================================================
// Schreibende Aktionen
// ===========================================================================

function skNeueId(praefix) {
  return praefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

// Zwei Zeiträume überschneiden sich, wenn jeder vor dem Ende des anderen
// beginnt. Berührung (Ende == Beginn) ist erlaubt: 20–22 Uhr und 22–24 Uhr
// sind zwei saubere Blöcke, kein Konflikt.
function skFindeKonflikt(slots, absVon, absBis, ausserId) {
  return slots.find((s) => s.id !== ausserId && absVon < s.absBis && absBis > s.absVon) || null;
}

async function skErstellePlan({ titel, startDatum, anzahlTage, von, bis, adminPin }) {
  await skAuthBereit;
  if (skRoh && skRoh.meta) return { erfolg: false, fehler: "Es gibt schon einen Streamplan." };

  const t = skText(titel, 60);
  if (!t) return { erfolg: false, fehler: "Bitte gib dem Streamplan einen Namen." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDatum || ""))) return { erfolg: false, fehler: "Bitte wähle einen ersten Tag." };

  const tage = Math.round(skZahl(anzahlTage, 0));
  if (!(tage >= 1 && tage <= SK_MAX_TAGE)) return { erfolg: false, fehler: "Der Plan geht über 1 bis " + SK_MAX_TAGE + " Tage." };

  const v = Math.round(skZahl(von, -1));
  const b = Math.round(skZahl(bis, -1));
  const fenster = skPruefeFenster(v, b);
  if (!fenster.erfolg) return fenster;
  // Ein Tagesfenster darf in die Nacht reichen, aber nicht in den nächsten
  // Kalendertag hineinragen – sonst gäbe es Zeitpunkte in zwei Spalten.
  if (tage > 1 && b > 1440 + v) {
    return { erfolg: false, fehler: "Das Zeitfenster reicht bis in den nächsten Tag hinein. Kürze es oder lass den Plan nur über einen Tag laufen." };
  }

  const pin = skText(adminPin, 20);
  if (!pin) return { erfolg: false, fehler: "Bitte lege einen Veranstalter-PIN fest." };

  await db.ref(SK_BASIS).update({
    meta: {
      titel: t,
      hostId: skEigeneUid,
      adminPin: pin,
      erstelltAm: firebase.database.ServerValue.TIMESTAMP,
      startDatum: startDatum,
      anzahlTage: tage,
      standardVon: v,
      standardBis: b,
    },
  });
  try {
    localStorage.setItem(SK_PIN_KEY, pin);
  } catch (e) { /* privater Modus: dann zählt nur hostId */ }
  return { erfolg: true };
}

function skPruefeFenster(von, bis) {
  if (!(von >= 0 && von < 1440)) return { erfolg: false, fehler: "Der Beginn muss zwischen 0:00 und 23:45 liegen." };
  if (!(bis > von)) return { erfolg: false, fehler: "Das Ende muss nach dem Beginn liegen." };
  if (bis > SK_MAX_BIS) return { erfolg: false, fehler: "Später als 6:00 in der Nacht geht ein Tag nicht." };
  if (von % SK_SCHRITT || bis % SK_SCHRITT) return { erfolg: false, fehler: "Bitte nur volle Viertelstunden." };
  return { erfolg: true };
}

// Zeitfenster der Tage ändern (Veranstalter). Nimmt bewusst ALLE Tage auf
// einmal und prüft sie gemeinsam: einzeln gespeichert würde ein legitimes
// Verschieben scheitern, sobald zwei Tage aneinander vorbeiziehen müssen
// (Donnerstag verkürzen und Freitag vorziehen kollidiert im Zwischenschritt).
// Geprüft wird beides, was schiefgehen kann: Überlappung zweier Tage und
// Belegungen, die aus ihrem neuen Fenster herausfallen würden.
async function skSetzeTagesfenster(liste) {
  await skAuthBereit;
  if (!skIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const z = skGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Kein Streamplan vorhanden." };

  const neu = [];
  for (const eintrag of liste || []) {
    const tag = z.tage.find((t) => t.datum === eintrag.datum);
    if (!tag) return { erfolg: false, fehler: "Diesen Tag gibt es im Plan nicht." };
    const v = Math.round(skZahl(eintrag.von, -1));
    const b = Math.round(skZahl(eintrag.bis, -1));
    const fenster = skPruefeFenster(v, b);
    if (!fenster.erfolg) return { erfolg: false, fehler: tag.label + ": " + fenster.fehler };
    neu.push({ datum: tag.datum, index: tag.index, label: tag.label, von: v, bis: b });
  }
  if (!neu.length) return { erfolg: false, fehler: "Nichts zu speichern." };

  const sortiert = neu.slice().sort((a, b) => a.index - b.index);
  for (let i = 1; i < sortiert.length; i++) {
    const vorher = sortiert[i - 1];
    const jetzt = sortiert[i];
    if (vorher.index * 1440 + vorher.bis > jetzt.index * 1440 + jetzt.von) {
      return {
        erfolg: false,
        fehler: vorher.label + " reicht bis " + skZeitLabel(vorher.bis) + " und überschneidet sich damit mit " +
          jetzt.label + " ab " + skZeitLabel(jetzt.von) + ".",
      };
    }
  }

  for (const tag of neu) {
    const rausfallend = z.slots.filter((s) => s.datum === tag.datum && (s.von < tag.von || s.bis > tag.bis));
    if (rausfallend.length) {
      const s = rausfallend[0];
      return {
        erfolg: false,
        fehler: tag.label + ": " + rausfallend.length + " Belegung(en) liegen außerhalb, z. B. " +
          (s.streamer || "ein Eintrag") + " von " + skZeitLabel(s.von) + " bis " + skZeitLabel(s.bis) +
          ". Erst verschieben, dann das Fenster ändern.",
      };
    }
  }

  const updates = {};
  neu.forEach((t) => { updates[t.datum] = { von: t.von, bis: t.bis }; });
  await db.ref(SK_BASIS + "/tage").update(updates);
  return { erfolg: true };
}

async function skBelegeZeit({ datum, von, bis, streamer, titel, notiz }) {
  await skAuthBereit;
  const z = skGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Kein Streamplan vorhanden." };

  const geprueft = skPruefeBelegung(z, { datum, von, bis, streamer, titel, notiz }, null);
  if (!geprueft.erfolg) return geprueft;

  const id = skNeueId("slot");
  await db.ref(SK_BASIS + "/slots/" + id).update(
    Object.assign({}, geprueft.werte, {
      uid: skEigeneUid,
      erstelltAm: firebase.database.ServerValue.TIMESTAMP,
    })
  );
  try {
    localStorage.setItem(SK_NAME_KEY, geprueft.werte.streamer);
  } catch (e) { /* egal */ }
  return { erfolg: true, id };
}

async function skAendereSlot(id, { datum, von, bis, streamer, titel, notiz }) {
  await skAuthBereit;
  const z = skGetZustand();
  if (!z.vorhanden) return { erfolg: false, fehler: "Kein Streamplan vorhanden." };
  const alt = z.slots.find((s) => s.id === id);
  if (!alt) return { erfolg: false, fehler: "Diese Belegung gibt es nicht mehr." };
  if (!alt.darfBearbeiten) return { erfolg: false, fehler: "Das ist der Eintrag von jemand anderem." };

  const geprueft = skPruefeBelegung(z, { datum, von, bis, streamer, titel, notiz }, id);
  if (!geprueft.erfolg) return geprueft;

  await db.ref(SK_BASIS + "/slots/" + id).update(geprueft.werte);
  return { erfolg: true };
}

// Gemeinsame Prüfung für Anlegen und Ändern: gültiger Tag, Zeiten im Raster und
// im Tagesfenster, Name gesetzt, keine Überschneidung mit einer fremden oder
// eigenen Belegung. Es gibt einen Kanal, also kann nur einer senden.
function skPruefeBelegung(z, { datum, von, bis, streamer, titel, notiz }, ausserId) {
  const tag = z.tage.find((t) => t.datum === datum);
  if (!tag) return { erfolg: false, fehler: "Bitte wähle einen Tag aus dem Plan." };

  const v = Math.round(skZahl(von, -1));
  const b = Math.round(skZahl(bis, -1));
  if (v % SK_SCHRITT || b % SK_SCHRITT) return { erfolg: false, fehler: "Bitte nur volle Viertelstunden." };
  if (!(b - v >= SK_MIN_DAUER)) return { erfolg: false, fehler: "Das Ende muss mindestens " + SK_MIN_DAUER + " Minuten nach dem Beginn liegen." };
  if (v < tag.von || b > tag.bis) {
    return { erfolg: false, fehler: "An " + tag.label + " läuft der Stream von " + skZeitLabel(tag.von) + " bis " + skZeitLabel(tag.bis) + "." };
  }

  const name = skText(streamer, 40);
  if (!name) return { erfolg: false, fehler: "Bitte trag deinen Namen ein." };

  const absVon = tag.index * 1440 + v;
  const absBis = tag.index * 1440 + b;
  const konflikt = skFindeKonflikt(z.slots, absVon, absBis, ausserId);
  if (konflikt) {
    return {
      erfolg: false,
      fehler: "Da streamt schon " + (konflikt.streamer || "jemand") + " (" +
        skDatumLabel(konflikt.datum, false) + " " + skZeitLabel(konflikt.von) + "–" + skZeitLabel(konflikt.bis) + ").",
    };
  }

  return {
    erfolg: true,
    werte: { datum, von: v, bis: b, streamer: name, titel: skText(titel, 60), notiz: skText(notiz, 200) },
  };
}

async function skLoescheSlot(id) {
  await skAuthBereit;
  const z = skGetZustand();
  const slot = z.slots.find((s) => s.id === id);
  if (!slot) return { erfolg: false, fehler: "Diese Belegung gibt es nicht mehr." };
  if (!slot.darfBearbeiten) return { erfolg: false, fehler: "Das ist der Eintrag von jemand anderem." };
  await db.ref(SK_BASIS + "/slots/" + id).remove();
  return { erfolg: true };
}

// Alle Belegungen weg, Plan und Zeitfenster bleiben stehen – das Gegenstück zu
// "Turnier zurücksetzen".
async function skLeereBelegungen() {
  await skAuthBereit;
  if (!skIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const anzahl = skGetZustand().slots.length;
  if (!anzahl) return { erfolg: false, fehler: "Es ist nichts belegt." };
  await db.ref(SK_BASIS + "/slots").remove();
  return { erfolg: true, anzahl };
}

async function skLoeschePlan() {
  await skAuthBereit;
  if (!skIstAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(SK_BASIS).remove();
  return { erfolg: true };
}

function skAuthentifiziereAlsAdmin(pin) {
  const eingabe = skText(pin, 20);
  if (!eingabe) return { erfolg: false, fehler: "Bitte gib den PIN ein." };
  if (!skRoh || !skRoh.meta || !skRoh.meta.adminPin) return { erfolg: false, fehler: "Kein Streamplan vorhanden." };
  if (eingabe !== skRoh.meta.adminPin) return { erfolg: false, fehler: "Der PIN stimmt nicht." };
  try {
    localStorage.setItem(SK_PIN_KEY, eingabe);
  } catch (e) { /* privater Modus */ }
  skMelde();
  return { erfolg: true };
}

// ===========================================================================
const streamService = {
  SCHRITT: SK_SCHRITT,
  MAX_BIS: SK_MAX_BIS,
  MAX_TAGE: SK_MAX_TAGE,
  onZustandsAenderung: skOnZustandsAenderung,
  getZustand: skGetZustand,
  erstellePlan: skErstellePlan,
  setzeTagesfenster: skSetzeTagesfenster,
  belegeZeit: skBelegeZeit,
  aendereSlot: skAendereSlot,
  loescheSlot: skLoescheSlot,
  leereBelegungen: skLeereBelegungen,
  loeschePlan: skLoeschePlan,
  authentifiziereAlsAdmin: skAuthentifiziereAlsAdmin,
  zeitLabel: skZeitLabel,
  zeitLabelLang: skZeitLabelLang,
  datumLabel: skDatumLabel,
  heuteIso: skHeuteIso,
  datumPlus: skDatumPlus,
  getGespeicherterName: () => {
    try {
      return localStorage.getItem(SK_NAME_KEY) || localStorage.getItem("agelan_spieler_name") || "";
    } catch (e) {
      return "";
    }
  },
};
