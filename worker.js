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
  async fetch(request, env) {
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
    if (aktion === "konto-anlegen")  return kontoAnlegen(request, body, env, cors);
    if (aktion === "konto-login")    return kontoLogin(request, body, env, cors);
    if (aktion === "konto-pruefen")  return kontoPruefen(body, env, cors);
    if (aktion === "konto-admin")    return kontoAdmin(request, body, env, cors);
    if (aktion === "konto-liste")    return kontoListe(body, env, cors);
    if (aktion === "konto-loeschen") return kontoLoeschen(body, env, cors);
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
async function tokenBauen(env, nick, admin) {
  const nutzlast = { n: nick, e: Date.now() + TOKEN_TAGE * 86400000 };
  if (admin) nutzlast.a = 1;
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
    return { nick: nutzlast.n, admin: nutzlast.a === 1 };
  } catch (e) {
    return null;
  }
}

async function kontoAnlegen(request, body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet (KV-Binding KONTEN fehlt)." }, 500, cors);
  if (!bremseOffen(request)) {
    return json({ error: "Zu viele Fehlversuche. Bitte später erneut versuchen." }, 429, cors);
  }
  if (!env.PW_AGELAN) return json({ error: "Worker-Secret PW_AGELAN ist nicht konfiguriert" }, 500, cors);

  // Die Einladung: einmalig, danach nie wieder nötig.
  const einladungOk = await passwortGleich(String(body.lanPasswort || ""), env.PW_AGELAN);
  if (!einladungOk) {
    bremseFehlschlag(request);
    return json({ error: "Falsches Passwort für die Anmeldung." }, 403, cors);
  }

  const geprueft = nickPruefen(body.nickname);
  if (geprueft.fehler) return json({ error: geprueft.fehler }, 400, cors);

  const passwort = String(body.passwort || "");
  if (passwort.length < PW_MIN) {
    return json({ error: "Das Passwort braucht mindestens " + PW_MIN + " Zeichen." }, 400, cors);
  }

  const schluessel = nickSchluessel(geprueft.nick);
  if (await env.KONTEN.get(schluessel)) {
    return json({ error: "Diesen Namen gibt es schon. Nimm einen anderen – oder melde dich damit an." }, 409, cors);
  }

  // Wer beim Anlegen auch das Veranstalter-Passwort mitschickt, wird gleich
  // Veranstalter. Michel muss sich so nicht zweimal durch Masken klicken.
  const istAdmin = body.veranstalterPasswort
    ? await veranstalterOk(body, env)
    : false;

  await env.KONTEN.put(schluessel, JSON.stringify({
    nick: geprueft.nick,
    pw: await passwortHashen(passwort),
    admin: istAdmin,
    angelegtAm: Date.now(),
  }));

  return json({
    ok: true,
    nickname: geprueft.nick,
    admin: istAdmin,
    token: await tokenBauen(env, geprueft.nick, istAdmin),
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
  if (!roh) { bremseFehlschlag(request); return json(fehlmeldung, 403, cors); }

  let konto;
  try {
    konto = JSON.parse(roh);
  } catch (e) {
    return json({ error: "Das Konto ist beschädigt." }, 500, cors);
  }

  if (!(await passwortStimmt(String(body.passwort || ""), konto.pw))) {
    bremseFehlschlag(request);
    return json(fehlmeldung, 403, cors);
  }
  return json({
    ok: true,
    nickname: konto.nick,
    admin: !!konto.admin,
    token: await tokenBauen(env, konto.nick, !!konto.admin),
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
  try {
    admin = !!JSON.parse(roh).admin;
  } catch (e) { /* kaputter Eintrag gilt als kein Admin */ }

  // Weicht der Stand vom Token ab, bekommt der Client ein frisches.
  const token = admin !== gelesen.admin ? await tokenBauen(env, gelesen.nick, admin) : null;
  return json({ ok: true, nickname: gelesen.nick, admin, token }, 200, cors);
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

  konto.admin = anschalten;
  await env.KONTEN.put(schluessel, JSON.stringify(konto));
  return json({
    ok: true,
    nickname: konto.nick,
    admin: anschalten,
    token: await tokenBauen(env, konto.nick, anschalten),
  }, 200, cors);
}

// --- Veranstalter: Konten sehen und leeren ---------------------------------
// Zwei Wege zum Veranstalter-Nachweis: das Passwort (fuer den ersten Zugang und
// fuer Skripte) oder ein angemeldetes Veranstalter-Konto. Letzteres ist der
// Alltagsweg - wer angemeldet ist, soll sein Passwort nicht dauernd wiederholen.
async function veranstalterOk(body, env) {
  if (body.token) {
    const gelesen = await tokenLesen(env, body.token);
    if (gelesen && gelesen.admin) {
      // ⚠️ Gegenprobe am Bestand: das Recht kann seit Ausstellung entzogen sein.
      const roh = await env.KONTEN.get(nickSchluessel(gelesen.nick));
      if (roh) {
        try {
          if (JSON.parse(roh).admin) return true;
        } catch (e) { /* kaputter Eintrag zaehlt nicht */ }
      }
    }
  }
  if (!env.PW_AGELAN_VERANSTALTER) return false;
  if (!body.veranstalterPasswort) return false;
  return passwortGleich(String(body.veranstalterPasswort), env.PW_AGELAN_VERANSTALTER);
}

async function kontoListe(body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  if (!(await veranstalterOk(body, env))) return json({ error: "Nur der Veranstalter." }, 403, cors);

  const liste = [];
  let cursor;
  do {
    const seite = await env.KONTEN.list({ prefix: "konto:", cursor: cursor });
    for (const k of seite.keys) {
      const roh = await env.KONTEN.get(k.name);
      if (!roh) continue;
      try {
        const konto = JSON.parse(roh);
        liste.push({ nickname: konto.nick, admin: !!konto.admin, angelegtAm: konto.angelegtAm || 0 });
      } catch (e) { /* kaputter Eintrag wird übersprungen */ }
    }
    cursor = seite.list_complete ? null : seite.cursor;
  } while (cursor);

  liste.sort((a, b) => a.nickname.localeCompare(b.nickname));
  return json({ ok: true, konten: liste }, 200, cors);
}

async function kontoLoeschen(body, env, cors) {
  if (!kvDa(env)) return json({ error: "Konten sind noch nicht eingerichtet." }, 500, cors);
  if (!(await veranstalterOk(body, env))) return json({ error: "Nur der Veranstalter." }, 403, cors);

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
  return json({ ok: true, geloescht: anzahl }, 200, cors);
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
