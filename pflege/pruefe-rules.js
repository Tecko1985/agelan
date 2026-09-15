// Wertet die Firebase-Regeln gegen die ECHTEN Zugriffe aus, die die Dienste
// machen - und gegen die Zugriffe, die sie verhindern sollen.
//
// Der Anlass (Abnahme 04.09.2026): der Essensbereich stand mit ".read": true
// in dieser Datei, genau wie das Turnier-Board darueber. Beim Board ist das
// richtig - dort liegen Spielstaende. Unter essen liegen aber:
//
//   meta.bestellerTelefon   private Handynummer
//   meta.lieferantEmail     Mailadresse
//   meta.adminPin           der PIN, der zum Essens-Admin macht
//                           (essen-service.js:213 vergleicht ihn im Browser)
//   bestellungen/*          wer was gegessen hat, mit Sonderwunsch und Preis
//
// Mit ".read": true holt das jeder mit einem blanken Aufruf der
// Datenbank-Adresse ab - ohne Browser, ohne App, ohne Konto.
//
// ⚠️ "auth != null" ist bewusst KEIN Rechtemodell. Die Anmeldung ist anonym
// (turnier-service.js:67), jede:r auf der Seite besteht sie. Die Zeile kappt
// den Weg von AUSSEN, nicht den von innen - dieselbe Stufe, die hier fuers
// Schreiben schon immer galt. Wer die Bestellungen auch vor den Teilnehmern
// schuetzen will, braucht echte Firebase-Konten statt der anonymen Anmeldung.
// Das ist ein Umbau, kein Regelwechsel.
//
// Firebase-Ausdruecke sind JS-nah: auth, root.child(x).val(), $-Variablen.
// Nachgebaut wird genau so viel, wie diese Regeln benutzen.
const fs = require("fs");

const DATEI = __dirname + "/../database.rules.json";
const REGELN = JSON.parse(fs.readFileSync(DATEI, "utf8")).rules;

// Der Weltzustand, gegen den geprueft wird: ein laufendes Turnier, ein
// Streamplan und ein Essensplan unter essen/aktuell (ES_BASIS).
const HASH_T1 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const HASH_ANDERS = "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752";

// Die Uhr, gegen die die Takt-Regeln gemessen werden. Firebase fuellt `now`
// selbst mit der Serverzeit; hier steht ein fester Wert, damit der Prueflauf
// morgen dasselbe sagt wie heute (Linie wie f-echte-uhr: nie gegen Date.now()).
const JETZT = 1789000000000;

const WELT = {
  turniere: { T1: { meta: { name: "AgeLan" } } },
  // Der Admin-PIN des Turniers liegt NEBEN dem Turnierbaum, nicht darin:
  // turniere/$tid traegt ".read": true, und ein Leserecht laesst sich in
  // Firebase weiter unten nicht wieder wegnehmen. T1 ist eingerichtet, T2
  // ist frisch (noch kein Hash hinterlegt).
  turnierGeheim: { T1: { adminPinHash: HASH_T1 } },
  turnierPinProbe: { T1: { "gast-1": HASH_T1 } },
  // Der Streamkalender geht denselben Weg mit eigenen Knoten.
  streamplan: { P1: { meta: { titel: "Stream" } } },
  streamplanGeheim: { P1: { adminPinHash: HASH_T1 } },
  streamplanPinProbe: { P1: { "gast-1": HASH_T1 } },
  essen: { aktuell: { meta: { hostId: "host-uid", adminPin: "4711" } } },
  // Fruehstueck und Essen gehen seit dem 15.09.2026 denselben Weg wie Turnier
  // und Streamplan: Hash im geschuetzten Knoten, nichts mehr im Klartext.
  fruehstueck: { F1: { meta: { titel: "Fruehstueck" } } },
  fruehstueckGeheim: { F1: { adminPinHash: HASH_T1 } },
  fruehstueckPinProbe: { F1: { "gast-1": HASH_T1 } },
  essenGeheim: { aktuell: { adminPinHash: HASH_T1 } },
  essenPinProbe: { aktuell: { "gast-1": HASH_T1 } },
  // ⚠️ Der Takt ist die Bremse gegen das Durchprobieren des PINs. Ein Beweis
  // geht nur durch, wenn derselbe uid GERADE getaktet hat. "gast-1" hat das,
  // "gast-schnell" hat vor 200 ms getaktet (darf also noch nicht wieder),
  // "gast-alt" vor einer Minute (sein Takt ist abgelaufen).
  turnierPinTakt:     { T1: { "gast-1": JETZT - 200, "gast-schnell": JETZT - 200, "gast-alt": JETZT - 60000 } },
  streamplanPinTakt:  { P1: { "gast-1": JETZT - 200 } },
  fruehstueckPinTakt: { F1: { "gast-1": JETZT - 200 } },
  essenPinTakt:  { aktuell: { "gast-1": JETZT - 200 } }
};

