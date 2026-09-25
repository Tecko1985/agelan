// ===========================================================================
// turnier-service.js – Firebase-Kapsel & komplette Turnierlogik für AgeLan.
//
// app.js redet ausschließlich über die turnierService-API (unten) und nie direkt
// mit Firebase. getZustand() liefert einen fertig aufbereiteten UI-Zustand
// (inkl. berechneter Gruppentabellen und K.o.-Bracket); onZustandsAenderung()
// meldet jede Live-Änderung.
//
// Datenmodell (Realtime Database, je Turnier ein Knoten unter turniere/<id>):
//   meta    : { name, erstelltAm, hostId, phase, bestOf,
//               anzahlGruppen, weiterProGruppe, punkteSieg, siegerTeamId }
//
// ⚠️ Der Admin-PIN steht NICHT in meta. turniere/<id> ist fuer jeden lesbar
// (".read": true), also lag der PIN dort bis 2026-09-15 im Klartext offen im
// Netz. Er liegt jetzt als SHA-256-Hash unter turnierGeheim/<id>/adminPinHash
// in einem Knoten ohne jedes Leserecht. Geprueft wird ueber den Beweis-Weg in
// beweisePin() – siehe dort.
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

// ⚠️ Mindestlaenge des PINs, und zwar der eigentliche Schutz (15.09.2026).
//
// Der Beweisweg ueber turnierPinProbe ist ein Orakel: ein Schreibvorgang
// gelingt genau dann, wenn der Hash stimmt. Der Takt daneben laesst einen
// Versuch je Sekunde und Konto zu -- wer sich aber staendig neue anonyme
// Konten holt, umgeht ihn. Ein vierstelliger PIN ("1234") waere damit in
// ueberschaubarer Zeit durchprobiert.
//
// Sechs Zeichen sind die Grenze, ab der das aussichtslos wird: rein
// ziffrig eine Million Moeglichkeiten, mit Buchstaben ein Vielfaches davon.
// Der PIN darf weiterhin alles sein, was sich tippen laesst -- nur nicht
// mehr kurz.
//
// ⚠️ Gilt fuer NEUE Plaene. Bestehende Turniere, Streamplaene, Fruehstuecks-
// und Essensplaene behalten ihren alten PIN; sie hier abzuweisen wuerde
// laufende Veranstaltungen aussperren.
const PIN_MIN = 6;
const PIN_ZU_KURZ = "Der PIN ist zu kurz. Bitte mindestens " + PIN_MIN + " Zeichen – Ziffern und Buchstaben sind erlaubt.";

// Gibt die Fehlermeldung zurueck, oder "" wenn der PIN lang genug ist.
// ⚠️ Global, weil Streamplan, Fruehstueck und Essen dieselbe Grenze benutzen.
function pinZuKurz(pin) {
  return String(pin || "").trim().length < PIN_MIN ? PIN_ZU_KURZ : "";
}

const ADMIN_PIN_KEY = "agelan_admin_pin";
// Zwei Knoten AUSSERHALB von turniere/: dort haengt ".read": true am ganzen
// Turnierbaum, und ein Leserecht laesst sich in Firebase weiter unten nicht
// wieder wegnehmen. Deshalb liegt das Geheimnis daneben statt darunter.
const GEHEIM_PFAD = "turnierGeheim";    // <id>/adminPinHash – kein Leserecht
const PROBE_PFAD  = "turnierPinProbe";  // <id>/<uid> – Beweisablage, kein Leserecht
const NAME_KEY = "agelan_spieler_name";

const SPIELER_FARBEN = ["#1a56a0", "#057a55", "#c9941f", "#9333ea", "#dc2626", "#0891b2", "#db2777", "#ea580c"];

// --- lokaler Zustand -------------------------------------------------------
let eigeneUid = null;
let letzterZustand = null;   // roher meta/spieler/teams/gruppen/spiele-Snapshot
// ⚠️ MEHRERE Zuhoerer, keiner allein: neben der Turnier-Oberflaeche haengt auch
// die Uebersicht-Kachel an diesem Dienst. Ein einzelnes `listener = callback`
// hat den zuletzt Angemeldeten den vorigen ueberschreiben lassen - die
// Turnier-Oberflaeche zeichnete dann nie wieder neu, und ein Klick auf eine
// Turnierkachel tat sichtbar nichts. Die anderen drei Dienste fuehren aus
// demselben Grund eine Liste.
let callbacks = [];
let startGelaufen = false;
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

// --- PIN-Beweis ------------------------------------------------------------
// Merker je Turnier: steht hier true, ist der gemerkte PIN serverseitig
// bestaetigt. istVeranstalterVon() ist synchron und kann selbst nicht fragen.
let pinOk = {};
let pinLaeuft = {};

function istMockModus() {
  try { return !!window.__AGELAN_MOCK__; } catch (e) { return false; }
}

// SHA-256 ueber "<turnierId>:<pin>". Die Turnier-Id salzt mit: derselbe PIN in
// zwei Turnieren ergibt zwei verschiedene Hashes.
// ⚠️ crypto.subtle gibt es nur im sicheren Kontext (https oder localhost).
// Live und im Dev-Server ist das erfuellt; ueber eine nackte LAN-IP per http
// nicht – dort scheitert der PIN-Weg mit einer klaren Meldung statt still.
async function pinHash(id, pin) {
  const roh = new TextEncoder().encode(String(id) + ":" + String(pin));
  const buf = await crypto.subtle.digest("SHA-256", roh);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pinHashMoeglich() {
  try { return !!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest); }
  catch (e) { return false; }
}

const PIN_UNSICHER = "Dieses Geraet kann den PIN nicht pruefen: die Seite laeuft ohne https. Bitte ueber https://tecko1985.github.io/agelan/ oeffnen.";

// Beweist dem SERVER, dass wir den PIN kennen – ohne dass PIN oder Hash
// irgendwo lesbar waeren. Der Hash unter turnierGeheim/<id> hat kein Leserecht;
// die Regel fuer turnierPinProbe/<id>/<uid> laesst das Schreiben nur zu, wenn
// der geschriebene Wert genau dem hinterlegten Hash gleicht. Geht der Schreib-
// vorgang durch, war der PIN richtig – geht er nicht durch, war er falsch.
// Nebenwirkung mit Absicht: die Ablage ist zugleich der Nachweis, den die Regel
// spaeter beim PIN-Wechsel und beim Loeschen verlangt.
// ⚠️ Der Streamkalender benutzt denselben Weg mit eigenen Knoten und ruft
// beweisePinAn() direkt auf (stream-service.js wird nach dieser Datei geladen).
// Wer hier etwas aendert, aendert es fuer beide.
// Der Taktknoten zum Beweisknoten. Alle vier Bereiche heissen gleich gebaut
// (<bereich>PinProbe / <bereich>PinTakt); passt das nicht, gibt es lieber gar
// keinen Takt als einen falschen Pfad, auf den keine Regel zeigt.
function taktPfadZu(probePfad) {
  const p = String(probePfad || "");
  return p.endsWith("PinProbe") ? p.slice(0, -"PinProbe".length) + "PinTakt" : "";
}

// ⚠️ Vor JEDEM Beweis einmal takten. Der Beweisweg ist naemlich ein Orakel:
// der Schreibvorgang gelingt genau dann, wenn der Hash stimmt. Ohne Bremse
// koennte jemand einen vierstelligen PIN in Minuten durchprobieren –
// Firebase-Regeln haben von sich aus kein Zaehlwerk. Die Regel laesst den
// Beweis nur durch, wenn derselbe uid in den letzten 5 Sekunden getaktet hat,
// und takten darf man hoechstens jede Sekunde.
//
// ⚠️⚠️ ServerValue.TIMESTAMP, NIEMALS Date.now(). Die Regel misst gegen `now`
// (die Serverzeit). Wer die Geraeteuhr schickt, sperrt jeden mit einer schief
// gehenden Uhr dauerhaft aus – der PIN ginge dann nie mehr durch.
async function takte(probePfad, id, uid) {
  const takt = taktPfadZu(probePfad);
  if (!takt) return false;
  try {
    const marke = (firebase && firebase.database && firebase.database.ServerValue)
      ? firebase.database.ServerValue.TIMESTAMP : null;
    if (marke === null) return false;
    await db.ref(takt + "/" + id + "/" + uid).set(marke);
    return true;
  } catch (e) {
    // Abgelehnt heisst hier fast immer "zu schnell hintereinander" – der
    // Aufrufer wartet kurz und nimmt einen zweiten Anlauf.
    return false;
  }
}

// Einen Beweis ABLEGEN, ohne vorher zu raten: beim Anlegen und beim Wechseln
// kennen wir den richtigen Hash schon. Der Takt muss trotzdem sein – die Regel
// verlangt ihn fuer JEDES Hinlegen, nicht nur fuers Probieren.
// ⚠️ Wirft weiter, wenn es nicht klappt: hier ist ein Fehlschlag KEIN "PIN war
// falsch", sondern ein echtes Problem, und der Aufrufer muss davon erfahren.
async function legeBeweisAb(probePfad, id, uid, hash) {
  for (let versuch = 0; versuch < 2; versuch++) {
    if (await takte(probePfad, id, uid)) break;
    if (versuch === 0) await new Promise((f) => setTimeout(f, 1100));
  }
  await db.ref(probePfad + "/" + id + "/" + uid).set(hash);
}

