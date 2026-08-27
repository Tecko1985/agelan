// ===========================================================================
// turnier-service.js – Firebase-Kapsel & komplette Turnierlogik für AgeLan.
//
// app.js redet ausschließlich über die turnierService-API (unten) und nie direkt
// mit Firebase. getZustand() liefert einen fertig aufbereiteten UI-Zustand
// (inkl. berechneter Gruppentabellen und K.o.-Bracket); onZustandsAenderung()
// meldet jede Live-Änderung.
//
// Datenmodell (Realtime Database, je Turnier ein Knoten unter turniere/<id>):
//   meta    : { name, erstelltAm, hostId, adminPin, phase, bestOf,
//               anzahlGruppen, weiterProGruppe, punkteSieg, siegerTeamId }
//   spieler/$uid  : { name, rating, beigetretenAm }
//   teams/$teamId : { name, ratingSchnitt, mitglieder:{uid:true}, gruppe }
//   gruppen/$gid  : { name, teamIds:{teamId:true} }
//   spiele/$sid   : { phase:"gruppe"|"ko", gruppe?, runde?, position?,
//                     teamA, teamB, saetzeA, saetzeB, status, gemeldetVon }
//
// Phasen: anmeldung -> teams -> gruppen -> ko -> beendet
//
// MEHRERE TURNIERE NEBENEINANDER: jedes Turnier hat einen eigenen Knoten
// turniere/<id>. Die Firebase-Regeln erlauben Lesen nur auf einem KONKRETEN
// turniere/$tid, nicht auf der Sammlung – ein Client kann die vorhandenen
// Turniere also nicht auflisten. Deshalb führt turniere/_index die Liste der
// IDs. Dieser Knoten fällt unter dieselbe $tid-Regel (.read: true,
// .write: auth != null) und braucht KEINE neue Regel in der Firebase-Konsole.
// ===========================================================================

const INDEX_PFAD = "turniere/_index";
const ERSTES_TURNIER_ID = "aktuell";   // Altbestand: das erste Turnier lag fest hier
const TURNIER_ID_KEY = "agelan_turnier_id";

let turnierId = null;                  // aktuell geöffnetes Turnier (null = Auswahl)
function turnierBasis() { return "turniere/" + turnierId; }

const RATING_MIN = 500;
const RATING_MAX = 3000;
const RATING_DEFAULT = 1500;

const ADMIN_PIN_KEY = "agelan_admin_pin";
const NAME_KEY = "agelan_spieler_name";

const SPIELER_FARBEN = ["#1a56a0", "#057a55", "#c9941f", "#9333ea", "#dc2626", "#0891b2", "#db2777", "#ea580c"];

// --- lokaler Zustand -------------------------------------------------------
let eigeneUid = null;
let letzterZustand = null;   // roher meta/spieler/teams/gruppen/spiele-Snapshot
let listener = null;
let turnierRef = null;
let turnierCb = null;        // Callback des Haupt-Listeners – zum gezielten Abhängen

// Turnierliste
let indexRoh = {};           // { id: { name, erstelltAm } } aus turniere/_index
let indexGeladen = false;
let uebersicht = {};         // { id: roher Baum }  – undefined = noch nicht geladen
let uebersichtRefs = {};     // { id: { ref, cb } } – zum gezielten Abhängen

const istMock = !!window.__AGELAN_MOCK__;

const authBereit = new Promise((resolve) => {
  auth.onAuthStateChanged((user) => {
    if (user) {
      eigeneUid = user.uid;
      resolve(user.uid);
    }
  });
});
auth.signInAnonymously().catch((err) => console.error("Anonyme Anmeldung fehlgeschlagen:", err));

// --- kleine Helfer ---------------------------------------------------------
function mischeArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function noetigeSaetze(bestOf) {
  return Math.ceil((bestOf || 3) / 2); // best-of-3 -> 2, best-of-5 -> 3
}

function gruppenName(index) {
  return String.fromCharCode(65 + index); // 0->A, 1->B, ...
}

function naechsteZweierpotenz(n) {
  let p = 1;
  while (p < n) p *= 2;
  return Math.max(p, 1);
}

// Standard-Bracket-Seed-Reihenfolge für n (Zweierpotenz).
// n=4 -> [1,4,2,3] (Paare (1,4)(2,3)); n=8 -> [1,8,4,5,2,7,3,6] usw.
function bracketSeedReihenfolge(n) {
  let pls = [1, 2];
  while (pls.length < n) {
    const summe = pls.length * 2 + 1;
    const out = [];
    for (const p of pls) {
      out.push(p);
      out.push(summe - p);
    }
    pls = out;
  }
  return pls;
}

function rundenTitel(anzahlMatches) {
  if (anzahlMatches === 1) return "Finale";
  if (anzahlMatches === 2) return "Halbfinale";
  if (anzahlMatches === 4) return "Viertelfinale";
  if (anzahlMatches === 8) return "Achtelfinale";
  if (anzahlMatches === 16) return "Sechzehntelfinale";
  return anzahlMatches * 2 + "er-Runde";
}

// --- Turnierform & Ablauf --------------------------------------------------
// teamGroesse 1 = Einzel (jede:r spielt für sich), 2 = 2er-Teams.
// ablauf: gruppen_ko (Gruppen, dann K.-o.) | nur_ko | nur_gruppen (eine Tabelle).
// Alte Turniere haben die Felder nicht – Standard ist das bisherige Verhalten.
const ABLAUF_ARTEN = ["gruppen_ko", "nur_ko", "nur_gruppen", "schweizer", "schweizer_ko"];
const TIEBREAK_ARTEN = ["satzdifferenz", "direktes_duell", "buchholz", "buchholz_cut1", "sonneborn"];

function metaTeamGroesse(meta) {
  const g = Math.round(Number(meta && meta.teamGroesse));
  return [1, 2, 3, 4].indexOf(g) !== -1 ? g : 2;
}
function metaAblauf(meta) {
  const a = meta && meta.ablauf;
  return ABLAUF_ARTEN.indexOf(a) !== -1 ? a : "gruppen_ko";
}
// Läuft vor der K.-o.-Runde eine Tabellenphase (Gruppen, Round Robin, Schweizer)?
function hatVorrunde(meta) {
  return metaAblauf(meta) !== "nur_ko";
}
function istSchweizer(meta) {
  const a = metaAblauf(meta);
  return a === "schweizer" || a === "schweizer_ko";
}
// Endet das Turnier mit einer K.-o.-Runde oder mit der Tabelle?
function hatKoRunde(meta) {
  const a = metaAblauf(meta);
  return a === "gruppen_ko" || a === "nur_ko" || a === "schweizer_ko";
}
function metaTiebreak(meta) {
  const t = meta && meta.tiebreak;
  if (TIEBREAK_ARTEN.indexOf(t) !== -1) return t;
  return istSchweizer(meta) ? "buchholz" : "satzdifferenz";
}
// Einfaches K.-o. (eine Niederlage raus) oder Doppel-K.-o. (Verliererbaum:
// erst nach der zweiten Niederlage raus).
function metaKoTyp(meta) {
  return (meta && meta.koTyp) === "doppel" ? "doppel" : "einfach";
}
function metaPunkteSieg(meta) {
  const p = Math.round(Number(meta && meta.punkteSieg));
  return Number.isFinite(p) && p >= 1 && p <= 5 ? p : 3;
}
// Best-of des Finales kann vom Rest abweichen ("Finale Best of 5").
function bestOfFuer(spiel, meta) {
  const standard = meta.bestOf || 3;
  if (!spiel || spiel.phase !== "ko" || spiel.platz3) return standard;
  const finale = Number(meta.bestOfFinale);
  if (![3, 5, 7].includes(finale)) return standard;
  // Finale = letzte Runde des Brackets. Ohne Kenntnis der Rundenzahl reicht der
  // Marker, den die Progression beim Anlegen setzt.
  return spiel.istFinale ? finale : standard;
}

// --- Admin-Status ----------------------------------------------------------
// Jedes Turnier hat einen eigenen PIN, also auch einen eigenen Speicherplatz
// (agelan_admin_pin_<id>). Der alte Schlüssel agelan_admin_pin wird weiter
// mitgeschrieben und mitgeprüft: der Streamkalender liest genau diesen.
function adminPinKey(id) {
  return ADMIN_PIN_KEY + "_" + (id || turnierId);
}

function merkeAdminPin(id, pin) {
  try {
    localStorage.setItem(adminPinKey(id), pin);
    localStorage.setItem(ADMIN_PIN_KEY, pin);
  } catch (e) {}
}

// Beide Speicherplätze zurückgeben, nicht nur den ersten gefundenen: sonst
// verdeckt ein veralteter turnierspezifischer Wert einen gültigen alten.
function gespeichertePins(id) {
  const out = [];
  try {
    const a = localStorage.getItem(adminPinKey(id));
    if (a) out.push(a);
    const b = localStorage.getItem(ADMIN_PIN_KEY);
    if (b) out.push(b);
  } catch (e) {}
  return out;
}

// Veranstalter EINES bestimmten Turniers – auch für Turniere, die gerade nicht
// geöffnet sind (Löschknopf auf der Kachel).
function istVeranstalterVon(id, meta) {
  if (!meta) return false;
  if (meta.hostId && meta.hostId === eigeneUid) return true;
  if (!meta.adminPin) return false;
  return gespeichertePins(id).indexOf(meta.adminPin) !== -1;
}

function istAdmin() {
  if (!letzterZustand || !letzterZustand.meta) return false;
  return istVeranstalterVon(turnierId, letzterZustand.meta);
}

// ===========================================================================
// Zustands-Aufbereitung für die UI
// ===========================================================================
function spielerListe() {
  const roh = (letzterZustand && letzterZustand.spieler) || {};
  return Object.keys(roh)
    .map((uid) => ({ id: uid, ...roh[uid] }))
    .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (a.beigetretenAm || 0) - (b.beigetretenAm || 0));
}

function teamListe() {
  const roh = (letzterZustand && letzterZustand.teams) || {};
  return Object.keys(roh).map((tid) => ({
    id: tid,
    ...roh[tid],
    seed: Number.isFinite(Number(roh[tid].seed)) ? Number(roh[tid].seed) : null,
    mitgliederUids: Object.keys(roh[tid].mitglieder || {}),
  }));
}

