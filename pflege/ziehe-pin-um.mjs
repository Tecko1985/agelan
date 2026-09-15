// Zieht die Admin-PINs bestehender Turniere an ihren neuen Platz um:
// Klartext raus aus dem offenen turniere/$tid/meta, Pruefsumme rein in den
// Knoten turnierGeheim/$tid, den niemand lesen darf.
//
// Aufruf:  node pflege/ziehe-pin-um.mjs            (nur zeigen, nichts aendern)
//          node pflege/ziehe-pin-um.mjs --umziehen (wirklich umziehen)
//
// ⚠️ REIHENFOLGE. Erst die Regeln aus database.rules.json in der Firebase-
// Konsole VEROEFFENTLICHEN, dann dieses Skript. Andersherum schlaegt das
// Schreiben des Hashes fehl (der Knoten hat ohne die neuen Regeln keinerlei
// Erlaubnis) - und der geloeschte Klartext waere unwiederbringlich weg. Der
// PIN liesse sich dann von KEINEM Geraet mehr nachweisen.
//
// ⚠️ Das Skript gibt nie einen PIN aus, nur seine Laenge.
//
// Die App macht dasselbe von selbst (heileAltenPin in turnier-service.js),
// sobald ein Geraet mit gemerktem PIN das Turnier oeffnet. Dieses Skript ist
// der Weg, der nicht darauf wartet.

import { createHash } from "node:crypto";

const DB = "https://agelan-ab042-default-rtdb.europe-west1.firebasedatabase.app";
const API_KEY = "AIzaSyCOA-Ogseh13AKND3nGITSDWRbPBEKpIu0";   // nicht geheim, steht in firebase-config.js
const ECHT = process.argv.includes("--umziehen");

// Die Regeln verlangen fuer jeden Schreibvorgang "auth != null". Die Anmeldung
// ist anonym - genau die, die jeder Besucher der Seite auch bekommt.
const anmeldung = await (await fetch(
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + API_KEY,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"returnSecureToken":true}' }
)).json();
if (!anmeldung.idToken) throw new Error("keine anonyme Anmeldung: " + JSON.stringify(anmeldung.error));
const AUTH = "?auth=" + anmeldung.idToken;

// ⚠️ Der Status MUSS mit ausgewertet werden. Firebase antwortet auf einen
// verbotenen Lesezugriff mit 401 UND einem JSON-Koerper {"error":"..."} - und
// der ist ein Objekt, also wahrheitswert-wahr. Ein blankes `await a.json()`
// haette "Hash liegt schon" gemeldet, wo in Wahrheit nur das Leserecht fehlt.
// Genau darauf haette das Skript dann den Klartext geloescht, ohne je einen
// Hash gelegt zu haben: der PIN waere von keinem Geraet mehr nachweisbar.
const hole = async (pfad, mitAuth) => {
  const a = await fetch(DB + "/" + pfad + ".json" + (mitAuth ? AUTH : ""));
  if (!a.ok) return { ok: false, status: a.status, wert: null };
  return { ok: true, status: 200, wert: await a.json() };
};
const schreib = async (pfad, wert) => {
  const a = await fetch(DB + "/" + pfad + ".json" + AUTH, { method: "PUT", body: JSON.stringify(wert) });
  return a.ok ? { ok: true } : { ok: false, grund: a.status + " " + (await a.text()).slice(0, 120) };
};
const loesche = async (pfad) => {
  const a = await fetch(DB + "/" + pfad + ".json" + AUTH, { method: "DELETE" });
  if (!a.ok) throw new Error(pfad + " -> " + a.status + " " + (await a.text()).slice(0, 120));
};

// Gleiche Bildung wie pinHash() in turnier-service.js: die Turnier-Id salzt mit,
// damit derselbe PIN in zwei Turnieren nicht denselben Hash ergibt.
const pinHash = (id, pin) => createHash("sha256").update(id + ":" + pin, "utf8").digest("hex");

const idsAntwort = await hole("turniere/_index", true);
if (!idsAntwort.ok) throw new Error("Turnierliste nicht lesbar: " + idsAntwort.status);
const ids = Object.keys(idsAntwort.wert || {});
console.log((ECHT ? "UMZUG" : "NUR ANSEHEN (mit --umziehen wird es echt)") + " - " + ids.length + " Turnier(e)\n");

let offen = 0;
for (const id of ids) {
  const metaAntwort = await hole("turniere/" + id + "/meta", true);
  const meta = metaAntwort.wert || {};
  const klartext = meta.adminPin;
  const name = meta.name || "?";

  // ⚠️ Ob schon ein Hash liegt, laesst sich NICHT nachsehen - der Knoten hat
  // kein Leserecht, und das ist ja der Sinn der Sache. Der Schreibversuch
  // selbst ist die Auskunft: er geht nur durch, wenn dort noch nichts liegt.
  if (!klartext) {
    console.log("  " + id + "  " + name + ": kein Klartext mehr - nichts zu tun");
    continue;
  }
  offen++;
  console.log("  " + id + "  " + name + ": Klartext-PIN offen (Laenge " + String(klartext).length + ")");
  if (!ECHT) continue;

  // Erst den Hash hinlegen, dann den Klartext wegnehmen - und den Klartext NUR
  // dann, wenn der Hash wirklich angekommen ist.
  const gelegt = await schreib("turnierGeheim/" + id + "/adminPinHash", pinHash(id, String(klartext)));
  if (!gelegt.ok) {
    console.log("     -> KEIN Hash gelegt, Klartext bleibt stehen. Grund: " + gelegt.grund);
    console.log("        Meistens: die Regeln sind in der Firebase-Konsole noch nicht veroeffentlicht.");
    console.log("        Sonst: dort liegt schon ein Hash - dann darf nur umschreiben, wer den alten PIN beweist.");
    continue;
  }
  await loesche("turniere/" + id + "/meta/adminPin");
  console.log("     -> Hash gelegt, Klartext geloescht");
}

console.log("\n" + (offen ? offen + " Turnier(e) mit offenem PIN" : "kein offener PIN mehr"));
console.log("Gegenprobe danach:  node pflege/pruefe-live-pin.mjs");
