// Prüfstand für die RECHTE in database.rules.json (Abnahme 25.09.e, B2-16 / Entscheidung E5).
//
// Aufruf:  node pflege/pruefe-rechte.js            (Arbeitskopie)
//          node pflege/pruefe-rechte.js <datei>    (z. B. eine alte Fassung aus git show)
//
// Anlass: Bis zum 26.09.2026 stand auf turniere/$tid, streamplan/$pid, fruehstueck/$pid
// und essen/$pid jeweils ".write": "auth != null" — und die Anmeldung ist anonym. Jede:r
// mit dem Link konnte Ergebnisse überschreiben, Turniere und Pläne löschen und fremde
// Bestellungen ändern; Telefonnummer und Lieferanten-Mail lagen für alle lesbar in
// essen/$pid/meta.
//
// Jetzt gilt je Bereich:
//   Verwaltung  = das anlegende Gerät (meta/hostId) ODER ein PIN-Beweis gegen den
//                 hinterlegten Hash (…PinProbe/<id>/<uid> === …Geheim/<id>/adminPinHash,
//                 und der Hash MUSS existieren — sonst wäre null === null für jeden wahr).
//   Teilnehmer  = nur die eigenen Wege: Turnier beitreten/abmelden/Rating, Ergebnis des
//                 EIGENEN Spiels melden/bestätigen/widersprechen, die K.-o.-Folgerunde
//                 anlegen (läuft beim Bestätigenden), eigener Stream-Slot, eigene
//                 Frühstücks- und Essensbestellung.
// ⚠️ Das Veranstalter-/Orga-MERKMAL am Konto (kontoIstVeranstalter) kann Firebase nicht
//    prüfen — es liegt im Worker. Ein Konto-Veranstalter ohne PIN-Beweis und ohne hostId
//    darf in der Datenbank deshalb NICHT mehr verwalten. Bewusste Folge von E5.
//
// Der Auswerter ist der aus spiele/pflege/pruefe-rules.js (versteht auth, root, data,
// newData, now, $-Variablen, Kaskade, .validate, Mehrpfad-update, TIMESTAMP), dazu
// .matches(/re/). Pfade und Werte sind aus den *-service.js ABGESCHRIEBEN — wer einen
// Schreibweg ändert, trägt ihn hier nach. Am Ende läuft ein Selbsttest.
"use strict";
const fs = require("fs");
if (!String.prototype.matches) {
  Object.defineProperty(String.prototype, "matches", { value: function (re) { return re.test(this.valueOf()); }, enumerable: false });
}
const DATEI = process.argv[2] || __dirname + "/../database.rules.json";
const ORIGINAL = JSON.parse(fs.readFileSync(DATEI, "utf8").replace(/\r\n/g, "\n")).rules;

/* ======================================================================
   Auswerter (aus spiele/pflege/pruefe-rules.js)
   ====================================================================== */

const JETZT = 1758600000000;
const TS = { ".sv": "timestamp" };

function teile(p) { return String(p || "").split("/").filter(Boolean); }
function kopie(x) { return x === undefined || x === null ? null : JSON.parse(JSON.stringify(x)); }
function lies(baum, p) {
  let k = baum;
  for (const t of teile(p)) { if (k === null || typeof k !== "object" || !(t in k)) return null; k = k[t]; }
  return k === undefined ? null : k;
}
function leer(x) { return x === null || x === undefined || (typeof x === "object" && Object.keys(x).length === 0); }
/* Firebase speichert weder null noch leere Objekte; TIMESTAMP wird zu now. */
function normiere(x) {
  if (x === null || x === undefined) return null;
  if (typeof x !== "object") return x;
  if (x[".sv"] === "timestamp") return JETZT;
  const o = {};
  const keys = Array.isArray(x) ? x.map((_, i) => i) : Object.keys(x);
  for (const k of keys) { const v = normiere(x[k]); if (v !== null) o[k] = v; }
  return Object.keys(o).length ? o : null;
}
function schreibIn(baum, p, wert) {
  const t = teile(p);
  const neu = kopie(baum) || {};
  if (!t.length) return normiere(wert) || {};
  let k = neu; const kette = [neu];
  for (let i = 0; i < t.length - 1; i++) {
    if (typeof k[t[i]] !== "object" || k[t[i]] === null) k[t[i]] = {};
    k = k[t[i]]; kette.push(k);
  }
  const w = normiere(wert);
  if (w === null) delete k[t[t.length - 1]]; else k[t[t.length - 1]] = w;
  for (let i = t.length - 1; i >= 1; i--) {
    const eltern = kette[i - 1]; const kind = eltern[t[i - 1]];
    if (kind && typeof kind === "object" && Object.keys(kind).length === 0) delete eltern[t[i - 1]]; else break;
  }
  return neu;
}
function snap(wert) {
  return {
    val: () => (wert === undefined ? null : wert),
    exists: () => !leer(wert),
    child: (p) => snap(lies(wert, p)),
    hasChildren: (liste) => !!wert && typeof wert === "object" && (liste || []).every((k) => wert[k] !== undefined && wert[k] !== null),
    hasChild: (k) => !!wert && typeof wert === "object" && wert[k] !== undefined,
    isString: () => typeof wert === "string",
    isNumber: () => typeof wert === "number",
    isBoolean: () => typeof wert === "boolean",
  };
}

// agelan-Rolle 26.09.2026: `auth.token` - bei jeder Firebase-Anmeldung vorhanden, mit den Claims
// eines Custom Tokens. orgaClaim = Konto ⭐/🛠 mit gueltigem Claim (worker firebase-rolle),
// orgaAbgelaufen = Claim nach agelanBis, orgaFalsch = agelanOrga als Text statt true.
const TOKENS = {
  orgaClaim: { agelanOrga: true, agelanBis: JETZT + 3600000 },
  orgaAbgelaufen: { agelanOrga: true, agelanBis: JETZT - 1 },
  orgaFalsch: { agelanOrga: "true", agelanBis: JETZT + 3600000 },
};
function authFuer(uid) { return uid ? { uid, token: Object.assign({ firebase: { sign_in_provider: TOKENS[uid] ? "custom" : "anonymous" } }, TOKENS[uid] || {}) } : null; }