function wert(pfad) {
  return pfad.split("/").reduce((o, t) => (o == null ? null : o[t]), WELT) ?? null;
}

// Firebase erlaubt root.child("a/b") genauso wie root.child("a").child("b").
// Die PIN-Regeln benutzen die zweite Form - der Pruefstand muss sie kennen,
// sonst wirft er und meldet jede Regel als "verboten".
function kindKette(pfad) {
  return {
    child: (weiter) => kindKette(pfad + "/" + weiter),
    val: () => wert(pfad),
    exists: () => wert(pfad) !== null,
  };
}

// Sucht die tiefste Regel des gegebenen Typs entlang des Pfades und sammelt
// dabei die $-Variablen ein. Firebase kaskadiert: eine Erlaubnis weiter oben
// genuegt, eine Verschaerfung weiter unten nimmt sie NICHT zurueck.
function findeRegeln(regeln, pfadTeile, typ) {
  const treffer = [];
  let knoten = regeln;
  const vars = {};
  for (let i = 0; i <= pfadTeile.length; i++) {
    if (knoten && knoten[typ] !== undefined) treffer.push({ ausdruck: knoten[typ], vars: { ...vars } });
    if (i === pfadTeile.length) break;
    const teil = pfadTeile[i];
    if (knoten && knoten[teil] !== undefined) { knoten = knoten[teil]; continue; }
    const platzhalter = knoten ? Object.keys(knoten).find((k) => k.startsWith("$")) : null;
    if (!platzhalter) { knoten = null; break; }
    vars[platzhalter] = teil;
    knoten = knoten[platzhalter];
  }
  return treffer;
}

// ⚠️ Die Schluessel heissen ".read"/".write", nicht "read"/"write". Ohne den
// Punkt findet die Suche NIE eine Regel und meldet alles als verboten - das
// sieht wie ein sicherer Zustand aus und ist nur ein toter Test.
function darf(regeln, pfad, typ, uid, loeschen) {
  const gefunden = findeRegeln(regeln, pfad.split("/"), "." + typ);
  for (const { ausdruck, vars } of gefunden) {
    if (ausdruck === true) return true;
    if (ausdruck === false) continue;
    const auth = uid ? { uid } : null;
    const root = { child: (p) => kindKette(p) };
    // ⚠️ `data` ist der Wert, der JETZT an der Stelle steht - die Regel fuer
    // den PIN-Hash unterscheidet damit "noch keiner da" von "wird ersetzt".
    // Ohne dieses Objekt wirft eval() und `darf()` meldet stumpf false: alles
    // sieht sicher aus, und geprueft ist nichts.
    const data = { exists: () => wert(pfad) !== null, val: () => wert(pfad) };
    const now = JETZT;
    const newData = { exists: () => !loeschen };
    let code = String(ausdruck);
    for (const [name, w] of Object.entries(vars)) {
      code = code.split(name).join(JSON.stringify(w));
    }
    let ok = false;
    try { ok = eval(code); } catch (e) { ok = false; }
    if (ok) return true;
  }
  return false;
}