function spielListe() {
  const roh = (letzterZustand && letzterZustand.spiele) || {};
  return Object.keys(roh).map((sid) => ({ id: sid, ...roh[sid] }));
}

function findeEigenesTeam() {
  if (!eigeneUid) return null;
  return teamListe().find((t) => (t.mitglieder || {})[eigeneUid]) || null;
}

function teamAnzeigename(teamId, teams) {
  const t = teams.find((x) => x.id === teamId);
  return t ? t.name : "?";
}

// Gruppentabelle aus den bestätigten Gruppenspielen einer Gruppe berechnen.
function berechneTabelle(gruppenTeamIds, teams, spiele, meta) {
  const punkteSieg = metaPunkteSieg(meta);
  const zeilen = {};
  gruppenTeamIds.forEach((tid) => {
    zeilen[tid] = {
      teamId: tid,
      name: teamAnzeigename(tid, teams),
      spiele: 0, siege: 0, niederlagen: 0,
      saetzePlus: 0, saetzeMinus: 0, punkte: 0,
      buchholz: 0, buchholzCut1: 0, sonneborn: 0, freilose: 0,
      gegner: [], besiegte: [],
    };
  });

  const bestaetigte = spiele.filter(
    (s) => s.phase === "gruppe" && s.status === "bestaetigt" && zeilen[s.teamA]
  );

  bestaetigte.forEach((s) => {
    const a = zeilen[s.teamA];
    // Freilos im Schweizer System: zählt als Sieg, hat aber keinen Gegner und
    // darf deshalb weder in die Buchholz-Summe noch in ein direktes Duell.
    if (!s.teamB || !zeilen[s.teamB]) {
      if (!s.teamB) {
        a.spiele++; a.siege++; a.freilose++;
        a.punkte += punkteSieg;
        a.saetzePlus += Number(s.saetzeA) || 0;
      }
      return;
    }
    const b = zeilen[s.teamB];
    a.spiele++; b.spiele++;
    a.gegner.push(s.teamB); b.gegner.push(s.teamA);
    a.saetzePlus += s.saetzeA; a.saetzeMinus += s.saetzeB;
    b.saetzePlus += s.saetzeB; b.saetzeMinus += s.saetzeA;
    if (s.saetzeA > s.saetzeB) { a.siege++; a.punkte += punkteSieg; a.besiegte.push(s.teamB); b.niederlagen++; }
    else { b.siege++; b.punkte += punkteSieg; b.besiegte.push(s.teamA); a.niederlagen++; }
  });

  // Buchholz: Summe der Punkte aller Gegner, die man wirklich gespielt hat.
  // Zwingend ein ZWEITER Durchlauf – vorher stehen die Gegnerpunkte nicht fest.
  const punkteVon = (gid) => (zeilen[gid] ? zeilen[gid].punkte : 0);
  Object.values(zeilen).forEach((z) => {
    const gegnerPunkte = z.gegner.map(punkteVon);
    z.buchholz = gegnerPunkte.reduce((summe, p) => summe + p, 0);
    // Buchholz gestrichen: der schwächste Gegner fällt raus. Dämpft, dass ein
    // einziger sehr schwacher Gegner die ganze Wertung nach unten zieht.
    z.buchholzCut1 = gegnerPunkte.length
      ? z.buchholz - Math.min(...gegnerPunkte)
      : 0;
    // Sonneborn-Berger: nur die Punkte der wirklich BESIEGTEN Gegner.
    z.sonneborn = z.besiegte.reduce((summe, gid) => summe + punkteVon(gid), 0);
  });

  // ALLE Begegnungen der beiden zusammenzaehlen, nicht nur die erste: bei Hin-
  // und Rueckrunde entschiede sonst allein das Hinspiel.
  const direktesDuell = (x, y) => {
    let xSaetze = 0, ySaetze = 0;
    bestaetigte.forEach((m) => {
      if (m.teamA === x && m.teamB === y) { xSaetze += m.saetzeA; ySaetze += m.saetzeB; }
      else if (m.teamA === y && m.teamB === x) { xSaetze += m.saetzeB; ySaetze += m.saetzeA; }
    });
    return ySaetze - xSaetze; // >0 wenn y besser -> x weiter unten
  };

  const satzWeg = (a, b) => {
    const dA = a.saetzePlus - a.saetzeMinus, dB = b.saetzePlus - b.saetzeMinus;
    if (dB !== dA) return dB - dA;
    if (b.saetzePlus !== a.saetzePlus) return b.saetzePlus - a.saetzePlus;
    return 0;
  };

  // Reihenfolge der Kriterien nach der eingestellten Wertung. Punkte stehen
  // immer vorn, der Name immer hinten (damit die Sortierung stabil bleibt).
  const tiebreak = metaTiebreak(meta);
  const feinwertung = {
    buchholz: (a, b) => b.buchholz - a.buchholz,
    buchholz_cut1: (a, b) => b.buchholzCut1 - a.buchholzCut1,
    sonneborn: (a, b) => b.sonneborn - a.sonneborn,
  }[tiebreak];
  const kriterien = feinwertung
    ? [feinwertung, satzWeg, (a, b) => direktesDuell(a.teamId, b.teamId)]
    : tiebreak === "direktes_duell"
    ? [(a, b) => direktesDuell(a.teamId, b.teamId), satzWeg]
    : [satzWeg, (a, b) => direktesDuell(a.teamId, b.teamId)];

  return Object.values(zeilen).sort((a, b) => {
    if (b.punkte !== a.punkte) return b.punkte - a.punkte;
    for (const kriterium of kriterien) {
      const wert = kriterium(a, b);
      if (wert !== 0) return wert;
    }
    return a.name.localeCompare(b.name);
  });
}

