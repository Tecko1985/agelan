// ===========================================================================
// app.js – Screens, Rendering, Events. Redet nur über turnierService.
// Alle aus Firebase stammenden Werte (v. a. Namen) werden mit escapeHtml()
// escaped, bevor sie per innerHTML eingesetzt werden (XSS-Schutz).
// ===========================================================================

// Schalter für den ganzen Turnierteil (Tab, Screens, Veranstalter-Zahnrad).
// Auf false wird die Seite nur für den Streamplan herausgegeben.
const TURNIER_SICHTBAR = true;

// Turniere ANLEGEN darf nur der Veranstalter. Geprüft wird serverseitig gegen
// das Worker-Secret PW_AGELAN_VERANSTALTER (Scope agelan-veranstalter) – ein
// zweites, engeres Passwort als das der Seite, das jeder Teilnehmer kennt.
// ⚠️ Das ist eine Bedien-Sperre, kein Datenriegel: die Firebase-Regeln lassen
// jeden angemeldeten (anonymen) Client schreiben. Wer die Datenbank-URL kennt,
// kommt daran vorbei – genau wie am Passwort-Gate der Seite.
const AGELAN_GATEWAY = "https://agelan.michel-brunner.workers.dev";
const VERANSTALTER_SCOPE = "agelan-veranstalter";
const VERANSTALTER_KEY = "agelan_veranstalter_ok";

// Nur der alte Passwort-Weg, ohne das Konto. Fuer die Frage "gibt es hier etwas
// zum Abmelden?" - das Konto meldet man in der Anmeldung ab, nicht hier.
function veranstalterPasswortMerker() {
  try { return localStorage.getItem(VERANSTALTER_KEY) === "1"; } catch (e) { return false; }
}

function veranstalterFrei() {
  // Ein Veranstalter-Konto braucht das zweite Passwort nicht mehr.
  if (typeof kontoIstVeranstalter === "function" && kontoIstVeranstalter()) return true;
  try { return localStorage.getItem(VERANSTALTER_KEY) === "1"; } catch (e) { return false; }
}
function setzeVeranstalterFrei(frei) {
  try {
    if (frei) localStorage.setItem(VERANSTALTER_KEY, "1");
    else localStorage.removeItem(VERANSTALTER_KEY);
  } catch (e) {}
}

let zustand = null;
let willMitmachen = false;   // lokaler UI-Zustand: "Jetzt anmelden" geklickt
let meldeSpielId = null;     // aktuell im Melde-Dialog bearbeitetes Spiel
let meldeAdminModus = false; // Melde-Dialog als Admin-Korrektur?
let losFelderInit = false;   // Auslosungs-Felder je Team-Phase einmal mit Vorschlag füllen