async function beweisePinAn(geheimPfad, probePfad, id, uid, pin) {
  if (!id || !uid || !pin) return false;
  if (!pinHashMoeglich()) return false;
  let h;
  try { h = await pinHash(id, pin); } catch (e) { return false; }
  // Ohne Firebase gibt es keine Regeln, die den Beweis pruefen koennten – im
  // Test-Modus wird deshalb direkt verglichen.
  if (istMockModus()) {
    try {
      const snap = await db.ref(geheimPfad + "/" + id + "/adminPinHash").once("value");
      return snap.val() === h;
    } catch (e) { return false; }
  }
  // ⚠️⚠️ Der Beweis wird IMMER versucht, auch wenn der Takt nicht lag.
  //
  // Das ist kein Schlendrian, sondern die Reihenfolge-Sicherung: die neuen
  // Regeln muessen in der Firebase-Konsole von Hand veroeffentlicht werden,
  // und bis dahin gibt es den Knoten turnierPinTakt gar nicht -- takte()
  // scheitert dann bei JEDEM. Wuerde der Beweis daran haengen, waere nach dem
  // Hochladen dieser Datei und VOR dem Veroeffentlichen der Regeln in allen
  // vier Bereichen kein Veranstalter-Zugang mehr moeglich. Mitten in einer
  // laufenden Veranstaltung.
  //
  // Beide Welten gehen damit auf:
  //   - alte Regeln: Takt scheitert, Beweis geht durch (wie bisher).
  //   - neue Regeln: ohne frischen Takt weist die Regel den Beweis ab --
  //     die Bremse greift also genau dann, wenn die Regeln stehen.
  //
  // Zwei Anlaeufe, weil der Takt auch daran scheitern kann, dass derselbe
  // Browser gerade eben schon getaktet hat (zwei gemerkte PINs hintereinander,
  // oder ein zweiter offener Tab). Nach gut einer Sekunde ist der Weg frei.
  for (let versuch = 0; versuch < 2; versuch++) {
    const getaktet = await takte(probePfad, id, uid);
    try {
      await db.ref(probePfad + "/" + id + "/" + uid).set(h);
      return true;
    } catch (e) {
      // Lag der Takt, kann es nur am Hash gelegen haben: der PIN war falsch,
      // ein zweiter Anlauf brauchte niemand. Lag der Takt NICHT, war
      // moeglicherweise nur das Sekundenfenster zu -- dafuer der zweite Gang.
      if (getaktet) return false;
      if (versuch === 0) await new Promise((f) => setTimeout(f, 1100));
    }
  }
  return false;
}

function beweisePin(id, pin) {
  return beweisePinAn(GEHEIM_PFAD, PROBE_PFAD, id, eigeneUid, pin);
}

// Altbestand: Turniere aus der Zeit, als der PIN im Klartext in meta stand.
// Wer den PIN noch gemerkt hat, zieht sie beim Oeffnen selbst um – Hash in den
// geschuetzten Knoten, Klartext raus. Danach laeuft alles ueber beweisePin().
async function heileAltenPin(id, pins) {
  const baum = uebersicht[id] || (id === turnierId ? letzterZustand : null);
  const alt = baum && baum.meta && baum.meta.adminPin;
  if (!alt || pins.indexOf(alt) === -1) return false;
  if (!pinHashMoeglich()) return false;
  try {
    const h = await pinHash(id, alt);
    await db.ref(GEHEIM_PFAD + "/" + id + "/adminPinHash").set(h);
    await legeBeweisAb(PROBE_PFAD, id, eigeneUid, h);
    await db.ref("turniere/" + id + "/meta/adminPin").remove();
    pinOk[id] = true;
    benachrichtige();
    return true;
  } catch (e) {
    console.error("PIN-Umzug fehlgeschlagen:", e);
    return false;
  }
}

// Laeuft einmal je Turnier, sobald dessen Baum da ist: gemerkte PINs gegen den
// Server halten. Erst danach zeigt die Oberflaeche die Veranstalter-Knoepfe –
// deshalb am Ende benachrichtige().
async function pruefeGemerktePins(id) {
  if (!id || pinOk[id] || pinLaeuft[id]) return;
  const pins = gespeichertePins(id);
  if (!pins.length) return;
  pinLaeuft[id] = true;
  try {
    for (let i = 0; i < pins.length; i++) {
      if (await beweisePin(id, pins[i])) {
        pinOk[id] = true;
        benachrichtige();
        return;
      }
    }
    await heileAltenPin(id, pins);
  } finally {
    pinLaeuft[id] = false;
  }
}

// Veranstalter EINES bestimmten Turniers – auch für Turniere, die gerade nicht
// geöffnet sind (Löschknopf auf der Kachel).
// Ist das angemeldete Konto als Veranstalter hinterlegt? Das Merkmal steht im
// signierten Token, der Client kann es nicht selbst setzen.
// ⚠️ Wie jede Rechteprüfung dieser App eine BEDIEN-Sperre, kein Datenriegel:
// die Firebase-Regeln lassen weiterhin jeden anonymen Client schreiben.
// ⚠️ Seit 2026-09-04 zaehlt `orga` genauso wie `admin`: wer zur Organisation
// gehoert, hat dieselben Rechte. Der Unterschied liegt nur im Weg dorthin —
// `admin` ueber das Veranstalter-Passwort, `orga` per Klick im Einstellungs-
// Reiter. Diese eine Funktion ist der Punkt, an dem das fuer die ganze App
// entschieden wird; jeder Bereich fragt sie.
function kontoIstVeranstalter() {
  try {
    const k = window.__AGELAN_KONTO__;
    return !!(k && (k.admin || k.orga));
  } catch (e) {
    return false;
  }
}

// Gehoert diese Person zur Organisation? Beim Essen heisst das: zahlt nichts.
// Veranstalter gehoeren immer dazu — sie richten die Veranstaltung aus.
function kontoIstOrga() {
  try {
    const k = window.__AGELAN_KONTO__;
    return !!(k && (k.orga || k.admin));
  } catch (e) {
    return false;
  }
}

// Darf diese Person im Streamplan eintragen?
// ⚠️ Seit 2026-09-14 zaehlt NUR der Streamer-Haken - auch bei Orga und
// Veranstalter. Vorher stand hier `|| k.admin || k.orga`, und die Folge war:
// der Haken liess sich bei diesen Leuten nicht mehr wegnehmen (die Liste
// zeigte ihn fest gesetzt und grau, weil ein Abwaehlen ohnehin nichts
// geaendert haette). Wer das Eintragen erlauben will, setzt den Haken - wer es
// nehmen will, nimmt ihn raus. Ein Recht, eine Stelle.
// ⚠️ Wie alles hier eine BEDIEN-Sperre: die Firebase-Regeln lassen weiterhin
// jeden anonymen Client schreiben.
function kontoDarfStreamen() {
  try {
    const k = window.__AGELAN_KONTO__;
    return !!(k && k.streamer);
  } catch (e) {
    return false;
  }
}

// Ist ueberhaupt ein Konto angemeldet? Nur dann ist der Streamer-Haken die
// zustaendige Auskunft; ohne Konto entscheidet weiter der PIN-Weg im Plan.
function kontoAngemeldet() {
  try {
    const k = window.__AGELAN_KONTO__;
    return !!(k && k.nickname);
  } catch (e) {
    return false;
  }
}