function gruppenMitTabellen(teams, spiele, meta) {
  const roh = (letzterZustand && letzterZustand.gruppen) || {};
  return Object.keys(roh)
    .map((gid) => {
      const teamIds = Object.keys(roh[gid].teamIds || {});
      const eigene = spiele.filter((s) => s.phase === "gruppe" && s.gruppe === roh[gid].name);
      // Schweizer System spielt in Runden – für die Anzeige nach Runde bündeln.
      const rundenNummern = [...new Set(eigene.map((s) => Number(s.runde) || 0))].sort((a, b) => a - b);
      return {
        id: gid,
        name: roh[gid].name,
        teamIds,
        tabelle: berechneTabelle(teamIds, teams, spiele, meta),
        spiele: eigene,
        runden: rundenNummern.map((r) => ({
          runde: r,
          spiele: eigene.filter((s) => (Number(s.runde) || 0) === r).sort((a, b) => (a.position || 0) - (b.position || 0)),
        })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// K.o.-Bracket (Runden -> Matches) für die Anzeige.
function baueBracket(teams, spiele, meta) {
  const alleKo = spiele.filter((s) => s.phase === "ko");
  if (alleKo.length === 0) return null;
  const doppel = metaKoTyp(meta) === "doppel";

  const alsMatch = (s) => ({
    id: s.id,
    teamA: s.teamA, teamB: s.teamB || null,
    teamAName: s.teamA ? teamAnzeigename(s.teamA, teams) : "\u2014",
    teamBName: s.teamB ? teamAnzeigename(s.teamB, teams) : (s.teamA ? "Freilos" : "\u2014"),
    saetzeA: s.saetzeA, saetzeB: s.saetzeB,
    status: s.status, gemeldetVon: s.gemeldetVon || null,
    siegerTeamId: s.status === "bestaetigt" ? matchSieger(s) : null,
  });

  // Durchgereichte Leerspiele (weder teamA noch teamB) wuerden als "\u2014 vs \u2014"
  // erscheinen und nur verwirren.
  const sichtbar = (liste) => liste.filter((s) => s.teamA);

  const rundenAus = (liste, benenne) => {
    const nummern = [...new Set(liste.map((s) => s.runde))].sort((a, b) => a - b);
    return nummern
      .map((r) => {
        const roh = liste.filter((s) => s.runde === r).sort((a, b) => a.position - b.position);
        return { runde: r, name: benenne(sichtbar(roh).length, r, nummern.length), matches: sichtbar(roh).map(alsMatch) };
      })
      .filter((r) => r.matches.length);
  };

  // Das Spiel um Platz 3 gehoert nicht in die Rundenfolge, sonst waere die
  // letzte Runde zweimal besetzt und hiesse "Halbfinale".
  const platz3Spiel = alleKo.find((s) => s.platz3) || null;
  const ohnePlatz3 = alleKo.filter((s) => !s.platz3);

  const gewinnerSpiele = ohnePlatz3.filter((s) => (s.bracket || "w") === "w");
  const verliererSpiele = ohnePlatz3.filter((s) => s.bracket === "l");
  const finaleSpiel = ohnePlatz3.find((s) => s.bracket === "f") || null;

  // WARNUNG: Die Gesamtzahl der Runden aus der BRACKETGROESSE rechnen, nicht aus
  // den bisher angelegten Runden - sonst hiesse die erste Runde "Gewinner-Finale",
  // solange sie die einzige ist.
  const ersteRunde = gewinnerSpiele.filter((s) => s.runde === 0).length;
  const wRunden = ersteRunde ? Math.round(Math.log2(ersteRunde * 2)) : 0;
  const lRunden = Math.max(0, 2 * wRunden - 2);

  // Im Doppel-K.-o. ist die letzte Gewinnerrunde NICHT das Finale - das grosse
  // Finale kommt erst nach dem Verliererbaum.
  const runden = rundenAus(gewinnerSpiele, (anzahl, r) =>
    doppel && r === wRunden - 1 ? "Gewinner-Finale" : rundenTitel(anzahl));
  const verliererRunden = rundenAus(verliererSpiele, (anzahl, r) =>
    r === lRunden - 1 ? "Verlierer-Finale" : "Verliererrunde " + (r + 1));

  const platz3 = platz3Spiel ? alsMatch(platz3Spiel) : null;
  const finale = finaleSpiel && finaleSpiel.teamA ? alsMatch(finaleSpiel) : null;
  return {
    runden,
    verliererRunden: doppel ? verliererRunden : [],
    finale,
    platz3,
    doppel,
    siegerTeamId: meta.siegerTeamId || null,
  };
}

function matchSieger(spiel) {
  if (!spiel.teamB) return spiel.teamA; // Freilos
  if (spiel.saetzeA == null || spiel.saetzeB == null) return null;
  return spiel.saetzeA > spiel.saetzeB ? spiel.teamA : spiel.teamB;
}

function getZustand() {
  const vorhanden = !!(letzterZustand && letzterZustand.meta);
  const meta = vorhanden ? letzterZustand.meta : {};
  const teams = teamListe();
  const spiele = spielListe();
  const eigenesTeam = findeEigenesTeam();
  const spieler = spielerListe();

  return {
    eigeneUid,
    istMock,
    turnierId,
    liste: getListe(),
    listeGeladen: indexGeladen,
    teamGroesse: metaTeamGroesse(meta),
    ablauf: metaAblauf(meta),
    istSchweizer: istSchweizer(meta),
    hatKoRunde: hatKoRunde(meta),
    hatVorrunde: hatVorrunde(meta),
    tiebreak: metaTiebreak(meta),
    koTyp: metaKoTyp(meta),
    punkteSieg: metaPunkteSieg(meta),
    schweizerRunden: Number(meta.schweizerRunden) || 0,
    schweizerGespielt: vorhanden && istSchweizer(meta) ? schweizerGespielteRunden(spiele) : 0,
    vorhanden,
    phase: vorhanden ? meta.phase : null,
    meta,
    istAdmin: istAdmin(),
    spieler,
    eigenerSpieler: spieler.find((s) => s.id === eigeneUid) || null,
    teams,
    setzliste: setzlisteReihenfolge(teams),
    eigenesTeam,
    gruppen: gruppenMitTabellen(teams, spiele, meta),
    spiele,
    offeneSpieleAnzahl: simulierbareSpiele().length,
    bracket: baueBracket(teams, spiele, meta),
  };
}

function benachrichtige() {
  if (listener) listener(getZustand());
}

// ===========================================================================
// Turnierliste: welche Turniere gibt es, und was ist gerade ihr Stand?
// ===========================================================================
function neueTurnierId() {
  // Kein push() – firebase-mock.js kennt es nicht. Zeit + Zufall reicht hier
  // vollkommen: Turniere werden von Hand angelegt, nicht im Sekundentakt.
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Ein Eintrag steht im Index, aber unter turniere/<id> liegt nichts mehr:
// wird nicht angezeigt. undefined = noch nicht geladen, null = wirklich weg.
function getListe() {
  return Object.keys(indexRoh)
    .filter((id) => !(id in uebersicht) || (uebersicht[id] && uebersicht[id].meta))
    .map((id) => {
      const baum = uebersicht[id];
      const meta = (baum && baum.meta) || null;
      const eintrag = indexRoh[id] || {};
      return {
        id,
        name: (meta && meta.name) || eintrag.name || "Turnier",
        phase: meta ? meta.phase : null,
        geladen: id in uebersicht,
        teamGroesse: metaTeamGroesse(meta),
        ablauf: metaAblauf(meta),
        koTyp: metaKoTyp(meta),
        spielerAnzahl: baum && baum.spieler ? Object.keys(baum.spieler).length : 0,
        erstelltAm: (meta && meta.erstelltAm) || eintrag.erstelltAm || 0,
        binIchDrin: !!(baum && baum.spieler && eigeneUid && baum.spieler[eigeneUid]),
        binIchVeranstalter: istVeranstalterVon(id, meta),
        istOffen: !meta || meta.phase === "anmeldung",
      };
    })
    .sort((a, b) => (a.erstelltAm || 0) - (b.erstelltAm || 0));
}

function synchronisiereUebersicht() {
  Object.keys(indexRoh).forEach((id) => {
    if (uebersichtRefs[id]) return;
    const ref = db.ref("turniere/" + id);
    const cb = ref.on("value", (snap) => {
      uebersicht[id] = snap.val();
      benachrichtige();
    });
    uebersichtRefs[id] = { ref, cb };
  });
  Object.keys(uebersichtRefs).forEach((id) => {
    if (indexRoh[id]) return;
    // Mit Callback abhängen: der Haupt-Listener liegt auf demselben Pfad und
    // würde von einem off("value") ohne Callback mit abgeräumt.
    uebersichtRefs[id].ref.off("value", uebersichtRefs[id].cb);
    delete uebersichtRefs[id];
    delete uebersicht[id];
  });
}

// Das erste Turnier lag fest unter turniere/aktuell und kannte den Index noch
// nicht. Steht es da, ohne im Index zu stehen, wird es einmalig nachgetragen.
async function heileIndex() {
  const vorhandenerIndex = await db.ref(INDEX_PFAD).once("value");
  if (vorhandenerIndex.val()) return;
  const alt = await db.ref("turniere/" + ERSTES_TURNIER_ID + "/meta").once("value");
  const meta = alt.val();
  if (!meta) return;
  await db.ref(INDEX_PFAD + "/" + ERSTES_TURNIER_ID).set({
    name: meta.name || "Turnier",
    erstelltAm: meta.erstelltAm || 0,
  });
}

function gespeicherteTurnierId() {
  try { return localStorage.getItem(TURNIER_ID_KEY); } catch (e) { return null; }
}

// Turnier öffnen (id) oder zurück zur Auswahl (null).
function waehleTurnier(id) {
  const neu = id || null;
  if (neu === turnierId) return;
  if (turnierRef && turnierCb) turnierRef.off("value", turnierCb);
  turnierRef = null;
  turnierCb = null;
  letzterZustand = null;
  turnierId = neu;
  try {
    if (turnierId) localStorage.setItem(TURNIER_ID_KEY, turnierId);
    else localStorage.removeItem(TURNIER_ID_KEY);
  } catch (e) {}
  if (turnierId) {
    turnierRef = db.ref(turnierBasis());
    turnierCb = turnierRef.on("value", (snap) => {
      letzterZustand = snap.val();
      benachrichtige();
    });
  }
  benachrichtige();
}

function onZustandsAenderung(callback) {
  listener = callback;
  authBereit.then(async () => {
    try { await heileIndex(); } catch (e) { console.error("Index-Abgleich fehlgeschlagen:", e); }
    db.ref(INDEX_PFAD).on("value", (snap) => {
      indexRoh = snap.val() || {};
      indexGeladen = true;
      synchronisiereUebersicht();
      // Gemerktes Turnier gelöscht? Dann zurück in die Auswahl, statt auf einem
      // leeren Screen zu landen.
      if (turnierId && !indexRoh[turnierId]) waehleTurnier(null);
      else benachrichtige();
    });
    const gemerkt = gespeicherteTurnierId();
    if (gemerkt) waehleTurnier(gemerkt);
    else benachrichtige();
  });
}

// ===========================================================================
// Aktionen
// ===========================================================================

// --- Turnier anlegen (Admin) ----------------------------------------------
// Legt IMMER ein zusätzliches Turnier an – mehrere laufen nebeneinander.
async function erstelleTurnier({ name, adminPin, teamGroesse, ablauf }) {
  await authBereit;
  if (!name || !name.trim()) return { erfolg: false, fehler: "Bitte einen Turniernamen eingeben." };
  if (!adminPin || !String(adminPin).trim()) return { erfolg: false, fehler: "Bitte einen Admin-PIN festlegen." };
  const pin = String(adminPin).trim();
  const id = neueTurnierId();
  // Modus (Best-of), Gruppen-Anzahl und Weiterkommende werden erst beim Auslosen
  // festgelegt – dann steht die Teilnehmerzahl fest. Hier nur Platzhalter-Defaults.
  // Turnierform und Ablauf dagegen jetzt: sie sagen, worauf man sich einschreibt.
  await db.ref("turniere/" + id + "/meta").set({
    name: name.trim(),
    erstelltAm: firebase.database.ServerValue.TIMESTAMP,
    hostId: eigeneUid,
    adminPin: pin,
    phase: "anmeldung",
    teamGroesse: metaTeamGroesse({ teamGroesse }),
    ablauf: metaAblauf({ ablauf }),
    bestOf: 3,
    anzahlGruppen: 2,
    weiterProGruppe: 2,
    punkteSieg: 3,
    siegerTeamId: null,
  });
  // Erst danach in den Index: ein Eintrag ohne Baum wäre eine tote Kachel.
  await db.ref(INDEX_PFAD + "/" + id).set({
    name: name.trim(),
    erstelltAm: firebase.database.ServerValue.TIMESTAMP,
  });
  merkeAdminPin(id, pin);
  waehleTurnier(id);
  return { erfolg: true, id };
}

// --- Turnierform & Ablauf ändern (Admin, nur während der Anmeldung) -------
// Danach hängen Teams, Gruppen und Spiele daran – ein Wechsel würde sie
// ungültig machen. Wer trotzdem umstellen will, setzt vorher zurück.
async function setzeTurnierform({ teamGroesse, ablauf }) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "anmeldung") {
    return { erfolg: false, fehler: "Geht nur während der Anmeldung – setze das Turnier vorher zurück." };
  }
  await db.ref(turnierBasis() + "/meta").update({
    teamGroesse: metaTeamGroesse({ teamGroesse }),
    ablauf: metaAblauf({ ablauf }),
  });
  return { erfolg: true };
}

// --- als Admin auf einem weiteren Gerät anmelden --------------------------
function authentifiziereAlsAdmin(pin) {
  if (!letzterZustand || !letzterZustand.meta) return { erfolg: false, fehler: "Kein Turnier vorhanden." };
  if (String(pin).trim() !== letzterZustand.meta.adminPin) {
    return { erfolg: false, fehler: "Falscher PIN." };
  }
  merkeAdminPin(turnierId, String(pin).trim());
  benachrichtige();
  return { erfolg: true };
}

// --- Spieler-Login / Rating -----------------------------------------------
async function tritBei({ name, rating }) {
  await authBereit;
  if (!letzterZustand || !letzterZustand.meta) return { erfolg: false, fehler: "Kein Turnier vorhanden." };
  if (letzterZustand.meta.phase !== "anmeldung") return { erfolg: false, fehler: "Die Anmeldung ist bereits geschlossen." };
  if (!name || !name.trim()) return { erfolg: false, fehler: "Bitte einen Namen eingeben." };
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < RATING_MIN || r > RATING_MAX) {
    return { erfolg: false, fehler: `Rating muss zwischen ${RATING_MIN} und ${RATING_MAX} liegen.` };
  }
  await db.ref(turnierBasis() + "/spieler/" + eigeneUid).set({
    name: name.trim(),
    rating: r,
    beigetretenAm: firebase.database.ServerValue.TIMESTAMP,
  });
  try { localStorage.setItem(NAME_KEY, name.trim()); } catch (e) {}
  return { erfolg: true };
}

async function aktualisiereRating(rating) {
  await authBereit;
  if (!letzterZustand || !letzterZustand.meta || letzterZustand.meta.phase !== "anmeldung") {
    return { erfolg: false, fehler: "Änderung nicht mehr möglich." };
  }
  if (!letzterZustand.spieler || !letzterZustand.spieler[eigeneUid]) {
    return { erfolg: false, fehler: "Du bist nicht angemeldet." };
  }
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < RATING_MIN || r > RATING_MAX) {
    return { erfolg: false, fehler: `Rating muss zwischen ${RATING_MIN} und ${RATING_MAX} liegen.` };
  }
  await db.ref(turnierBasis() + "/spieler/" + eigeneUid + "/rating").set(r);
  return { erfolg: true };
}

async function meldeAb() {
  await authBereit;
  if (!letzterZustand || !letzterZustand.meta || letzterZustand.meta.phase !== "anmeldung") {
    return { erfolg: false, fehler: "Abmelden nicht mehr möglich." };
  }
  await db.ref(turnierBasis() + "/spieler/" + eigeneUid).remove();
  return { erfolg: true };
}

// --- Teams bilden (Admin) --------------------------------------------------
// Balanced-Pairing: sortiert nach Rating, paart Bester+Schlechtester. Bei
// ungerader Zahl bekommt das schwächste Paar einen dritten Spieler (3er-Team).
// Ratingfaire Teams beliebiger Groesse per Schlangen-Zug: nach Rating sortiert,
// dann abwechselnd vorwaerts und rueckwaerts auf die Teams verteilt. Bei zwei
// Personen je Team kommt genau das alte "Bester + Schlechtester" heraus.
// ⚠️ Uebrige Spieler:innen gehen an das JEWEILS SCHWAECHSTE Team, nicht an das
// naechste in der Reihe – sonst bekaeme ausgerechnet das staerkste Team noch
// eine Person dazu.
function balancedGruppen(spieler, groesse) {
  const k = Math.max(1, Math.min(4, Math.round(groesse) || 2));
  const sortiert = [...spieler].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const anzahlTeams = Math.max(1, Math.floor(sortiert.length / k));
  const teams = Array.from({ length: anzahlTeams }, () => []);

  const verteilbar = anzahlTeams * k;
  for (let i = 0; i < verteilbar; i++) {
    const runde = Math.floor(i / anzahlTeams);
    const pos = i % anzahlTeams;
    const idx = runde % 2 === 0 ? pos : anzahlTeams - 1 - pos;
    teams[idx].push(sortiert[i]);
  }
  const summe = (t) => t.reduce((s, sp) => s + (sp.rating || 0), 0);
  for (let i = verteilbar; i < sortiert.length; i++) {
    let minIdx = 0, minSumme = Infinity;
    teams.forEach((t, idx) => { const w = summe(t); if (w < minSumme) { minSumme = w; minIdx = idx; } });
    teams[minIdx].push(sortiert[i]);
  }
  return teams;
}

function paareZuTeamsObjekt(paare) {
  const teams = {};
  paare.forEach((paar, idx) => {
    const mitglieder = {};
    paar.forEach((sp) => (mitglieder[sp.id] = true));
    const schnitt = Math.round(paar.reduce((s, sp) => s + (sp.rating || 0), 0) / paar.length);
    teams["team_" + idx] = {
      name: paar.map((sp) => sp.name).join(" & "),
      ratingSchnitt: schnitt,
      mitglieder,
      gruppe: null,
    };
  });
  return teams;
}

// Einzelturnier: jede:r ist eine eigene "Mannschaft" von einer Person. Damit
// laufen Auslosung, Tabellen und Bracket unverändert weiter – die ganze Logik
// darunter rechnet ohnehin mit Teams, nicht mit Spielern.
function einzelTeamsObjekt(spieler) {
  const teams = {};
  spieler
    .slice()
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .forEach((sp, idx) => {
      teams["team_" + idx] = {
        name: sp.name,
        ratingSchnitt: Number(sp.rating) || 0,
        mitglieder: { [sp.id]: true },
        gruppe: null,
      };
    });
  return teams;
}

async function bildeTeams() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter kann Teams bilden." };
  const meta = letzterZustand.meta;
  if (!["anmeldung", "teams"].includes(meta.phase)) return { erfolg: false, fehler: "Falsche Phase." };
  const spieler = spielerListe();
  const groesse = metaTeamGroesse(meta);
  const einzel = groesse === 1;
  const mindestens = groesse * 2; // es braucht mindestens zwei Teams
  if (spieler.length < mindestens) {
    return {
      erfolg: false,
      fehler: einzel
        ? "Mindestens 2 Angemeldete nötig."
        : `Mindestens ${mindestens} Spieler nötig (für 2 Teams à ${groesse}).`,
    };
  }

  const teams = einzel ? einzelTeamsObjekt(spieler) : paareZuTeamsObjekt(balancedGruppen(spieler, groesse));
  await db.ref(turnierBasis()).update({
    teams: teams,
    "meta/phase": "teams",
  });
  return { erfolg: true };
}

// --- Setzliste ------------------------------------------------------------
// Ohne Handarbeit ist die Setzliste schlicht die Rating-Reihenfolge. Sobald der
// Veranstalter einmal verschoben hat, tragen ALLE Teams ein seed-Feld, und das
// schlaegt danach das Rating – auch beim Auslosen.
function setzlisteReihenfolge(teams) {
  const alleMitSeed = teams.length > 0 && teams.every((t) => t.seed !== null);
  return teams.slice().sort((a, b) => {
    if (alleMitSeed) return a.seed - b.seed;
    return (b.ratingSchnitt || 0) - (a.ratingSchnitt || 0);
  });
}

// Ein Team in der Setzliste um eine Position nach oben oder unten schieben.
async function verschiebeInSetzliste(teamId, richtung) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (letzterZustand.meta.phase !== "teams") {
    return { erfolg: false, fehler: "Die Setzliste lässt sich nur vor dem Auslosen ändern." };
  }
  const liste = setzlisteReihenfolge(teamListe());
  const von = liste.findIndex((t) => t.id === teamId);
  const nach = von + (richtung < 0 ? -1 : 1);
  if (von === -1 || nach < 0 || nach >= liste.length) return { erfolg: false };
  const getauscht = liste.slice();
  [getauscht[von], getauscht[nach]] = [getauscht[nach], getauscht[von]];
  // Immer die GANZE Liste neu durchnummerieren: einzelne seeds zu setzen würde
  // Lücken und Doppelungen hinterlassen, sobald mehrfach verschoben wird.
  const updates = {};
  getauscht.forEach((t, i) => { updates["teams/" + t.id + "/seed"] = i; });
  updates["meta/setzlisteManuell"] = true;
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true };
}

