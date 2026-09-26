// ===========================================================================
// agelan-worker – prüft die beiden Passwörter der AgeLan.
//
// Bewusst ein EIGENER Worker mit EIGENEN Secrets, nicht der landingpage-Worker
// des Vereins: die AgeLan gehört zu Michels privatem Bereich (Repo unter
// Tecko1985), und ein privates Tool soll nicht daran hängen, ob am
// Vereins-Gateway gerade etwas umgebaut wird – und umgekehrt. Gleiches Muster
// wie beim beleg-scanner-Worker.
//
// Der Worker kann genau eine Sache: ein eingegebenes Passwort gegen ein Secret
// vergleichen und ja/nein sagen. Kein Login, keine Sessions, kein Nextcloud,
// keine Datenbank. Was er nicht kann, kann auch nicht missbraucht werden.
//
// Secrets (im Cloudflare-Dashboard bei DIESEM Worker zu setzen):
//   PW_AGELAN              = Einladung: einmal noetig, um sich ein Konto anzulegen
//   PW_AGELAN_VERANSTALTER = Turniere anlegen und Konten verwalten (nur Michel)
//   FIREBASE_DIENSTKONTO   = JSON-Schluessel eines Firebase-Dienstkontos (Projekt
//                            agelan-ab042). Damit stellt `firebase-rolle` fuer ⭐/🛠
//                            ein Custom Token aus (Verwaltung ohne PIN). Fehlt es,
//                            antwortet nur diese Aktion 503; alles andere laeuft.
//   DISCORD_BOT_TOKEN      = Token des Bots, der die Benachrichtigungen verschickt.
//                            Fehlt es, sagen NUR die Discord-Aktionen das klar;
//                            alles Uebrige laeuft unveraendert weiter. Auch die
//                            Meldung ueber eine neue Anmeldung entfaellt dann
//                            still - eine Anmeldung darf daran nicht scheitern.
//
// Bindings:
//   KONTEN (KV) = die Benutzerkonten. Fehlt das Binding, laufen die Konto-
//   Aktionen mit einer klaren Meldung ins Leere; das alte gemeinsame Passwort
//   (verify-action-password) funktioniert unabhaengig davon weiter.
//
// ⚠️ Konten liegen im KV des Workers, NICHT in Firebase: die Firebase-Daten
// sind oeffentlich lesbar, dort waeren die Passwort-Hashes fuer jeden abrufbar
// und offline angreifbar.
//
// ⚠️ Das Konto ist eine Zugangs- und Namenssache, KEIN Datenriegel. Die
// Firebase-Regeln lassen weiterhin jeden anonymen Client schreiben. Was das
// Konto bringt: ein fester Nickname (und damit eine saubere Abrechnung) und
// dass nach der Anmeldung kein gemeinsames Passwort mehr herumgereicht wird.
//
// ⚠️ Ein PUT ohne keep_bindings löscht sämtliche Secrets. deploy-worker.ps1
// schickt es mit, der Dashboard-Weg nicht.
// ===========================================================================

// Scope (schickt der Client) -> Name des Secrets (steht nur hier im Worker).
// Der Client kennt die Secret-NAMEN bewusst nicht, nur den Scope.
const PASSWORT_SECRETS = {
  "agelan-zugang": "PW_AGELAN",
  "agelan-veranstalter": "PW_AGELAN_VERANSTALTER",
};

// Von wo darf ein Browser anfragen. CORS ist kein Serverschutz (curl kommt
// immer durch) – es verhindert nur, dass eine fremde Seite die Prüfung im
// Namen eines Besuchers aufruft. Der echte Schutz sind Passwort und Bremse.
const ERLAUBTE_ORIGINS = [
  "https://tecko1985.github.io",
  "http://localhost:8791", // Dev-Server der AgeLan
];

// Höchstens so viele Fehlversuche je IP und Stunde. Ein vergessenes Passwort
// braucht ein paar Anläufe, ein Durchprobieren scheitert daran.
const FEHL_MAX_PRO_STUNDE = 30;
const FEHL_ZAEHLER = new Map();

export default {
  // ⚠️ ctx kommt dazu, weil die Meldung ueber eine neue Anmeldung NACH der
  // Antwort laufen muss (ctx.waitUntil). Zwei Discord-Aufrufe je Veranstalter
  // duerfen den Menschen, der sich gerade anmeldet, nicht warten lassen.
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsKopf(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: Object.assign({}, cors, {
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        }),
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Nur POST" }, 405, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "Kein gültiges JSON" }, 400, cors);
    }

    const aktion = String(body.action || "");
    if (aktion === "verify-action-password") return pruefePasswort(request, body, env, cors);
    if (aktion === "konto-anlegen")  return kontoAnlegen(request, body, env, cors, ctx);
    if (aktion === "konto-login")    return kontoLogin(request, body, env, cors);
    if (aktion === "konto-pruefen")  return kontoPruefen(body, env, cors);
    if (aktion === "konto-admin")    return kontoAdmin(request, body, env, cors);
    if (aktion === "konto-streamer") return kontoStreamer(request, body, env, cors);
    if (aktion === "konto-orga")     return kontoOrga(request, body, env, cors);
    if (aktion === "konto-liste")    return kontoListe(request, body, env, cors);
    if (aktion === "konto-loeschen") return kontoLoeschen(request, body, env, cors);
    if (aktion === "konto-discord")  return kontoDiscord(body, env, cors);
    if (aktion === "discord-test")   return discordTest(body, env, cors);
    if (aktion === "discord-sammel") return discordSammel(request, body, env, cors);
    if (aktion === "firebase-rolle") return firebaseRolle(body, env, cors);
    return json({ error: "Unbekannte Aktion" }, 400, cors);
  },
};

async function pruefePasswort(request, body, env, cors) {
  // Die Bremse VOR dem Vergleich: sonst kostet jeder Rateversuch weiterhin
  // einen vollen Durchlauf.
  if (!bremseOffen(request)) {
    return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
  }

  const scope = String(body.scope || "");
  // hasOwnProperty statt direktem Zugriff: sonst träfe scope="constructor"
  // etwas aus dem Prototyp statt aus der Tabelle.
  const secretName = Object.prototype.hasOwnProperty.call(PASSWORT_SECRETS, scope)
    ? PASSWORT_SECRETS[scope]
    : null;
  if (!secretName) return json({ error: "Unbekannter Passwort-Scope" }, 400, cors);

  // Fehlt das Secret, ist das ein Einrichtungsfehler und keine falsche Eingabe.
  // Der Unterschied 500 gegen 403 ist beim Aufsetzen der einzige Beleg dafür,
  // dass das Secret wirklich sitzt.
  if (!env[secretName]) {
    return json({ error: "Worker-Secret " + secretName + " ist nicht konfiguriert" }, 500, cors);
  }

  const stimmt = await passwortGleich(String(body.password || ""), env[secretName]);
  if (!stimmt) {
    bremseFehlschlag(request);
    // ⚠️ Hier, nicht oben am Eingang: limit() zaehlt bei JEDEM Aufruf mit -- am
    // Eingang wuerde normales Arbeiten die Bremse fuellen.
    if (!(await bindungBremseOffen(env, request, "aktions-pw"))) {
      return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
    }
    return json({ error: "Falsches Passwort" }, 403, cors);
  }
  return json({ ok: true }, 200, cors);
}

