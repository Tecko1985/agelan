// ===========================================================================
// turnier-service.js – Firebase-Kapsel & komplette Turnierlogik für Agelan.
//
// app.js redet ausschließlich über die turnierService-API (unten) und nie direkt
// mit Firebase. getZustand() liefert einen fertig aufbereiteten UI-Zustand
// (inkl. berechneter Gruppentabellen und K.o.-Bracket); onZustandsAenderung()
// meldet jede Live-Änderung.
//
// Datenmodell (Realtime Database, ein aktives Turnier unter turniere/aktuell):
//   meta    : { name, erstelltAm, hostId, adminPin, phase, bestOf,
//               anzahlGruppen, weiterProGruppe, punkteSieg, siegerTeamId }
//   spieler/$uid  : { name, rating, beigetretenAm }
//   teams/$teamId : { name, ratingSchnitt, mitglieder:{uid:true}, gruppe }
//   gruppen/$gid  : { name, teamIds:{teamId:true} }
//   spiele/$sid   : { phase:"gruppe"|"ko", gruppe?, runde?, position?,
//                     teamA, teamB, saetzeA, saetzeB, status, gemeldetVon }
//
// Phasen: anmeldung -> teams -> gruppen -> ko -> beendet
// ===========================================================================

const TURNIER_ID = "aktuell";
const BASIS = "turniere/" + TURNIER_ID;

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

// --- Admin-Status ----------------------------------------------------------
function gespeicherterAdminPin() {
  try {
    return localStorage.getItem(ADMIN_PIN_KEY);
  } catch (e) {
    return null;
  }
}

function istAdmin() {
  if (!letzterZustand || !letzterZustand.meta) return false;
  const meta = letzterZustand.meta;
  if (meta.hostId && meta.hostId === eigeneUid) return true;
  return !!meta.adminPin && gespeicherterAdminPin() === meta.adminPin;
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
  const punkteSieg = meta.punkteSieg || 3;
  const zeilen = {};
  gruppenTeamIds.forEach((tid) => {
    zeilen[tid] = {
      teamId: tid,
      name: teamAnzeigename(tid, teams),
      spiele: 0, siege: 0, niederlagen: 0,
      saetzePlus: 0, saetzeMinus: 0, punkte: 0,
    };
  });

  const bestaetigte = spiele.filter(
    (s) => s.phase === "gruppe" && s.status === "bestaetigt" && zeilen[s.teamA] && zeilen[s.teamB]
  );

  bestaetigte.forEach((s) => {
    const a = zeilen[s.teamA], b = zeilen[s.teamB];
    a.spiele++; b.spiele++;
    a.saetzePlus += s.saetzeA; a.saetzeMinus += s.saetzeB;
    b.saetzePlus += s.saetzeB; b.saetzeMinus += s.saetzeA;
    if (s.saetzeA > s.saetzeB) { a.siege++; a.punkte += punkteSieg; b.niederlagen++; }
    else { b.siege++; b.punkte += punkteSieg; a.niederlagen++; }
  });

  const direktesDuell = (x, y) => {
    const s = bestaetigte.find(
      (m) => (m.teamA === x && m.teamB === y) || (m.teamA === y && m.teamB === x)
    );
    if (!s) return 0;
    const xSaetze = s.teamA === x ? s.saetzeA : s.saetzeB;
    const ySaetze = s.teamA === x ? s.saetzeB : s.saetzeA;
    return ySaetze - xSaetze; // >0 wenn y besser -> x weiter unten
  };

  return Object.values(zeilen).sort((a, b) => {
    if (b.punkte !== a.punkte) return b.punkte - a.punkte;
    const dA = a.saetzePlus - a.saetzeMinus, dB = b.saetzePlus - b.saetzeMinus;
    if (dB !== dA) return dB - dA;
    if (b.saetzePlus !== a.saetzePlus) return b.saetzePlus - a.saetzePlus;
    const dd = direktesDuell(a.teamId, b.teamId);
    if (dd !== 0) return dd;
    return a.name.localeCompare(b.name);
  });
}

