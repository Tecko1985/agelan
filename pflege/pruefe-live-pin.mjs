// Haelt die LIVE-Datenbank gegen die Zusage: weder der Turnier-Admin-PIN noch
// der Veranstalter-PIN des Streamplans darf von aussen lesbar sein.
//
// Der Anlass (15.09.2026): der PIN stand im Klartext in turniere/$tid/meta,
// und dort gilt ".read": true. Ein einzelner Aufruf ohne Anmeldung, ohne
// Browser, ohne Konto gab ihn heraus - die Turnier-Ids stehen im ebenfalls
// offenen turniere/_index.
//
// Aufruf:  node pflege/pruefe-live-pin.mjs
//
// ⚠️ Dieser Pruefstand fragt die ECHTE Datenbank. Er aendert nichts und gibt
// keinen PIN aus - nur, OB einer herauskommt.
// ⚠️ Gruen wird er erst, wenn database.rules.json in der Firebase-Konsole
// VEROEFFENTLICHT ist. Im Repo stehende Regeln sind nicht die laufenden.

const DB = "https://agelan-ab042-default-rtdb.europe-west1.firebasedatabase.app";

async function hole(pfad) {
  const antwort = await fetch(DB + "/" + pfad + ".json");
  if (!antwort.ok) return { fehler: antwort.status + " " + antwort.statusText };
  return { wert: await antwort.json() };
}

let fehler = 0;
const melde = (ok, text) => {
  if (!ok) fehler++;
  console.log((ok ? "  OK   " : "  FEHL ") + text);
};

// --- 1. Die Turnierliste ist offen. Das ist so gewollt (Board an der Wand) --
const index = await hole("turniere/_index");
const ids = Object.keys(index.wert || {});
console.log("Turniere im offenen Index: " + ids.length);

// --- 2. Kein Turnier gibt seinen PIN heraus --------------------------------
console.log("\nmeta ohne Anmeldung abgefragt:");
for (const id of ids) {
  const meta = await hole("turniere/" + id + "/meta");
  const drin = !!(meta.wert && Object.prototype.hasOwnProperty.call(meta.wert, "adminPin"));
  melde(!drin, id + ": adminPin im offenen meta = " + (drin ? "JA (Laenge " + String(meta.wert.adminPin).length + ")" : "nein"));
}

// --- 3. Auch der Hash bleibt drin ------------------------------------------
// Waere er lesbar, liesse sich ein kurzer PIN offline in Sekunden durchprobieren.
console.log("\nGeheim-Knoten ohne Anmeldung abgefragt:");
for (const id of ids) {
  const geheim = await hole("turnierGeheim/" + id + "/adminPinHash");
  melde(!!geheim.fehler, id + ": adminPinHash lesbar = " + (geheim.fehler ? "nein (" + geheim.fehler + ")" : "JA"));
  const probe = await hole("turnierPinProbe/" + id);
  melde(!!probe.fehler, id + ": Beweisablage lesbar = " + (probe.fehler ? "nein (" + probe.fehler + ")" : "JA"));
}

// --- 4. Derselbe Fehler lag im Streamplan ---------------------------------
// Der Knoten ist nicht auflistbar, der Pfad streamplan/aktuell aber in einer
// Minute geraten - das ist kein Schutz.
console.log("\nStreamplan ohne Anmeldung abgefragt:");
const planMeta = await hole("streamplan/aktuell/meta");
if (!planMeta.wert) {
  console.log("  (kein Streamplan angelegt)");
} else {
  const drin = Object.prototype.hasOwnProperty.call(planMeta.wert, "adminPin");
  melde(!drin, "adminPin im offenen meta = " + (drin ? "JA (Laenge " + String(planMeta.wert.adminPin).length + ")" : "nein"));
  const geheim = await hole("streamplanGeheim/aktuell/adminPinHash");
  melde(!!geheim.fehler, "adminPinHash lesbar = " + (geheim.fehler ? "nein (" + geheim.fehler + ")" : "JA"));
  const probe = await hole("streamplanPinProbe/aktuell");
  melde(!!probe.fehler, "Beweisablage lesbar = " + (probe.fehler ? "nein (" + probe.fehler + ")" : "JA"));
}

// --- 5. Gegenprobe: der Abruf funktioniert ueberhaupt ----------------------
// ⚠️ Ohne diesen Punkt waere ein kaputter Aufruf (Tippfehler im Pfad, DB weg)
// von einem sauberen Ergebnis nicht zu unterscheiden - alles waere gruen und
// nichts geprueft.
console.log("\nGegenprobe (der Abruf muss ueberhaupt etwas liefern):");
const ersterName = ids.length ? (await hole("turniere/" + ids[0] + "/meta/name")).wert : null;
melde(!!ersterName, "Turniername ohne Anmeldung lesbar = " + (ersterName ? "ja" : "NEIN - der Pruefstand misst nichts"));

console.log("\n" + (fehler ? fehler + " FEHLER" : "alles wie zugesagt"));
process.exit(fehler ? 1 : 0);