function istVeranstalterVon(id, meta) {
  if (!meta) return false;
  if (kontoIstVeranstalter()) return true;
  if (meta.hostId && meta.hostId === eigeneUid) return true;
  // Der PIN-Weg laeuft ueber den Server und laesst sich hier nicht synchron
  // nachschlagen. Was zaehlt, ist das Ergebnis von pruefeGemerktePins().
  return !!pinOk[id || turnierId];
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

  // Jedes Kriterium liefert je Team einen Schlüssel (größer = besser) – und
  // zwar für die GRUPPE der gerade noch Gleichen, nicht paarweise.
  // ⚠️ Das direkte Duell ist eine Mini-Tabelle nur aus den Spielen der Gleichen
  // untereinander: Siege, dann Satzdifferenz, dann Sätze. Paarweise verglichen
  // war es bei drei Punktgleichen im Kreis (A>B, B>C, C>A) nicht transitiv, und
  // die Tabelle hing an der Reihenfolge der Team-Ids statt an den Ergebnissen
  // (Bugjagd 25.09.d T5-2). Bei zwei Gleichen kommt dasselbe heraus wie vorher.
  // ⚠️ ALLE Begegnungen zählen, nicht nur die erste: bei Hin- und Rückrunde
  // entschiede sonst allein das Hinspiel.
  const direktesDuell = (gruppe) => {
    const drin = new Set(gruppe.map((z) => z.teamId));
    const mini = {};
    gruppe.forEach((z) => { mini[z.teamId] = { siege: 0, plus: 0, minus: 0 }; });
    bestaetigte.forEach((m) => {
      if (!m.teamB || !drin.has(m.teamA) || !drin.has(m.teamB)) return;
      const a = mini[m.teamA], b = mini[m.teamB];
      a.plus += m.saetzeA; a.minus += m.saetzeB;
      b.plus += m.saetzeB; b.minus += m.saetzeA;
      if (m.saetzeA > m.saetzeB) a.siege++; else b.siege++;
    });
    return (z) => { const x = mini[z.teamId]; return [x.siege, x.plus - x.minus, x.plus]; };
  };
  const satzWeg = () => (z) => [z.saetzePlus - z.saetzeMinus, z.saetzePlus];

  // Reihenfolge der Kriterien nach der eingestellten Wertung. Punkte stehen
  // immer vorn, der Name immer hinten (damit die Sortierung stabil bleibt).
  const tiebreak = metaTiebreak(meta);
  const feinwertung = {
    buchholz: () => (z) => [z.buchholz],
    buchholz_cut1: () => (z) => [z.buchholzCut1],
    sonneborn: () => (z) => [z.sonneborn],
  }[tiebreak];
  const kriterien = [() => (z) => [z.punkte]].concat(feinwertung
    ? [feinwertung, satzWeg, direktesDuell]
    : tiebreak === "direktes_duell"
    ? [direktesDuell, satzWeg]
    : [satzWeg, direktesDuell]);

  // Gruppe nach dem ersten Kriterium ordnen und in Teilgruppen gleicher Werte
  // zerlegen. Jede Teilgruppe wird mit ALLEN Kriterien neu geordnet – beim
  // direkten Duell heißt das: neue Mini-Tabelle nur der noch Gleichen. Trennt ein
  // Kriterium niemanden, kommt das nächste dran.
  const ordne = (gruppe, liste) => {
    if (gruppe.length < 2) return gruppe;
    if (!liste.length) return gruppe.slice().sort((a, b) => a.name.localeCompare(b.name));
    const wert = liste[0](gruppe);
    const vgl = (a, b) => {
      const x = wert(a), y = wert(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    };
    const sortiert = gruppe.slice().sort(vgl);
    const teile = [];
    sortiert.forEach((z) => {
      const letzte = teile[teile.length - 1];
      if (letzte && vgl(letzte[0], z) === 0) letzte.push(z); else teile.push([z]);
    });
    if (teile.length === 1) return ordne(gruppe, liste.slice(1));
    return [].concat(...teile.map((t) => ordne(t, liste)));
  };
  return ordne(Object.values(zeilen), kriterien);
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
    // ⚠️ Das Bracket baut seine Matches aus AUSGEWAEHLTEN Feldern, nicht per
    // Spread. Ohne diese zwei Zeilen haette jedes K.-o.-Spiel in der Anzeige
    // keine Zeit - obwohl sie in der Datenbank steht.
    geplantAm: s.geplantAm || null, dauerMin: Number(s.dauerMin) || null,
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
  const finaleSpiel = ohnePlatz3.find((s) => s.bracket === "f" && (s.runde || 0) === 0) || null;

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
  const entscheidungSpiel = ohnePlatz3.find((s) => s.bracket === "f" && s.runde === 1) || null;
  const entscheidung = entscheidungSpiel && entscheidungSpiel.teamA ? alsMatch(entscheidungSpiel) : null;
  return {
    runden,
    verliererRunden: doppel ? verliererRunden : [],
    finale,
    entscheidung,
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
    formatOffen: !!meta.formatOffen,
    istSchweizer: istSchweizer(meta),
    hatKoRunde: hatKoRunde(meta),
    hatVorrunde: hatVorrunde(meta),
    tiebreak: metaTiebreak(meta),
    koTyp: metaKoTyp(meta),
    spieltage: !!meta.spieltage,
    bracketReset: !!meta.bracketReset,
    spieltagDaten: (vorhanden && letzterZustand.spieltagDaten) || {},
    zeitplan: Object.assign({}, ZP_VORGABE, (meta && meta.zeitplan) || {}),
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
  const z = getZustand();
  // Ein Fehler in einem Zuhoerer darf die anderen nicht mit abraeumen.
  callbacks.forEach((cb) => {
    try { cb(z); } catch (e) { console.error("Turnier-Zuhoerer fehlgeschlagen:", e); }
  });
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
        formatOffen: !!(meta && meta.formatOffen),
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
      // Erst jetzt steht der Baum – und erst jetzt laesst sich ein gemerkter
      // PIN gegen den Server halten. Laeuft je Turnier nur einmal.
      pruefeGemerktePins(id);
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
      pruefeGemerktePins(turnierId);
      benachrichtige();
    });
  }
  benachrichtige();
}

function onZustandsAenderung(callback) {
  if (typeof callback !== "function") return;
  callbacks.push(callback);
  // Wer sich spaeter anhaengt, bekommt den Stand sofort - sonst sieht er bis
  // zur naechsten fremden Aenderung nichts.
  if (startGelaufen) {
    callback(getZustand());
    return;
  }
  // Der Datenbank-Teil unten gehoert genau einmal angeschaltet. Ein zweiter
  // Aufruf haenge sonst einen zweiten Index-Listener an denselben Pfad.
  startGelaufen = true;
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
  if (pinZuKurz(pin)) return { erfolg: false, fehler: PIN_ZU_KURZ };
  if (!pinHashMoeglich()) return { erfolg: false, fehler: PIN_UNSICHER };
  const id = neueTurnierId();
  // Hash VOR dem Anlegen bilden: scheitert er, gibt es kein halbes Turnier.
  let pinH;
  try { pinH = await pinHash(id, pin); }
  catch (e) { return { erfolg: false, fehler: PIN_UNSICHER }; }
  // Kein Ablauf übergeben = das Format wird erst später festgelegt. Das ist
  // der Normalfall: erst am Veranstaltungstag steht fest, wie viele kommen.
  // teamGroesse/ablauf tragen solange die alten Standardwerte als Platzhalter,
  // damit jede vorhandene Auswertung weiterrechnet wie bisher.
  const formatOffen = !ablauf;
  // Modus (Best-of), Gruppen-Anzahl und Weiterkommende werden erst beim Auslosen
  // festgelegt – dann steht die Teilnehmerzahl fest. Hier nur Platzhalter-Defaults.
  // Turnierform und Ablauf dagegen jetzt: sie sagen, worauf man sich einschreibt.
  await db.ref("turniere/" + id + "/meta").set({
    name: name.trim(),
    erstelltAm: firebase.database.ServerValue.TIMESTAMP,
    hostId: eigeneUid,
    phase: "anmeldung",
    teamGroesse: metaTeamGroesse({ teamGroesse }),
    ablauf: metaAblauf({ ablauf }),
    formatOffen: formatOffen,
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
  // Der PIN selbst kommt nirgends in die Datenbank – nur sein Hash, und zwar
  // in den Knoten ohne Leserecht. Die Beweisablage gleich mit: die Regel
  // verlangt sie spaeter beim PIN-Wechsel und beim Loeschen.
  await db.ref(GEHEIM_PFAD + "/" + id + "/adminPinHash").set(pinH);
  await legeBeweisAb(PROBE_PFAD, id, eigeneUid, pinH);
  pinOk[id] = true;
  merkeAdminPin(id, pin);
  waehleTurnier(id);
  return { erfolg: true, id };
}

// --- Turnierform & Ablauf ändern (Admin, nur während der Anmeldung) -------
// Danach hängen Teams, Gruppen und Spiele daran – ein Wechsel würde sie
// ungültig machen. Wer trotzdem umstellen will, setzt vorher zurück.
async function setzeTurnierform({ teamGroesse, ablauf, koTyp }) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "anmeldung") {
    return { erfolg: false, fehler: "Geht nur während der Anmeldung – setze das Turnier vorher zurück." };
  }
  const zusatz = {};
  // koTyp ist beim Auslosen nochmal wählbar; hier nur, damit die Vorschau in
  // der Anmeldung und das spätere Auslosen dasselbe meinen.
  if (koTyp === "doppel" || koTyp === "einfach") zusatz.koTyp = koTyp;
  await db.ref(turnierBasis() + "/meta").update(Object.assign({
    teamGroesse: metaTeamGroesse({ teamGroesse }),
    ablauf: metaAblauf({ ablauf }),
    formatOffen: false,
  }, zusatz));
  return { erfolg: true };
}

// --- als Admin auf einem weiteren Gerät anmelden --------------------------
// ⚠️ Seit 2026-09-15 ASYNCHRON: geprueft wird gegen den Server (beweisePin),
// nicht mehr gegen einen mitgelieferten Klartext-PIN. Jeder Aufrufer muss
// await setzen – ohne await ist das Ergebnis ein Promise und damit immer wahr.
async function authentifiziereAlsAdmin(pin) {
  await authBereit;
  const id = turnierId;
  if (!id || !letzterZustand || !letzterZustand.meta) return { erfolg: false, fehler: "Kein Turnier vorhanden." };
  const eingabe = String(pin == null ? "" : pin).trim();
  if (!eingabe) return { erfolg: false, fehler: "Bitte den PIN eingeben." };
  if (!pinHashMoeglich()) return { erfolg: false, fehler: PIN_UNSICHER };
  if (!(await beweisePin(id, eingabe))) {
    // Altbestand ohne hinterlegten Hash: dort entscheidet noch der Klartext –
    // einmalig, denn heileAltenPin() raeumt ihn gleich danach weg.
    const alt = letzterZustand.meta && letzterZustand.meta.adminPin;
    if (!alt || eingabe !== alt) return { erfolg: false, fehler: "Falscher PIN." };
  }
  merkeAdminPin(id, eingabe);
  pinOk[id] = true;
  await heileAltenPin(id, [eingabe]);
  benachrichtige();
  return { erfolg: true };
}