// Zurueck auf die Rating-Reihenfolge.
async function setzlisteZuruecksetzen() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (letzterZustand.meta.phase !== "teams") {
    return { erfolg: false, fehler: "Die Setzliste lässt sich nur vor dem Auslosen ändern." };
  }
  const updates = {};
  teamListe().forEach((t) => { updates["teams/" + t.id + "/seed"] = null; });
  updates["meta/setzlisteManuell"] = false;
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true };
}

// Zwei Spieler zwischen ihren Teams tauschen (Admin, Phase "teams").
async function tauscheSpieler(uidA, uidB) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (letzterZustand.meta.phase !== "teams") return { erfolg: false, fehler: "Nur in der Team-Phase möglich." };
  if (metaTeamGroesse(letzterZustand.meta) === 1) {
    return { erfolg: false, fehler: "Im Einzelturnier gibt es keine Teams zum Tauschen." };
  }
  if (uidA === uidB) return { erfolg: false };
  const teams = teamListe();
  const teamA = teams.find((t) => (t.mitglieder || {})[uidA]);
  const teamB = teams.find((t) => (t.mitglieder || {})[uidB]);
  if (!teamA || !teamB || teamA.id === teamB.id) return { erfolg: false, fehler: "Spieler nicht in verschiedenen Teams." };

  const spieler = spielerListe();
  const rating = (uid) => (spieler.find((s) => s.id === uid) || {}).rating || 0;
  const name = (uid) => (spieler.find((s) => s.id === uid) || {}).name || "?";

  const neuA = { ...(teamA.mitglieder || {}) }; delete neuA[uidA]; neuA[uidB] = true;
  const neuB = { ...(teamB.mitglieder || {}) }; delete neuB[uidB]; neuB[uidA] = true;
  const nameVon = (mit) => Object.keys(mit).map(name).join(" & ");
  const schnittVon = (mit) => Math.round(Object.keys(mit).reduce((s, u) => s + rating(u), 0) / Object.keys(mit).length);

  await db.ref(turnierBasis()).update({
    [`teams/${teamA.id}/mitglieder`]: neuA,
    [`teams/${teamA.id}/name`]: nameVon(neuA),
    [`teams/${teamA.id}/ratingSchnitt`]: schnittVon(neuA),
    [`teams/${teamB.id}/mitglieder`]: neuB,
    [`teams/${teamB.id}/name`]: nameVon(neuB),
    [`teams/${teamB.id}/ratingSchnitt`]: schnittVon(neuB),
  });
  return { erfolg: true };
}

// --- Gruppen auslosen (Admin) ---------------------------------------------
// Rein zufällige Verteilung (Schlangensystem, gleichmäßige Gruppengrößen).
function verteileZufaellig(teams, anzahlGruppen) {
  const gemischt = mischeArray(teams.map((t) => t.id));
  const buckets = Array.from({ length: anzahlGruppen }, () => []);
  gemischt.forEach((tid, i) => buckets[i % anzahlGruppen].push(tid));
  return buckets;
}

// Setzliste/Töpfe: Teams nach ratingSchnitt in Töpfe zu je `anzahlGruppen` Teams
// teilen; jeder Topf wird gemischt und über die Gruppen verteilt (ein Team pro
// Gruppe je Topf). So landen die stärksten Teams garantiert in verschiedenen
// Gruppen (WM-Prinzip) – ausgewogenere Gruppen bei erhaltenem Losglück.
function verteileNachToepfen(teams, anzahlGruppen) {
  // Reihenfolge der Setzliste (von Hand oder nach Rating), nicht stur das Rating.
  const sortiert = setzlisteReihenfolge(teams);
  const buckets = Array.from({ length: anzahlGruppen }, () => []);
  for (let start = 0; start < sortiert.length; start += anzahlGruppen) {
    const topf = mischeArray(sortiert.slice(start, start + anzahlGruppen));
    topf.forEach((team, i) => buckets[i].push(team.id));
  }
  return buckets;
}