const unbekannt = [];
function werte(ausdruck, vars, kontext) {
  if (ausdruck === true || ausdruck === "true") return true;
  if (ausdruck === false || ausdruck === "false") return false;
  let code = String(ausdruck).replace(/\.beginsWith\(/g, ".startsWith(");
  // längste Namen zuerst ($code vor $c…)
  for (const name of Object.keys(vars).sort((a, b) => b.length - a.length)) code = code.split(name).join(JSON.stringify(vars[name]));
  try {
    const fn = new Function("auth", "root", "data", "newData", "now", '"use strict"; return (' + code + ");");
    return !!fn(kontext.auth, kontext.root, kontext.data, kontext.newData, JETZT);
  } catch (e) {
    // ⚠️ Nicht still „verboten" — genau das war die Blindheit der ersten Fassung.
    // Ein auth===null-Zugriff (auth.uid bei anonym) ist in Firebase „false", kein Fehler.
    if (kontext.auth === null && /auth/.test(e.message + code) && e instanceof TypeError) return false;
    unbekannt.push(String(ausdruck) + "  →  " + e.message);
    return false;
  }
}
/** Weg von der Wurzel zum Ziel: je Ebene {knoten, vars, pfad}. */
function weg(regeln, pfad) {
  const t = teile(pfad);
  const raus = [];
  let knoten = regeln; const vars = {};
  raus.push({ knoten, vars: { ...vars }, pfad: "" });
  for (let i = 0; i < t.length; i++) {
    if (!knoten) { raus.push({ knoten: null, vars: { ...vars }, pfad: t.slice(0, i + 1).join("/") }); continue; }
    let naechster = knoten[t[i]];
    if (naechster === undefined) {
      const ph = Object.keys(knoten).find((k) => k.startsWith("$"));
      if (ph) { vars[ph] = t[i]; naechster = knoten[ph]; } else naechster = null;
    }
    knoten = naechster || null;
    raus.push({ knoten, vars: { ...vars }, pfad: t.slice(0, i + 1).join("/") });
  }
  return raus;
}
function darfSchreibenEinzeln(regeln, baum, pfad, wert, uid, neuBaum) {
  const nachher = neuBaum || schreibIn(baum, pfad, wert);
  const k0 = { auth: authFuer(uid), root: snap(baum) };
  let erlaubt = false;
  for (const e of weg(regeln, pfad)) {
    if (!e.knoten || e.knoten[".write"] === undefined) continue;
    if (werte(e.knoten[".write"], e.vars, Object.assign({}, k0, { data: snap(lies(baum, e.pfad)), newData: snap(lies(nachher, e.pfad)) }))) { erlaubt = true; break; }
  }
  if (!erlaubt) return false;
  const pruefe = (kr, p, vars) => {
    const nd = lies(nachher, p);
    if (leer(nd)) return true;
    if (kr && kr[".validate"] !== undefined &&
      !werte(kr[".validate"], vars, Object.assign({}, k0, { data: snap(lies(baum, p)), newData: snap(nd) }))) return false;
    if (nd && typeof nd === "object" && kr) {
      for (const k of Object.keys(nd)) {
        let kind = kr[k]; const v2 = { ...vars };
        if (kind === undefined) { const ph = Object.keys(kr).find((x) => x.startsWith("$")); if (ph) { kind = kr[ph]; v2[ph] = k; } }
        if (kind && !pruefe(kind, p + "/" + k, v2)) return false;
      }
    }
    return true;
  };
  const ziel = weg(regeln, pfad);
  for (const e of ziel.slice(0, -1)) {
    if (!e.knoten || e.knoten[".validate"] === undefined) continue;
    const nd = lies(nachher, e.pfad);
    if (leer(nd)) continue;
    if (!werte(e.knoten[".validate"], e.vars, Object.assign({}, k0, { data: snap(lies(baum, e.pfad)), newData: snap(nd) }))) return false;
  }
  const letztes = ziel[ziel.length - 1];
  return letztes.knoten ? pruefe(letztes.knoten, pfad, letztes.vars) : true;
}
/** set/remove (wert null) an einem Pfad. */
function darfSetzen(regeln, baum, pfad, wert, uid) { return darfSchreibenEinzeln(regeln, baum, pfad, wert, uid); }
/** Mehrpfad-update: jeder Teilpfad für sich, aber gegen den GEMEINSAMEN Nachher-Baum. */
function darfUpdate(regeln, baum, basis, objekt, uid) {
  let nachher = baum;
  const schluessel = Object.keys(objekt);
  const pfade = schluessel.map((k) => teile(basis + "/" + k).join("/"));
  schluessel.forEach((k, i) => { nachher = schreibIn(nachher, pfade[i], objekt[k]); });
  return pfade.every((p, i) => darfSchreibenEinzeln(regeln, baum, p, objekt[schluessel[i]], uid, nachher));
}
/** Lesen: eine .read auf dem Weg genügt. */
function darfLesen(regeln, baum, pfad, uid) {
  for (const e of weg(regeln, pfad)) {
    if (!e.knoten || e.knoten[".read"] === undefined) continue;
    if (werte(e.knoten[".read"], e.vars, { auth: authFuer(uid), root: snap(baum), data: snap(lies(baum, e.pfad)), newData: snap(null) })) return true;
  }
  return false;
}


/* ======================================================================
   Welten und Fälle — Fall: [Bereich, Text, Welt, Art (lesen|set|update), Pfad, Wert, uid, SOLL]
   Nutzer: host = anlegendes Gerät · pin = Verwaltung per PIN-Beweis · a1/a2 Team A ·
   b1 Team B · z1 angemeldeter Spieler ohne Team · fremd = angemeldet, nicht dabei ·
   orgaKonto = Konto-Veranstalter ohne PIN und ohne hostId · null = nicht angemeldet
   ====================================================================== */
const faelle = [];
function F(b, text, welt, art, pfad, wert, uid, soll) { faelle.push([b, text, welt, art, pfad, wert, uid, soll]); }
const H = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/* ---------- Turnier ---------- */
function weltT(phase, extra) {
  const w = {
    turniere: {
      _index: { T1: { name: "Cup", erstelltAm: 1 } },
      T1: {
        meta: { name: "Cup", phase, hostId: "host" },
        spieler: { a1: { name: "A1", rating: 1200 }, a2: { name: "A2", rating: 1200 }, b1: { name: "B1", rating: 1200 }, b2: { name: "B2", rating: 1200 }, z1: { name: "Z1", rating: 1200 } },
        teams: { tA: { name: "A", ratingSchnitt: 1200, mitglieder: { a1: true, a2: true } }, tB: { name: "B", ratingSchnitt: 1200, mitglieder: { b1: true, b2: true } } },
        spiele: {
          g1: { phase: "ko", runde: 0, position: 0, bracket: "w", teamA: "tA", teamB: "tB", status: "offen" },
          g2: { phase: "ko", runde: 0, position: 1, bracket: "w", teamA: "tA", teamB: "tB", status: "gemeldet", saetzeA: 2, saetzeB: 1, gemeldetVon: "tA" },
          g3: { phase: "ko", runde: 0, position: 2, bracket: "w", teamA: "tA", teamB: "tB", status: "bestaetigt", saetzeA: 2, saetzeB: 0, gemeldetVon: "tA" },
        },
      },
      T2: { meta: { name: "Ohne PIN", phase: "anmeldung" } },   // Altbestand: kein hostId, kein Hash
    },
    turnierGeheim: { T1: { adminPinHash: H } },
    turnierPinProbe: { T1: { pin: H } },
  };
  if (extra) extra(w);
  return w;
}
{
  const R = "turniere/T1", S = R + "/spiele/";
  F("Turnier", "MUSS: Turnier anlegen (ts:960, hostId = eigene uid)", weltT("ko"), "set", "turniere/T9/meta", { name: "Neu", erstelltAm: TS, hostId: "neu", phase: "anmeldung", bestOf: 3 }, "neu", true);
  F("Turnier", "MUSS: Index-Eintrag des neuen Turniers (ts:975)", weltT("ko"), "set", "turniere/_index/T9", { name: "Neu", erstelltAm: TS }, "neu", true);
  F("Turnier", "MUSS: heileIndex legt _index/aktuell an (ts:871, jeder)", weltT("ko", (w) => { delete w.turniere._index; }), "set", "turniere/_index/aktuell", { name: "Alt", erstelltAm: 1 }, "fremd", true);
  F("Turnier", "MUSS: Turnier ist öffentlich lesbar", weltT("ko"), "lesen", R, null, null, true);
  F("Turnier", "MUSS: Index ist öffentlich lesbar", weltT("ko"), "lesen", "turniere/_index", null, null, true);
  F("Turnier", "MUSS: beitreten in der Anmeldung (ts:1059)", weltT("anmeldung"), "set", R + "/spieler/x1", { name: "X", rating: 1300, beigetretenAm: TS }, "x1", true);
  F("Turnier", "MUSS: sich in der Anmeldung abmelden (ts:1111)", weltT("anmeldung"), "set", R + "/spieler/z1", null, "z1", true);
  F("Turnier", "MUSS: eigenes Rating in der Teamphase samt Team-Schnitt (ts:1102)", weltT("teams"), "update", "", { [R + "/spieler/a1/rating"]: 1500, [R + "/teams/tA/ratingSchnitt"]: 1350 }, "a1", true);
  F("Turnier", "MUSS: Team A meldet sein Ergebnis (ts:1707)", weltT("ko"), "update", S + "g1", { saetzeA: 2, saetzeB: 0, status: "gemeldet", gemeldetVon: "tA" }, "a1", true);
  F("Turnier", "MUSS: Team B meldet sein Ergebnis", weltT("ko"), "update", S + "g1", { saetzeA: 1, saetzeB: 2, status: "gemeldet", gemeldetVon: "tB" }, "b2", true);
  F("Turnier", "MUSS: Gegner bestätigt (ts:1726)", weltT("ko"), "set", S + "g2/status", "bestaetigt", "b1", true);
  F("Turnier", "MUSS: Gegner widerspricht (ts:1740)", weltT("ko"), "update", S + "g2", { saetzeA: null, saetzeB: null, status: "offen", gemeldetVon: null }, "b1", true);
  F("Turnier", "MUSS: Melder nimmt die eigene Meldung zurück (ts:1740, beide Seiten)", weltT("ko"), "update", S + "g2", { saetzeA: null, saetzeB: null, status: "offen", gemeldetVon: null }, "a2", true);
  F("Turnier", "MUSS: K.-o.-Folgerunde vom Bestätigenden (ts:2339)", weltT("ko"), "update", R, { "spiele/ko_r1_p0": { phase: "ko", bracket: "w", runde: 1, position: 0, teamA: "tA", teamB: "tB", saetzeA: null, saetzeB: null, status: "offen", gemeldetVon: null, istFinale: true } }, "b1", true);
  F("Turnier", "MUSS: Sieger nach dem Finale (ts:2315)", weltT("ko"), "update", R + "/meta", { phase: "beendet", siegerTeamId: "tA" }, "b1", true);
  F("Turnier", "MUSS: Verwaltung per hostId lost aus (ts:1465)", weltT("teams"), "update", R, { gruppen: { gA: { name: "A", teamIds: { tA: true } } }, spiele: { g_1: { phase: "gruppe", gruppe: "gA", runde: 0, teamA: "tA", teamB: "tB", status: "offen" } }, "meta/phase": "gruppen" }, "host", true);
  F("Turnier", "MUSS: Verwaltung per PIN korrigiert ein bestätigtes Ergebnis (ts:1770)", weltT("ko"), "update", S + "g3", { saetzeA: 0, saetzeB: 2, status: "bestaetigt", gemeldetVon: "admin" }, "pin", true);
  F("Turnier", "MUSS: Verwaltung per PIN entfernt einen Spieler (ts:1129)", weltT("anmeldung"), "set", R + "/spieler/z1", null, "pin", true);
  F("Turnier", "MUSS: Verwaltung löscht das Turnier (ts:2611)", weltT("ko"), "set", R, null, "pin", true);
  F("Turnier", "MUSS: Index-Eintrag nach dem Löschen weg (ts:2617, Turnier schon fort)", weltT("ko", (w) => { delete w.turniere.T1; delete w.turnierPinProbe; }), "set", "turniere/_index/T1", null, "pin", true);
  F("Turnier", "DARF NICHT: Fremder überschreibt ein Ergebnis", weltT("ko"), "update", S + "g1", { saetzeA: 0, saetzeB: 2, status: "gemeldet", gemeldetVon: "tB" }, "fremd", false);
  F("Turnier", "DARF NICHT: Fremder löscht das Turnier", weltT("ko"), "set", R, null, "fremd", false);
  F("Turnier", "DARF NICHT: Spieler löscht das Turnier", weltT("ko"), "set", R, null, "a1", false);
  F("Turnier", "DARF NICHT: Spieler ohne Team meldet ein Ergebnis", weltT("ko"), "update", S + "g1", { saetzeA: 2, saetzeB: 0, status: "gemeldet", gemeldetVon: "tA" }, "z1", false);
  F("Turnier", "DARF NICHT: Team A bestätigt seine eigene Meldung", weltT("ko"), "set", S + "g2/status", "bestaetigt", "a2", false);
  F("Turnier", "DARF NICHT: beim Melden den Gegner austauschen", weltT("ko"), "update", S + "g1", { teamB: "tC", saetzeA: 2, saetzeB: 0, status: "gemeldet", gemeldetVon: "tA" }, "a1", false);
  F("Turnier", "DARF NICHT: im Namen des Gegners melden", weltT("ko"), "update", S + "g1", { saetzeA: 0, saetzeB: 2, status: "gemeldet", gemeldetVon: "tB" }, "a1", false);
  F("Turnier", "DARF NICHT: beim Bestätigen die Sätze ändern", weltT("ko"), "update", S + "g2", { status: "bestaetigt", saetzeA: 0 }, "b1", false);
  F("Turnier", "DARF NICHT: bestätigtes Spiel ändern", weltT("ko"), "update", S + "g3", { saetzeA: 0, saetzeB: 2, status: "gemeldet", gemeldetVon: "tB" }, "b1", false);
  F("Turnier", "DARF NICHT: bestätigtes Spiel löschen", weltT("ko"), "set", S + "g3", null, "a1", false);
  F("Turnier", "DARF NICHT: Fremder legt ein K.-o.-Spiel an", weltT("ko"), "update", R, { "spiele/ko_r1_p0": { phase: "ko", runde: 1, position: 0, teamA: "tA", teamB: null, status: "bestaetigt", gemeldetVon: "freilos" } }, "fremd", false);
  F("Turnier", "DARF NICHT: Spieler legt in der Gruppenphase ein Spiel an", weltT("gruppen"), "update", R, { "spiele/ko_r1_p0": { phase: "ko", runde: 1, position: 0, teamA: "tA", status: "offen" } }, "a1", false);
  F("Turnier", "DARF NICHT: Fremder setzt den Sieger", weltT("ko"), "set", R + "/meta/siegerTeamId", "tB", "fremd", false);
  F("Turnier", "DARF NICHT: Spieler ändert einen schon gesetzten Sieger", weltT("ko", (w) => { w.turniere.T1.meta.siegerTeamId = "tA"; }), "set", R + "/meta/siegerTeamId", "tB", "b1", false);
  F("Turnier", "DARF NICHT: Spieler setzt die Phase zurück", weltT("ko"), "set", R + "/meta/phase", "anmeldung", "a1", false);
  F("Turnier", "DARF NICHT: Spieler ändert den Turniernamen", weltT("ko"), "set", R + "/meta/name", "Meins", "a1", false);
  F("Turnier", "DARF NICHT: Spieler macht sich zum Gastgeber", weltT("ko"), "set", R + "/meta/hostId", "a1", "a1", false);
  F("Turnier", "DARF NICHT: Spieler schreibt den Schnitt eines fremden Teams", weltT("teams"), "set", R + "/teams/tB/ratingSchnitt", 3000, "a1", false);
  F("Turnier", "DARF NICHT: Spieler trägt sich in ein fremdes Team ein", weltT("teams"), "set", R + "/teams/tB/mitglieder/a1", true, "a1", false);
  F("Turnier", "DARF NICHT: Spieler ändert fremden Spieler-Eintrag", weltT("anmeldung"), "set", R + "/spieler/b1", { name: "B1", rating: 500 }, "a1", false);
  F("Turnier", "DARF NICHT: beitreten während der K.-o.-Phase", weltT("ko"), "set", R + "/spieler/x1", { name: "X", rating: 1300 }, "x1", false);
  F("Turnier", "DARF NICHT: Fremder löscht einen Index-Eintrag, solange das Turnier steht", weltT("ko"), "set", "turniere/_index/T1", null, "fremd", false);
  F("Turnier", "DARF NICHT: Fremder übernimmt ein bestehendes Turnier (meta neu setzen)", weltT("ko"), "set", R + "/meta", { name: "Weg", phase: "anmeldung", hostId: "fremd" }, "fremd", false);
  F("Turnier", "DARF NICHT: Turnier ohne hinterlegten PIN von Fremden löschen (null === null)", weltT("ko"), "set", "turniere/T2", null, "fremd", false);
  // B2-15 (26.09.): unter turniere/$tid nur die bekannten Knoten (meta, spieler, teams, spiele,
  // gruppen, spieltagDaten) - vorher liess sich beliebiger Inhalt ablegen.
  F("Turnier", "DARF NICHT: unbekanntes Feld im Turnier (auch Verwaltung)", weltT("ko"), "set", R + "/muell", "x", "host", false);
  F("Turnier", "MUSS: Gruppen und Spieltage bleiben erlaubt (ts:1465, ts:1976)", weltT("teams"), "update", R, { gruppen: { gA: { name: "A" } }, "spieltagDaten/1": "2026-10-01" }, "host", true);
  F("Turnier", "DARF NICHT: ohne Anmeldung melden", weltT("ko"), "update", S + "g1", { saetzeA: 2, saetzeB: 0, status: "gemeldet", gemeldetVon: "tA" }, null, false);
  F("Turnier", "DARF NICHT (bewusste Folge E5): Konto-Veranstalter ohne PIN verwaltet", weltT("ko"), "set", R, null, "orgaKonto", false);
}

/* ---------- Streamplan ---------- */
function weltS(ohnePlan) {
  const w = {
    streamplan: { aktuell: { meta: { titel: "Stream", hostId: "host", startDatum: "2026-10-01", anzahlTage: 4 },
      slots: { s1: { datum: "2026-10-01", von: 600, bis: 660, streamer: "U1", uid: "u1" } },
      programm: { p1: { datum: "2026-10-01", von: 600, bis: 700, titel: "Finale" } } } },
    streamplanGeheim: { aktuell: { adminPinHash: H } },
    streamplanPinProbe: { aktuell: { pin: H } },
  };
  if (ohnePlan) delete w.streamplan.aktuell.meta;
  return w;
}
{
  const P = "streamplan/aktuell";
  const slot = { datum: "2026-10-01", von: 700, bis: 760, streamer: "U2", titel: "", notiz: "", uid: "u2", erstelltAm: TS };
  F("Stream", "MUSS: eigenen Slot belegen (ss:678)", weltS(), "update", P + "/slots/s2", slot, "u2", true);
  F("Stream", "MUSS: eigenen Slot ändern, uid bleibt (ss:704)", weltS(), "update", P + "/slots/s1", { datum: "2026-10-01", von: 610, bis: 670, streamer: "U1", titel: "neu", notiz: "" }, "u1", true);
  F("Stream", "MUSS: eigenen Slot löschen (ss:809)", weltS(), "set", P + "/slots/s1", null, "u1", true);
  F("Stream", "MUSS: Verwaltung ändert fremden Slot (ss:704)", weltS(), "update", P + "/slots/s1", { von: 620, bis: 680 }, "pin", true);
  F("Stream", "MUSS: Verwaltung leert alle Slots (ss:821)", weltS(), "set", P + "/slots", null, "host", true);
  F("Stream", "MUSS: Verwaltung legt Programm an (ss:770)", weltS(), "update", P + "/programm/p2", { datum: "2026-10-02", von: 600, bis: 700, titel: "Show", notiz: "", streamerNoetig: true, erstelltAm: TS }, "pin", true);
  F("Stream", "MUSS: neuen Plan anlegen, wenn keiner steht (ss:558)", weltS(true), "update", P, { meta: { titel: "Neu", hostId: "neu", erstelltAm: TS, startDatum: "2026-10-01", anzahlTage: 4, standardVon: 600, standardBis: 1380 } }, "neu", true);
  F("Stream", "MUSS: Plan bleibt öffentlich lesbar", weltS(), "lesen", P, null, null, true);
  F("Stream", "DARF NICHT: fremden Slot löschen", weltS(), "set", P + "/slots/s1", null, "u2", false);
  F("Stream", "DARF NICHT: fremden Slot ändern", weltS(), "update", P + "/slots/s1", { von: 0 }, "u2", false);
  F("Stream", "DARF NICHT: Slot unter fremder uid anlegen", weltS(), "update", P + "/slots/s3", Object.assign({}, slot, { uid: "u1" }), "u2", false);
  F("Stream", "DARF NICHT: fremden Slot an sich ziehen (uid ändern)", weltS(), "update", P + "/slots/s1", { uid: "u2" }, "u2", false);
  F("Stream", "DARF NICHT: Teilnehmer löscht den Plan", weltS(), "set", P, null, "u2", false);
  F("Stream", "DARF NICHT: Teilnehmer ändert das Programm", weltS(), "set", P + "/programm/p1", null, "u2", false);
  F("Stream", "DARF NICHT: Fremder übernimmt den bestehenden Plan (meta neu)", weltS(), "update", P, { meta: { titel: "Weg", hostId: "fremd", startDatum: "2026-10-01", anzahlTage: 1 } }, "fremd", false);
  F("Stream", "DARF NICHT (bewusste Folge E5): Konto-Veranstalter ohne PIN leert Slots", weltS(), "set", P + "/slots", null, "orgaKonto", false);
}

/* ---------- Frühstück ---------- */
function weltF(ohnePlan) {
  const w = {
    fruehstueck: { aktuell: { meta: { titel: "Frühstück", hostId: "host", startDatum: "2026-10-01", anzahlTage: 4 },
      pakete: { p1: { name: "Brötchen", preisCent: 250 } },
      bestellungen: { "2026-10-02": {
        u1: { name: "U1", positionen: { p1: 1 }, abgeholt: false, bezahlt: false },
        u3: { name: "U3", positionen: { p1: 2 }, abgeholt: false, bezahlt: true } } } } },
    fruehstueckGeheim: { "fruehstueck-aktuell": { adminPinHash: H } },
    fruehstueckPinProbe: { "fruehstueck-aktuell": { pin: H } },
  };
  if (ohnePlan) delete w.fruehstueck.aktuell.meta;
  return w;
}
{
  const B = "fruehstueck/aktuell/bestellungen/2026-10-02/";
  const neu = { name: "U2", positionen: { p1: 1 }, preise: { p1: { name: "Brötchen", preisCent: 250 } }, notiz: "", abgeholt: false, bezahlt: false, aktualisiertAm: TS };
  F("Frühstück", "MUSS: eigene Bestellung (fs:759)", weltF(), "set", B + "u2", neu, "u2", true);
  F("Frühstück", "MUSS: eigene Bestellung ändern, Haken bleiben (fs:759)", weltF(), "set", B + "u1", Object.assign({}, neu, { name: "U1", positionen: { p1: 3 } }), "u1", true);
  F("Frühstück", "MUSS: eigene Bestellung stornieren (fs:785)", weltF(), "set", B + "u1", null, "u1", true);
  F("Frühstück", "MUSS: bezahlte Bestellung, nur Notiz geändert (fs:742, Haken bleiben true)", weltF(), "set", B + "u3", { name: "U3", positionen: { p1: 2 }, preise: {}, notiz: "ohne Butter", abgeholt: false, bezahlt: true, aktualisiertAm: TS }, "u3", true);
  F("Frühstück", "MUSS: Verwaltung hakt „abgeholt“ ab (fs:793)", weltF(), "set", B + "u1/abgeholt", true, "pin", true);
  F("Frühstück", "MUSS: Verwaltung hakt „bezahlt“ ab (fs:801)", weltF(), "set", B + "u1/bezahlt", true, "host", true);
  F("Frühstück", "MUSS: Verwaltung löscht ein Paket samt fremder Positionen (fs:667)", weltF(), "update", "fruehstueck/aktuell", { "pakete/p1": null, "bestellungen/2026-10-02/u1": null, "bestellungen/2026-10-02/u3": null }, "pin", true);
  F("Frühstück", "MUSS: neuen Plan anlegen, wenn keiner steht (fs:560)", weltF(true), "update", "fruehstueck/aktuell", { meta: { titel: "Neu", hostId: "neu", erstelltAm: TS, startDatum: "2026-10-01", anzahlTage: 4, schlussUhr: 1200, annahmeOffen: true } }, "neu", true);
  F("Frühstück", "DARF NICHT: fremde Bestellung überschreiben", weltF(), "set", B + "u1", Object.assign({}, neu, { name: "U1" }), "u2", false);
  F("Frühstück", "DARF NICHT: fremde Bestellung löschen", weltF(), "set", B + "u1", null, "u2", false);
  F("Frühstück", "DARF NICHT: eigene Bestellung selbst als bezahlt markieren", weltF(), "set", B + "u1/bezahlt", true, "u1", false);
  F("Frühstück", "DARF NICHT: neue Bestellung gleich als bezahlt", weltF(), "set", B + "u2", Object.assign({}, neu, { bezahlt: true }), "u2", false);
  F("Frühstück", "DARF NICHT: eigene Bestellung selbst als abgeholt markieren", weltF(), "set", B + "u1/abgeholt", true, "u1", false);
  F("Frühstück", "DARF NICHT: bezahlte eigene Bestellung stornieren", weltF(), "set", B + "u3", null, "u3", false);
  F("Frühstück", "DARF NICHT: Teilnehmer löscht den Plan", weltF(), "set", "fruehstueck/aktuell", null, "u2", false);
  F("Frühstück", "DARF NICHT: Teilnehmer ändert ein Paket", weltF(), "set", "fruehstueck/aktuell/pakete/p1/preisCent", 0, "u2", false);
}

/* ---------- Essen ---------- */
function weltE(ohnePlan) {
  const w = {
    essen: { aktuell: { meta: { titel: "Freitag", hostId: "host", lieferantName: "Pizzeria" },
      karte: { g1: { name: "Margherita", preisCent: 800 } },
      bestellungen: {
        o1: { uid: "u1", name: "U1", status: "neu", orga: false, positionen: { a: { name: "Margherita", anzahl: 1, preisCent: 800 } }, erstelltAm: 5 },
        o2: { uid: "u1", name: "U1", status: "bestellt", rundeId: "r1", orga: false, positionen: { a: { name: "Margherita", anzahl: 1, preisCent: 800 } }, erstelltAm: 6 },
        o3: { uid: "u3", name: "U3", status: "neu", orga: false, positionen: { a: { name: "Margherita", anzahl: 1, preisCent: 800 } }, erstelltAm: 7 } } } },
    essenOrga: { aktuell: { bestellerTelefon: "0000 1111", lieferantEmail: "kueche@example.org" } },
    essenGeheim: { "essen-aktuell": { adminPinHash: H } },
    essenPinProbe: { "essen-aktuell": { pin: H } },
  };
  if (ohnePlan) { delete w.essen.aktuell.meta; delete w.essenOrga; }
  return w;
}
{
  const E = "essen/aktuell", O = E + "/bestellungen/";
  const pos = { a: { gerichtId: "g1", nummer: "1", name: "Margherita", sonderwunsch: "", anzahl: 1, preisCent: 800, sort: 0 } };
  F("Essen", "MUSS: eigene Bestellung (es:1426)", weltE(), "set", O + "o9", { uid: "u2", name: "U2", orga: false, status: "neu", rundeId: null, notiz: "", positionen: pos, erstelltAm: TS, aktualisiertAm: TS }, "u2", true);
  F("Essen", "MUSS: eigene Bestellung ändern (es:1426, Status/Orga/erstelltAm bleiben)", weltE(), "set", O + "o1", { uid: "u1", name: "U1", orga: false, status: "neu", rundeId: null, notiz: "scharf", positionen: pos, erstelltAm: 5, aktualisiertAm: TS }, "u1", true);
  F("Essen", "MUSS: eigene Bestellung stornieren (es:1470)", weltE(), "update", E, { "bestellungen/o1": null }, "u1", true);
  F("Essen", "MUSS: Verwaltung setzt den Status fremder Bestellung (es:1493)", weltE(), "update", O + "o3", { status: "bezahlt", aktualisiertAm: TS }, "pin", true);
  F("Essen", "MUSS: Verwaltung löscht eine Bestellung aus einer Runde (es:1671)", weltE(), "update", E, { "bestellungen/o2": null, "runden/r1": null }, "host", true);
  F("Essen", "MUSS: Teilnehmer liest Karte und Bestellungen", weltE(), "lesen", E, null, "u2", true);
  F("Essen", "MUSS: Verwaltung liest Telefon/Lieferanten-Mail", weltE(), "lesen", "essenOrga/aktuell", null, "pin", true);
  F("Essen", "MUSS: Verwaltung (hostId) liest Telefon/Lieferanten-Mail", weltE(), "lesen", "essenOrga/aktuell", null, "host", true);
  F("Essen", "MUSS: Verwaltung schreibt Telefon/Lieferanten-Mail (Einstellungen)", weltE(), "set", "essenOrga/aktuell", { bestellerTelefon: "0000 2222", lieferantEmail: "neu@example.org" }, "pin", true);
  F("Essen", "MUSS: neuen Plan anlegen, meta OHNE Telefon/Mail (es:1181)", weltE(true), "update", E, { meta: { titel: "Samstag", hostId: "neu", erstelltAm: TS, annahmeOffen: true, lieferantName: "Imbiss", bestellerName: "Orga", hinweis: "" } }, "neu", true);
  F("Essen", "MUSS: Anlegender schreibt danach Telefon/Mail in den Orga-Knoten", weltE(), "set", "essenOrga/aktuell", { bestellerTelefon: "0000 3333", lieferantEmail: "" }, "host", true);
  F("Essen", "MUSS: alte Felder aus meta entfernen (Umzug)", weltE(), "update", E + "/meta", { bestellerTelefon: null, lieferantEmail: null }, "pin", true);
  F("Essen", "DARF NICHT: fremde Bestellung ändern", weltE(), "update", O + "o1", { notiz: "x" }, "u2", false);
  F("Essen", "DARF NICHT: fremde Bestellung stornieren", weltE(), "update", E, { "bestellungen/o1": null }, "u2", false);
  F("Essen", "DARF NICHT: Bestellung unter fremder uid anlegen", weltE(), "set", O + "o9", { uid: "u1", name: "U1", orga: false, status: "neu", positionen: pos, erstelltAm: TS }, "u2", false);
  F("Essen", "DARF NICHT: neue Bestellung gleich als bezahlt", weltE(), "set", O + "o9", { uid: "u2", name: "U2", orga: false, status: "bezahlt", positionen: pos, erstelltAm: TS }, "u2", false);
  F("Essen", "DARF NICHT: eigene Bestellung selbst auf bezahlt setzen", weltE(), "update", O + "o1", { status: "bezahlt" }, "u1", false);
  F("Essen", "DARF NICHT: eigenes Orga-Merkmal beim Ändern umstellen", weltE(), "update", O + "o1", { orga: true }, "u1", false);
  F("Essen", "DARF NICHT: eigene Bestellung in einer Runde ändern", weltE(), "update", O + "o2", { notiz: "x" }, "u1", false);
  F("Essen", "DARF NICHT: eigene Bestellung in einer Runde stornieren", weltE(), "update", E, { "bestellungen/o2": null }, "u1", false);
  F("Essen", "DARF NICHT: Teilnehmer liest Telefon/Lieferanten-Mail", weltE(), "lesen", "essenOrga/aktuell", null, "u2", false);
  F("Essen", "DARF NICHT: ohne Anmeldung Telefon/Lieferanten-Mail lesen", weltE(), "lesen", "essenOrga/aktuell", null, null, false);
  F("Essen", "DARF NICHT: Teilnehmer schreibt Telefon/Lieferanten-Mail", weltE(), "set", "essenOrga/aktuell/bestellerTelefon", "0", "u2", false);
  F("Essen", "DARF NICHT: Telefon wieder ins lesbare meta (auch Verwaltung)", weltE(), "update", E + "/meta", { bestellerTelefon: "0000 4444" }, "pin", false);
  F("Essen", "DARF NICHT: Lieferanten-Mail wieder ins lesbare meta (auch Verwaltung)", weltE(), "update", E + "/meta", { lieferantEmail: "x@example.org" }, "host", false);
  F("Essen", "DARF NICHT: Zusatzfeld im Orga-Knoten", weltE(), "set", "essenOrga/aktuell/iban", "DE00", "pin", false);
  F("Essen", "DARF NICHT: Teilnehmer löscht den Plan", weltE(), "set", E, null, "u2", false);
  F("Essen", "DARF NICHT: Teilnehmer ändert die Karte", weltE(), "set", E + "/karte/g1/preisCent", 0, "u2", false);
  F("Essen", "DARF NICHT: Fremder übernimmt den bestehenden Plan (meta neu)", weltE(), "update", E, { meta: { titel: "Weg", hostId: "fremd" } }, "fremd", false);
  F("Essen", "DARF NICHT (bewusste Folge E5): Konto-Veranstalter ohne PIN liest Telefon", weltE(), "lesen", "essenOrga/aktuell", null, "orgaKonto", false);
}

/* ---------- A3-06 (Fixprüfung 26.09.2026): wer darf einen PIN-Hash NEU anlegen? ----------
   Vorher: jeder Angemeldete, wenn noch keiner lag – und danach war er per Beweis Verwaltung
   (bei Frühstück/Essen/Stream mit festen Kennungen sogar schon VOR dem Anlegen des Plans).
   Jetzt: nur das anlegende Gerät (meta/hostId) – oder beim Altbestand mit Klartext-PIN
   in meta (dort ist der PIN ohnehin lesbar; der Umzug in den Hash muss gehen). */
{
  const ohneT = (w) => { delete w.turnierGeheim; delete w.turnierPinProbe; };
  F("Turnier", "MUSS (A3-06): anlegendes Gerät hinterlegt den Hash (ts:erstelleTurnier)", weltT("anmeldung", ohneT), "set", "turnierGeheim/T1/adminPinHash", H, "host", true);
  F("Turnier", "DARF NICHT (A3-06): Teilnehmer legt Hash für Turnier ohne Hash an", weltT("anmeldung", ohneT), "set", "turnierGeheim/T1/adminPinHash", H, "a1", false);
  F("Turnier", "DARF NICHT (A3-06): Hash für ein Turnier, das es nicht gibt", weltT("anmeldung", ohneT), "set", "turnierGeheim/T9/adminPinHash", H, "fremd", false);
  F("Turnier", "MUSS (A3-06, Altbestand): Hash für Turnier mit Klartext-PIN (heileAltenPin)", weltT("anmeldung", (w) => { ohneT(w); w.turniere.T1.meta.adminPin = "123456"; }), "set", "turnierGeheim/T1/adminPinHash", H, "a1", true);
  F("Turnier", "MUSS: PIN wechseln mit Beweis bleibt (Verwaltung per PIN)", weltT("anmeldung"), "set", "turnierGeheim/T1/adminPinHash", "0".repeat(64), "pin", true);
  F("Turnier", "DARF NICHT: vorhandenen Hash ohne Beweis ersetzen (auch hostId nicht)", weltT("anmeldung"), "set", "turnierGeheim/T1/adminPinHash", "0".repeat(64), "host", false);

  const ohneS = (w) => { delete w.streamplanGeheim; delete w.streamplanPinProbe; return w; };
  F("Stream", "MUSS (A3-06): anlegendes Gerät hinterlegt den Hash nach meta", ohneS(weltS()), "set", "streamplanGeheim/aktuell/adminPinHash", H, "host", true);
  F("Stream", "DARF NICHT (A3-06): Teilnehmer legt Hash für fremden Plan an", ohneS(weltS()), "set", "streamplanGeheim/aktuell/adminPinHash", H, "u2", false);
  F("Stream", "DARF NICHT (A3-06): Hash vor dem Anlegen besetzen (kein Plan)", ohneS(weltS(true)), "set", "streamplanGeheim/aktuell/adminPinHash", H, "u2", false);

  const ohneF = (w) => { delete w.fruehstueckGeheim; delete w.fruehstueckPinProbe; return w; };
  F("Frühstück", "MUSS (A3-06): anlegendes Gerät hinterlegt den Hash nach meta", ohneF(weltF()), "set", "fruehstueckGeheim/fruehstueck-aktuell/adminPinHash", H, "host", true);
  F("Frühstück", "DARF NICHT (A3-06): Teilnehmer legt Hash für fremden Plan an", ohneF(weltF()), "set", "fruehstueckGeheim/fruehstueck-aktuell/adminPinHash", H, "u2", false);
  F("Frühstück", "DARF NICHT (A3-06): Hash vor dem Anlegen besetzen (kein Plan, live-Fall)", ohneF(weltF(true)), "set", "fruehstueckGeheim/fruehstueck-aktuell/adminPinHash", H, "u2", false);
  F("Frühstück", "MUSS (A3-06, Altbestand): Hash für Plan mit Klartext-PIN", (() => { const w = ohneF(weltF()); w.fruehstueck.aktuell.meta.adminPin = "123456"; return w; })(), "set", "fruehstueckGeheim/fruehstueck-aktuell/adminPinHash", H, "u2", true);

  const ohneE = (w) => { delete w.essenGeheim; delete w.essenPinProbe; return w; };
  F("Essen", "MUSS (A3-06): anlegendes Gerät hinterlegt den Hash nach meta", ohneE(weltE()), "set", "essenGeheim/essen-aktuell/adminPinHash", H, "host", true);
  F("Essen", "DARF NICHT (A3-06): Teilnehmer legt Hash für fremden Plan an", ohneE(weltE()), "set", "essenGeheim/essen-aktuell/adminPinHash", H, "u2", false);
  F("Essen", "DARF NICHT (A3-06): Hash vor dem Anlegen besetzen (kein Plan)", ohneE(weltE(true)), "set", "essenGeheim/essen-aktuell/adminPinHash", H, "u2", false);
}

/* ---------- A3-07 (Fixprüfung 26.09.2026): Essens-Altbestand ohne `orga`-Feld ----------
   Bestellungen von vor dem 04.09. haben kein Feld `orga`. Der Client schreibt beim Ändern
   immer ein Boolean (`orga: false`); die Regel verlangte Gleichheit mit dem alten Wert (null)
   und wies den Besteller ab. Jetzt darf aus „fehlt“ ein `false` werden – nie ein `true`.
   Eine `rundeId` auf eine gelöschte Runde bleibt für den Besteller gesperrt (der Client
   bietet dort seit A3-07 kein Ändern/Stornieren mehr an). */
{
  const E = "essen/aktuell", O = E + "/bestellungen/";
  const pos = { a: { gerichtId: "g1", nummer: "1", name: "Margherita", sonderwunsch: "", anzahl: 1, preisCent: 800, sort: 0 } };
  const altbestand = (w) => { w.essen.aktuell.bestellungen.o4 = { uid: "u1", name: "U1", status: "neu", positionen: { a: { name: "Margherita", anzahl: 1, preisCent: 800 } }, erstelltAm: 8 }; };
  const weltAlt = () => { const w = weltE(); altbestand(w); return w; };
  F("Essen", "MUSS (A3-07): Altbestand ohne orga-Feld ändern, Client schreibt orga:false (es:esBestelle)", weltAlt(), "set", O + "o4", { uid: "u1", name: "U1", orga: false, status: "neu", rundeId: null, notiz: "", positionen: pos, erstelltAm: 8, aktualisiertAm: TS }, "u1", true);
  F("Essen", "DARF NICHT (A3-07): Altbestand ohne orga-Feld auf orga:true (kostenlos) ändern", weltAlt(), "set", O + "o4", { uid: "u1", name: "U1", orga: true, status: "neu", rundeId: null, notiz: "", positionen: pos, erstelltAm: 8, aktualisiertAm: TS }, "u1", false);
  F("Essen", "DARF NICHT (A3-07): fremder Altbestand bleibt fremd", weltAlt(), "set", O + "o4", { uid: "u1", name: "U1", orga: false, status: "neu", rundeId: null, notiz: "", positionen: pos, erstelltAm: 8, aktualisiertAm: TS }, "u2", false);
  F("Essen", "MUSS: Altbestand stornieren (war schon erlaubt)", weltAlt(), "update", E, { "bestellungen/o4": null }, "u1", true);
  F("Essen", "DARF NICHT: Besteller ändert Bestellung mit rundeId auf gelöschte Runde (Client sperrt seit A3-07)", (() => { const w = weltE(); w.essen.aktuell.bestellungen.o5 = { uid: "u1", name: "U1", orga: false, status: "neu", rundeId: "weg", positionen: { a: { name: "Margherita", anzahl: 1, preisCent: 800 } }, erstelltAm: 9 }; return w; })(), "update", E, { "bestellungen/o5": null }, "u1", false);
  F("Essen", "MUSS: Verwaltung holt sie aus der verschwundenen Runde zurück (esNimmAusRunde)", (() => { const w = weltE(); w.essen.aktuell.bestellungen.o5 = { uid: "u1", name: "U1", orga: false, status: "neu", rundeId: "weg", positionen: { a: { name: "Margherita", anzahl: 1, preisCent: 800 } }, erstelltAm: 9 }; return w; })(), "update", E, { "bestellungen/o5/rundeId": null, "bestellungen/o5/status": "neu", "bestellungen/o5/aktualisiertAm": TS }, "pin", true);
}

/* ---------- A3-08 (Fixprüfung 26.09.2026): keine Zusatzfelder im Turnierbaum ----------
   Jeder Client liest turniere/_index ganz und hängt je Eintrag einen Horcher auf das Turnier.
   Wer ein eigenes Turnier anlegt (oder sich einschreibt), konnte dort beliebig viel ablegen. */
{
  const R = "turniere/T1";
  const metaNeu = { name: "Neu", erstelltAm: TS, hostId: "neu", phase: "anmeldung", teamGroesse: 2, ablauf: "gruppen_ko", formatOffen: true, bestOf: 3, anzahlGruppen: 2, weiterProGruppe: 2, punkteSieg: 3, siegerTeamId: null };
  F("Turnier", "MUSS (A3-08): Turnier anlegen mit allen Feldern von erstelleTurnier", weltT("ko"), "set", "turniere/T9/meta", metaNeu, "neu", true);
  F("Turnier", "DARF NICHT (A3-08): neues Turnier mit Zusatzfeld in meta", weltT("ko"), "set", "turniere/T9/meta", Object.assign({}, metaNeu, { muell: "x".repeat(100) }), "neu", false);
  F("Turnier", "DARF NICHT (A3-08): Index-Eintrag mit Zusatzfeld", weltT("ko"), "set", "turniere/_index/T9", { name: "Neu", erstelltAm: TS, muell: "x" }, "neu", false);
  F("Turnier", "DARF NICHT (A3-08): Verwaltung legt Zusatzfeld in meta ab", weltT("ko"), "set", R + "/meta/muell", "x", "host", false);
  F("Turnier", "DARF NICHT (A3-08): Verwaltung schreibt 5000 Zeichen in meta.ablauf", weltT("anmeldung"), "set", R + "/meta/ablauf", "x".repeat(5000), "host", false);
  F("Turnier", "MUSS: Verwaltung stellt Stellschrauben beim Auslosen (ts:gemeinsameLosMeta)", weltT("teams"), "update", R, { "meta/bestOf": 3, "meta/bestOfFinale": 5, "meta/punkteSieg": 3, "meta/tiebreak": "buchholz", "meta/koTyp": "doppel", "meta/bracketReset": true, "meta/spielUmPlatz3": false, "meta/doppelrunde": false, "meta/spieltage": true, "meta/schweizerRunden": null, "meta/weiterInsgesamt": 4, "meta/setzlisteManuell": true }, "pin", true);
  F("Turnier", "MUSS: Zeitplan in meta merken (ts:erzeugeZeitplan)", weltT("gruppen"), "update", R, { "meta/zeitplan": { startDatum: "2026-10-01", startZeit: "10:00", dauerMin: 60, pauseMin: 10, gleichzeitig: 2, tagesEnde: "02:00" } }, "host", true);
  F("Turnier", "DARF NICHT (A3-08): Zusatzfeld im Zeitplan", weltT("gruppen"), "update", R, { "meta/zeitplan": { startDatum: "2026-10-01", startZeit: "10:00", muell: "x" } }, "host", false);
  F("Turnier", "DARF NICHT (A3-08): Teilnehmer schreibt Zusatzfeld in seinen Spieler-Eintrag", weltT("anmeldung"), "set", R + "/spieler/x1", { name: "X", rating: 1300, beigetretenAm: TS, muell: "x".repeat(100) }, "x1", false);
  F("Turnier", "MUSS: Testspieler anlegen (Verwaltung, name/rating/beigetretenAm)", weltT("anmeldung"), "update", R, { "spieler/test_a_0": { name: "Testspieler 1", rating: 1200, beigetretenAm: 1789000000000 } }, "pin", true);
  F("Turnier", "DARF NICHT (A3-08): Verwaltung legt Zusatzfeld in eine Gruppe", weltT("teams"), "update", R, { gruppen: { gA: { name: "A", teamIds: { tA: true }, muell: "x" } } }, "host", false);
  F("Turnier", "DARF NICHT (A3-08): Spieltag-Datum als freier Text", weltT("gruppen"), "set", R + "/spieltagDaten/1", "irgendwann", "host", false);
  F("Turnier", "DARF NICHT (A3-08): Zusatzfeld an einem Team", weltT("teams"), "set", R + "/teams/tA/muell", "x", "host", false);
  F("Turnier", "DARF NICHT (A3-08): Zusatzfeld an einem neuen K.-o.-Spiel (Teilnehmer)", weltT("ko"), "update", R, { "spiele/ko_r1_p0": { phase: "ko", bracket: "w", runde: 1, position: 0, teamA: "tA", teamB: "tB", status: "offen", istFinale: true, muell: "x" } }, "b1", false);
}

/* ---------- agelan-Rolle (26.09.2026, Variante B): ⭐/🛠 per Claim, ohne PIN ----------
   Der Worker stellt fuer das Konto ein Custom Token mit agelanOrga/agelanBis aus (dieselbe uid).
   Mit gueltigem Claim ist man in ALLEN Bereichen Verwaltung - ohne hostId und ohne PIN-Beweis.
   Abgelaufen, falsch getypt oder fehlend: wie bisher (PIN-Weg). */
{
  const R = "turniere/T1", S = R + "/spiele/";
  const ohneT = (w) => { delete w.turniere.T1.meta.hostId; delete w.turnierGeheim; delete w.turnierPinProbe; };
  const faelleT = [
    ["korrigiert ein bestätigtes Ergebnis", () => weltT("ko"), "update", S + "g3", { saetzeA: 0, saetzeB: 2, status: "bestaetigt", gemeldetVon: "admin" }],
    ["löscht das Turnier", () => weltT("ko"), "set", R, null],
    ["löscht den Index-Eintrag, solange das Turnier steht", () => weltT("ko"), "set", "turniere/_index/T1", null],
    ["legt den Hash für ein Turnier ohne Hash an", () => weltT("anmeldung", ohneT), "set", "turnierGeheim/T1/adminPinHash", H],
    ["wechselt den PIN ohne Beweis", () => weltT("anmeldung"), "set", "turnierGeheim/T1/adminPinHash", "0".repeat(64)],
  ];
  for (const [text, welt, art, pfad, wert] of faelleT) {
    F("Turnier", "MUSS (Rolle): Claim gültig " + text, welt(), art, pfad, wert, "orgaClaim", true);
    F("Turnier", "DARF NICHT (Rolle): Claim abgelaufen " + text, welt(), art, pfad, wert, "orgaAbgelaufen", false);
    F("Turnier", "DARF NICHT (Rolle): agelanOrga als Text " + text, welt(), art, pfad, wert, "orgaFalsch", false);
  }
  const P = "streamplan/aktuell";
  F("Stream", "MUSS (Rolle): Claim gültig legt Programm an", weltS(), "update", P + "/programm/p9", { datum: "2026-10-02", von: 600, bis: 700, titel: "Show", notiz: "", streamerNoetig: true, erstelltAm: TS }, "orgaClaim", true);
  F("Stream", "MUSS (Rolle): Claim gültig löscht den Plan", weltS(), "set", P, null, "orgaClaim", true);
  F("Stream", "DARF NICHT (Rolle): Claim abgelaufen leert Slots", weltS(), "set", P + "/slots", null, "orgaAbgelaufen", false);
  const B = "fruehstueck/aktuell/bestellungen/2026-10-02/";
  F("Frühstück", "MUSS (Rolle): Claim gültig hakt „bezahlt“ ab", weltF(), "set", B + "u1/bezahlt", true, "orgaClaim", true);
  F("Frühstück", "MUSS (Rolle): Claim gültig legt Hash an (Plan ohne Hash)", (() => { const w = weltF(); delete w.fruehstueckGeheim; delete w.fruehstueckPinProbe; return w; })(), "set", "fruehstueckGeheim/fruehstueck-aktuell/adminPinHash", H, "orgaClaim", true);
  F("Frühstück", "DARF NICHT (Rolle): Claim abgelaufen hakt ab", weltF(), "set", B + "u1/bezahlt", true, "orgaAbgelaufen", false);
  const E = "essen/aktuell";
  F("Essen", "MUSS (Rolle): Claim gültig setzt Status", weltE(), "update", E + "/bestellungen/o3", { status: "bezahlt", aktualisiertAm: TS }, "orgaClaim", true);
  F("Essen", "MUSS (Rolle): Claim gültig liest Telefon/Lieferanten-Mail", weltE(), "lesen", "essenOrga/aktuell", null, "orgaClaim", true);
  F("Essen", "MUSS (Rolle): Claim gültig schreibt Telefon/Lieferanten-Mail", weltE(), "set", "essenOrga/aktuell", { bestellerTelefon: "0000 5555", lieferantEmail: "x@example.org" }, "orgaClaim", true);
  F("Essen", "MUSS (Rolle): Claim gültig wechselt den Essens-PIN ohne Beweis", weltE(), "set", "essenGeheim/essen-aktuell/adminPinHash", "0".repeat(64), "orgaClaim", true);
  F("Essen", "DARF NICHT (Rolle): Claim abgelaufen liest Telefon", weltE(), "lesen", "essenOrga/aktuell", null, "orgaAbgelaufen", false);
  F("Essen", "DARF NICHT (Rolle): agelanOrga als Text liest Telefon", weltE(), "lesen", "essenOrga/aktuell", null, "orgaFalsch", false);
  F("Essen", "DARF NICHT (Rolle): Telefon auch mit Claim nicht zurück ins lesbare meta", weltE(), "update", E + "/meta", { bestellerTelefon: "0000 6666" }, "orgaClaim", false);
  F("Essen", "MUSS (Rolle): Claim gültig löscht eine Bestellung aus einer Runde", weltE(), "update", E, { "bestellungen/o2": null, "runden/r1": null }, "orgaClaim", true);
  // Probe-Knoten: der Client liest ihn, um zu wissen, ob die eingespielten Regeln den Claim kennen.
  F("Rolle", "MUSS: rolleProbe mit gültigem Claim lesbar", weltT("ko"), "lesen", "rolleProbe", null, "orgaClaim", true);
  F("Rolle", "DARF NICHT: rolleProbe mit abgelaufenem Claim", weltT("ko"), "lesen", "rolleProbe", null, "orgaAbgelaufen", false);
  F("Rolle", "DARF NICHT: rolleProbe ohne Claim (Teilnehmer, auch Verwaltung per PIN)", weltT("ko"), "lesen", "rolleProbe", null, "pin", false);
  F("Rolle", "DARF NICHT: rolleProbe ohne Anmeldung", weltT("ko"), "lesen", "rolleProbe", null, null, false);
  F("Rolle", "DARF NICHT: rolleProbe beschreiben (auch mit Claim)", weltT("ko"), "set", "rolleProbe", "x", "orgaClaim", false);
}

/* ======================================================================
   Lauf
   ====================================================================== */
function pruefeAlle(regeln) {
  const rot = [];
  for (const [b, text, welt, art, pfad, wert, uid, soll] of faelle) {
    const ist = art === "lesen" ? darfLesen(regeln, welt, pfad, uid) : art === "update" ? darfUpdate(regeln, welt, pfad, wert, uid) : darfSetzen(regeln, welt, pfad, wert, uid);
    if (ist !== soll) rot.push(b + " | " + text + " (soll " + soll + ", ist " + ist + ")");
  }
  return rot;
}
let fehler = 0;
for (const [b, text, welt, art, pfad, wert, uid, soll] of faelle) {
  const ist = art === "lesen" ? darfLesen(ORIGINAL, welt, pfad, uid) : art === "update" ? darfUpdate(ORIGINAL, welt, pfad, wert, uid) : darfSetzen(ORIGINAL, welt, pfad, wert, uid);
  const ok = ist === soll;
  if (!ok) fehler++;
  console.log((ok ? "  OK   " : "  FEHL ") + b.padEnd(10) + " " + text + (ok ? "" : "   (erwartet " + soll + ", ist " + ist + ")"));
}
if (unbekannt.length) {
  fehler += unbekannt.length;
  console.log("\n  FEHL  der Auswerter versteht " + unbekannt.length + " Ausdruck/Ausdrücke nicht:");
  for (const u of Array.from(new Set(unbekannt)).slice(0, 10)) console.log("        " + u);
}

console.log("\n=== Selbsttest (jede Mutation muss mindestens eine Zusage rot machen) ===\n");
const mutationen = [
  ["Turnier wieder für jeden Angemeldeten (Stand vor E5)", (r) => { r.turniere.$tid[".write"] = "auth != null"; }],
  ["Turnier-Spiel ohne Teamprüfung", (r) => { r.turniere.$tid.spiele.$sid[".write"] = "auth != null"; }],
  ["Verwaltung ohne Hash-Existenz (null === null)", (r) => { r.turniere.$tid[".write"] = r.turniere.$tid[".write"].replace("root.child('turnierGeheim/' + $tid + '/adminPinHash').exists() && ", ""); }],
  ["Turnier ohne Feld-Liste (Stand vor 26.09., B2-15)", (r) => { delete r.turniere.$tid.$sonst; }],
  ["Sieger mehrfach setzbar", (r) => { r.turniere.$tid.meta.siegerTeamId[".write"] = r.turniere.$tid.meta.siegerTeamId[".write"].replace("!data.exists() && ", ""); }],
  ["Streamplan wieder für jeden (Stand vor E5)", (r) => { r.streamplan.$pid[".write"] = "auth != null"; }],
  ["Stream-Slot ohne uid-Bindung", (r) => { r.streamplan.$pid.slots.$sid[".write"] = "auth != null"; }],
  ["Frühstück wieder für jeden (Stand vor E5)", (r) => { r.fruehstueck.$pid[".write"] = "auth != null"; }],
  ["Frühstücks-Bestellung ohne Haken-Schutz", (r) => { r.fruehstueck.$pid.bestellungen.$datum.$uid[".write"] = "auth != null && $uid === auth.uid"; }],
  ["Essen wieder für jeden (Stand vor E5)", (r) => { r.essen.$pid[".write"] = "auth != null"; }],
  ["Essens-Bestellung ohne uid-Bindung", (r) => { r.essen.$pid.bestellungen.$oid[".write"] = "auth != null"; }],
  ["Orga-Knoten für jeden Angemeldeten lesbar", (r) => { r.essenOrga.$pid[".read"] = "auth != null"; }],
  ["Telefon wieder in meta erlaubt (Stand vor E5)", (r) => { r.essen.$pid.meta.bestellerTelefon[".validate"] = "newData.isString() && newData.val().length <= 40"; }],
  ["PIN-Hash wieder für jeden neu anlegbar (Stand vor A3-06)", (r) => {
    for (const [g, pr, v] of [["turnierGeheim", "turnierPinProbe", "$tid"], ["streamplanGeheim", "streamplanPinProbe", "$pid"], ["fruehstueckGeheim", "fruehstueckPinProbe", "$pid"], ["essenGeheim", "essenPinProbe", "$pid"]]) {
      r[g][v].adminPinHash[".write"] = "auth != null && (!data.exists() || data.val() === root.child('" + pr + "').child(" + v + ").child(auth.uid).val())";
    }
  }],
  ["Essens-Altbestand ohne orga wieder gesperrt (Stand vor A3-07)", (r) => {
    r.essen.$pid.bestellungen.$oid[".write"] = r.essen.$pid.bestellungen.$oid[".write"].replace(" || (!data.child('orga').exists() && newData.child('orga').val() === false))", ")").replace("(newData.child('orga').val() === data.child('orga').val())", "newData.child('orga').val() === data.child('orga').val()");
  }],
  ["Turnierbaum ohne Feldlisten (Stand vor A3-08)", (r) => {
    delete r.turniere._index.$id.$sonst; delete r.turniere.$tid.meta.$sonst; delete r.turniere.$tid.meta.zeitplan.$sonst;
    delete r.turniere.$tid.spieler.$uid.$sonst; delete r.turniere.$tid.teams.$team.$sonst; delete r.turniere.$tid.spiele.$sid.$sonst;
    delete r.turniere.$tid.gruppen.$gid.$sonst;
  }],
  ["Rolle ohne Ablaufzeit (nur agelanOrga)", (r) => {
    const s = JSON.stringify(r).split(" && auth.token.agelanBis > now").join("");
    Object.assign(r, JSON.parse(s));
  }],
  ["Rolle fuer jeden Angemeldeten (Claim-Pruefung weg)", (r) => {
    const s = JSON.stringify(r).split("(auth.token.agelanOrga === true && auth.token.agelanBis > now)").join("(auth != null)");
    Object.assign(r, JSON.parse(s));
  }],
  ["Altbestand-Umzug gesperrt (nur hostId)", (r) => {
    r.turnierGeheim.$tid.adminPinHash[".write"] = r.turnierGeheim.$tid.adminPinHash[".write"].replace(" || root.child('turniere/' + $tid + '/meta/adminPin').exists()", "");
  }],
];
let blind = 0;
for (const [name, aendere] of mutationen) {
  const r = JSON.parse(JSON.stringify(ORIGINAL));
  let rot;
  try { aendere(r); rot = pruefeAlle(r); } catch (e) { rot = null; }
  if (rot === null) { console.log("  ??   " + name + "  (Regel nicht gefunden — Rules umgebaut? Mutation anpassen)"); blind++; continue; }
  const ok = rot.length > 0;
  if (!ok) blind++;
  console.log((ok ? "  OK   " : "  BLIND ") + name + (ok ? "  → " + rot.length + " rot, z. B. " + rot[0] : "  → NICHTS rot"));
}
fehler += blind;
console.log("\n" + (fehler ? fehler + " FEHLER" : "alle " + faelle.length + " Zusagen erfüllt, Selbsttest " + mutationen.length + "/" + mutationen.length + " schlägt an") + "  (Quelle: " + DATEI + ")");
process.exit(fehler ? 1 : 0);
