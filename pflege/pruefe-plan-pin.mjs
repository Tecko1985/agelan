// Prueft Anlegen, Loeschen und Anmelden von Fruehstueck und Essen gegen eine
// nachgestellte Datenbank mit denselben Schreibregeln wie database.rules.json
// (fruehstueckGeheim/essenGeheim, ...PinProbe, ...PinTakt).
//
// Der Anlass (Bugjagd 16.09.2026, Funde A1-A3):
//   A2  "Plan loeschen" raeumte fruehstueckGeheim/<pid> bzw. essenGeheim/<pid>
//       als GANZEN Knoten weg. Die Regel erlaubt Schreiben nur am Kind
//       adminPinHash -> abgewiesen, catch schluckte es, der alte Hash blieb, und
//       jede Neuanlage mit anderem PIN scheiterte mit "Regeln vermutlich nicht
//       veroeffentlicht".
//   A3  Essen schrieb den Hash VOR der Pruefung der Lieferanten-Mail. Ein
//       Tippfehler, und der zweite Anlauf scheiterte am eigenen Hash.
//   A1  Scheiterte beim Umzug eines Altplans nur das Entfernen des Klartexts,
//       blieb der PIN offen in meta stehen - fuer immer, weil der naechste
//       Beweis gelingt und der Umzug nie wieder anlief.
//
// ⚠️ Die Funktionen werden AUS DEN ECHTEN DATEIEN geschnitten (f-aequivalenztest).
//
// Aufruf:              node pflege/pruefe-plan-pin.mjs
// Mutationsprobe:      node pflege/pruefe-plan-pin.mjs --gegen e18f7d6
//   liest die Dateien aus dem Stand VOR den Fixes (git show) und MUSS rot
//   werden - sonst merkt dieses Skript nichts.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const gegenIdx = process.argv.indexOf("--gegen");
const GEGEN = gegenIdx > 0 ? process.argv[gegenIdx + 1] : null;

function lies(datei) {
  if (GEGEN) return execFileSync("git", ["-C", REPO, "show", GEGEN + ":" + datei], { encoding: "utf8" });
  return readFileSync(new URL("../" + datei, import.meta.url), "utf8");
}

function schneide(text, name, pflicht = true) {
  let a = text.indexOf("function " + name + "(");
  if (a < 0) {
    if (pflicht) throw new Error("nicht gefunden: " + name);
    return "";
  }
  if (text.slice(a - 6, a) === "async ") a -= 6;
  const e = text.indexOf("\n}\n", a);
  if (e < 0) throw new Error("kein Ende: " + name);
  return text.slice(a, e + 3);
}

const TS = lies("turnier-service.js");
const BASIS_CODE = ["taktPfadZu", "takte", "legeBeweisAb", "beweisePinAn", "pinHash", "pinHashMoeglich", "pinZuKurz"]
  .map((n) => schneide(TS, n)).join("\n");

const BEREICHE = {
  essen: {
    datei: "essen-service.js", p: "es", P: "ES",
    basis: "essen/aktuell", pid: "essen-aktuell", geheim: "essenGeheim", probe: "essenPinProbe", takt: "essenPinTakt",
    kern: ["esText", "esZahl", "esGespeicherterPin", "esIstAdmin", "esBeweisWegDa", "esBeweisePin", "esHeileAltenPin",
      "esPruefeGemerktenPin", "esErstellePlan", "esLoeschePlan", "esAuthentifiziereAlsAdmin"],
    // esSchreibeOrgaDaten seit Abnahme 25.09.e (E5): Telefon/Lieferanten-Mail in essenOrga, mit
    // Rueckfall auf meta. Die nachgestellte DB unten kennt essenOrga NICHT (= alte Regeln) und
    // prueft damit genau diesen Rueckfall mit.
    neu: ["esEntferneHash", "esRaeumeKlartext", "esSchreibeOrgaDaten"],
    plan: (pin, extra = {}) => ({ titel: "Do", lieferantEmail: "", adminPin: pin, ...extra }),
  },
  fruehstueck: {
    datei: "fruehstueck-service.js", p: "fr", P: "FR",
    basis: "fruehstueck/aktuell", pid: "fruehstueck-aktuell", geheim: "fruehstueckGeheim", probe: "fruehstueckPinProbe", takt: "fruehstueckPinTakt",
    kern: ["frText", "frZahl", "frGespeicherterPin", "frIstAdmin", "frBeweisWegDa", "frBeweisePin", "frHeileAltenPin",
      "frPruefeGemerktenPin", "frErstellePlan", "frLoeschePlan", "frAuthentifiziereAlsAdmin"],
    neu: ["frEntferneHash", "frRaeumeKlartext"],
    plan: (pin) => ({ titel: "Sa", startDatum: "2026-10-02", anzahlTage: 2, schlussUhr: 1200, adminPin: pin }),
  },
};