// Einstieg für den Auslosungs-Knopf: je nach Ablauf Gruppen oder direkt Bracket.
async function loseTurnier(optionen) {
  const meta = letzterZustand && letzterZustand.meta;
  if (!meta) return { erfolg: false, fehler: "Kein Turnier vorhanden." };
  if (metaAblauf(meta) === "nur_ko") return loseKoDirekt(optionen);
  if (istSchweizer(meta)) return starteSchweizer(optionen);
  return loseGruppen(optionen);
}

// Werte, die bei jeder Auslosungs-Art gleich aus den Optionen kommen.
function gemeinsameLosMeta(opt, meta) {
  const updates = {};
  updates["meta/bestOf"] = [3, 5, 7].includes(Number(opt.bestOf)) ? Number(opt.bestOf) : (meta.bestOf || 3);
  updates["meta/bestOfFinale"] = [3, 5, 7].includes(Number(opt.bestOfFinale)) ? Number(opt.bestOfFinale) : null;
  updates["meta/punkteSieg"] = metaPunkteSieg({ punkteSieg: opt.punkteSieg });
  updates["meta/tiebreak"] = TIEBREAK_ARTEN.indexOf(opt.tiebreak) !== -1
    ? opt.tiebreak
    : metaTiebreak(meta);
  const koTyp = hatKoRunde(meta) && opt.koTyp === "doppel" ? "doppel" : "einfach";
  updates["meta/koTyp"] = koTyp;
  // Im Doppel-K.-o. ergibt sich Platz 3 aus dem Verliererbaum – ein eigenes
  // Spiel darum waere doppelt gemoppelt.
  updates["meta/spielUmPlatz3"] = hatKoRunde(meta) && koTyp === "einfach" ? !!opt.spielUmPlatz3 : false;
  return updates;
}

async function loseGruppen(optionen) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "teams") return { erfolg: false, fehler: "Erst Teams bilden." };
  const teams = teamListe();
  if (teams.length < 2) return { erfolg: false, fehler: "Zu wenige Teilnehmer." };

  const opt = optionen || {};
  const nurGruppen = metaAblauf(meta) === "nur_gruppen";
  const doppelrunde = !!opt.doppelrunde;
  // "Jeder gegen jeden" ist genau eine Gruppe, und hervorgehoben wird nur, wer
  // sie gewinnt – es kommt ja niemand irgendwohin weiter.
  const anzahlGruppen = nurGruppen
    ? 1
    : Math.max(1, Math.min(teams.length, Number(opt.anzahlGruppen) || meta.anzahlGruppen || 2));
  const weiterProGruppe = nurGruppen
    ? 1
    : Math.max(1, Math.min(teams.length, Number(opt.weiterProGruppe) || meta.weiterProGruppe || 2));
  const modus = opt.modus === "zufaellig" ? "zufaellig" : "setzliste";
  const buckets = modus === "zufaellig"
    ? verteileZufaellig(teams, anzahlGruppen)
    : verteileNachToepfen(teams, anzahlGruppen);

  const updates = {};
  updates["gruppen"] = {};
  updates["spiele"] = {};
  buckets.forEach((teamIds, gi) => {
    const gName = gruppenName(gi);
    const gid = "gruppe_" + gName;
    const teamIdsMap = {};
    teamIds.forEach((tid) => {
      teamIdsMap[tid] = true;
      updates[`teams/${tid}/gruppe`] = gName;
    });
    updates["gruppen"][gid] = { name: gName, teamIds: teamIdsMap };
    // Round-Robin: jede Paarung genau einmal – mit Hin- und Rückrunde zweimal,
    // beim zweiten Mal mit vertauschten Seiten.
    const durchgaenge = doppelrunde ? 2 : 1;
    for (let d = 0; d < durchgaenge; d++) {
      for (let a = 0; a < teamIds.length; a++) {
        for (let b = a + 1; b < teamIds.length; b++) {
          const sid = `g_${gName}_${a}_${b}` + (d ? "_r" : "");
          updates["spiele"][sid] = {
            phase: "gruppe", gruppe: gName, runde: d,
            teamA: d ? teamIds[b] : teamIds[a],
            teamB: d ? teamIds[a] : teamIds[b],
            saetzeA: null, saetzeB: null,
            status: "offen", gemeldetVon: null,
          };
        }
      }
    }
  });
  Object.assign(updates, gemeinsameLosMeta(opt, meta));
  updates["meta/phase"] = "gruppen";
  updates["meta/anzahlGruppen"] = anzahlGruppen;
  updates["meta/weiterProGruppe"] = weiterProGruppe;
  updates["meta/doppelrunde"] = doppelrunde;
  updates["meta/schweizerRunden"] = null;
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true };
}

// ===========================================================================
// Schweizer System
// ===========================================================================
// Jede Runde spielt jede:r gegen eine:n mit möglichst gleicher Punktzahl, und
// nie zweimal gegen dieselbe Person. Nach der letzten Runde entscheidet die
// Tabelle – bei Punktgleichstand üblicherweise Buchholz (Summe der Punkte
// aller eigenen Gegner: wer die stärkeren Gegner hatte, steht vorn).
const SCHWEIZER_GRUPPE = "S";

function schweizerVorschlagRunden(anzahl) {
  if (anzahl < 2) return 1;
  return Math.max(3, Math.ceil(Math.log2(anzahl)));
}

// Wer hat schon gegen wen gespielt? Freilose zählen nicht als Begegnung.
function bisherigePaarungen(spiele) {
  const gespielt = {};
  spiele.filter((s) => s.phase === "gruppe" && s.teamA && s.teamB).forEach((s) => {
    (gespielt[s.teamA] = gespielt[s.teamA] || {})[s.teamB] = true;
    (gespielt[s.teamB] = gespielt[s.teamB] || {})[s.teamA] = true;
  });
  return gespielt;
}

// Greedy von oben nach unten: der oder die Erste bekommt den nächsten noch
// freien Gegner, gegen den noch nicht gespielt wurde. Findet sich keiner, wird
// als letztes Mittel eine Wiederholung erlaubt – lieber ein zweites Duell als
// eine Runde, die gar nicht zustande kommt.
function schweizerPaare(reihenfolge, gespielt) {
  const offen = reihenfolge.slice();
  const paare = [];
  while (offen.length > 1) {
    const a = offen.shift();
    let idx = offen.findIndex((b) => !(gespielt[a] && gespielt[a][b]));
    if (idx === -1) idx = 0;
    paare.push([a, offen[idx]]);
    offen.splice(idx, 1);
  }
  return { paare, freilos: offen.length ? offen[0] : null };
}

// Freilos an die/den Letzte:n, die/der noch keins hatte – sonst sammelt immer
// dieselbe Person die Geschenkpunkte.
function schweizerFreilosKandidat(reihenfolge, tabelle) {
  const hatteFreilos = {};
  tabelle.forEach((z) => { if (z.freilose > 0) hatteFreilos[z.teamId] = true; });
  for (let i = reihenfolge.length - 1; i >= 0; i--) {
    if (!hatteFreilos[reihenfolge[i]]) return reihenfolge[i];
  }
  return reihenfolge[reihenfolge.length - 1];
}

function schweizerRundenSpiele(runde, paare, freilos, meta) {
  const spiele = {};
  paare.forEach(([a, b], i) => {
    spiele[`s_r${runde}_p${i}`] = {
      phase: "gruppe", gruppe: SCHWEIZER_GRUPPE, runde, position: i,
      teamA: a, teamB: b,
      saetzeA: null, saetzeB: null,
      status: "offen", gemeldetVon: null,
    };
  });
  if (freilos) {
    spiele[`s_r${runde}_frei`] = {
      phase: "gruppe", gruppe: SCHWEIZER_GRUPPE, runde, position: paare.length,
      teamA: freilos, teamB: null,
      saetzeA: noetigeSaetze(meta.bestOf), saetzeB: 0,
      status: "bestaetigt", gemeldetVon: "freilos",
    };
  }
  return spiele;
}

async function starteSchweizer(optionen) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "teams") return { erfolg: false, fehler: "Erst die Teilnehmer festlegen." };
  const teams = teamListe();
  if (teams.length < 3) return { erfolg: false, fehler: "Schweizer System braucht mindestens 3 Teilnehmer." };

  const opt = optionen || {};
  const gemeinsam = gemeinsameLosMeta(opt, meta);
  const bestOf = gemeinsam["meta/bestOf"];
  const maxRunden = Math.max(1, teams.length - 1);
  const runden = Math.max(1, Math.min(maxRunden, Number(opt.schweizerRunden) || schweizerVorschlagRunden(teams.length)));
  const weiter = Math.max(2, Math.min(teams.length, Number(opt.weiterInsgesamt) || 4));

  // Runde 1: Setzliste = obere Hälfte gegen untere Hälfte (Stärkste treffen
  // erst später aufeinander), sonst reines Los.
  const sortiert = (opt.modus === "zufaellig" ? mischeArray(teams) : setzlisteReihenfolge(teams)).map((t) => t.id);
  const haelfte = Math.floor(sortiert.length / 2);
  const paare = [];
  for (let i = 0; i < haelfte; i++) paare.push([sortiert[i], sortiert[haelfte + i]]);
  const freilos = sortiert.length % 2 ? sortiert[sortiert.length - 1] : null;

  const teamIdsMap = {};
  sortiert.forEach((tid) => { teamIdsMap[tid] = true; });

  const updates = Object.assign({}, gemeinsam);
  updates["gruppen"] = { ["gruppe_" + SCHWEIZER_GRUPPE]: { name: SCHWEIZER_GRUPPE, teamIds: teamIdsMap } };
  updates["spiele"] = schweizerRundenSpiele(0, paare, freilos, { bestOf });
  updates["meta/phase"] = "gruppen";
  updates["meta/anzahlGruppen"] = 1;
  updates["meta/schweizerRunden"] = runden;
  updates["meta/weiterInsgesamt"] = weiter;
  updates["meta/weiterProGruppe"] = weiter;
  updates["meta/doppelrunde"] = false;
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true };
}