// --- Helfer ----------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const AVATAR_FARBEN = ["#1a56a0", "#057a55", "#c9941f", "#9333ea", "#dc2626", "#0891b2", "#db2777", "#ea580c"];
function avatarFarbe(schluessel) {
  let h = 0;
  const s = String(schluessel || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff;
  return AVATAR_FARBEN[Math.abs(h) % AVATAR_FARBEN.length];
}
function initiale(name) {
  const n = String(name || "?").trim();
  return n ? n[0].toUpperCase() : "?";
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

function teamNameVon(z, teamId) {
  const t = z.teams.find((x) => x.id === teamId);
  return t ? t.name : "—";
}

function spielerNameVon(z, uid) {
  const s = z.spieler.find((x) => x.id === uid);
  return s ? s.name : "?";
}

// --- Routing ---------------------------------------------------------------
function bestimmeScreen(z) {
  // Kein Turnier geöffnet (oder das gemerkte gibt es nicht mehr) -> Turnierliste.
  if (!z.turnierId || !z.vorhanden) return "screen-auswahl";
  if (z.phase === "anmeldung") {
    if (willMitmachen && !z.eigenerSpieler) return "screen-login";
    if (z.eigenerSpieler || z.istAdmin) return "screen-lobby";
    return "screen-start";
  }
  return { teams: "screen-teams", gruppen: "screen-gruppen", ko: "screen-ko", beendet: "screen-beendet" }[z.phase] || "screen-start";
}

// --- Haupt-Render ----------------------------------------------------------
function render(z) {
  zustand = z;
  const screen = bestimmeScreen(z);
  showScreen(screen);
  if (z.phase !== "teams") losFelderInit = false;

  if (screen === "screen-auswahl") renderAuswahl(z);
  if (screen === "screen-start") renderStart(z);
  if (screen === "screen-lobby") renderLobby(z);
  if (screen === "screen-teams") renderTeams(z);
  if (screen === "screen-gruppen") renderGruppen(z);
  if (screen === "screen-ko") renderKo(z);
  if (screen === "screen-beendet") renderBeendet(z);

  // Rückweg in die Turnierliste nur, solange ein Turnier geöffnet ist.
  const leiste = document.getElementById("turnier-leiste");
  leiste.style.display = screen === "screen-auswahl" ? "none" : "";
  document.getElementById("turnier-leiste-name").textContent = z.vorhanden ? z.meta.name : "";

  // Admin-Zahnrad nur zeigen, wenn ein Turnier existiert – und gar nicht,
  // solange der Turnierteil ausgeblendet ist (es öffnet nur Turnier-Aktionen;
  // der Streamplan hat seinen eigenen Veranstalter-Bereich in seinem Tab).
  document.getElementById("btn-admin-oeffnen").style.display = TURNIER_SICHTBAR && z.vorhanden ? "" : "none";
}

// --- AUSWAHL: alle Turniere nebeneinander ----------------------------------
const PHASE_TEXT = {
  anmeldung: "Anmeldung läuft",
  teams: "Teams stehen fest",
  gruppen: "Gruppenphase",
  ko: "K.-o.-Runde",
  beendet: "Beendet",
};

const FORM_TEXT = { 1: "1 gegen 1", 2: "2 gegen 2", 3: "3 gegen 3", 4: "4 gegen 4" };
const ABLAUF_TEXT = {
  gruppen_ko: "Gruppen + K.-o.",
  nur_ko: "Nur K.-o.",
  nur_gruppen: "Jeder gegen jeden",
  schweizer: "Schweizer System",
  schweizer_ko: "Schweizer + K.-o.",
};

// Kurzname der Feinwertung fuer den Tabellenkopf.
const WERTUNG_KOPF = { buchholz: "BH", buchholz_cut1: "BH-1", sonneborn: "SB" };
function wertungSpalte(tiebreak) {
  return WERTUNG_KOPF[tiebreak] || null;
}
function wertungWert(zeile, tiebreak) {
  if (tiebreak === "buchholz") return zeile.buchholz;
  if (tiebreak === "buchholz_cut1") return zeile.buchholzCut1;
  if (tiebreak === "sonneborn") return zeile.sonneborn;
  return 0;
}

// --- Formatwahl während der Anmeldung ------------------------------------
// Das Format wird bewusst erst gewählt, wenn die Anmeldungen da sind: am
// Veranstaltungstag weiß niemand vorher, wie viele kommen. Damit die Wahl
// keine Kopfrechenaufgabe ist, rechnet die App jeden Ablauf für die aktuelle
// Zahl durch (Partien, Runden, wie oft jede:r drankommt).
const ABLAUF_TITEL = {
  gruppen_ko: "Gruppen, dann K.-o.",
  nur_ko: "Nur K.-o.",
  nur_gruppen: "Jeder gegen jeden",
  schweizer: "Schweizer System",
  schweizer_ko: "Schweizer System, dann K.-o.",
};

// Was der Veranstalter gerade angeklickt hat, aber noch nicht festgelegt hat.
// Eigener Entwurf statt setzeAuswahl(): sonst springt die halbfertige Wahl
// bei jeder neuen Anmeldung (Live-Update) auf den gespeicherten Stand zurück.
let formatEntwurf = { teamGroesse: null, koTyp: null, ablauf: null };

function formatEntwurfAus(z) {
  if (formatEntwurf.teamGroesse === null) formatEntwurf.teamGroesse = z.teamGroesse;
  if (formatEntwurf.koTyp === null) formatEntwurf.koTyp = z.koTyp;
  if (formatEntwurf.ablauf === null) formatEntwurf.ablauf = z.formatOffen ? "" : z.ablauf;
  return formatEntwurf;
}
function formatEntwurfZuruecksetzen() {
  formatEntwurf = { teamGroesse: null, koTyp: null, ablauf: null };
}

// Kleiner Text-Setzer: es gibt nur zeigeFehler(), und der ist fuer Fehler.
function setzeText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

function renderFormatWahl(z) {
  const liste = document.getElementById("format-liste");
  if (!liste) return;
  const entwurf = formatEntwurfAus(z);
  const anzahl = z.spieler.length;

  document.getElementById("form-teamgroesse").value = String(entwurf.teamGroesse);
  document.getElementById("form-kotyp").value = entwurf.koTyp;

  setzeText("format-stand", z.formatOffen
    ? "Noch nichts festgelegt. Warte, bis alle da sind – dann wähle hier."
    : "Festgelegt: " + (FORM_TEXT[z.teamGroesse] || "") + " · " +
      (ABLAUF_TEXT[z.ablauf] || "") + ". Änderbar, solange die Anmeldung läuft.");

  const wort = anzahl === 1 ? "1 Angemeldeten" : anzahl + " Angemeldeten";
  setzeText("format-vorschau-titel", "Ablauf – so sähe er mit " + wort + " aus");

  const vergleich = turnierService.formatVergleich(anzahl, entwurf.teamGroesse, entwurf.koTyp);
  // Was aus den Angemeldeten wird, gehört direkt unter die Auswahl: sonst
  // steht auf den Karten "6 Teams", ohne dass jemand sieht, wo die herkommen.
  const probe = vergleich[0];
  setzeText("format-teams-zeile", anzahl === 0
    ? "Noch niemand angemeldet."
    : entwurf.teamGroesse === 1
    ? anzahl + (anzahl === 1 ? " Teilnehmer:in spielt" : " Teilnehmende spielen") + " einzeln gegeneinander."
    : anzahl + " Angemeldete ergeben " + probe.teams + " Team" + (probe.teams === 1 ? "" : "s") +
      (probe.uebrige === 1
        ? " – 1 Person geht nicht auf und kommt ins schwächste Team dazu."
        : probe.uebrige
        ? " – " + probe.uebrige + " Personen gehen nicht auf und kommen in die schwächsten Teams dazu."
        : "."));
  liste.innerHTML = vergleich
    .map((v) => {
      const aktiv = v.ablauf === entwurf.ablauf && v.moeglich;
      const zeilen = v.zeilen.map((t) => `<span class="fk-zeile">${escapeHtml(t)}</span>`).join("");
      const warnung = v.warnung ? `<span class="fk-warnung">${escapeHtml(v.warnung)}</span>` : "";
      const zahlen = v.moeglich
        ? `<span class="fk-zahlen">${escapeHtml(v.kurz)}</span>`
        : "";
      return `<button type="button" class="format-karte${aktiv ? " aktiv" : ""}${v.moeglich ? "" : " gesperrt"}"
        data-ablauf="${escapeHtml(v.ablauf)}"${v.moeglich ? "" : " disabled"}>
        <span class="fk-kopf"><span class="fk-name">${escapeHtml(ABLAUF_TITEL[v.ablauf] || v.ablauf)}</span>
        <span class="fk-haken">${aktiv ? "✓" : ""}</span></span>
        ${zahlen}${zeilen}${warnung}
      </button>`;
    })
    .join("");
}

// Im Einzelturnier gibt es keine Teams – dann heißt alles "Teilnehmer".
function einheitWort(teamGroesse) {
  return teamGroesse === 1 ? "Teilnehmer" : "Teams";
}

function renderAuswahl(z) {
  const liste = z.liste || [];
  const box = document.getElementById("auswahl-liste");
  const leer = document.getElementById("auswahl-leer");

  leer.style.display = liste.length === 0 && z.listeGeladen ? "" : "none";
  box.innerHTML = liste
    .map((t) => {
      // "Gruppenphase" stimmt nur da, wo es wirklich Gruppen gibt.
      const eineTabelle = t.ablauf === "nur_gruppen" || t.ablauf === "schweizer" || t.ablauf === "schweizer_ko";
      const phase = t.phase === "teams" && t.teamGroesse === 1
        ? "Teilnehmer stehen fest"
        : t.phase === "gruppen" && eineTabelle
        ? "Spiele laufen"
        : PHASE_TEXT[t.phase] || (t.geladen ? "—" : "wird geladen …");
      const zahl = t.spielerAnzahl === 1 ? "1 Angemeldete:r" : t.spielerAnzahl + " Angemeldete";
      // Solange der Turnierbaum nicht da ist, stehen in teamGroesse/ablauf nur
      // die Standardwerte – die dürfen nicht als Tatsache auf der Kachel landen.
      // Solange das Format offen ist, stehen in teamGroesse/ablauf nur
      // Platzhalter – die dürfen nicht als Zusage auf der Kachel landen.
      const art = !t.geladen
        ? ""
        : t.formatOffen
        ? "Format wird noch festgelegt"
        : (FORM_TEXT[t.teamGroesse] || "") + " · " + (ABLAUF_TEXT[t.ablauf] || "") + (t.koTyp === "doppel" ? " (doppelt)" : "");
      const aktion = t.binIchDrin
        ? "Du bist dabei"
        : t.phase === "anmeldung"
        ? "Einschreiben"
        : "Ansehen";
      // Papierkorb nur für den Veranstalter DIESES Turniers – sonst führt der
      // Knopf nur in eine Fehlermeldung.
      const loeschen = t.binIchVeranstalter
        ? `<button class="tk-loeschen" data-loeschen="${escapeHtml(t.id)}" title="Turnier löschen" aria-label="Turnier löschen">🗑</button>`
        : "";
      // Symbol je Phase: auf einen Blick sichtbar, wo ein Turnier gerade steht,
      // ohne dafür die Zeilen darunter lesen zu müssen.
      const symbol = t.phase === "beendet" ? "🏅" : t.phase === "anmeldung" ? "📝" : "⚔️";
      return `<div class="turnier-karte${t.binIchDrin ? " dabei" : ""}">
        <button class="tk-oeffnen" data-turnier="${escapeHtml(t.id)}">
          <span class="tk-symbol" aria-hidden="true">${symbol}</span>
          <span class="tk-text">
            <span class="tk-name">${escapeHtml(t.name)}</span>
            ${art ? `<span class="tk-meta">${escapeHtml(art)}</span>` : ""}
            <span class="tk-meta">${escapeHtml(phase)} · ${escapeHtml(zahl)}</span>
          </span>
          <span class="tk-aktion">${escapeHtml(aktion)}</span>
        </button>
        ${loeschen}
      </div>`;
    })
    .join("");
  zeigeFehler("auswahl-fehler", "");

  const frei = veranstalterFrei();
  document.getElementById("veranstalter-gate").style.display = frei ? "none" : "";
  document.getElementById("anlegen-block").style.display = frei ? "" : "none";
  // Der Abmelde-Knopf gilt nur dem Passwort-Notausgang: wer ueber sein KONTO
  // Veranstalter ist, kann sich hier nichts abgewoehnen - er wuerde nur einen
  // Merker loeschen, den er gar nicht gesetzt hat.
  const sperrKnopf = document.getElementById("btn-veranstalter-sperren");
  if (sperrKnopf) sperrKnopf.hidden = !veranstalterPasswortMerker();
}

// --- START -----------------------------------------------------------------
function renderStart(z) {
  document.getElementById("start-turniername").textContent = "🏆 " + z.meta.name;
  document.getElementById("start-phase-text").textContent =
    z.phase === "anmeldung" ? "Anmeldung läuft – mach mit!" : "Turnier läuft";
  document.getElementById("start-zaehler").textContent = z.spieler.length + " Angemeldete";
  document.getElementById("btn-mitmachen").style.display = z.phase === "anmeldung" ? "" : "none";
}

// --- LOBBY -----------------------------------------------------------------
function renderLobby(z) {
  document.getElementById("lobby-titel").textContent = z.meta.name + " – Anmeldung";
  document.getElementById("lobby-zaehler").textContent = z.spieler.length + " Angemeldete";

  const liste = document.getElementById("lobby-spielerliste");
  liste.innerHTML = z.spieler
    .map((s) => {
      const ich = s.id === z.eigeneUid ? ' <span class="spieler-badge">(du)</span>' : "";
      return `<li>
        <span class="spieler-avatar" style="background:${avatarFarbe(s.id)}">${escapeHtml(initiale(s.name))}</span>
        <span class="spieler-name">${escapeHtml(s.name)}${ich}</span>
        <span class="spieler-badge">${Number(s.rating) || 0}</span>
      </li>`;
    })
    .join("");

  // eigenes Rating anpassen
  const eigen = document.getElementById("lobby-eigen");
  if (z.eigenerSpieler) {
    eigen.style.display = "";
    setRating("lobby-rating-slider", "lobby-rating", z.eigenerSpieler.rating);
  } else {
    eigen.style.display = "none";
  }

  document.getElementById("btn-lobby-selbst-anmelden").style.display = z.eigenerSpieler ? "none" : "";
  document.getElementById("lobby-admin").style.display = z.istAdmin ? "" : "none";
  document.getElementById("lobby-warte").style.display = z.istAdmin || !z.eigenerSpieler ? "none" : "";

  const einzel = z.teamGroesse === 1;
  document.getElementById("lobby-warte").textContent = einzel
    ? "Warte, bis der Veranstalter auslost …"
    : "Warte, bis der Veranstalter die Teams bildet …";

  if (z.istAdmin) {
    document.getElementById("btn-teams-bilden").textContent = einzel
      ? "Weiter zur Auslosung →"
      : "Teams bilden →";
    // Geht die Zahl der Angemeldeten nicht auf, wandern die Übrigen in die
    // schwächsten Teams – das soll dastehen, bevor sich jemand wundert.
    const rest = z.spieler.length % z.teamGroesse;
    document.getElementById("lobby-teams-hinweis").textContent = z.formatOffen
      ? "Lege oben zuerst das Turnierformat fest."
      : einzel
      ? "Als Veranstalter: alle Angemeldeten spielen einzeln gegeneinander."
      : "Als Veranstalter: bildet ratingfaire " + z.teamGroesse + "er-Teams." +
        (rest === 1
          ? " 1 Angemeldete:r geht nicht auf und kommt ins schwächste Team dazu."
          : rest
          ? " " + rest + " Angemeldete gehen nicht auf und kommen in die schwächsten Teams dazu."
          : "");
    renderFormatWahl(z);
    // Ohne Format keine Teams: die Auslosung hängt an teamGroesse und ablauf.
    document.getElementById("btn-teams-bilden").disabled = !!z.formatOffen;
  }
}

// Setzt ein <select> nur, wenn es nicht gerade bearbeitet wird.
function setzeAuswahl(id, wert) {
  const el = document.getElementById(id);
  if (!el || el === document.activeElement) return;
  if (el.value !== wert) el.value = wert;
}

// --- TEAMS -----------------------------------------------------------------
function renderTeams(z) {
  const liste = document.getElementById("teams-liste");
  liste.innerHTML = z.teams
    .slice()
    .sort((a, b) => (b.ratingSchnitt || 0) - (a.ratingSchnitt || 0))
    .map((t) => {
      const mitglieder = t.mitgliederUids
        .map((uid) => `<span class="team-mitglied"><span class="spieler-avatar mini" style="background:${avatarFarbe(uid)}">${escapeHtml(initiale(spielerNameVon(z, uid)))}</span>${escapeHtml(spielerNameVon(z, uid))}</span>`)
        .join("");
      return `<div class="team-karte">
        <div class="team-kopf"><span class="team-name">${escapeHtml(t.name)}</span><span class="team-rating">Ø ${t.ratingSchnitt || 0}</span></div>
        <div class="team-mitglieder">${mitglieder}</div>
      </div>`;
    })
    .join("");

  const einzel = z.teamGroesse === 1;
  const wort = einheitWort(z.teamGroesse);
  document.getElementById("teams-titel").textContent = wort;

  const adminBlock = document.getElementById("teams-admin");
  adminBlock.style.display = z.istAdmin ? "" : "none";
  document.getElementById("teams-warte").style.display = z.istAdmin ? "none" : "";

  if (z.istAdmin) {
    // Tauschen und "Neu vorschlagen" ergeben nur Sinn, wenn es Paare gibt.
    document.getElementById("teams-tausch-block").style.display = einzel ? "none" : "";
    if (!einzel) {
      const optionen = z.teams
        .flatMap((t) => t.mitgliederUids.map((uid) => ({ uid, name: spielerNameVon(z, uid), team: t.name })))
        .map((o) => `<option value="${escapeHtml(o.uid)}">${escapeHtml(o.name)} — ${escapeHtml(o.team)}</option>`)
        .join("");
      document.getElementById("tausch-a").innerHTML = optionen;
      document.getElementById("tausch-b").innerHTML = optionen;
    }

    document.getElementById("los-teamzahl").textContent = "(" + z.teams.length + " " + wort + ")";

    // Gruppen und Weiterkommende gibt es nur, wenn eine Gruppenphase gespielt wird.
    const mitGruppen = z.ablauf === "gruppen_ko";
    const tabellenphase = z.ablauf === "nur_gruppen" || z.istSchweizer || mitGruppen;
    document.getElementById("los-gruppenfelder").style.display = mitGruppen ? "" : "none";
    document.getElementById("los-vorschau").style.display = mitGruppen ? "" : "none";
    document.getElementById("los-schweizerfelder").style.display = z.istSchweizer ? "" : "none";
    document.getElementById("los-schweizer-hinweis").style.display = z.istSchweizer ? "" : "none";
    document.getElementById("los-weiter-gesamt-feld").style.display = z.istSchweizer && z.hatKoRunde ? "" : "none";
    document.getElementById("los-finalfeld").style.display = z.hatKoRunde ? "" : "none";
    document.getElementById("los-kotyp-feld").style.display = z.hatKoRunde ? "" : "none";
    // Im Doppel-K.-o. ergibt sich Platz 3 aus dem Verliererbaum.
    const doppelKo = document.getElementById("los-kotyp").value === "doppel";
    document.getElementById("los-platz3-zeile").style.display = z.hatKoRunde && !doppelKo ? "" : "none";
    document.getElementById("los-kotyp-hinweis").textContent = doppelKo
      ? "Wer verliert, rutscht in den Verliererbaum und ist erst nach der zweiten Niederlage raus. Am Ende steht ein großes Finale."
      : "Eine Niederlage und man ist raus.";
    renderSetzliste(z);
    // Hin- und Rückrunde ergibt nur da Sinn, wo feste Paarungen entstehen –
    // im Schweizer System werden die Gegner ja erst je Runde ausgelost.
    const mitPaarungen = mitGruppen || z.ablauf === "nur_gruppen";
    document.getElementById("los-doppelrunde-zeile").style.display = mitPaarungen ? "" : "none";
    // Spieltage gibt es nur, wo die Paarungen von vornherein feststehen – im
    // Schweizer System entsteht jede Runde erst aus dem Zwischenstand.
    document.getElementById("los-spieltage-zeile").style.display = mitPaarungen ? "" : "none";
    document.getElementById("los-bracketreset-zeile").style.display =
      z.hatKoRunde && document.getElementById("los-kotyp").value === "doppel" ? "" : "none";
    // Punkte und Gleichstand betreffen nur eine Tabelle.
    document.getElementById("los-wertungfelder").style.display = tabellenphase ? "" : "none";

    document.getElementById("los-ablauf-hinweis").textContent =
      z.ablauf === "nur_ko"
        ? "Nur K.-o.-Runde: alle " + z.teams.length + " " + wort + " kommen direkt ins Bracket, wer verliert ist raus."
        : z.ablauf === "nur_gruppen"
        ? "Jeder gegen jeden: alle " + z.teams.length + " " + wort + " spielen in einer Tabelle, danach entscheidet Platz 1."
        : z.ablauf === "schweizer"
        ? "Schweizer System: feste Rundenzahl, jede Runde neue Gegner mit ähnlicher Punktzahl. Danach entscheidet die Tabelle."
        : z.ablauf === "schweizer_ko"
        ? "Schweizer System, danach kommen die Besten in die K.-o.-Runde."
        : "Gruppenphase, danach K.-o.-Runde.";
    // Bei "jeder gegen jeden" spielt ohnehin jede:r gegen jede:n – die
    // Auslosungs-Art hätte dort keine Wirkung.
    document.getElementById("los-art-block").style.display = z.ablauf === "nur_gruppen" ? "none" : "";
    document.getElementById("losmodus-setzliste-text").textContent = mitGruppen
      ? "— starke " + wort + " auf die Gruppen verteilt (fairere Gruppen)"
      : "— starke " + wort + " treffen erst spät aufeinander";

    if (!losFelderInit) {
      losFelderInit = true;
      document.getElementById("los-gruppen").value = turnierService.vorschlagGruppen(z.teams.length);
      document.getElementById("los-runden").value = turnierService.schweizerVorschlagRunden(z.teams.length);
      document.getElementById("los-weiter-gesamt").value = Math.min(z.teams.length, 4);
      document.getElementById("los-tiebreak").value = z.tiebreak;
      document.getElementById("los-punkte").value = z.punkteSieg;
    }
    if (z.istSchweizer) aktualisiereSchweizerHinweis(z.teams.length);
    aktualisiereLosVorschau(z.teams.length);
  }
}

// Überschrift einer Runde: im Schweizer System "Runde N", im Ligamodus
// "Spieltag N" – samt Datum, wenn eines eingetragen ist.
function rundenName(z, runde) {
  if (z.istSchweizer) return "Runde " + (runde + 1);
  const datum = (z.spieltagDaten || {})[runde];
  return "Spieltag " + (runde + 1) + (datum ? " – " + datumLesbar(datum) : "");
}

function datumLesbar(iso) {
  const teile = String(iso || "").split("-");
  if (teile.length !== 3) return String(iso || "");
  return teile[2] + "." + teile[1] + "." + teile[0];
}

// Ligamodus: je Spieltag ein Datumsfeld für den Veranstalter.
function renderSpieltagDaten(z) {
  const karte = document.getElementById("spieltag-daten");
  const box = document.getElementById("spieltag-datum-liste");
  if (!karte || !box) return;
  const zeigen = z.istAdmin && z.spieltage && !z.istSchweizer;
  karte.style.display = zeigen ? "" : "none";
  if (!zeigen) return;
  // Die Spieltagsnummern aus den Spielen holen, nicht raten – bei mehreren
  // Gruppen laufen sie gruppenübergreifend gleich.
  const nummern = [...new Set(z.spiele.filter((s) => s.phase === "gruppe").map((s) => Number(s.runde) || 0))]
    .sort((a, b) => a - b);
  const daten = z.spieltagDaten || {};
  box.innerHTML = nummern
    .map((n) => `<div class="spieltag-datum-zeile">
      <span class="sd-name">Spieltag ${n + 1}</span>
      <input type="date" class="eingabe" data-spieltag="${n}" value="${escapeHtml(daten[n] || "")}">
    </div>`)
    .join("");
}

// Setzliste von Hand: Reihenfolge, die beim Auslosen als "stark nach schwach"
// gilt. Ohne Eingriff steht hier schlicht die Rating-Reihenfolge.
function renderSetzliste(z) {
  const box = document.getElementById("setzliste");
  if (!box) return;
  const liste = z.setzliste || [];
  box.innerHTML = liste
    .map((t, i) => `<li>
      <span class="sl-pos">${i + 1}.</span>
      <span class="sl-name">${escapeHtml(t.name)}</span>
      <button class="sl-knopf" data-hoch="${escapeHtml(t.id)}" title="nach oben"${i === 0 ? " disabled" : ""}>↑</button>
      <button class="sl-knopf" data-runter="${escapeHtml(t.id)}" title="nach unten"${i === liste.length - 1 ? " disabled" : ""}>↓</button>
    </li>`)
    .join("");
}

// Sagt an, wie viele Spiele bei der gewählten Rundenzahl je Person anfallen.
function aktualisiereSchweizerHinweis(anzahl) {
  const feld = document.getElementById("los-runden");
  const box = document.getElementById("los-schweizer-hinweis");
  if (!feld || !box) return;
  const max = Math.max(1, anzahl - 1);
  const runden = Math.max(1, Math.min(max, Number(feld.value) || 1));
  const ungerade = anzahl % 2 === 1;
  box.textContent = "→ " + runden + " Runde" + (runden > 1 ? "n" : "") + ", also " + runden +
    " Spiel" + (runden > 1 ? "e" : "") + " je Teilnehmer" +
    (ungerade ? " (ungerade Zahl: je Runde bekommt eine:r ein Freilos und damit einen Sieg geschenkt)." : ".") +
    " Höchstens " + max + " Runden möglich, sonst gäbe es Wiederholungen.";
}

// Zeigt an, wie groß die Gruppen bei der aktuell gewählten Gruppenzahl würden.
function aktualisiereLosVorschau(teamAnzahl) {
  const gruppenEl = document.getElementById("los-gruppen");
  const vorschauEl = document.getElementById("los-vorschau");
  if (!gruppenEl || !vorschauEl) return;
  const gruppen = Math.max(1, Math.min(teamAnzahl, Number(gruppenEl.value) || 1));
  const basis = Math.floor(teamAnzahl / gruppen);
  const rest = teamAnzahl % gruppen;
  const groessen = [];
  for (let i = 0; i < gruppen; i++) groessen.push(basis + (i < rest ? 1 : 0));
  const alleGleich = groessen.every((g) => g === groessen[0]);
  const wort = einheitWort(zustand ? zustand.teamGroesse : 2);
  vorschauEl.textContent = "→ " + (alleGleich
    ? gruppen + " Gruppe" + (gruppen > 1 ? "n" : "") + " à " + groessen[0] + " " + wort
    : gruppen + " Gruppen: " + groessen.join(", ") + " " + wort);
}

// --- GRUPPEN ---------------------------------------------------------------
function renderGruppen(z) {
  // Eine Tabelle statt Gruppen: "Jeder gegen jeden" und Schweizer System.
  const eineTabelle = z.ablauf === "nur_gruppen" || z.istSchweizer;
  const spalte = einheitWort(z.teamGroesse) === "Teams" ? "Team" : "Teilnehmer";
  // Buchholz nur zeigen, wenn danach auch gewertet wird – sonst ist es eine
  // Zahl, die niemand einordnen kann.
  const wertungKopf = wertungSpalte(z.tiebreak);
  const zeigeBuchholz = !!wertungKopf;
  // Hervorheben, wer weiterkommt. Ohne K.-o.-Runde ist das nur Platz 1.
  const qualBis = !z.hatKoRunde ? 1 : z.istSchweizer ? (z.meta.weiterInsgesamt || 4) : (z.meta.weiterProGruppe || 2);

  const container = document.getElementById("gruppen-container");
  container.innerHTML = z.gruppen
    .map((g) => {
      const zeilen = g.tabelle
        .map((r, i) => {
          const frei = r.freilose > 0 ? ' <span class="spieler-badge">Freilos</span>' : "";
          return `<tr class="${i < qualBis ? "qual" : ""}">
            <td class="pos">${i + 1}</td>
            <td class="tname">${escapeHtml(r.name)}${frei}</td>
            <td>${r.spiele}</td>
            <td>${r.siege}-${r.niederlagen}</td>
            <td>${r.saetzePlus}:${r.saetzeMinus}</td>
            ${zeigeBuchholz ? `<td>${wertungWert(r, z.tiebreak)}</td>` : ""}
            <td class="punkte">${r.punkte}</td>
          </tr>`;
        })
        .join("");
      // Schweizer System und Ligamodus spielen in Runden – sonst steht alles
      // in einem Block.
      const spiele = z.istSchweizer || z.spieltage
        ? g.runden.map((r) => `<h4 class="runden-titel">${escapeHtml(rundenName(z, r.runde))}</h4>
            <div class="spiel-liste">${r.spiele.map((s) => spielZeileHtml(z, s)).join("")}</div>`).join("")
        : `<div class="spiel-liste">${g.spiele.map((s) => spielZeileHtml(z, s)).join("")}</div>`;
      return `<div class="gruppe">
        ${eineTabelle ? "" : `<h3>Gruppe ${escapeHtml(g.name)}</h3>`}
        <table class="tabelle">
          <thead><tr><th></th><th>${spalte}</th><th>Sp</th><th>S-N</th><th>Sätze</th>${zeigeBuchholz ? `<th>${wertungKopf}</th>` : ""}<th>Pkt</th></tr></thead>
          <tbody>${zeilen}</tbody>
        </table>
        ${spiele}
      </div>`;
    })
    .join("");

  const rundenText = z.istSchweizer ? ` – Runde ${Math.max(1, z.schweizerGespielt)} von ${z.schweizerRunden}` : "";
  document.getElementById("gruppen-titel").textContent =
    (z.istSchweizer ? "Schweizer System" : eineTabelle ? "Tabelle" : "Gruppenphase") + rundenText;

  const offen = z.spiele.filter((s) => s.phase === "gruppe" && s.status !== "bestaetigt").length;
  // Im Schweizer System kommt erst die nächste Runde, und erst nach der letzten
  // die K.-o.-Runde bzw. der Abschluss.
  const fehlendeRunden = z.istSchweizer && z.schweizerGespielt < z.schweizerRunden;

  renderSpieltagDaten(z);

  const adminBlock = document.getElementById("gruppen-admin");
  adminBlock.style.display = z.istAdmin ? "" : "none";
  if (z.istAdmin) {
    const btn = document.getElementById("btn-ko-losen");
    btn.disabled = offen > 0;
    btn.textContent = fehlendeRunden
      ? `Runde ${z.schweizerGespielt + 1} auslosen →`
      : z.hatKoRunde
      ? "K.o.-Auslosung starten →"
      : "Turnier beenden →";
    document.getElementById("gruppen-admin-hinweis").textContent =
      offen > 0
        ? `Noch ${offen} unbestätigte(s) Spiel(e).`
        : fehlendeRunden
        ? `Runde ${z.schweizerGespielt} fertig – die nächste wird nach dem aktuellen Stand ausgelost.`
        : z.hatKoRunde
        ? "Alle Spiele bestätigt – bereit für die K.-o.-Runde."
        : "Alle Spiele bestätigt – Platz 1 der Tabelle gewinnt.";
    zeigeSimKnopf("btn-sim-gruppen", z.offeneSpieleAnzahl);
  }
  const warte = document.getElementById("gruppen-warte");
  warte.style.display = z.istAdmin ? "none" : "";
  warte.textContent = offen > 0
    ? `Noch ${offen} Spiel(e) offen.`
    : fehlendeRunden
    ? "Runde fertig – warte auf die Auslosung der nächsten Runde."
    : z.hatKoRunde
    ? "Alles fertig – warte auf die K.-o.-Auslosung."
    : "Alle Spiele fertig – warte auf den Abschluss durch den Veranstalter.";
}

// --- K.O. ------------------------------------------------------------------
function renderKo(z) {
  document.getElementById("ko-container").innerHTML = bracketHtml(z);
  document.getElementById("ko-admin").style.display = z.istAdmin ? "" : "none";
  if (z.istAdmin) zeigeSimKnopf("btn-sim-ko", z.offeneSpieleAnzahl);
}

// Der Auswürfeln-Knopf trägt die Anzahl im Text und verschwindet, wenn nichts
// mehr offen ist – in der K.-o.-Runde ändert sich beides nach jeder Runde.
function zeigeSimKnopf(id, anzahl) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.style.display = anzahl > 0 ? "" : "none";
  btn.textContent = anzahl === 1 ? "🧪 1 offenes Spiel auswürfeln" : `🧪 ${anzahl} offene Spiele auswürfeln`;
}

// --- BEENDET ---------------------------------------------------------------
function renderBeendet(z) {
  // Bei "Jeder gegen jeden" gibt es kein Bracket – der Sieger steht nur in meta.
  const siegerId = (z.bracket && z.bracket.siegerTeamId) || z.meta.siegerTeamId || null;
  document.getElementById("beendet-sieger").textContent = "🥇 " + (siegerId ? teamNameVon(z, siegerId) : "—");

  const hatBracket = !!(z.bracket && z.bracket.runden.length);
  const bracketBox = document.getElementById("beendet-bracket");
  bracketBox.style.display = hatBracket ? "" : "none";
  bracketBox.innerHTML = hatBracket ? bracketHtml(z) : "";

  // Ohne K.-o.-Runde ist die Endtabelle das Ergebnis.
  const tabelleBox = document.getElementById("beendet-tabelle");
  tabelleBox.style.display = hatBracket ? "none" : "";
  tabelleBox.innerHTML = hatBracket ? "" : endtabelleHtml(z);
}

// Endstand als Tabelle – für Turniere, die ohne K.-o.-Runde enden.
function endtabelleHtml(z) {
  if (!z.gruppen || !z.gruppen.length) return '<p class="hinweis-text">Keine Tabelle vorhanden.</p>';
  const spalte = einheitWort(z.teamGroesse) === "Teams" ? "Team" : "Teilnehmer";
  const wertungKopf = wertungSpalte(z.tiebreak);
  const zeigeBuchholz = !!wertungKopf;
  return z.gruppen
    .map((g) => {
      const zeilen = g.tabelle
        .map((r, i) => `<tr class="${i === 0 ? "qual" : ""}">
          <td class="pos">${i + 1}</td>
          <td class="tname">${escapeHtml(r.name)}</td>
          <td>${r.spiele}</td>
          <td>${r.siege}-${r.niederlagen}</td>
          <td>${r.saetzePlus}:${r.saetzeMinus}</td>
          ${zeigeBuchholz ? `<td>${wertungWert(r, z.tiebreak)}</td>` : ""}
          <td class="punkte">${r.punkte}</td>
        </tr>`)
        .join("");
      return `<div class="gruppe">
        ${z.gruppen.length > 1 ? `<h3>Gruppe ${escapeHtml(g.name)}</h3>` : ""}
        <table class="tabelle">
          <thead><tr><th></th><th>${spalte}</th><th>Sp</th><th>S-N</th><th>Sätze</th>${zeigeBuchholz ? `<th>${wertungKopf}</th>` : ""}<th>Pkt</th></tr></thead>
          <tbody>${zeilen}</tbody>
        </table>
      </div>`;
    })
    .join("");
}

function bracketHtml(z) {
  if (!z.bracket || z.bracket.runden.length === 0) return '<p class="hinweis-text">Noch keine Paarungen.</p>';
  return z.bracket.runden
    .map((r) => {
      const matches = r.matches
        .map((m) => {
          const sieger = m.siegerTeamId;
          const aWin = sieger && sieger === m.teamA ? " sieger" : "";
          const bWin = sieger && sieger === m.teamB ? " sieger" : "";
          const spiel = z.spiele.find((s) => s.id === m.id);
          const aktionen = spiel ? spielAktionenHtml(z, spiel) : "";
          return `<div class="match">
            <div class="match-team${aWin}"><span>${escapeHtml(m.teamAName)}</span><span class="match-saetze">${m.saetzeA == null ? "" : m.saetzeA}</span></div>
            <div class="match-team${bWin}"><span>${escapeHtml(m.teamBName)}</span><span class="match-saetze">${m.saetzeB == null ? "" : m.saetzeB}</span></div>
            ${aktionen ? `<div class="match-aktionen">${aktionen}</div>` : ""}
          </div>`;
        })
        .join("");
      return `<div class="bracket-runde"><h3>${escapeHtml(r.name)}</h3>${matches}</div>`;
    })
    .join("") + verliererHtml(z) + grossesFinaleHtml(z) + platz3Html(z);
}

// Verliererbaum des Doppel-K.-o. – nur da, wo es ihn gibt.
function verliererHtml(z) {
  const runden = (z.bracket && z.bracket.verliererRunden) || [];
  if (!runden.length) return "";
  return runden
    .map((r) => `<div class="bracket-runde"><h3>${escapeHtml(r.name)}</h3>${r.matches.map((m) => matchHtml(z, m)).join("")}</div>`)
    .join("");
}

function grossesFinaleHtml(z) {
  const m = z.bracket && z.bracket.finale;
  const e = z.bracket && z.bracket.entscheidung;
  let html = m ? `<div class="bracket-runde"><h3>Großes Finale</h3>${matchHtml(z, m)}</div>` : "";
  if (e) {
    html += `<div class="bracket-runde"><h3>Entscheidungsspiel</h3>
      <p class="hinweis-text">Beide haben jetzt eine Niederlage – dieses Spiel entscheidet.</p>
      ${matchHtml(z, e)}</div>`;
  }
  return html;
}

// Ein einzelnes Match als Baustein – gleich fuer Bracket, Verliererbaum,
// großes Finale und Spiel um Platz 3.
function matchHtml(z, m) {
  const spiel = z.spiele.find((s) => s.id === m.id);
  const aktionen = spiel ? spielAktionenHtml(z, spiel) : "";
  const aWin = m.siegerTeamId && m.siegerTeamId === m.teamA ? " sieger" : "";
  const bWin = m.siegerTeamId && m.siegerTeamId === m.teamB ? " sieger" : "";
  return `<div class="match">
    <div class="match-team${aWin}"><span>${escapeHtml(m.teamAName)}</span><span class="match-saetze">${m.saetzeA == null ? "" : m.saetzeA}</span></div>
    <div class="match-team${bWin}"><span>${escapeHtml(m.teamBName)}</span><span class="match-saetze">${m.saetzeB == null ? "" : m.saetzeB}</span></div>
    ${aktionen ? `<div class="match-aktionen">${aktionen}</div>` : ""}
  </div>`;
}

// Das Spiel um Platz 3 haengt unter dem Bracket, nicht in der Rundenfolge –
// es entscheidet nichts ueber den Turniersieg.
function platz3Html(z) {
  const m = z.bracket && z.bracket.platz3;
  if (!m) return "";
  return `<div class="bracket-runde"><h3>Spiel um Platz 3</h3>${matchHtml(z, m)}</div>`;
}

// --- Spiel-Zeile (Gruppe) + Aktionen --------------------------------------
function spielZeileHtml(z, s) {
  const ergebnis =
    s.status === "offen"
      ? '<span class="spiel-status">offen</span>'
      : `<span class="spiel-ergebnis${s.status === "bestaetigt" ? " ok" : ""}">${s.saetzeA}:${s.saetzeB}${s.status === "gemeldet" ? " ?" : " ✓"}</span>`;
  // Freilos: kein Gegner, aber ein gewerteter Sieg – "vs —" liest sich wie ein Fehler.
  const gegner = s.teamB ? escapeHtml(teamNameVon(z, s.teamB)) : "Freilos";
  return `<div class="spiel-zeile">
    <div class="spiel-teams"><span>${escapeHtml(teamNameVon(z, s.teamA))}</span> <span class="vs">vs</span> <span>${gegner}</span></div>
    <div class="spiel-rechts">${ergebnis}</div>
    <div class="spiel-aktionen">${spielAktionenHtml(z, s)}</div>
  </div>`;
}

// Liefert die passenden Aktions-Buttons für ein Spiel je nach Rolle/Status.
function spielAktionenHtml(z, s) {
  const meinTeam = z.eigenesTeam ? z.eigenesTeam.id : null;
  const beteiligt = meinTeam && (s.teamA === meinTeam || s.teamB === meinTeam);
  const admin = z.istAdmin;
  const btn = (aktion, label, cls) => `<button class="mini-btn ${cls || ""}" data-aktion="${aktion}" data-spiel="${escapeHtml(s.id)}">${label}</button>`;

  if (s.status === "offen") {
    if (!s.teamB) return ""; // Freilos
    if (beteiligt || admin) return btn("melden", "Ergebnis melden", "primary");
    return "";
  }
  if (s.status === "gemeldet") {
    const binGegner = beteiligt && meinTeam !== s.gemeldetVon;
    let html = "";
    if (binGegner || admin) {
      html += btn("bestaetigen", "Bestätigen", "primary") + btn("widersprechen", "Widersprechen", "");
    } else if (beteiligt) {
      html += '<span class="warte-mini">wartet auf Gegner</span>';
    }
    return html;
  }
  if (s.status === "bestaetigt" && admin) {
    return btn("korrigieren", "✎", "");
  }
  return "";
}

// ===========================================================================
// Rating-Slider <-> Zahl koppeln
// ===========================================================================
function setRating(sliderId, numberId, wert) {
  const w = Math.max(500, Math.min(3000, Number(wert) || 1500));
  const sl = document.getElementById(sliderId);
  const nu = document.getElementById(numberId);
  if (sl) sl.value = w;
  if (nu) nu.value = w;
}
function koppleRating(sliderId, numberId) {
  const sl = document.getElementById(sliderId);
  const nu = document.getElementById(numberId);
  if (!sl || !nu) return;
  sl.addEventListener("input", () => (nu.value = sl.value));
  nu.addEventListener("input", () => (sl.value = nu.value));
}

// ===========================================================================
// Melde-Dialog
// ===========================================================================
function oeffneMeldeDialog(spielId, adminModus) {
  const s = zustand.spiele.find((x) => x.id === spielId);
  if (!s) return;
  meldeSpielId = spielId;
  meldeAdminModus = !!adminModus;
  document.getElementById("melden-titel").textContent = adminModus ? "Ergebnis korrigieren" : "Ergebnis melden";
  document.getElementById("melden-name-a").textContent = teamNameVon(zustand, s.teamA);
  document.getElementById("melden-name-b").textContent = teamNameVon(zustand, s.teamB);
  document.getElementById("melden-saetze-a").value = s.saetzeA == null ? 0 : s.saetzeA;
  document.getElementById("melden-saetze-b").value = s.saetzeB == null ? 0 : s.saetzeB;
  const noetig = window.turnierService ? turnierService.noetigeSaetze(zustand.meta.bestOf) : 2;
  document.getElementById("melden-hinweis").textContent = `Best of ${zustand.meta.bestOf}: Sieger braucht ${noetig} Sätze.`;
  document.getElementById("melden-fehler").textContent = "";
  document.getElementById("modal-melden").classList.add("aktiv");
}
function schliesseMeldeDialog() {
  meldeSpielId = null;
  document.getElementById("modal-melden").classList.remove("aktiv");
}

// ===========================================================================
// Admin-Dialog
// ===========================================================================
function oeffneAdmin() {
  const login = document.getElementById("admin-login");
  const panel = document.getElementById("admin-panel");
  const istAdmin = zustand && zustand.istAdmin;
  login.style.display = istAdmin ? "none" : "";
  panel.style.display = istAdmin ? "" : "none";
  document.getElementById("admin-fehler").textContent = "";
  document.getElementById("admin-panel-fehler").textContent = "";
  document.getElementById("admin-pin").value = "";
  document.getElementById("modal-admin").classList.add("aktiv");
}
function schliesseAdmin() {
  document.getElementById("modal-admin").classList.remove("aktiv");
}

// ===========================================================================
// Fehler-Helfer
// ===========================================================================
function zeigeFehler(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

// ===========================================================================
// Event-Wiring
// ===========================================================================
function wireEvents() {
  koppleRating("login-rating-slider", "login-rating");
  koppleRating("lobby-rating-slider", "lobby-rating");

  // Turnier erstellen (legt immer ein zusätzliches an)
  document.getElementById("btn-turnier-erstellen").addEventListener("click", async () => {
    const res = await turnierService.erstelleTurnier({
      name: document.getElementById("neu-name").value,
      adminPin: document.getElementById("neu-pin").value,
      // Kein Format: das legt der Veranstalter später in der Lobby fest,
      // wenn die Zahl der Angemeldeten feststeht.
    });
    zeigeFehler("neu-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) {
      document.getElementById("neu-name").value = "";
      document.getElementById("neu-pin").value = "";
    }
  });

  // Veranstalter-Passwort prüfen und den Anlegen-Bereich freigeben
  const pruefeVeranstalter = async () => {
    const feld = document.getElementById("veranstalter-pw");
    const knopf = document.getElementById("btn-veranstalter-oeffnen");
    const pw = feld.value;
    if (!pw) return zeigeFehler("veranstalter-fehler", "Bitte Passwort eingeben.");
    knopf.disabled = true;
    zeigeFehler("veranstalter-fehler", "Prüfe …");
    try {
      const resp = await fetch(AGELAN_GATEWAY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify-action-password", scope: VERANSTALTER_SCOPE, password: pw }),
      });
      if (resp.ok) {
        setzeVeranstalterFrei(true);
        feld.value = "";
        zeigeFehler("veranstalter-fehler", "");
        if (zustand) render(zustand);
        return;
      }
      if (resp.status === 403) zeigeFehler("veranstalter-fehler", "Falsches Passwort.");
      else if (resp.status === 429) zeigeFehler("veranstalter-fehler", "Zu viele Fehlversuche. Bitte später erneut versuchen.");
      else {
        const body = await resp.json().catch(() => ({}));
        zeigeFehler("veranstalter-fehler", body.error && /nicht konfiguriert/.test(body.error)
          ? "Der Veranstalter-Zugang ist noch nicht eingerichtet."
          : "Prüfung fehlgeschlagen (HTTP " + resp.status + ").");
      }
    } catch (e) {
      zeigeFehler("veranstalter-fehler", "Keine Verbindung zum Server.");
    }
    knopf.disabled = false;
    feld.select();
  };
  document.getElementById("btn-veranstalter-oeffnen").addEventListener("click", pruefeVeranstalter);
  document.getElementById("veranstalter-pw").addEventListener("keydown", (e) => {
    if (e.key === "Enter") pruefeVeranstalter();
  });
  document.getElementById("btn-veranstalter-sperren").addEventListener("click", () => {
    setzeVeranstalterFrei(false);
    if (zustand) render(zustand);
  });

  // Formatwahl: Teamgröße und K.-o.-Art ändern nur den Entwurf und rechnen
  // die Vorschau neu – gespeichert wird erst mit "Format festlegen".
  document.getElementById("form-teamgroesse").addEventListener("change", (e) => {
    formatEntwurf.teamGroesse = Number(e.target.value) || 2;
    if (zustand) renderFormatWahl(zustand);
  });
  document.getElementById("form-kotyp").addEventListener("change", (e) => {
    formatEntwurf.koTyp = e.target.value;
    if (zustand) renderFormatWahl(zustand);
  });
  document.getElementById("format-liste").addEventListener("click", (e) => {
    const karte = e.target.closest("[data-ablauf]");
    if (!karte || karte.disabled) return;
    formatEntwurf.ablauf = karte.dataset.ablauf;
    zeigeFehler("form-fehler", "");
    if (zustand) renderFormatWahl(zustand);
  });

  // Turnierform/Ablauf festlegen (nur während der Anmeldung)
  document.getElementById("btn-form-speichern").addEventListener("click", async () => {
    if (!formatEntwurf.ablauf) {
      return zeigeFehler("form-fehler", "Bitte oben einen Ablauf auswählen.");
    }
    const res = await turnierService.setzeTurnierform({
      teamGroesse: formatEntwurf.teamGroesse,
      ablauf: formatEntwurf.ablauf,
      koTyp: formatEntwurf.koTyp,
    });
    zeigeFehler("form-fehler", res.erfolg ? "" : res.fehler);
    // Nach dem Speichern gilt wieder, was im Turnier steht – sonst hinge die
    // Anzeige an einem Entwurf, den ein anderes Gerät längst überschrieben hat.
    if (res.erfolg) {
      formatEntwurfZuruecksetzen();
      if (zustand) renderFormatWahl(zustand);
    }
  });

  // Turnier aus der Liste öffnen oder löschen
  document.getElementById("auswahl-liste").addEventListener("click", async (e) => {
    const papierkorb = e.target.closest("[data-loeschen]");
    if (papierkorb) {
      const id = papierkorb.dataset.loeschen;
      const eintrag = (zustand && zustand.liste || []).find((t) => t.id === id);
      const name = eintrag ? eintrag.name : "Das Turnier";
      if (!confirm(`„${name}" wirklich löschen? Anmeldungen, Ergebnisse und der Veranstalter-PIN sind dann weg. Das lässt sich nicht rückgängig machen.`)) return;
      const res = await turnierService.loescheTurnierMitId(id);
      zeigeFehler("auswahl-fehler", res.erfolg ? "" : res.fehler);
      return;
    }
    const karte = e.target.closest("[data-turnier]");
    if (!karte) return;
    willMitmachen = false;
    turnierService.waehleTurnier(karte.dataset.turnier);
  });

  // Zurück in die Turnierliste
  document.getElementById("btn-turnier-wechseln").addEventListener("click", () => {
    willMitmachen = false;
    turnierService.waehleTurnier(null);
  });

  // Mitmachen / Zuschauen
  document.getElementById("btn-mitmachen").addEventListener("click", () => {
    willMitmachen = true;
    document.getElementById("login-name").value = turnierService.getGespeicherterName();
    render(zustand);
  });
  document.getElementById("btn-nur-zuschauen").addEventListener("click", () => {
    // In der Anmeldephase gibt es nur die Lobby-Liste zu sehen.
    willMitmachen = false;
    showScreen("screen-lobby");
    renderLobby(zustand);
  });
  document.getElementById("btn-login-zurueck").addEventListener("click", () => {
    willMitmachen = false;
    render(zustand);
  });

  // Login absenden
  document.getElementById("btn-login-bestaetigen").addEventListener("click", async () => {
    const res = await turnierService.tritBei({
      name: document.getElementById("login-name").value,
      rating: document.getElementById("login-rating").value,
    });
    if (res.erfolg) willMitmachen = false;
    zeigeFehler("login-fehler", res.erfolg ? "" : res.fehler);
  });

  // Lobby: Rating speichern
  document.getElementById("btn-lobby-rating-speichern").addEventListener("click", async () => {
    await turnierService.aktualisiereRating(document.getElementById("lobby-rating").value);
  });

  // Lobby: als Veranstalter selbst mitspielen
  document.getElementById("btn-lobby-selbst-anmelden").addEventListener("click", () => {
    willMitmachen = true;
    document.getElementById("login-name").value = turnierService.getGespeicherterName();
    render(zustand);
  });

  // Testspieler (nur Veranstalter, nur während der Anmeldung)
  document.getElementById("btn-test-spieler").addEventListener("click", async () => {
    const res = await turnierService.legeTestspielerAn(document.getElementById("test-anzahl").value);
    zeigeFehler("test-fehler", res.erfolg ? "" : res.fehler);
  });
  document.getElementById("btn-test-entfernen").addEventListener("click", async () => {
    const res = await turnierService.entferneTestspieler();
    zeigeFehler("test-fehler", res.erfolg ? "" : res.fehler);
  });

  // Spiele auswürfeln (Veranstalter, zum Ausprobieren). Mit Rückfrage: bereits
  // bestätigte Ergebnisse bleiben zwar unangetastet, aber die ausgewürfelten
  // lassen sich nur über "Turnier zurücksetzen" wieder loswerden.
  const simuliere = async (fehlerId) => {
    const offen = zustand ? zustand.offeneSpieleAnzahl : 0;
    if (!confirm(`${offen} offene(s) Spiel(e) mit Zufallsergebnissen füllen? Bereits bestätigte Ergebnisse bleiben stehen; die ausgewürfelten bekommst du nur über „Turnier zurücksetzen" wieder weg.`)) return;
    const res = await turnierService.simuliereOffeneSpiele();
    zeigeFehler(fehlerId, res.erfolg ? "" : res.fehler);
  };
  document.getElementById("btn-sim-gruppen").addEventListener("click", () => simuliere("sim-gruppen-fehler"));
  document.getElementById("btn-sim-ko").addEventListener("click", () => simuliere("sim-ko-fehler"));

  // Teams
  document.getElementById("btn-teams-bilden").addEventListener("click", async () => {
    const res = await turnierService.bildeTeams();
    if (!res.erfolg) alert(res.fehler);
  });
  document.getElementById("btn-teams-neu").addEventListener("click", async () => {
    const res = await turnierService.bildeTeams();
    zeigeFehler("teams-fehler", res.erfolg ? "" : res.fehler);
  });
  document.getElementById("btn-tauschen").addEventListener("click", async () => {
    const res = await turnierService.tauscheSpieler(
      document.getElementById("tausch-a").value,
      document.getElementById("tausch-b").value
    );
    zeigeFehler("teams-fehler", res.erfolg ? "" : res.fehler);
  });
  document.getElementById("btn-gruppen-losen").addEventListener("click", async () => {
    const modusEl = document.querySelector('input[name="losmodus"]:checked');
    // loseTurnier entscheidet nach dem Ablauf, ob Gruppen entstehen oder das
    // Bracket direkt gesetzt wird.
    const res = await turnierService.loseTurnier({
      modus: modusEl ? modusEl.value : "setzliste",
      bestOf: document.getElementById("los-bestof").value,
      bestOfFinale: document.getElementById("los-bestof-finale").value,
      anzahlGruppen: document.getElementById("los-gruppen").value,
      weiterProGruppe: document.getElementById("los-weiter").value,
      schweizerRunden: document.getElementById("los-runden").value,
      weiterInsgesamt: document.getElementById("los-weiter-gesamt").value,
      punkteSieg: document.getElementById("los-punkte").value,
      tiebreak: document.getElementById("los-tiebreak").value,
      doppelrunde: document.getElementById("los-doppelrunde").checked,
      spielUmPlatz3: document.getElementById("los-platz3").checked,
      koTyp: document.getElementById("los-kotyp").value,
      spieltage: document.getElementById("los-spieltage").checked,
      bracketReset: document.getElementById("los-bracketreset").checked,
    });
    zeigeFehler("teams-fehler", res.erfolg ? "" : res.fehler);
  });
  document.getElementById("los-gruppen").addEventListener("input", () => {
    if (zustand) aktualisiereLosVorschau(zustand.teams.length);
  });
  document.getElementById("los-runden").addEventListener("input", () => {
    if (zustand) aktualisiereSchweizerHinweis(zustand.teams.length);
  });
  // Die K.-o.-Art blendet das Platz-3-Feld um, also neu zeichnen.
  document.getElementById("los-kotyp").addEventListener("change", () => {
    if (zustand) renderTeams(zustand);
  });

  // Setzliste verschieben
  document.getElementById("setzliste").addEventListener("click", async (e) => {
    const hoch = e.target.closest("[data-hoch]");
    const runter = e.target.closest("[data-runter]");
    if (!hoch && !runter) return;
    const res = await turnierService.verschiebeInSetzliste(
      hoch ? hoch.dataset.hoch : runter.dataset.runter,
      hoch ? -1 : 1
    );
    zeigeFehler("setzliste-fehler", res.erfolg === false && res.fehler ? res.fehler : "");
  });
  // Datum eines Spieltags speichern
  document.getElementById("spieltag-datum-liste").addEventListener("change", async (e) => {
    const feld = e.target.closest("[data-spieltag]");
    if (!feld) return;
    const res = await turnierService.setzeSpieltagDatum(feld.dataset.spieltag, feld.value);
    zeigeFehler("spieltag-fehler", res.erfolg ? "" : res.fehler);
  });

  document.getElementById("btn-setzliste-reset").addEventListener("click", async () => {
    const res = await turnierService.setzlisteZuruecksetzen();
    zeigeFehler("setzliste-fehler", res.erfolg ? "" : res.fehler);
  });

  // Gruppen: K.o. auslosen – oder bei "Jeder gegen jeden" das Turnier beenden.
  document.getElementById("btn-ko-losen").addEventListener("click", async () => {
    if (!zustand) return;
    // Ein Knopf, drei Bedeutungen: naechste Schweizer Runde, K.-o.-Auslosung
    // oder Abschluss ueber die Tabelle.
    const fehlendeRunden = zustand.istSchweizer && zustand.schweizerGespielt < zustand.schweizerRunden;
    const res = fehlendeRunden
      ? await turnierService.naechsteSchweizerRunde()
      : zustand.hatKoRunde
      ? await turnierService.starteKoAuslosung()
      : await turnierService.beendeNachGruppen();
    if (!res.erfolg) zeigeFehler("gruppen-admin-hinweis", res.fehler);
  });

  // K.o.: nächste Runde manuell
  document.getElementById("btn-ko-naechste").addEventListener("click", () => turnierService.naechsteRundeManuell());

  // Delegierte Aktionen für Spiel-Buttons
  document.getElementById("app").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-aktion]");
    if (!btn) return;
    const spielId = btn.getAttribute("data-spiel");
    const aktion = btn.getAttribute("data-aktion");
    if (aktion === "melden") oeffneMeldeDialog(spielId, false);
    else if (aktion === "korrigieren") oeffneMeldeDialog(spielId, true);
    else if (aktion === "bestaetigen") turnierService.bestaetigeErgebnis(spielId).then((r) => { if (!r.erfolg) alert(r.fehler); });
    else if (aktion === "widersprechen") turnierService.widersprichErgebnis(spielId);
  });

  // Melde-Dialog
  document.getElementById("btn-melden-speichern").addEventListener("click", async () => {
    if (!meldeSpielId) return;
    const a = document.getElementById("melden-saetze-a").value;
    const b = document.getElementById("melden-saetze-b").value;
    const res = meldeAdminModus
      ? await turnierService.adminSetzeErgebnis(meldeSpielId, a, b)
      : await turnierService.meldeErgebnis(meldeSpielId, a, b);
    if (res.erfolg) schliesseMeldeDialog();
    else zeigeFehler("melden-fehler", res.fehler);
  });
  document.getElementById("btn-melden-abbrechen").addEventListener("click", schliesseMeldeDialog);

  // Admin-Dialog
  document.getElementById("btn-admin-oeffnen").addEventListener("click", oeffneAdmin);
  document.getElementById("btn-admin-schliessen").addEventListener("click", schliesseAdmin);
  document.getElementById("btn-admin-anmelden").addEventListener("click", () => {
    const res = turnierService.authentifiziereAlsAdmin(document.getElementById("admin-pin").value);
    if (res.erfolg) oeffneAdmin();
    else zeigeFehler("admin-fehler", res.fehler);
  });
  // Zurücksetzen: Angemeldete bleiben drin, nur Teams/Gruppen/Spiele fallen weg.
  document.getElementById("btn-admin-reset").addEventListener("click", async () => {
    if (!confirm("Turnier zurücksetzen? Teams, Gruppen und alle Ergebnisse werden verworfen. Die Angemeldeten bleiben drin, ihr könnt sofort neu auslosen.")) return;
    const res = await turnierService.setzeTurnierZurueck();
    if (!res.erfolg) return zeigeFehler("admin-panel-fehler", res.fehler);
    schliesseAdmin();
  });
  // Löschen: kompletter Turnierbaum weg, danach wieder "Turnier anlegen".
  document.getElementById("btn-admin-loeschen").addEventListener("click", async () => {
    const name = (zustand && zustand.meta && zustand.meta.name) || "Das Turnier";
    if (!confirm(`„${name}" wirklich komplett löschen? Anmeldungen, Ergebnisse und der Admin-PIN sind dann weg. Das kann nicht rückgängig gemacht werden.`)) return;
    const res = await turnierService.loescheTurnier();
    if (!res.erfolg) return zeigeFehler("admin-panel-fehler", res.fehler);
    willMitmachen = false;
    schliesseAdmin();
  });

  // Modals per Klick auf den Hintergrund schließen
  document.getElementById("modal-melden").addEventListener("click", (e) => {
    if (e.target.id === "modal-melden") schliesseMeldeDialog();
  });
  document.getElementById("modal-admin").addEventListener("click", (e) => {
    if (e.target.id === "modal-admin") schliesseAdmin();
  });
}