const faelle = [
  // [Beschreibung, Pfad, read|write, uid, erwartet]

  // --- Das Essen: von aussen zu, von innen offen -------------------------
  ["DARF NICHT: Telefonnummer OHNE Anmeldung", "essen/aktuell/meta/bestellerTelefon", "read", null, false],
  ["DARF NICHT: Lieferanten-Mail OHNE Anmeldung", "essen/aktuell/meta/lieferantEmail", "read", null, false],
  ["DARF NICHT: Admin-PIN OHNE Anmeldung", "essen/aktuell/meta/adminPin", "read", null, false],
  ["DARF NICHT: Bestellungen OHNE Anmeldung", "essen/aktuell/bestellungen", "read", null, false],
  ["DARF NICHT: einzelne Bestellung OHNE Anmeldung", "essen/aktuell/bestellungen/b1/name", "read", null, false],
  ["DARF NICHT: Speisekarte OHNE Anmeldung", "essen/aktuell/karte", "read", null, false],
  ["DARF NICHT: Essen schreiben OHNE Anmeldung", "essen/aktuell/bestellungen/b1", "write", null, false],
  ["DARF NICHT: ganzen Essensplan loeschen OHNE Anmeldung", "essen/aktuell", "write", null, false],

  ["MUSS: Teilnehmer liest die Speisekarte", "essen/aktuell/karte", "read", "gast-1", true],
  ["MUSS: Teilnehmer liest die Bestellliste", "essen/aktuell/bestellungen", "read", "gast-1", true],
  ["MUSS: Teilnehmer bestellt", "essen/aktuell/bestellungen/b1", "write", "gast-1", true],
  ["MUSS: Teilnehmer liest die Runden", "essen/aktuell/runden", "read", "gast-1", true],
  ["MUSS: Veranstalter legt den Plan an", "essen/aktuell/meta", "write", "host-uid", true],
  ["MUSS: Veranstalter pflegt die Karte", "essen/aktuell/karte/g1", "write", "host-uid", true],

  // --- Das Turnier-Board bleibt oeffentlich ------------------------------
  // ⚠️ Gegenprobe in die andere Richtung: der Fix darf das Board NICHT
  // mitnehmen. Es ist die Anzeige, die im Raum an der Wand haengt - dort
  // meldet sich niemand an.
  ["MUSS: Turnier bleibt oeffentlich lesbar", "turniere/T1/meta", "read", null, true],
  ["MUSS: Streamplan bleibt oeffentlich lesbar", "streamplan/P1/meta", "read", null, true],
  ["MUSS: angemeldet ins Turnier schreiben", "turniere/T1/spiele/s1", "write", "gast-1", true],
  ["DARF NICHT: Turnier schreiben OHNE Anmeldung", "turniere/T1/spiele/s1", "write", null, false],

  // --- Der Admin-PIN des Turniers ---------------------------------------
  // Der Anlass (15.09.2026): der PIN stand im Klartext in turniere/$tid/meta,
  // und dort gilt ".read": true. Ein blanker Aufruf von
  //   .../turniere/<id>/meta.json
  // gab ihn heraus - ohne Browser, ohne Konto, ohne Turnier zu kennen ausser
  // der Id aus dem oeffentlichen Index. Jetzt liegt nur noch ein Hash da, und
  // zwar in einem Knoten ganz ohne Leserecht.
  ["DARF NICHT: PIN-Hash lesen OHNE Anmeldung", "turnierGeheim/T1/adminPinHash", "read", null, false],
  ["DARF NICHT: PIN-Hash lesen MIT Anmeldung", "turnierGeheim/T1/adminPinHash", "read", "gast-1", false],
  ["DARF NICHT: ganzen Geheim-Knoten lesen", "turnierGeheim/T1", "read", "gast-1", false],
  ["DARF NICHT: Beweisablage lesen", "turnierPinProbe/T1/gast-1", "read", "gast-1", false],

  // Der Beweisweg: schreiben darf jeder Angemeldete, aber NUR unter der
  // eigenen Kennung - und nur den richtigen Wert (siehe Wert-Regeln unten).
  ["MUSS: eigenen Beweis ablegen", "turnierPinProbe/T1/gast-1", "write", "gast-1", true],
  ["DARF NICHT: Beweis unter fremder Kennung", "turnierPinProbe/T1/gast-1", "write", "fremd-1", false],
  ["DARF NICHT: Beweis ablegen OHNE Anmeldung", "turnierPinProbe/T1/gast-1", "write", null, false],

  // Den Hash anlegen darf, wer ein neues Turnier macht (T2: noch nichts da).
  // Einen VORHANDENEN ersetzen darf nur, wer den alten PIN bewiesen hat -
  // sonst koennte jeder Zuschauer ein laufendes Turnier uebernehmen.
  ["MUSS: PIN beim neuen Turnier hinterlegen", "turnierGeheim/T2/adminPinHash", "write", "gast-1", true],
  ["MUSS: PIN wechseln mit gueltigem Beweis", "turnierGeheim/T1/adminPinHash", "write", "gast-1", true],
  ["DARF NICHT: fremden PIN ohne Beweis ueberschreiben", "turnierGeheim/T1/adminPinHash", "write", "fremd-1", false],
  ["DARF NICHT: PIN hinterlegen OHNE Anmeldung", "turnierGeheim/T2/adminPinHash", "write", null, false],

  // --- Der Veranstalter-PIN des Streamplans ------------------------------
  // Derselbe Fehler, derselbe Fix: streamplan/$pid traegt ".read": true (der
  // Kalender haengt im Raum), und der PIN lag im Klartext darunter.
  ["DARF NICHT: Stream-PIN-Hash lesen OHNE Anmeldung", "streamplanGeheim/P1/adminPinHash", "read", null, false],
  ["DARF NICHT: Stream-PIN-Hash lesen MIT Anmeldung", "streamplanGeheim/P1/adminPinHash", "read", "gast-1", false],
  ["DARF NICHT: Stream-Beweisablage lesen", "streamplanPinProbe/P1/gast-1", "read", "gast-1", false],
  ["MUSS: Streamplan bleibt oeffentlich lesbar (zweite Probe)", "streamplan/P1/slots", "read", null, true],

  ["MUSS: eigenen Stream-Beweis ablegen", "streamplanPinProbe/P1/gast-1", "write", "gast-1", true],
  ["DARF NICHT: Stream-Beweis unter fremder Kennung", "streamplanPinProbe/P1/gast-1", "write", "fremd-1", false],
  ["MUSS: Stream-PIN beim neuen Plan hinterlegen", "streamplanGeheim/P2/adminPinHash", "write", "gast-1", true],
  ["MUSS: Stream-PIN wechseln mit gueltigem Beweis", "streamplanGeheim/P1/adminPinHash", "write", "gast-1", true],
  ["DARF NICHT: fremden Stream-PIN ohne Beweis ueberschreiben", "streamplanGeheim/P1/adminPinHash", "write", "fremd-1", false],

  // --- Die Takt-Bremse gegen das Durchprobieren des PINs (15.09.2026) ------
  //
  // Der Beweisweg ist ein Orakel: ein Schreibvorgang gelingt genau dann, wenn
  // der Hash stimmt. Ohne Bremse ist ein vierstelliger PIN in Minuten geraten
  // -- 10.000 Versuche, und Firebase-Regeln haben von sich aus KEIN Zaehlwerk.
  //
  // Der Takt kappt das: ein Beweis geht nur durch, wenn derselbe uid in den
  // letzten 5 Sekunden getaktet hat, und getaktet werden darf hoechstens jede
  // Sekunde. Damit bleibt EIN Versuch je Sekunde und Konto.
  //
  // ⚠️ Das haelt niemanden auf, der sich staendig NEUE anonyme Konten holt --
  // die Anmeldung ist offen. Die eigentliche Arbeit macht die Mindestlaenge
  // des PINs (turnier-service.js, PIN_MIN). Der Takt ist die zweite Reihe.
  ["DARF NICHT: Beweis OHNE vorherigen Takt", "turnierPinProbe/T1/gast-neu", "write", "gast-neu", false],
  ["DARF NICHT: Beweis mit ABGELAUFENEM Takt", "turnierPinProbe/T1/gast-alt", "write", "gast-alt", false],
  ["MUSS: Beweis mit frischem Takt", "turnierPinProbe/T1/gast-1", "write", "gast-1", true],
  ["MUSS: erstes Takten geht immer", "turnierPinTakt/T1/gast-neu", "write", "gast-neu", true],
  ["DARF NICHT: zweimal takten binnen einer Sekunde", "turnierPinTakt/T1/gast-schnell", "write", "gast-schnell", false],
  ["MUSS: wieder takten, wenn die Sekunde um ist", "turnierPinTakt/T1/gast-alt", "write", "gast-alt", true],
  ["DARF NICHT: fremden Takt setzen", "turnierPinTakt/T1/gast-1", "write", "fremd-1", false],
  ["DARF NICHT: Takt lesen", "turnierPinTakt/T1/gast-1", "read", "gast-1", false],

  // --- Fruehstueck und Essen: derselbe Weg, eigene Knoten (15.09.2026) -----
  //
  // ⚠️ Der Anlass: beide legten den Admin-PIN bis heute im KLARTEXT unter
  // meta.adminPin ab. Beim Fruehstueck stand darueber ".read": true -- der PIN
  // war damit fuer JEDEN abrufbar, ohne Konto, ohne Browser. Beim Essen
  // reichte eine anonyme Anmeldung, die auf dieser Seite jede:r besteht.
  // Dahinter liegen Telefonnummer, Lieferantenmail und alle Bestellungen.
  ["DARF NICHT: Fruehstuecks-PIN-Hash lesen", "fruehstueckGeheim/F1/adminPinHash", "read", "gast-1", false],
  ["DARF NICHT: Fruehstuecks-Hash OHNE Beweis ersetzen", "fruehstueckGeheim/F1/adminPinHash", "write", "fremd-1", false],
  ["MUSS: Fruehstuecks-Hash ersetzen, wer ihn bewiesen hat", "fruehstueckGeheim/F1/adminPinHash", "write", "gast-1", true],
  ["DARF NICHT: Essens-PIN-Hash lesen", "essenGeheim/aktuell/adminPinHash", "read", "gast-1", false],
  ["DARF NICHT: Essens-Hash OHNE Beweis ersetzen", "essenGeheim/aktuell/adminPinHash", "write", "fremd-1", false],
  ["MUSS: Essens-Hash ersetzen, wer ihn bewiesen hat", "essenGeheim/aktuell/adminPinHash", "write", "gast-1", true],
  ["DARF NICHT: Essens-Beweisablage lesen", "essenPinProbe/aktuell/gast-1", "read", "gast-1", false],
  ["MUSS: frischen Essens-Hash anlegen, wo keiner steht", "essenGeheim/neu1/adminPinHash", "write", "gast-1", true],

  // Aufraeumen braucht KEINEN Takt -- sonst scheitert das Loeschen eines
  // Turniers am eigenen Schutz und laesst Reste in der Datenbank stehen.
  ["MUSS: eigenen Beweis wegnehmen, auch ohne Takt", "turnierPinProbe/T1/gast-alt", "write", "gast-alt", true, true],
  ["DARF NICHT: fremden Beweis wegnehmen", "turnierPinProbe/T1/gast-1", "write", "fremd-1", false, true]
];

