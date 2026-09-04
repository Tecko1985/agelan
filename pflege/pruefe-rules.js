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
const WELT = {
  turniere: { T1: { meta: { name: "AgeLan" } } },
  essen: { aktuell: { meta: { hostId: "host-uid", adminPin: "4711" } } }
};

function wert(pfad) {
  return pfad.split("/").reduce((o, t) => (o == null ? null : o[t]), WELT) ?? null;
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
function darf(regeln, pfad, typ, uid) {
  const gefunden = findeRegeln(regeln, pfad.split("/"), "." + typ);
  for (const { ausdruck, vars } of gefunden) {
    if (ausdruck === true) return true;
    if (ausdruck === false) continue;
    const auth = uid ? { uid } : null;
    const root = { child: (p) => ({ val: () => wert(p) }) };
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
  ["DARF NICHT: Turnier schreiben OHNE Anmeldung", "turniere/T1/spiele/s1", "write", null, false]
];

let fehler = 0;
for (const [text, pfad, typ, uid, erwartet] of faelle) {
  const ist = darf(REGELN, pfad, typ, uid);
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

console.log("\n" + (fehler ? fehler + " FEHLER" : "alle " + faelle.length + " Zusagen erfuellt"));
process.exit(fehler ? 1 : 0);