// --- Fehlgeschlagene Schreibvorgänge sichtbar machen -------------------------
// ⚠️ Die Service-Funktionen geben für LOGIK-Fehler sauber { erfolg:false } zurück,
// fangen aber keine Ausnahme. Schlägt ein Firebase-Schreibvorgang fehl (Token
// abgelaufen, WLAN weg, Regelverstoß), wirft das await in turnier-service.js und
// niemand fängt es: der Klick verpufft, die Oberfläche zeigt weiter den alten
// Stand, und die einzige Spur ist eine unhandledrejection in der Konsole.
//
// Auf einer LAN mit wackligem WLAN heißt das: "Ergebnis melden" gedrückt, nichts
// passiert, nochmal gedrückt, nichts. Ein Handler an dieser Stelle deckt alle 35
// Schreibwege ab; einzelne try/catch in 36 Funktionen wären der teurere Weg zum
// selben Ergebnis.
let netzFehlerTimer = null;
function zeigeNetzFehler(text) {
  const el = document.getElementById("netz-fehler");
  if (!el) return;
  el.textContent = text;
  el.classList.add("sichtbar");
  if (netzFehlerTimer) clearTimeout(netzFehlerTimer);
  netzFehlerTimer = setTimeout(() => el.classList.remove("sichtbar"), 8000);
}