let fehler = 0;
for (const [text, pfad, typ, uid, erwartet, loeschen] of faelle) {
  const ist = darf(REGELN, pfad, typ, uid, loeschen);
  const ok = ist === erwartet;
  if (!ok) fehler++;
  console.log((ok ? "  OK   " : "  FEHL ") + text + "   (erwartet " + erwartet + ", ist " + ist + ")");
}

// --- Mutationsprobe --------------------------------------------------------
// ⚠️ Ein Pruefstand, der die ALTE Regel auch bestehen laesst, beweist nichts.
// Hier wird die Fassung von vor dem 04.09.2026 nachgebaut - essen mit
// ".read": true - und gezeigt, dass sie an genau den Faellen scheitert, die
// oben gruen sind. Faellt dieser Abschnitt weg oder wird er gruen, ist der
// Pruefstand tot und die Zusage oben wertlos.
const alt = JSON.parse(JSON.stringify(REGELN));
alt.essen.$pid[".read"] = true;
const ohneAnmeldung = faelle.filter((f) => f[0].startsWith("DARF NICHT") && f[1].startsWith("essen/") && f[2] === "read");
const durchgerutscht = ohneAnmeldung.filter((f) => darf(alt, f[1], f[2], f[3]) === true);
console.log("\nMutationsprobe (alte Regel \".read\": true):");
console.log("  " + durchgerutscht.length + " von " + ohneAnmeldung.length +
            " Lesezugriffen ohne Anmeldung waeren durchgegangen");
