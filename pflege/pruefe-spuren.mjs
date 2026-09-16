// Prueft skVerteileSpuren() aus stream-app.js: wie breit ein Block im
// Streamplan steht, haengt an der Zahl der Spuren seiner Ueberschneidungs-
// GRUPPE, nicht an der des ganzen Tages (Bugjagd 16.09.2026, A4).
//
// ⚠️ Die Funktion wird AUS DER ECHTEN DATEI geschnitten (f-aequivalenztest).
//
// Aufruf:          node pflege/pruefe-spuren.mjs
// Mutationsprobe:  node pflege/pruefe-spuren.mjs --gegen e18f7d6   (MUSS rot werden)

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const i = process.argv.indexOf("--gegen");
const text = i > 0
  ? execFileSync("git", ["-C", REPO, "show", process.argv[i + 1] + ":stream-app.js"], { encoding: "utf8" })
  : readFileSync(new URL("../stream-app.js", import.meta.url), "utf8");

const a = text.indexOf("function skVerteileSpuren(");
const e = text.indexOf("\n}\n", a);
if (a < 0 || e < 0) throw new Error("skVerteileSpuren nicht gefunden");
const skVerteileSpuren = new Function(text.slice(a, e + 3) + "\nreturn skVerteileSpuren;")();

let fehler = 0, gesamt = 0;
function zusage(name, ok, daten) {
  gesamt++;
  console.log((ok ? "  OK    " : "  FEHLT ") + name);
  if (!ok) { fehler++; console.log("        " + JSON.stringify(daten)); }
}
const b = (von, bis, id) => ({ von, bis, id });

{
  const s = [b(600, 720, "allein"), b(1200, 1320, "x"), b(1200, 1320, "y")];
  skVerteileSpuren(s);
  zusage("einsamer Block am Vormittag steht voll breit", s[0].spurAnzahl === 1 && s[0].spur === 0, s);
  zusage("zwei gleichzeitige am Abend teilen sich die Breite", s[1].spurAnzahl === 2 && s[2].spurAnzahl === 2 && s[1].spur !== s[2].spur, s);
}
{
  // Kette: A ueberlappt B, B ueberlappt C, A und C nicht -> eine Gruppe, 2 Spuren
  const s = [b(600, 720, "A"), b(660, 780, "B"), b(720, 840, "C")];
  skVerteileSpuren(s);
  zusage("Kette A-B-C ist eine Gruppe mit 2 Spuren", s.every((x) => x.spurAnzahl === 2), s);
  zusage("C nimmt die frei gewordene Spur von A", s[2].spur === s[0].spur, s);
}
{
  // Beruehrung Ende == Beginn ist keine Ueberschneidung
  const s = [b(600, 720, "A"), b(720, 840, "B")];
  skVerteileSpuren(s);
  zusage("Beruehrung trennt die Gruppen", s.every((x) => x.spurAnzahl === 1 && x.spur === 0), s);
}
{
  // unsortierte Eingabe, Reihenfolge des Arrays bleibt
  const s = [b(1200, 1320, "spaet"), b(600, 720, "frueh1"), b(600, 720, "frueh2")];
  const ids = s.map((x) => x.id).join();
  skVerteileSpuren(s);
  zusage("unsortiert: spaeter Block allein voll breit", s[0].spurAnzahl === 1, s);
  zusage("unsortiert: fruehe Bloecke je halb und getrennt", s[1].spurAnzahl === 2 && s[2].spurAnzahl === 2 && s[1].spur !== s[2].spur, s);
  zusage("Reihenfolge des Arrays unveraendert", s.map((x) => x.id).join() === ids, s);
}
{
  // Drei auf einmal, danach wieder einer
  const s = [b(600, 700, "a"), b(600, 700, "b"), b(600, 700, "c"), b(800, 900, "d")];
  skVerteileSpuren(s);
  zusage("drei gleichzeitig: 3 Spuren", s.slice(0, 3).every((x) => x.spurAnzahl === 3) && new Set(s.slice(0, 3).map((x) => x.spur)).size === 3, s);
  zusage("danach wieder voll breit", s[3].spurAnzahl === 1 && s[3].spur === 0, s);
}
{
  const s = [];
  skVerteileSpuren(s);
  zusage("leerer Tag wirft nicht", s.length === 0, s);
}

console.log("\n" + (gesamt - fehler) + " von " + gesamt + " Zusagen erfuellt");
if (fehler) process.exit(1);