window.addEventListener("unhandledrejection", (e) => {
  // Die Konsolenmeldung bleibt bewusst stehen (kein preventDefault) – sie ist
  // beim Nachsehen die genauere Quelle als dieser Balken.
  const grund = e && e.reason;
  const text = String((grund && grund.message) || grund || "");
  zeigeNetzFehler(
    /permission|denied|auth/i.test(text)
      ? "Nicht gespeichert – die Anmeldung ist abgelaufen. Bitte die Seite neu laden."
      : "Nicht gespeichert – keine Verbindung. Bitte prüfen und noch einmal versuchen."
  );
});

// --- Start ------------------------------------------------------------------
(function init() {
  // Im Normalbetrieb steht hier NICHTS - dass die Seite laeuft, sieht man daran,
  // dass sie laeuft. Nur der Test-Modus meldet sich, damit niemand gegen die
  // Mock-Datenbank arbeitet und es fuer echt haelt.
  const status = document.getElementById("sync-status");
  if (status) {
    if (window.__AGELAN_MOCK__) {
      status.textContent = "● lokal (Test)";
      status.style.color = "#fde68a";
      status.hidden = false;
    } else {
      status.hidden = true;
    }
  }
  wireEvents();
  turnierService.onZustandsAenderung(render);
})();

// ---------- Info-Tab / Versionshistorie ----------
const APP_VERSION = "1.0";
const APP_CHANGELOG = [
  {
    version: "5.1",
    groups: [
      { title: "Essen: eine Bestellung faellt nicht mehr aus der Lieferung", items: [
          "Wer als Veranstalter seine eigene Bestellung noch offen hatte und sie speicherte, <b>nachdem</b> die Sammelbestellung schon rausgegangen war, riss sie damit still aus der Lieferung. Sie landete wieder im Stapel und waere in der naechsten Sammelmail ein zweites Mal beim Lieferanten gelandet; die Lieferung blieb als leere Huelle mit 0,00 € stehen.",
          "Die Zuordnung zur Lieferung bleibt jetzt beim Speichern erhalten. Herausnehmen geht weiterhin nur ueber <b>„Aus der Lieferung nehmen“</b>."
      ]}
    ]
  },
  {
    version: "5.0",
    groups: [
      { title: "Der Streamkalender ist jetzt immer gleich breit", items: [
          "Über den Vorraum geöffnet war der Streamkalender nur halb so breit wie über die Reiterleiste – die Spalten schmaler, die Blöcke enger. Umgekehrt blieb die größere Breite hängen, wenn die App bei fehlendem Recht auf den Turnier-Reiter zurücksprang.",
          "Die Breite hängt jetzt am Reiter selbst, nicht mehr am Weg dorthin."
      ]}
    ]
  },
  {
    version: "4.9",
    groups: [
      { title: "Die Essensdaten sind nicht mehr oeffentlich lesbar", items: [
          "In den Datenbank-Regeln stand der Essensbereich auf „offen fuer alle“ – genauso wie das Turnier-Board darueber. Beim Board ist das richtig, dort haengen Spielstaende. Unter dem Essen liegen aber die Telefonnummer fuer die Bestellung, die Mailadresse des Lieferanten, der Admin-PIN und wer was gegessen hat.",
          "Zum Lesen ist jetzt eine Anmeldung noetig. Fuer alle auf der LAN aendert sich dadurch nichts – die Anmeldung passiert beim Oeffnen der Seite von selbst. Von aussen kommt niemand mehr an die Daten.",
          "Das Turnier-Board und der Streamplan bleiben absichtlich offen: die haengen im Raum an der Wand.",
          "<b>Wichtig:</b> die Regeln muessen in der Firebase-Konsole neu eingefuegt werden, sonst gilt weiter, was dort steht."
      ]},
      { title: "Changelog quer am Handy", items: [
          "Der aufgeklappte Changelog-Kasten war auf 420 Pixel Hoehe begrenzt. Quer gehalten ist ein Handy nur rund 375 Pixel hoch – der Kasten ragte unten heraus. Jetzt richtet er sich nach dem Schirm."
      ]}
    ]
  },
  {
    version: "4.8",
    groups: [
      { title: "Lösch-Knöpfe zugeklappt", items: [
          "„Alle Bestellungen entfernen“ und „Essensbestellung löschen“ stecken jetzt hinter <b>„Löschen und zurücksetzen“</b>. Zugeklappt kann man sie nicht im Vorbeiscrollen erwischen – beide fragen weiterhin zusätzlich nach."
      ]}
    ]
  },
  {
    version: "4.7",
    groups: [
      { title: "Statistik weiter nach unten", items: [
          "Der Statistik-Kasten stand zwischen der Bestellliste und der Sammelbestellung im Weg. Er steht jetzt ganz unten, direkt über den Lösch-Knöpfen – zum Nachschauen, nicht zum Arbeiten."
      ]}
    ]
  },
  {
    version: "4.6",
    groups: [
      { title: "Discord-Nachricht mit Uhrzeiten", items: [
          "Unter der Essensliste steht jetzt <b>„Bestellt: 04.09., 12:31“</b> und <b>„Da seit: 04.09., 13:32“</b> – wann bestellt wurde und wann das Essen angekommen ist.",
          "Wer zweimal bestellt hat, sieht die <b>frühere</b> Zeit: er wartet ja seit dem ersten Mal.",
          "In der Liste steht jetzt auch die Bestellnummer: „1x Nr. 13 Salami“. Danach fragt man vorn an der Ausgabe."
      ]}
    ]
  },
  {
    version: "4.5",
    groups: [
      { title: "Speisekarte: Bestellnummern, Suche, Gruppen zum Aufklappen", items: [
          "Jedes Gericht kann jetzt die <b>Bestellnummer</b> der Karte des Lieferanten tragen („12“, „14a“). Sie steht vorn in der Zeile – und in der E-Mail: „1x Nr. 13 Salami à 9,50 €“. Beim Lieferanten wird nach der Nummer bestellt.",
          "Über der Karte ist ein <b>Suchfeld</b>. Es sucht in Nummer, Name, Zutaten und Kategorie; mehrere Wörter müssen alle vorkommen, „pizza sala“ findet „Pizza Salami“.",
          "Die Kategorien (Pizza, Nudeln, Beilagen …) sind <b>zugeklappt</b>, wenn es mehr als eine gibt. Bei einer Suche gehen alle Treffergruppen von allein auf.",
          "Der Import versteht die Nummer vorn: <i>12 | Margherita | Tomate, Käse | 8,50</i>. Ein Gericht, das mit einer Zahl anfängt – „4 Käse Brot“ – bleibt ein Name. Die Vorschau sagt vorher, wie viele Nummern erkannt wurden.",
          "Die Nummer wird wie Name und Preis auf der Bestellung festgeschrieben. Ändert der Lieferant seine Karte, stimmt der alte Beleg trotzdem weiter."
      ]}
    ]
  },
  {
    version: "4.4",
    groups: [
      { title: "Verwaltungs-Kästen zum Aufklappen", items: [
          "<b>Speisekarte</b>, <b>Speisekarte importieren</b> und <b>Einstellungen</b> sind jetzt zugeklappt. Die richtet man einmal ein; danach standen sie nur noch zwischen der Bestellliste und dem, was am Abend gebraucht wird.",
          "In der zugeklappten Zeile steht das Wichtigste: wie viele Gerichte auf der Karte stehen, und ob die Bestellannahme gerade offen ist.",
          "Was du aufklappst, bleibt offen – bis zum nächsten Neuladen."
      ]}
    ]
  },
  {
    version: "4.3",
    groups: [
      { title: "Neuer Tag, ohne etwas zu verlieren", items: [
          "Unter „Einstellungen“ steht jetzt ganz oben das Feld <b>Tag</b>. Trag dort „Freitag“ ein, wenn der nächste Tag beginnt – bis jetzt ließ sich der Name gar nicht ändern.",
          "Die Zählung der Sammelbestellungen fängt dann wieder bei 1 an: „Freitag 1“, „Freitag 2“ … Alles vom Vortag bleibt stehen und behält seinen Namen („Donnerstag 1“ heißt weiter so).",
          "Speisekarte, Lieferant und Zeiten bleiben ebenfalls. Es geht nichts verloren – im Gegensatz zu „alles löschen“.",
          "Unter dem Feld steht sofort, wie die nächste Sammelbestellung heißen wird und wie viele es an diesem Tag schon gab."
      ]}
    ]
  },
  {
    version: "4.2",
    groups: [
      { title: "Rückweg nach einem Fehlklick", items: [
          "In einer Lieferung gibt es jetzt einen Schritt zurück: <b>„↺ doch nicht abgeholt“</b> und <b>„↺ doch nicht bezahlt“</b>. Die Bestellung bleibt dabei in der Lieferung – vorher gab es dort nur „↩ herausnehmen“, und das riss sie ganz aus der Sammelbestellung.",
          "Auch für die ganze Lieferung: hat man „Alle abgeholt“ zu früh gedrückt, setzt ein Klick alle wieder auf „beim Lieferanten bestellt“.",
          "Die Knöpfe sagen jetzt, was sie tun, statt nur „zurück“ – bei einem Orga-Essen heißt es entsprechend „doch nicht freigegeben“.",
          "Wird jemand auf „doch nicht bezahlt“ zurückgesetzt, taucht sein Betrag sofort wieder unter „Noch zu kassieren“ auf."
      ]}
    ]
  },
  {
    version: "4.1",
    groups: [
      { title: "Bescheid geben: Uhrzeit dabei, und keine Nachricht an Abgeholte", items: [
          "An jeder Lieferung steht jetzt <b>„📣 Bescheid gegeben: 04.09., 12:47 · 2 erreicht“</b>. Die Zeit steht in der Datenbank und ist auch nach dem Neuladen noch da – vorher war nach einem Neuladen nicht mehr zu sehen, ob überhaupt schon jemand benachrichtigt wurde.",
          "Wer sein Essen schon geholt hat, bekommt <b>keine zweite Nachricht</b> mehr. Vorher ging beim erneuten Klick alles noch einmal an alle.",
          "Vor dem Verschicken steht in der Rückfrage, wer ausgelassen wird und warum – und danach noch einmal im Ergebnis.",
          "Der Knopf heißt beim zweiten Mal „Nochmal Bescheid“."
      ]}
    ]
  },
  {
    version: "4.0",
    groups: [
      { title: "Essen: Lieferungen starten zugeklappt", items: [
          "Nach dem Neuladen sind alle Sammelbestellungen zu. Vorher sprang jede noch nicht abgeholte von allein auf – bei mehreren Lieferungen am Abend war das eine Bildschirmlänge zum Durchscrollen.",
          "Damit man trotzdem sieht, worauf es ankommt, steht Datum und Uhrzeit jetzt schon in der zugeklappten Zeile – neben „0/2 abgeholt“ und dem Betrag.",
          "Was du aufklappst, bleibt offen, auch wenn nebenbei jemand bestellt."
      ]},
      { title: "Datum und Uhrzeit größer", items: [
          "„Rausgeschickt: 04.09., 12:27“ und „Bestellt: …“ waren sehr klein. Sie sind jetzt so groß wie der übrige Text, die Zeitangabe selbst hervorgehoben."
      ]}
    ]
  },
  {
    version: "3.9",
    groups: [
      { title: "Discord-Nachricht sagt jetzt auch, was man bestellt hat", items: [
          "Bisher stand nur „Dein Essen ist da (Donnerstag 2)“. Jetzt steht darunter, was für einen dabei ist – zum Beispiel „1x Salami (Extra Käse)“ und „2x Pommes“.",
          "Jede:r bekommt nur die eigenen Zeilen. Was die anderen essen, geht niemanden etwas an.",
          "Wer zwei Bestellungen in derselben Lieferung hat, bekommt weiter genau eine Nachricht – mit allen seinen Zeilen darin.",
          "Der Text wird weiterhin auf dem Server gebaut, nicht in der App. Gerichtnamen und Sonderwünsche werden dabei gekürzt und von Zeilenumbrüchen, Erwähnungen und Formatierung befreit."
      ]}
    ]
  },
  {
    version: "3.8",
    groups: [
      { title: "Essen: die nächste Sammelbestellung geht sofort", items: [
          "Beim Nachlesen einer schon verschickten Sammelbestellung steht jetzt darunter, wie viele Bestellungen im Stapel warten – mit einem Knopf direkt in die nächste. Vorher war der Weg dorthin nur der kleine Link ganz oben im Kasten.",
          "Dabei steht auch, dass die vorige dafür nicht geliefert sein muss. Es konnte schon immer eine zweite raus, man sah es nur nicht.",
          "Liegt im Stapel nur Unbezahltes, hieß es „keine Bestellung“. Jetzt steht dort, wie viele unbezahlte warten und dass „auch unbezahlte“ sie mitnimmt."
      ]}
    ]
  },
  {
    version: "3.7",
    groups: [
      { title: "QR-Code zum Scannen", items: [
          "Rechts in der Reiterleiste gibt es einen Knopf mit einem QR-Symbol. Er zeigt einen großen QR-Code, der auf genau diese Seite führt – zum Hinhalten, damit andere ihn mit der Handy-Kamera scannen können.",
          "Darunter steht die Adresse im Klartext. Geht der Code mal nicht (schlechtes Licht, alte Kamera), tippt man sie eben ab.",
          "Der Knopf ist für alle da, nicht nur für Veranstalter – so kann jede:r einem Kumpel die Seite zeigen."
      ]}
    ]
  },
  {
    version: "3.6",
    groups: [
      { title: "Essen: Statistik zum Aufklappen", items: [
          "Über der Sammelbestellung gibt es einen zugeklappten Kasten <b>📊 Statistik</b>. Er zeigt, wer die meisten Bestellungen aufgegeben hat – mit Platz, Balken, Anzahl der Bestellungen, Stückzahl und Warenwert.",
          "Darunter dieselbe Liste für die Gerichte: was am häufigsten bestellt wurde.",
          "Gleiche Zahl heißt gleicher Platz. Wer zur Organisation gehört, bekommt ein 🛠 an den Namen.",
          "Die Beträge sind der Warenwert, nicht das kassierte Geld – Orga-Essen zählt mit. Steht auch so darunter."
      ]}
    ]
  },
  {
    version: "3.5",
    groups: [
      { title: "Essen: Bestellungen ohne Sammelbestellung stehen jetzt richtig", items: [
          "Bestellungen aus der Zeit vor den Sammelbestellungen standen unter „Stapel – noch nicht rausgeschickt“, obwohl daneben „bestellt“ stand. Sie haben jetzt einen eigenen Abschnitt <b>„Ohne Sammelbestellung“</b>.",
          "Ein Knopf trägt sie als eigene Sammelbestellung nach – danach sind sie wie alle anderen abzurechnen. Wer sie nur abhaken will, kann das weiter tun.",
          "Beim Nachtragen bleibt der Stand stehen: aus „abgeholt“ wird nicht wieder „bestellt“."
      ]}
    ]
  },
  {
    version: "3.4",
    groups: [
      { title: "Essen ist da – alle auf einen Klick benachrichtigen", items: [
          "Bei jeder Sammelbestellung gibt es den Knopf <b>📣 Bescheid geben</b>. Er schreibt allen Bestellern dieser Lieferung per Discord, dass ihr Essen vorne bereitliegt.",
          "Danach steht dort, <b>wer nicht erreicht wurde und warum</b> – keine Discord-ID hinterlegt, Direktnachrichten gesperrt, kein Konto mit dem Namen. Diesen Leuten muss man selbst Bescheid sagen.",
          "Der Knopf ändert keinen Stand und darf mehrfach gedrückt werden – falls jemand beim ersten Mal nicht reagiert.",
          "Wer zweimal in derselben Lieferung bestellt hat, bekommt trotzdem nur eine Nachricht."
      ]},
      { title: "Unter der Haube", items: [
          "Die App schickt nur die <b>Namen</b> an den Server, nie die Discord-IDs – nachgeschlagen wird dort. Die IDs verlassen den Server nicht.",
          "Verschickt wird nacheinander statt alles auf einmal, weil Discord beim Massenversand bremst. Höchstens 60 Leute je Durchgang."
      ]}
    ]
  },
  {
    version: "3.3",
    groups: [
      { title: "Essen: jede Sammelbestellung für sich", items: [
          "Geht eine Bestellung an den Lieferanten raus, wird daraus eine eigene Sammelbestellung mit Namen und Nummer – „Donnerstag 1“, „Donnerstag 2“, und am nächsten Tag „Freitag 1“. An einem Tag können beliebig viele rausgehen, zu verschiedenen Uhrzeiten.",
          "Die Veranstalter-Liste ist danach zweigeteilt: oben der Stapel, der noch nicht raus ist, darunter jede verschickte Sammelbestellung mit den Bestellungen, die wirklich in dieser Mail standen.",
          "Jede Sammelbestellung rechnet für sich ab: was für diese Lieferung zu zahlen ist, was davon auf die Organisation geht und was noch zu kassieren ist.",
          "Ein Knopf schaltet eine ganze Lieferung auf „abgeholt“, wenn das Essen da ist und alle es geholt haben. Einzeln geht es weiter wie bisher.",
          "Der Mailtext einer schon verschickten Sammelbestellung lässt sich jederzeit wieder aufrufen – zum Nachlesen oder zum Nachschicken.",
          "Eine Bestellung, die schon in einer Mail steht, kann nicht in eine zweite rutschen. Wer sie hinter „bestellt“ zurücksetzt, holt sie aus der Sammelbestellung heraus und kann sie neu mitschicken.",
          "Nummern werden nie zweimal vergeben, auch wenn eine Sammelbestellung wieder leer wird."
      ]},
      { title: "Bleibt, wo man war", items: [
          "Nach dem Neuladen öffnet die App wieder den Bereich, in dem man zuletzt war, und springt nicht mehr aufs Turnier zurück."
      ]}
    ]
  },
  {
    version: "3.2",
    groups: [
      { title: "Bestellzeiten: ein Fenster, in dem bestellt werden kann", items: [
          "Unter „Einstellungen“ im Essen-Reiter lassen sich zwei Uhrzeiten setzen – zum Beispiel 10:00 bis 21:00. Außerhalb davon nimmt die App keine Bestellungen mehr an, ganz von allein.",
          "Ein Fenster über Mitternacht geht auch, etwa 18:00 bis 02:00. Beide Felder leer heißt: rund um die Uhr.",
          "Oben steht immer, woran man ist: „offen, heute bis 21:00 Uhr“ oder „Bestellt werden kann nur zwischen 10:00–21:00 Uhr“. Der Schalter „Bestellannahme ist offen“ bleibt daneben der Griff für zwischendurch."
      ]},
      { title: "E-Mail an den Lieferanten: Preise und Orga-Anteil je Gericht", items: [
          "Hinter jedem Gericht steht wieder der Stückpreis und die Zeilensumme: „5x Salami à 10,00 € = 50,00 €“.",
          "Sind welche davon für die Organisation, steht es an genau dieser Zeile: „davon 1x für die Organisation, zu zahlen 40,00 €“. Der Lieferant muss nicht selbst suchen, welche der fünf Pizzen gemeint sind.",
          "Unten die Zeile „Zu zahlen“ – der Betrag, der wirklich fällig wird, nicht der Warenwert.",
          "Statt zwei getrennter Blöcke steht wieder eine einzige Liste. Die Küche macht fünf Salami, egal wer sie bezahlt."
      ]},
      { title: "Übersicht über der E-Mail", items: [
          "Rechts an jeder Zeile steht jetzt, was zu zahlen ist – bei einem reinen Orga-Essen also 0,00 € statt des Warenwerts. Vorher stand dort ein Betrag, den niemand bringt.",
          "Der Warenwert steht weiter darunter, mit dem Anteil der Organisation."
      ]}
    ]
  },
  {
    version: "3.1",
    groups: [
      { title: "Bestellungen einzeln abwickeln", items: [
          "Neben jeder einzelnen Bestellung steht jetzt „✉ nur diese“. Damit geht genau diese eine an den Lieferanten, statt auf eine Sammelbestellung zu warten – auf der LAN kommt nicht jeder gleichzeitig, und wer um 18 Uhr bezahlt, soll sein Essen nicht erst um 20 Uhr bestellt bekommen.",
          "Der E-Mail-Kasten zeigt dann „Nur die Bestellung von …“ und schaltet danach genau diese eine auf „beim Lieferanten bestellt“ – die anderen bleiben unberührt.",
          "Ein Klick auf „← alle zusammen“ führt zurück zur Sammelbestellung. Die bleibt der Normalfall und ist unverändert.",
          "Mehrere Bestellungen von derselben Person gab es schon immer: abgeschickte wandern unter „Deine Bestellungen“, und der Zettel darüber ist sofort wieder frei für die nächste."
      ]}
    ]
  },
  {
    version: "3.0",
    groups: [
      { title: "Neu: Bescheid per Discord, wenn das Essen da ist", items: [
          "Unter „Mein Konto“ – oben in der Kopfzeile auf den eigenen Namen tippen – lässt sich die eigene Discord-Benutzer-ID hinterlegen. Der AgeLan-Bot schickt dann eine Direktnachricht, sobald das Essen zum Abholen bereitliegt.",
          "Freiwillig, kein Pflichtfeld. Wer die ID gerade nicht findet, bestellt trotzdem ganz normal und fragt eben selbst nach.",
          "Gemeint ist <b>nicht der Discord-Name</b>, sondern eine lange Zahl. Die App prüft das Format (17 bis 20 Ziffern) und zeigt die Klickfolge zum Finden gleich zum Aufklappen mit an.",
          "Knopf „Testnachricht schicken“: Eine falsche, aber gültig aussehende Zahl ginge an eine wildfremde Person oder ins Leere – ohne dass es irgendwer merkt. Der Test macht aus dem stillen Fehler einen sichtbaren.",
          "Wer noch keine ID hinterlegt hat, sieht einen gelben Punkt an seinem Namen in der Kopfzeile."
      ]},
      { title: "Für den Veranstalter", items: [
          "Die Konten-Liste unter „Einstellungen“ nennt jetzt oben namentlich, wer noch keine Discord-ID hinterlegt hat. Diese Leute bekommen keine Nachricht und müssen anders erreicht werden.",
          "Die ID selbst steht dort bewusst nicht – nur, ob eine hinterlegt ist."
      ]},
      { title: "Kleinkram", items: [
          "Der Datenschutz-Hinweis im Vorraum sagt jetzt auch, dass die Discord-ID gespeichert wird, wofür sie an Discord geht und wie man sie wieder loswürde. Die Essensbestellungen fehlten dort ebenfalls noch."
      ]}
    ]
  },
  {
    version: "2.9",
    groups: [
      { title: "Keine Beträge mehr in der Bestell-E-Mail", items: [
          "Der Brief an den Lieferanten nennt nur noch Mengen und Sonderwünsche. Was die Organisation isst, wird nicht bezahlt – eine Summe daneben hätte eine Forderung behauptet, die es gar nicht gibt.",
          "Was wer zahlt, steht weiter in der App: in der Übersicht über der E-Mail und bei jeder einzelnen Bestellung."
      ]}
    ]
  },
  {
    version: "2.8",
    groups: [
      { title: "Organisation: eigenes Merkmal am Konto", items: [
          "Wer zur Organisation gehört, bekommt im Reiter „Einstellungen“ ein Häkchen 🛠. Damit hat die Person alle Rechte – wie ein Veranstalter, nur ohne dass das Veranstalter-Passwort weitergegeben werden muss.",
          "Veranstalter gehören immer zur Organisation, bei ihnen ist das Häkchen fest gesetzt.",
          "Das Merkmal steht im signierten Anmelde-Token und wird bei jedem Start frisch geprüft: ein entzogenes Recht wirkt sofort, nicht erst in 120 Tagen."
      ]},
      { title: "Essen: die Organisation zahlt nichts", items: [
          "Bestellungen von Leuten aus der Organisation sind kostenlos. Statt eines Betrags steht dort „kostenlos“, und der Schritt „Hat bezahlt“ heißt bei ihnen „Freigeben“.",
          "Der Veranstalter sieht getrennt, was noch zu kassieren ist und was auf die Organisation geht.",
          "In der E-Mail an den Lieferanten stehen zwei Blöcke: die Teilnehmer-Bestellungen und darunter die der Organisation, mit dem Zusatz, dass die Teilnehmer die nicht mitbezahlen. Dazu die Summen einzeln und zusammen.",
          "Jede einzelne Bestellung lässt sich vom Veranstalter auf Orga umstellen oder wieder zahlungspflichtig machen – für den Fall, dass sich jemand vertan hat."
      ]}
    ]
  },
  {
    version: "2.7",
    groups: [
      { title: "Neu: Essensbestellung", items: [
          "Fünfter Bereich neben Turnier, Stream und Frühstück – für das warme Essen vom Lieferanten. Der Weg ist der, den es vorne am Tisch auch gibt: zusammenstellen, bezahlen, wir bestellen, du holst ab.",
          "Zu jedem Gericht lässt sich ein eigener Sonderwunsch schreiben („Pommes mit Spezialsoße“). Dasselbe Gericht darf zweimal auf der Bestellung stehen, einmal mit und einmal ohne – für die Küche sind das zwei verschiedene Dinge.",
          "Jede Bestellung hat einen Stand, den alle Beteiligten sehen: noch nicht bezahlt, bezahlt, beim Lieferanten bestellt, abgeholt.",
          "Ändern und stornieren geht, solange nicht bezahlt ist. Danach ist die Bestellung fest – sonst wäre der kassierte Betrag ein anderer als der bestellte."
      ]},
      { title: "Für den Veranstalter", items: [
          "Speisekarte importieren: eine ganze Karte auf einmal einfügen statt vierzig Gerichte einzeln anzulegen. Ein Gericht je Zeile, Felder mit „|“ getrennt, eine Zeile mit „#“ beginnt eine Kategorie. Vor dem Übernehmen steht eine Vorschau – wahlweise anhängen oder die alte Karte ersetzen.",
          "Sammelbestellung auf Knopfdruck: Die App zählt gleiche Gerichte zusammen, schreibt den fertigen E-Mail-Text und öffnet damit das Mailprogramm. Der Text lässt sich vorher noch ändern oder in die Zwischenablage kopieren.",
          "In der E-Mail stehen bewusst keine Namen der Besteller – der Lieferant braucht Mengen und Sonderwünsche, sonst nichts.",
          "Ist die Mail raus, setzt ein Klick alle mitgeschickten Bestellungen auf „beim Lieferanten bestellt“.",
          "Die Bestellannahme lässt sich schließen, solange eine Sammelbestellung unterwegs ist.",
          "Preise werden mit der Bestellung festgeschrieben. Wer für 8,50 € bestellt hat, zahlt 8,50 €, auch wenn die Karte danach anders aussieht. Ein Gericht von der Karte zu nehmen lässt bestehende Bestellungen unangetastet."
      ]},
      { title: "Handy", items: [
          "Mit dem fünften Reiter passte die Leiste auf schmalen Geräten nicht mehr in eine Zeile. Statt die Seite seitlich wegschiebbar zu machen, bricht die Leiste jetzt um."
      ]}
    ]
  },
  {
    version: "2.6",
    groups: [
      { title: "Die Änderungsliste ist wieder sichtbar", items: [
          "Mit dem Info-Reiter verschwand auch diese Liste. Gepflegt wurde sie weiter – sehen konnte sie seitdem niemand. Sie steht jetzt unten im Reiter „Einstellungen“, zugeklappt.",
          "Kleiner Anzeigefehler nebenbei: im Eintrag zur Streamer-Freigabe stand statt der Kamera 🎥 ein Zeichenfehler."
      ]},
      { title: "Handy: die Reiterleiste passt wieder auf den Schirm", items: [
          "Mit dem vierten Reiter „Einstellungen“ war die Leiste breiter als ein iPhone – dadurch ließ sich die ganze Seite seitlich wegschieben. Betraf nur Veranstalter, weil nur die den vierten Reiter sehen.",
          "Auf schmalen Geräten sind die Reiter jetzt etwas enger gesetzt, alle vier sind ohne Wischen erreichbar."
      ]}
    ]
  },
  {
    version: "2.5",
    groups: [
      { title: "Streamplan: Termine sitzen mittig in ihrer Spalte", items: [
          "Die Blöcke klebten am linken Rand ihrer Spalte – gemessen 1 Pixel Luft links gegen 5 rechts. Jetzt sind es auf beiden Seiten gleich viel.",
          "Betrifft auch nebeneinanderliegende Streams: jede Spur ist für sich mittig."
      ]}
    ]
  },
  {
    version: "2.4",
    groups: [
      { title: "Streamplan: der Termin klebt jetzt an der Maus", items: [
          "Beim Anfassen sprang ein Termin nach oben weg, danach lief er dauerhaft über dem Mauszeiger – Positionieren war Glückssache.",
          "Ursache war ein falscher Nullpunkt: gezeichnet wird ab dem Beginn der Zeitleiste, verschoben wurde ab dem Beginn des Tages. Beginnt ein Tag später als die Leiste, klaffen die beiden auseinander."
      ]}
    ]
  },
  {
    version: "2.3",
    groups: [
      { title: "Streamplan: Ziehen ist jetzt genau", items: [
          "Beim Verschieben rastet ein Termin auf 5 Minuten statt auf eine Viertelstunde. Vorher sprang ein Zug um 25 Minuten auf 30 – das fühlte sich an, als folge der Block der Maus nicht.",
          "Die Auswahllisten in den Dialogen bleiben bei Viertelstunden, dort wären 5-Minuten-Schritte nur eine endlose Liste."
      ]}
    ]
  },
  {
    version: "2.2",
    groups: [
      { title: "Turnier anlegen: das Konto reicht", items: [
          "Wer als Veranstalter angemeldet ist, sieht das Formular sofort – ohne das Veranstalter-Passwort noch einmal einzugeben.",
          "Der Passwortkasten ist für dich damit weg. Für alle anderen steht dort nur noch ein Hinweis, dahinter zugeklappt ein Notweg über das Passwort."
      ]}
    ]
  },
  {
    version: "2.1",
    groups: [
      { title: "Streamplan: Termine verschieben und besser unterscheiden", items: [
          "Termine lassen sich mit der Maus greifen und nach oben oder unten ziehen. Beim Ziehen siehst du die neue Uhrzeit sofort; losgelassen wird auf volle Viertelstunden gerundet.",
          "Am Handy geht das bewusst NICHT – sonst könntest du über dem Kalender nicht mehr scrollen. Dort bleibt der Weg über den Dialog.",
          "Termine, die direkt aneinander anschließen, verschmolzen bisher optisch zu einem Block. Jeder zweite ist jetzt dunkler und hat eine helle Trennlinie."
      ]}
    ]
  },
  {
    version: "2.0",
    groups: [
      { title: "Streamplan: eintragen nur mit Freigabe", items: [
          "In den Einstellungen hat jetzt jedes Konto ein Häkchen 🎥. Wer es hat, darf sich in den Streamplan eintragen und seine Einträge ändern.",
          "Alle anderen sehen den Plan weiterhin vollständig – sie können ihn nur nicht mehr verändern. Der Knopf zum Eintragen ist für sie weg.",
          "Veranstalter dürfen immer, ihr Häkchen ist deshalb fest gesetzt."
      ]}
    ]
  },
  {
    version: "1.9",
    groups: [
      { title: "Einstellungen: wer hat ein Konto?", items: [
          "Neuer Reiter „Einstellungen“ ganz rechts – nur für Veranstalter sichtbar.",
          "Dort stehen alle angemeldeten Nutzer mit Datum. Ein ⭐ markiert die Veranstalter, „(du)“ dein eigenes Konto.",
          "Einzelne Konten lassen sich löschen; bereits abgegebene Bestellungen bleiben davon unberührt.",
          "„Alle Konten löschen“ macht den Schnitt nach der Veranstaltung – danach legt jede:r für die nächste AgeLan ein neues an."
      ]}
    ]
  },
  {
    version: "1.8",
    groups: [
      { title: "Das Logo der AgeLan", items: [
          "Auf der Startseite steht jetzt das Banner „AGE LAN #3“ statt des Pokal-Symbols.",
          "Oben links in der Kopfzeile sitzt das Wappen daraus – der Schriftzug wäre dort zu klein zum Lesen."
      ]},
      { title: "Kein Namensfeld mehr beim Frühstück", items: [
          "Du bist angemeldet, also steht dein Name fest. Über den Paketen steht jetzt „Bestellung für <dein Name>“ statt eines Eingabefelds.",
          "Damit kann niemand mehr versehentlich unter einem anderen Namen bestellen – und die Abrechnung bleibt eindeutig."
      ]}
    ]
  },
  {
    version: "1.7",
    groups: [
      { title: "Veranstalter ist jetzt das Konto, nicht das Gerät", items: [
          "Beim Anlegen des Kontos kann der Veranstalter zusätzlich sein Veranstalter-Passwort eintragen. Alle anderen lassen das Feld leer.",
          "Danach bist du auf JEDEM Gerät Veranstalter, sobald du dich anmeldest – am Handy genauso wie am Rechner.",
          "Kein PIN-Eintippen mehr, und ein gelöschter Browser-Speicher kostet dich nicht mehr die Rechte.",
          "Oben rechts steht ein ⭐ vor deinem Namen, wenn du als Veranstalter angemeldet bist.",
          "Die PINs der einzelnen Turniere funktionieren unverändert weiter – für alle, die kein Veranstalter-Konto haben."
      ]}
    ]
  },
  {
    version: "1.6",
    groups: [
      { title: "Jeder hat jetzt sein eigenes Konto", items: [
          "Statt eines Passworts für alle legst du dir einmal ein Konto an: dein Name und ein Passwort, das nur du kennst.",
          "Zum Anlegen brauchst du einmalig das Passwort der Veranstaltung von Michel. Danach nie wieder – ab dann reichen Name und dein eigenes Passwort.",
          "Oben rechts steht, mit welchem Namen du angemeldet bist.",
          "Dein Name steht damit überall automatisch: beim Einschreiben ins Turnier, beim Streamplan und beim Frühstück. Kein Tippen mehr, und die Frühstücks-Abrechnung stimmt.",
          "Die Anmeldung bleibt auf deinem Gerät bestehen – auch nach dem Schließen des Browsers.",
          "Dein Passwort wird verschlüsselt gespeichert und lässt sich nicht auslesen, auch nicht von Michel."
      ]},
      { title: "Kein Vereinslogo mehr", items: [
          "Oben rechts hing das Wappen des SC 1911 Heiligenstadt. Die AgeLan ist eine private Veranstaltung – das Wappen ist raus."
      ]}
    ]
  },
  {
    version: "1.5",
    groups: [
      { title: "Frühstück: Abrechnung", items: [
          "Neue Abrechnung für den Veranstalter: je Person steht dort, was sie über alle Morgen bestellt hat und was sie zahlen muss.",
          "Aufklappen zeigt jeden Morgen einzeln mit Positionen und Preis – ein Haken je Zeile markiert „bezahlt“.",
          "Unten steht, wie viel insgesamt noch offen ist und wie viel es insgesamt war.",
          "Auch in der Bestellliste je Morgen stehen jetzt die Preise: je Position und als Summe pro Person.",
          "Die Liste ist alphabetisch sortiert und bleibt beim Abhaken stehen, statt umzuspringen."
      ]},
      { title: "Behobene Fehler", items: [
          "Wer schon bestellt hatte und die Seite neu lud, sah unter Umständen lauter Nullen statt seiner Bestellung. Ein Klick auf „Bestellung aktualisieren“ hätte sie dann gelöscht. Die Anzeige zieht jetzt nach – aber nur, solange du nicht selbst gerade etwas eingegeben hast.",
          "Der Haken „bezahlt“ und „abgeholt“ bleibt stehen, auch wenn der Besteller seine Bestellung danach noch ändert.",
          "Im Veranstalter-Bereich hieß das Feld noch „Anzahl Morgen“ – jetzt „Wie viele Tage?“, wie beim Anlegen."
      ]}
    ]
  },
  {
    version: "1.4",
    groups: [
      { title: "„AgeLan“ oben führt zurück zur Übersicht", items: [
          "Ein Tipp auf „🏆 AgeLan“ in der Kopfzeile bringt dich jederzeit zurück auf die Übersicht mit den drei Kacheln.",
          "Von dort geht es mit einem Tipp weiter – ohne dass du das Passwort noch einmal eingeben musst.",
          "Die Schlösser auf den Kacheln verschwinden, sobald der Zugang auf deinem Gerät frei ist. Sie würden sonst eine Sperre behaupten, die es nicht mehr gibt.",
          "Mit der Escape-Taste geht die Übersicht wieder zu."
      ]}
    ]
  },
  {
    version: "1.3",
    groups: [
      { title: "Turniere jetzt als Kacheln wie auf der Startseite", items: [
          "Jedes Turnier hat ein Symbol, das den Stand zeigt: 📝 Anmeldung läuft, ⚔️ Spiele laufen, 🏅 beendet.",
          "Name, Format und Stand stehen untereinander, „Einschreiben“ steht rechts daneben – am Handy darunter, damit der Name nicht mitten im Wort umbricht.",
          "Gleicher Aufbau wie die Kacheln auf der Startseite: Symbol links, Text in der Mitte, Handlung rechts."
      ]},
      { title: "Frühstück: klarer, über wie viele Tage bestellt wird", items: [
          "Das Feld hieß „Morgen“ und ließ sich als „morgen“ lesen. Jetzt heißt es „Wie viele Tage?“.",
          "Darunter steht sofort, welche Tage dabei herauskommen – etwa „Frühstück gibt es an 3 Morgen: Fr 4.9., Sa 5.9., So 6.9.“."
      ]}
    ]
  },
  {
    version: "1.2",
    groups: [
      { title: "Startseite offen, Passwort erst beim Öffnen", items: [
          "Die Seite beginnt jetzt mit einer Übersicht, die für alle offen ist: Turnier, Stream und Frühstück stehen als Kacheln nebeneinander, jede mit einem Satz dazu.",
          "Das Passwort wird erst abgefragt, wenn du einen der drei Bereiche öffnest – vorher siehst du, was es überhaupt gibt.",
          "Nach der Eingabe geht genau der Bereich auf, den du angeklickt hast.",
          "Ein Passwort für alle drei Bereiche, wie bisher. Einmal eingegeben, bleibt der Zugang auf diesem Gerät bestehen.",
          "Es bleibt dabei: vor der Freigabe wird nichts aus der Datenbank geladen. Die Übersicht ist reine Anzeige."
      ]}
    ]
  },
  {
    version: "1.1",
    groups: [
      { title: "Neu: Frühstücksbestellung", items: [
          "Dritter Reiter „Frühstück“ neben Turnier und Stream: der Veranstalter legt Frühstückspakete mit Namen, Beschreibung und Preis an.",
          "Bestellt wird je Morgen bis zu einem festen Bestellschluss am Vorabend – danach ist der Morgen für alle außer dem Veranstalter geschlossen.",
          "Menge je Paket per Plus/Minus, dazu ein freiwilliges Notizfeld – etwa für „ohne Milch“.",
          "Eine Bestellung lässt sich bis zum Bestellschluss jederzeit ändern oder wieder stornieren.",
          "Der Veranstalter sieht je Morgen die Einkaufsliste (Summe je Paket) und eine Liste aller Bestellungen mit einem Haken zum Abhaken bei der Ausgabe.",
          "Gleiches Prinzip wie beim Streamplan: eigener PIN je Bestellung, überlebt Zurücksetzen und Löschen eines Turniers."
      ]}
    ]
  },
  {
    version: "1.0",
    groups: [
      { title: "Wo die Turnierdaten liegen", items: [
          "Die Turnierdaten laufen über die Echtzeit-Datenbank von Google (Firebase). Das Rechenzentrum steht in Belgien, betrieben wird es von Google — nicht in Deutschland.",
          "Gespeichert wird der Name, unter dem du dich einschreibst, deine Team-Zuordnung und die gemeldeten Ergebnisse.",
          "Wer seinen Namen nicht bei Google haben möchte, schreibt sich mit einem Spitznamen ein."
      ]},
      { title: "Die Seite", items: [
          "Turnier- und Streamplan der AgeLan in einem: der Reiter „Turnier“ für alle Turniere der Veranstaltung, der Reiter „Stream“ für den Sendeplan.",
          "Die Seite ist mit einem Passwort geschützt. Wer es nicht hat, kommt an nichts heran – die App-Dateien werden erst nach der Freigabe geladen.",
          "Das Passwort gibt es beim Veranstalter. Einmal eingegeben, bleibt der Zugang auf diesem Gerät bestehen.",
          "Geprüft wird es auf dem Server, nicht in der Seite – es steht nirgends im Quelltext.",
          "Alle Geräte sehen denselben Stand live."
      ]},
      { title: "Viele Turniere nebeneinander", items: [
          "Der Reiter „Turnier“ beginnt mit einer Liste aller Turniere – jedes mit Stand und Zahl der Angemeldeten.",
          "Einschreiben geht in jedes Turnier einzeln; wo du schon dabei bist, steht „Du bist dabei“.",
          "Über „← Alle Turniere“ oben wechselst du jederzeit zurück zur Liste.",
          "Jedes Turnier hat seinen eigenen Veranstalter-PIN.",
          "Jedes Turnier, das dir gehört, hat einen Papierkorb – Löschen geht ohne es vorher zu öffnen, und immer mit Rückfrage."
      ]},
      { title: "Erst anmelden, dann das Format", items: [
          "Ein neues Turnier braucht nur Name und PIN. Turnierform und Ablauf legst du später fest – für den Turniertag gedacht: erst wenn alle da sind, weißt du, wie viele mitspielen.",
          "Auf der Kachel steht solange „Format wird noch festgelegt“, damit sich niemand unter falschen Annahmen einschreibt. „Teams bilden“ geht erst, wenn das Format steht.",
          "Turnierform: 1 gegen 1, 2 gegen 2, 3 gegen 3 oder 4 gegen 4. Bei 1 gegen 1 entfällt die Teambildung, alle Angemeldeten gehen direkt in die Auslosung.",
          "Fünf Abläufe zur Wahl: Gruppenphase mit K.-o.-Runde, nur K.-o.-Runde, Jeder gegen jeden (Round Robin), Schweizer System mit Tabelle oder Schweizer System mit anschließender K.-o.-Runde.",
          "Beim Schweizer System spielst du in jeder Runde gegen jemanden mit ähnlicher Punktzahl – nie zweimal gegen dieselbe Person. Bei ungerader Zahl gibt es je Runde ein Freilos, und wer schon eins hatte, bekommt kein zweites.",
          "Neues Turnier anlegen darf nur, wer das Veranstalter-Passwort kennt – ein anderes als das für die Seite. Einschreiben, Ergebnisse melden und Zuschauen bleiben für alle offen.",
          "Der Veranstalter-Zugang lässt sich über „Veranstalter-Zugang auf diesem Gerät beenden“ wieder sperren."
      ]},
      { title: "Vorschau: was käme bei jedem Ablauf heraus?", items: [
          "In der Anmeldung stehen alle fünf Abläufe untereinander – jeder mit den Zahlen für genau die Zahl der Angemeldeten.",
          "Je Ablauf: wie viele Partien es gibt, über wie viele Runden, und wie oft jede:r drankommt.",
          "Dazu Hinweise, die die Wahl leichter machen: wie viele Gruppen entstünden, wie viele Freilose es gäbe, wie viele nach der ersten Runde schon fertig wären.",
          "Umschalten auf eine andere Turnierform oder auf Doppel-K.-o. rechnet die Vorschau sofort neu.",
          "Die Zahlen kommen aus derselben Rechnung wie die spätere Auslosung – was dort steht, passiert hinterher auch."
      ]},
      { title: "Auslosen und Wertung", items: [
          "Setzliste von Hand: vor dem Auslosen lässt sich die Reihenfolge mit den Pfeilen festlegen. Sie bestimmt, wer als stark gilt – wer in verschiedene Gruppen kommt und wer im Bracket erst spät aufeinandertrifft. Ohne Eingriff zählt das Rating; ein Klick stellt das wieder her.",
          "Punkte je Sieg frei einstellbar.",
          "Bei Punktgleichstand wählbar: Satzdifferenz, direktes Duell, Buchholz, Buchholz gestrichen (der schwächste Gegner fällt aus der Rechnung) oder Sonneborn-Berger (nur die Punkte der wirklich besiegten Gegner).",
          "Hin- und Rückrunde: jede Paarung zweimal, beim zweiten Mal mit getauschten Seiten.",
          "Spiel um Platz 3, und das Finale kann einen eigenen Modus haben – zum Beispiel Best of 5 statt Best of 3.",
          "Doppel-K.-o. bei jeder K.-o.-Runde zuschaltbar: wer einmal verliert, rutscht in den Verliererbaum, erst die zweite Niederlage bedeutet das Aus. Am Ende trifft der Sieger des Gewinnerbaums auf den des Verliererbaums.",
          "Dazu ankreuzbar: gewinnt im großen Finale der aus dem Verliererbaum, gibt es ein Entscheidungsspiel – er hatte schon eine Niederlage, der andere noch keine.",
          "Ligamodus mit Spieltagen bei Gruppen und Jeder gegen jeden: je Spieltag hat jedes Team höchstens ein Spiel, und der Veranstalter trägt je Spieltag ein Datum ein. Gut, wenn sich das Turnier über mehrere Tage zieht."
      ]},
      { title: "Während des Turniers", items: [
          "Ergebnisse eintragen, Tabellen und Bracket aktualisieren sich sofort auf allen Geräten.",
          "Ließ sich etwas nicht speichern, erscheint unten ein roter Balken mit dem Grund – bei abgelaufener Anmeldung mit dem Hinweis, die Seite neu zu laden. Kein Klick verpufft mehr stillschweigend.",
          "Zum Ausprobieren legt der Veranstalter in der Anmeldung Testspieler mit zufälligem Rating an und spielt den ganzen Ablauf allein durch; ein Klick entfernt sie wieder.",
          "Offene Spiele lassen sich auswürfeln – das stärkere Team gewinnt häufiger, aber nicht immer.",
          "Zurücksetzen verwirft Teams, Gruppen und Ergebnisse, alle Angemeldeten bleiben drin. Löschen entfernt das ganze Turnier. Beides steht als Veranstalter hinter dem Zahnrad oben rechts."
      ]},
      { title: "Streamkalender", items: [
          "Der Reiter „Stream“ zeigt einen Kalender über die Tage der Veranstaltung, in den sich die Streamer selbst eintragen.",
          "Eintragen heißt: Tag, Von, Bis, Name und wahlweise, was in der Zeit läuft. Der eigene Eintrag lässt sich jederzeit ändern oder wieder entfernen.",
          "Es sendet immer nur einer: überschneidet sich eine Zeit mit einer schon eingetragenen, nimmt der Plan sie nicht an und sagt, wer da schon dran ist.",
          "Am Handy zeigt der Kalender einen Tag, auf größeren Bildschirmen alle Tage nebeneinander.",
          "Zeiten nach Mitternacht gehören zum selben Veranstaltungstag und sind als „(Nacht)“ gekennzeichnet.",
          "Unter dem Kalender stehen Programm und Streams in einer gemeinsamen Zeitleiste, jeweils gekennzeichnet."
      ]},
      { title: "Programm und Veranstalter-Rechte im Streamplan", items: [
          "Jeder Tag hat zwei Spalten: links das Programm der AgeLan, rechts die Streams. So ist auf einen Blick zu sehen, worauf sich eine Streamzeit legt – etwa ob gerade die Gruppenphase läuft.",
          "Programmpunkte legt nur der Veranstalter an. Alle anderen sehen sie und können sie zum Nachlesen öffnen.",
          "Programm und Streams behindern sich nicht: ein Stream darf zeitgleich zu einem Turnier laufen, das ist ja der Zweck. Nur die Streams untereinander bleiben überschneidungsfrei; auch zwei Programmpunkte dürfen parallel liegen und stehen dann nebeneinander.",
          "Das Zeitfenster lässt sich für jeden Tag einzeln stellen – etwa ein Sonntag, an dem nur noch der Vormittag läuft.",
          "Fremde Einträge lassen sich korrigieren oder entfernen, ebenso alle Einträge auf einmal.",
          "Es gilt derselbe Veranstalter-PIN wie beim Turnier; beim Anlegen des Plans wird er übernommen.",
          "Der Streamplan hängt nicht am Turnier: Zurücksetzen und Löschen des Turniers lassen ihn unberührt, und es braucht kein Turnier, damit es ihn gibt."
      ]}
    ]
  }
];