if (durchgerutscht.length !== ohneAnmeldung.length) {
  fehler++;
  console.log("  FEHL  Der Pruefstand merkt den Unterschied nicht - er ist tot.");
}

// --- Mutationsprobe: der Admin-PIN an seinem alten Platz -------------------
// ⚠️ Der Fix VERSCHIEBT den PIN, er verschaerft keine Leseregel - an den
// Regeln allein ist davon nichts zu sehen. Deshalb hier der direkte Vergleich:
// der PIN einmal dort, wo er bis 15.09.2026 lag (turniere/$tid/meta, ".read":
// true), und einmal dort, wo er jetzt liegt. Zeigt dieser Abschnitt keinen
// Unterschied mehr, ist der Umzug rueckgaengig gemacht worden.
console.log("\nMutationsprobe (PIN am alten Platz in meta):");
for (const [was, altPfad, neuPfad] of [
  ["Turnier   ", "turniere/T1/meta/adminPin",   "turnierGeheim/T1/adminPinHash"],
  ["Streamplan", "streamplan/P1/meta/adminPin", "streamplanGeheim/P1/adminPinHash"],
]) {
  const knoten = altPfad.split("/").slice(0, -1).reduce((o, t) => o[t], WELT);
  knoten.adminPin = "geheim123";
  const alsKlartext = darf(REGELN, altPfad, "read", null);
  delete knoten.adminPin;
  const alsHash = darf(REGELN, neuPfad, "read", null);
  console.log("  " + was + ": Klartext in meta ohne Anmeldung lesbar: " + alsKlartext +
              "   |   Hash lesbar: " + alsHash);
  if (!alsKlartext || alsHash) {
    fehler++;
    console.log("  FEHL  Der Vergleich zeigt keinen Unterschied - er ist tot.");
  }
}