function schweizerGespielteRunden(spiele) {
  const nummern = spiele.filter((s) => s.phase === "gruppe").map((s) => Number(s.runde) || 0);
  return nummern.length ? Math.max(...nummern) + 1 : 0;
}

async function naechsteSchweizerRunde() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "gruppen" || !istSchweizer(meta)) {
    return { erfolg: false, fehler: "Kein laufendes Schweizer System." };
  }
  if (!alleGruppenspieleBestaetigt()) {
    return { erfolg: false, fehler: "Es sind noch nicht alle Spiele bestätigt." };
  }
  const spiele = spielListe();
  const gespielt = schweizerGespielteRunden(spiele);
  const gesamt = Number(meta.schweizerRunden) || 0;
  if (gespielt >= gesamt) return { erfolg: false, fehler: "Alle Runden sind gespielt." };

  const teams = teamListe();
  const gruppen = gruppenMitTabellen(teams, spiele, meta);
  const tabelle = (gruppen[0] && gruppen[0].tabelle) || [];
  if (tabelle.length < 2) return { erfolg: false, fehler: "Zu wenige Teilnehmer." };

  const reihenfolge = tabelle.map((z) => z.teamId);
  const ungerade = reihenfolge.length % 2 === 1;
  const freilos = ungerade ? schweizerFreilosKandidat(reihenfolge, tabelle) : null;
  const zuPaaren = ungerade ? reihenfolge.filter((id) => id !== freilos) : reihenfolge;
  const { paare } = schweizerPaare(zuPaaren, bisherigePaarungen(spiele));

  const neue = schweizerRundenSpiele(gespielt, paare, freilos, meta);
  const updates = {};
  Object.keys(neue).forEach((sid) => { updates["spiele/" + sid] = neue[sid]; });
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true, runde: gespielt + 1 };
}

// --- Ergebnis melden / bestätigen -----------------------------------------
function validiereSaetze(saetzeA, saetzeB, bestOf) {
  const a = Number(saetzeA), b = Number(saetzeB);
  const noetig = noetigeSaetze(bestOf);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
    return { ok: false, fehler: "Bitte gültige Satzzahlen eingeben." };
  }
  if (Math.max(a, b) !== noetig || Math.min(a, b) >= noetig) {
    return { ok: false, fehler: `Best-of-${bestOf}: Sieger braucht genau ${noetig} Sätze (z. B. ${noetig}:0 oder ${noetig}:${noetig - 1}).` };
  }
  return { ok: true, a, b };
}

function findeSpiel(spielId) {
  return spielListe().find((s) => s.id === spielId) || null;
}

function darfFuerSpiel(spiel, uid) {
  const team = findeEigenesTeam();
  if (!team) return { team: null, seiteA: false, seiteB: false };
  return {
    team,
    seiteA: spiel.teamA === team.id,
    seiteB: spiel.teamB === team.id,
  };
}

async function meldeErgebnis(spielId, saetzeA, saetzeB) {
  await authBereit;
  const spiel = findeSpiel(spielId);
  if (!spiel) return { erfolg: false, fehler: "Spiel nicht gefunden." };
  const meta = letzterZustand.meta;
  const rolle = darfFuerSpiel(spiel, eigeneUid);
  if (!rolle.seiteA && !rolle.seiteB && !istAdmin()) {
    return { erfolg: false, fehler: "Nur die beteiligten Teams dürfen melden." };
  }
  if (spiel.status === "bestaetigt") return { erfolg: false, fehler: "Ergebnis ist bereits bestätigt." };
  const v = validiereSaetze(saetzeA, saetzeB, bestOfFuer(spiel, meta));
  if (!v.ok) return { erfolg: false, fehler: v.fehler };

  const meinTeamId = rolle.team ? rolle.team.id : (istAdmin() ? "admin" : null);
  await db.ref(turnierBasis() + "/spiele/" + spielId).update({
    saetzeA: v.a, saetzeB: v.b,
    status: "gemeldet",
    gemeldetVon: meinTeamId,
  });
  return { erfolg: true };
}

async function bestaetigeErgebnis(spielId) {
  await authBereit;
  const spiel = findeSpiel(spielId);
  if (!spiel) return { erfolg: false, fehler: "Spiel nicht gefunden." };
  if (spiel.status !== "gemeldet") return { erfolg: false, fehler: "Kein gemeldetes Ergebnis." };
  const rolle = darfFuerSpiel(spiel, eigeneUid);
  const meinTeamId = rolle.team ? rolle.team.id : null;
  const istGegner = meinTeamId && meinTeamId !== spiel.gemeldetVon && (rolle.seiteA || rolle.seiteB);
  if (!istGegner && !istAdmin()) {
    return { erfolg: false, fehler: "Nur das gegnerische Team (oder der Veranstalter) bestätigt." };
  }
  await db.ref(turnierBasis() + "/spiele/" + spielId + "/status").set("bestaetigt");
  await pruefeKoProgression();
  return { erfolg: true };
}

async function widersprichErgebnis(spielId) {
  await authBereit;
  const spiel = findeSpiel(spielId);
  if (!spiel) return { erfolg: false, fehler: "Spiel nicht gefunden." };
  if (spiel.status !== "gemeldet") return { erfolg: false, fehler: "Kein gemeldetes Ergebnis." };
  const rolle = darfFuerSpiel(spiel, eigeneUid);
  if (!rolle.seiteA && !rolle.seiteB && !istAdmin()) {
    return { erfolg: false, fehler: "Nur beteiligte Teams." };
  }
  await db.ref(turnierBasis() + "/spiele/" + spielId).update({
    saetzeA: null, saetzeB: null, status: "offen", gemeldetVon: null,
  });
  return { erfolg: true };
}

// Admin überschreibt ein Ergebnis direkt (gilt sofort als bestätigt).
async function adminSetzeErgebnis(spielId, saetzeA, saetzeB) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const spiel = findeSpiel(spielId);
  if (!spiel) return { erfolg: false, fehler: "Spiel nicht gefunden." };
  const v = validiereSaetze(saetzeA, saetzeB, bestOfFuer(spiel, letzterZustand.meta));
  if (!v.ok) return { erfolg: false, fehler: v.fehler };
  await db.ref(turnierBasis() + "/spiele/" + spielId).update({
    saetzeA: v.a, saetzeB: v.b, status: "bestaetigt", gemeldetVon: "admin",
  });
  await pruefeKoProgression();
  return { erfolg: true };
}

// --- K.o.-Auslosung (Admin) -----------------------------------------------
function alleGruppenspieleBestaetigt() {
  const spiele = spielListe().filter((s) => s.phase === "gruppe");
  return spiele.length > 0 && spiele.every((s) => s.status === "bestaetigt");
}

async function starteKoAuslosung() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "gruppen") return { erfolg: false, fehler: "Erst die Gruppenphase." };
  if (!alleGruppenspieleBestaetigt()) {
    return { erfolg: false, fehler: "Es sind noch nicht alle Gruppenspiele bestätigt." };
  }
  if (istSchweizer(meta) && schweizerGespielteRunden(spielListe()) < (Number(meta.schweizerRunden) || 0)) {
    return { erfolg: false, fehler: "Es fehlen noch Runden im Schweizer System." };
  }

  const teams = teamListe();
  const spiele = spielListe();
  const gruppen = gruppenMitTabellen(teams, spiele, meta).sort((a, b) => a.name.localeCompare(b.name));

  // Qualifizierte einsammeln: platz-major (alle Platz 1, dann alle Platz 2, ...)
  // Beim Schweizer System gibt es nur eine Tabelle – dort zählt schlicht die
  // eingestellte Zahl von oben.
  const qualifizierte = [];
  if (istSchweizer(meta)) {
    const tabelle = (gruppen[0] && gruppen[0].tabelle) || [];
    const weiter = Math.min(Number(meta.weiterInsgesamt) || 4, tabelle.length);
    for (let platz = 0; platz < weiter; platz++) {
      qualifizierte.push({ teamId: tabelle[platz].teamId, gruppenIndex: 0, platz });
    }
  } else {
    const weiter = Math.min(meta.weiterProGruppe || 2, Math.max(...gruppen.map((g) => g.teamIds.length)));
    for (let platz = 0; platz < weiter; platz++) {
      gruppen.forEach((g, gi) => {
        if (g.tabelle[platz]) qualifizierte.push({ teamId: g.tabelle[platz].teamId, gruppenIndex: gi, platz });
      });
    }
  }
  if (qualifizierte.length < 2) return { erfolg: false, fehler: "Zu wenige qualifizierte Teilnehmer." };

  const ersteRunde = koErsteRunde(qualifizierte.map((q) => q.teamId));
  const updates = {};
  Object.keys(ersteRunde).forEach((sid) => { updates["spiele/" + sid] = ersteRunde[sid]; });
  updates["meta/phase"] = "ko";
  await db.ref(turnierBasis()).update(updates);
  await pruefeKoProgression(); // falls Freilose sofort die nächste Runde erlauben
  return { erfolg: true };
}

// Erste K.-o.-Runde als { spielId: spiel } – über Kreuz gesetzt, Freilose bei
// nicht-2er-Potenz. Wird von der Auslosung nach der Gruppenphase UND vom
// direkten Bracket (Ablauf "nur_ko") benutzt.
function koErsteRunde(teamIdsNachSeed) {
  const spiele = {};
  const bracketGroesse = naechsteZweierpotenz(teamIdsNachSeed.length);
  const seedReihenfolge = bracketSeedReihenfolge(bracketGroesse); // 1-basierte Seeds
  const teamFuerSeed = (seed) => (seed <= teamIdsNachSeed.length ? teamIdsNachSeed[seed - 1] : null);
  const matches = bracketGroesse / 2;
  for (let p = 0; p < matches; p++) {
    let teamA = teamFuerSeed(seedReihenfolge[p * 2]);
    let teamB = teamFuerSeed(seedReihenfolge[p * 2 + 1]);
    // Falls A ein Freilos ist, B nach vorne ziehen
    if (!teamA && teamB) { teamA = teamB; teamB = null; }
    const istFreilos = teamA && !teamB;
    spiele["ko_r0_p" + p] = {
      phase: "ko", runde: 0, position: p,
      teamA: teamA, teamB: teamB,
      saetzeA: null, saetzeB: null,
      status: istFreilos ? "bestaetigt" : "offen",
      gemeldetVon: null,
      bracket: "w",
      istFinale: matches === 1,
    };
  }
  return spiele;
}