// ⚠️ Der zuletzt geöffnete Bereich wird gemerkt. Ohne das landet jedes
// Neuladen wieder im Turnier – wer gerade Essen abrechnet, muss sich nach
// jedem F5 neu durchklicken. Das Gate liest den Wert beim Start aus, siehe
// index.html.
const AGELAN_TAB_KEY = "agelan_tab";

function activateTab(name) {
  document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-section").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
  // Der Streamkalender braucht mehr Breite als die 560 px der Turnier-Screens
  // (style.css: main#app.sk-breit { max-width: 980px }). Der Schalter steht
  // HIER und nicht am Klickhorcher der Reiterleiste, weil es zwei weitere Wege
  // in den Reiter gibt: den Vorraum (index.html oeffneBereich) und den
  // Rueckfall auf "turnier" bei Rechteverlust. Ueber den Klickhorcher blieb der
  // Kalender vom Vorraum aus 560 px schmal, und umgekehrt hing die Klasse nach
  // dem Rechteverlust am Turnier-Reiter fest.
  const app = document.getElementById("app");
  if (app) app.classList.toggle("sk-breit", name === "stream");
  try {
    localStorage.setItem(AGELAN_TAB_KEY, name);
  } catch (e) { /* privater Modus: dann startet es eben wieder im Turnier */ }
}