// --- Wert-Regeln (".validate") ---------------------------------------------
// ⚠️ `darf()` oben prueft nur ".read"/".write". Eine kaputte ".validate" faellt
// dort NICHT auf - sie laesst das Schreiben weiter zu und weist erst den WERT
// ab. Genau das ist die gefaehrliche Sorte: die App meldet "gespeichert", die
// Datenbank nimmt es nicht, und niemand sieht es, bis am Turniertag die Zeiten
// fehlen. Deshalb hier ein eigener Pruefer.
//
// Anders als ".read"/".write" kaskadiert ".validate" NICHT nach oben: es gilt
// genau die Regel am Knoten selbst.
// ⚠️ Die $-Platzhalter muessen mit heraus. Die Beweis-Regel baut ihren
// Vergleichspfad aus $tid zusammen; bleibt der Name unersetzt im Ausdruck
// stehen, wirft eval() und JEDER Wert gilt als ungueltig - der Pruefstand
// meldet dann rote Faelle, die in Wahrheit gruen sind.
function findeValidate(regeln, pfadTeile) {
  let knoten = regeln;
  const vars = {};
  for (const teil of pfadTeile) {
    if (knoten && knoten[teil] !== undefined) { knoten = knoten[teil]; continue; }
    const platzhalter = knoten ? Object.keys(knoten).find((k) => k.startsWith("$")) : null;
    if (!platzhalter) return { ausdruck: undefined, vars };
    vars[platzhalter] = teil;
    knoten = knoten[platzhalter];
  }
  return { ausdruck: knoten ? knoten[".validate"] : undefined, vars };
}

// Firebase kennt `.matches(/regex/)` auf Strings. In Node gibt es das nicht -
// hier fuer die Dauer des Pruefstands nachgereicht.
if (!String.prototype.matches) {
  Object.defineProperty(String.prototype, "matches", {
    value: function (re) { return re.test(this.valueOf()); },
    enumerable: false,
  });
}

// wert === undefined bedeutet: der Knoten wird geloescht.
// ⚠️ Firebase wertet ".validate" beim LOESCHEN gar nicht erst aus - sonst
// liesse sich ein Feld mit strenger Regel nie wieder entfernen. Genau davon
// haengt hier der Umzug des Altbestands ab: meta/adminPin traegt ".validate":
// false und muss sich trotzdem loeschen lassen.
function gueltig(regeln, pfad, wert) {
  const { ausdruck, vars } = findeValidate(regeln, pfad.split("/"));
  if (wert === undefined || wert === null) return true;   // Loeschen wird nicht geprueft
  if (ausdruck === undefined) return true;   // keine Regel = alles erlaubt
  const newData = {
    exists: () => wert !== undefined && wert !== null,
    isString: () => typeof wert === "string",
    isNumber: () => typeof wert === "number",
    isBoolean: () => typeof wert === "boolean",
    val: () => (wert === undefined ? null : wert),
    hasChildren: (liste) => !!wert && typeof wert === "object" && liste.every((k) => wert[k] !== undefined),
  };
  // ⚠️ Die Beweis-Regel vergleicht gegen root.child(...) - ohne `root` wirft
  // eval() und jeder Beweis gaelte als ungueltig. Das saehe sicher aus und
  // wuerde in Wahrheit nichts pruefen.
  const root = { child: (p) => kindKette(p) };
  const now = JETZT;
  let code = String(ausdruck);
  for (const [name, w] of Object.entries(vars)) {
    code = code.split(name).join(JSON.stringify(w));
  }
  try { return !!eval(code); } catch (e) { return false; }
}