// --- Spieler-Login / Rating -----------------------------------------------
async function tritBei({ name, rating, trotzdem }) {
  await authBereit;
  if (!letzterZustand || !letzterZustand.meta) return { erfolg: false, fehler: "Kein Turnier vorhanden." };
  if (letzterZustand.meta.phase !== "anmeldung") return { erfolg: false, fehler: "Die Anmeldung ist bereits geschlossen." };
  if (!name || !name.trim()) return { erfolg: false, fehler: "Bitte einen Namen eingeben." };
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < RATING_MIN || r > RATING_MAX) {
    return { erfolg: false, fehler: `Das 1vs1-Elo muss zwischen ${RATING_MIN} und ${RATING_MAX} liegen.` };
  }
  // ⚠️ Die Anmeldung hängt an der anonymen Kennung des GERÄTS. Wer sich am Handy
  // angemeldet hat, sieht am PC wieder „Einschreiben“ – ein Klick, und derselbe
  // Name steht zweimal im Turnier (Bugjagd 25.09.d T5-7). Deshalb erst nachfragen;
  // zwei verschiedene Leute mit gleichem Namen gehen mit `trotzdem` weiter durch.
  const gleich = name.trim().toLowerCase();
  const schonDa = Object.entries(letzterZustand.spieler || {})
    .find(([uid, sp]) => uid !== eigeneUid && sp && String(sp.name || "").trim().toLowerCase() === gleich);
  if (schonDa && !trotzdem) {
    return {
      erfolg: false, doppelt: true,
      fehler: "„" + name.trim() + "“ ist schon angemeldet – vielleicht von einem anderen Gerät aus.",
    };
  }
  await db.ref(turnierBasis() + "/spieler/" + eigeneUid).set({
    name: name.trim(),
    rating: r,
    beigetretenAm: firebase.database.ServerValue.TIMESTAMP,
  });
  try { localStorage.setItem(NAME_KEY, name.trim()); } catch (e) {}
  return { erfolg: true };
}

// ⚠️ Seit 2026-09-15 auch in der Phase "teams" erlaubt. Michel: "die ratings
// muessen auch von den spielern noch aenderbar werden - da stehen naemlich schon
// werte drin die nicht stimmen". Solange nicht ausgelost ist, kann der
// Veranstalter die Teams neu bilden – eine Korrektur wirkt sich also noch aus.
// Ab "gruppen"/"ko" bleibt es zu: dort haengen Auslosung und Setzliste daran,
// und ein nachtraeglich geaendertes Rating wuerde eine schon gespielte Runde
// anders begruenden, als sie zustande kam.
async function aktualisiereRating(rating) {
  await authBereit;
  if (!letzterZustand || !letzterZustand.meta || !["anmeldung", "teams"].includes(letzterZustand.meta.phase)) {
    return { erfolg: false, fehler: "Änderung nicht mehr möglich." };
  }
  if (!letzterZustand.spieler || !letzterZustand.spieler[eigeneUid]) {
    return { erfolg: false, fehler: "Du bist nicht angemeldet." };
  }
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < RATING_MIN || r > RATING_MAX) {
    return { erfolg: false, fehler: `Das 1vs1-Elo muss zwischen ${RATING_MIN} und ${RATING_MAX} liegen.` };
  }

  const eintraege = { [`spieler/${eigeneUid}/rating`]: r };
  // ⚠️ In der Phase "teams" liegt der Schnitt schon als eigener Wert in der
  // Mannschaft (bildeTeams hat ihn eingefroren). Ohne dieses Nachziehen wuerde
  // die Team-Karte weiter das alte Ø zeigen – die Korrektur waere gespeichert
  // und trotzdem unsichtbar, und der Veranstalter wuerde nach einer falschen
  // Zahl entscheiden.
  if (letzterZustand.meta.phase === "teams") {
    const meinTeam = teamListe().find((t) => (t.mitglieder || {})[eigeneUid]);
    if (meinTeam && meinTeam.mitgliederUids.length) {
      const wert = (uid) => (uid === eigeneUid ? r : Number((letzterZustand.spieler[uid] || {}).rating) || 0);
      const summe = meinTeam.mitgliederUids.reduce((s, uid) => s + wert(uid), 0);
      eintraege[`teams/${meinTeam.id}/ratingSchnitt`] = Math.round(summe / meinTeam.mitgliederUids.length);
    }
  }
  await db.ref(turnierBasis()).update(eintraege);
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

// Der Veranstalter nimmt eine fremde Anmeldung heraus: vertippt, doppelt
// angemeldet, kommt nicht. Bis zum 25.09.2026 ging das nur über „Turnier
// löschen“ – und damit waren alle Anmeldungen weg (Bugjagd 25.09.d T5-7).
// ⚠️ Nur in der Phase „anmeldung“: danach hängen Teams und Spiele an der uid,
// und ein Loch darin ließe Mannschaften mit einem Geist zurück.
async function entferneSpieler(uid) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (!letzterZustand || !letzterZustand.meta || letzterZustand.meta.phase !== "anmeldung") {
    return { erfolg: false, fehler: "Herausnehmen geht nur, solange die Anmeldung läuft." };
  }
  if (!uid || !letzterZustand.spieler || !Object.prototype.hasOwnProperty.call(letzterZustand.spieler, uid)) {
    return { erfolg: false, fehler: "Diese Anmeldung gibt es nicht mehr." };
  }
  await db.ref(turnierBasis() + "/spieler/" + uid).remove();
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
  if (meta.formatOffen) {
    return { erfolg: false, fehler: "Lege zuerst das Turnierformat fest." };
  }
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

// Spieltage nach dem Kreisverfahren: jede:r spielt je Spieltag höchstens
// einmal, und jede Paarung kommt genau einmal vor. Bei ungerader Zahl bleibt je
// Spieltag eine:r ohne Spiel – kein Freilos-Sieg wie im Schweizer System, in
// einer Liga spielen am Ende alle gleich viele Partien.
function spieltagPaare(ids) {
  const liste = ids.slice();
  if (liste.length % 2) liste.push(null); // Platzhalter für den spielfreien Platz
  const n = liste.length;
  const runden = [];
  for (let r = 0; r < n - 1; r++) {
    const paare = [];
    for (let i = 0; i < n / 2; i++) {
      const a = liste[i], b = liste[n - 1 - i];
      // Seiten je Spieltag wechseln, damit niemand immer links steht.
      if (a && b) paare.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    runden.push(paare);
    liste.splice(1, 0, liste.pop()); // rotieren, der erste bleibt stehen
  }
  return runden;
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
  updates["meta/bracketReset"] = koTyp === "doppel" && !!opt.bracketReset;
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
  const spieltage = !!opt.spieltage;
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
    const durchgaenge = doppelrunde ? 2 : 1;
    if (spieltage) {
      // Ligamodus: nach Spieltagen sortiert, damit jede:r pro Spieltag höchstens
      // einmal ran muss. runde = Spieltag, gruppenübergreifend gleich nummeriert.
      const basisRunden = spieltagPaare(teamIds);
      for (let d = 0; d < durchgaenge; d++) {
        basisRunden.forEach((paare, r) => {
          const spieltag = d * basisRunden.length + r;
          paare.forEach(([a, b], i) => {
            updates["spiele"][`g_${gName}_st${spieltag}_${i}`] = {
              phase: "gruppe", gruppe: gName, runde: spieltag, position: i,
              teamA: d ? b : a,
              teamB: d ? a : b,
              saetzeA: null, saetzeB: null,
              status: "offen", gemeldetVon: null,
            };
          });
        });
      }
    } else {
      // Round-Robin am Stück: jede Paarung genau einmal – mit Hin- und
      // Rückrunde zweimal, beim zweiten Mal mit vertauschten Seiten.
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
    }
  });
  Object.assign(updates, gemeinsameLosMeta(opt, meta));
  updates["meta/phase"] = "gruppen";
  updates["meta/anzahlGruppen"] = anzahlGruppen;
  updates["meta/weiterProGruppe"] = weiterProGruppe;
  updates["meta/doppelrunde"] = doppelrunde;
  updates["meta/spieltage"] = spieltage;
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

// Von oben nach unten: der oder die Erste bekommt den nächsten noch freien
// Gegner, gegen den noch nicht gespielt wurde – aber nur, wenn sich der Rest
// danach auch noch ohne Wiedersehen paaren lässt (Tiefensuche mit Rücksetzen).
// ⚠️ Rein greedy blieben sonst für die letzten zwei oft nur Gegner, die sich
// schon kannten, obwohl es eine Paarung ganz ohne Wiedersehen gab (Bugjagd
// 25.09.d T5-3: bei 5 Teilnehmenden in 87 von 120 Turnieren). Erst wenn es
// keine gibt, wird als letztes Mittel eine Wiederholung erlaubt – lieber ein
// zweites Duell als eine Runde, die gar nicht zustande kommt.
// ⚠️ Die Suche hat eine Obergrenze an Schritten; reicht sie nicht, gilt der
// alte Greedy-Weg. Bei den üblichen Größen ist sie nach wenigen Schritten fertig.
const SCHWEIZER_SUCHE_MAX = 20000;
function schweizerPaare(reihenfolge, gespielt) {
  const kennt = (a, b) => !!(gespielt[a] && gespielt[a][b]);
  if (reihenfolge.length % 2 === 0) {
    let schritte = 0;
    const suche = (offen) => {
      if (!offen.length) return [];
      if (++schritte > SCHWEIZER_SUCHE_MAX) return null;
      const a = offen[0];
      for (let i = 1; i < offen.length; i++) {
        if (kennt(a, offen[i])) continue;
        const rest = suche(offen.slice(1, i).concat(offen.slice(i + 1)));
        if (rest) return [[a, offen[i]]].concat(rest);
        if (schritte > SCHWEIZER_SUCHE_MAX) return null;
      }
      return null;
    };
    const ohne = suche(reihenfolge);
    if (ohne) return { paare: ohne, freilos: null, ohneWiedersehen: true };
  }
  return Object.assign(schweizerPaareGreedy(reihenfolge, gespielt), { ohneWiedersehen: false });
}