function renderVersionInfo() {
  document.querySelectorAll("#version-badge, #version-badge-2").forEach((el) => { if (el) el.textContent = "v" + APP_VERSION; });
  const box = document.getElementById("changelog-list");
  if (!box) return;
  box.innerHTML = APP_CHANGELOG.map((entry) => `
    <div class="changelog-entry">
      <div class="cv">Version ${entry.version}</div>
      ${entry.groups.map((g) => `
        <div class="cgt">${g.title}</div>
        <ul>${g.items.map((i) => `<li>${i}</li>`).join("")}</ul>`).join("")}
    </div>`).join("");
}


// ---------- Einstellungen: die angemeldeten Konten ----------
// Nur für Veranstalter. Der Nachweis ist das Anmelde-Token; der Worker prüft es
// gegen den KV-Bestand, ein entzogenes Recht wirkt also sofort.
const KONTEN_GATEWAY = "https://agelan.michel-brunner.workers.dev";

function kontenToken() {
  try {
    const k = window.__AGELAN_KONTO__;
    return (k && k.token) || "";
  } catch (e) {
    return "";
  }
}

async function kontenRufe(aktion, extra) {
  const antwort = await fetch(KONTEN_GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ action: aktion, token: kontenToken() }, extra || {})),
  });
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok || !daten.ok) throw new Error(daten.error || "HTTP " + antwort.status);
  return daten;
}