const WERT_FAELLE = [
  // [Beschreibung, Pfad, Wert, erwartet]
  ["MUSS: Anstoss im richtigen Format", "turniere/T1/spiele/s1/geplantAm", "2026-10-01T14:00", true],
  ["MUSS: Anstoss darf wieder weg", "turniere/T1/spiele/s1/geplantAm", undefined, true],
  ["DARF NICHT: Anstoss nur als Datum", "turniere/T1/spiele/s1/geplantAm", "2026-10-01", false],
  ["DARF NICHT: Anstoss mit Sekunden", "turniere/T1/spiele/s1/geplantAm", "2026-10-01T14:00:00", false],
  ["DARF NICHT: Anstoss als Wort", "turniere/T1/spiele/s1/geplantAm", "morgen frueh", false],
  ["DARF NICHT: Anstoss als Zahl", "turniere/T1/spiele/s1/geplantAm", 1790000000, false],

  ["MUSS: Dauer 60 Minuten", "turniere/T1/spiele/s1/dauerMin", 60, true],
  ["MUSS: Dauer 600 Minuten (Obergrenze)", "turniere/T1/spiele/s1/dauerMin", 600, true],
  ["MUSS: Dauer 5 Minuten (Untergrenze)", "turniere/T1/spiele/s1/dauerMin", 5, true],
  ["MUSS: Dauer darf wieder weg", "turniere/T1/spiele/s1/dauerMin", undefined, true],
  ["DARF NICHT: Dauer 601 Minuten", "turniere/T1/spiele/s1/dauerMin", 601, false],
  ["DARF NICHT: Dauer 4 Minuten", "turniere/T1/spiele/s1/dauerMin", 4, false],
  ["DARF NICHT: Dauer als Text", "turniere/T1/spiele/s1/dauerMin", "60", false],

  // Der PIN darf im oeffentlich lesbaren meta nicht wieder auftauchen - auch
  // nicht durch eine alte, im Browser haengengebliebene Fassung der App.
  // Weggeloescht werden muss er dagegen duerfen: genau so zieht der Altbestand um.
  ["DARF NICHT: PIN im Klartext in meta", "turniere/T1/meta/adminPin", "geheim123", false],
  ["DARF NICHT: PIN als Zahl in meta", "turniere/T1/meta/adminPin", 4711, false],
  ["MUSS: alter Klartext-PIN darf weg", "turniere/T1/meta/adminPin", undefined, true],

  ["MUSS: Hash als 64 Hex-Zeichen", "turnierGeheim/T1/adminPinHash", HASH_ANDERS, true],
  ["MUSS: Hash darf beim Loeschen weg", "turnierGeheim/T1/adminPinHash", undefined, true],
  ["DARF NICHT: Klartext statt Hash", "turnierGeheim/T1/adminPinHash", "geheim123", false],
  ["DARF NICHT: Hash zu kurz", "turnierGeheim/T1/adminPinHash", "9f86d081", false],
  ["DARF NICHT: Hash mit Grossbuchstaben", "turnierGeheim/T1/adminPinHash", HASH_T1.toUpperCase(), false],
  ["DARF NICHT: fremdes Feld im Geheim-Knoten", "turnierGeheim/T1/adminPin", "geheim123", false],

  // Das Herzstueck: die Ablage nimmt NUR den Wert an, der schon hinterlegt
  // ist. Geht der Schreibvorgang durch, kannte der Schreiber den PIN.
  ["MUSS: Beweis gleicht dem hinterlegten Hash", "turnierPinProbe/T1/gast-1", HASH_T1, true],
  ["DARF NICHT: Beweis mit falschem Hash", "turnierPinProbe/T1/gast-1", HASH_ANDERS, false],
  ["DARF NICHT: Beweis fuer Turnier ohne Hash", "turnierPinProbe/T2/gast-1", HASH_T1, false],

  ["DARF NICHT: Stream-PIN im Klartext in meta", "streamplan/P1/meta/adminPin", "geheim123", false],
  ["MUSS: alter Stream-Klartext darf weg", "streamplan/P1/meta/adminPin", undefined, true],
  ["MUSS: Stream-Hash als 64 Hex-Zeichen", "streamplanGeheim/P1/adminPinHash", HASH_ANDERS, true],
  ["DARF NICHT: Klartext statt Stream-Hash", "streamplanGeheim/P1/adminPinHash", "geheim123", false],
  ["DARF NICHT: fremdes Feld im Stream-Geheim-Knoten", "streamplanGeheim/P1/adminPin", "geheim123", false],
  ["MUSS: Stream-Beweis gleicht dem hinterlegten Hash", "streamplanPinProbe/P1/gast-1", HASH_T1, true],
  ["DARF NICHT: Stream-Beweis mit falschem Hash", "streamplanPinProbe/P1/gast-1", HASH_ANDERS, false],

  // --- Der Klartext-PIN ist jetzt UEBERALL verriegelt (15.09.2026) ---------
  ["DARF NICHT: Klartext-PIN zurueck ins Turnier-meta", "turniere/T1/meta/adminPin", "1234", false],
  ["DARF NICHT: Klartext-PIN zurueck ins Fruehstuecks-meta", "fruehstueck/F1/meta/adminPin", "1234", false],
  ["DARF NICHT: Klartext-PIN zurueck ins Essens-meta", "essen/aktuell/meta/adminPin", "1234", false],
  ["DARF NICHT: Klartext-PIN zurueck ins Streamplan-meta", "streamplan/P1/meta/adminPin", "1234", false],

  // --- Takt: nur eine Zahl, und nur die aktuelle Serverzeit ----------------
  // ⚠️ Der Client schickt hier ServerValue.TIMESTAMP, NICHT seine eigene Uhr.
  // Wer stattdessen Date.now() schickt, sperrt sich mit einer schief gehenden
  // Geraeteuhr selbst aus -- der PIN ginge dann nie mehr durch.
  ["MUSS: Takt als aktuelle Zeit", "turnierPinTakt/T1/gast-1", 1789000000000, true],
  ["DARF NICHT: Takt in der Zukunft", "turnierPinTakt/T1/gast-1", 1789000060000, false],
  ["DARF NICHT: Takt weit in der Vergangenheit", "turnierPinTakt/T1/gast-1", 1788999000000, false],
  ["DARF NICHT: Takt als Text", "turnierPinTakt/T1/gast-1", "jetzt", false],

  // --- Die neuen Hash-Knoten nehmen nur echte Hashes -----------------------
  ["MUSS: Fruehstuecks-Hash als 64 Hex-Zeichen", "fruehstueckGeheim/F1/adminPinHash", HASH_ANDERS, true],
  ["DARF NICHT: Klartext statt Fruehstuecks-Hash", "fruehstueckGeheim/F1/adminPinHash", "1234", false],
  ["DARF NICHT: fremdes Feld im Fruehstuecks-Geheim-Knoten", "fruehstueckGeheim/F1/notiz", "hallo", false],
  ["MUSS: Essens-Hash als 64 Hex-Zeichen", "essenGeheim/aktuell/adminPinHash", HASH_ANDERS, true],
  ["DARF NICHT: Klartext statt Essens-Hash", "essenGeheim/aktuell/adminPinHash", "1234", false],
  ["DARF NICHT: fremdes Feld im Essens-Geheim-Knoten", "essenGeheim/aktuell/notiz", "hallo", false],
  ["MUSS: Essens-Beweis gleicht dem hinterlegten Hash", "essenPinProbe/aktuell/gast-1", HASH_T1, true],
  ["DARF NICHT: Essens-Beweis mit falschem Hash", "essenPinProbe/aktuell/gast-1", HASH_ANDERS, false],

  // Die alten Felder als Gegenprobe, dass der Pruefer ueberhaupt greift.
  ["MUSS: Saetze als Zahl", "turniere/T1/spiele/s1/saetzeA", 2, true],
  ["DARF NICHT: Saetze als Text", "turniere/T1/spiele/s1/saetzeA", "zwei", false],
];