function schweizerPaareGreedy(reihenfolge, gespielt) {
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
// dieselbe Person die Geschenkpunkte. Geliefert werden alle Berechtigten in der
// Reihenfolge des Vorrangs: von unten nach oben, nur wer noch keins hatte
// (hatten alle eins: alle).
function schweizerFreilosKandidaten(reihenfolge, tabelle) {
  const hatteFreilos = {};
  tabelle.forEach((z) => { if (z.freilose > 0) hatteFreilos[z.teamId] = true; });
  const vonUnten = reihenfolge.slice().reverse();
  const ohne = vonUnten.filter((id) => !hatteFreilos[id]);
  return ohne.length ? ohne : vonUnten;
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
  const kennt = bisherigePaarungen(spiele);
  // ⚠️ Bei ungerader Zahl entscheidet auch das Freilos, ob es ohne Wiedersehen
  // geht. Deshalb der Reihe nach die Berechtigten durchprobieren (Vorrang wie
  // bisher: von unten, wer noch keins hatte) und den ersten nehmen, bei dem der
  // Rest ohne Wiedersehen aufgeht. Geht es mit keinem, bleibt es beim ersten.
  let freilos = null;
  let paare = null;
  if (ungerade) {
    const kandidaten = schweizerFreilosKandidaten(reihenfolge, tabelle);
    for (const k of kandidaten) {
      const versuch = schweizerPaare(reihenfolge.filter((id) => id !== k), kennt);
      if (versuch.ohneWiedersehen) { freilos = k; paare = versuch.paare; break; }
    }
    if (!paare) {
      freilos = kandidaten[0];
      paare = schweizerPaare(reihenfolge.filter((id) => id !== freilos), kennt).paare;
    }
  } else {
    paare = schweizerPaare(reihenfolge, kennt).paare;
  }

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
  const updates = {};
  updates["spiele/" + spielId + "/saetzeA"] = v.a;
  updates["spiele/" + spielId + "/saetzeB"] = v.b;
  updates["spiele/" + spielId + "/status"] = "bestaetigt";
  updates["spiele/" + spielId + "/gemeldetVon"] = "admin";
  // ⚠️ Korrektur an einem schon bestätigten K.-o.-Spiel mit NEUEM Sieger: die
  // Folgespiele sind längst mit dem alten Sieger (und Verlierer) angelegt, und
  // die Progression legt eine vorhandene Runde nie neu an. Ohne Nachzug zeigte
  // die Karte den neuen Sieger, im Finale stünde weiter der alte.
  const alterSieger = spiel.phase === "ko" && spiel.status === "bestaetigt" && spiel.teamB ? koSieger(spiel) : null;
  const neuerSieger = v.a > v.b ? spiel.teamA : spiel.teamB;
  if (alterSieger && neuerSieger !== alterSieger) {
    const folge = koKorrekturFolgen(spiel, alterSieger, koVerlierer(spiel), letzterZustand.meta);
    if (folge.fehler) return { erfolg: false, fehler: folge.fehler };
    Object.assign(updates, folge.updates);
  }
  await db.ref(turnierBasis()).update(updates);
  await pruefeKoProgression();
  return { erfolg: true };
}

// Liegt `s` im K.-o.-Ablauf NACH dem korrigierten Spiel `kor`? Im Gewinnerbaum
// hat noch niemand verloren – jedes Spiel im Verliererbaum oder Finale mit
// einem der beiden ist also später. Im Verliererbaum ist der Gewinnerbaum
// Vergangenheit. Einfaches K.-o.: höhere Runde (Platz 3 trägt die Finalrunde).
function koIstSpaeter(kor, s, doppel) {
  if (s.id === kor.id || s.phase !== "ko") return false;
  if (!doppel) return (s.runde || 0) > (kor.runde || 0);
  const bk = kor.bracket || "w";
  const bs = s.bracket || "w";
  if (bk === "w") return bs !== "w" || (s.runde || 0) > (kor.runde || 0);
  if (bk === "l") return bs === "f" || (bs === "l" && (s.runde || 0) > (kor.runde || 0));
  return bs === "f" && (s.runde || 0) > (kor.runde || 0);
}

// Was eine Korrektur mit neuem Sieger nach sich zieht: in allen späteren, noch
// nicht gespielten Spielen tauschen alter Sieger und alter Verlierer die Plätze.
// Ist ein späteres Spiel schon gemeldet oder gespielt, wird abgelehnt – dort
// hätten sonst die falschen Teams ein Ergebnis. Ein Entscheidungsspiel hängt am
// Ausgang des großen Finales und wird verworfen; die Progression legt es neu
// an, falls es gebraucht wird. War das Turnier schon beendet, läuft es wieder
// als K.-o. weiter, damit der Sieger neu bestimmt wird.
function koKorrekturFolgen(kor, alterSieger, alterVerlierer, meta) {
  const doppel = metaKoTyp(meta) === "doppel";
  const betrifft = (s) => [s.teamA, s.teamB].some((t) => t && (t === alterSieger || t === alterVerlierer));
  const spaeter = spielListe().filter((s) => koIstSpaeter(kor, s, doppel) && betrifft(s));
  const durchgereicht = (s) => s.gemeldetVon === "freilos" || s.gemeldetVon === "leer";
  const gespielt = spaeter.filter((s) => s.status !== "offen" && !durchgereicht(s));
  if (gespielt.length) {
    return { fehler: "Das Folgespiel ist schon gemeldet oder gespielt – dort stünden nach der Korrektur die falschen Teams. Ein gemeldetes Folgespiel erst mit „Widersprechen“ zurücksetzen; ist es schon bestätigt, lässt sich dieses Ergebnis nicht mehr ändern." };
  }
  const tausch = (t) => (t === alterSieger ? alterVerlierer : t === alterVerlierer ? alterSieger : t);
  const updates = {};
  spaeter.forEach((s) => {
    if (s.entscheidung) { updates["spiele/" + s.id] = null; return; }
    if (s.teamA) updates["spiele/" + s.id + "/teamA"] = tausch(s.teamA);
    if (s.teamB) updates["spiele/" + s.id + "/teamB"] = tausch(s.teamB);
  });
  if (meta && (meta.siegerTeamId || meta.phase === "beendet")) {
    updates["meta/phase"] = "ko";
    updates["meta/siegerTeamId"] = null;
  }
  return { updates };
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

  const ersteRunde = koErsteRunde(koSeedsOhneGruppenduell(qualifizierte));
  const updates = {};
  Object.keys(ersteRunde).forEach((sid) => { updates["spiele/" + sid] = ersteRunde[sid]; });
  updates["meta/phase"] = "ko";
  await db.ref(turnierBasis()).update(updates);
  await pruefeKoProgression(); // falls Freilose sofort die nächste Runde erlauben
  return { erfolg: true };
}

// Setzliste für die erste K.-o.-Runde nach einer Gruppenphase: platz-major wie
// eingesammelt, aber ohne ein Wiedersehen aus derselben Gruppe in Runde 1.
// ⚠️ Das Über-Kreuz-Setzen allein trennt Gruppen nur bei 2, 4, 8 … Gruppen. Bei
// 3 Gruppen × 2 Weiterkommenden (der Vorschlag der App für 9–12 Teams) traf der
// Sieger C auf den Zweiten C, der ihn gerade in der Gruppe gespielt hatte
// (Bugjagd 25.09.d T5-1). Deshalb: in jedem Paar aus derselben Gruppe tauscht
// der schwächer Gesetzte den Platz mit dem nächstgelegenen Setzplatz eines
// ANDEREN echten Spiels, sofern danach beide Paare gemischt sind.
// ⚠️ Getauscht wird nur zwischen echten Spielen, nie mit einem Freilos-Platz –
// ein Freilos gehört dem Besten, nicht dem, der zufällig passt. Jeder Tausch
// löst genau einen Konflikt und schafft keinen neuen, also endet die Schleife.
// Lässt es sich nicht vermeiden (z. B. nur eine Gruppe), bleibt es beim Setzen.
function koSeedsOhneGruppenduell(qualifizierte) {
  const ids = qualifizierte.map((q) => q.teamId);
  const gruppe = qualifizierte.map((q) => q.gruppenIndex);
  const n = ids.length;
  if (new Set(gruppe).size < 2) return ids;
  const groesse = naechsteZweierpotenz(n);
  const folge = bracketSeedReihenfolge(groesse);
  const paare = [];
  for (let p = 0; p < groesse / 2; p++) {
    const a = folge[p * 2] - 1, b = folge[p * 2 + 1] - 1;
    if (a < n && b < n) paare.push([Math.min(a, b), Math.max(a, b)]);
  }
  const partnerVon = (i) => { const pr = paare.find((x) => x[0] === i || x[1] === i); return pr ? (pr[0] === i ? pr[1] : pr[0]) : -1; };
  for (let schritt = 0; schritt < n; schritt++) {
    const konflikt = paare.find(([a, b]) => gruppe[a] === gruppe[b]);
    if (!konflikt) break;
    const [stark, schwach] = konflikt;
    let bester = -1;
    for (let c = 0; c < n; c++) {
      const partner = partnerVon(c);
      if (partner < 0 || c === stark || c === schwach) continue;
      if (gruppe[c] === gruppe[stark] || gruppe[schwach] === gruppe[partner]) continue;
      const abstand = Math.abs(c - schwach), alt = Math.abs(bester - schwach);
      // Bei gleichem Abstand lieber einen schwächer Gesetzten nehmen.
      if (bester < 0 || abstand < alt || (abstand === alt && c > bester)) bester = c;
    }
    if (bester < 0) break;
    [ids[schwach], ids[bester]] = [ids[bester], ids[schwach]];
    [gruppe[schwach], gruppe[bester]] = [gruppe[bester], gruppe[schwach]];
  }
  return ids;
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

// Datum eines Spieltags setzen oder wieder löschen (Ligamodus).
async function setzeSpieltagDatum(spieltag, datum) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const nr = Math.round(Number(spieltag));
  if (!Number.isFinite(nr) || nr < 0) return { erfolg: false, fehler: "Unbekannter Spieltag." };
  const wert = String(datum || "").trim();
  if (wert && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(wert)) {
    return { erfolg: false, fehler: "Bitte ein gültiges Datum wählen." };
  }
  await db.ref(turnierBasis() + "/spieltagDaten/" + nr).set(wert || null);
  return { erfolg: true };
}

// ===========================================================================
// Zeitplan: wann wird welches Spiel gespielt (seit 2026-09-14)
// ===========================================================================
// Michel: "die Spiele sollen terminiert werden um den Ablauf besser
// gewaehrleisten zu koennen." Die Zeit haengt am SPIEL
// (`spiele/$sid.geplantAm` + `dauerMin`), nicht an der Runde: bei zwei
// Plaetzen laufen zwei Spiele derselben Runde nebeneinander, eine Zeit je
// Runde koennte das gar nicht ausdruecken.
//
// ⚠️ `geplantAm` ist eine ORTSZEIT als Text ("2026-10-01T14:00"), kein
// Zeitstempel. Ein Turnier findet an einem Ort statt; eine UTC-Zahl waere hier
// nur eine Fehlerquelle (Sommerzeit, falsch gestelltes Geraet) und in der
// Datenbank nicht lesbar.

const ZP_VORGABE = {
  startZeit: "10:00",
  dauerMin: 60,      // Michel: ein Spiel dauert bis zu einer Stunde
  pauseMin: 10,
  gleichzeitig: 1,
  tagesEnde: "22:00",
};

const ZP_MAX_FENSTER = 5000;   // Notbremse, damit keine Suche endlos laeuft

function zpMinuten(hhmm) {
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function zpZeitText(minuten) {
  const m = Math.max(0, Math.round(minuten));
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function zpDatumPlus(iso, tage) {
  const t = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(iso || ""));
  if (!t) return "";
  const d = new Date(Number(t[1]), Number(t[2]) - 1, Number(t[3]));
  d.setDate(d.getDate() + (Number(tage) || 0));
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

// ⚠️ Ein Freilos wird nicht gespielt. Bekaeme es eine Zeit, stuende im Ablauf
// ein Termin, zu dem niemand antritt - und der Platz waere blockiert.
function zpIstFreilos(s) {
  return !s.teamA || !s.teamB || s.gemeldetVon === "freilos";
}

// Bloecke in Spielreihenfolge: erst die Gruppenphase nach Runde/Spieltag, dann
// die K.-o.-Runden. ⚠️ Eine Runde faengt NIE an, bevor die vorige durch ist -
// im K.o. stuende sonst ein Termin fuer ein Spiel, dessen Teilnehmer noch gar
// nicht feststehen.
function zpBloecke(spiele) {
  const key = (s) => (s.phase === "ko" ? "1" : "0") + ":" + String(Number(s.runde) || 0).padStart(4, "0");
  const map = {};
  spiele.forEach((s) => {
    (map[key(s)] = map[key(s)] || []).push(s);
  });
  return Object.keys(map).sort().map((k) => map[k].sort((a, b) =>
    String(a.gruppe || "").localeCompare(String(b.gruppe || "")) ||
    (Number(a.position) || 0) - (Number(b.position) || 0) ||
    String(a.id).localeCompare(String(b.id))
  ));
}

// Die reine Rechnung, ohne Datenbank: Spiele + Einstellungen -> Zeit je Spiel.
// Bewusst getrennt gehalten, damit sie sich in Node gegenpruefen laesst.
function berechneZeitplan(spiele, opt) {
  const startMin = zpMinuten(opt.startZeit);
  const endeMin = zpMinuten(opt.tagesEnde);
  const dauer = Math.round(Number(opt.dauerMin));
  const pause = Math.round(Number(opt.pauseMin) || 0);
  const plaetze = Math.max(1, Math.round(Number(opt.gleichzeitig) || 1));
  const schritt = dauer + pause;

  // Wie viele Spielfenster passen in einen Tag? Das letzte Fenster braucht nur
  // noch die Spieldauer, keine Pause dahinter.
  const proTag = Math.max(1, Math.floor((endeMin - startMin - dauer) / schritt) + 1);
  const fenster = (k) => {
    const tag = Math.floor(k / proTag);
    const pos = k % proTag;
    return { datum: zpDatumPlus(opt.startDatum, tag), vonMin: startMin + pos * schritt };
  };

  const belegt = {};        // Fenster -> wie viele Plaetze schon weg
  const teamsIm = {};       // Fenster -> { teamId: true }
  const plan = {};
  let abFenster = 0;

  zpBloecke(spiele).forEach((block) => {
    let hoechstes = abFenster - 1;
    block.forEach((s) => {
      let k = abFenster;
      while (k < ZP_MAX_FENSTER) {
        const voll = (belegt[k] || 0) >= plaetze;
        const t = teamsIm[k] || {};
        // ⚠️ Kein Team zweimal zur selben Zeit. Bei "jeder gegen jeden" am
        // Stueck stehen ALLE Spiele in einer Runde - ohne diese Pruefung
        // schickt der Plan dasselbe Team auf zwei Plaetze gleichzeitig.
        const doppelt = t[s.teamA] || t[s.teamB];
        if (!voll && !doppelt) break;
        k++;
      }
      if (k >= ZP_MAX_FENSTER) return;
      const f = fenster(k);
      plan[s.id] = f.datum + "T" + zpZeitText(f.vonMin);
      belegt[k] = (belegt[k] || 0) + 1;
      teamsIm[k] = teamsIm[k] || {};
      teamsIm[k][s.teamA] = true;
      teamsIm[k][s.teamB] = true;
      if (k > hoechstes) hoechstes = k;
    });
    abFenster = hoechstes + 1;
  });
  return plan;
}

function zpPruefeEinstellungen(opt) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(opt.startDatum || ""))) {
    return "Bitte ein Startdatum wählen.";
  }
  const startMin = zpMinuten(opt.startZeit);
  const endeMin = zpMinuten(opt.tagesEnde);
  if (startMin === null) return "Bitte eine Startzeit im Format 14:00 angeben.";
  if (endeMin === null) return "Bitte ein Tagesende im Format 22:00 angeben.";
  const dauer = Math.round(Number(opt.dauerMin));
  if (!Number.isFinite(dauer) || dauer < 5 || dauer > 600) {
    return "Die Dauer je Spiel muss zwischen 5 und 600 Minuten liegen.";
  }
  // ⚠️ Hier NICHT `Number(x) || 0` bzw. `|| 1` schreiben. Das schluckt eine
  // getippte 0 und macht stillschweigend etwas anderes als dort steht - beim
  // Feld "gleichzeitig" waere aus einer 0 eine 1 geworden, ohne ein Wort.
  // Leer heisst Vorgabe, eine Zahl heisst diese Zahl, Unsinn heisst Fehler.
  const pauseRoh = String(opt.pauseMin === undefined || opt.pauseMin === null ? "" : opt.pauseMin).trim();
  const pause = pauseRoh === "" ? 0 : Math.round(Number(pauseRoh));
  if (!Number.isFinite(pause) || pause < 0 || pause > 240) {
    return "Die Pause muss zwischen 0 und 240 Minuten liegen.";
  }
  const plaetzeRoh = String(opt.gleichzeitig === undefined || opt.gleichzeitig === null ? "" : opt.gleichzeitig).trim();
  const plaetze = plaetzeRoh === "" ? 1 : Math.round(Number(plaetzeRoh));
  if (!Number.isFinite(plaetze) || plaetze < 1 || plaetze > 8) {
    return "Es können 1 bis 8 Spiele gleichzeitig laufen.";
  }
  // ⚠️ Ohne diese Pruefung liefe die Fensterrechnung auf ein Fenster je Tag
  // und legte ein Drei-Stunden-Spiel in einen Tag, der nur zwei Stunden offen
  // ist.
  if (endeMin - startMin < dauer) {
    return "Zwischen Startzeit und Tagesende passt kein einziges Spiel. Tagesende später setzen oder die Dauer kürzen.";
  }
  return "";
}