function kontenDatum(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.getDate() + "." + (d.getMonth() + 1) + "." + d.getFullYear();
}

async function ladeKonten() {
  const box = document.getElementById("konten-liste");
  const knopf = document.getElementById("btn-konten-laden");
  zeigeFehler("konten-fehler", "");
  knopf.disabled = true;
  knopf.textContent = "Lade …";
  try {
    const daten = await kontenRufe("konto-liste");
    const eigener = (window.__AGELAN_KONTO__ || {}).nickname;

    // ⚠️ Die Nachfassliste. Wer keine Discord-ID hinterlegt hat, bekommt
    // KEINE Nachricht, wenn sein Essen bereitliegt - und merkt das von selbst
    // nie. Ohne diesen Satz haelt der Veranstalter alle fuer informiert und
    // drei Leute holen ihr Essen nicht ab.
    const ohneId = daten.konten.filter((k) => !k.discord).map((k) => k.nickname);
    const fehlend = ohneId.length
      ? `<p class="konten-fehlend"><b>⚠️ ${ohneId.length} ohne Discord-ID:</b> ${escapeHtml(ohneId.join(", "))}<br>
         Diese Leute bekommen keine Nachricht, wenn ihr Essen da ist. Jede:r trägt sie selbst ein – oben auf den eigenen Namen tippen, dann „Mein Konto“.</p>`
      : "";

    box.innerHTML = daten.konten.length
      ? fehlend + `<p class="hinweis-text">${daten.konten.length} Konto${daten.konten.length === 1 ? "" : "en"}</p>` +
        daten.konten.map((k) => `
          <div class="konto-zeile">
            <span class="konto-name">${k.admin ? "⭐ " : (k.orga ? "🛠 " : "👤 ")}${escapeHtml(k.nickname)}${k.nickname === eigener ? " <span class=\"konto-du\">(du)</span>" : ""}</span>
            ${k.discord ? "" : `<span class="konto-kein-discord" title="Keine Discord-ID hinterlegt – bekommt keine Nachricht, wenn das Essen bereitliegt">💬❌</span>`}
            <label class="konto-streamer" title="Gehört zur Organisation: hat alle Rechte und zahlt beim Essen nichts">
              <input type="checkbox" data-konto-orga="${escapeHtml(k.nickname)}" ${k.orga || k.admin ? "checked" : ""} ${k.admin ? "disabled" : ""}>
              🛠
            </label>
            <label class="konto-streamer" title="Darf sich in den Streamplan eintragen">
              <input type="checkbox" data-konto-streamer="${escapeHtml(k.nickname)}" ${k.streamer || k.admin || k.orga ? "checked" : ""} ${k.admin || k.orga ? "disabled" : ""}>
              🎥
            </label>
            <span class="konto-datum">${kontenDatum(k.angelegtAm)}</span>
            <button type="button" class="mini-btn" data-konto-loeschen="${escapeHtml(k.nickname)}">🗑</button>
          </div>`).join("")
      : `<p class="hinweis-text">Noch niemand hat sich ein Konto angelegt.</p>`;

    // ⚠️ Nach dem Umstellen die ganze Liste neu holen, nicht nur den einen
    // Haken stehen lassen: „Orga" schaltet auch das Streamer-Haekchen fest und
    // aendert das Symbol vor dem Namen. Ohne Neuladen behauptet die Zeile
    // daneben etwas, das nicht mehr stimmt.
    box.querySelectorAll("[data-konto-orga]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        try {
          await kontenRufe("konto-orga", { nickname: cb.dataset.kontoOrga, orga: cb.checked });
          await ladeKonten();
        } catch (e) {
          cb.checked = !cb.checked;   // zurueckdrehen, sonst behauptet der Haken etwas Falsches
          zeigeFehler("konten-fehler", e.message);
        }
      });
    });

    box.querySelectorAll("[data-konto-streamer]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        try {
          await kontenRufe("konto-streamer", { nickname: cb.dataset.kontoStreamer, streamer: cb.checked });
          zeigeFehler("konten-fehler", "");
        } catch (e) {
          cb.checked = !cb.checked;   // zurueckdrehen, sonst behauptet der Haken etwas Falsches
          zeigeFehler("konten-fehler", e.message);
        }
      });
    });

    box.querySelectorAll("[data-konto-loeschen]").forEach((b) => {
      b.addEventListener("click", async () => {
        const name = b.dataset.kontoLoeschen;
        if (!confirm(`Konto „${name}" wirklich löschen? Die Person muss sich danach ein neues anlegen. Bereits abgegebene Bestellungen bleiben stehen.`)) return;
        try {
          await kontenRufe("konto-loeschen", { nickname: name });
          await ladeKonten();
        } catch (e) {
          zeigeFehler("konten-fehler", e.message);
        }
      });
    });
  } catch (e) {
    box.innerHTML = "";
    zeigeFehler("konten-fehler", e.message);
  } finally {
    knopf.disabled = false;
    knopf.textContent = "Liste neu laden";
  }
}