// Ablauf "nur K.-o.": ohne Gruppenphase direkt ins Bracket, gesetzt nach Rating.
async function loseKoDirekt(optionen) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "teams") return { erfolg: false, fehler: "Erst die Teilnehmer festlegen." };
  const teams = teamListe();
  if (teams.length < 2) return { erfolg: false, fehler: "Zu wenige Teilnehmer." };

  const opt = optionen || {};
  // Setzliste = nach Rating; "rein zufällig" mischt vorher durch.
  const sortiert = opt.modus === "zufaellig" ? mischeArray(teams) : setzlisteReihenfolge(teams);

  const updates = Object.assign({}, gemeinsameLosMeta(opt, meta));
  updates["gruppen"] = null;
  updates["spiele"] = koErsteRunde(sortiert.map((t) => t.id));
  updates["meta/phase"] = "ko";
  updates["meta/schweizerRunden"] = null;
  await db.ref(turnierBasis()).update(updates);
  await pruefeKoProgression(); // Freilose sofort weiterziehen
  return { erfolg: true };
}

// Ablauf "jeder gegen jeden": kein K.-o., die Tabelle entscheidet.
async function beendeNachGruppen() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "gruppen") return { erfolg: false, fehler: "Erst die Spiele." };
  if (hatKoRunde(meta)) {
    return { erfolg: false, fehler: "Dieses Turnier endet mit der K.-o.-Runde." };
  }
  if (!alleGruppenspieleBestaetigt()) {
    return { erfolg: false, fehler: "Es sind noch nicht alle Spiele bestätigt." };
  }
  if (istSchweizer(meta) && schweizerGespielteRunden(spielListe()) < (Number(meta.schweizerRunden) || 0)) {
    return { erfolg: false, fehler: "Es fehlen noch Runden im Schweizer System." };
  }
  const gruppen = gruppenMitTabellen(teamListe(), spielListe(), meta);
  const erster = gruppen[0] && gruppen[0].tabelle[0];
  if (!erster) return { erfolg: false, fehler: "Keine Tabelle vorhanden." };
  await db.ref(turnierBasis()).update({
    "meta/phase": "beendet",
    "meta/siegerTeamId": erster.teamId,
  });
  return { erfolg: true };
}

// Nach jedem bestätigten K.o.-Ergebnis: ist die aktuelle Runde komplett, wird
// die nächste erzeugt (bzw. der Sieger festgestellt). Deterministisch + mit
// Existenz-Guard, damit mehrere Clients es gefahrlos anstoßen können.
// Nach jedem bestaetigten Ergebnis: was laesst sich jetzt neu erzeugen?
// WARNUNG: in der SCHLEIFE, nicht einmalig. Eine Runde, die nur aus Freilosen
// besteht, ist im selben Moment fertig, in dem sie entsteht - ohne Wiederholung
// bliebe die Kette dort stehen. Der Zaehler ist der Notausgang gegen Endlosläufe.
async function pruefeKoProgression() {
  for (let i = 0; i < 12; i++) {
    const geaendert = await koProgressionSchritt();
    if (!geaendert) return;
  }
}

function koSieger(s) {
  if (!s) return null;
  if (!s.teamB) return s.teamA || null;
  return s.saetzeA > s.saetzeB ? s.teamA : s.teamB;
}
function koVerlierer(s) {
  if (!s || !s.teamB) return null;
  return s.saetzeA > s.saetzeB ? s.teamB : s.teamA;
}

// Ein K.-o.-Spiel bauen. Fehlt ein Gegner, ist es ein Freilos und sofort
// gewertet; fehlen beide (kann im Verliererbaum hinter Freilosen passieren),
// entsteht ein leeres Spiel, das nur durchreicht.
function macheKoSpiel(bracket, runde, position, a, b, extra) {
  const teamA = a || b || null;
  const teamB = a && b ? b : null;
  const durchgereicht = !teamB;
  return Object.assign({
    phase: "ko", bracket, runde, position,
    teamA, teamB,
    saetzeA: null, saetzeB: null,
    status: durchgereicht ? "bestaetigt" : "offen",
    gemeldetVon: durchgereicht ? (teamA ? "freilos" : "leer") : null,
  }, extra || {});
}

async function koProgressionSchritt() {
  const snap = await db.ref(turnierBasis()).once("value");
  const zustand = snap.val();
  if (!zustand || !zustand.meta || zustand.meta.phase !== "ko") return false;
  const spiele = Object.keys(zustand.spiele || {}).map((sid) => ({ id: sid, ...zustand.spiele[sid] }));
  return metaKoTyp(zustand.meta) === "doppel"
    ? doppelKoSchritt(zustand, spiele)
    : einfachKoSchritt(zustand, spiele);
}

async function einfachKoSchritt(zustand, spiele) {
  // WARNUNG: Das Spiel um Platz 3 liegt in derselben Runde wie das Finale,
  // entscheidet aber nichts ueber den Turniersieg - es MUSS aus der Progression
  // heraus, sonst zaehlt es als zweites Match der Runde und erzeugt eine Runde
  // danach.
  const koSpiele = spiele.filter((s) => s.phase === "ko" && !s.platz3);
  if (koSpiele.length === 0) return false;

  const maxRunde = Math.max(...koSpiele.map((s) => s.runde));
  const aktuelle = koSpiele.filter((s) => s.runde === maxRunde).sort((a, b) => a.position - b.position);
  if (!aktuelle.every((s) => s.status === "bestaetigt")) return false;

  if (aktuelle.length === 1) {
    if (zustand.meta.siegerTeamId) return false; // schon gesetzt
    await db.ref(turnierBasis() + "/meta").update({ phase: "beendet", siegerTeamId: koSieger(aktuelle[0]) });
    return false;
  }

  const naechste = maxRunde + 1;
  if (koSpiele.some((s) => s.runde === naechste)) return false; // Guard: schon angelegt
  const anzahlNaechste = aktuelle.length / 2;
  const updates = {};
  for (let p = 0; p < anzahlNaechste; p++) {
    updates["spiele/ko_r" + naechste + "_p" + p] = macheKoSpiel(
      "w", naechste, p, koSieger(aktuelle[p * 2]), koSieger(aktuelle[p * 2 + 1]),
      // Marker fuers abweichende Best-of des Finales - aus dem Spiel allein
      // waere spaeter nicht erkennbar, dass es das letzte ist.
      { istFinale: anzahlNaechste === 1 }
    );
  }
  // Halbfinale gerade beendet und "Spiel um Platz 3" eingeschaltet: die beiden
  // Verlierer spielen den dritten Platz aus.
  if (anzahlNaechste === 1 && zustand.meta.spielUmPlatz3) {
    const dritte = [koVerlierer(aktuelle[0]), koVerlierer(aktuelle[1])].filter(Boolean);
    if (dritte.length === 2 && !spiele.some((s) => s.platz3)) {
      updates["spiele/ko_platz3"] = macheKoSpiel("w", naechste, 1, dritte[0], dritte[1], { platz3: true });
    }
  }
  await db.ref(turnierBasis()).update(updates);
  return true;
}

// ===========================================================================
// Doppel-K.-o.: Gewinner- und Verliererbaum
// ===========================================================================
// Wer im Gewinnerbaum verliert, faellt in den Verliererbaum und ist erst nach
// der ZWEITEN Niederlage raus. Aufbau bei N Plaetzen (W = log2(N) Runden im
// Gewinnerbaum):
//   Verliererrunde 0       : die Verlierer der ersten Gewinnerrunde unter sich
//   Verliererrunde ungerade: die Uebriggebliebenen gegen die frisch Abgestiegenen
//   Verliererrunde gerade  : die Uebriggebliebenen unter sich
// Insgesamt 2W-2 Verliererrunden, danach das grosse Finale.
// WARNUNG: bewusst OHNE "Bracket Reset" - das grosse Finale ist EIN Spiel. Wer
// aus dem Verliererbaum kommt, muesste sonst zweimal gewinnen; das ist zwar die
// reine Lehre, aber fuer ein Fun-Event eine Runde, die keiner erwartet.
async function doppelKoSchritt(zustand, spiele) {
  const meta = zustand.meta;
  const ko = spiele.filter((s) => s.phase === "ko");
  if (!ko.length) return false;
  const gewinner = ko.filter((s) => (s.bracket || "w") === "w");
  const verlierer = ko.filter((s) => s.bracket === "l");
  const grosses = ko.find((s) => s.bracket === "f") || null;

  const runde = (liste, r) => liste.filter((s) => s.runde === r).sort((a, b) => a.position - b.position);
  const fertig = (liste) => liste.length > 0 && liste.every((s) => s.status === "bestaetigt");

  const m0 = runde(gewinner, 0).length;
  if (!m0) return false;
  const W = Math.round(Math.log2(m0 * 2));
  const lbRunden = Math.max(0, 2 * W - 2);
  const updates = {};

  // --- Gewinnerbaum: naechste Runde aus den Siegern
  for (let r = 0; r + 1 < W; r++) {
    const akt = runde(gewinner, r);
    if (!fertig(akt) || runde(gewinner, r + 1).length) continue;
    for (let p = 0; p < akt.length / 2; p++) {
      updates["spiele/w_r" + (r + 1) + "_p" + p] =
        macheKoSpiel("w", r + 1, p, koSieger(akt[p * 2]), koSieger(akt[p * 2 + 1]));
    }
    break; // je Schritt nur eine Runde - der naechste Durchlauf sieht sie dann
  }

  // --- Verliererbaum
  for (let r = 0; r < lbRunden; r++) {
    if (runde(verlierer, r).length) continue;
    if (r === 0) {
      const wb0 = runde(gewinner, 0);
      if (!fertig(wb0)) break;
      const abstieg = wb0.map(koVerlierer);
      for (let p = 0; p < abstieg.length / 2; p++) {
        updates["spiele/l_r0_p" + p] = macheKoSpiel("l", 0, p, abstieg[p * 2], abstieg[p * 2 + 1]);
      }
    } else if (r % 2 === 1) {
      const wbRunde = (r - 1) / 2 + 1;
      const vorher = runde(verlierer, r - 1);
      const oben = runde(gewinner, wbRunde);
      if (!fertig(vorher) || !fertig(oben)) break;
      // Die Absteiger gedreht einsetzen: sonst trifft man sofort wieder auf die
      // Person, gegen die man eben schon verloren hat.
      const abstieg = oben.map(koVerlierer).reverse();
      vorher.map(koSieger).forEach((teamId, p) => {
        updates["spiele/l_r" + r + "_p" + p] = macheKoSpiel("l", r, p, teamId, abstieg[p]);
      });
    } else {
      const vorher = runde(verlierer, r - 1);
      if (!fertig(vorher)) break;
      const weiter = vorher.map(koSieger);
      for (let p = 0; p < weiter.length / 2; p++) {
        updates["spiele/l_r" + r + "_p" + p] = macheKoSpiel("l", r, p, weiter[p * 2], weiter[p * 2 + 1]);
      }
    }
    break;
  }

  // --- Grosses Finale
  const wbFinale = runde(gewinner, W - 1);
  const lbFinale = lbRunden > 0 ? runde(verlierer, lbRunden - 1) : [];
  if (!grosses && fertig(wbFinale) && (lbRunden === 0 || fertig(lbFinale))) {
    updates["spiele/f_r0_p0"] = macheKoSpiel(
      "f", 0, 0, koSieger(wbFinale[0]), lbRunden ? koSieger(lbFinale[0]) : null, { istFinale: true }
    );
  }

  if (Object.keys(updates).length) {
    await db.ref(turnierBasis()).update(updates);
    return true;
  }

  if (grosses && grosses.status === "bestaetigt" && !meta.siegerTeamId) {
    await db.ref(turnierBasis() + "/meta").update({ phase: "beendet", siegerTeamId: koSieger(grosses) });
  }
  return false;
}