// Alle noch offenen (weder gemeldeten noch bestätigten) Spiele der Reihe nach terminieren.
// ⚠️ Bestätigte Spiele bleiben unangetastet: der Knopf ist auch das Werkzeug
// zum NACHplanen, wenn der Ablauf hinterherhinkt. Wer Gespieltes verschöbe,
// machte aus dem Ablauf eine Fälschung.
async function erzeugeZeitplan(optionen) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const opt = Object.assign({}, ZP_VORGABE, optionen || {});
  const fehler = zpPruefeEinstellungen(opt);
  if (fehler) return { erfolg: false, fehler };

  // ⚠️ Nur „offen“: ein gemeldetes Spiel ist gespielt, nur noch nicht bestätigt –
  // es in die Zukunft zu schieben blockierte dort einen Platz.
  const offen = spielListe().filter((s) => s.status === "offen" && !zpIstFreilos(s));
  if (!offen.length) return { erfolg: false, fehler: "Es gibt gerade kein Spiel, das terminiert werden könnte." };

  const plan = berechneZeitplan(offen, opt);
  const updates = {};
  Object.keys(plan).forEach((sid) => {
    updates["spiele/" + sid + "/geplantAm"] = plan[sid];
    updates["spiele/" + sid + "/dauerMin"] = Math.round(Number(opt.dauerMin));
  });
  // Die Einstellungen merken, sonst tippt Michel sie beim Nachplanen neu.
  updates["meta/zeitplan"] = {
    startDatum: opt.startDatum, startZeit: opt.startZeit,
    dauerMin: Math.round(Number(opt.dauerMin)), pauseMin: Math.round(Number(opt.pauseMin) || 0),
    gleichzeitig: Math.round(Number(opt.gleichzeitig) || 1), tagesEnde: opt.tagesEnde,
  };
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true, anzahl: Object.keys(plan).length };
}

