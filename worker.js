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
//   PW_AGELAN              = Zugang zu den drei Bereichen (kennt jeder Teilnehmer)
//   PW_AGELAN_VERANSTALTER = Turniere anlegen (nur Michel)
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

    if (String(body.action || "") !== "verify-action-password") {
      return json({ error: "Unbekannte Aktion" }, 400, cors);
    }

    return pruefePasswort(request, body, env, cors);
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