console.log("\nWert-Regeln (.validate):");
for (const [text, pfad, wert, erwartet] of WERT_FAELLE) {
  const ist = gueltig(REGELN, pfad, wert);
  const ok = ist === erwartet;
  if (!ok) fehler++;
  console.log((ok ? "  OK   " : "  FEHL ") + text + "   (erwartet " + erwartet + ", ist " + ist + ")");
}

// ⚠️ Mutationsprobe fuer die Wert-Regeln: ohne die beiden neuen Eintraege
// muessten die "DARF NICHT"-Faelle durchrutschen. Tun sie das nicht, prueft
// dieser Abschnitt nichts und die Zusage darueber ist wertlos.
const ohneNeue = JSON.parse(JSON.stringify(REGELN));
delete ohneNeue.turniere.$tid.spiele.$sid.geplantAm;
delete ohneNeue.turniere.$tid.spiele.$sid.dauerMin;
const sollenScheitern = WERT_FAELLE.filter((f) => f[3] === false && /geplantAm|dauerMin/.test(f[1]));
const rutschenDurch = sollenScheitern.filter((f) => gueltig(ohneNeue, f[1], f[2]) === true);
console.log("\nMutationsprobe (ohne die neuen Wert-Regeln):");
console.log("  " + rutschenDurch.length + " von " + sollenScheitern.length + " falschen Werten waeren durchgegangen");
if (rutschenDurch.length !== sollenScheitern.length) {
  fehler++;
  console.log("  FEHL  Der Pruefer merkt den Unterschied nicht - er ist tot.");
}

console.log("\n" + (fehler ? fehler + " FEHLER" : "alle " + (faelle.length + WERT_FAELLE.length) + " Zusagen erfuellt"));
process.exit(fehler ? 1 : 0);