// Ein einzelnes Spiel von Hand verschieben - oder die Zeit wieder wegnehmen.
async function setzeSpielZeit(spielId, geplantAm, dauerMin) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const spiel = ((letzterZustand && letzterZustand.spiele) || {})[spielId];
  if (!spiel) return { erfolg: false, fehler: "Dieses Spiel gibt es nicht mehr." };

  // ⚠️ Sekunden abschneiden statt abweisen. `datetime-local` liefert je nach
  // Browser und Schrittweite "…T14:00" ODER "…T14:00:00" - die Regel in
  // database.rules.json nimmt nur die kurze Form. Ohne diese Zeile bekaeme
  // Michel bei einer voellig richtigen Eingabe "Bitte Datum und Uhrzeit
  // vollständig angeben" zu lesen.
  const wert = String(geplantAm || "").trim().replace(/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}):[0-9]{2}(\.[0-9]+)?$/, "$1");
  if (wert && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/.test(wert)) {
    return { erfolg: false, fehler: "Bitte Datum und Uhrzeit vollständig angeben." };
  }
  const updates = {};
  updates["spiele/" + spielId + "/geplantAm"] = wert || null;
  if (dauerMin !== undefined && dauerMin !== null && String(dauerMin) !== "") {
    const d = Math.round(Number(dauerMin));
    if (!Number.isFinite(d) || d < 5 || d > 600) {
      return { erfolg: false, fehler: "Die Dauer muss zwischen 5 und 600 Minuten liegen." };
    }
    updates["spiele/" + spielId + "/dauerMin"] = wert ? d : null;
  } else if (!wert) {
    // ⚠️ Ohne Zeit hat die Dauer keinen Sinn mehr. Bliebe sie stehen, zeigte
    // die Liste "· 60 Min" hinter einem Spiel ganz ohne Termin.
    updates["spiele/" + spielId + "/dauerMin"] = null;
  }
  await db.ref(turnierBasis()).update(updates);
  return { erfolg: true };
}

// Alle Zeiten wieder wegnehmen.
async function loescheZeitplan() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const updates = {};
  spielListe().forEach((s) => {
    updates["spiele/" + s.id + "/geplantAm"] = null;
    updates["spiele/" + s.id + "/dauerMin"] = null;
  });
  if (!Object.keys(updates).length) return { erfolg: true };
  updates["meta/zeitplan"] = null;
  await db.ref(turnierBasis()).update(updates);
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
  const finalSpiele = ko.filter((s) => s.bracket === "f");
  const grossesEins = finalSpiele.find((s) => (s.runde || 0) === 0) || null;
  const entscheidung = finalSpiele.find((s) => s.runde === 1) || null;
  const wbFinale = runde(gewinner, W - 1);
  const lbFinale = lbRunden > 0 ? runde(verlierer, lbRunden - 1) : [];
  if (!grossesEins && fertig(wbFinale) && (lbRunden === 0 || fertig(lbFinale))) {
    updates["spiele/f_r0_p0"] = macheKoSpiel(
      "f", 0, 0, koSieger(wbFinale[0]), lbRunden ? koSieger(lbFinale[0]) : null, { istFinale: true }
    );
  }

  // Entscheidungsspiel ("Bracket Reset"): teamA kommt aus dem Gewinnerbaum und
  // hat noch KEINE Niederlage, teamB aus dem Verliererbaum und hat eine. Gewinnt
  // teamB das grosse Finale, stehen beide bei einer Niederlage - dann muss ein
  // zweites Spiel her, sonst waere der eine mit einer Niederlage raus und der
  // andere mit einer Niederlage Sieger.
  if (
    meta.bracketReset && grossesEins && !entscheidung &&
    grossesEins.status === "bestaetigt" && grossesEins.teamB &&
    koSieger(grossesEins) === grossesEins.teamB
  ) {
    updates["spiele/f_r1_p0"] = macheKoSpiel(
      "f", 1, 0, grossesEins.teamA, grossesEins.teamB, { istFinale: true, entscheidung: true }
    );
  }

  if (Object.keys(updates).length) {
    await db.ref(turnierBasis()).update(updates);
    return true;
  }

  // Der Sieger steht erst fest, wenn kein Entscheidungsspiel mehr aussteht.
  const letztes = entscheidung || grossesEins;
  const brauchtEntscheidung =
    meta.bracketReset && grossesEins && !entscheidung &&
    grossesEins.status === "bestaetigt" && grossesEins.teamB &&
    koSieger(grossesEins) === grossesEins.teamB;
  if (letztes && letztes.status === "bestaetigt" && !brauchtEntscheidung && !meta.siegerTeamId) {
    await db.ref(turnierBasis() + "/meta").update({ phase: "beendet", siegerTeamId: koSieger(letztes) });
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
  // Geheimnis zuerst, Beweisablage danach: die Regel laesst das Loeschen des
  // Hashes nur zu, solange der Beweis noch daneben liegt.
  try { await db.ref(GEHEIM_PFAD + "/" + id + "/adminPinHash").remove(); } catch (e) {}
  try { await db.ref(PROBE_PFAD + "/" + id + "/" + eigeneUid).remove(); } catch (e) {}
  delete pinOk[id];
  await db.ref(INDEX_PFAD + "/" + id).remove();
  try { localStorage.removeItem(adminPinKey(id)); } catch (e) {}
  if (turnierId === id) waehleTurnier(null);
  return { erfolg: true };
}

async function loescheTurnier() {
  return loescheTurnierMitId(turnierId);
}

// ===========================================================================
// Format-Vorschau: wie sähe DIESES Format bei DIESER Teilnehmerzahl aus?
// ===========================================================================
// Reine Rechnung, ohne Datenbank – gedacht für die Anmeldephase, wenn noch
// niemand weiß, wie viele kommen. Nutzt bewusst dieselben Formeln wie die
// Auslosung (Teamzahl wie balancedGruppen, schweizerVorschlagRunden,
// naechsteZweierpotenz), sonst verspricht die Vorschau etwas anderes, als
// hinterher wirklich passiert.

// Wie viele Gruppen schlägt die App bei n Teams vor? Dieselbe Formel wie im
// Auslosen-Block der Oberfläche – hier die eine Quelle dafür.
function vorschlagGruppen(anzahlTeams) {
  return Math.max(1, Math.ceil(anzahlTeams / 4));
}

// n Teams möglichst gleichmäßig auf g Gruppen: [4,4,3] statt [4,4,2,1].
function gruppenGroessen(anzahlTeams, anzahlGruppen) {
  const g = Math.max(1, Math.min(anzahlTeams, Math.round(anzahlGruppen) || 1));
  const basis = Math.floor(anzahlTeams / g);
  const rest = anzahlTeams % g;
  return Array.from({ length: g }, (unused, i) => basis + (i < rest ? 1 : 0));
}