// --- nachgestellte Datenbank ---------------------------------------------------
// Nur die Regeln, die diese Wege beruehren. Stand database.rules.json 16.09.2026.
function neueWelt(b) {
  const D = {};
  let uhr = 1.789e12;
  const log = [];
  const stoerung = new Set();   // Pfade (Endung), deren naechster Schreibvorgang mit Netzfehler scheitert
  const get = (p) => p.split("/").reduce((o, k) => (o == null ? null : o[k]), D) ?? null;
  const put = (p, v) => {
    const t = p.split("/"); let o = D;
    for (let i = 0; i < t.length - 1; i++) { o[t[i]] ??= {}; o = o[t[i]]; }
    if (v === null) delete o[t.at(-1)]; else o[t.at(-1)] = v;
  };
  function erlaubt(p, v, uid) {
    const t = p.split("/");
    if (t[0] === b.geheim) {
      if (t.length !== 3 || t[2] !== "adminPinHash") return false;   // $sonst / Elternknoten: keine .write-Regel
      const d = get(p);
      return !d || d === get(b.probe + "/" + t[1] + "/" + uid);
    }
    if (t[0] === b.probe) {
      if (t.length !== 3 || t[2] !== uid) return false;
      if (v === null) return true;
      const tk = get(b.takt + "/" + t[1] + "/" + uid);
      return tk > uhr - 5000 && v === get(b.geheim + "/" + t[1] + "/adminPinHash");
    }
    if (t[0] === b.takt) {
      if (t.length !== 3 || t[2] !== uid) return false;
      const d = get(p);
      return !d || uhr > d + 1000;
    }
    if (p === b.basis || p.startsWith(b.basis + "/")) {
      if (v && typeof v === "object" && v.meta && "adminPin" in v.meta) return false;
      return true;
    }
    return false;
  }
  function stoert(p) {
    for (const s of stoerung) if (p.endsWith(s)) { stoerung.delete(s); return true; }
    return false;
  }
  const mkref = (uid) => (p) => ({
    set: async (v) => {
      if (v === "__TS__") v = uhr;
      uhr += 50;
      if (stoert(p)) { log.push("NETZ set " + p); throw new Error("Netz weg"); }
      if (!erlaubt(p, v, uid)) { log.push("DENY set " + p); throw new Error("PERMISSION_DENIED " + p); }
      log.push("OK set " + p); put(p, v);
    },
    remove: async () => {
      uhr += 50;
      if (stoert(p)) { log.push("NETZ remove " + p); throw new Error("Netz weg"); }
      if (!erlaubt(p, null, uid)) { log.push("DENY remove " + p); throw new Error("PERMISSION_DENIED " + p); }
      log.push("OK remove " + p); put(p, null);
    },
    update: async (o) => {
      uhr += 50;
      if (stoert(p)) { log.push("NETZ update " + p); throw new Error("Netz weg"); }
      if (!erlaubt(p, o, uid)) { log.push("DENY update " + p); throw new Error("PERMISSION_DENIED " + p); }
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object") for (const [k2, v2] of Object.entries(v)) put(p + "/" + k + "/" + k2, v2 === "__TS__" ? uhr : v2);
        else put(p + "/" + k, v);
      }
      log.push("OK update " + p);
    },
    once: async () => ({ val: () => get(p) }),
  });
  return { D, get, put, log, mkref, stoerung, tick: (ms) => { uhr += ms; } };
}