// Admin-Fallback, falls die Auto-Progression mal nicht griff.
async function naechsteRundeManuell() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await pruefeKoProgression();
  return { erfolg: true };
}

// --- Testspieler (Admin, zum Ausprobieren) --------------------------------
// Legt Spieler mit zufälligem Rating an, damit sich der komplette Ablauf
// (Teams → Gruppen → K.-o.) allein durchspielen lässt, ohne dass sich echte
// Leute anmelden müssen. Die UIDs tragen ein "test_"-Präfix und sind damit
// gezielt wieder entfernbar. Das Rating ist über den ganzen erlaubten Bereich
// gleichverteilt – das fordert Balanced-Pairing und Setzlisten-Töpfe am meisten.
const TEST_UID_PREFIX = "test_";

function zufallsRating() {
  const stufen = (RATING_MAX - RATING_MIN) / 10;
  return RATING_MIN + Math.floor(Math.random() * (stufen + 1)) * 10;
}

// Beide Testspieler-Aktionen nur während der Anmeldung: danach hängen an den
// Spieler:innen bereits Teams, Gruppen und Spiele.
function testspielerErlaubt() {
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (!letzterZustand || !letzterZustand.meta) return { erfolg: false, fehler: "Kein Turnier vorhanden." };
  if (letzterZustand.meta.phase !== "anmeldung") {
    return { erfolg: false, fehler: "Geht nur während der Anmeldung – setze das Turnier vorher zurück." };
  }
  return { erfolg: true };
}

async function legeTestspielerAn(anzahl) {
  await authBereit;
  const erlaubt = testspielerErlaubt();
  if (!erlaubt.erfolg) return erlaubt;
  const roh = parseInt(anzahl, 10);
  if (!roh || roh < 1) return { erfolg: false, fehler: "Bitte eine Anzahl zwischen 1 und 64 angeben." };
  const n = Math.min(64, roh);
  const schon = Object.keys(letzterZustand.spieler || {}).length;
  const marke = Date.now().toString(36);
  const updates = {};
  for (let i = 0; i < n; i++) {
    updates["spieler/" + TEST_UID_PREFIX + marke + "_" + i] = {
      name: "Testspieler " + (schon + i + 1),
      rating: zufallsRating(),
      beigetretenAm: Date.now() + i,
    };
  }
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true, anzahl: n };
}

async function entferneTestspieler() {
  await authBereit;
  const erlaubt = testspielerErlaubt();
  if (!erlaubt.erfolg) return erlaubt;
  const updates = {};
  Object.keys(letzterZustand.spieler || {})
    .filter((uid) => uid.indexOf(TEST_UID_PREFIX) === 0)
    .forEach((uid) => { updates["spieler/" + uid] = null; });
  const anzahl = Object.keys(updates).length;
  if (!anzahl) return { erfolg: false, fehler: "Es sind keine Testspieler angelegt." };
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true, anzahl };
}

// --- Spiele simulieren (Admin, zum Ausprobieren) --------------------------
// Würfelt alle offenen Spiele aus, damit sich Gruppentabellen, K.-o.-Baum und
// Sieger-Ermittlung durchspielen lassen, ohne jedes Ergebnis von Hand zu melden.
// Freilose (kein teamB) gelten schon als bestätigt und bleiben außen vor.
// Die Gewinnchance kommt aus der ELO-Formel über den Team-Ratings: das stärkere
// Team gewinnt häufiger, aber nicht immer – ohne Überraschungen wäre die
// Gruppentabelle am Ende bloß die Setzliste und der Test wenig aussagekräftig.
function simulierbareSpiele() {
  return spielListe().filter((s) => s.status !== "bestaetigt" && s.teamA && s.teamB);
}

async function simuliereOffeneSpiele() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (!letzterZustand || !letzterZustand.meta) return { erfolg: false, fehler: "Kein Turnier vorhanden." };
  const offene = simulierbareSpiele();
  if (!offene.length) return { erfolg: false, fehler: "Es sind gerade keine Spiele offen." };

  const meta = letzterZustand.meta;
  const rating = {};
  teamListe().forEach((t) => { rating[t.id] = t.ratingSchnitt || RATING_DEFAULT; });

  const updates = {};
  offene.forEach((s) => {
    const ra = rating[s.teamA] || RATING_DEFAULT;
    const rb = rating[s.teamB] || RATING_DEFAULT;
    const chanceA = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const aGewinnt = Math.random() < chanceA;
    const noetig = noetigeSaetze(bestOfFuer(s, meta));
    const knapp = Math.floor(Math.random() * noetig); // Sätze des Verlierers: 0 .. noetig-1
    updates["spiele/" + s.id + "/saetzeA"] = aGewinnt ? noetig : knapp;
    updates["spiele/" + s.id + "/saetzeB"] = aGewinnt ? knapp : noetig;
    updates["spiele/" + s.id + "/status"] = "bestaetigt";
    updates["spiele/" + s.id + "/gemeldetVon"] = "simulation";
  });
  await db.ref(turnierBasis()).update(updates);
  // Wie bei adminSetzeErgebnis: die K.-o.-Progression selbst anstoßen, damit die
  // nächste Runde entsteht (bzw. der Sieger feststeht).
  await pruefeKoProgression();
  return { erfolg: true, anzahl: offene.length };
}

// --- Turnier zurücksetzen / löschen (Admin) -------------------------------
// Zurücksetzen: das Turnier bleibt bestehen und alle angemeldeten Spieler:innen
// bleiben drin – nur Teams, Gruppen und Spiele fallen weg, die Phase geht zurück
// auf "anmeldung". Für einen zweiten Durchlauf mit derselben Runde, ohne dass
// sich alle neu anmelden müssen. bestOf/anzahlGruppen/weiterProGruppe bleiben
// als Vorbelegung fürs nächste Auslosen stehen.
async function setzeTurnierZurueck() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(turnierBasis()).update({
    teams: null,
    gruppen: null,
    spiele: null,
    "meta/phase": "anmeldung",
    "meta/siegerTeamId": null,
  });
  return { erfolg: true };
}

// Löschen: kompletter Turnierbaum weg, inklusive Spieler:innen und Admin-PIN.
// Danach steht die App wieder auf "Neues Turnier anlegen".
// Löscht ein BESTIMMTES Turnier – auch eins, das gerade nicht geöffnet ist
// (Papierkorb auf der Kachel in der Turnierliste).
async function loescheTurnierMitId(id) {
  await authBereit;
  if (!id) return { erfolg: false, fehler: "Kein Turnier angegeben." };
  const baum = uebersicht[id];
  const meta = baum && baum.meta;
  if (!meta) return { erfolg: false, fehler: "Turnier nicht gefunden." };
  if (!istVeranstalterVon(id, meta)) {
    return { erfolg: false, fehler: "Nur der Veranstalter dieses Turniers kann es löschen." };
  }
  // Erst der Baum, dann der Index-Eintrag: bleibt der Eintrag zurück, zeigt
  // getListe() ihn ohnehin nicht mehr an (Baum weg = keine Kachel).
  await db.ref("turniere/" + id).remove();
  await db.ref(INDEX_PFAD + "/" + id).remove();
  try { localStorage.removeItem(adminPinKey(id)); } catch (e) {}
  if (turnierId === id) waehleTurnier(null);
  return { erfolg: true };
}

async function loescheTurnier() {
  return loescheTurnierMitId(turnierId);
}

// ===========================================================================
const turnierService = {
  RATING_MIN, RATING_MAX, RATING_DEFAULT,
  onZustandsAenderung,
  getZustand,
  getListe,
  getTurnierId: () => turnierId,
  waehleTurnier,
  erstelleTurnier,
  setzeTurnierform,
  authentifiziereAlsAdmin,
  tritBei,
  aktualisiereRating,
  meldeAb,
  bildeTeams,
  tauscheSpieler,
  loseTurnier,
  loseGruppen,
  naechsteSchweizerRunde,
  verschiebeInSetzliste,
  setzlisteZuruecksetzen,
  schweizerVorschlagRunden,
  beendeNachGruppen,
  meldeErgebnis,
  bestaetigeErgebnis,
  widersprichErgebnis,
  adminSetzeErgebnis,
  starteKoAuslosung,
  naechsteRundeManuell,
  legeTestspielerAn,
  entferneTestspieler,
  simuliereOffeneSpiele,
  setzeTurnierZurueck,
  loescheTurnier,
  loescheTurnierMitId,
  noetigeSaetze,
  getGespeicherterName: () => { try { return localStorage.getItem(NAME_KEY) || ""; } catch (e) { return ""; } },
};