function setupEinstellungenTab() {
  const knopf = document.getElementById("btn-konten-laden");
  if (!knopf) return;
  knopf.addEventListener("click", ladeKonten);

  document.getElementById("btn-konten-leeren").addEventListener("click", async () => {
    if (!confirm("Wirklich ALLE Konten löschen? Auch dein eigenes – du musst dich danach neu anlegen. Das lässt sich nicht rückgängig machen.")) return;
    zeigeFehler("konten-leeren-fehler", "");
    try {
      const daten = await kontenRufe("konto-loeschen", { alle: true });
      zeigeFehler("konten-leeren-fehler", daten.geloescht + " Konten gelöscht. Lade die Seite neu.");
      document.getElementById("konten-liste").innerHTML = "";
    } catch (e) {
      zeigeFehler("konten-leeren-fehler", e.message);
    }
  });
}

// Der Tab erscheint nur für Veranstalter. ⚠️ Läuft auch nach dem Anmelden noch
// einmal, weil das Konto beim ersten Zeichnen der Tabs noch nicht feststeht.
function zeigeEinstellungenTab() {
  const knopf = document.getElementById("nav-einstellungen");
  if (!knopf) return;
  const darf = typeof kontoIstVeranstalter === "function" && kontoIstVeranstalter();
  knopf.hidden = !darf;
  // Steht man im Tab und verliert das Recht, gehört man dort nicht mehr hin.
  if (!darf && document.getElementById("tab-einstellungen").classList.contains("active")) {
    activateTab("turnier");
  }
}

function setupInfoTab() {
  setupEinstellungenTab();
  document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => {
    b.addEventListener("click", () => activateTab(b.dataset.tab));
  });
  if (!TURNIER_SICHTBAR) {
    const turnierKnopf = document.querySelector('nav.tabs button[data-tab="turnier"]');
    if (turnierKnopf) turnierKnopf.style.display = "none";
    document.getElementById("btn-admin-oeffnen").style.display = "none";
    activateTab("stream");
  }
  // Kam der Einstieg über eine Kachel des Vorraums, gehört die App genau dort
  // auf — sonst landet jemand, der auf „Frühstück" geklickt hat, im Turnier.
  // Das Gate setzt den Wert VOR dem Nachladen dieser Datei.
  const startTab = window.__AGELAN_START_TAB__;
  if (startTab && document.getElementById("tab-" + startTab)) {
    if (startTab !== "turnier" || TURNIER_SICHTBAR) activateTab(startTab);
  }
  zeigeEinstellungenTab();
  renderVersionInfo();
}

// Die Skripte werden vom Passwort-Gate erst nach der Freigabe nachgeladen –
// dann ist DOMContentLoaded längst durch und würde nie mehr feuern.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupInfoTab);
else setupInfoTab();