// Vergleich über die Hashes und ohne vorzeitigen Abbruch: aus der Antwortzeit
// lässt sich so nicht ablesen, wie viele Zeichen schon stimmten.
async function passwortGleich(eingabe, erwartet) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(eingabe)),
    crypto.subtle.digest("SHA-256", enc.encode(erwartet)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bremseIp(request) {
  return String((request.headers && request.headers.get("CF-Connecting-IP")) || "");
}

// Cloudflares eigenes Zaehlwerk (Bindung "BREMSE"). Es zaehlt AUSSERHALB des
// Isolates -- und genau das ist der Unterschied zu FEHL_ZAEHLER hier drueber:
// die Map lebt nur im gerade laufenden Isolate. Cloudflare verteilt Anfragen
// auf viele davon und raeumt kalte weg; eine Welle aus einem Anschluss sieht
// deshalb oft eine leere Map. Die Map bleibt als schnelle erste Reihe stehen,
// die Bindung ist die, die live wirklich haelt.
//
// ⚠️⚠️ BEI DIESEM WORKER IST DIE BINDUNG BEWUSST NICHT GESETZT.
// Michel am 15.09.2026: "die bremse im agelan binding brauchen wir nicht."
// AgeLan ist ein privates Event-Tool mit einer Handvoll Teilnehmern, die das
// Passwort ohnehin kennen -- der Aufwand lohnt hier nicht.
//
// Der Code bleibt trotzdem stehen, weil er GENAU DANN NICHTS TUT: fehlt
// env.BREMSE, gibt bindungBremseOffen sofort true zurueck, ein typeof je
// Fehlversuch. Die Map-Bremse darueber laeuft unveraendert weiter. Wer die
// Bindung spaeter doch setzt (Name BREMSE), schaltet sie damit scharf, ohne
// eine Zeile zu aendern.
//
// ⚠️ Das ist eine ENTSCHEIDUNG, kein offener Befund -- bei einer Abnahme
// nicht erneut melden. Der Rest der Flotte hat die Bindung seit dem
// 15.09.2026 (landingpage, beleg-scanner, mitgliedsportal,
// vereinsverwaltung); dort gehoert sie auch hin, denn dort haengen
// Vereinsdaten dran. Nachsehen: ToolsUebersicht/pruefe-bremsen.ps1.
//
// Drei Faelle geben bewusst frei statt zu sperren: Bindung fehlt (aelterer
// Deploy), keine Client-Adresse, Bindung wirft. Eine kaputte Bremse darf den
// normalen Weg nicht kippen.
async function bindungBremseOffen(env, request, kennung) {
  if (!env || !env.BREMSE || typeof env.BREMSE.limit !== "function") return true;
  const ip = bremseIp(request);
  if (!ip) return true;
  try {
    const r = await env.BREMSE.limit({ key: kennung + ":" + ip });
    return r && r.success !== false;
  } catch (fehler) {
    console.warn("BREMSE-Bindung nicht nutzbar: " + ((fehler && fehler.message) || fehler));
    return true;
  }
}

function bremseOffen(request) {
  const ip = bremseIp(request);
  if (!ip) return true;
  const eintrag = FEHL_ZAEHLER.get(ip);
  if (!eintrag || Date.now() - eintrag.start > 3600000) return true;
  return eintrag.n < FEHL_MAX_PRO_STUNDE;
}

// Nur nach einem Fehlversuch aufrufen, nie nach einem erfolgreichen.
function bremseFehlschlag(request) {
  const ip = bremseIp(request);
  if (!ip) return;
  const jetzt = Date.now();
  const eintrag = FEHL_ZAEHLER.get(ip);
  if (!eintrag || jetzt - eintrag.start > 3600000) {
    FEHL_ZAEHLER.set(ip, { start: jetzt, n: 1 });
    // Aufräumen, damit die Map in einem langlebigen Isolate nicht wächst.
    if (FEHL_ZAEHLER.size > 500) {
      for (const [k, v] of FEHL_ZAEHLER) {
        if (jetzt - v.start > 3600000) FEHL_ZAEHLER.delete(k);
      }
    }
    return;
  }
  eintrag.n++;
}

function corsKopf(origin) {
  return {
    "Access-Control-Allow-Origin": ERLAUBTE_ORIGINS.includes(origin) ? origin : ERLAUBTE_ORIGINS[0],
    "Vary": "Origin",
  };
}

function json(daten, status, cors) {
  return new Response(JSON.stringify(daten), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors),
  });
}

// ===========================================================================
// Benutzerkonten (Nickname + eigenes Passwort)
//
// Ablauf: einmal mit dem LAN-Passwort ein Konto anlegen, danach nur noch
// Nickname + eigenes Passwort. Das LAN-Passwort ist die Einladung, nicht mehr
// der tägliche Zugang.
// ===========================================================================

const NICK_MIN = 2;
const NICK_MAX = 20;
const PW_MIN = 4;              // Fun-Event, kein Bankkonto – aber nicht leer
const TOKEN_TAGE = 120;        // deckt eine Veranstaltung samt Vorlauf ab
const PBKDF2_RUNDEN = 100000;

// --- Discord ---------------------------------------------------------------
// Eine Discord-Benutzer-ID ist ein "Snowflake": eine reine Zahl, keine
// Buchstaben. 17 Stellen haben die aeltesten Konten von 2016, heute werden 18
// bis 19 vergeben; 20 ist Reserve, damit die Pruefung nicht in ein paar Jahren
// faelschlich ablehnt.
//
// ⚠️ Fast jede:r tippt beim ersten Mal seinen Discord-NAMEN hier hinein. Das
// ist der haeufigste Fehler ueberhaupt, deshalb sagt die Meldung nicht bloss
// "falsch", sondern gleich die Klickfolge zum Richtigen.
const DISCORD_ID_RE = /^[0-9]{17,20}$/;
const DISCORD_ID_HILFE =
  "Das ist keine Discord-ID. Gemeint ist nicht dein Discord-Name, sondern eine lange Zahl. " +
  "So findest du sie: Discord öffnen → Einstellungen → Erweitert → Entwicklermodus einschalten. " +
  "Dann Rechtsklick auf dich selbst → „Benutzer-ID kopieren“.";

const DISCORD_API = "https://discord.com/api/v10";

// Wie oft darf ein Konto eine Testnachricht ausloesen. ⚠️ Nicht Bequemlichkeit,
// sondern Schutz: wer eine FREMDE ID hinterlegt, koennte diese Person sonst im
// Sekundentakt zuspammen. Der Zeitstempel liegt im KV, nicht im Speicher des
// Workers - sonst waere die Bremse nach jedem Neustart wieder offen.
const DISCORD_TEST_PAUSE_MS = 60000;

// Höchstens so viele Leute in einem Rutsch anschreiben. ⚠️ Jede Person kostet
// ZWEI Aufrufe an Discord (Kanal öffnen, hineinschreiben), und ein Worker hat
// ein Zeitbudget. Lieber sauber ablehnen als mittendrin sterben - dann wäre
// unklar, wer schon Bescheid weiß und wer nicht.
const DISCORD_SAMMEL_MAX = 60;
// Wie viele Zeilen "was du bestellt hast" hoechstens in einer Nachricht stehen.
const DISCORD_POSTEN_MAX = 20;