// Ein Geraet = eine anonyme Kennung mit eigenem localStorage.
function geraet(b, welt, uid, { konto = false, gemerkt = null } = {}) {
  const text = lies(b.datei);
  const code = b.kern.map((n) => schneide(text, n)).join("\n") + "\n" + b.neu.map((n) => schneide(text, n, false)).join("\n");
  const P = b.P, p = b.p;
  const speicher = new Map();
  if (gemerkt) speicher.set("agelan_admin_pin", gemerkt);
  const ls = { getItem: (k) => speicher.get(k) ?? null, setItem: (k, v) => speicher.set(k, v), removeItem: (k) => speicher.delete(k) };
  const fn = new Function("db", "firebase", "window", "crypto", "localStorage", "setTimeout", "console",
    `const ${P}_BASIS=${JSON.stringify(b.basis)}, ${P}_PIN_KEY="agelan_admin_pin", ${P}_PID=${JSON.stringify(b.pid)},
       ${P}_GEHEIM_PFAD=${JSON.stringify(b.geheim)}, ${P}_PROBE_PFAD=${JSON.stringify(b.probe)}, ${P}_MAX_TAGE=7;
     let ${p}Roh=null, ${p}EigeneUid=${JSON.stringify(uid)}, ${p}PinOk=false, ${p}PinLaeuft=false;
     const ${P}_ORGA_PFAD="essenOrga/aktuell"; let ${p}Orga=null, ${p}OrgaHorcher=null, ${p}OrgaVersuch=null;
     const ${p}AuthBereit=Promise.resolve();
     const PIN_MIN=6, PIN_ZU_KURZ="zu kurz", PIN_UNSICHER="unsicher";
     function istMockModus(){ return false; }
     function kontoIstVeranstalter(){ return ${konto}; }
     function ${p}Melde(){}
     ${BASIS_CODE}
     ${code}
     return {
       setRoh: (r) => { ${p}Roh = r; },
       erstelle: ${p}ErstellePlan, loesche: ${p}LoeschePlan, anmelden: ${p}AuthentifiziereAlsAdmin,
       gemerkt: ${p}PruefeGemerktenPin, pinOk: () => ${p}PinOk
     };`);
  const g = fn({ ref: (pf) => welt.mkref(uid)(pf) }, { database: { ServerValue: { TIMESTAMP: "__TS__" } } },
    { crypto: webcrypto }, webcrypto, ls, (f, ms) => { welt.tick(ms); f(); }, { error() {}, log() {} });
  // Wie der Listener in der App: vor jedem Schritt den Stand der Datenbank sehen.
  const frisch = () => g.setRoh(welt.get(b.basis));
  // Ein Wurf aus dem Dienst ist fuer die Oberflaeche ein Fehlschlag, kein Absturz des Pruefstands.
  const halte = async (f) => { try { return await f(); } catch (e) { return { erfolg: false, geworfen: String(e) }; } };
  return {
    erstelle: (a) => halte(() => { frisch(); return g.erstelle(a); }),
    loesche: () => halte(() => { frisch(); return g.loesche(); }),
    anmelden: (pin) => halte(() => { frisch(); return g.anmelden(pin); }),
    gemerkt: () => halte(() => { frisch(); return g.gemerkt(); }),
    pinOk: g.pinOk,
  };
}

const hashVon = async (b, pin) => {
  const buf = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(b.pid + ":" + pin));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
};

let fehler = 0, gesamt = 0;
function zusage(name, ok, welt) {
  gesamt++;
  if (ok) { console.log("  OK    " + name); return; }
  fehler++;
  console.log("  FEHLT " + name);
  if (welt) console.log("        Log: " + welt.log.join(" | "));
}