function gruppenMitTabellen(teams, spiele, meta) {
  const roh = (letzterZustand && letzterZustand.gruppen) || {};
  return Object.keys(roh)
    .map((gid) => {
      const teamIds = Object.keys(roh[gid].teamIds || {});
      return {
        id: gid,
        name: roh[gid].name,
        teamIds,
        tabelle: berechneTabelle(teamIds, teams, spiele, meta),
        spiele: spiele.filter((s) => s.phase === "gruppe" && s.gruppe === roh[gid].name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// K.o.-Bracket (Runden -> Matches) für die Anzeige.
function baueBracket(teams, spiele, meta) {
  const koSpiele = spiele.filter((s) => s.phase === "ko");
  if (koSpiele.length === 0) return null;
  const rundenNummern = [...new Set(koSpiele.map((s) => s.runde))].sort((a, b) => a - b);
  const runden = rundenNummern.map((r) => {
    const matches = koSpiele
      .filter((s) => s.runde === r)
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        id: s.id,
        teamA: s.teamA, teamB: s.teamB || null,
        teamAName: s.teamA ? teamAnzeigename(s.teamA, teams) : "—",
        teamBName: s.teamB ? teamAnzeigename(s.teamB, teams) : (s.teamA ? "Freilos" : "—"),
        saetzeA: s.saetzeA, saetzeB: s.saetzeB,
        status: s.status, gemeldetVon: s.gemeldetVon || null,
        siegerTeamId: s.status === "bestaetigt" ? matchSieger(s) : null,
      }));
    return { runde: r, name: rundenTitel(matches.length), matches };
  });
  return { runden, siegerTeamId: meta.siegerTeamId || null };
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
    vorhanden,
    phase: vorhanden ? meta.phase : null,
    meta,
    istAdmin: istAdmin(),
    spieler,
    eigenerSpieler: spieler.find((s) => s.id === eigeneUid) || null,
    teams,
    eigenesTeam,
    gruppen: gruppenMitTabellen(teams, spiele, meta),
    spiele,
    bracket: baueBracket(teams, spiele, meta),
  };
}

function benachrichtige() {
  if (listener) listener(getZustand());
}

function onZustandsAenderung(callback) {
  listener = callback;
  authBereit.then(() => {
    turnierRef = db.ref(BASIS);
    turnierRef.on("value", (snap) => {
      letzterZustand = snap.val();
      benachrichtige();
    });
  });
}

// ===========================================================================
// Aktionen
// ===========================================================================

// --- Turnier anlegen (Admin) ----------------------------------------------
async function erstelleTurnier({ name, bestOf, anzahlGruppen, weiterProGruppe, adminPin }) {
  await authBereit;
  if (!name || !name.trim()) return { erfolg: false, fehler: "Bitte einen Turniernamen eingeben." };
  if (!adminPin || !String(adminPin).trim()) return { erfolg: false, fehler: "Bitte einen Admin-PIN festlegen." };
  if (letzterZustand && letzterZustand.meta) {
    return { erfolg: false, fehler: "Es läuft bereits ein Turnier. Erst zurücksetzen." };
  }
  const pin = String(adminPin).trim();
  await db.ref(BASIS + "/meta").set({
    name: name.trim(),
    erstelltAm: firebase.database.ServerValue.TIMESTAMP,
    hostId: eigeneUid,
    adminPin: pin,
    phase: "anmeldung",
    bestOf: [3, 5, 7].includes(Number(bestOf)) ? Number(bestOf) : 3,
    anzahlGruppen: Math.max(1, Math.min(8, Number(anzahlGruppen) || 2)),
    weiterProGruppe: Math.max(1, Math.min(4, Number(weiterProGruppe) || 2)),
    punkteSieg: 3,
    siegerTeamId: null,
  });
  try { localStorage.setItem(ADMIN_PIN_KEY, pin); } catch (e) {}
  return { erfolg: true };
}

// --- als Admin auf einem weiteren Gerät anmelden --------------------------
function authentifiziereAlsAdmin(pin) {
  if (!letzterZustand || !letzterZustand.meta) return { erfolg: false, fehler: "Kein Turnier vorhanden." };
  if (String(pin).trim() !== letzterZustand.meta.adminPin) {
    return { erfolg: false, fehler: "Falscher PIN." };
  }
  try { localStorage.setItem(ADMIN_PIN_KEY, String(pin).trim()); } catch (e) {}
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
  await db.ref(BASIS + "/spieler/" + eigeneUid).set({
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
  await db.ref(BASIS + "/spieler/" + eigeneUid + "/rating").set(r);
  return { erfolg: true };
}

async function meldeAb() {
  await authBereit;
  if (!letzterZustand || !letzterZustand.meta || letzterZustand.meta.phase !== "anmeldung") {
    return { erfolg: false, fehler: "Abmelden nicht mehr möglich." };
  }
  await db.ref(BASIS + "/spieler/" + eigeneUid).remove();
  return { erfolg: true };
}

// --- Teams bilden (Admin) --------------------------------------------------
// Balanced-Pairing: sortiert nach Rating, paart Bester+Schlechtester. Bei
// ungerader Zahl bekommt das schwächste Paar einen dritten Spieler (3er-Team).
function balancedPaare(spieler) {
  const sortiert = [...spieler].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const paare = [];
  let i = 0, j = sortiert.length - 1;
  while (i < j) { paare.push([sortiert[i], sortiert[j]]); i++; j--; }
  if (i === j) {
    const rest = sortiert[i];
    if (paare.length === 0) { paare.push([rest]); }
    else {
      let minIdx = 0, minSumme = Infinity;
      paare.forEach((p, idx) => {
        const s = p.reduce((sum, sp) => sum + (sp.rating || 0), 0);
        if (s < minSumme) { minSumme = s; minIdx = idx; }
      });
      paare[minIdx].push(rest);
    }
  }
  return paare;
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

async function bildeTeams() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter kann Teams bilden." };
  const meta = letzterZustand.meta;
  if (!["anmeldung", "teams"].includes(meta.phase)) return { erfolg: false, fehler: "Falsche Phase." };
  const spieler = spielerListe();
  if (spieler.length < 4) return { erfolg: false, fehler: "Mindestens 4 Spieler nötig (für 2 Teams)." };

  const teams = paareZuTeamsObjekt(balancedPaare(spieler));
  await db.ref(BASIS).update({
    teams: teams,
    "meta/phase": "teams",
  });
  return { erfolg: true };
}

// Zwei Spieler zwischen ihren Teams tauschen (Admin, Phase "teams").
async function tauscheSpieler(uidA, uidB) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  if (letzterZustand.meta.phase !== "teams") return { erfolg: false, fehler: "Nur in der Team-Phase möglich." };
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

  await db.ref(BASIS).update({
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
  const sortiert = [...teams].sort((a, b) => (b.ratingSchnitt || 0) - (a.ratingSchnitt || 0));
  const buckets = Array.from({ length: anzahlGruppen }, () => []);
  for (let start = 0; start < sortiert.length; start += anzahlGruppen) {
    const topf = mischeArray(sortiert.slice(start, start + anzahlGruppen));
    topf.forEach((team, i) => buckets[i].push(team.id));
  }
  return buckets;
}

async function loseGruppen(modus) {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  const meta = letzterZustand.meta;
  if (meta.phase !== "teams") return { erfolg: false, fehler: "Erst Teams bilden." };
  const teams = teamListe();
  if (teams.length < 2) return { erfolg: false, fehler: "Zu wenige Teams." };

  const anzahlGruppen = Math.min(meta.anzahlGruppen || 2, teams.length);
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
    // Round-Robin: jede Paarung genau einmal
    for (let a = 0; a < teamIds.length; a++) {
      for (let b = a + 1; b < teamIds.length; b++) {
        const sid = `g_${gName}_${a}_${b}`;
        updates["spiele"][sid] = {
          phase: "gruppe", gruppe: gName,
          teamA: teamIds[a], teamB: teamIds[b],
          saetzeA: null, saetzeB: null,
          status: "offen", gemeldetVon: null,
        };
      }
    }
  });
  updates["meta/phase"] = "gruppen";
  await db.ref(BASIS).update(updates);
  return { erfolg: true };
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
  const v = validiereSaetze(saetzeA, saetzeB, meta.bestOf);
  if (!v.ok) return { erfolg: false, fehler: v.fehler };

  const meinTeamId = rolle.team ? rolle.team.id : (istAdmin() ? "admin" : null);
  await db.ref(BASIS + "/spiele/" + spielId).update({
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
  await db.ref(BASIS + "/spiele/" + spielId + "/status").set("bestaetigt");
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
  await db.ref(BASIS + "/spiele/" + spielId).update({
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
  const v = validiereSaetze(saetzeA, saetzeB, letzterZustand.meta.bestOf);
  if (!v.ok) return { erfolg: false, fehler: v.fehler };
  await db.ref(BASIS + "/spiele/" + spielId).update({
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

  const teams = teamListe();
  const spiele = spielListe();
  const gruppen = gruppenMitTabellen(teams, spiele, meta).sort((a, b) => a.name.localeCompare(b.name));
  const weiter = Math.min(meta.weiterProGruppe || 2, Math.max(...gruppen.map((g) => g.teamIds.length)));

  // Qualifizierte einsammeln: platz-major (alle Platz 1, dann alle Platz 2, ...)
  const qualifizierte = [];
  for (let platz = 0; platz < weiter; platz++) {
    gruppen.forEach((g, gi) => {
      if (g.tabelle[platz]) qualifizierte.push({ teamId: g.tabelle[platz].teamId, gruppenIndex: gi, platz });
    });
  }
  if (qualifizierte.length < 2) return { erfolg: false, fehler: "Zu wenige qualifizierte Teams." };

  const bracketGroesse = naechsteZweierpotenz(qualifizierte.length);
  const seedReihenfolge = bracketSeedReihenfolge(bracketGroesse); // 1-basierte Seeds
  // Seed i (1-basiert) -> qualifizierte[i-1] oder null (Freilos)
  const teamFuerSeed = (seed) => (seed <= qualifizierte.length ? qualifizierte[seed - 1].teamId : null);

  const updates = {};
  const matches = bracketGroesse / 2;
  for (let p = 0; p < matches; p++) {
    const seedA = seedReihenfolge[p * 2];
    const seedB = seedReihenfolge[p * 2 + 1];
    let teamA = teamFuerSeed(seedA);
    let teamB = teamFuerSeed(seedB);
    // Falls A ein Freilos ist, B nach vorne ziehen
    if (!teamA && teamB) { teamA = teamB; teamB = null; }
    const sid = `ko_r0_p${p}`;
    const istFreilos = teamA && !teamB;
    updates["spiele/" + sid] = {
      phase: "ko", runde: 0, position: p,
      teamA: teamA, teamB: teamB,
      saetzeA: null, saetzeB: null,
      status: istFreilos ? "bestaetigt" : "offen",
      gemeldetVon: null,
    };
  }
  updates["meta/phase"] = "ko";
  await db.ref(BASIS).update(updates);
  await pruefeKoProgression(); // falls Freilose sofort die nächste Runde erlauben
  return { erfolg: true };
}

// Nach jedem bestätigten K.o.-Ergebnis: ist die aktuelle Runde komplett, wird
// die nächste erzeugt (bzw. der Sieger festgestellt). Deterministisch + mit
// Existenz-Guard, damit mehrere Clients es gefahrlos anstoßen können.
async function pruefeKoProgression() {
  const snap = await db.ref(BASIS).once("value");
  const zustand = snap.val();
  if (!zustand || !zustand.meta || zustand.meta.phase !== "ko") return;
  const spiele = Object.keys(zustand.spiele || {}).map((sid) => ({ id: sid, ...zustand.spiele[sid] }));
  const koSpiele = spiele.filter((s) => s.phase === "ko");
  if (koSpiele.length === 0) return;

  const maxRunde = Math.max(...koSpiele.map((s) => s.runde));
  const aktuelle = koSpiele.filter((s) => s.runde === maxRunde).sort((a, b) => a.position - b.position);
  const alleBestaetigt = aktuelle.every((s) => s.status === "bestaetigt");
  if (!alleBestaetigt) return;

  const sieger = (s) => (!s.teamB ? s.teamA : s.saetzeA > s.saetzeB ? s.teamA : s.teamB);

  if (aktuelle.length === 1) {
    // Finale entschieden
    if (zustand.meta.siegerTeamId) return; // schon gesetzt
    await db.ref(BASIS + "/meta").update({ phase: "beendet", siegerTeamId: sieger(aktuelle[0]) });
    return;
  }

  // Nächste Runde erzeugen, falls noch nicht vorhanden
  const naechste = maxRunde + 1;
  if (koSpiele.some((s) => s.runde === naechste)) return; // Guard: schon angelegt
  const updates = {};
  for (let p = 0; p < aktuelle.length / 2; p++) {
    const sid = `ko_r${naechste}_p${p}`;
    updates["spiele/" + sid] = {
      phase: "ko", runde: naechste, position: p,
      teamA: sieger(aktuelle[p * 2]),
      teamB: sieger(aktuelle[p * 2 + 1]),
      saetzeA: null, saetzeB: null,
      status: "offen", gemeldetVon: null,
    };
  }
  await db.ref(BASIS).update(updates);
}

// Admin-Fallback, falls die Auto-Progression mal nicht griff.
async function naechsteRundeManuell() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await pruefeKoProgression();
  return { erfolg: true };
}

// --- Turnier zurücksetzen (Admin) -----------------------------------------
async function setzeTurnierZurueck() {
  await authBereit;
  if (!istAdmin()) return { erfolg: false, fehler: "Nur der Veranstalter." };
  await db.ref(BASIS).remove();
  return { erfolg: true };
}

// ===========================================================================
const turnierService = {
  RATING_MIN, RATING_MAX, RATING_DEFAULT,
  onZustandsAenderung,
  getZustand,
  erstelleTurnier,
  authentifiziereAlsAdmin,
  tritBei,
  aktualisiereRating,
  meldeAb,
  bildeTeams,
  tauscheSpieler,
  loseGruppen,
  meldeErgebnis,
  bestaetigeErgebnis,
  widersprichErgebnis,
  adminSetzeErgebnis,
  starteKoAuslosung,
  naechsteRundeManuell,
  setzeTurnierZurueck,
  noetigeSaetze,
  getGespeicherterName: () => { try { return localStorage.getItem(NAME_KEY) || ""; } catch (e) { return ""; } },
};