// Gerichtnamen und Sonderwuensche kommen aus einem Formular, das jeder
// Teilnehmer ausfuellt, und landen hier in einer Nachricht, die der Bot unter
// Michels Namen verschickt.
// ⚠️ Deshalb: Zeilenumbrueche raus (sonst baut sich jemand eigene Absaetze und
// damit eine eigene Nachricht), `@` raus (keine Erwaehnungen), Backticks und
// Sternchen raus (kein Markdown), harte Laengengrenze. Der Text bleibt lesbar,
// aber er kann den Rahmen nicht mehr sprengen.
function discordSauber(wert, maxLaenge) {
  return String(wert == null ? "" : wert)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[@`*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLaenge);
}

// Leer ist erlaubt und heisst "nicht hinterlegt": die ID ist FREIWILLIG. Als
// Pflichtfeld wuerde sie jeden aussperren, der sie gerade nicht findet - und
// wer sich nicht anmelden kann, kann auch kein Essen bestellen.
function discordIdPruefen(wert) {
  const s = String(wert == null ? "" : wert).trim();
  if (!s) return { id: "" };
  if (!DISCORD_ID_RE.test(s)) return { fehler: DISCORD_ID_HILFE };
  return { id: s };
}

// Schickt EINE Direktnachricht. Gibt immer ein Ergebnisobjekt zurueck und wirft
// nie: der spaetere Sammelversand muss weiterlaufen, wenn es bei einer Person
// hakt, und danach sagen koennen, bei WEM es gehakt hat.
//
// Zwei Aufrufe sind noetig - Discord kennt kein "schick an Benutzer X". Man
// oeffnet erst einen DM-Kanal und schreibt dann hinein.
//
// ⚠️ Zwei Grenzen, die niemand umgehen kann:
//   - Der Bot erreicht nur, wer mit ihm auf demselben Server ist.
//   - Wer "Direktnachrichten von Servermitgliedern" ausgeschaltet hat, bekommt
//     nichts; Discord antwortet dann 403. Auch der Veranstalter kann das nicht
//     aendern, die Person muss es selbst umstellen.
// Beides MUSS der Aufrufer dem Menschen zeigen. Sonst denkt der Veranstalter,
// alle waeren informiert, und drei Leute holen ihr Essen nie ab.
async function discordDm(env, empfaengerId, text) {
  if (!env.DISCORD_BOT_TOKEN) {
    return { ok: false, grund: "Der Discord-Bot ist noch nicht eingerichtet (Secret DISCORD_BOT_TOKEN fehlt)." };
  }
  const geprueft = discordIdPruefen(empfaengerId);
  if (geprueft.fehler || !geprueft.id) {
    return { ok: false, grund: "Keine gültige Discord-ID hinterlegt." };
  }

  const kopf = {
    "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
    "Content-Type": "application/json",
  };

  // Schritt 1: DM-Kanal oeffnen - oder den bestehenden zurueckbekommen.
  const kanal = await discordRufe(DISCORD_API + "/users/@me/channels", {
    method: "POST", headers: kopf,
    body: JSON.stringify({ recipient_id: geprueft.id }),
  });
  if (!kanal.ok) return { ok: false, grund: discordGrund(kanal.status, true) };
  const kanalId = kanal.daten && kanal.daten.id;
  if (!kanalId) return { ok: false, grund: "Discord hat keinen Kanal zurückgegeben." };

  // Schritt 2: hineinschreiben. 2000 Zeichen sind die Grenze, 1900 laesst Luft.
  const nachricht = await discordRufe(DISCORD_API + "/channels/" + kanalId + "/messages", {
    method: "POST", headers: kopf,
    body: JSON.stringify({ content: String(text).slice(0, 1900) }),
  });
  if (!nachricht.ok) return { ok: false, grund: discordGrund(nachricht.status, false) };
  return { ok: true };
}

// Aus einem HTTP-Status wird ein Satz, den ein Mensch versteht UND der sagt,
// wer etwas dagegen tun kann.
function discordGrund(status, beimOeffnen) {
  if (status === 403) return "Direktnachrichten sind gesperrt. Die Person muss sie in Discord für Servermitglieder erlauben.";
  if (status === 401) return "Der Bot-Token stimmt nicht. Das muss der Veranstalter richten.";
  if (status === 429) return "Discord bremst gerade. Bitte in ein paar Minuten noch einmal versuchen.";
  if (status === 0)   return "Discord war nicht erreichbar.";
  if (beimOeffnen && (status === 400 || status === 404)) {
    return "Diese Discord-ID gibt es nicht, oder die Person ist nicht auf dem AgeLan-Server.";
  }
  return "Discord antwortet mit Fehler " + status + ".";
}

// Ein Aufruf an Discord, mit EINEM Wiederholversuch bei 429. Discord nennt die
// Wartezeit selbst in `retry_after` (Sekunden, mit Nachkommastellen); blind zu
// wiederholen wuerde die Sperre nur verlaengern.
// ⚠️ Nur einmal wiederholt und hoechstens 10 Sekunden gewartet: ein Worker hat
// ein Zeitbudget, eine Warteschleife wuerde den ganzen Sammelversand mitreissen.
async function discordRufe(url, optionen) {
  let antwort;
  try {
    antwort = await fetch(url, optionen);
  } catch (e) {
    return { ok: false, status: 0, daten: null };
  }
  if (antwort.status === 429) {
    let warten = 1;
    try {
      const b = await antwort.json();
      if (b && typeof b.retry_after === "number") warten = b.retry_after;
    } catch (e) { /* ohne Angabe bleibt es bei einer Sekunde */ }
    if (warten > 10) return { ok: false, status: 429, daten: null };
    await new Promise((r) => setTimeout(r, Math.ceil(warten * 1000)));
    try {
      antwort = await fetch(url, optionen);
    } catch (e) {
      return { ok: false, status: 0, daten: null };
    }
  }
  let daten = null;
  try { daten = await antwort.json(); } catch (e) { /* eine 204 hat keinen Rumpf */ }
  return { ok: antwort.ok, status: antwort.status, daten: daten };
}

// Die Rundenzahl wandert MIT in den gespeicherten Hash. Sonst ließen sich alte
// Konten nach einer Änderung dieser Zahl nicht mehr prüfen.
function hashFormat(salt, runden, hash) {
  return "pbkdf2$" + runden + "$" + salt + "$" + hash;
}

async function pbkdf2(passwort, saltB64, runden) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(passwort), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64ZuBytes(saltB64), iterations: runden },
    key,
    256
  );
  return bytesZuB64(new Uint8Array(bits));
}

async function passwortHashen(passwort) {
  const salt = bytesZuB64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(passwort, salt, PBKDF2_RUNDEN);
  return hashFormat(salt, PBKDF2_RUNDEN, hash);
}

async function passwortStimmt(passwort, gespeichert) {
  const teile = String(gespeichert || "").split("$");
  if (teile.length !== 4 || teile[0] !== "pbkdf2") return false;
  const runden = parseInt(teile[1], 10);
  if (!(runden > 0 && runden <= 1000000)) return false;
  const hash = await pbkdf2(passwort, teile[2], runden);
  return zeitgleich(hash, teile[3]);
}

// Vergleich ohne vorzeitigen Abbruch.
function zeitgleich(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Der Schlüssel im KV. Kleinbuchstaben, damit "Tecko" und "tecko" nicht zwei
// Konten werden – angezeigt wird trotzdem die Schreibweise der Anmeldung.
function nickSchluessel(nick) {
  return "konto:" + String(nick).trim().toLowerCase();
}

function nickPruefen(nick) {
  const n = String(nick == null ? "" : nick).trim();
  if (n.length < NICK_MIN) return { fehler: "Der Name braucht mindestens " + NICK_MIN + " Zeichen." };
  if (n.length > NICK_MAX) return { fehler: "Der Name darf höchstens " + NICK_MAX + " Zeichen haben." };
  if (!/^[\wÄÖÜäöüß .\-]+$/u.test(n)) {
    return { fehler: "Erlaubt sind Buchstaben, Zahlen, Punkt, Bindestrich und Leerzeichen." };
  }
  return { nick: n };
}

function kvDa(env) {
  return !!(env.KONTEN && typeof env.KONTEN.get === "function");
}

// Schlüssel zum Signieren der Anmelde-Token. Wird beim ersten Mal selbst
// erzeugt und im KV abgelegt – so muss dafür kein Secret von Hand gesetzt
// werden. Fällt er weg, sind nur alle Anmeldungen ungültig; niemand verliert
// sein Konto.
async function tokenSchluessel(env) {
  let roh = await env.KONTEN.get("_tokenSecret");
  if (!roh) {
    roh = bytesZuB64(crypto.getRandomValues(new Uint8Array(32)));
    await env.KONTEN.put("_tokenSecret", roh);
  }
  return crypto.subtle.importKey(
    "raw", b64ZuBytes(roh), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

// ⚠️ Das Admin-Merkmal steht MIT im signierten Token, ist also nicht faelschbar.
// Der Client darf ihm deshalb glauben - er kann es nicht selbst setzen.
// ⚠️ Abnahme 25.09.e B2-11: `t` = angelegtAm des Kontos. Ein Token gehoert damit zu GENAU
// einem Konto, nicht zu einem Namen: wurde das Konto geloescht und unter demselben Namen
// neu angelegt, passt das alte Token nicht mehr (siehe tokenPasstZuKonto). Vorher gab
// konto-pruefen dem alten Token sogar ein frisches mit den Rechten des Nachfolgers.
async function tokenBauen(env, nick, admin, streamer, orga, angelegtAm) {
  const nutzlast = { n: nick, e: Date.now() + TOKEN_TAGE * 86400000, t: Number(angelegtAm) || 0 };
  if (admin) nutzlast.a = 1;
  if (streamer) nutzlast.s = 1;
  // ⚠️ `orga` entscheidet ueber Geld (wer beim Essen nichts zahlt) und gehoert
  // deshalb genauso ins signierte Token wie die Rechte. Im Browser bleibt es
  // trotzdem eine BEDIEN-Sperre: wer sein localStorage verstellt, sieht sich
  // selbst als Orga. Die Firebase-Regeln pruefen das nicht — der Veranstalter
  // sieht in der Bestellliste, wer sich als Orga eingetragen hat, und kann es
  // je Bestellung umstellen.
  if (orga) nutzlast.o = 1;
  const teil = bytesZuB64Url(new TextEncoder().encode(JSON.stringify(nutzlast)));
  const key = await tokenSchluessel(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(teil));
  return teil + "." + bytesZuB64Url(new Uint8Array(sig));
}

// ⚠️ Der GANZE Rumpf steht im try: atob() wirft bei allem, was kein sauberes
// base64 ist, und ein geworfener Fehler nimmt hier den ganzen Worker mit
// (Cloudflare-Fehler 1101). Genau das passiert im Alltag – ein abgeschnittenes
// oder von Hand verstelltes Token im localStorage darf niemanden aussperren,
// sondern muss schlicht als „nicht angemeldet" gelten. Live nachgemessen am
// 2026-09-03: vorher 1101, danach {"ok":false}.
async function tokenLesen(env, token) {
  try {
    const teile = String(token || "").split(".");
    if (teile.length !== 2) return null;
    const key = await tokenSchluessel(env);
    const ok = await crypto.subtle.verify(
      "HMAC", key, b64UrlZuBytes(teile[1]), new TextEncoder().encode(teile[0])
    );
    if (!ok) return null;
    const nutzlast = JSON.parse(new TextDecoder().decode(b64UrlZuBytes(teile[0])));
    if (!nutzlast || !nutzlast.n || !(nutzlast.e > Date.now())) return null;
    return { nick: nutzlast.n, admin: nutzlast.a === 1, streamer: nutzlast.s === 1, orga: nutzlast.o === 1,
             t: typeof nutzlast.t === "number" ? nutzlast.t : null };
  } catch (e) {
    return null;
  }
}

// B2-11: passt das (gueltig signierte) Token zu DIESEM Konto? Alte Token ohne `t` (vor dem
// 26.09.2026 ausgestellt) gelten als abgelaufen - einmal neu anmelden.
function tokenPasstZuKonto(gelesen, konto) {
  return !!gelesen && !!konto && typeof gelesen.t === "number" && gelesen.t === (Number(konto.angelegtAm) || 0);
}

async function kontoAnlegen(request, body, env, cors, ctx) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet (KV-Binding KONTEN fehlt)." }, 500, cors);
  if (!bremseOffen(request)) {
    return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
  }
  if (!env.PW_AGELAN) return json({ error: "Worker-Secret PW_AGELAN ist nicht konfiguriert" }, 500, cors);

  // Die Einladung: einmalig, danach nie wieder nötig.
  const einladungOk = await passwortGleich(String(body.lanPasswort || ""), env.PW_AGELAN);
  if (!einladungOk) {
    bremseFehlschlag(request);
    // ⚠️ Hier, nicht oben am Eingang: limit() zaehlt bei JEDEM Aufruf mit -- am
    // Eingang wuerde normales Arbeiten die Bremse fuellen.
    if (!(await bindungBremseOffen(env, request, "konto-anlegen"))) {
      return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
    }
    return json({ error: "Falsches Passwort für die Anmeldung." }, 403, cors);
  }

  const geprueft = nickPruefen(body.nickname);
  if (geprueft.fehler) return json({ error: geprueft.fehler }, 400, cors);

  const passwort = String(body.passwort || "");
  if (passwort.length < PW_MIN) {
    return json({ error: "Das Passwort braucht mindestens " + PW_MIN + " Zeichen." }, 400, cors);
  }

  // Freiwillig - leer ist der Normalfall. Steht aber etwas drin, muss es
  // stimmen. ⚠️ Sonst legt jemand sein Konto mit "Tecko" als Discord-ID an und
  // erfaehrt nie, dass er keine Benachrichtigung bekommt.
  const discord = discordIdPruefen(body.discordId);
  if (discord.fehler) return json({ error: discord.fehler }, 400, cors);

  const schluessel = nickSchluessel(geprueft.nick);
  if (await env.KONTEN.get(schluessel)) {
    return json({ error: "Diesen Namen gibt es schon. Nimm einen anderen – oder melde dich damit an." }, 409, cors);
  }

  // Wer beim Anlegen auch das Veranstalter-Passwort mitschickt, wird gleich
  // Veranstalter. Michel muss sich so nicht zweimal durch Masken klicken.
  const istAdmin = body.veranstalterPasswort
    ? (await veranstalterOk(request, body, env)).ok
    : false;

  const angelegtAm = Date.now();   // B2-11: steht auch im Token
  await env.KONTEN.put(schluessel, JSON.stringify({
    nick: geprueft.nick,
    pw: await passwortHashen(passwort),
    admin: istAdmin,
    streamer: false,   // vergibt der Veranstalter, siehe konto-streamer
    orga: false,       // vergibt der Veranstalter, siehe konto-orga
    discordId: discord.id,   // "" = nicht hinterlegt, jederzeit nachtragbar
    angelegtAm: angelegtAm,
  }));

  // ⚠️ ERST nach dem Schreiben, und bewusst ohne await: das Konto steht schon,
  // die Meldung ist eine Zugabe. Ein klemmender Discord-Bot darf eine Anmeldung
  // weder verzoegern noch kippen. Fehlt ctx (Prueflauf, alte Laufzeit), faellt
  // nur die Meldung weg.
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(meldeNeuesKonto(env, {
      nick: geprueft.nick,
      discordId: discord.id,
      admin: istAdmin,
    }));
  }

  return json({
    ok: true,
    nickname: geprueft.nick,
    admin: istAdmin,
    streamer: false,
    // ⚠️ Ein Veranstalter gehoert immer zur Organisation — er RICHTET sie aus.
    // Deshalb hier nicht `false`, sondern `istAdmin`; im KV steht bewusst
    // weiter `orga: false`, damit ein abgegebenes Veranstalter-Recht die
    // Orga-Zugehoerigkeit nicht heimlich mitnimmt.
    orga: istAdmin,
    // ⚠️ Die eigene ID darf zurueck an den eigenen Client - er hat sie selbst
    // geschickt. In die KONTEN-LISTE fuer den Veranstalter gehoert sie nicht,
    // dort steht nur, OB eine hinterlegt ist.
    discordId: discord.id,
    token: await tokenBauen(env, geprueft.nick, istAdmin, false, istAdmin, angelegtAm),
  }, 200, cors);
}

async function kontoLogin(request, body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet (KV-Binding KONTEN fehlt)." }, 500, cors);
  if (!bremseOffen(request)) {
    return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
  }

  const geprueft = nickPruefen(body.nickname);
  if (geprueft.fehler) return json({ error: geprueft.fehler }, 400, cors);

  const roh = await env.KONTEN.get(nickSchluessel(geprueft.nick));
  // Bewusst dieselbe Meldung wie bei falschem Passwort: sonst ließe sich von
  // außen durchprobieren, welche Namen es überhaupt gibt.
  const fehlmeldung = { error: "Name oder Passwort stimmt nicht." };
  if (!roh) {
    bremseFehlschlag(request);
    // ⚠️ Hier, nicht oben am Eingang: limit() zaehlt bei JEDEM Aufruf mit -- am
    // Eingang wuerde normales Arbeiten die Bremse fuellen.
    if (!(await bindungBremseOffen(env, request, "konto-login"))) {
      return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
    }
    return json(fehlmeldung, 403, cors);
  }

  let konto;
  try {
    konto = JSON.parse(roh);
  } catch (e) {
    return json({ error: "Das Konto ist beschädigt." }, 500, cors);
  }

  if (!(await passwortStimmt(String(body.passwort || ""), konto.pw))) {
    bremseFehlschlag(request);
    // ⚠️ Hier, nicht oben am Eingang: limit() zaehlt bei JEDEM Aufruf mit -- am
    // Eingang wuerde normales Arbeiten die Bremse fuellen.
    if (!(await bindungBremseOffen(env, request, "konto-login"))) {
      return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
    }
    return json(fehlmeldung, 403, cors);
  }
  return json({
    ok: true,
    nickname: konto.nick,
    admin: !!konto.admin,
    streamer: !!konto.streamer,
    orga: !!konto.orga || !!konto.admin,
    discordId: konto.discordId || "",
    token: await tokenBauen(env, konto.nick, !!konto.admin, !!konto.streamer, !!konto.orga || !!konto.admin, konto.angelegtAm),
  }, 200, cors);
}

async function kontoPruefen(body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  const gelesen = await tokenLesen(env, body.token);
  if (!gelesen) return json({ ok: false }, 200, cors);
  // Gegenprobe am Bestand: ein gelöschtes Konto darf mit altem Token nicht
  // weiterlaufen – genau das passiert nach "alle Konten leeren".
  const roh = await env.KONTEN.get(nickSchluessel(gelesen.nick));
  if (!roh) return json({ ok: false }, 200, cors);

  // ⚠️ Der Admin-Stand kommt aus dem KV, NICHT aus dem Token: ein entzogenes
  // Veranstalter-Recht muss sofort wirken und nicht erst, wenn das Token in
  // 120 Tagen abläuft.
  let admin = false;
  let streamer = false;
  let orga = false;
  let discordId = "";
  let angelegtAm = 0;
  try {
    const k = JSON.parse(roh);
    angelegtAm = Number(k.angelegtAm) || 0;
    admin = !!k.admin;
    streamer = !!k.streamer;
    orga = !!k.orga;
    discordId = k.discordId || "";
  } catch (e) { /* kaputter Eintrag gilt als ohne Rechte */ }
  orga = orga || admin;   // Veranstalter gehoeren immer dazu
  // B2-11: gleicher Name, aber ein NEUES Konto -> das alte Token gilt nicht mehr.
  if (!tokenPasstZuKonto(gelesen, { angelegtAm: angelegtAm })) return json({ ok: false }, 200, cors);

  // Weicht der Stand vom Token ab, bekommt der Client ein frisches.
  const abweichend = admin !== gelesen.admin || streamer !== gelesen.streamer || orga !== gelesen.orga;
  const token = abweichend ? await tokenBauen(env, gelesen.nick, admin, streamer, orga, angelegtAm) : null;
  // ⚠️ Die ID muss bei JEDEM Start mitkommen, nicht nur beim Anmelden. Wer sie
  // an einem Geraet nachtraegt, soll sie am naechsten auch sehen - sonst
  // behauptet das zweite Geraet, es sei nichts hinterlegt, und der Mensch
  // traegt sie ein zweites Mal ein.
  return json({ ok: true, nickname: gelesen.nick, admin, streamer, orga, discordId, token }, 200, cors);
}

// Ein bestehendes Konto zum Veranstalter machen (oder das Recht wieder abgeben).
async function kontoAdmin(request, body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  if (!bremseOffen(request)) {
    return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
  }

  const gelesen = await tokenLesen(env, body.token);
  if (!gelesen) return json({ error: "Du bist nicht angemeldet." }, 403, cors);

  // Das Recht ABGEBEN darf man ohne Passwort - es ist der eigene Verzicht.
  const anschalten = body.admin !== false;
  // ⚠️ HIER zaehlt nur das Passwort: sonst koennte sich ein Veranstalter-Konto
  // selbst bestaetigen, und der Nachweis waere ein Zirkelschluss.
  const mitPasswort = !!env.PW_AGELAN_VERANSTALTER && !!body.veranstalterPasswort
    && await passwortGleich(String(body.veranstalterPasswort), env.PW_AGELAN_VERANSTALTER);
  if (anschalten && !mitPasswort) {
    bremseFehlschlag(request);
    // ⚠️ Hier, nicht oben am Eingang: limit() zaehlt bei JEDEM Aufruf mit -- am
    // Eingang wuerde normales Arbeiten die Bremse fuellen.
    if (!(await bindungBremseOffen(env, request, "konto-admin"))) {
      return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
    }
    return json({ error: "Falsches Veranstalter-Passwort." }, 403, cors);
  }

  const schluessel = nickSchluessel(gelesen.nick);
  const roh = await env.KONTEN.get(schluessel);
  if (!roh) return json({ error: "Dieses Konto gibt es nicht mehr." }, 404, cors);

  let konto;
  try {
    konto = JSON.parse(roh);
  } catch (e) {
    return json({ error: "Das Konto ist beschädigt." }, 500, cors);
  }

  if (!tokenPasstZuKonto(gelesen, konto)) return json({ error: "Du bist nicht angemeldet." }, 403, cors);   // B2-11
  konto.admin = anschalten;
  await env.KONTEN.put(schluessel, JSON.stringify(konto));
  const orgaJetzt = !!konto.orga || anschalten;
  return json({
    ok: true,
    nickname: konto.nick,
    admin: anschalten,
    streamer: !!konto.streamer,
    orga: orgaJetzt,
    token: await tokenBauen(env, konto.nick, anschalten, !!konto.streamer, orgaJetzt, konto.angelegtAm),
  }, 200, cors);
}

// Streamer-Merkmal setzen oder nehmen. Nur der Veranstalter - anders als beim
// Veranstalter-Recht gibt es hier keinen Selbstbedienungsweg per Passwort.
async function kontoStreamer(request, body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  const erlaubt = await veranstalterOk(request, body, env);
  if (!erlaubt.ok) return json({ error: erlaubt.fehler }, erlaubt.status, cors);

  const geprueft = nickPruefen(body.nickname);
  if (geprueft.fehler) return json({ error: geprueft.fehler }, 400, cors);

  const schluessel = nickSchluessel(geprueft.nick);
  const roh = await env.KONTEN.get(schluessel);
  if (!roh) return json({ error: "Dieses Konto gibt es nicht mehr." }, 404, cors);

  let konto;
  try {
    konto = JSON.parse(roh);
  } catch (e) {
    return json({ error: "Das Konto ist beschädigt." }, 500, cors);
  }

  konto.streamer = body.streamer !== false;
  await env.KONTEN.put(schluessel, JSON.stringify(konto));
  // ⚠️ Kein neues Token: das gehört dem BETROFFENEN, nicht dem Veranstalter.
  // Es zieht bei dessen nächster Startprüfung von selbst nach (konto-pruefen).
  return json({ ok: true, nickname: konto.nick, streamer: konto.streamer }, 200, cors);
}

// Orga-Merkmal setzen oder nehmen. Wer dazugehoert, zahlt beim Essen nichts.
// Nur der Veranstalter, genau wie beim Streamer-Merkmal.
// ⚠️ Bei einem Veranstalter laesst es sich nicht abschalten — er richtet die
// Veranstaltung aus und gehoert damit zur Organisation. Der Weg dorthin ist,
// ihm zuerst das Veranstalter-Recht zu nehmen.
async function kontoOrga(request, body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  const erlaubt = await veranstalterOk(request, body, env);
  if (!erlaubt.ok) return json({ error: erlaubt.fehler }, erlaubt.status, cors);

  const geprueft = nickPruefen(body.nickname);
  if (geprueft.fehler) return json({ error: geprueft.fehler }, 400, cors);

  const schluessel = nickSchluessel(geprueft.nick);
  const roh = await env.KONTEN.get(schluessel);
  if (!roh) return json({ error: "Dieses Konto gibt es nicht mehr." }, 404, cors);

  let konto;
  try {
    konto = JSON.parse(roh);
  } catch (e) {
    return json({ error: "Das Konto ist beschädigt." }, 500, cors);
  }

  konto.orga = body.orga !== false;
  await env.KONTEN.put(schluessel, JSON.stringify(konto));
  // ⚠️ Kein neues Token: das gehoert dem BETROFFENEN, nicht dem Veranstalter.
  // Es zieht bei dessen naechster Startpruefung von selbst nach (konto-pruefen).
  return json({ ok: true, nickname: konto.nick, orga: !!konto.orga || !!konto.admin }, 200, cors);
}

// --- Veranstalter: Konten sehen und leeren ---------------------------------
// Zwei Wege zum Veranstalter-Nachweis: das Passwort (fuer den ersten Zugang und
// fuer Skripte) oder ein angemeldetes Veranstalter-Konto. Letzteres ist der
// Alltagsweg - wer angemeldet ist, soll sein Passwort nicht dauernd wiederholen.
// ⚠️ Seit 2026-09-04 zaehlt hier NEBEN `admin` auch `orga`: wer zur
// Organisation gehoert, hat dieselben Rechte (Michels Ansage). Der Unterschied
// zwischen den beiden Merkmalen ist nur noch, WIE man sie bekommt — `admin`
// ueber das Veranstalter-Passwort (der Weg fuer den ersten Zugang und nach
// „alle Konten loeschen"), `orga` per Klick von jemandem, der die Rechte schon
// hat. Damit muss Michel sein Passwort nicht an die Crew weitergeben.
// ⚠️ Der Passwort-Zweig braucht DIESELBE Bremse wie konto-admin. Bis
// 2026-09-06 hatte er keine: konto-streamer, konto-orga, konto-liste,
// konto-loeschen und discord-sammel pruefen alle dasselbe Veranstalter-
// Passwort, riefen aber weder `bremseOffen` noch `bremseFehlschlag`. Damit war
// das Passwort ueber jede dieser Nebenaktionen unbegrenzt durchprobierbar, und
// ein Treffer gibt die ganze Kontenliste her bzw. loescht mit {alle:true}
// jedes Konto. Die Bremse gehoert deshalb HIER hinein, nicht in die Aufrufer -
// sonst faellt sie beim naechsten neuen Aufrufer wieder hinten runter.
//
// Rueckgabe ist ein Objekt, kein Boolescher Wert: der Aufrufer muss 429 von
// 403 unterscheiden koennen, sonst sieht ein Ausgesperrter nur "Nur der
// Veranstalter" und probiert weiter.
async function veranstalterOk(request, body, env) {
  if (body.token) {
    const gelesen = await tokenLesen(env, body.token);
    if (gelesen && (gelesen.admin || gelesen.orga)) {
      // ⚠️ Gegenprobe am Bestand: das Recht kann seit Ausstellung entzogen sein.
      const roh = await env.KONTEN.get(nickSchluessel(gelesen.nick));
      if (roh) {
        try {
          const k = JSON.parse(roh);
          if ((k.admin || k.orga) && tokenPasstZuKonto(gelesen, k)) return { ok: true };   // B2-11
        } catch (e) { /* kaputter Eintrag zaehlt nicht */ }
      }
    }
  }
  const nurToken = { ok: false, fehler: "Nur der Veranstalter.", status: 403 };
  if (!env.PW_AGELAN_VERANSTALTER) return nurToken;
  // Kein Passwort mitgeschickt = kein Rateversuch. Das zaehlt nicht mit, sonst
  // sperrt ein Client mit abgelaufenem Token sich selbst aus.
  if (!body.veranstalterPasswort) return nurToken;

  // Die Bremse VOR dem Vergleich, wie in pruefePasswort: sonst kostet jeder
  // Rateversuch weiterhin einen vollen Durchlauf.
  if (!bremseOffen(request)) {
    return { ok: false, fehler: "Zu viele Fehlversuche. Bitte später erneut versuchen.", status: 429 };
  }
  const stimmt = await passwortGleich(String(body.veranstalterPasswort), env.PW_AGELAN_VERANSTALTER);
  if (!stimmt) {
    bremseFehlschlag(request);
    // ⚠️ Hier, nicht oben am Eingang: limit() zaehlt bei JEDEM Aufruf mit -- am
    // Eingang wuerde normales Arbeiten die Bremse fuellen.
    if (!(await bindungBremseOffen(env, request, "veranstalter-pw"))) {
      return { ok: false, fehler: "Zu viele Fehlversuche. Bitte später erneut versuchen.", status: 429 };
    }
    return nurToken;
  }
  return { ok: true };
}

async function kontoListe(request, body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  const erlaubt = await veranstalterOk(request, body, env);
  if (!erlaubt.ok) return json({ error: erlaubt.fehler }, erlaubt.status, cors);

  const liste = [];
  let cursor;
  do {
    const seite = await env.KONTEN.list({ prefix: "konto:", cursor: cursor });
    for (const k of seite.keys) {
      const roh = await env.KONTEN.get(k.name);
      if (!roh) continue;
      try {
        const konto = JSON.parse(roh);
        liste.push({
          nickname: konto.nick,
          admin: !!konto.admin,
          streamer: !!konto.streamer,
          orga: !!konto.orga || !!konto.admin,
          // ⚠️ Bewusst nur JA/NEIN, nicht die Zahl. Der Veranstalter muss
          // sehen, wer noch keine hinterlegt hat (die bekommen keine
          // Benachrichtigung) - die ID selbst braucht er dafuer nicht.
          discord: !!konto.discordId,
          angelegtAm: konto.angelegtAm || 0,
        });
      } catch (e) { /* kaputter Eintrag wird übersprungen */ }
    }
    cursor = seite.list_complete ? null : seite.cursor;
  } while (cursor);

  liste.sort((a, b) => a.nickname.localeCompare(b.nickname));
  return json({ ok: true, konten: liste }, 200, cors);
}

async function kontoLoeschen(request, body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  const erlaubt = await veranstalterOk(request, body, env);
  if (!erlaubt.ok) return json({ error: erlaubt.fehler }, erlaubt.status, cors);

  // Ein einzelnes Konto ...
  if (body.nickname) {
    const geprueft = nickPruefen(body.nickname);
    if (geprueft.fehler) return json({ error: geprueft.fehler }, 400, cors);
    await env.KONTEN.delete(nickSchluessel(geprueft.nick));
    return json({ ok: true, geloescht: 1 }, 200, cors);
  }

  // ... oder alle auf einmal: der Schnitt nach einer Veranstaltung.
  if (body.alle !== true) return json({ error: "Weder ein Name noch alle:true angegeben." }, 400, cors);
  let anzahl = 0;
  let cursor;
  do {
    const seite = await env.KONTEN.list({ prefix: "konto:", cursor: cursor });
    for (const k of seite.keys) { await env.KONTEN.delete(k.name); anzahl++; }
    cursor = seite.list_complete ? null : seite.cursor;
  } while (cursor);
  // B2-11: neuer Signierschluessel -> JEDES bisher ausgestellte Token ist ungueltig.
  await env.KONTEN.delete("_tokenSecret");
  return json({ ok: true, geloescht: anzahl }, 200, cors);
}

// --- Discord-Anbindung ------------------------------------------------------

// Ein Konto liest sich selbst aus dem KV. Beide Discord-Aktionen brauchen das,
// und beide muessen dabei DASSELBE tun: nur das eigene Konto, nur ueber das
// signierte Token.
async function eigenesKonto(body, env) {
  const gelesen = await tokenLesen(env, body.token);
  if (!gelesen) return { fehler: "Nicht angemeldet.", status: 403 };
  const roh = await env.KONTEN.get(nickSchluessel(gelesen.nick));
  if (!roh) return { fehler: "Dieses Konto gibt es nicht mehr.", status: 404 };
  try {
    const konto = JSON.parse(roh);
    if (!tokenPasstZuKonto(gelesen, konto)) return { fehler: "Nicht angemeldet.", status: 403 };   // B2-11
    return { konto: konto, schluessel: nickSchluessel(gelesen.nick) };
  } catch (e) {
    return { fehler: "Der Konto-Eintrag ist beschädigt.", status: 500 };
  }
}

// Die eigene Discord-ID eintragen, aendern oder wieder loeschen (leer schicken).
//
// ⚠️ Braucht bewusst KEIN Veranstalter-Recht: jede:r pflegt die eigene ID. Der
// Nickname kommt dabei aus dem SIGNIERTEN TOKEN, nicht aus dem Body - sonst
// koennte jede:r Angemeldete einem Fremden eine ID unterschieben und damit
// dessen Benachrichtigungen auf sich selbst umleiten.
async function kontoDiscord(body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);

  // Erst die Anmeldung, dann das Format - wie überall sonst in dieser Datei.
  // Wer nicht angemeldet ist, soll nicht einmal erfahren, wie die Prüfung
  // aussieht.
  const eigen = await eigenesKonto(body, env);
  if (eigen.fehler) return json({ error: eigen.fehler }, eigen.status, cors);

  const geprueft = discordIdPruefen(body.discordId);
  if (geprueft.fehler) return json({ error: geprueft.fehler }, 400, cors);

  eigen.konto.discordId = geprueft.id;
  await env.KONTEN.put(eigen.schluessel, JSON.stringify(eigen.konto));
  return json({ ok: true, discordId: geprueft.id }, 200, cors);
}

// Testnachricht an die EIGENE hinterlegte ID.
//
// ⚠️ Das ist der wichtigste Teil der ganzen Discord-Anbindung. Eine falsche,
// aber gueltig aussehende Zahl geht an eine wildfremde Person oder ins Leere -
// ohne dass es irgendwer merkt. Erst diese Testnachricht macht aus dem stillen
// Fehler einen sichtbaren.
//
// ⚠️ Die ID kommt aus dem KV, NICHT aus dem Body. Sonst waere das hier ein
// Werkzeug, mit dem jede:r Angemeldete beliebige Discord-Nutzer anschreiben
// koennte - eine Spam-Schleuder mit Michels Bot als Absender.
async function discordTest(body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);

  const eigen = await eigenesKonto(body, env);
  if (eigen.fehler) return json({ error: eigen.fehler }, eigen.status, cors);
  const konto = eigen.konto;

  if (!konto.discordId) {
    return json({ error: "Du hast noch keine Discord-ID hinterlegt. Trag sie ein, speichere sie – danach geht der Test." }, 400, cors);
  }

  // ⚠️ Die Bremse wird VOR dem Versand geschrieben, nicht danach. Zwei schnelle
  // Klicks laufen sonst beide durch, weil der zweite den Zeitstempel des ersten
  // noch nicht sieht.
  const jetzt = Date.now();
  const seit = jetzt - (konto.discordTestZuletzt || 0);
  if (seit < DISCORD_TEST_PAUSE_MS) {
    const rest = Math.ceil((DISCORD_TEST_PAUSE_MS - seit) / 1000);
    return json({ error: "Gerade eben lief schon ein Test. Bitte warte noch " + rest + " Sekunden." }, 429, cors);
  }
  konto.discordTestZuletzt = jetzt;
  await env.KONTEN.put(eigen.schluessel, JSON.stringify(konto));

  const ergebnis = await discordDm(
    env,
    konto.discordId,
    "Hallo " + konto.nick + "! 👋\n\n" +
    "Das ist eine Testnachricht aus der AgeLan-App.\n\n" +
    "Wenn du sie liest, ist deine Discord-ID richtig hinterlegt. Du bekommst hier " +
    "Bescheid, sobald dein Essen zum Abholen bereitliegt.\n\n" +
    "Du musst jetzt nichts weiter tun."
  );
  // 502, nicht 500: der Fehler kommt von Discord, nicht aus diesem Worker.
  if (!ergebnis.ok) return json({ error: ergebnis.grund }, 502, cors);
  return json({ ok: true }, 200, cors);
}

// Alle Besteller einer Lieferung anschreiben: "dein Essen ist da".
//
// \u26a0\ufe0f Der Client schickt NAMEN, keine Discord-IDs. Die IDs verlassen den Worker
// nie - der Veranstalter sieht in seiner Konten-Liste nur, OB eine hinterlegt
// ist. Ein Client, der sie zum Verschicken br\u00e4uchte, h\u00e4tte damit alle.
//
// \u26a0\ufe0f Den Nachrichtentext baut dieser Worker, nicht der Client. Sonst w\u00e4re das
// hier ein Versandweg f\u00fcr beliebigen Text an beliebige Konten - mit Michels Bot
// als Absender. Anpassbar ist nur ein kurzer Zusatz.
//
// \u26a0\ufe0f Die Antwort ist IMMER eine Nachfassliste: wer NICHT erreicht wurde und
// warum. Ohne die h\u00e4lt der Veranstalter alle f\u00fcr informiert, und drei Leute
// holen ihr Essen nie ab.
// Die Zeilen „das ist deins" aus dem, was der Client mitschickt.
// ⚠️ Der Client wird NICHT geglaubt: Anzahl wird auf 1..99 gestutzt, Texte
// werden gesaeubert und gekuerzt, und mehr als DISCORD_POSTEN_MAX Zeilen gibt
// es nicht. Sonst waere die Aktion ueber den Umweg „Sonderwunsch" doch wieder
// ein Versandweg fuer beliebigen Text unter Michels Bot-Namen.
function postenListe(roh) {
  if (!Array.isArray(roh)) return [];
  const raus = [];
  for (const p of roh) {
    if (raus.length >= DISCORD_POSTEN_MAX) break;
    const gericht = discordSauber(p && p.gericht, 80);
    if (!gericht) continue;
    let anzahl = Math.round(Number(p && p.anzahl));
    if (!Number.isFinite(anzahl) || anzahl < 1) anzahl = 1;
    if (anzahl > 99) anzahl = 99;
    raus.push({ anzahl, gericht, sonderwunsch: discordSauber(p && p.sonderwunsch, 120) });
  }
  return raus;
}

async function discordSammel(request, body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  const erlaubt = await veranstalterOk(request, body, env);
  if (!erlaubt.ok) return json({ error: erlaubt.fehler }, erlaubt.status, cors);
  if (!env.DISCORD_BOT_TOKEN) {
    return json({ error: "Der Discord-Bot ist noch nicht eingerichtet (Secret DISCORD_BOT_TOKEN fehlt)." }, 500, cors);
  }

  // Doppelte Namen fallen raus: dieselbe Person hat oft mehrere Bestellungen in
  // einer Lieferung, soll aber genau EINE Nachricht bekommen.
  //
  // Zwei Eingabeformen:
  //   body.leute     = [{ name, posten: [{anzahl, gericht, sonderwunsch}] }]
  //   body.nicknames = ["Anna", "Bernd"]            (aeltere Fassung des Clients)
  // ⚠️ Die alte Form muss bleiben: der Worker wird VOR den Seiten ausgerollt
  // (erweiternde Aenderung), und in der Zwischenzeit ruft der alte Client an.
  // Ohne sie waere der Bescheid-Knopf fuer alle kaputt, bis Pages durch ist.
  const rohLeute = Array.isArray(body.leute) ? body.leute : [];
  const rohNamen = Array.isArray(body.nicknames) ? body.nicknames : [];
  const eintraege = rohLeute.length
    ? rohLeute.map((l) => ({ name: (l && l.name), posten: (l && l.posten), bestelltAm: (l && l.bestelltAm) }))
    : rohNamen.map((n) => ({ name: n, posten: null, bestelltAm: null }));

  const namen = [];
  const postenZuName = new Map();
  const postenZeit = new Map();
  const gesehen = new Set();
  for (const e of eintraege) {
    const wert = String(e.name == null ? "" : e.name).trim();
    if (!wert) continue;
    const schluessel = wert.toLowerCase();
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    namen.push(wert);
    postenZuName.set(schluessel, postenListe(e.posten));
    postenZeit.set(schluessel, e.bestelltAm);
  }
  if (!namen.length) return json({ error: "Es sind keine Namen mitgekommen." }, 400, cors);
  if (namen.length > DISCORD_SAMMEL_MAX) {
    return json({ error: "Das sind " + namen.length + " Leute auf einmal. Mehr als " + DISCORD_SAMMEL_MAX + " gehen in einem Durchgang nicht." }, 400, cors);
  }

  // ⚠️ Beide durch discordSauber, nicht nur trimmen und kuerzen. Bis
  // 2026-09-06 gingen sie roh in die DM - mit Zeilenumbruechen, `@`, Backticks
  // und Markdown, zusammen bis 260 Zeichen, an bis zu DISCORD_SAMMEL_MAX Konten
  // unter Michels Bot-Namen. Genau das, was der Kommentar oben ausschliesst
  // ("Anpassbar ist nur ein kurzer Zusatz") - `gericht`, `sonderwunsch` und
  // `daSeit` waren schon sauber, diese beiden nicht.
  const was = discordSauber(body.titel, 60);
  const zusatz = discordSauber(body.hinweis, 200);
  // Wann das Essen angekommen ist – fuer alle in dieser Lieferung dieselbe Zeit.
  const daSeit = discordSauber(body.daSeit, 20);

  const erreicht = [];
  const offen = [];
  // \u26a0\ufe0f Nacheinander, nicht alle auf einmal: Discord bremst beim Massen\u00f6ffnen
  // von DM-Kan\u00e4len, und ein Schwall parallel liefe direkt in die Sperre.
  for (const name of namen) {
    const eintrag = await env.KONTEN.get(nickSchluessel(name));
    if (!eintrag) { offen.push({ nickname: name, grund: "Kein Konto mit diesem Namen." }); continue; }

    let konto;
    try {
      konto = JSON.parse(eintrag);
    } catch (e) {
      offen.push({ nickname: name, grund: "Der Konto-Eintrag ist besch\u00e4digt." });
      continue;
    }
    if (!konto.discordId) {
      offen.push({ nickname: konto.nick || name, grund: "Keine Discord-ID hinterlegt." });
      continue;
    }

    // Was diese Person bestellt hat, kommt mit in die Nachricht. Michel am
    // 04.09.2026: \u201ein die discord nachricht nicht nur donnerstag 2 sondern auch
    // das bestellte essen".
    // \u26a0\ufe0f Jede:r bekommt nur die EIGENEN Zeilen. Die ganze Lieferung an alle zu
    // schicken hiesse, jedem zu verraten, was die anderen essen.
    const posten = postenZuName.get(name.toLowerCase()) || [];
    const liste = posten.length
      ? "\n\nDas ist deins:\n" + posten.map((p) =>
          "\u2022 " + p.anzahl + "x " + p.gericht + (p.sonderwunsch ? " (" + p.sonderwunsch + ")" : "")
        ).join("\n")
      : "";

    // Wann bestellt, wann da. \u26a0\ufe0f Beide Zeiten kommen FERTIG FORMATIERT vom
    // Client, nicht als Zeitstempel: der Worker laeuft in UTC, und aus einem
    // Zeitstempel wuerde hier \u201e11:12" statt \u201e13:12". Der Client steht dort, wo
    // die Veranstaltung ist, und kennt die richtige Zeit. Beide Werte gehen
    // durch discordSauber, sind also auf 20 harmlose Zeichen begrenzt.
    const bestelltText = discordSauber(postenZeit.get(name.toLowerCase()), 20);
    const zeilen = [];
    if (bestelltText) zeilen.push("Bestellt: " + bestelltText);
    if (daSeit) zeilen.push("Da seit: " + daSeit);
    const zeiten = zeilen.length ? "\n\n" + zeilen.join("\n") : "";

    const text =
      "Hallo " + (konto.nick || name) + "! \ud83c\udf55\n\n" +
      "Dein Essen ist da" + (was ? " (" + was + ")" : "") + " \u2013 du kannst es vorne abholen." +
      liste +
      zeiten +
      (zusatz ? "\n\n" + zusatz : "");

    const ergebnis = await discordDm(env, konto.discordId, text);
    if (ergebnis.ok) erreicht.push(konto.nick || name);
    else offen.push({ nickname: konto.nick || name, grund: ergebnis.grund });
  }

  return json({ ok: true, geschickt: erreicht.length, erreicht: erreicht, offen: offen }, 200, cors);
}

// --- Neue Anmeldung an die Veranstalter melden ------------------------------
//
// Michel am 15.09.2026: „bau mir hier für den bot einmal ein das ich
// benachritigt werde wenn neue user sich angemeldet haben".
//
// ⚠️ Läuft NACH der Antwort (ctx.waitUntil) und wirft NIE. Das Konto steht zu
// diesem Zeitpunkt schon im KV – ein klemmender Bot darf eine Anmeldung weder
// verzögern noch kippen. Der Preis dafür: ein Fehler beim Verschicken ist von
// aussen nicht sichtbar. Deshalb sagt die Konten-Liste in der App, WEN diese
// Meldung überhaupt erreicht – sonst wäre „es kam nichts“ nicht von „es gibt
// niemanden zum Anschreiben“ zu unterscheiden.
//
// ⚠️ Nur an `admin`, bewusst NICHT an `orga`. Beide dürfen die Konten-Liste
// sehen, aber melden lassen will es sich der, der die Veranstaltung ausrichtet.
// Ändert sich das, muss die Zeile in der Konten-Liste (app.js) mitwandern –
// sonst behauptet die App etwas anderes, als der Worker tut.
//
// ⚠️ Keine Bremse: wer ein Konto anlegen kann, hat das Einladungs-Passwort.
// Eine Bremse würde echte Anmeldungen verschlucken, und genau die sind der
// Zweck. Anders als bei der Testnachricht gibt es hier also keine Pause.
async function meldeNeuesKonto(env, neu) {
  try {
    if (!env.DISCORD_BOT_TOKEN || !kvDa(env)) return;

    // Sich selbst meldet niemand. Legt Michel sein eigenes Konto mit dem
    // Veranstalter-Passwort an, ist er in derselben Sekunde Veranstalter – und
    // bekäme sonst eine Nachricht über sich selbst.
    const eigener = nickSchluessel(neu.nick);

    const ziele = [];
    let anzahl = 0;
    let cursor;
    do {
      const seite = await env.KONTEN.list({ prefix: "konto:", cursor: cursor });
      anzahl += seite.keys.length;
      for (const k of seite.keys) {
        if (k.name === eigener) continue;
        const roh = await env.KONTEN.get(k.name);
        if (!roh) continue;
        try {
          const konto = JSON.parse(roh);
          if (konto.admin && konto.discordId) ziele.push(konto);
        } catch (e) { /* kaputter Eintrag wird übersprungen */ }
      }
      cursor = seite.list_complete ? null : seite.cursor;
    } while (cursor);

    if (!ziele.length) return;

    // ⚠️ Der Name geht ROH hinein, nicht durch discordSauber. nickPruefen hat
    // `@`, Backticks, Sternchen und Zeilenumbrüche schon ausgeschlossen; übrig
    // bleibt nur der Unterstrich, der im Doppelpack kursiv machen kann. Den zu
    // schlucken wäre schlimmer: die Meldung muss das Konto EXAKT benennen,
    // sonst findet Michel es in der Liste nicht wieder.
    const text =
      "🆕 Neue Anmeldung in der AgeLan\n\n" +
      "Name: " + neu.nick + "\n" +
      "Discord-ID: " + (neu.discordId
        ? "hinterlegt"
        : "fehlt – diese Person bekommt keine Nachricht, wenn ihr Essen da ist") + "\n" +
      "Konten insgesamt: " + anzahl +
      (neu.admin
        ? "\n\n⚠️ Dieses Konto hat beim Anlegen das Veranstalter-Passwort mitgeschickt und ist damit selbst Veranstalter."
        : "") +
      "\n\nDie ganze Liste steht in der App unter „Einstellungen“.";

    // Nacheinander, wie beim Sammel-Bescheid: Discord bremst beim Massenöffnen
    // von DM-Kanälen. Veranstalter sind wenige, das kostet nichts.
    for (const ziel of ziele) {
      await discordDm(env, ziel.discordId, text);
    }
  } catch (e) {
    // Bewusst still. Hier gibt es niemanden mehr, dem man etwas sagen könnte –
    // die Antwort an den neuen Nutzer ist längst raus.
  }
}

// ===========================================================================
// Firebase-Rolle (agelan-Rolle 26.09.2026, Entscheidung Michel: Variante B)
//
// Wer per Konto Veranstalter (⭐) oder Orga (🛠) ist, soll in der Firebase-
// Datenbank als Verwaltung gelten, OHNE den PIN des Bereichs. Die Regeln kennen
// das Konto aber nicht - sie kennen nur `auth`. Deshalb stellt dieser Worker ein
// Firebase-CUSTOM-TOKEN aus: fuer DIESELBE uid, mit der das Geraet schon anonym
// angemeldet ist (hostId, Bestellungen und Anmeldungen haengen an ihr), und mit
// den Claims `agelanOrga: true` und `agelanBis: <jetzt + 24 h in ms>`. Die Regeln
// pruefen `auth.token.agelanOrga === true && auth.token.agelanBis > now`.
//
// Ablauf `firebase-rolle`:
//   1. Konto-Token pruefen, Stand aus dem KV (wie konto-pruefen, B2-11) - ein
//      entzogenes ⭐/🛠 wirkt beim naechsten Abholen sofort.
//   2. Das Firebase-ID-Token des Geraets pruefen (RS256 gegen Googles oeffentliche
//      Schluessel, aud/iss = Projekt, exp/iat/auth_time, sub = uid). Nur so steht
//      fest, fuer WELCHE uid das Custom Token gilt - sonst koennte jemand eines fuer
//      die uid eines anderen Geraets (etwa dessen hostId) verlangen.
//   3. Custom Token bauen, signiert mit dem Schluessel des Dienstkontos aus dem
//      Secret FIREBASE_DIENSTKONTO (die JSON-Datei aus der Firebase-Konsole).
// Fehlt das Secret: 503 { nichtKonfiguriert: true } - der Client bleibt dann
// still beim PIN-Weg.
//
// Doku: Custom Token https://firebase.google.com/docs/auth/admin/create-custom-tokens
// ("Create custom tokens using a third-party JWT library"), ID-Token pruefen
// https://firebase.google.com/docs/auth/admin/verify-id-tokens ("Verify ID tokens
// using a third-party JWT library"). Die JWK-Adresse liefert dieselben Schluessel
// (gleiche kid) wie die dort genannte x509-Adresse, laesst sich aber ohne
// Zertifikats-Zerlegung direkt mit crypto.subtle einlesen.
// ===========================================================================

const FIREBASE_PROJEKT = "agelan-ab042";
const FIREBASE_JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CUSTOM_TOKEN_AUD = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
const ROLLE_DAUER_MS = 24 * 3600 * 1000;   // danach verfaellt der Claim in den Regeln von selbst
const UHR_SPIEL_S = 60;                     // Uhrenversatz, den iat/auth_time haben duerfen

let jwkSpeicher = { bis: 0, keys: [] };    // je Isolate, nach Cache-Control max-age
let dienstkontoSpeicher = { roh: null, key: null };

async function firebaseRolle(body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  const dienstkonto = dienstkontoLesen(env);
  if (!dienstkonto) return json({ ok: false, nichtKonfiguriert: true }, 503, cors);

  // 1. Konto (Stand aus dem KV, nicht aus dem Token allein)
  const eigen = await eigenesKonto(body, env);
  if (eigen.fehler) return json({ ok: false, fehler: eigen.fehler }, eigen.status === 500 ? 500 : 401, cors);
  if (!(eigen.konto.admin || eigen.konto.orga)) {
    return json({ ok: false, fehler: "Nur für Veranstalter oder Orga." }, 403, cors);
  }

  // 2. Firebase-ID-Token des Geraets
  const uid = await firebaseIdTokenPruefen(body.idToken, Date.now());
  if (!uid) return json({ ok: false, fehler: "Die Firebase-Anmeldung dieses Geräts ließ sich nicht bestätigen." }, 401, cors);

  // 3. Custom Token fuer DIESELBE uid
  const bis = Date.now() + ROLLE_DAUER_MS;
  let customToken;
  try {
    customToken = await customTokenBauen(dienstkonto, uid, { agelanOrga: true, agelanBis: bis }, Date.now());
  } catch (e) {
    // Kaputter Schluessel im Secret: fuer den Client dasselbe wie "nicht eingerichtet".
    return json({ ok: false, nichtKonfiguriert: true }, 503, cors);
  }
  return json({ ok: true, customToken: customToken, uid: uid, bis: bis }, 200, cors);
}

// Das Secret ist die JSON-Datei des Dienstkontos. Gelesen werden nur client_email
// und private_key; project_id muss zum Projekt passen, sonst lehnt Firebase das
// Custom Token ohnehin ab (und der Fehler waere dann schwer zu finden).
function dienstkontoLesen(env) {
  const roh = env && typeof env.FIREBASE_DIENSTKONTO === "string" ? env.FIREBASE_DIENSTKONTO : "";
  if (!roh) return null;
  try {
    const d = JSON.parse(roh);
    if (!d || typeof d.client_email !== "string" || typeof d.private_key !== "string") return null;
    if (d.project_id && d.project_id !== FIREBASE_PROJEKT) return null;
    return { client_email: d.client_email, private_key: d.private_key, roh: roh };
  } catch (e) {
    return null;
  }
}

async function dienstkontoSchluessel(dienstkonto) {
  if (dienstkontoSpeicher.roh === dienstkonto.roh && dienstkontoSpeicher.key) return dienstkontoSpeicher.key;
  const pem = dienstkonto.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", b64ZuBytes(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  dienstkontoSpeicher = { roh: dienstkonto.roh, key: key };
  return key;
}

// Custom Token nach "Create custom tokens using a third-party JWT library":
// RS256, iss = sub = Dienstkonto, aud = IdentityToolkit, exp hoechstens 1 h nach
// iat (nur fuer den Tausch gegen ein ID-Token), uid, claims. Die Claim-Namen sind
// keine reservierten Namen (acr, amr, at_hash, aud, auth_time, azp, cnf, c_hash,
// exp, iat, iss, jti, nbf, nonce, sub, firebase, user_id).
async function customTokenBauen(dienstkonto, uid, claims, jetztMs) {
  const iat = Math.floor(jetztMs / 1000);
  const kopf = { alg: "RS256", typ: "JWT" };
  const nutzlast = {
    iss: dienstkonto.client_email, sub: dienstkonto.client_email, aud: CUSTOM_TOKEN_AUD,
    iat: iat, exp: iat + 3600, uid: uid, claims: claims,
  };
  const eingabe = jsonB64Url(kopf) + "." + jsonB64Url(nutzlast);
  const key = await dienstkontoSchluessel(dienstkonto);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(eingabe));
  return eingabe + "." + bytesZuB64Url(new Uint8Array(sig));
}

function jsonB64Url(o) {
  return bytesZuB64Url(new TextEncoder().encode(JSON.stringify(o)));
}

// Googles oeffentliche Schluessel fuer Firebase-ID-Token, zwischengespeichert nach
// Cache-Control max-age. Unbekannte kid -> einmal frisch holen (Schluesselwechsel).
async function jwkHolen(kid, jetztMs) {
  const suche = () => jwkSpeicher.keys.find((k) => k && k.kid === kid) || null;
  if (jwkSpeicher.bis > jetztMs) {
    const k = suche();
    if (k) return k;
  }
  const antwort = await fetch(FIREBASE_JWK_URL);
  if (!antwort.ok) return null;
  const daten = await antwort.json();
  const m = /max-age=(\d+)/.exec(antwort.headers.get("Cache-Control") || "");
  jwkSpeicher = { bis: jetztMs + (m ? Number(m[1]) : 3600) * 1000, keys: Array.isArray(daten && daten.keys) ? daten.keys : [] };
  return suche();
}

// Liefert die uid (sub) eines gueltigen Firebase-ID-Tokens dieses Projekts, sonst null.
// ⚠️ Der ganze Rumpf steht im try, wie bei tokenLesen: ein verstelltes Token darf
// den Worker nicht mitreissen (Cloudflare 1101).
async function firebaseIdTokenPruefen(idToken, jetztMs) {
  try {
    const teile = String(idToken || "").split(".");
    if (teile.length !== 3) return null;
    const kopf = JSON.parse(new TextDecoder().decode(b64UrlZuBytes(teile[0])));
    const nutzlast = JSON.parse(new TextDecoder().decode(b64UrlZuBytes(teile[1])));
    if (!kopf || kopf.alg !== "RS256" || typeof kopf.kid !== "string") return null;
    const jetzt = Math.floor(jetztMs / 1000);
    if (nutzlast.aud !== FIREBASE_PROJEKT) return null;
    if (nutzlast.iss !== "https://securetoken.google.com/" + FIREBASE_PROJEKT) return null;
    if (!(typeof nutzlast.exp === "number" && nutzlast.exp > jetzt)) return null;
    if (!(typeof nutzlast.iat === "number" && nutzlast.iat <= jetzt + UHR_SPIEL_S)) return null;
    if (!(typeof nutzlast.auth_time === "number" && nutzlast.auth_time <= jetzt + UHR_SPIEL_S)) return null;
    if (typeof nutzlast.sub !== "string" || !nutzlast.sub || nutzlast.sub.length > 128) return null;
    const jwk = await jwkHolen(kopf.kid, jetztMs);
    if (!jwk || jwk.kty !== "RSA") return null;
    const key = await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64UrlZuBytes(teile[2]), new TextEncoder().encode(teile[0] + "." + teile[1])
    );
    return ok ? nutzlast.sub : null;
  } catch (e) {
    return null;
  }
}

// --- base64-Helfer ----------------------------------------------------------
function bytesZuB64(bytes) {
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}
function b64ZuBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
// Für Token: base64url ohne Polster, damit nichts in einer URL kaputtgeht.
function bytesZuB64Url(bytes) {
  return bytesZuB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64UrlZuBytes(s) {
  let b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return b64ZuBytes(b64);
}