// Paarungen, wenn jede:r gegen jede:n spielt.
function paarungenIn(n) {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

// Zu spielende K.-o.-Partien bei q Startplätzen. Freilose legt die App zwar als
// Spiele an, gespielt wird darin aber nichts – deshalb zählen sie hier nicht
// als Partie, sondern werden getrennt gemeldet.
function koPartien(q, koTyp, bracketReset) {
  if (q < 2) return { spiele: 0, runden: 0, freilose: 0 };
  const bracket = naechsteZweierpotenz(q);
  const freilose = bracket - q;
  if (koTyp === "doppel") {
    // Doppel-K.-o.: raus erst nach der zweiten Niederlage, also sind 2q-2
    // Niederlagen zu vergeben (+1, falls das Entscheidungsspiel nötig wird).
    return {
      spiele: 2 * q - 2 + (bracketReset ? 1 : 0),
      runden: Math.max(1, 2 * Math.round(Math.log2(bracket)) - 1),
      freilose: freilose,
    };
  }
  return { spiele: q - 1, runden: Math.round(Math.log2(bracket)), freilose: freilose };
}

// Wie viele Spieltage dauert "jeder gegen jeden" als Liga (Kreisverfahren)?
function ligaSpieltage(n) {
  if (n < 2) return 0;
  return n % 2 === 0 ? n - 1 : n;
}

// Ergebnis: { moeglich, warnung, teams, uebrige, einheit, spiele, runden,
//             rundenWort, proMin, proMax, freilose, kurz, zeilen[] }
function formatVorschau(optionen) {
  const opt = optionen || {};
  const spielerAnzahl = Math.max(0, Math.round(Number(opt.spielerAnzahl) || 0));
  const groesse = metaTeamGroesse({ teamGroesse: opt.teamGroesse });
  const ablauf = ABLAUF_ARTEN.indexOf(opt.ablauf) !== -1 ? opt.ablauf : "gruppen_ko";
  const koTyp = opt.koTyp === "doppel" ? "doppel" : "einfach";
  const durchgaenge = opt.doppelrunde ? 2 : 1;
  const einheit = groesse === 1 ? "Teilnehmer" : "Teams";

  // Teamzahl exakt wie balancedGruppen: floor(n/k). Übrige rücken in
  // bestehende Teams nach, es entsteht also kein unvollständiges Team.
  const teams = spielerAnzahl < groesse ? 0 : Math.max(1, Math.floor(spielerAnzahl / groesse));
  const uebrige = teams ? spielerAnzahl - teams * groesse : spielerAnzahl;

  const leer = {
    moeglich: false, teams: teams, uebrige: uebrige, einheit: einheit, spiele: 0,
    runden: 0, rundenWort: "Runden", proMin: 0, proMax: 0, freilose: 0,
    kurz: "", zeilen: [],
  };

  const mindest = (ablauf === "schweizer" || ablauf === "schweizer_ko") ? 3 : 2;
  if (teams < mindest) {
    return Object.assign({}, leer, {
      warnung: "Braucht mindestens " + mindest + " " + einheit +
        (groesse > 1 ? " (also " + mindest * groesse + " Angemeldete)" : "") + ".",
    });
  }

  const zeilen = [];
  let spiele = 0, runden = 0, rundenWort = "Runden", proMin = 0, proMax = 0, freilose = 0;
  let warnung = "";

  if (ablauf === "nur_gruppen") {
    spiele = paarungenIn(teams) * durchgaenge;
    runden = ligaSpieltage(teams) * durchgaenge;
    rundenWort = "Spieltage";
    proMin = proMax = (teams - 1) * durchgaenge;
    zeilen.push("Eine einzige Tabelle entscheidet – kein K.-o.");
    zeilen.push("Alle spielen gleich oft, niemand fliegt vorzeitig raus.");
    if (spiele > 40) warnung = "Sehr viele Partien – das dauert bei dieser Zahl lange.";
  } else if (ablauf === "gruppen_ko") {
    const g = vorschlagGruppen(teams);
    const groessen = gruppenGroessen(teams, g);
    const gruppenspiele = groessen.reduce(function (s, x) { return s + paarungenIn(x); }, 0) * durchgaenge;
    const weiterJe = Math.max(1, Math.min(2, Math.min.apply(null, groessen)));
    const q = Math.max(2, g * weiterJe);
    const ko = koPartien(q, koTyp, false);
    spiele = gruppenspiele + ko.spiele;
    freilose = ko.freilose;
    runden = Math.max.apply(null, groessen.map(function (x) { return x - 1; })) * durchgaenge + ko.runden;
    proMin = Math.min.apply(null, groessen) - 1;
    proMax = Math.max.apply(null, groessen) - 1 + ko.runden;
    zeilen.push(g + (g === 1 ? " Gruppe" : " Gruppen") + " mit " + groessen.join("/") +
      (groesse === 1 ? " Teilnehmenden." : " Teams."));
    zeilen.push("Die besten " + weiterJe + " je Gruppe kommen weiter – " + q + " im K.-o.");
    if (freilose > 0) {
      zeilen.push(freilose + (freilose === 1 ? " Freilos" : " Freilose") + " in der ersten K.-o.-Runde.");
    }
  } else if (ablauf === "nur_ko") {
    const ko = koPartien(teams, koTyp, false);
    spiele = ko.spiele;
    runden = ko.runden;
    freilose = ko.freilose;
    proMin = koTyp === "doppel" ? 2 : 1;
    proMax = ko.runden;
    zeilen.push(koTyp === "doppel"
      ? "Raus erst nach der zweiten Niederlage."
      : "Wer einmal verliert, ist raus.");
    if (koTyp !== "doppel") {
      // Nur die echten Erstrunden-Partien zählen: wer ein Freilos hat, steht
      // schon in Runde 2, ohne gespielt zu haben.
      const raus = teams - naechsteZweierpotenz(teams) / 2;
      warnung = "Kürzestes Format – " + raus + " von " + teams + " scheiden schon in Runde 1 aus.";
    }
    if (freilose > 0) {
      zeilen.push(freilose + (freilose === 1 ? " Freilos" : " Freilose") +
        " in Runde 1 (der Baum füllt auf " + naechsteZweierpotenz(teams) + " auf).");
    }
  } else {
    // schweizer / schweizer_ko
    const maxRunden = Math.max(1, teams - 1);
    const r = Math.max(1, Math.min(maxRunden, schweizerVorschlagRunden(teams)));
    const proRunde = Math.floor(teams / 2);
    const schweizerSpiele = r * proRunde;
    runden = r;
    proMin = proMax = r;
    if (teams % 2 === 1) {
      freilose = r;
      proMin = r - 1;
      zeilen.push("Ungerade Zahl: pro Runde hat eine:r ein Freilos (zählt als Sieg, rotiert).");
    }
    if (ablauf === "schweizer_ko") {
      const q = Math.max(2, Math.min(teams, 4));
      const ko = koPartien(q, koTyp, false);
      spiele = schweizerSpiele + ko.spiele;
      runden = r + ko.runden;
      proMax = proMax + ko.runden;
      zeilen.unshift(r + " Runden Schweizer System, dann die besten " + q + " ins K.-o.");
    } else {
      spiele = schweizerSpiele;
      zeilen.unshift(r + " feste Runden – danach entscheidet die Tabelle (Buchholz).");
      zeilen.push("Niemand fliegt raus, alle spielen gleich oft.");
    }
  }

  const proText = proMin === proMax ? String(proMin) : proMin + "–" + proMax;
  const rundenText = runden === 1 ? rundenWort.replace(/e$/, "").replace(/n$/, "") : rundenWort;
  return {
    moeglich: true,
    warnung: warnung,
    teams: teams,
    uebrige: uebrige,
    einheit: einheit,
    spiele: spiele,
    runden: runden,
    rundenWort: rundenWort,
    proMin: proMin,
    proMax: proMax,
    freilose: freilose,
    kurz: spiele + (spiele === 1 ? " Partie" : " Partien") + " · " + runden + " " + rundenText +
      " · jede:r spielt " + proText,
    zeilen: zeilen,
  };
}

// Alle Abläufe auf einmal durchrechnen – für den Vergleich in der Anmeldung.
function formatVergleich(spielerAnzahl, teamGroesse, koTyp) {
  return ABLAUF_ARTEN.map(function (a) {
    return Object.assign(
      { ablauf: a },
      formatVorschau({
        spielerAnzahl: spielerAnzahl,
        teamGroesse: teamGroesse,
        ablauf: a,
        koTyp: koTyp,
      })
    );
  });
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
  entferneSpieler,
  bildeTeams,
  tauscheSpieler,
  loseTurnier,
  loseGruppen,
  naechsteSchweizerRunde,
  verschiebeInSetzliste,
  setzlisteZuruecksetzen,
  schweizerVorschlagRunden,
  formatVorschau,
  formatVergleich,
  vorschlagGruppen,
  beendeNachGruppen,
  setzeSpieltagDatum,
  erzeugeZeitplan,
  setzeSpielZeit,
  loescheZeitplan,
  berechneZeitplan,   // rein rechnend, fuer die Gegenprobe in Node
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
  // ⚠️ Gehört zu noetigeSaetze: das Finale kann ein eigenes Best-of tragen
  // (meta.bestOfFinale). Wer im Melde-Dialog einen Modus benennt, muss diese
  // Funktion fragen – validiereSaetze prueft gleich darauf genau damit.
  bestOfFuer,
  // ⚠️ Das angemeldete Konto schlaegt jeden gemerkten Namen: es ist der Name,
  // unter dem abgerechnet wird. Steht kein Konto bereit (aeltere Anmeldung,
  // privater Modus), gilt weiter der zuletzt benutzte Name.
  getGespeicherterName: () => {
    try {
      const konto = window.__AGELAN_KONTO__;
      if (konto && konto.nickname) return konto.nickname;
      return localStorage.getItem(NAME_KEY) || "";
    } catch (e) {
      return "";
    }
  },
};
