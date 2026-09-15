// Prueft beweisePinAn() aus turnier-service.js gegen beide Regel-Welten.
//
// Der Anlass (Abnahme 15.09.2026): der PIN-Beweis braucht seit heute einen
// vorher gesetzten "Takt" (turnierPinTakt), damit sich der PIN nicht
// durchprobieren laesst. Die neuen Firebase-Regeln muessen dafuer aber von
// Hand in der Konsole veroeffentlicht werden.
//
// ⚠️⚠️ Zwischen "Datei ist live" und "Regeln sind veroeffentlicht" liegt ein
// Zeitfenster. Haengt der Beweis am Takt, ist in diesem Fenster in ALLEN vier
// Bereichen kein Veranstalter-Zugang mehr moeglich -- unter Umstaenden mitten
// in einer laufenden Veranstaltung. Genau das misst dieses Skript.
//
// ⚠️ Der Funktionsrumpf wird AUS DER ECHTEN DATEI geschnitten, nicht hier
// abgetippt. Eine abgetippte Fassung wuerde weiter "bestanden" melden,
// nachdem jemand das Original geaendert hat (siehe f-aequivalenztest).
//
// Aufruf:  node pflege/pruefe-pin-beweis.mjs

import { readFileSync } from "node:fs";

const QUELLE = new URL("../turnier-service.js", import.meta.url);
const text = readFileSync(QUELLE, "utf8");

// Die drei Funktionen, um die es geht -- von ihrer Zeile bis zur schliessenden
// Klammer am Zeilenanfang.
function schneide(name) {
  let anfang = text.indexOf("function " + name + "(");
  if (anfang < 0) throw new Error("nicht gefunden: " + name);
  // ⚠️ Das "async" davor MIT nehmen. Ohne es faellt der Ausschnitt beim
  // Auswerten mit "await is only valid in async functions" um -- und ein
  // Skript, das umfaellt, hat nichts gemessen.
  if (text.slice(anfang - 6, anfang) === "async ") anfang -= 6;
  const ende = text.indexOf("\n}\n", anfang);
  if (ende < 0) throw new Error("kein Ende gefunden: " + name);
  return text.slice(anfang, ende + 3);
}
const rumpf = ["taktPfadZu", "takte", "beweisePinAn"].map(schneide).join("\n");
if (!rumpf.includes("PinTakt")) throw new Error("Takt-Logik fehlt im Ausschnitt -- misst nichts");

let protokoll = [];

function baueWelt({ taktErlaubt, probeErlaubt }) {
  protokoll = [];
  return {
    db: {
      ref: (pfad) => ({
        set: async () => {
          const art = pfad.includes("PinTakt") ? "takt" : "probe";
          protokoll.push(art);
          const erlaubt = art === "takt" ? taktErlaubt : probeErlaubt;
          if (!erlaubt) throw new Error("PERMISSION_DENIED");
        },
        once: async () => ({ val: () => null }),
      }),
    },
    firebase: { database: { ServerValue: { TIMESTAMP: { ".sv": "timestamp" } } } },
    pinHashMoeglich: () => true,
    istMockModus: () => false,
    pinHash: async (id, pin) => "a".repeat(64),
  };
}

async function lauf(welt) {
  const bauen = new Function(
    "db", "firebase", "pinHashMoeglich", "istMockModus", "pinHash",
    rumpf + "\nreturn beweisePinAn;"
  );
  const fn = bauen(welt.db, welt.firebase, welt.pinHashMoeglich, welt.istMockModus, welt.pinHash);
  return fn("turnierGeheim", "turnierPinProbe", "T1", "uid-1", "geheim123");
}

const FAELLE = [
  // [Beschreibung, Welt, erwartet, erwartete Schrittfolge]
  ["ALTE Regeln (Takt-Knoten gibt es noch nicht), PIN richtig",
   { taktErlaubt: false, probeErlaubt: true }, true, "takt>probe"],
  ["ALTE Regeln, PIN falsch",
   { taktErlaubt: false, probeErlaubt: false }, false, "takt>probe>takt>probe"],
  ["NEUE Regeln, Takt liegt, PIN richtig",
   { taktErlaubt: true, probeErlaubt: true }, true, "takt>probe"],
  ["NEUE Regeln, Takt liegt, PIN falsch",
   { taktErlaubt: true, probeErlaubt: false }, false, "takt>probe"],
];

let fehler = 0;
for (const [beschreibung, welt, erwartet, schritteSoll] of FAELLE) {
  const w = baueWelt(welt);
  const ist = await lauf(w);
  const schritte = protokoll.join(">");
  const ok = ist === erwartet && schritte === schritteSoll;
  if (!ok) fehler++;
  console.log(
    (ok ? "  OK   " : "  FEHL ") + beschreibung +
    "   (erwartet " + erwartet + "/" + schritteSoll + ", ist " + ist + "/" + schritte + ")"
  );
}

// --- Mutationsprobe: misst dieses Skript ueberhaupt etwas? ------------------
// Eine Fassung, die den Beweis NUR nach erfolgreichem Takt versucht -- genau
// der Fehler, gegen den dieses Skript steht. Der erste Fall MUSS daran
// scheitern; tut er es nicht, prueft hier nichts.
const kaputt = rumpf.replace(
  "    const getaktet = await takte(probePfad, id, uid);",
  "    const getaktet = await takte(probePfad, id, uid);\n    if (!getaktet) { if (versuch === 0) { await new Promise((f) => setTimeout(f, 1)); continue; } return false; }"
);
if (kaputt === rumpf) {
  console.log("\n⚠️ Mutationsprobe konnte nicht ansetzen -- der Rumpf sieht anders aus als erwartet.");
  fehler++;
} else {
  const w = baueWelt({ taktErlaubt: false, probeErlaubt: true });
  const bauen = new Function(
    "db", "firebase", "pinHashMoeglich", "istMockModus", "pinHash",
    kaputt + "\nreturn beweisePinAn;"
  );
  const ist = await bauen(w.db, w.firebase, w.pinHashMoeglich, w.istMockModus, w.pinHash)(
    "turnierGeheim", "turnierPinProbe", "T1", "uid-1", "geheim123"
  );
  console.log("\nMutationsprobe (Beweis haengt am Takt):");
  console.log(ist === false
    ? "  OK   die kaputte Fassung sperrt aus -- dieses Skript wuerde das merken"
    : "  FEHL die kaputte Fassung kam durch -- dieses Skript misst nichts");
  if (ist !== false) fehler++;
}

console.log("\n" + (fehler ? fehler + " FEHLER" : "alle Zusagen erfuellt"));
process.exit(fehler ? 1 : 0);
