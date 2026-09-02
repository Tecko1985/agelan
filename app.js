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
const AGELAN_GATEWAY = "https://landingpage.michel-brunner.workers.dev";
const VERANSTALTER_SCOPE = "agelan-veranstalter";
const VERANSTALTER_KEY = "agelan_veranstalter_ok";

function veranstalterFrei() {
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
      return `<div class="turnier-karte${t.binIchDrin ? " dabei" : ""}">
        <button class="tk-oeffnen" data-turnier="${escapeHtml(t.id)}">
          <span class="tk-name">${escapeHtml(t.name)}</span>
          <span class="tk-meta">${escapeHtml(art)}</span>
          <span class="tk-meta">${escapeHtml(phase)} · ${escapeHtml(zahl)}</span>
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
  // Sync-Status im Header
  const status = document.getElementById("sync-status");
  if (window.__AGELAN_MOCK__) {
    status.textContent = "● lokal (Test)";
    status.style.color = "#fde68a";
  } else {
    status.textContent = "● live";
  }
  wireEvents();
  turnierService.onZustandsAenderung(render);
})();

// ---------- Info-Tab / Versionshistorie ----------
const APP_VERSION = "1.0";
const APP_CHANGELOG = [
  {
    version: "1.0",
    groups: [
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

function activateTab(name) {
  document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-section").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
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

function setupInfoTab() {
  document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => {
    b.addEventListener("click", () => activateTab(b.dataset.tab));
  });
  if (!TURNIER_SICHTBAR) {
    const turnierKnopf = document.querySelector('nav.tabs button[data-tab="turnier"]');
    if (turnierKnopf) turnierKnopf.style.display = "none";
    document.getElementById("btn-admin-oeffnen").style.display = "none";
    activateTab("stream");
  }
  renderVersionInfo();
}

// Die Skripte werden vom Passwort-Gate erst nach der Freigabe nachgeladen –
// dann ist DOMContentLoaded längst durch und würde nie mehr feuern.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupInfoTab);
else setupInfoTab();