for (const [name, b] of Object.entries(BEREICHE)) {
  console.log("\n== " + name + (GEGEN ? " (Stand " + GEGEN + ")" : ""));
  const hashPfad = b.geheim + "/" + b.pid + "/adminPinHash";

  if (name === "essen") {
    // A3: Tippfehler in der Lieferanten-Mail
    const w = neueWelt(b); const g = geraet(b, w, "host");
    const r1 = await g.erstelle(b.plan("geheim123", { lieferantEmail: "pizza@" }));
    zusage("A3 Tippfehler in der Mail wird abgewiesen", !r1.erfolg, w);
    zusage("A3 ... und hinterlaesst keinen Hash", w.get(hashPfad) === null, w);
    const r2 = await g.erstelle(b.plan("geheim123", { lieferantEmail: "pizza@x.de" }));
    zusage("A3 zweiter Anlauf mit richtiger Mail legt an", r2.erfolg === true, w);
  }

  {
    // A3: das Schreiben des Plans scheitert (Netz), zweiter Anlauf mit demselben PIN
    const w = neueWelt(b); const g = geraet(b, w, "host");
    w.stoerung.add(b.basis);
    const r1 = await g.erstelle(b.plan("geheim123"));
    zusage("A3 Netzfehler beim Plan meldet Fehlschlag", !r1.erfolg, w);
    zusage("A3 ... und nimmt den Hash wieder zurueck", w.get(hashPfad) === null, w);
    const r2 = await g.erstelle(b.plan("geheim123"));
    zusage("A3 zweiter Anlauf mit demselben PIN legt an", r2.erfolg === true && w.get(b.basis + "/meta/titel") !== null, w);
  }
  {
    // A3: Plan scheitert UND das Zuruecknehmen scheitert -> derselbe PIN kommt trotzdem durch
    const w = neueWelt(b); const g = geraet(b, w, "host");
    w.stoerung.add(b.basis);
    // Das Zuruecknehmen erst NACH dem Hinterlegen stoeren - sonst traefe es das Hinterlegen selbst.
    const orig = w.mkref;
    let hinterlegt = false;
    w.mkref = (uid) => (pf) => {
      const r = orig(uid)(pf);
      if (pf === hashPfad) {
        const set = r.set, rem = r.remove;
        r.set = async (v) => { await set(v); hinterlegt = true; };
        r.remove = async () => { if (hinterlegt) throw new Error("Netz weg"); return rem(); };
      }
      return r;
    };
    await g.erstelle(b.plan("geheim123"));
    w.mkref = orig;
    zusage("A3 (Probe) Hash blieb nach gescheitertem Zuruecknehmen stehen", w.get(hashPfad) !== null, w);
    w.tick(3000);
    const r2 = await g.erstelle(b.plan("geheim123"));
    zusage("A3 derselbe PIN kommt ueber den stehengebliebenen Hash hinweg", r2.erfolg === true, w);
  }

  {
    // A2: anlegen, loeschen, mit ANDEREM PIN neu anlegen
    const w = neueWelt(b); const g = geraet(b, w, "host");
    const r1 = await g.erstelle(b.plan("geheim123"));
    zusage("A2 Plan angelegt", r1.erfolg === true, w);
    w.tick(3000);
    const r2 = await g.loesche();
    zusage("A2 Loeschen gelingt ohne Warnung", r2.erfolg === true && !r2.warnung, w);
    zusage("A2 ... und der Hash ist weg", w.get(hashPfad) === null, w);
    w.tick(3000);
    const r3 = await g.erstelle(b.plan("neuerPin99"));
    zusage("A2 neuer Plan mit anderem PIN geht", r3.erfolg === true, w);
    zusage("A2 ... und traegt den neuen Hash", w.get(hashPfad) === await hashVon(b, "neuerPin99"), w);
  }
  {
    // A2: Loeschen auf einem zweiten Geraet mit gemerktem PIN. Wie in der App wird der
    // gemerkte PIN beim Eintreffen der Daten bewiesen (gemerkt()), erst dann geloescht.
    // ⚠️ Seit der Fixpruefung 26.09.2026 (A3-01) macht das Konto-Merkmal allein NICHT mehr
    // zum Veranstalter - die Datenbank kennt es nicht. Vorher rief dieser Fall loesche()
    // ohne Beweis auf und verliess sich auf kontoIstVeranstalter().
    const w = neueWelt(b); const host = geraet(b, w, "host");
    await host.erstelle(b.plan("geheim123"));
    const zweit = geraet(b, w, "orga", { konto: true, gemerkt: "geheim123" });
    w.tick(3000);
    await zweit.gemerkt();
    w.tick(3000);
    const r = await zweit.loesche();
    zusage("A2 Veranstalter-Konto mit gemerktem PIN raeumt den Hash", r.erfolg === true && w.get(hashPfad) === null, w);
  }
  {
    // A3-01: Konto-Merkmal OHNE jeden Beweis darf nicht loeschen - Plan und Hash bleiben.
    const w = neueWelt(b); const host = geraet(b, w, "host");
    await host.erstelle(b.plan("geheim123"));
    const fremd = geraet(b, w, "orga", { konto: true });
    w.tick(3000);
    const r = await fremd.loesche();
    zusage("A3-01 Konto ohne PIN: Loeschen abgelehnt, Plan und Hash bleiben", r.erfolg === false && w.get(b.basis + "/meta/titel") !== null && w.get(hashPfad) !== null, w);
  }
  {
    // A2: das anlegende Geraet (hostId) loescht, seine Beweisablage ist aber weg und der PIN
    // nicht gemerkt -> Plan weg, der Hash laesst sich nicht austragen: Warnung statt Stille.
    const w = neueWelt(b); const host = geraet(b, w, "host");
    await host.erstelle(b.plan("geheim123"));
    w.put(b.probe + "/" + b.pid + "/host", null);
    const hostOhnePin = geraet(b, w, "host");
    w.tick(3000);
    const r = await hostOhnePin.loesche();
    zusage("A2 ohne Beweis: Plan weg, aber Warnung statt Stille", r.erfolg === true && typeof r.warnung === "string" && r.warnung.length > 0, w);
    w.tick(3000);
    const r2 = await hostOhnePin.erstelle(b.plan("geheim123"));
    zusage("A2 ... und die Warnung stimmt: mit dem alten PIN geht es weiter", r2.erfolg === true, w);
  }

  {
    // A1: Altplan mit Klartext; beim Umzug scheitert nur das Entfernen des Klartexts
    const w = neueWelt(b);
    w.put(b.basis + "/meta", { titel: "Alt", adminPin: "altpin123456" });
    w.stoerung.add("/meta/adminPin");
    const g = geraet(b, w, "orga");
    const r1 = await g.anmelden("altpin123456");
    zusage("A1 (Probe) erste Anmeldung gelingt, Klartext bleibt haengen", r1.erfolg === true && w.get(b.basis + "/meta/adminPin") !== null, w);
    w.tick(10000);
    const g2 = geraet(b, w, "orga");
    const r2 = await g2.anmelden("altpin123456");
    zusage("A1 naechste Anmeldung raeumt den Klartext weg", r2.erfolg === true && w.get(b.basis + "/meta/adminPin") === null, w);
  }
  {
    // A1: dasselbe ueber den gemerkten PIN beim Laden
    const w = neueWelt(b);
    w.put(b.basis + "/meta", { titel: "Alt", adminPin: "altpin123456" });
    w.stoerung.add("/meta/adminPin");
    const g = geraet(b, w, "orga", { gemerkt: "altpin123456" });
    await g.gemerkt();
    w.tick(10000);
    const g2 = geraet(b, w, "orga", { gemerkt: "altpin123456" });
    await g2.gemerkt();
    zusage("A1 gemerkter PIN beim Laden raeumt den Klartext weg", g2.pinOk() === true && w.get(b.basis + "/meta/adminPin") === null, w);
  }
}

console.log("\n" + (gesamt - fehler) + " von " + gesamt + " Zusagen erfuellt");
if (fehler) process.exit(1);
