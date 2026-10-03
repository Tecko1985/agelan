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
// „Nur zuschauen“ geklickt: bleibt in der Lobby. ⚠️ Nur per showScreen() sprang
// die nächste fremde Anmeldung über render() zurück auf den Startschirm
// (Bugjagd 25.09.d T5-8). Zurückgesetzt beim Turnierwechsel.
let willZuschauen = false;
let meldeSpielId = null;     // aktuell im Melde-Dialog bearbeitetes Spiel
let meldeAdminModus = false; // Melde-Dialog als Admin-Korrektur?
let losFelderInit = false;   // Auslosungs-Felder je Team-Phase einmal mit Vorschlag füllen

// --- Helfer ----------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Weisse Initiale darauf, alle >= 4,5 (Abnahme D 21.09.2026): Gold #8a6412 (#c9941f 2,71),
// Tuerkis #077f9c (#0891b2 3,68), Orange #ca4c0a (#ea580c 3,56).
const AVATAR_FARBEN = ["#1a56a0", "#057a55", "#8a6412", "#9333ea", "#dc2626", "#077f9c", "#db2777", "#ca4c0a"];
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
    if (z.eigenerSpieler || z.istAdmin || willZuschauen) return "screen-lobby";
    return "screen-start";
  }
  return { teams: "screen-teams", gruppen: "screen-gruppen", ko: "screen-ko", beendet: "screen-beendet" }[z.phase] || "screen-start";
}

// --- Haupt-Render ----------------------------------------------------------
function render(z) {
  zustand = z;
  // ⚠️ Turnierwechsel (Liste, Löschen, anderes Gerät): Format-Entwurf und
  // Elo-Merker gehören zum ALTEN Turnier. Sonst schrieb „Format festlegen" den
  // Entwurf von Turnier A still in Turnier B (Bugjagd 01.10.2026). Hier statt am
  // Klick, weil das die eine Stelle ist, die jeden Wechsel sieht.
  if (z.turnierId !== letzteRenderTurnierId) {
    letzteRenderTurnierId = z.turnierId;
    formatEntwurfZuruecksetzen();
    ratingBeruehrt.lobby = false;
    ratingBeruehrt.teams = false;
  }
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
  renderBedingungen(z);

  // Admin-Zahnrad nur zeigen, wenn ein Turnier existiert – und gar nicht,
  // solange der Turnierteil ausgeblendet ist (es öffnet nur Turnier-Aktionen;
  // der Streamplan hat seinen eigenen Veranstalter-Bereich in seinem Tab).
  document.getElementById("btn-admin-oeffnen").style.display = TURNIER_SICHTBAR && z.vorhanden ? "" : "none";

  // ⚠️ Steht der Zeitplan-Dialog offen, muss seine Liste mitwandern. Ohne das
  // zeigt sie nach "Zeitplan erzeugen" weiter die leeren Felder von vorher -
  // und wer dann ein Feld anfasst, schreibt den alten Stand zurück.
  const zpOffen = document.getElementById("modal-zeitplan");
  if (zpOffen && zpOffen.classList.contains("aktiv")) renderZeitplanListe(z);
}

// Turnierbedingungen über dem Turnier (Michel am 02.10.2026): was gespielt
// wird – Format, Best-of, Finale. Erst, wenn das Format feststeht.
function renderBedingungen(z) {
  const el = document.getElementById("turnier-bedingungen");
  if (!el) return;
  const meta = (z && z.meta) || {};
  if (!z || !z.vorhanden || meta.formatOffen) { el.hidden = true; return; }
  const teile = [];
  teile.push(FORM_TEXT[z.teamGroesse] || "");
  let ablauf = ABLAUF_TITEL[z.ablauf] || "";
  if (z.hatKoRunde) {
    const ko = [z.koTyp === "doppel" ? "Doppel-K.-o." : "einfaches K.-o."];
    if (meta.spielUmPlatz3 && z.koTyp !== "doppel") ko.push("mit Spiel um Platz 3");
    ablauf += " (" + ko.join(", ") + ")";
  }
  teile.push(ablauf);
  const bo = Number(meta.bestOf) || 3;
  teile.push("Spiele: Best of " + bo + (bo === 1 ? " (ein Spiel entscheidet)" : " (" + Math.ceil(bo / 2) + " Siege nötig)"));
  if (z.hatKoRunde && turnierService.BEST_OF_FINALE_ERLAUBT.includes(Number(meta.bestOfFinale)) && Number(meta.bestOfFinale) !== bo) {
    teile.push("Finale: Best of " + meta.bestOfFinale);
  }
  el.innerHTML = "<b>Turnierbedingungen:</b> " + teile.filter(Boolean).map(escapeHtml).join(" · ");
  el.hidden = false;
}

// Kurz unter der Partienummer: welcher Modus gilt für genau dieses Spiel.
function boMarke(z, spiel) {
  if (!spiel || !z.meta) return "";
  if (spiel.gemeldetVon === "adminwin") return " · Admin-Win";
  const bo = turnierService.bestOfFuer(spiel, z.meta);
  return " · Best of " + bo + (spiel.istFinale && bo !== (Number(z.meta.bestOf) || 3) ? " (Finale)" : "");
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

// Hat jemand seinen Elo-Regler angefasst, ohne zu speichern? Ein Merker je
// Kasten – „lobby" und „teams" stehen beide im DOM und dürfen sich nicht
// gegenseitig zurücksetzen.
// ⚠️ Aus demselben Grund wie formatEntwurf: renderLobby läuft bei JEDER
// fremden An- und Abmeldung. Ohne diesen Merker sprang der Regler auf den
// gespeicherten Wert zurück, und „Speichern" – das das Feld erst beim Klick
// liest – schrieb genau den alten Wert wieder in die Datenbank.
const ratingBeruehrt = { lobby: false, teams: false };
// Für den Reset beider Merker bei Turnierwechsel (siehe render).
let letzteRenderTurnierId;

function formatEntwurfAus(z) {
  // ⚠️ Bei offenem Format NICHT den Platzhalter (2 gegen 2) vorbelegen: Am
  // 02.10.2026 wurde das Turnier „1vs1“ so als 2 gegen 2 ausgelost – das Feld
  // stand schon da, niemand hat es angefasst. Jetzt muss man aktiv wählen.
  if (formatEntwurf.teamGroesse === null) formatEntwurf.teamGroesse = z.formatOffen ? "" : z.teamGroesse;
  if (formatEntwurf.koTyp === null) formatEntwurf.koTyp = z.koTyp;
  if (formatEntwurf.ablauf === null) formatEntwurf.ablauf = z.formatOffen ? "" : z.ablauf;
  const meta = z.meta || {};
  if (formatEntwurf.bestOf == null) formatEntwurf.bestOf = String(meta.bestOf || 3);
  if (formatEntwurf.bestOfFinale == null) formatEntwurf.bestOfFinale = meta.bestOfFinale ? String(meta.bestOfFinale) : "";
  if (formatEntwurf.losmodus == null) formatEntwurf.losmodus = turnierService.gewaehlterLosmodus();
  return formatEntwurf;
}
function formatEntwurfZuruecksetzen() {
  formatEntwurf = { teamGroesse: null, koTyp: null, ablauf: null, bestOf: null, bestOfFinale: null, losmodus: null };
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
  document.getElementById("form-bestof").value = entwurf.bestOf;
  document.getElementById("form-bestof-finale").value = entwurf.bestOfFinale;
  document.getElementById("form-setzliste").checked = entwurf.losmodus !== "zufaellig";

  setzeText("format-stand", z.formatOffen
    ? "Noch nichts festgelegt. Warte, bis alle da sind – dann wähle hier."
    : "Festgelegt: " + (FORM_TEXT[z.teamGroesse] || "") + " · " +
      (ABLAUF_TEXT[z.ablauf] || "") + ". Änderbar, solange die Anmeldung läuft.");

  const wort = anzahl === 1 ? "1 Angemeldeten" : anzahl + " Angemeldeten";
  setzeText("format-vorschau-titel", "Ablauf – so sähe er mit " + wort + " aus");

  if (!entwurf.teamGroesse) {
    setzeText("format-teams-zeile", "");
    liste.innerHTML = `<p class="fk-warnung">Bitte zuerst oben wählen, wer zusammen spielt – 1 gegen 1, 2 gegen 2 …</p>`;
    return;
  }
  const vergleich = turnierService.formatVergleich(anzahl, entwurf.teamGroesse, entwurf.koTyp,
    Number(entwurf.bestOf), entwurf.bestOfFinale ? Number(entwurf.bestOfFinale) : null);
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
        ? `<span class="fk-zahlen">${escapeHtml(v.kurz)}</span><span class="fk-dauer">${escapeHtml(v.dauer || "")}</span>`
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
  // ⚠️ Zurücknehmen: die eigene Anmeldung selbst („Abmelden“), fremde nur der
  // Veranstalter (🗑). Bis zum 25.09.2026 gab es dafür keinen Knopf, meldeAb()
  // war nie verdrahtet (Bugjagd 25.09.d T5-7). Die Klicks laufen über einen
  // Horcher an der Liste (wireEvents), nicht je Zeile.
  const anmeldung = z.phase === "anmeldung";
  liste.innerHTML = z.spieler
    .map((s) => {
      const eigen = s.id === z.eigeneUid;
      const ich = eigen ? ' <span class="spieler-badge">(du)</span>' : "";
      const knopf = !anmeldung ? ""
        : eigen
        ? `<button type="button" class="mini-btn" data-lobby-abmelden="1">Abmelden</button>`
        : z.istAdmin
        ? `<button type="button" class="mini-btn" data-lobby-entfernen="${escapeHtml(s.id)}" title="Aus der Anmeldung nehmen" aria-label="${escapeHtml(s.name)} aus der Anmeldung nehmen">🗑</button>`
        : "";
      return `<li>
        <span class="spieler-avatar" style="background:${avatarFarbe(s.id)}">${escapeHtml(initiale(s.name))}</span>
        <span class="spieler-name">${escapeHtml(s.name)}${ich}</span>
        <span class="spieler-badge">${Number(s.rating) || 0}</span>${knopf}
      </li>`;
    })
    .join("");

  // eigenes Elo anpassen
  renderRatingBlock("lobby", z);

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

  // Ab hier sieht niemand mehr die Lobby – der Elo-Kasten muss also mitkommen.
  renderRatingBlock("teams", z);

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
      // ⚠️ Jede Anmeldung, jede Elo-Änderung zeichnet hier neu. Ohne das Merken
      // sprang eine halb getroffene Auswahl (erst A, dann B) auf den ersten
      // Eintrag zurück, und „Tauschen“ tauschte die Falschen.
      ["tausch-a", "tausch-b"].forEach((id) => {
        const sel = document.getElementById(id);
        const vorher = sel.value;
        sel.innerHTML = optionen;
        if (vorher && Array.prototype.some.call(sel.options, (o) => o.value === vorher)) sel.value = vorher;
      });
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
    // ⚠️ Die K.-o.-Art aus der Formatwahl in der Lobby (meta.koTyp) vorbelegen –
    // einmal je Team-Phase, wie die übrigen Auslosungs-Felder unten. Sonst stand
    // hier fest „einfach“, und „Auslosen“ schrieb das über ein gewähltes „Doppel“.
    // Vor dem Lesen unten, damit Hinweis und Zeilen gleich zum Wert passen.
    if (!losFelderInit) document.getElementById("los-kotyp").value = z.koTyp === "doppel" ? "doppel" : "einfach";
    // Best-of aus der Formatwahl ebenso vorbelegen.
    if (!losFelderInit && z.meta) {
      document.getElementById("los-bestof").value = String(turnierService.BEST_OF_ERLAUBT.includes(Number(z.meta.bestOf)) ? z.meta.bestOf : 3);
      document.getElementById("los-bestof-finale").value = turnierService.BEST_OF_FINALE_ERLAUBT.includes(Number(z.meta.bestOfFinale)) ? String(z.meta.bestOfFinale) : "";
    }
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
      // Auslosungs-Art aus der Formatwahl vorbelegen.
      const lm = turnierService.gewaehlterLosmodus();
      const radio = document.querySelector('input[name="losmodus"][value="' + lm + '"]');
      if (radio) radio.checked = true;
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
  // ⚠️ Gleiche Sperre wie in renderZeitplanListe: jedes Live-Update baute die
  // Datumsfelder neu und warf eine halbfertige Eingabe weg (Bugjagd 01.10.2026).
  if (box.contains(document.activeElement)) return;
  box.innerHTML = nummern
    .map((n) => `<div class="spieltag-datum-zeile">
      <span class="sd-name">Spieltag ${n + 1}</span>
      <input type="date" class="eingabe" data-spieltag="${n}" value="${escapeHtml(daten[n] || "")}" aria-label="Datum für Spieltag ${n + 1}">
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
        ? g.runden.map((r) => {
            const echt = r.spiele.filter((s) => s.teamA && s.teamB);
            return rundeKlappHtml(z, "g" + g.name + "_r" + r.runde, "h4", rundenName(z, r.runde),
              echt.filter((s) => s.status === "bestaetigt").length, echt.length,
              `<div class="spiel-liste">${r.spiele.map((s) => spielZeileHtml(z, s)).join("")}</div>`);
          }).join("")
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
  setzeKoHtml(document.getElementById("ko-container"), bracketHtml(z));
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
  setzeKoHtml(bracketBox, hatBracket ? bracketHtml(z) : "");

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

// Freilose einer Runde nicht als eigene Karten (Michel am 02.10.2026: „viel zu
// viele Freilose“ – bei 35 im 1 gegen 1 füllt der Baum auf 64 auf: 3 echte
// Spiele, 29 Freilose). Sie stehen kompakt als eine Zeile über den Spielen.
// Leere Durchreicher (kein Team) erscheinen gar nicht.
function istFreilosMatch(m) { return !!(m && m.teamA && !m.teamB); }
function istLeerMatch(m) { return !!(m && !m.teamA && !m.teamB); }
function freiloseZeileHtml(z, matches) {
  const frei = matches.filter(istFreilosMatch);
  if (!frei.length) return "";
  return `<p class="hinweis-text bracket-freilose"><b>${frei.length === 1 ? "1 Freilos" : frei.length + " Freilose"}</b> – direkt in der nächsten Runde: ` +
    frei.map((m) => escapeHtml(m.teamAName)).join(", ") + "</p>";
}

// Lücken einer K.-o.-Runde sichtbar machen (Michel am 02.10.2026): Seit die
// nächste Runde Partie für Partie entsteht, fehlte z. B. kingofthrowing123 –
// sein Gegner stand noch nicht fest. Jetzt steht an der Stelle eine Karte
// „wartet“ mit beiden Seiten: schon feststehender Name oder „Sieger Partie N“.
// Nur einfaches K.-o.; nur Runden, die schon angefangen haben.
function koLueckenHtml(z, rundeNr) {
  if (!z.meta || z.koTyp === "doppel" || !rundeNr) return [];
  const ko = z.spiele.filter((s) => s.phase === "ko" && !s.platz3 && (s.bracket || "w") === "w");
  const runde0 = ko.filter((s) => (Number(s.runde) || 0) === 0).length;
  if (!runde0 || (runde0 & (runde0 - 1)) !== 0) return [];
  const finden = (r, p) => ko.find((s) => (Number(s.runde) || 0) === r && (Number(s.position) || 0) === p);
  const erwartet = runde0 / Math.pow(2, rundeNr);
  const nr = partieNummern(z);
  const seite = (s) => {
    if (!s) return { text: "offen", fest: false };
    if (s.status === "bestaetigt") {
      const sieger = !s.teamB ? s.teamA : (s.saetzeA > s.saetzeB ? s.teamA : s.teamB);
      return sieger ? { text: teamNameVon(z, sieger), fest: true } : { text: "—", fest: false };
    }
    return { text: nr.get(s.id) ? "Sieger Partie " + nr.get(s.id) : "Sieger offen", fest: false, partie: nr.get(s.id) };
  };
  const karten = [];
  for (let p = 0; p < erwartet; p++) {
    if (finden(rundeNr, p)) continue;
    const a = seite(finden(rundeNr - 1, p * 2)), b = seite(finden(rundeNr - 1, p * 2 + 1));
    const warten = [a, b].filter((x) => !x.fest && x.partie).map((x) => x.partie);
    const eigene = nr.get("ko_r" + rundeNr + "_p" + p);
    karten.push({ position: p, html: `<div class="match match-wartet">
      <div class="match-nr">${eigene ? "Partie " + eigene + " · " : ""}wartet${warten.length ? " auf Partie " + warten.join(" und ") : ""}</div>
      <div class="match-team${a.fest ? "" : " offen"}"><span>${escapeHtml(a.text)}</span><span class="match-saetze"></span></div>
      <div class="match-team${b.fest ? "" : " offen"}"><span>${escapeHtml(b.text)}</span><span class="match-saetze"></span></div>
    </div>` });
  }
  return karten;
}

// Runden einklappbar (Michel am 03.10.2026), im Kopf „fertig/gesamt“ der
// echten Partien (Freilose zählen nicht, wartende K.-o.-Partien schon).
// Fertige Runden sind von selbst zu, laufende offen. Wer selbst klickt, behält
// seine Wahl – auch über das Neuzeichnen bei jedem Ergebnis hinweg.
// ⚠️ Gemerkt wird nur beim Klick auf den Kopf, nicht über das toggle-Ereignis:
// das feuert auch, wenn die Runde mit „open“ neu gezeichnet wird, und würde den
// Automatik-Stand als Wahl festschreiben – eine fertige Runde klappte nie zu.
const RUNDE_OFFEN = new Map();
function rundeKlappHtml(z, key, tag, titel, fertig, gesamt, innen) {
  const k = (z.turnierId || "") + "|" + key;
  const komplett = gesamt > 0 && fertig >= gesamt;
  const offen = RUNDE_OFFEN.has(k) ? RUNDE_OFFEN.get(k) : !komplett;
  return `<details class="runde-klapp" data-runde-key="${escapeHtml(k)}"${offen ? " open" : ""}>
    <summary><${tag} class="runde-klapp-titel">${escapeHtml(titel)}</${tag}><span class="runde-zaehler${komplett ? " fertig" : ""}" title="fertig / gesamt">${fertig}/${gesamt}</span></summary>
    ${innen}
  </details>`;
}
document.addEventListener("click", (e) => {
  const kopf = e.target.closest && e.target.closest("details.runde-klapp > summary");
  if (!kopf) return;
  const d = kopf.parentElement;
  RUNDE_OFFEN.set(d.dataset.rundeKey, !d.open);
});

// --- Turnierbaum als zweite Ansicht (Michel am 03.10.2026) -------------------
// Umschalter „Liste | Baum“ über dem K.-o. Der Baum zeigt alle Runden als
// Spalten, jede Partie mittig zwischen ihren beiden Vorgängern, mit Linien.
// Freilose der ersten Runde sind schmale Zeilen statt ganzer Karten – sonst
// wäre ein 64er-Feld mit 28 Freilosen meterlang.
// ⚠️ Nur einfaches K.-o. mit Zweierpotenz in Runde 0 (so lost die App seit
// jeher). Doppel-K.-o. bleibt in der Liste – Verliererbaum und großes Finale
// passen nicht in dieses Raster.
// Nur Anzeige: Melden und Korrigieren gehen in der Liste.
let koAnsicht = (() => { try { return localStorage.getItem("agelan_ko_ansicht") === "baum" ? "baum" : "liste"; } catch (e) { return "liste"; } })();

const BAUM_B = 210;        // Breite einer Karte
const BAUM_LUECKE = 44;    // Abstand zwischen den Spalten (Platz für Linien)
const BAUM_H = 66;         // Höhe einer Partie
const BAUM_H_FREI = 30;    // Höhe einer Freilos-Zeile in Runde 0
const BAUM_ABSTAND = 10;   // senkrechter Abstand in Runde 0
const BAUM_KOPF = 34;      // Platz für die Rundennamen

function koBaumMoeglich(z) {
  if (!z.meta || z.koTyp === "doppel") return false;
  const n0 = z.spiele.filter((s) => s.phase === "ko" && !s.platz3 && (s.bracket || "w") === "w" && (Number(s.runde) || 0) === 0).length;
  return n0 >= 1 && (n0 & (n0 - 1)) === 0;
}

function koAnsichtUmschalterHtml(z) {
  if (!koBaumMoeglich(z)) return "";
  const knopf = (wert, text) => `<button type="button" class="es-filter-chip${koAnsicht === wert ? " aktiv" : ""}" data-ko-ansicht="${wert}" aria-pressed="${koAnsicht === wert}">${text}</button>`;
  return `<div class="ko-ansicht-wahl" role="group" aria-label="Ansicht">${knopf("liste", "☰ Liste")}${knopf("baum", "🌳 Turnierbaum")}</div>`;
}

function koRundenName(anzahlSpiele) {
  if (anzahlSpiele === 1) return "Finale";
  if (anzahlSpiele === 2) return "Halbfinale";
  if (anzahlSpiele === 4) return "Viertelfinale";
  if (anzahlSpiele === 8) return "Achtelfinale";
  if (anzahlSpiele === 16) return "Sechzehntelfinale";
  return (anzahlSpiele * 2) + "er-Runde";
}

function koBaumHtml(z) {
  const ko = z.spiele.filter((s) => s.phase === "ko" && !s.platz3 && (s.bracket || "w") === "w");
  const n0 = ko.filter((s) => (Number(s.runde) || 0) === 0).length;
  const runden = Math.round(Math.log2(n0)) + 1;
  const finden = (r, p) => ko.find((s) => (Number(s.runde) || 0) === r && (Number(s.position) || 0) === p);
  const nr = partieNummern(z);
  const name = (id) => (id ? teamNameVon(z, id) : "");
  const sieger = (s) => (!s || s.status !== "bestaetigt") ? null : (!s.teamB ? s.teamA : (Number(s.saetzeA) > Number(s.saetzeB) ? s.teamA : s.teamB));

  // Senkrechte Mitten: Runde 0 der Reihe nach, jede weitere Runde mittig
  // zwischen ihren beiden Vorgängern.
  const mitte = [[]];
  const hoehe0 = [];
  let y = BAUM_KOPF;
  for (let p = 0; p < n0; p++) {
    const s = finden(0, p);
    const h = s && s.teamA && s.teamB ? BAUM_H : BAUM_H_FREI;
    hoehe0.push(h);
    mitte[0].push(y + h / 2);
    y += h + BAUM_ABSTAND;
  }
  const gesamtHoehe = Math.max(y, BAUM_KOPF + BAUM_H + BAUM_ABSTAND);
  for (let r = 1; r < runden; r++) {
    mitte.push([]);
    for (let p = 0; p < n0 / Math.pow(2, r); p++) mitte[r].push((mitte[r - 1][2 * p] + mitte[r - 1][2 * p + 1]) / 2);
  }
  const xVon = (r) => r * (BAUM_B + BAUM_LUECKE);

  // Eine Seite einer Karte: Teamname, schon bekannt aus dem Vorgänger, oder „Sieger Partie N“.
  const seiteAusVorgaenger = (r, p) => {
    const v = finden(r - 1, p);
    const w = sieger(v);
    if (w) return { text: name(w), offen: false };
    // Noch nicht angelegte Vorgänger haben schon ihre feste Nummer (partieNummernAus).
    const n = nr.get(v ? v.id : "ko_r" + (r - 1) + "_p" + p);
    return { text: n ? "Sieger Partie " + n : "offen", offen: true };
  };

  const karten = [];
  const linien = [];
  for (let r = 0; r < runden; r++) {
    const anzahl = n0 / Math.pow(2, r);
    for (let p = 0; p < anzahl; p++) {
      const s = finden(r, p);
      const cy = mitte[r][p];
      const x = xVon(r);
      if (r === 0 && !(s && s.teamA && s.teamB)) {
        const txt = s && s.teamA ? escapeHtml(name(s.teamA)) + ' <span class="baum-frei-marke">Freilos</span>' : '<span class="baum-leer">—</span>';
        karten.push(`<div class="baum-frei" style="left:${x}px;top:${cy - BAUM_H_FREI / 2}px;width:${BAUM_B}px;height:${BAUM_H_FREI}px">${txt}</div>`);
      } else {
        let a, b, sa = "", sb = "", wa = false, wb = false, kopf = "", warte = false;
        if (s) {
          a = { text: name(s.teamA), offen: false };
          b = { text: s.teamB ? name(s.teamB) : "Freilos", offen: !s.teamB };
          if (s.status !== "offen" && s.saetzeA != null) { sa = s.saetzeA; sb = s.saetzeB; }
          const w = sieger(s);
          wa = !!w && w === s.teamA; wb = !!w && w === s.teamB;
          kopf = nr.get(s.id) ? "Partie " + nr.get(s.id) : "";
        } else {
          a = seiteAusVorgaenger(r, 2 * p);
          b = seiteAusVorgaenger(r, 2 * p + 1);
          warte = true;
          const eigene = nr.get("ko_r" + r + "_p" + p);
          kopf = (eigene ? "Partie " + eigene + " · " : "") + "wartet";
        }
        const zeile = (seite, satz, gewonnen) => `<div class="baum-team${gewonnen ? " sieger" : ""}${seite.offen ? " offen" : ""}"><span>${escapeHtml(seite.text)}</span><b>${satz === "" ? "" : escapeHtml(String(satz))}</b></div>`;
        const laeuft = s && s.status !== "bestaetigt";
        // Offene Partien fallen auf (Michel am 03.10.2026): Farbbalken links,
        // getönte Fläche und ein Schild „läuft“ bzw. „gemeldet“ im Kopf.
        const statusKlasse = s && s.status === "offen" ? " st-offen" : s && s.status === "gemeldet" ? " st-gemeldet" : "";
        const schild = s && s.status === "offen" ? '<span class="baum-schild">▶ läuft</span>'
          : s && s.status === "gemeldet" ? '<span class="baum-schild">? gemeldet</span>' : "";
        const tun = s ? baumAktionen(z, s) : [];
        karten.push(`<div class="baum-match${warte ? " wartet" : ""}${laeuft ? " laeuft" : ""}${statusKlasse}${tun.length ? " klickbar" : ""}"${tun.length
          ? ` data-baum-spiel="${escapeHtml(s.id)}" role="button" tabindex="0" title="${escapeHtml(tun.map((t) => t.text).join(" / "))}"` : ""} style="left:${x}px;top:${cy - BAUM_H / 2}px;width:${BAUM_B}px;height:${BAUM_H}px">
          <div class="baum-kopf"><span>${escapeHtml(kopf)}</span>${schild}</div>${zeile(a, sa, wa)}${zeile(b, sb, wb)}</div>`);
      }
      // Linie zum Nachfolger
      if (r < runden - 1) {
        const x1 = x + BAUM_B, xm = x1 + BAUM_LUECKE / 2, ziel = mitte[r + 1][Math.floor(p / 2)];
        linien.push(`<path d="M${x1} ${cy}H${xm}V${ziel}H${x1 + BAUM_LUECKE}"/>`);
      }
    }
  }
  const titel = [];
  for (let r = 0; r < runden; r++) {
    titel.push(`<div class="baum-runde-titel" style="left:${xVon(r)}px;width:${BAUM_B}px">${escapeHtml(koRundenName(n0 / Math.pow(2, r)))}</div>`);
  }
  // Sieger rechts neben dem Finale, Spiel um Platz 3 darunter.
  let breite = xVon(runden - 1) + BAUM_B;
  const finale = finden(runden - 1, 0);
  const champion = sieger(finale);
  if (champion) {
    const x = breite + BAUM_LUECKE;
    linien.push(`<path d="M${breite} ${mitte[runden - 1][0]}H${x}"/>`);
    karten.push(`<div class="baum-champion" style="left:${x}px;top:${mitte[runden - 1][0] - 22}px;width:${BAUM_B}px">🏆 ${escapeHtml(name(champion))}</div>`);
    breite = x + BAUM_B;
  }
  let hoehe = gesamtHoehe;
  const p3 = z.spiele.find((s) => s.phase === "ko" && s.platz3);
  if (p3) {
    const x = xVon(runden - 1), top = mitte[runden - 1][0] + BAUM_H / 2 + 40;
    const w = sieger(p3);
    const tun3 = baumAktionen(z, p3);
    const zeile = (id, satz) => `<div class="baum-team${w && w === id ? " sieger" : ""}"><span>${escapeHtml(name(id))}</span><b>${p3.status !== "offen" && satz != null ? escapeHtml(String(satz)) : ""}</b></div>`;
    karten.push(`<div class="baum-match${p3.status !== "bestaetigt" ? " laeuft" : ""}${tun3.length ? " klickbar" : ""}"${tun3.length
      ? ` data-baum-spiel="${escapeHtml(p3.id)}" role="button" tabindex="0" title="${escapeHtml(tun3.map((t) => t.text).join(" / "))}"` : ""} style="left:${x}px;top:${top}px;width:${BAUM_B}px;height:${BAUM_H}px">
      <div class="baum-kopf">Spiel um Platz 3${nr.get(p3.id) ? " · Partie " + nr.get(p3.id) : ""}</div>${zeile(p3.teamA, p3.saetzeA)}${zeile(p3.teamB, p3.saetzeB)}</div>`);
    hoehe = Math.max(hoehe, top + BAUM_H + 10);
  }
  return `<p class="hinweis-text">Tipp auf eine Partie, um das Ergebnis zu melden, zu bestätigen oder (als Veranstalter) zu korrigieren.</p>
    <div class="ko-baum-scroll"><div class="ko-baum" style="width:${breite + 4}px;height:${hoehe}px">
      <svg class="baum-linien" width="${breite + 4}" height="${hoehe}" aria-hidden="true">${linien.join("")}</svg>
      ${titel.join("")}${karten.join("")}
    </div></div>`;
}

// Was man an einer Partie im Baum tun kann – dieselben Regeln wie die Knöpfe
// der Liste (spielAktionenHtml), nur als Daten.
function baumAktionen(z, s) {
  const d = document.createElement("div");
  d.innerHTML = spielAktionenHtml(z, s);
  return [...d.querySelectorAll("[data-aktion]")].map((b) => ({ aktion: b.dataset.aktion, text: b.textContent.trim() === "✎" ? "Ergebnis korrigieren" : b.textContent.trim() }));
}

// Klick auf eine Partie im Baum (Michel am 03.10.2026): eine Aktion → gleich
// ausführen (meist „Ergebnis melden“ bzw. als Veranstalter „korrigieren“),
// mehrere (Bestätigen/Widersprechen) → kleines Auswahlfeld an der Klickstelle.
function schliesseBaumWahl() {
  const alt = document.getElementById("baum-wahl");
  if (alt) alt.remove();
}
function baumKlick(karte, x, y) {
  schliesseBaumWahl();
  const s = zustand && zustand.spiele.find((t) => t.id === karte.dataset.baumSpiel);
  if (!s) return;
  const tun = baumAktionen(zustand, s);
  if (!tun.length) return;
  if (tun.length === 1) { spielAktionAusfuehren(tun[0].aktion, s.id); return; }
  const wahl = document.createElement("div");
  wahl.id = "baum-wahl";
  wahl.className = "baum-wahl";
  wahl.innerHTML = `<p class="baum-wahl-titel">${escapeHtml(teamNameVon(zustand, s.teamA))} ${s.saetzeA != null ? escapeHtml(s.saetzeA + ":" + s.saetzeB) : "vs"} ${escapeHtml(teamNameVon(zustand, s.teamB))}</p>` +
    tun.map((t) => `<button type="button" class="mini-btn${t.aktion === "bestaetigen" ? " primary" : ""}" data-baum-tun="${escapeHtml(t.aktion)}">${escapeHtml(t.text)}</button>`).join("");
  document.body.appendChild(wahl);
  const r = wahl.getBoundingClientRect();
  wahl.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2)) + "px";
  wahl.style.top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y + 12)) + "px";
  wahl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-baum-tun]");
    if (!b) return;
    schliesseBaumWahl();
    spielAktionAusfuehren(b.dataset.baumTun, s.id);
  });
}
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("#baum-wahl")) return;
  const karte = e.target.closest && e.target.closest("[data-baum-spiel]");
  if (!karte) { schliesseBaumWahl(); return; }
  baumKlick(karte, e.clientX, e.clientY);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { schliesseBaumWahl(); return; }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-baum-spiel]")) {
    e.preventDefault();
    const r = e.target.getBoundingClientRect();
    baumKlick(e.target, r.left + r.width / 2, r.bottom);
  }
});
window.addEventListener("scroll", schliesseBaumWahl, { passive: true });

// Neu zeichnen ohne dass der Baum an den Anfang zurückspringt: jedes Ergebnis
// zeichnet den K.-o.-Kasten neu, die Scrollstellung bleibt.
function setzeKoHtml(el, html) {
  const alt = el.querySelector(".ko-baum-scroll");
  const pos = alt ? [alt.scrollLeft, alt.scrollTop] : null;
  el.innerHTML = html;
  baumEinpassen();
  // Falls der Kasten gerade erst sichtbar wird: nach dem Zeichnen noch einmal.
  requestAnimationFrame(baumEinpassen);
  const neu = el.querySelector(".ko-baum-scroll");
  if (pos && neu) { neu.scrollLeft = pos[0]; neu.scrollTop = pos[1]; }
}

// Ohne Scrollbalken (Michel am 03.10.2026): Der Baum nutzt die ganze
// Fensterbreite statt der schmalen Spalte und wird verkleinert, bis er passt.
// Nach unten läuft er einfach mit der Seite. Nur wenn er selbst bei 55 % noch
// zu breit wäre (Handy, großes Feld), lässt er sich seitlich wischen – ohne
// sichtbaren Balken. Kleiner wäre nicht mehr lesbar.
const BAUM_MIN_SKALA = 0.55;
function baumEinpassen() {
  document.querySelectorAll(".ko-baum-scroll").forEach((huelle) => {
    const baum = huelle.querySelector(".ko-baum");
    if (!baum) return;
    const fenster = document.documentElement.clientWidth;
    const rand = 16;
    const natB = parseFloat(baum.style.width) || baum.offsetWidth;
    const natH = parseFloat(baum.style.height) || baum.offsetHeight;
    const platz = Math.max(200, fenster - 2 * rand);
    const skala = Math.max(BAUM_MIN_SKALA, Math.min(1, platz / natB));
    const breite = Math.min(platz, natB * skala);
    // Mittig im Fenster, unabhängig von der schmalen Spalte drumherum.
    huelle.style.width = breite + "px";
    huelle.style.marginLeft = "0px";
    const links = huelle.getBoundingClientRect().left;
    huelle.style.marginLeft = Math.round((fenster - breite) / 2 - links) + "px";
    baum.style.transform = skala < 1 ? "scale(" + skala + ")" : "";
    baum.style.transformOrigin = "top left";
    // Die Hülle muss die verkleinerte Größe tragen, sonst bleibt unten Leerraum.
    huelle.style.height = Math.ceil(natH * skala) + "px";
    const innen = huelle.querySelector(".ko-baum-mass") || (() => {
      const m = document.createElement("div"); m.className = "ko-baum-mass"; huelle.appendChild(m); return m;
    })();
    innen.style.width = Math.ceil(natB * skala) + "px";
  });
}
window.addEventListener("resize", () => baumEinpassen());

document.addEventListener("click", (e) => {
  const k = e.target.closest && e.target.closest("[data-ko-ansicht]");
  if (!k) return;
  koAnsicht = k.dataset.koAnsicht === "baum" ? "baum" : "liste";
  try { localStorage.setItem("agelan_ko_ansicht", koAnsicht); } catch (err) { /* privater Modus */ }
  if (zustand) render(zustand);
});

function bracketHtml(z) {
  if (!z.bracket || z.bracket.runden.length === 0) return '<p class="hinweis-text">Noch keine Paarungen.</p>';
  if (koAnsicht === "baum" && koBaumMoeglich(z)) return koAnsichtUmschalterHtml(z) + koBaumHtml(z);
  return koAnsichtUmschalterHtml(z) + bracketListeHtml(z);
}

function bracketListeHtml(z) {
  return z.bracket.runden
    .map((r) => {
      const posVon = (id) => { const sp = z.spiele.find((x) => x.id === id); return sp ? Number(sp.position) || 0 : 0; };
      const echt = r.matches.filter((m) => !istFreilosMatch(m) && !istLeerMatch(m));
      const luecken = koLueckenHtml(z, r.runde);
      const fertig = echt.filter((m) => { const sp = z.spiele.find((s) => s.id === m.id); return sp && sp.status === "bestaetigt"; }).length;
      const matches = echt
        .map((m) => ({ position: posVon(m.id), html: (() => {
          const sieger = m.siegerTeamId;
          const aWin = sieger && sieger === m.teamA ? " sieger" : "";
          const bWin = sieger && sieger === m.teamB ? " sieger" : "";
          const spiel = z.spiele.find((s) => s.id === m.id);
          const aktionen = spiel ? spielAktionenHtml(z, spiel) : "";
          return `<div class="match">
            ${partieNrHtml(z, m.id) ? `<div class="match-nr">Partie ${partieNummern(z).get(m.id)}${escapeHtml(boMarke(z, spiel))}</div>` : ""}
            <div class="match-team${aWin}"><span>${escapeHtml(m.teamAName)}</span><span class="match-saetze">${m.saetzeA == null ? "" : m.saetzeA}</span></div>
            <div class="match-team${bWin}"><span>${escapeHtml(m.teamBName)}</span><span class="match-saetze">${m.saetzeB == null ? "" : m.saetzeB}</span></div>
            ${m.geplantAm ? `<div class="match-zeit">${zeitMarkeHtml(m)}</div>` : ""}
            ${aktionen ? `<div class="match-aktionen">${aktionen}</div>` : ""}
          </div>`;
        })() }))
        .concat(luecken)
        .sort((a, b) => a.position - b.position)
        .map((k) => k.html)
        .join("");
      return `<div class="bracket-runde">${rundeKlappHtml(z, "w" + r.runde, "h3", r.name, fertig, echt.length + luecken.length,
        freiloseZeileHtml(z, r.matches) + matches)}</div>`;
    })
    .join("") + verliererHtml(z) + grossesFinaleHtml(z) + platz3Html(z);
}

// Verliererbaum des Doppel-K.-o. – nur da, wo es ihn gibt.
function verliererHtml(z) {
  const runden = (z.bracket && z.bracket.verliererRunden) || [];
  if (!runden.length) return "";
  return runden
    .map((r) => {
      const echt = r.matches.filter((m) => !istFreilosMatch(m) && !istLeerMatch(m));
      const fertig = echt.filter((m) => { const sp = z.spiele.find((s) => s.id === m.id); return sp && sp.status === "bestaetigt"; }).length;
      return `<div class="bracket-runde">${rundeKlappHtml(z, "l" + r.runde, "h3", r.name, fertig, echt.length,
        freiloseZeileHtml(z, r.matches) + echt.map((m) => matchHtml(z, m)).join(""))}</div>`;
    })
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
    ${partieNrHtml(z, m.id) ? `<div class="match-nr">Partie ${partieNummern(z).get(m.id)}${escapeHtml(boMarke(z, spiel))}</div>` : ""}
    <div class="match-team${aWin}"><span>${escapeHtml(m.teamAName)}</span><span class="match-saetze">${m.saetzeA == null ? "" : m.saetzeA}</span></div>
    <div class="match-team${bWin}"><span>${escapeHtml(m.teamBName)}</span><span class="match-saetze">${m.saetzeB == null ? "" : m.saetzeB}</span></div>
    ${m.geplantAm ? `<div class="match-zeit">${zeitMarkeHtml(m)}</div>` : ""}
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

// Fortlaufende Partienummern über das ganze Turnier (Michel am 02.10.2026) –
// zum Ansagen und Suchen („Partie 7 bitte melden“). Reihenfolge: erst die
// Vorrunde nach Runde, Gruppe, Position, dann das K.-o. nach Runde,
// Gewinner- vor Verliererbaum, Position; Spiel um Platz 3 vor dem Finale.
// Freilose und leere Durchreicher bekommen keine Nummer.
// ⚠️ Gerechnet aus den Spielen selbst, nicht gespeichert: kommt eine neue
// Runde dazu, behalten alle bisherigen Partien ihre Nummer, weil neue Runden
// immer hinten einsortiert werden.
const PARTIE_NR_CACHE = new WeakMap();
function partieNummern(z) {
  const liste = z.spiele || [];
  if (PARTIE_NR_CACHE.has(liste)) return PARTIE_NR_CACHE.get(liste);
  // Gerechnet im Service – dieselbe Zählung zeigt auch die Übersicht.
  const nr = turnierService.partieNummernAus(liste, z.meta);
  PARTIE_NR_CACHE.set(liste, nr);
  return nr;
}
function partieNrHtml(z, id) {
  const n = partieNummern(z).get(id);
  return n ? `<span class="partie-nr">#${n}</span>` : "";
}

// --- Spiel-Zeile (Gruppe) + Aktionen --------------------------------------
function spielZeileHtml(z, s) {
  const ergebnis =
    s.status === "offen"
      ? '<span class="spiel-status">offen</span>'
      : `<span class="spiel-ergebnis${s.status === "bestaetigt" ? " ok" : ""}">${s.saetzeA}:${s.saetzeB}${s.status === "gemeldet" ? " ?" : " ✓"}${s.gemeldetVon === "adminwin" ? ' <span class="adminwin-marke">Admin-Win</span>' : ""}${s.gemeldetVon === "rueckzug" ? ' <span class="adminwin-marke">kampflos</span>' : ""}</span>`;
  // Freilos: kein Gegner, aber ein gewerteter Sieg – "vs —" liest sich wie ein Fehler.
  const gegner = s.teamB ? escapeHtml(teamNameVon(z, s.teamB)) : "Freilos";
  return `<div class="spiel-zeile">
    <div class="spiel-teams">${partieNrHtml(z, s.id)}<span>${escapeHtml(teamNameVon(z, s.teamA))}</span> <span class="vs">vs</span> <span>${gegner}</span>${zeitMarkeHtml(s)}</div>
    <div class="spiel-rechts">${ergebnis}</div>
    <div class="spiel-aktionen">${spielAktionenHtml(z, s)}</div>
  </div>`;
}

// Liefert die passenden Aktions-Buttons für ein Spiel je nach Rolle/Status.
function spielAktionAusfuehren(aktion, spielId) {
  if (aktion === "melden") oeffneMeldeDialog(spielId, false);
  else if (aktion === "korrigieren") oeffneMeldeDialog(spielId, true);
  else if (aktion === "bestaetigen") turnierService.bestaetigeErgebnis(spielId).then((r) => { if (!r.erfolg) alert(r.fehler); });
  else if (aktion === "widersprechen") turnierService.widersprichErgebnis(spielId);
}

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

// Derselbe Elo-Kasten steht zweimal in der Seite: in der Lobby („lobby") und
// nach dem Team-Bilden auf dem Teams-Bildschirm („teams"). Beide schreiben in
// dasselbe Feld, also hängen sie an EINER Funktion – sonst driften sie
// auseinander, sobald sich an einer Stelle etwas ändert.
// ⚠️ Die Ids müssen dem Muster folgen: <praefix>-eigen, <praefix>-rating,
// <praefix>-rating-slider, <praefix>-rating-hinweis,
// btn-<praefix>-rating-speichern.
function wireRatingBlock(praefix) {
  koppleRating(praefix + "-rating-slider", praefix + "-rating");

  // Ab der ersten Bewegung gehört der Regler dem Spieler, nicht mehr dem
  // Live-Update (siehe ratingBeruehrt).
  [praefix + "-rating-slider", praefix + "-rating"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", () => {
      ratingBeruehrt[praefix] = true;
      zeigeFehler(praefix + "-rating-hinweis", "");
    });
  });

  const btn = document.getElementById("btn-" + praefix + "-rating-speichern");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const res = await turnierService.aktualisiereRating(document.getElementById(praefix + "-rating").value);
    // Erst wenn es wirklich drin steht, darf das nächste Update den Regler
    // wieder nachziehen. Bei einem Fehler bleibt der eingestellte Wert stehen.
    if (res && res.erfolg) ratingBeruehrt[praefix] = false;
    const hinweis = document.getElementById(praefix + "-rating-hinweis");
    if (hinweis) hinweis.classList.toggle("fehler", !(res && res.erfolg));
    zeigeFehler(praefix + "-rating-hinweis", res && res.erfolg ? "Gespeichert ✓" : (res && res.fehler) || "");
  });
}

// Zeigt den Kasten nur, wenn man selbst mitspielt, und zieht den Regler auf den
// gespeicherten Wert nach – solange ihn niemand angefasst hat.
function renderRatingBlock(praefix, z) {
  const block = document.getElementById(praefix + "-eigen");
  if (!block) return;
  if (!z.eigenerSpieler) {
    block.style.display = "none";
    return;
  }
  block.style.display = "";
  if (!ratingBeruehrt[praefix]) setRating(praefix + "-rating-slider", praefix + "-rating", z.eigenerSpieler.rating);
}

// ===========================================================================
// Melde-Dialog
// ===========================================================================
// ⚠️ Abnahme 25.09.e D-12: die fuenf Fenster (Melden, Veranstalter, Zeitplan, Stream,
// Programm) sind echte Dialoge: role=dialog + aria-modal in index.html, beim Oeffnen geht der
// Fokus auf die Ueberschrift (nicht ins erste Feld - das wuerde am Handy die Tastatur
// aufklappen), beim Schliessen zurueck zum Ausloeser, Escape schliesst das oberste Fenster.
// Die beiden Stream-Fenster rufen dieselben Helfer aus stream-app.js (geteilter Scope).
const DLG_SCHLIESSER = {
  "modal-melden": () => schliesseMeldeDialog(),
  "modal-admin": () => schliesseAdmin(),
  "modal-zeitplan": () => schliesseZeitplan(),
  "modal-stream": () => { if (typeof skSchliesseDialog === "function") skSchliesseDialog(); },
  "modal-programm": () => { if (typeof skSchliesseProgrammDialog === "function") skSchliesseProgrammDialog(); },
};
const dlgAusloeser = {};
function dlgFokusRein(id) {
  const ov = document.getElementById(id);
  if (!ov) return;
  if (!dlgAusloeser[id]) dlgAusloeser[id] = document.activeElement;
  const titel = ov.querySelector("[role=dialog] h3");
  if (titel) { try { titel.focus(); } catch (e) { /* egal */ } }
}
function dlgFokusZurueck(id) {
  const a = dlgAusloeser[id];
  delete dlgAusloeser[id];
  if (a && a !== document.body && typeof a.focus === "function" && document.body.contains(a)) {
    try { a.focus(); } catch (e) { /* egal */ }
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const offen = Object.keys(DLG_SCHLIESSER).filter((id) => {
    const el = document.getElementById(id);
    return el && el.classList.contains("aktiv");
  });
  if (offen.length) DLG_SCHLIESSER[offen[offen.length - 1]]();
});

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
  // ⚠️ Nicht meta.bestOf: das Finale kann ein eigenes Best-of haben
  // („Finale Best of 5“). Der Hinweis muss denselben Wert nennen, den
  // validiereSaetze gleich darauf prueft – sonst fordert der Dialog eine
  // Eingabe, die er selbst ablehnt. Das ist zugleich die einzige Stelle der
  // App, an der waehrend des Turniers ein Modus benannt wird.
  // ⚠️ Und NICHT window.turnierService abfragen: der Service steht als
  // `const` im Skript und landet damit nie am window – die Bedingung war immer
  // falsch, der Hinweis nannte deshalb stur „2 Sätze", egal welches Best-of
  // eingestellt war. turnier-service.js wird vor app.js geladen, der direkte
  // Aufruf ist sicher.
  const bestOf = turnierService.bestOfFuer(s, zustand.meta);
  const noetig = turnierService.noetigeSaetze(bestOf);
  document.getElementById("melden-hinweis").textContent = noetig === 1
    ? "Best of 1: ein Spiel entscheidet – trag 1:0 oder 0:1 ein."
    : `Best of ${bestOf}: Sieger braucht ${noetig} Sätze.`;
  document.getElementById("melden-fehler").textContent = "";
  // Admin-Win nur für Veranstalter und nur bei echten Paarungen.
  const winBox = document.getElementById("melden-adminwin");
  winBox.hidden = !(zustand.istAdmin && s.teamA && s.teamB);
  document.getElementById("btn-adminwin-a").textContent = "🏳 Admin-Win: " + teamNameVon(zustand, s.teamA);
  document.getElementById("btn-adminwin-b").textContent = "🏳 Admin-Win: " + teamNameVon(zustand, s.teamB);
  // Zurücksetzen auf „offen“: Veranstalter, echte Paarung, schon ein Ergebnis da.
  document.getElementById("btn-ergebnis-zurueck").hidden = !(zustand.istAdmin && s.teamA && s.teamB && s.status !== "offen");
  document.getElementById("modal-melden").classList.add("aktiv");
  dlgFokusRein("modal-melden");
}
function schliesseMeldeDialog() {
  meldeSpielId = null;
  document.getElementById("modal-melden").classList.remove("aktiv");
  dlgFokusZurueck("modal-melden");
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
  // A3-01: wer nur per Konto (⭐/🛠) Veranstalter ist, braucht hier den PIN.
  if (typeof zeigeKontoPinHinweis === "function") zeigeKontoPinHinweis("admin-konto-hinweis");
  document.getElementById("admin-fehler").textContent = "";
  document.getElementById("admin-panel-fehler").textContent = "";
  document.getElementById("admin-pin").value = "";
  // Spielmodus: nur sinnvoll, wenn ausgelost ist und noch gespielt wird.
  const meta = (zustand && zustand.meta) || {};
  const laeuft = istAdmin && meta.phase && meta.phase !== "anmeldung" && meta.phase !== "teams" && meta.phase !== "beendet";
  document.getElementById("admin-spielmodus").hidden = !laeuft;
  // Team zurückziehen: nur in der Vorrunde, Auswahl = Teams, die noch in einer Gruppe stehen.
  const vorrunde = istAdmin && meta.phase === "gruppen";
  document.getElementById("admin-rueckzug").hidden = !vorrunde;
  // Letzte Schweizer Runde zurücknehmen: ab Runde 2.
  const schweizerRunde = vorrunde && zustand.istSchweizer
    ? zustand.spiele.filter((s) => s.phase === "gruppe").reduce((m, s) => Math.max(m, Number(s.runde) || 0), 0) : 0;
  document.getElementById("admin-runde-zurueck").hidden = !(schweizerRunde >= 1);
  if (schweizerRunde >= 1) document.getElementById("btn-admin-runde-zurueck").textContent = "Auslosung von Runde " + (schweizerRunde + 1) + " zurücknehmen";
  if (vorrunde) {
    const inGruppe = new Set();
    (zustand.gruppen || []).forEach((g) => (g.teamIds || []).forEach((tid) => inGruppe.add(tid)));
    document.getElementById("admin-rueckzug-team").innerHTML = '<option value="">– Team wählen –</option>' +
      zustand.teams.filter((t) => inGruppe.has(t.id))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("");
  }
  if (laeuft) {
    document.getElementById("admin-bestof").value = String(meta.bestOf || 3);
    document.getElementById("admin-bestof-finale").value = meta.bestOfFinale ? String(meta.bestOfFinale) : "";
  }
  document.getElementById("modal-admin").classList.add("aktiv");
  dlgFokusRein("modal-admin");
}
function schliesseAdmin() {
  document.getElementById("modal-admin").classList.remove("aktiv");
  dlgFokusZurueck("modal-admin");
}


// ===========================================================================
// Zeitplan: Anzeige und Dialog
// ===========================================================================
const ZP_WOCHENTAGE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// "2026-10-01T14:00" -> "Do 01.10., 14:00". ⚠️ Der Text wird NICHT aus einem
// Date-Objekt gebaut: `new Date("2026-10-01T14:00")` ist zwar Ortszeit, aber
// eine Zeile weiter ist man beim Zeitstempel - und dann verschiebt die
// Sommerzeit den Anstoß. Nur der Wochentag braucht den Kalender.
function zeitLesbar(geplantAm) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/.exec(String(geplantAm || ""));
  if (!m) return "";
  const tag = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
  return ZP_WOCHENTAGE[tag] + " " + m[3] + "." + m[2] + "., " + m[4] + ":" + m[5];
}

// Dauer in Worten: 60 -> "1 h", 90 -> "1:30 h", 45 -> "45 Min".
function dauerLesbar(min) {
  const d = Math.round(Number(min) || 0);
  if (!d) return "";
  if (d < 60) return d + " Min";
  const h = Math.floor(d / 60), rest = d % 60;
  return rest ? h + ":" + String(rest).padStart(2, "0") + " h" : h + " h";
}

function zeitMarkeHtml(s) {
  if (!s || !s.geplantAm) return "";
  const dauer = dauerLesbar(s.dauerMin);
  return `<span class="spiel-zeit" title="Geplanter Anstoß">🕐 ${escapeHtml(zeitLesbar(s.geplantAm))}${dauer ? " · " + escapeHtml(dauer) : ""}</span>`;
}

// --- Dialog ---------------------------------------------------------------

function oeffneZeitplan() {
  if (!zustand || !zustand.istAdmin) return;
  const zp = zustand.zeitplan || {};
  // ⚠️ Erst befuellen, dann zeigen. Andersherum blitzen fuer einen Moment die
  // Werte des zuletzt geoeffneten Turniers auf.
  const start = zp.startDatum || erstesGeplantesDatum(zustand) || heuteIso();
  setzeWert("zp-start-datum", start);
  setzeWert("zp-start-zeit", zp.startZeit || "10:00");
  setzeWert("zp-tages-ende", zp.tagesEnde || "22:00");
  setzeWert("zp-dauer", zp.dauerMin == null ? 60 : zp.dauerMin);
  setzeWert("zp-pause", zp.pauseMin == null ? 10 : zp.pauseMin);
  setzeWert("zp-gleichzeitig", zp.gleichzeitig == null ? 1 : zp.gleichzeitig);
  zeigeFehler("zp-fehler", "");
  zeigeFehler("zp-meldung", "");
  renderZeitplanListe(zustand);
  document.getElementById("modal-zeitplan").classList.add("aktiv");
  dlgFokusRein("modal-zeitplan");
}

function schliesseZeitplan() {
  document.getElementById("modal-zeitplan").classList.remove("aktiv");
  dlgFokusZurueck("modal-zeitplan");
}

function setzeWert(id, wert) {
  const el = document.getElementById(id);
  if (el) el.value = wert == null ? "" : String(wert);
}

function heuteIso() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

// Ist schon einmal geplant worden, ist dessen erster Tag die bessere Vorgabe
// als "heute" – sonst schlaegt der Dialog beim Nachplanen den falschen Tag vor.
function erstesGeplantesDatum(z) {
  const daten = (z.spiele || []).filter((s) => s.geplantAm).map((s) => s.geplantAm).sort();
  return daten.length ? daten[0].slice(0, 10) : "";
}

// Die Liste zum Verschieben von Hand. Sortiert nach Zeit; was noch keine hat,
// steht unten – dort fehlt ja gerade der Termin, den man sucht.
function renderZeitplanListe(z) {
  const box = document.getElementById("zp-liste");
  const hinweis = document.getElementById("zp-liste-hinweis");
  if (!box) return;
  const spiele = (z.spiele || [])
    .filter((s) => s.teamA && s.teamB && s.gemeldetVon !== "freilos")
    .sort((a, b) =>
      String(a.geplantAm || "￿").localeCompare(String(b.geplantAm || "￿")) ||
      String(a.phase).localeCompare(String(b.phase)) ||
      (Number(a.runde) || 0) - (Number(b.runde) || 0) ||
      (Number(a.position) || 0) - (Number(b.position) || 0));

  if (!spiele.length) {
    box.innerHTML = "";
    hinweis.textContent = "Sobald die Spiele ausgelost sind, stehen sie hier einzeln zum Verschieben.";
    return;
  }
  const ohne = spiele.filter((s) => !s.geplantAm).length;
  hinweis.textContent = ohne
    ? ohne + " von " + spiele.length + " Spiel(en) hat noch keine Zeit."
    : "Alle " + spiele.length + " Spiele sind terminiert.";

  // ⚠️ Nicht unter den Fingern neu bauen. Jede Änderung schickt einen Schreib-
  // vorgang los, der als Live-Änderung zurückkommt und diese Liste neu zeichnet
  // – stünde der Cursor noch in einem Feld, wäre die halbfertige Eingabe weg.
  // Der Hinweis oben wandert trotzdem mit, der kostet keine Eingabe.
  if (box.contains(document.activeElement)) return;

  box.innerHTML = spiele.map((s) => `<div class="zp-zeile${s.status === "bestaetigt" ? " fertig" : ""}">
    <span class="zp-teams">${escapeHtml(teamNameVon(z, s.teamA))} <span class="vs">vs</span> ${escapeHtml(teamNameVon(z, s.teamB))}${s.status === "bestaetigt" ? ' <span class="spieler-badge">gespielt</span>' : ""}</span>
    <input type="datetime-local" class="eingabe zp-zeit" data-zp-spiel="${escapeHtml(s.id)}" value="${escapeHtml(s.geplantAm || "")}"
           aria-label="Anstoß ${escapeHtml(teamNameVon(z, s.teamA))} gegen ${escapeHtml(teamNameVon(z, s.teamB))}">
    <input type="number" class="eingabe zp-dauer-feld" data-zp-dauer="${escapeHtml(s.id)}" value="${s.dauerMin ? escapeHtml(String(s.dauerMin)) : ""}"
           min="5" max="600" step="5" placeholder="Min"
           aria-label="Dauer in Minuten für ${escapeHtml(teamNameVon(z, s.teamA))} gegen ${escapeHtml(teamNameVon(z, s.teamB))}">
  </div>`).join("");
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
  wireRatingBlock("lobby");
  wireRatingBlock("teams");

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
    formatEntwurf.teamGroesse = Number(e.target.value) || "";
    if (zustand) renderFormatWahl(zustand);
  });
  document.getElementById("form-kotyp").addEventListener("change", (e) => {
    formatEntwurf.koTyp = e.target.value;
    if (zustand) renderFormatWahl(zustand);
  });
  document.getElementById("form-bestof").addEventListener("change", (e) => {
    formatEntwurf.bestOf = e.target.value;
    if (zustand) renderFormatWahl(zustand);
  });
  document.getElementById("form-setzliste").addEventListener("change", (e) => {
    formatEntwurf.losmodus = e.target.checked ? "setzliste" : "zufaellig";
  });
  document.getElementById("form-bestof-finale").addEventListener("change", (e) => {
    formatEntwurf.bestOfFinale = e.target.value;
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
    if (!formatEntwurf.teamGroesse) {
      return zeigeFehler("form-fehler", "Bitte oben wählen, wer zusammen spielt (1 gegen 1, 2 gegen 2 …).");
    }
    if (!formatEntwurf.ablauf) {
      return zeigeFehler("form-fehler", "Bitte oben einen Ablauf auswählen.");
    }
    const res = await turnierService.setzeTurnierform({
      teamGroesse: formatEntwurf.teamGroesse,
      ablauf: formatEntwurf.ablauf,
      koTyp: formatEntwurf.koTyp,
      bestOf: formatEntwurf.bestOf,
      bestOfFinale: formatEntwurf.bestOfFinale,
      losmodus: formatEntwurf.losmodus,
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
    willZuschauen = false;
    turnierService.waehleTurnier(karte.dataset.turnier);
  });

  // Zurück in die Turnierliste
  document.getElementById("btn-turnier-wechseln").addEventListener("click", () => {
    willMitmachen = false;
    willZuschauen = false;
    turnierService.waehleTurnier(null);
  });

  // Name fürs Einschreiben: mit Konto fest der Kontoname, nicht änderbar
  // (Michel am 02.10.2026). Ohne Konto bleibt das Feld frei.
  function loginNameSetzen() {
    const feld = document.getElementById("login-name");
    let fest = "";
    try { fest = (window.__AGELAN_KONTO__ && window.__AGELAN_KONTO__.nickname) || ""; } catch (e) { fest = ""; }
    feld.value = fest || turnierService.getGespeicherterName();
    feld.readOnly = !!fest;
    feld.classList.toggle("feld-fest", !!fest);
    feld.title = fest ? "Dein Kontoname – im Turnier stehst du immer unter diesem Namen." : "";
  }

  // Mitmachen / Zuschauen
  document.getElementById("btn-mitmachen").addEventListener("click", () => {
    willMitmachen = true;
    loginNameSetzen();
    render(zustand);
  });
  document.getElementById("btn-nur-zuschauen").addEventListener("click", () => {
    // In der Anmeldephase gibt es nur die Lobby-Liste zu sehen.
    willMitmachen = false;
    willZuschauen = true;
    render(zustand);
  });
  document.getElementById("btn-login-zurueck").addEventListener("click", () => {
    willMitmachen = false;
    render(zustand);
  });

  // Login absenden
  document.getElementById("btn-login-bestaetigen").addEventListener("click", async () => {
    const eingabe = {
      name: document.getElementById("login-name").value,
      rating: document.getElementById("login-rating").value,
    };
    let res = await turnierService.tritBei(eingabe);
    // Gleicher Name schon angemeldet: meist dieselbe Person auf einem zweiten
    // Gerät. Nur auf ausdrückliches Ja ein zweites Mal eintragen.
    if (!res.erfolg && res.doppelt) {
      if (!confirm(res.fehler + "\n\nBist du das auf einem anderen Gerät, brauchst du dich nicht noch einmal anzumelden. Ist es jemand anderes mit gleichem Namen, dann trotzdem anmelden?")) {
        zeigeFehler("login-fehler", res.fehler + " Nicht noch einmal angemeldet.");
        return;
      }
      res = await turnierService.tritBei(Object.assign({ trotzdem: true }, eingabe));
    }
    if (res.erfolg) willMitmachen = false;
    zeigeFehler("login-fehler", res.erfolg ? "" : res.fehler);
  });

  // Lobby: eigene Anmeldung zurücknehmen / als Veranstalter eine fremde herausnehmen
  document.getElementById("lobby-spielerliste").addEventListener("click", async (e) => {
    const ab = e.target.closest("[data-lobby-abmelden]");
    const weg = e.target.closest("[data-lobby-entfernen]");
    if (!ab && !weg) return;
    let res;
    if (ab) {
      if (!confirm("Deine Anmeldung zu diesem Turnier zurücknehmen?")) return;
      res = await turnierService.meldeAb();
    } else {
      const uid = weg.dataset.lobbyEntfernen;
      const sp = (zustand && zustand.spieler || []).find((x) => x.id === uid);
      if (!confirm((sp ? "„" + sp.name + "“" : "Diese Anmeldung") + " aus dem Turnier nehmen?")) return;
      res = await turnierService.entferneSpieler(uid);
    }
    zeigeFehler("lobby-fehler", res.erfolg ? "" : res.fehler);
  });

  // Lobby: als Veranstalter selbst mitspielen
  // Veranstalter trägt jemand anderen ein. Die Kontonamen kommen als
  // Vorschlagsliste (nur für ⭐/🛠 abrufbar); frei tippen geht trotzdem.
  document.getElementById("btn-lobby-fremd-auf").addEventListener("click", async () => {
    const box = document.getElementById("lobby-fremd");
    box.hidden = !box.hidden;
    if (box.hidden) return;
    document.getElementById("lobby-fremd-name").focus();
    try {
      const daten = await kontenRufe("konto-liste");
      const angemeldet = new Set(((zustand && zustand.spieler) || []).map((s) => String(s.name || "").toLowerCase()));
      document.getElementById("lobby-fremd-namen").innerHTML = (daten.konten || [])
        .map((k) => k.nickname).filter((nick) => nick && !angemeldet.has(nick.toLowerCase()))
        .sort((a, b) => a.localeCompare(b))
        .map((nick) => `<option value="${escapeHtml(nick)}"></option>`).join("");
    } catch (e) { /* ohne Vorschläge – tippen geht trotzdem */ }
  });
  document.getElementById("btn-lobby-fremd").addEventListener("click", async () => {
    const nameEl = document.getElementById("lobby-fremd-name");
    const res = await turnierService.fuegeSpielerHinzu({
      name: nameEl.value,
      rating: document.getElementById("lobby-fremd-rating").value,
    });
    zeigeFehler("lobby-fremd-fehler", res.erfolg ? "" : res.fehler);
    if (!res.erfolg) document.getElementById("lobby-fremd-ok").textContent = "";
    if (res.erfolg) {
      document.getElementById("lobby-fremd-ok").textContent = "„" + nameEl.value.trim() + "“ ist eingetragen.";
      nameEl.value = "";
      nameEl.focus();
    }
  });
  document.getElementById("btn-lobby-selbst-anmelden").addEventListener("click", () => {
    willMitmachen = true;
    loginNameSetzen();
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
    if (!confirm(`${offen} offene(s) Spiel(e) mit Zufallsergebnissen füllen? Gemeldete und bestätigte Ergebnisse bleiben stehen; die ausgewürfelten bekommst du nur über „Turnier zurücksetzen" wieder weg.`)) return;
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


  // --- Zeitplan -----------------------------------------------------------
  // Zwei Knöpfe (Gruppenphase und K.-o.), ein Dialog.
  ["btn-zeitplan-gruppen", "btn-zeitplan-ko"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", oeffneZeitplan);
  });
  document.getElementById("btn-zp-schliessen").addEventListener("click", schliesseZeitplan);
  document.getElementById("modal-zeitplan").addEventListener("click", (e) => {
    if (e.target.id === "modal-zeitplan") schliesseZeitplan();
  });

  document.getElementById("btn-zp-erzeugen").addEventListener("click", async () => {
    zeigeFehler("zp-fehler", "");
    zeigeFehler("zp-meldung", "");
    const knopf = document.getElementById("btn-zp-erzeugen");
    // ⚠️ Der Knopf wirft bestehende Zeiten weg. Ohne Rückfrage ist ein
    // Fehlklick beim Nachplanen nicht mehr zurückzuholen.
    const schonGeplant = (zustand.spiele || []).some((s) => s.geplantAm && s.status !== "bestaetigt");
    if (schonGeplant && !confirm("Die bisherigen Zeiten der noch offenen Spiele werden überschrieben. Weitermachen?")) return;
    knopf.disabled = true;
    try {
      const res = await turnierService.erzeugeZeitplan({
        startDatum: document.getElementById("zp-start-datum").value,
        startZeit: document.getElementById("zp-start-zeit").value,
        tagesEnde: document.getElementById("zp-tages-ende").value,
        dauerMin: document.getElementById("zp-dauer").value,
        pauseMin: document.getElementById("zp-pause").value,
        gleichzeitig: document.getElementById("zp-gleichzeitig").value,
      });
      zeigeFehler("zp-fehler", res.erfolg ? "" : res.fehler);
      if (res.erfolg) {
        zeigeFehler("zp-meldung", res.anzahl + " Spiel(e) terminiert.");
      }
    } finally {
      // ⚠️ In den finally-Zweig: bleibt der Knopf nach einem Netzfehler
      // gesperrt, hilft nur noch Neuladen.
      knopf.disabled = false;
    }
  });

  document.getElementById("btn-zp-loeschen").addEventListener("click", async () => {
    if (!confirm("Alle geplanten Zeiten dieses Turniers entfernen?")) return;
    zeigeFehler("zp-meldung", "");
    const res = await turnierService.loescheZeitplan();
    zeigeFehler("zp-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) zeigeFehler("zp-meldung", "Alle Zeiten entfernt.");
  });

  // Einzeln verschieben. ⚠️ Die Dauer wird MITGESCHICKT, auch wenn nur die
  // Zeit geändert wurde – sonst räumt der Service sie beim Speichern weg.
  document.getElementById("zp-liste").addEventListener("change", async (e) => {
    const feld = e.target.closest("[data-zp-spiel], [data-zp-dauer]");
    if (!feld) return;
    const sid = feld.dataset.zpSpiel || feld.dataset.zpDauer;
    const zeile = feld.closest(".zp-zeile");
    const zeitFeld = zeile.querySelector("[data-zp-spiel]");
    const dauerFeld = zeile.querySelector("[data-zp-dauer]");
    zeigeFehler("zp-meldung", "");
    const res = await turnierService.setzeSpielZeit(sid, zeitFeld.value, dauerFeld.value);
    zeigeFehler("zp-fehler", res.erfolg ? "" : res.fehler);
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
  document.getElementById("btn-ko-naechste").addEventListener("click", async () => {
    const res = await turnierService.naechsteRundeManuell();
    if (!res.erfolg) return alert(res.fehler);
    alert(res.neu > 0
      ? res.neu + (res.neu === 1 ? " neue Partie angelegt." : " neue Partien angelegt.")
      : "Nichts Neues anzulegen" + (res.offen ? " – " + res.offen + (res.offen === 1 ? " Spiel ist" : " Spiele sind") + " noch offen." : "."));
  });

  // Delegierte Aktionen für Spiel-Buttons
  document.getElementById("app").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-aktion]");
    if (!btn) return;
    spielAktionAusfuehren(btn.getAttribute("data-aktion"), btn.getAttribute("data-spiel"));
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
  document.getElementById("btn-ergebnis-zurueck").addEventListener("click", async () => {
    if (!meldeSpielId) return;
    const s = zustand.spiele.find((x) => x.id === meldeSpielId);
    if (!s) return;
    if (!confirm("Ergebnis zurücksetzen?\n" + teamNameVon(zustand, s.teamA) + " vs " + teamNameVon(zustand, s.teamB) +
      " ist danach wieder offen, als wäre es nicht gespielt.")) return;
    const res = await turnierService.setzeErgebnisZurueck(meldeSpielId);
    if (res.erfolg) schliesseMeldeDialog();
    else zeigeFehler("melden-fehler", res.fehler);
  });
  ["A", "B"].forEach((seite) => {
    document.getElementById("btn-adminwin-" + seite.toLowerCase()).addEventListener("click", async () => {
      if (!meldeSpielId) return;
      const s = zustand.spiele.find((x) => x.id === meldeSpielId);
      if (!s) return;
      const sieger = teamNameVon(zustand, seite === "A" ? s.teamA : s.teamB);
      const verlierer = teamNameVon(zustand, seite === "A" ? s.teamB : s.teamA);
      if (!confirm("Admin-Win für " + sieger + "?\n" + verlierer + " verliert dieses Spiel kampflos.")) return;
      const res = await turnierService.adminWin(meldeSpielId, seite);
      if (res.erfolg) schliesseMeldeDialog();
      else zeigeFehler("melden-fehler", res.fehler);
    });
  });

  // Admin-Dialog
  document.getElementById("btn-admin-oeffnen").addEventListener("click", oeffneAdmin);
  document.getElementById("btn-turnier-veranstalter").addEventListener("click", oeffneAdmin);
  document.getElementById("btn-admin-schliessen").addEventListener("click", schliesseAdmin);
  // ⚠️ await: die Pruefung laeuft seit 2026-09-15 ueber den Server. Ohne await
  // waere res ein Promise – und `res.erfolg` damit immer undefined.
  document.getElementById("btn-admin-anmelden").addEventListener("click", async () => {
    const res = await turnierService.authentifiziereAlsAdmin(document.getElementById("admin-pin").value);
    if (res.erfolg) oeffneAdmin();
    else zeigeFehler("admin-fehler", res.fehler);
  });
  document.getElementById("btn-admin-runde-zurueck").addEventListener("click", async () => {
    if (!confirm("Die Auslosung der letzten Runde zurücknehmen?\n\nIhre Paarungen werden gelöscht (es ist dort noch nichts gespielt). Danach kannst du Ergebnisse der Runde davor zurücksetzen oder korrigieren und neu auslosen.")) return;
    const res = await turnierService.nimmSchweizerRundeZurueck();
    zeigeFehler("admin-panel-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) {
      document.getElementById("admin-runde-zurueck-ok").textContent = "Runde " + res.runde + " ist zurückgenommen (" + res.partien + " Paarungen gelöscht).";
      oeffneAdmin();
    }
  });
  document.getElementById("btn-admin-rueckzug").addEventListener("click", async () => {
    const wahl = document.getElementById("admin-rueckzug-team");
    if (!wahl.value) return zeigeFehler("admin-panel-fehler", "Bitte ein Team wählen.");
    const name = wahl.options[wahl.selectedIndex].textContent;
    if (!confirm(name + " aus dem Turnier zurückziehen?\n\nOffene Spiele des Teams gewinnt der Gegner kampflos. Gespielte Ergebnisse bleiben. In weiteren Runden wird das Team nicht mehr gepaart.")) return;
    const res = await turnierService.zieheTeamZurueck(wahl.value);
    zeigeFehler("admin-panel-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) {
      document.getElementById("admin-rueckzug-ok").textContent = name + " ist zurückgezogen" +
        (res.kampflos ? " – " + res.kampflos + (res.kampflos === 1 ? " offenes Spiel" : " offene Spiele") + " kampflos gewertet." : ".");
      oeffneAdmin();
    }
  });
  document.getElementById("btn-admin-spielmodus").addEventListener("click", async () => {
    const res = await turnierService.setzeSpielmodus({
      bestOf: document.getElementById("admin-bestof").value,
      bestOfFinale: document.getElementById("admin-bestof-finale").value,
    });
    zeigeFehler("admin-panel-fehler", res.erfolg ? "" : res.fehler);
    if (res.erfolg) document.getElementById("admin-spielmodus-ok").textContent = "Gespeichert." +
      (res.angepasst ? " " + res.angepasst + (res.angepasst === 1 ? " bestätigtes Ergebnis wurde" : " bestätigte Ergebnisse wurden") + " an den neuen Modus angepasst – die Sieger bleiben gleich." : "");
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
    willZuschauen = false;
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
  const text = String((grund && grund.code) || "") + " " + String((grund && grund.message) || grund || "");
  // ⚠️ PERMISSION_DENIED ist seit den Regeln vom 26.09.2026 (E5) fast immer ein
  // fehlendes Recht, keine abgelaufene Anmeldung: Neuladen half nie, und alle
  // suchten den Fehler an der falschen Stelle (Fixprüfung 26.09.2026, A3-04).
  // agelan-Rolle: vielleicht ist nur der Claim verfallen - dann neu holen (gebremst).
  if (/permission|denied/i.test(text) && typeof rolleNachAblehnung === "function") rolleNachAblehnung();
  zeigeNetzFehler(
    /permission|denied/i.test(text)
      ? "Nicht gespeichert – die Datenbank hat das abgelehnt. Verwalten geht nur mit dem PIN dieses Bereichs oder am Gerät, das ihn angelegt hat."
      : /auth/i.test(text)
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
    version: "8.87",
    groups: [
      { title: "Turnier: Best of 7 und Best of 9", items: [
          "Bei der Formatwahl, beim Auslosen und im Veranstalter-Dialog gibt es jetzt auch Best of 7 (4 Siege) und Best of 9 (5 Siege) – für alle Spiele und fürs Finale. Die Dauer-Schätzung rechnet mit Ø 5,5 bzw. 7 Spielen je Partie."
      ]},
    ],
  },
  {
    version: "8.86",
    groups: [
      { title: "Turnierbaum: offene Partien auffälliger", items: [
          "Partien, die gerade laufen, haben im Baum einen goldenen Balken links, eine getönte Fläche und das Schild „▶ läuft“. Gemeldete, noch nicht bestätigte Ergebnisse sind blau markiert („? gemeldet“). Fertige Partien bleiben schlicht."
      ]},
    ],
  },
  {
    version: "8.85",
    groups: [
      { title: "Turnier: Turnierbaum", items: [
          "Über dem K.-o. gibt es den Umschalter „☰ Liste | 🌳 Turnierbaum“. Der Baum zeigt alle Runden nebeneinander, jede Partie mittig zwischen ihren beiden Vorgängern, mit Verbindungslinien – Sieger grün, laufende Partien markiert, noch wartende Partien gestrichelt mit „Sieger Partie N“. Rechts der Turniersieger, darunter das Spiel um Platz 3.",
          "Freilose der ersten Runde stehen als schmale Zeile im Baum. Auf dem Handy lässt sich der Baum seitlich wischen. Melden und Korrigieren gehen weiter in der Liste; die gewählte Ansicht merkt sich das Gerät.",
          "Nur für einfaches K.-o. – beim Doppel-K.-o. bleibt es bei der Liste.",
          "Ohne Scrollbalken: Der Baum nutzt die ganze Fensterbreite und wird verkleinert, bis er passt; nach unten läuft er mit der Seite.",
          "Partien im Baum sind anklickbar: Wer melden darf, landet direkt im Melde-Dialog, Veranstalter bei „Ergebnis korrigieren“ (mit Admin-Win). Bei einem gemeldeten Ergebnis erscheint eine kleine Auswahl „Bestätigen / Widersprechen“."
      ]},
    ],
  },
  {
    version: "8.84",
    groups: [
      { title: "Essen: „Bestellung vollständig“", items: [
          "Ist in „Lieferung prüfen“ alles abgehakt, klappt die Liste zu und zeigt „✅ Bestellung vollständig“. Ein Klick auf den Kopf öffnet sie wieder, z. B. um einen Haken zu lösen."
      ]},
    ],
  },
  {
    version: "8.83",
    groups: [
      { title: "Essen: „Deine Bestellungen“ einklappbar", items: [
          "„Deine Bestellungen“ lässt sich mit einem Klick auf die Überschrift zuklappen; daneben steht z. B. „1 laufend · 4 erledigt“.",
          "Abgeholte Bestellungen stehen gesammelt unter „Abgeholt – erledigt“ und sind anfangs zugeklappt. Beides merkt sich das Gerät."
      ]},
    ],
  },
  {
    version: "8.82",
    groups: [
      { title: "Essen: Lieferungen filtern", items: [
          "Über „Beim Lieferanten“ gibt es die Filter „Alle“, „Nicht abgeschlossen“ und „Abgeschlossen“ mit Anzahl. So lassen sich Lieferungen, die komplett abgeholt sind, ausblenden. Die Wahl merkt sich das Gerät."
      ]},
    ],
  },
  {
    version: "8.81",
    groups: [
      { title: "Essen: Foodbot heißt jetzt Age Lan Bot", items: [
          "Alle Hinweise an der Lieferung sprechen vom „Age Lan Bot“ statt vom „Foodbot“."
      ]},
    ],
  },
  {
    version: "8.80",
    groups: [
      { title: "Turnier: Runden einklappbar", items: [
          "Jede Runde (K.-o., Verliererbaum, Schweizer Runden und Spieltage) lässt sich mit einem Klick auf die Überschrift ein- und ausklappen. Daneben steht, wie viele Partien fertig sind, z. B. „3/4“ – Freilose zählen nicht mit, noch wartende K.-o.-Partien schon.",
          "Fertige Runden sind von selbst zugeklappt, laufende offen. Wer selbst auf- oder zuklappt, behält seine Wahl."
      ]},
    ],
  },
  {
    version: "8.79",
    groups: [
      { title: "Frühstück: begrenzte Pakete", items: [
          "Pakete können eine Menge je Morgen bekommen (z. B. Hähnchen 12). Beim Bestellen steht dann „noch 5 von 12“; sind alle gebucht, ist das Paket ausgegraut und als „ausgebucht“ markiert. Leer oder 0 heißt unbegrenzt.",
          "Die eigene Bestellung zählt nicht gegen sich selbst – wer schon Hähnchen hat, kann seine Bestellung weiter ändern."
      ]},
    ],
  },
  {
    version: "8.78",
    groups: [
      { title: "Essen: Gerichte ausblenden", items: [
          "In „Speisekarte verwalten“ hat jedes Gericht ein Auge 👁: Ein Klick blendet es vorübergehend aus (🙈), es steht dann nicht mehr in der Bestellkarte, bleibt aber mit Nummer, Preis und Platz auf der Karte. Ein zweiter Klick zeigt es wieder an.",
          "Ausgeblendete Gerichte lassen sich nicht neu bestellen; in schon abgeschickten Bestellungen bleiben sie stehen."
      ]},
    ],
  },
  {
    version: "8.77",
    groups: [
      { title: "Turnier: Ergebnis und Runde zurücknehmen", items: [
          "Im Dialog „Ergebnis korrigieren“ gibt es für Veranstalter „↺ Ergebnis zurücksetzen“: Das Spiel ist danach wieder offen, als wäre es nicht gespielt. Geht nur, solange nichts darauf aufbaut (keine spätere Schweizer Runde, kein K.-o.-Folgespiel).",
          "Im Veranstalter-Dialog lässt sich im Schweizer System die Auslosung der letzten Runde zurücknehmen – solange dort noch nichts gemeldet ist. Danach Ergebnisse korrigieren und neu auslosen."
      ]},
    ],
  },
  {
    version: "8.76",
    groups: [
      { title: "Fehlerbehebungen", items: [
          "Turnier: Partienummern im K.-o. bleiben fest. Seit die nächste Runde Partie für Partie entsteht, konnte eine schon angesagte Partie eine Nummer weiterrutschen, wenn davor noch eine Partie der vorigen Runde angelegt wurde. Noch nicht angelegte Partien des Baums zählen jetzt schon mit; die wartenden Karten zeigen ihre spätere Nummer.",
          "Turnier: Wer schon vom Veranstalter eingetragen ist, bekommt beim eigenen Anmelden einen passenden Hinweis statt „von einem anderen Gerät aus“."
      ]},
    ],
  },
  {
    version: "8.75",
    groups: [
      { title: "Essen: Foodbot meldet „bestellt“", items: [
          "Sobald eine Sammelbestellung als rausgeschickt festgehalten wird, schreibt der Foodbot allen darin per Discord: „Deine Bestellung wurde soeben beim Pizzalieferanten bestellt – Bestellung 8 am Freitag“, dazu die eigenen Posten. An der Lieferung steht, wie viele erreicht wurden und wer nicht (z. B. ohne Discord-ID); bei einem Fehler gibt es „erneut senden“.",
          "Geht nur mit ⭐/🛠-Konto, wie „Bescheid geben“. Braucht die neue Worker-Fassung."
      ]},
    ],
  },
  {
    version: "8.74",
    groups: [
      { title: "Turnier: Ergebnisse folgen dem Spielmodus", items: [
          "Wird der Spielmodus im Veranstalter-Dialog umgestellt, passen sich bestätigte Ergebnisse automatisch an – der Sieger bleibt derselbe: Bo5 3:1 wird Bo3 2:1, 3:0 wird 2:0. Freilose, Admin-Wins und kampflose Spiele werden zu „nötige Siege : 0“."
      ]},
    ],
  },
  {
    version: "8.73",
    groups: [
      { title: "Turnier: wartende Partien sichtbar", items: [
          "Steht im K.-o. eine Partie der nächsten Runde noch nicht fest, erscheint an ihrer Stelle eine Karte „wartet auf Partie 1“ – mit dem schon feststehenden Namen und „Sieger Partie 1“ für die offene Seite. So fehlt niemand mehr scheinbar im Baum."
      ]},
    ],
  },
  {
    version: "8.72",
    groups: [
      { title: "Übersicht: alle offenen K.-o.-Partien", items: [
          "Die Turnier-Kachel zeigte im K.-o. nur die Partien der frühesten noch offenen Runde – seit die nächste Runde Partie für Partie entsteht, fehlten so alle schon spielbaren Partien. Jetzt stehen alle offenen K.-o.-Partien da."
      ]},
    ],
  },
  {
    version: "8.71",
    groups: [
      { title: "Turnier: K.-o. Partie für Partie", items: [
          "Im einfachen K.-o. muss nicht mehr die ganze Runde fertig sein: Sobald die beiden Spiele feststehen, aus denen eine Partie der nächsten Runde hervorgeht, wird sie angelegt und kann gespielt werden. Ein Spiel, das sich zieht, hält nur noch seinen eigenen Zweig auf.",
          "„Nächste Runde manuell prüfen“ sagt jetzt, was passiert ist – „2 neue Partien angelegt“ oder „Nichts Neues – 1 Spiel ist noch offen“.",
          "Rundennamen richten sich nach der Größe des Baums: ein erst halb angelegtes Halbfinale heißt nicht mehr „Finale“."
      ]},
    ],
  },
  {
    version: "8.70",
    groups: [
      { title: "Turnier: Team zurückziehen", items: [
          "Im Veranstalter-Dialog gibt es in der Vorrunde „Team zurückziehen“: Das Team wird ab sofort nicht mehr gepaart und verschwindet aus der Tabelle. Seine offenen Spiele gewinnt der Gegner kampflos, gespielte Ergebnisse bleiben und zählen für die Gegner weiter. Bisherige Paarungen und Partienummern bleiben unverändert."
      ]},
      { title: "Downloads: Klickzähler für Linux", items: [
          "Neu im Download-Bereich: der AoE2-Klickzähler (Spieler) als Linux-Datei, mit kurzer Anleitung zum Einrichten.",
          "Linux-Spieler erscheinen beim Turnierleiter wie alle anderen – gleicher Turnier-Code, gleiches Netzwerk."
      ]},
    ],
  },
  {
    version: "8.69",
    groups: [
      { title: "Übersicht: Turnier 30 Sekunden", items: [
          "Die Turnier-Kachel steht auf der Übersicht jetzt mindestens 30 Sekunden (die anderen weiter 15). Hat sie mehr als drei Seiten, bleibt sie, bis jede Seite ihre 10 Sekunden hatte."
      ]},
    ],
  },
  {
    version: "8.68",
    groups: [
      { title: "Übersicht: laufende Turniere live", items: [
          "Sobald ein Turnier ausgelost ist, zeigt die Turnier-Kachel der Übersicht statt der Turnierliste die offenen Partien – je Turnier eine Seite mit Partienummer, Paarung und Modus. Die Seiten wechseln alle 10 Sekunden, die Kachel bleibt so lange stehen, bis alle einmal dran waren.",
          "Gemeldete, noch nicht bestätigte Ergebnisse stehen als „Ergebnis gemeldet“ dabei. Läuft daneben noch eine Anmeldung, kommt sie als letzte Seite."
      ]},
    ],
  },
  {
    version: "8.67",
    groups: [
      { title: "Turnier: Admin-Win", items: [
          "Im Dialog „Ergebnis melden/korrigieren“ gibt es für Veranstalter „🏳 Admin-Win“ je Team: Kommt ein Spiel nicht zustande, wird es dem einen Team zugesprochen, das andere verliert kampflos. Gewertet mit den nötigen Sätzen zu 0 (Bo3 = 2:0), markiert als „Admin-Win“. Korrigieren geht danach wie gewohnt mit ✎."
      ]},
    ],
  },
  {
    version: "8.66",
    groups: [
      { title: "Turnier: Bedingungen sichtbar", items: [
          "Über jedem Turnier stehen die Turnierbedingungen, z. B. „1 gegen 1 · Nur K.-o. (einfaches K.-o., mit Spiel um Platz 3) · Spiele: Best of 3 (2 Siege nötig) · Finale: Best of 5“.",
          "Im K.-o.-Baum steht bei jedem Spiel dabei, was gespielt wird: „Partie 4 · Best of 3“, beim Finale ggf. „Best of 5 (Finale)“."
      ]},
    ],
  },
  {
    version: "8.65",
    groups: [
      { title: "Turnier: Partienummern", items: [
          "Jede Partie hat eine fortlaufende Nummer über das ganze Turnier – in der Vorrunde als „#7“ vor der Paarung, im K.-o.-Baum als „Partie 23“ über dem Spiel. Freilose zählen nicht mit. Neue Runden werden hinten angehängt, die Nummern bisheriger Partien bleiben."
      ]},
    ],
  },
  {
    version: "8.64",
    groups: [
      { title: "Turnier: keine Doppelanmeldung mehr", items: [
          "Wer mit Konto angemeldet ist, kann sich nicht ein zweites Mal von einem anderen Gerät ins selbe Turnier eintragen. Bisher ging das nach einer Rückfrage – so standen zwei Spieler doppelt im Baum."
      ]},
    ],
  },
  {
    version: "8.63",
    groups: [
      { title: "Turnier: Freilose kompakt", items: [
          "Im K.-o.-Baum stehen Freilose nicht mehr als eigene Karten, sondern in einer Zeile über den Spielen der Runde („29 Freilose – direkt in der nächsten Runde: …“). Zu sehen sind nur noch die Spiele, die wirklich gespielt werden."
      ]},
    ],
  },
  {
    version: "8.62",
    groups: [
      { title: "Turnier: Veranstalter-Knopf sichtbar", items: [
          "Neben „← Alle Turniere“ steht jetzt „⚙️ Veranstalter“. Darüber gehen PIN-Anmeldung, Spielmodus, Zurücksetzen und Löschen – vorher nur über das kleine ⚙️ oben rechts."
      ]},
    ],
  },
  {
    version: "8.61",
    groups: [
      { title: "Turnier: Teamgröße muss gewählt werden", items: [
          "Bei der Formatwahl stand „Wer spielt zusammen?“ von selbst auf „2 gegen 2“ – so wurde das Turnier „1vs1“ versehentlich als 2 gegen 2 ausgelost. Solange kein Format festgelegt ist, steht dort jetzt „– bitte wählen –“, und ohne Wahl lässt sich nichts festlegen."
      ]},
    ],
  },
  {
    version: "8.60",
    groups: [
      { title: "Turnier: Veranstalter trägt andere ein", items: [
          "In der Anmeldung gibt es für Veranstalter „＋ Andere:n eintragen“: Name (Vorschläge aus der Kontoliste) und 1vs1-Elo eingeben, fertig. Für alle, die sich nicht selbst anmelden können. Herausnehmen geht wie gewohnt mit dem Papierkorb."
      ]},
    ],
  },
  {
    version: "8.59",
    groups: [
      { title: "Turnier: Setzliste schon bei der Formatwahl", items: [
          "Bei „Format festlegen“ gibt es das Häkchen „Nach Setzliste auslosen“. Angehakt werden die Stärksten nach Elo verteilt (in Gruppen auf verschiedene Gruppen, im K.-o. und Schweizer System treffen sie erst spät aufeinander); ohne Haken wird rein zufällig gelost. Beim Auslosen ist die Wahl vorbelegt und noch änderbar."
      ]},
    ],
  },
  {
    version: "8.58",
    groups: [
      { title: "Turnier: Best-of schon bei der Formatwahl", items: [
          "Bei „Format festlegen“ gibt es jetzt „Modus je Spiel“ (Best of 1/3/5) und „Finale“ (Best of 3/5). Die Auswahl wird mit dem Format gespeichert und beim Auslosen vorbelegt.",
          "Die Dauer auf den Format-Karten rechnet mit dem gewählten Modus: Best of 3 im Schnitt 2,5 Spiele, Best of 5 im Schnitt 4 Spiele je Partie, das Finale mit seinem eigenen Modus."
      ]},
    ],
  },
  {
    version: "8.57",
    groups: [
      { title: "Turnier: Best of 1 / 3 / 5", items: [
          "Beim Auslosen gibt es für die Spiele jetzt Best of 1, Best of 3 und Best of 5, fürs Finale Best of 3 oder Best of 5.",
          "Im Veranstalter-Dialog („Veranstalter“) lässt sich der Modus auch bei laufendem Turnier noch ändern. Das gilt für alle Spiele, die noch nicht bestätigt sind – solange ein Ergebnis gemeldet, aber nicht bestätigt ist, wird die Änderung abgelehnt.",
          "Bei Best of 1 sagt der Melde-Dialog „1:0 oder 0:1“."
      ]},
    ],
  },
  {
    version: "8.56",
    groups: [
      { title: "Turnier: ungefähre Dauer je Format", items: [
          "Bei der Formatwahl steht auf jeder Karte die ungefähre Dauer, z. B. „Dauer ca. 6 h 15 min – 7 Runden à 45 min + je 10 min Pause“. Gerechnet mit 45 Minuten je Partie und 10 Minuten Pause zwischen den Runden; alle Partien einer Runde laufen gleichzeitig, die Runden nacheinander. Best-of-3 ist nicht eingerechnet."
      ]},
    ],
  },
  {
    version: "8.55",
    groups: [
      { title: "Turnier: Name = Kontoname", items: [
          "Beim Einschreiben ins Turnier steht fest der Kontoname im Feld und lässt sich nicht mehr ändern. So taucht im Turnier niemand unter einem Namen auf, den es in der Kontoliste nicht gibt."
      ]},
    ],
  },
  {
    version: "8.54",
    groups: [
      { title: "Essen: Dressing beim Salat", items: [
          "Bei Salaten gibt es im Warenkorb eine Auswahl „🥗 Essig und Öl“ (Standard) oder „Dressing nach Art des Hauses“. Die Wahl steht in der Bestellung und in der Mail an den Lieferanten."
      ]},
    ],
  },
  {
    version: "8.53",
    groups: [
      { title: "Schutz gegen Manipulation", items: [
          "Essen: Kostenlose Orga-Bestellungen nimmt die Datenbank nur noch von Konten mit gültiger ⭐/🛠-Rolle an, und kein Gericht kann billiger als auf der Karte bestellt werden. Vorher ließ sich beides über die Browser-Konsole fälschen.",
          "Frühstück: Der Bestellschluss und der Annahme-Schalter gelten jetzt auch in der Datenbank. Ein Gerät mit falscher Uhr kann nicht mehr nachbestellen.",
          "Turnier: Neue Turniere lassen sich nur noch mit ⭐/🛠-Konto anlegen. Spieler können keine gefälschten Ergebnisse oder Sieger mehr in die K.-o.-Runde schreiben – den Turniersieg trägt immer ein Gerät ein, das nicht zum Siegerteam gehört."
      ]},
    ],
  },
  {
    version: "8.52",
    groups: [
      { title: "Fehlersuche über das ganze Tool", items: [
          "Essen: Ein Doppelklick auf „Bestellung abschicken“ legte bei langsamem WLAN zwei Bestellungen an. Der Knopf ist jetzt während des Sendens gesperrt.",
          "Essen: Ein Doppelklick auf einen Status-Knopf (z. B. „Hat bezahlt“) sprang zwei Schritte weiter – etwa gleich auf „abgeholt“. Status-Knöpfe sind nach einem Klick kurz gesperrt.",
          "Essen: Eine Orga-Bestellung, die auf „zahlt“ umgestellt wird, springt jetzt auf „offen“ zurück und taucht wieder unter „noch zu kassieren“ auf. Vorher blieb sie als bezahlt stehen und wurde nie kassiert.",
          "Essen: In der Kassenliste steht bei Orga-Essen „kostenlos 🛠“ statt des vollen Preises.",
          "Essen und Frühstück: Lehnt die Datenbank eine Änderung ab (z. B. abgelaufene Veranstalter-Rechte), kommt jetzt eine Meldung statt eines Knopfs, der still nichts tut.",
          "Frühstück: Der Text-Export zählt nach Paket wie die Einkaufsliste – ein umbenanntes Paket stand vorher doppelt drin.",
          "Frühstück: Ein leeres Bestellschluss-Feld wurde still zu 20:00 Uhr. Jetzt kommt eine Meldung.",
          "Frühstück: Beim Öffnen wird der nächste noch bestellbare Morgen gezeigt, nicht ein schon vergangener.",
          "Neue Version: Das automatische Neuladen wartet jetzt auch, solange eine Frühstücksauswahl nicht gespeichert ist oder ein Dialog offen ist.",
          "Stream: Sicherheitslücke geschlossen – präparierte Einträge konnten Code auf fremden Geräten ausführen.",
          "Stream: Ein Ziehen im Kalender, das von einem Live-Update unterbrochen wurde, konnte später den eigenen Eintrag auf eine falsche Zeit verschieben.",
          "Turnier: Beim Wechsel zwischen Turnieren blieb der Format-Entwurf des vorigen stehen und konnte versehentlich gespeichert werden.",
          "Turnier: Datumsfelder der Spieltage verlieren beim Tippen nicht mehr die Eingabe durch Live-Updates.",
          "Weniger unnötige Datenbank-Last durch wiederholte PIN-Prüfungen bei Frühstück und Turnier."
      ]},
    ],
  },
  {
    version: "8.51",
    groups: [
      { title: "Frühstück: zwischen den Tagen blättern", items: [
          "In der Tageskarte gibt es links und rechts Pfeile ‹ › zum vorherigen und nächsten Morgen – so lässt sich auch schon für die folgenden Tage bestellen.",
          "Die Tag-Knöpfe über der Karte waren am PC versteckt (eine Regel des Streamplans hat sie mit ausgeblendet). Jetzt stehen sie überall da.",
          "Wer am aktuellen Morgen etwas geändert, aber nicht gespeichert hat, wird vor dem Wechsel gefragt."
      ]},
    ],
  },
  {
    version: "8.50",
    groups: [
      { title: "Frühstück: Name änderbar", items: [
          "In den Frühstücks-Einstellungen gibt es jetzt das Feld „Name der Bestellung (Überschrift)“. Bisher ließ sich der Name nach dem Anlegen nicht mehr ändern.",
          "Oben auf der Frühstücksseite steht jetzt gut sichtbar: „💰 Bezahlt wird morgens an der Vertrauenskasse.“"
      ]},
    ],
  },
  {
    version: "8.49",
    groups: [
      { title: "Essen: Abholen per Häkchen", items: [
          "In jeder Lieferung hat jede bezahlte Bestellung vorn ein Häkchen: antippen = abgeholt, nochmal = doch nicht. Ohne Aufklappen. Unbezahlte Bestellungen haben kein Häkchen – dort zuerst „Hat bezahlt“."
      ]},
    ],
  },
  {
    version: "8.48",
    groups: [
      { title: "Essen: nach Nummer sortiert", items: [
          "In jeder Lieferung stehen die Bestellungen, die Abhakliste und die Nummern in der Bestellzeile jetzt nach Kartennummer sortiert (3 vor 12 vor 43) – Bestellungen mit mehreren Gerichten nach ihrer kleinsten Nummer."
      ]},
    ],
  },
  {
    version: "8.47",
    groups: [
      { title: "Essen: welche Bestellung", items: [
          "Bei „Deine Bestellungen“ steht jetzt, mit welcher Sammelbestellung das Essen zum Lieferanten ging (z. B. „📦 Bestellung 2 am Donnerstag“) und wann es abgegeben wurde."
      ]},
      { title: "Fehler behoben", items: [
          "Warenkorb: Ein eingetippter Name ging verloren, sobald man ein Extra wählte, ein Gericht dazunahm oder eins entfernte.",
          "Ein älterer, längerer Sonderwunsch wurde beim Ändern der Bestellung still auf 50 Zeichen gekürzt.",
          "Von Hand getipptes „+ Käse“ im Sonderwunsch sah aus wie ein Extra, wurde aber je nach Lage berechnet oder nicht. Extras gibt es jetzt nur über die Auswahl.",
          "Ändert der Veranstalter eine fremde Bestellung, bleibt sie auf dem Namen des Bestellers – vorher landete sie unter dem eigenen Spitznamen.",
          "Lieferung prüfen: zwei gleichnamige Gerichte ohne Nummer werden getrennt abgehakt; Haken alter Lieferungen werden aufgeräumt."
      ]},
    ],
  },
  {
    version: "8.46",
    groups: [
      { title: "Essen: Nummern in der Bestellzeile", items: [
          "Auch zugeklappt steht bei jeder Bestellung jetzt die Kartennummer neben dem Namen, z. B. „Breznsoiza  Nr. 12 · 2× Nr. 7“ – zum schnellen Finden bei der Ausgabe."
      ]},
    ],
  },
  {
    version: "8.45",
    groups: [
      { title: "Essen: Lieferung prüfen", items: [
          "In jeder Lieferung steht über den Bestellungen „📋 Lieferung prüfen“: alle Positionen zusammengezählt, mit Nummer und Sonderwunsch, zum Abhaken, wenn das Essen kommt. Oben steht, wie viel schon abgehakt ist – bei allem „✅ alles da“. Die Haken merkt sich das Gerät, auf dem abgehakt wird."
      ]},
    ],
  },
  {
    version: "8.44",
    groups: [
      { title: "Essen: Nummern an den Bestellungen", items: [
          "In „Alle Bestellungen“, bei „Deine Bestellungen“ und in der Mail-Vorschau steht vor jedem Gericht die Nummer der Speisekarte, z. B. „1× Nr. 12 Bolognese“."
      ]},
    ],
  },
  {
    version: "8.43",
    groups: [
      { title: "Essen: Extras zum Auswählen", items: [
          "Im Warenkorb gibt es je Gericht eine Auswahl „➕ Extra dazu …“ mit typischen Zutaten. Käse, Thunfisch und Hähnchen kosten 1,50 €, alle anderen Extras 1 € – der Preis der Zeile rechnet sich sofort mit. Gewählte Extras stehen als Knöpfe darunter und lassen sich mit ✕ wieder entfernen.",
          "Daneben bleibt ein Feld für Sonstiges (z. B. „ohne Zwiebeln“) – das kostet nichts extra. Bei Getränken, Salaten und Desserts gibt es keine Extras."
      ]},
    ],
  },
  {
    version: "8.42",
    groups: [
      { title: "Speisekarte: Salate", items: [
          "Bei jedem Salat steht jetzt dabei: „Wird mit Essig und Öl oder Dressing nach Art des Hauses geliefert.“"
      ]},
    ],
  },
  {
    version: "8.41",
    groups: [
      { title: "Übersicht: wer noch zahlen muss", items: [
          "Die Essen-Kachel der Übersicht zeigt „💶 Noch nicht bezahlt – bitte zur Kasse“ mit den Namen aller, deren Bestellung noch offen ist – ohne Beträge, ohne Orga-Essen. Wer mehrere offene Bestellungen hat, steht einmal mit Anzahl da."
      ]},
    ],
  },
  {
    version: "8.40",
    groups: [
      { title: "Live-Verbindung und Frühstücks-Export", items: [
          "Kommt das Gerät zurück – Tab wieder vorn, Fenster wieder im Fokus, WLAN wieder da –, baut die Seite die Verbindung zur Datenbank sofort neu auf. Neue Bestellungen stehen an der Kasse dann gleich da, ohne Neuladen. Fehlt die Verbindung, steht oben „🔴 Keine Verbindung“.",
          "Frühstück: Unter den Bestellungen eines Morgens kopiert „📋 Als Text kopieren“ nur die Mengen je Paket und die Summe – ohne Namen und Preise, zum Einfügen in WhatsApp oder eine Mail."
      ]},
    ],
  },
  {
    version: "8.39",
    groups: [
      { title: "Schneller laden, von selbst aktuell", items: [
          "Die Seite lädt ihre Bausteine jetzt gleichzeitig statt einen nach dem anderen – am Handy spürbar schneller nach dem Anmelden.",
          "Ist eine neue Version online, laden alle Geräte von selbst neu, auch Beamer und Handys auf der Essensseite. Tippt gerade jemand oder liegt eine angefangene Bestellung im Korb, wartet das Neuladen; oben steht dann „Neue Version da“ mit einem Knopf zum sofortigen Neuladen.",
          "Essen: Kommen neue Bestellungen, nachdem der Mailtext schon geöffnet oder kopiert wurde, steht jetzt ein deutlicher Hinweis mit „Text mit allen Bestellungen neu erzeugen“ darunter.",
          "Frühstück: Die Einstellungen sind wie die Pakete zugeklappt; die Kopfzeile zeigt Annahme, Tage und Bestellschluss."
      ]},
    ],
  },
  {
    version: "8.38",
    groups: [
      { title: "Essen: Bestellungen filtern", items: [
          "In der Essensverwaltung sind die Zähler „alle / offen / bezahlt / bestellt / abgeholt“ jetzt Filter: ein Tipp zeigt nur die Bestellungen mit diesem Stand, egal ob im Stapel oder schon beim Lieferanten. Noch einmal tippen oder „alle“ zeigt wieder alles.",
          "Frühstück: Die Pakete in der Verwaltung sind zugeklappt, in der Kopfzeile steht die Anzahl."
      ]},
    ],
  },
  {
    version: "8.37",
    groups: [
      { title: "Frühstück auf Vertrauensbasis", items: [
          "In der Frühstücksverwaltung gibt es keine Haken „abgeholt“ und „bezahlt“ und keine Abrechnung mehr – das Frühstück läuft auf Vertrauensbasis. Es bleiben die Einkaufsliste und je Morgen, wer wie viel von welchem Paket bestellt hat."
      ]},
    ],
  },
  {
    version: "8.36",
    groups: [
      { title: "Mail an den Lieferanten nummeriert", items: [
          "Der Betreff der Sammelbestellung heißt jetzt „Bestellung 1 am Donnerstag“. Die Nummer zählt je Tag hoch, am nächsten Tag geht es wieder bei 1 los. Eine schon verschickte Sammelbestellung behält ihre Nummer."
      ]},
    ],
  },
  {
    version: "8.35",
    groups: [
      { title: "Verwalten mit ⭐/🛠-Konto repariert", items: [
          "Die Berechtigung, mit der ein ⭐/🛠-Konto ohne PIN verwaltet, kam bei der Datenbank nicht an: im Worker steckte der Schlüssel eines anderen Firebase-Projekts. Das ist behoben – Turnier, Frühstück, Essen und die Einstellungen der Übersicht lassen sich mit ⭐/🛠 wieder ohne PIN verwalten.",
          "Übersicht-Einstellungen und Allgemeine Infos: Lehnt die Datenbank ab, holt das Gerät die Berechtigung einmal neu und speichert noch einmal. Klappt es trotzdem nicht, steht die Ursache in einem Satz da, statt dass nichts passiert."
      ]},
    ],
  },
  {
    version: "8.34",
    groups: [
      { title: "Allgemeine Infos auf der Übersicht", items: [
          "Unter Einstellungen gibt es ein Feld „Allgemeine Infos“. Was dort steht, läuft auf der Übersicht als eigene Kachel „ℹ️ Infos“ mit durch. Jede Zeile wird ein Punkt, eine Zeile mit # am Anfang eine Zwischenüberschrift. Leer gelassen erscheint die Kachel nicht."
      ]},
    ],
  },
  {
    version: "8.33",
    groups: [
      { title: "Übersicht als Anzeigebildschirm", items: [
          "Die Übersicht zeigt immer nur eine Kachel, groß, und wechselt alle 15 Sekunden zur nächsten: Essen, Frühstück, Orga, Turnier. Unten steht, welche gerade dran ist, mit einem Balken bis zum nächsten Wechsel; ein Tipp auf einen Namen springt direkt dorthin.",
          "Das Feld für Hell/Dunkel steht jetzt unter Einstellungen statt auf der Übersicht. Automatisch nach der Sonne bleibt der Standard.",
          "Über der Übersicht steht nur noch der Name der Veranstaltung, ohne „Streamplan“."
      ]},
    ],
  },
  {
    version: "8.32",
    groups: [
      { title: "Hell und Dunkel nach der Sonne", items: [
          "Oben auf der Übersicht gibt es ein großes Feld für Hell/Dunkel. Tippen schaltet Automatisch → Hell → Dunkel. Die Wahl gilt für dieses Gerät.",
          "Automatisch (Standard) richtet sich nach Sonnenaufgang und Sonnenuntergang in Volkmarsen: tagsüber hell, abends und nachts dunkel. Das Feld zeigt, wann als Nächstes umgeschaltet wird; die Seite wechselt von selbst, ohne Neuladen."
      ]},
    ],
  },
  {
    version: "8.31",
    groups: [
      { title: "Übersicht neu sortiert und einstellbar", items: [
          "Die Stream-Kachel ist aus der Übersicht raus.",
          "Essen und Frühstück stehen groß über die ganze Breite und sagen oben auf einen Blick, ob gerade bestellt werden kann – oder ob es im Moment kein Essen gibt. Beim Frühstück steht je Morgen dabei, welche Pakete wie oft bestellt sind.",
          "Ganz unten steht das Turnier, offene Anmeldungen zuerst und mit eigenem Hinweis.",
          "Unter Einstellungen wählen Veranstalter und Orga, welche Kacheln auf der Übersicht erscheinen. Das gilt für alle, nicht nur für das eigene Gerät."
      ]},
    ],
  },
  {
    version: "8.30",
    groups: [
      { title: "Kontoliste lädt von selbst", items: [
          "Einstellungen: Die Liste der angemeldeten Nutzer lädt beim Öffnen des Reiters von selbst und hält sich danach alle 30 Sekunden im Hintergrund aktuell. Der Knopf „Liste laden“ ist weg; darüber steht, wann zuletzt aktualisiert wurde. Neu gezeichnet wird nur, wenn sich wirklich etwas geändert hat – Suche und Filter bleiben stehen."
      ]},
    ],
  },
  {
    version: "8.29",
    groups: [
      { title: "Kontoliste durchsuchen und filtern", items: [
          "Einstellungen: Über der Liste der angemeldeten Nutzer gibt es jetzt ein Suchfeld für den Namen und Filter für Veranstalter, Orga, Streamer, ohne Streamer-Haken und ohne Discord-ID – jeweils mit der Anzahl. Suche und Filter bleiben stehen, wenn ein Haken gesetzt wird und die Liste sich neu lädt."
      ]},
    ],
  },
  {
    version: "8.28",
    groups: [
      { title: "Übersicht zeigt den Gesamtstand", items: [
          "Essen: Die Übersicht zeigt jetzt für alle, wann jede Lieferung beim Lieferanten bestellt wurde, ob sie schon da ist und seit wann, wie viel davon abgeholt ist und wie viele Bestellungen für die nächste Sammelbestellung gesammelt sind. Die letzten Lieferungen stehen mit ihrer Lieferzeit darunter. Die Kachel „Mein Essen“ ist weg – die eigene Bestellung steht im Reiter Essen.",
          "Frühstück: Statt „Du hast bestellt“ zeigt die Übersicht für jeden kommenden Morgen, wie viele bestellt haben, wie viele Pakete es sind und ob noch bestellt werden kann."
      ]},
    ],
  },
  {
    version: "8.27",
    groups: [
      { title: "Fehlerbehebungen bei Essen und Verwaltung", items: [
          "Essen: „📣 Bescheid geben“ erreicht jetzt auch große Sammelbestellungen. Vorher bekam ab dem 26. Besteller niemand mehr eine Discord-Nachricht; jetzt schickt die App in mehreren Durchgängen, ohne die schon Erreichten doppelt anzuschreiben.",
          "Veranstalter- und Orga-Konto (⭐/🛠): Nach dem Neuladen oder in einem zweiten Tab erneuert sich die Verwaltung wieder rechtzeitig von selbst. Vorher fiel sie 24 Stunden nach dem ersten Holen weg, bis die Seite sie später wieder auffrischte.",
          "Essen: Lehnt die Datenbank das Lesen von Telefonnummer und Lieferanten-Mail einmal ab, versucht die App es nach einer Minute oder mit erneuerter Anmeldung wieder. Beim Speichern der Einstellungen werden die beiden Angaben nicht mehr mit leeren Feldern überschrieben, wenn sie gerade nicht gelesen waren."
      ]},
    ],
  },
  {
    version: "8.26",
    groups: [
      { title: "Veranstalter- und Orga-Konto verwalten ohne PIN", items: [
          "Wer per Konto Veranstalter (⭐) oder Orga (🛠) ist, verwaltet Turnier, Stream, Frühstück und Essen ohne PIN: die App meldet das Gerät dazu über das Konto bei der Datenbank an. Das gilt 24 Stunden und erneuert sich von selbst, solange die Seite offen ist oder neu geöffnet wird.",
          "Solange das nicht eingerichtet ist oder einmal nicht klappt, bleibt alles wie bisher: der Kasten „Veranstalter“ zeigt das PIN-Feld und sagt, warum. Wird ⭐/🛠 abgenommen, ist die Verwaltung in der App sofort weg und in der Datenbank spätestens nach 24 Stunden."
      ]},
    ],
  },
  {
    version: "8.25",
    groups: [
      { title: "Meldungen und Randfälle vor der AGE LAN", items: [
          "Lehnt die Datenbank einen Schritt ab, steht jetzt dort, woran es meist liegt – am fehlenden PIN des Bereichs – statt „Anmeldung abgelaufen“, „Regeln neu veröffentlichen“ oder „versuch es noch einmal“.",
          "Essen: Lehnt die Datenbank „Ist raus“ oder das Festhalten von „Bescheid geben“ ab, bleiben Mailtext und Nachfassliste stehen, und die App sagt, dass Mail bzw. Nachrichten schon raus sind – damit nichts ein zweites Mal hinausgeht. Ist die Lieferanten-Mail ohne PIN nicht lesbar, sagt die App das, statt „trag sie ein“ zu verlangen.",
          "Turnier: Bestätigen zwei Teams im K.-o. fast gleichzeitig, erscheint keine falsche Fehlermeldung mehr, und eine dabei liegen gebliebene Folgerunde legt das nächste Gerät eines Spielers von selbst an.",
          "Essen: Eine Bestellung aus der Zeit vor dem 04.09. lässt sich wieder selbst ändern. Hängt eine an einer inzwischen gelöschten Sammelbestellung, bietet die App dort kein Ändern oder Stornieren mehr an, das die Datenbank dann doch ablehnt – das geht über die Orga."
      ]},
    ],
  },
  {
    version: "8.24",
    groups: [
      { title: "Veranstalter- und Orga-Konto: PIN je Bereich", items: [
          "Wer nur – ohne PIN – über sein Konto (⭐/🛠) Veranstalter oder Orga ist, sieht in Turnier, Stream, Frühstück und Essen wieder das PIN-Feld. Die Verwaltung eines Bereichs öffnet sich auf einem Gerät nach einmaliger PIN-Eingabe; vorher erschienen die Knöpfe, und jeder Klick scheiterte mit „Anmeldung abgelaufen“.",
          "Das anlegende Gerät und wer den PIN dort schon eingegeben hat, merken davon nichts. Einstellungen-Reiter und Turnier anlegen hängen weiter nur am Konto; „Bescheid geben“ beim Essen braucht Konto und PIN."
      ]},
    ],
  },
  {
    version: "8.23",
    groups: [
      { title: "Essen: Telefon und Lieferanten-Mail nur für die Verwaltung", items: [
          "Telefonnummer des Bestellers und Mail des Lieferanten liegen getrennt von der Bestellliste. Sobald die neuen Datenbank-Regeln eingespielt sind, kann nur noch die Verwaltung sie lesen; vorhandene Angaben zieht die App beim nächsten Öffnen durch die Verwaltung selbst um.",
          "Lässt die Datenbank das Ändern oder Stornieren einer Bestellung von einem zweiten Gerät desselben Kontos nicht zu, sagt die App, dass es auf dem ersten Gerät oder über die Orga geht."
      ]},
    ],
  },
  {
    version: "8.22",
    groups: [
      { title: "Bedienung ohne Maus", items: [
          "Die Fenster Ergebnis melden, Veranstalter, Zeitplan, Zeit belegen und Programmpunkt schließen per Escape. Ein Vorleseprogramm erkennt sie als Fenster; der Fokus springt beim Öffnen hinein und beim Schließen zurück.",
          "Die Fehlermeldung in der Anmeldeliste eines Turniers wird vorgelesen."
      ]},
    ],
  },
  {
    version: "8.21",
    groups: [
      { title: "Essen: Fehler vor der AGE LAN behoben", items: [
          "„Ist raus“ hält genau die Bestellungen fest, die in der geöffneten oder kopierten Mail standen. Hat sich seitdem eine davon geändert, fragt die App nach.",
          "Stellt der Veranstalter eine Bestellung auf „zahlt“ oder „geht aufs Haus“, bleibt das auch, wenn der Besteller sie danach ändert.",
          "Beim Speichern der Einstellungen werden Änderungen von einem anderen Gerät nicht mehr mit alten Werten überschrieben – beim Frühstück ebenso.",
          "Der Korb zeigt nach einer Preisänderung den neuen Preis; „Ändern“ fragt nach, bevor ein gefüllter Korb ersetzt wird.",
          "Die Sammelmail trennt Stücke mit unterschiedlicher Bestellnummer; eine gleichzeitig doppelt angelegte, leere Lieferung wird nicht mehr angezeigt.",
          "„Bescheid geben“ gibt es nur mit Veranstalter- oder Orga-Konto; mit dem PIN allein steht dort, warum nicht.",
          "Die eigene Bestellung steht auch auf einem zweiten Gerät mit demselben Konto unter „Meine“.",
          "Richtige Gründe: „schon beim Lieferanten bestellt“ statt „bezahlt“, „Orga-Essen noch nicht freigegeben“ statt „Da fehlt noch Geld“.",
          "Das Recht über den PIN gilt nur für die Essensbestellung, für die er eingegeben wurde.",
          "Das Sonderwunsch-Feld vergrößert am iPhone nicht mehr die Seite."
      ]},
      { title: "Frühstück: Fehler vor der AGE LAN behoben", items: [
          "Nach einer Preisänderung zeigt die Karte den Betrag der eigenen Bestellung wie Kasse und Abrechnung und sagt, dass sich der Preis geändert hat.",
          "Die Zahl der Morgen lässt sich nicht mehr kürzen, solange am wegfallenden Morgen bestellt ist.",
          "Nach „Bestellen“ oder „Stornieren“ reagiert die Seite sofort wieder.",
          "Eine bezahlte Bestellung sperrt Menge und Stornieren, mit Hinweis auf den Haken des Veranstalters.",
          "Beim Tippen in Notiz oder Namen bleibt der Cursor im Feld; ein Doppelklick auf „Paket hinzufügen“ legt nur ein Paket an."
      ]},
      { title: "Turnier: Setzung, Wertung und Anmeldung", items: [
          "K.-o. nach Gruppen: in der ersten Runde trifft niemand auf jemanden aus der eigenen Gruppe, wenn es sich vermeiden lässt.",
          "Wertung „Direktes Duell“: bei mehreren Punktgleichen entscheidet eine Mini-Tabelle der Spiele untereinander – auch bei einem Dreier-Kreis eindeutig.",
          "Schweizer System: kein Wiedersehen, solange es eine Paarung ohne gibt.",
          "Die eigene Anmeldung lässt sich mit „Abmelden“ zurücknehmen, der Veranstalter nimmt Anmeldungen per 🗑 heraus. Meldet sich derselbe Name von einem zweiten Gerät an, fragt die App nach.",
          "Doppel-K.-o. mit zwei Teams: das große Finale ist ein echtes Rückspiel.",
          "Der Zeitplan kann über Mitternacht gehen (z. B. 18:00 bis 02:00).",
          "„Nur zuschauen“ bleibt in der Lobby; „Offene Spiele auswürfeln“ lässt gemeldete Ergebnisse stehen."
      ]},
      { title: "Stream, Übersicht und Start", items: [
          "Die Übersicht nennt alle parallelen Programmpunkte und alle gleichzeitig beginnenden Streams, zeigt nach Mitternacht den laufenden Veranstaltungstag und nach der Veranstaltung keine alte Nachfassliste mehr.",
          "Der Streamkalender öffnet nachts den laufenden Veranstaltungstag, das Tagesende steht immer in der Ende-Liste, und ein Doppelklick legt nichts doppelt an.",
          "Ein eigener Eintrag ohne 🎥 sagt, dass der Haken fehlt; ohne Eintrag-Recht öffnet ein Klick in die freie Spur keinen Dialog mehr.",
          "Lädt die Seite wegen des Netzes nicht vollständig, erscheint oben eine Leiste mit „Neu laden“."
      ]},
    ],
  },
  {
    version: "8.20",
    groups: [
      { title: "Teams tauschen: Auswahl springt nicht mehr zurück", items: [
          "Meldete sich jemand an oder änderte sein Elo, während der Veranstalter zwei Leute zum Tauschen auswählte, sprang die schon getroffene Auswahl auf den ersten Namen zurück.",
          "Die Auswahl bleibt jetzt stehen, solange es die Person noch gibt."
      ]},
    ],
  },
  {
    version: "8.19",
    groups: [
      { title: "Zeitplan: Nachplanen lässt gemeldete Spiele in Ruhe", items: [
          "Beim Nachplanen bekamen auch Spiele eine neue Zeit, deren Ergebnis schon gemeldet, aber noch nicht bestätigt war – sie wurden in die Zukunft geschoben und blockierten dort einen Platz.",
          "Terminiert werden jetzt nur noch Spiele, die wirklich noch offen sind."
      ]},
    ],
  },
  {
    version: "8.18",
    groups: [
      { title: "Konto anlegen: falsches Veranstalter-Passwort wird gemeldet", items: [
          "Wer beim Anlegen ein falsches Veranstalter-Passwort eingetragen hatte, bekam ohne jeden Hinweis ein normales Konto – erkennbar nur am 👤 statt ⭐ in der Kopfzeile.",
          "Jetzt sagt ein Hinweis, dass das Konto zwar angelegt ist, das Veranstalter-Passwort aber nicht stimmte."
      ]},
    ],
  },
  {
    version: "8.17",
    groups: [
      { title: "Anmeldung bleibt bei einer Serverstörung erhalten", items: [
          "Antwortete der Server beim Öffnen der Seite mit einem Fehler (etwa einer Störungsseite), wurde man abgemeldet und musste sich neu anmelden.",
          "Abgemeldet wird jetzt nur noch, wenn der Server ausdrücklich sagt, dass es das Konto nicht mehr gibt. Bei einer Störung geht es weiter wie bei einem kurzen Netzausfall."
      ]},
    ],
  },
  {
    version: "8.16",
    groups: [
      { title: "Übersicht: Orga-Kachel auch für Veranstalter per PIN", items: [
          "Wer die Essensbestellung per PIN oder als ihr Ersteller verwaltet, aber kein ⭐/🛠-Konto hat, sah in der Übersicht die Kachel „Für die Orga“ nicht.",
          "Sie erscheint jetzt für alle, die in der Essensbestellung Veranstalter sind – für alle anderen weiterhin gar nicht."
      ]},
    ],
  },
  {
    version: "8.15",
    groups: [
      { title: "Übersicht: Zahl der offenen Bestellungen passt zum Betrag", items: [
          "Die Orga-Kachel zählte bei „noch zu kassieren“ auch Orga-Essen als offene Bestellung mit, der Betrag daneben aber nicht – etwa „9,50 € · 2 offene Bestellungen“ bei nur einer zahlenden.",
          "Gezählt wird jetzt dieselbe Auswahl wie beim Betrag."
      ]},
    ],
  },
  {
    version: "8.14",
    groups: [
      { title: "Übersicht: Frühstück und Stream wie in den Bereichen selbst", items: [
          "War die Frühstücks-Annahme nur zugedreht, meldete die Übersicht „Für alle Tage ist der Bestellschluss vorbei“. Jetzt steht dort „Die Bestellannahme ist gerade geschlossen“ – wie im Frühstück selbst.",
          "Laufen zwei Streams gleichzeitig, nennt die Übersicht jetzt beide statt nur den ersten."
      ]},
    ],
  },
  {
    version: "8.13",
    groups: [
      { title: "Stream: Veranstalter ohne 🎥 können fremde Einträge wirklich korrigieren", items: [
          "Veranstalter und Orga ohne Streamer-Haken bekamen fremde Streams zum Bearbeiten angeboten – Speichern, Löschen und Verschieben scheiterten dann mit „Nur freigegebene Streamer …“.",
          "Fremde Einträge korrigiert jetzt, wer den Plan verwaltet, auch ohne 🎥. Selbst eintragen bleibt an den Haken gebunden."
      ]},
    ],
  },
  {
    version: "8.12",
    groups: [
      { title: "Turnier: Doppel-K.-o. aus der Formatwahl kommt beim Auslosen an", items: [
          "Wer in der Lobby „Doppel-K.-o.“ festgelegt hatte, fand beim Auslosen das Feld „K.-o.-Runde“ trotzdem auf „Einfach“ – ein Klick auf „Auslosen“ machte daraus ein einfaches K.-o.",
          "Das Feld übernimmt jetzt die Wahl aus der Lobby und lässt sich dort weiter ändern."
      ]},
    ],
  },
  {
    version: "8.11",
    groups: [
      { title: "Essen: geänderter Mailtext kommt in der Mail an", items: [
          "Der Text der Sammelbestellung ließ sich zwar ändern, „E-Mail öffnen“ schickte aber immer den ursprünglichen Text – und nach spätestens 30 Sekunden war die Änderung auch aus dem Feld verschwunden.",
          "„E-Mail öffnen“ nimmt jetzt genau den Text aus dem Feld. Er bleibt stehen, bis du wechselst; kommt inzwischen eine Bestellung dazu, steht ein Hinweis mit „Text neu erzeugen“ darunter."
      ]},
    ],
  },
  {
    version: "8.10",
    groups: [
      { title: "Essen: Einstellungen gehen beim Weitertippen nicht mehr verloren", items: [
          "Wer in den Essens-Einstellungen erst den Lieferanten änderte und dann ins nächste Feld wechselte, fand nach spätestens 30 Sekunden wieder den alten Lieferanten im Feld – und „Speichern“ übernahm ihn mit „Gespeichert.“.",
          "Ab der ersten Änderung bleiben jetzt alle Einstellungsfelder so, wie du sie getippt hast, bis gespeichert ist."
      ]},
    ],
  },
  {
    version: "8.9",
    groups: [
      { title: "Stream: gelöschter Plan hinterlässt keinen PIN, der den neuen sperrt", items: [
          "Löschte ein Veranstalter den Streamplan, ohne dessen PIN auf seinem Gerät eingegeben zu haben, blieb der alte PIN im Hintergrund hinterlegt. Ein neuer Plan mit neuem PIN entstand trotzdem – auf jedem anderen Gerät hieß es dann „PIN stimmt nicht“, der alte PIN funktionierte.",
          "Das Löschen versucht es jetzt auch mit dem auf dem Gerät gemerkten PIN und sagt es ausdrücklich, wenn der alte PIN stehen bleibt. Ein neuer Plan entsteht nur, wenn sein PIN wirklich gespeichert werden konnte – sonst mit einer Meldung, welcher PIN noch gilt."
      ]},
    ],
  },
  {
    version: "8.8",
    groups: [
      { title: "Stream: Zeitfenster springen beim Umstellen nicht mehr zurück", items: [
          "Trug sich jemand in den Plan ein, während der Veranstalter die Tages-Zeitfenster umstellte, sprang die gerade gewählte Uhrzeit zurück – und „Zeiten speichern“ schrieb den alten Wert mit der Meldung „Gespeichert.“.",
          "Die Auswahl bleibt jetzt stehen, bis gespeichert ist."
      ]},
    ],
  },
  {
    version: "8.7",
    groups: [
      { title: "Frühstück: Paket löschen klappt auch, wenn jemand nur dieses Paket bestellt hat", items: [
          "Hatte jemand ausschließlich das Paket bestellt, das gelöscht werden sollte, blieb das Paket einfach stehen – ohne Meldung.",
          "Solche Bestellungen fallen jetzt ganz weg (wie der Rückfrage-Dialog ankündigt), das Paket verschwindet. Geht beim Löschen doch etwas schief, steht der Grund unter der Paketliste."
      ]},
    ],
  },
  {
    version: "8.6",
    groups: [
      { title: "Turnier: ✎-Korrektur im K.-o. zieht die nächste Runde nach", items: [
          "Hat der Veranstalter ein K.-o.-Ergebnis mit ✎ umgedreht, zeigte die Karte den neuen Sieger – in der nächsten Runde (und im Spiel um Platz 3 oder im Verliererbaum) stand aber weiter der alte.",
          "Die Folgespiele bekommen jetzt die richtigen Teams, solange sie noch nicht gespielt sind. Ist das Folgespiel schon gemeldet oder gespielt, lehnt die App die Korrektur mit einer Erklärung ab, statt sie still halb auszuführen.",
          "Wird das Finale nach Turnierende korrigiert, steht danach der richtige Turniersieger fest."
      ]},
    ],
  },
  {
    version: "8.5",
    groups: [
      { title: "Frühstück: bezahlte Bestellung bleibt, wie sie bezahlt wurde", items: [
          "Wer nach dem Bezahlen selbst mehr bestellt hat, stand in der Abrechnung mit der höheren Summe, aber „offen 0,00 €“ – der Aufpreis ging unter.",
          "Eine bezahlte Bestellung lässt sich jetzt nur noch ändern oder stornieren, nachdem der Veranstalter den Haken „bezahlt“ herausgenommen hat. Eine Notiz ohne neuen Betrag geht weiter."
      ]},
    ],
  },
  {
    version: "8.4",
    groups: [
      { title: "Stream: gezogene Uhrzeit bleibt im Dialog erhalten", items: [
          "Nach dem Verschieben mit der Maus liegt ein Eintrag oft auf einer Fünf-Minuten-Zeit wie 20:05. Beim nächsten „Ändern“ stand der Beginn dann auf dem Tagesbeginn, und „Speichern“ hat ihn so übernommen.",
          "Die Auswahl zeigt jetzt genau die gespeicherte Zeit an – auch im Dialog für Programmpunkte."
      ]},
    ],
  },
  {
    version: "8.3",
    groups: [
      { title: "Stream: Verschieben behält „kein Streamer nötig“", items: [
          "Wer einen Programmpunkt ohne Streamer-Bedarf mit der Maus verschoben hat, fand ihn danach wieder als „Streamer nötig“ im Plan – mit Warnung in der Kopfzeile.",
          "Der Haken bleibt beim Verschieben jetzt so, wie er gesetzt war."
      ]},
    ],
  },
  {
    version: "8.2",
    groups: [
      { title: "Downloads", items: [
          "AoE2-Klickzähler (Spieler) durch die neue Fassung vom 23.09. ersetzt."
      ]},
    ],
  },
  {
    version: "8.1",
    groups: [
      { title: "Neuer Bereich: Downloads", items: [
          "Fünfte Kachel im Vorraum – Werkzeuge zum Herunterladen für die Veranstaltung.",
          "Als erste Datei drin: der AoE2-Klickzähler (Spieler) fürs 2vs2-Coop-Turnier."
      ]},
    ],
  },
  {
    version: "8.0",
    groups: [
      { title: "Dunkelmodus: blaue Schrift wieder lesbar", items: [
          "Seit dem neuen, dunkleren Vereinsblau verschwanden im Dunkelmodus der aktive Reiter, die Überschriften der Karten und des Vorraums sowie die Plus- und Minus-Knöpfe der Frühstücksbestellung fast im Hintergrund.",
          "Schrift, Rahmen und Haken in Vereinsblau stehen im Dunkelmodus jetzt in einem hellen Blau. Die blauen Knöpfe mit weißer Schrift bleiben, wie sie sind."
      ]},
    ],
  },
  {
    version: "7.9",
    groups: [
      { title: "Datenschutz-Hinweis: was die Veranstalter bei einer neuen Anmeldung erfahren", items: [
          "Der Hinweis im Vorraum sagte, die Nachricht an die Veranstalter enthalte deine Discord-ID. Das stimmte nicht: darin stehen dein Name, ob eine Discord-ID hinterlegt ist, und die Zahl der Konten – die ID selbst nie.",
          "Der Text sagt das jetzt so, wie der Server es tatsächlich verschickt."
      ]},
      { title: "Essen: Textfelder zoomen am iPhone nicht mehr", items: [
          "Das Feld für die Speisekarte zum Einlesen, der Hinweis und der E-Mail-Text waren kleiner geschrieben als 16 Pixel. Am iPhone hat das beim Antippen die ganze Seite herangezoomt.",
          "Die drei Felder schreiben jetzt in 16 Pixeln."
      ]},
    ],
  },
  {
    version: "7.8",
    groups: [
      { title: "Streamplan: ein einzelner Stream steht wieder in voller Breite", items: [
          "Standen irgendwo am Tag zwei Streams gleichzeitig, wurden ALLE Streams dieses Tages halb so breit gezeichnet – auch einer am Vormittag, neben dem gar nichts lief.",
          "Jetzt teilen sich nur die Einträge die Breite, die sich wirklich überschneiden. Alles andere steht wieder in voller Breite und bleibt lesbar.",
          "Dasselbe gilt für die Programmpunkte in der Spur links."
      ]},
    ],
  },
  {
    version: "7.7",
    groups: [
      { title: "Frühstück und Essen: kein alter PIN mehr offen in der Datenbank", items: [
          "Beim Umzug einer alten Bestellung auf die geschützte Prüfsumme konnte der letzte Schritt scheitern – etwa weil gerade die Verbindung wackelte. Dann lag die Prüfsumme schon, aber der alte PIN stand weiter lesbar in der Datenbank.",
          "Weil die nächste Anmeldung danach über die Prüfsumme klappte, lief der Umzug nie wieder an, und der PIN blieb dort liegen.",
          "Jetzt räumt jede erfolgreiche Anmeldung als Veranstalter einen noch vorhandenen alten PIN weg – so, wie es der Streamplan schon machte."
      ]},
    ],
  },
  {
    version: "7.6",
    groups: [
      { title: "Frühstück und Essen: nach dem Löschen lässt sich wieder neu anlegen", items: [
          "Beim Löschen einer Frühstücks- oder Essensbestellung sollte ihr PIN mit verschwinden. Das hat nicht geklappt: die Datenbank hat das Löschen abgelehnt, und die App hat den Fehler verschwiegen.",
          "Die Folge: eine neue Bestellung mit einem anderen PIN ließ sich nicht mehr anlegen – mit der irreführenden Meldung, die Datenbank-Regeln seien nicht veröffentlicht.",
          "Jetzt wird der PIN richtig ausgetragen. Wer als Veranstalter ohne PIN angemeldet ist, aber den PIN auf diesem Gerät gemerkt hat, trägt ihn dabei trotzdem aus.",
          "Geht es einmal gar nicht, sagt die App das nach dem Löschen: eine neue Bestellung geht dann nur mit demselben PIN wie bisher."
      ]},
    ],
  },
  {
    version: "7.5",
    groups: [
      { title: "Frühstück und Essen: ein zweiter Anlauf beim Anlegen klappt wieder", items: [
          "Beim Essen wurde der PIN schon gesichert, bevor die Mail-Adresse des Lieferanten geprüft war. Ein Tippfehler in der Adresse – und jeder weitere Versuch scheiterte mit „Der PIN ließ sich nicht sichern“.",
          "Jetzt wird erst alles geprüft und dann gespeichert. Ein Tippfehler lässt sich einfach korrigieren.",
          "Reißt beim Anlegen die Verbindung ab, nimmt die App den schon gesicherten PIN wieder zurück. Klappt auch das nicht, kommst du mit demselben PIN beim nächsten Versuch trotzdem durch.",
          "Die Fehlermeldung nennt jetzt beide möglichen Gründe: ein anderer PIN von früher ist noch hinterlegt, oder die Datenbank-Regeln fehlen."
      ]},
    ],
  },
  {
    version: "7.4",
    groups: [
      { title: "Beim Anmelden steht jetzt dran: es geht um dein 1vs1-Elo", items: [
          "Das Feld hieß nur „Rating“. Bei einem 2vs2-Turnier war damit nicht klar, welcher Wert gemeint ist – und wer sein Team-Elo einträgt, wird in eine Mannschaft gesteckt, die nicht zu ihm passt.",
          "Es heißt jetzt „1vs1-Elo“, und darunter steht der Satz dazu: auch bei einem 2vs2-Turnier zählt das 1vs1-Elo, nicht das Team-Elo.",
          "Derselbe Hinweis steht an jeder Stelle, an der der Wert eingegeben wird – beim Anmelden und beim Nachträglich-Ändern."
      ]},
      { title: "Dein Elo lässt sich länger korrigieren", items: [
          "Stand ein falscher Wert drin, ließ er sich nur so lange ändern, wie die Anmeldung offen war. Sobald der Veranstalter die Mannschaften gebildet hatte, war er festgenagelt.",
          "Jetzt steht derselbe Kasten auch auf dem Mannschafts-Bildschirm. Bis zur Auslosung kann jede:r seinen Wert richtigstellen.",
          "Der Durchschnitt der Mannschaft rechnet sich dabei sofort mit – vorher hätte auf der Karte weiter die alte Zahl gestanden.",
          "Damit sich eine Korrektur auch auf die Aufteilung auswirkt, muss der Veranstalter die Mannschaften noch einmal neu vorschlagen lassen. Das steht als Satz im Kasten.",
          "Ab der Auslosung bleibt der Wert zu: daran hängen Setzliste und Baum, und ein nachträglich geändertes Elo würde eine schon gespielte Runde anders begründen, als sie zustande kam."
      ]},
    ],
  },
  {
    version: "7.3",
    groups: [
      { title: "Der Veranstalter-PIN ist jetzt überall geschützt", items: [
          "Frühstück und Essen bewahrten ihren PIN bisher im Klartext in der Datenbank auf. Beim Frühstück war er damit für jeden abrufbar, beim Essen für jeden, der die Seite offen hatte – und hinter dem Essens-PIN stehen Telefonnummer, Lieferantenadresse und alle Bestellungen mit Namen.",
          "Beide gehen jetzt denselben Weg wie Turnier und Streamplan: gespeichert wird nur noch eine Prüfsumme, aus der sich der PIN nicht zurückrechnen lässt. Geprüft wird auf dem Server, nicht mehr im Browser.",
          "Für dich ändert sich nichts: derselbe PIN, dieselben Knöpfe. Nur die Anmeldung braucht jetzt einen kurzen Augenblick, weil sie übers Netz geht.",
          "Wer einen Plan von früher aufmacht und seinen PIN noch gemerkt hat, zieht ihn dabei von selbst um.",
          "Neue Pläne brauchen einen PIN mit mindestens sechs Zeichen. Bestehende behalten ihren.",
          "Wird ein Plan gelöscht, verschwindet seine Prüfsumme mit – sonst ließe sich der nächste mit dem alten PIN aufmachen."
      ]},
      { title: "Bremse gegen falsche Passwörter: vorbereitet, aber nicht eingeschaltet", items: [
          "Die Bremse gegen das Durchprobieren von Passwörtern zählte bisher nur innerhalb eines Servers mit – und davon laufen viele nebeneinander. Eine Welle verteilte sich darauf und kam durch.",
          "Der Anschluss an Cloudflares eigenes Zählwerk, das außerhalb der einzelnen Server mitzählt, ist eingebaut – bei AgeLan aber bewusst nicht eingeschaltet: das Passwort kennen die Teilnehmer ohnehin. Es gilt also weiter die bisherige Bremse. (Richtigstellung vom 16.09.2026: hier stand zuerst, Cloudflare zähle schon mit.)"
      ]},
      { title: "Datenschutz: ein Satz, der gefehlt hat", items: [
          "Seit gestern bekommen die Veranstalter eine Discord-Nachricht, sobald jemand ein Konto anlegt. Dass das passiert, steht jetzt auch im Datenschutz-Hinweis."
      ]},
    ],
  },
  {
    version: "7.2",
    groups: [
      { title: "Streamplan: mehrere dürfen sich dieselbe Zeit nehmen", items: [
          "Bisher wies der Plan eine schon belegte Zeit ab („Da streamt schon …“). Das war strenger als nötig – der Streamplan ist erstmal eine Planung, keine Sendeliste.",
          "Jetzt darf sich jeder eine Zeit vormerken, auch wenn dort schon jemand steht. Wer am Ende wirklich sendet, klärt ihr untereinander.",
          "Im Kalender stehen die Streams dann nebeneinander – so wie die Programmpunkte in der Spur links.",
          "Damit das niemand übersieht: die Maske sagt schon beim Eintragen, wer auf dieser Zeit sonst noch im Plan steht. Der Satz passt sich sofort an, wenn du Tag, Beginn oder Ende änderst.",
          "Auch Verschieben mit der Maus geht jetzt auf eine belegte Zeit.",
          "Alles andere bleibt streng: Zeiten außerhalb des Tagesfensters, unter 15 Minuten oder ohne Namen nimmt der Plan weiterhin nicht an.",
          "Ein Programmpunkt gilt weiter erst dann als abgedeckt, wenn die Zeit wirklich durchgehend belegt ist – zwei Streamer auf derselben Stunde zählen nicht doppelt."
      ]},
    ],
  },
  {
    version: "7.1",
    groups: [
      { title: "Kleinigkeit: „Kontoen“", items: [
          "In der Konten-Liste stand bei mehr als einem Konto „9 Kontoen“. Jetzt steht dort „9 Konten“ – und bei genau einem weiterhin „1 Konto“."
      ]},
    ],
  },
  {
    version: "7.0",
    groups: [
      { title: "Discord: der Bot meldet neue Anmeldungen", items: [
          "Legt sich jemand ein Konto an, bekommt jeder Veranstalter mit hinterlegter Discord-ID sofort eine Nachricht vom Bot.",
          "Darin stehen der Name, ob die Person selbst eine Discord-ID hinterlegt hat, und wie viele Konten es jetzt insgesamt gibt.",
          "Hat sich jemand beim Anlegen gleich mit dem Veranstalter-Passwort Veranstalter-Rechte gegeben, steht das ausdrücklich dabei.",
          "Die Meldung geht an Veranstalter, nicht an die Orga – und niemand bekommt eine Nachricht über sich selbst.",
          "Die Anmeldung wartet nicht auf den Bot: klemmt Discord, ist das Konto trotzdem angelegt.",
          "Die Konten-Liste unter „Einstellungen“ sagt jetzt, wen diese Meldung überhaupt erreicht. Hat kein Veranstalter eine Discord-ID hinterlegt, steht das dort – sonst bliebe unklar, ob der Bot schweigt oder ob nur niemand neu ist."
      ]},
    ],
  },
  {
    version: "6.9",
    groups: [
      { title: "Frühstück: Bestellannahme auf- und zudrehen", items: [
          "Beim Essen gab es den Schalter schon, beim Frühstück nicht: dort entschied allein der Bestellschluss am Vorabend, ob jemand buchen kann.",
          "In den Einstellungen des Veranstalters steht jetzt „Bestellannahme ist offen“. Der Haken wirkt sofort, ohne „Einstellungen speichern“.",
          "Ist zu, bleiben alle Morgen sichtbar – die Plus- und Minus-Knöpfe sind nur ausgegraut, und oben steht „Geschlossen“. Ansehen geht weiter, bestellen nicht.",
          "Die beiden Gründe werden auseinandergehalten: „geschlossen“ heißt warten auf den Veranstalter, „Bestellschluss vorbei“ heißt für diesen Morgen ist Schluss. Ein gemeinsames Wort für beides würde niemanden wissen lassen, ob Warten hilft.",
          "Der Veranstalter selbst kann auch bei zugedrehter Annahme weiter bestellen – genau wie beim Essen.",
          "Bestehende Frühstücksbestellungen bleiben offen: fehlt das Feld, gilt offen."
      ]},
    ],
  },
  {
    version: "6.8",
    groups: [
      { title: "Stream: der Veranstalter-PIN steht nicht mehr offen im Netz", items: [
          "Derselbe Fehler wie beim Turnier, nur eine Ecke weiter: der PIN des Streamplans lag im Klartext im offen lesbaren Datensatz.",
          "Er wird jetzt genauso behandelt – nur noch als Pruefsumme, in einem Knoten, den niemand lesen darf, und geprueft wird auf dem Server.",
          "Einen laufenden PIN kann nur noch wechseln, wer den alten kennt.",
          "Ein bestehender Plan zieht beim naechsten Oeffnen von selbst um – wer den PIN gemerkt hat, bleibt Veranstalter.",
          "Beim Anlegen eines Streamplans wird weiterhin der PIN des laufenden Turniers vorgeschlagen. Er kommt jetzt aus dem Geraet statt aus dem Turnier-Datensatz, wo er nicht mehr steht."
      ]},
    ],
  },
  {
    version: "6.7",
    groups: [
      { title: "Turnier: der Admin-PIN steht nicht mehr offen im Netz", items: [
          "Der PIN eines Turniers lag im Klartext im selben Datensatz wie Name und Phase – und der ist fuer jeden lesbar, damit das Board an der Wand ohne Anmeldung laufen kann. Wer die Adresse der Datenbank kannte, bekam den PIN mit einem einzigen Aufruf heraus.",
          "Der PIN wird jetzt nirgends mehr gespeichert, nur noch seine Pruefsumme – und die liegt in einem Knoten, den niemand lesen darf.",
          "Geprueft wird ab jetzt auf dem Server statt im Browser: dein Geraet legt die Pruefsumme in einer Ablage ab, und die Datenbank nimmt sie nur an, wenn sie zur hinterlegten passt. Stimmt der PIN nicht, geht der Schreibvorgang gar nicht erst durch.",
          "Einen laufenden PIN kann nur noch wechseln, wer den alten kennt.",
          "Bestehende Turniere ziehen beim naechsten Oeffnen von selbst um – wer den PIN gemerkt hat, bleibt Veranstalter und merkt nichts davon."
      ]},
    ],
  },
  {
    version: "6.6",
    groups: [
      { title: "Turnier: Klick auf eine Turnierkachel öffnet wieder", items: [
          "In der Turnierliste tat ein Klick auf ein Turnier nichts – die Liste blieb einfach stehen.",
          "Grund: seit es die Übersicht gibt, hängen zwei Stellen am Turnier-Dienst. Der Dienst merkte sich aber nur eine davon, und die Übersicht kam als Letzte – damit war die Turnier-Oberfläche abgeklemmt und zeichnete nie wieder neu.",
          "Der Dienst führt jetzt eine Liste aller Zuhörer, so wie Stream, Frühstück und Essen es schon immer tun."
      ]},
    ],
  },
  {
    version: "6.5",
    groups: [
      { title: "Turnier: Spiele bekommen einen Anstoß", items: [
          "Neuer Knopf „🕐 Zeitplan – Spiele terminieren“ für den Veranstalter, in der Gruppenphase und im K.-o.",
          "Du sagst einmal: erster Spieltag, Beginn, Schluss für den Tag, Dauer je Spiel, Pause dazwischen, wie viele Spiele gleichzeitig. Die App verteilt alle offenen Spiele.",
          "Ein Spiel darf bis zu zehn Stunden dauern – passt es nicht mehr vor den Schluss, geht es am nächsten Tag zur Beginnzeit weiter.",
          "Kein Team steht auf zwei Plätzen gleichzeitig, und eine Runde beginnt erst, wenn die vorige durch ist.",
          "Der Anstoß steht danach an jedem Spiel, in der Gruppenliste und im Baum – für alle sichtbar, nicht nur für den Veranstalter.",
          "Einzelne Spiele lassen sich im selben Fenster verschieben; Dauer je Spiel geht auch einzeln.",
          "Schon bestätigte Spiele rührt der Automat nicht an. Damit ist derselbe Knopf auch das Werkzeug zum Nachplanen, wenn der Ablauf hinterherhinkt.",
          "„Alle Zeiten löschen“ nimmt den ganzen Zeitplan wieder zurück."
      ]},
    ],
  },
  {
    version: "6.4",
    groups: [
      { title: "Streamer-Haken 🎥 laesst sich wieder wegnehmen", items: [
          "Bei Veranstaltern ⭐ und Leuten aus der Organisation 🛠 war der Haken 🎥 fest gesetzt und grau – einmal drin, nie wieder raus.",
          "Der Grund: diese beiden Gruppen durften ohnehin immer eintragen, ein Abwaehlen haette also nichts bewirkt. Statt einer wirkungslosen Schaltflaeche stand dort eine gesperrte.",
          "Jetzt entscheidet der Haken allein – fuer jeden. Wer eintragen soll, bekommt ihn; wer nicht mehr soll, verliert ihn. Auch bei ⭐ und 🛠.",
          "Den Streamplan verwalten – Programm anlegen, Bloecke loeschen, Plan leeren – duerfen Veranstalter und Organisation weiterhin ohne den Haken.",
          "⚠️ Nach dieser Aenderung hat zunaechst NUR noch der den Haken, bei dem er wirklich gesetzt ist. Wer bisher ueber ⭐ oder 🛠 eingetragen hat, braucht ihn einmal ausdruecklich."
      ]},
    ],
  },
  {
    version: "6.3",
    groups: [
      { title: "Nach der Anmeldung: Erinnerung an die Discord-ID", items: [
          "Wer noch keine Discord-ID hinterlegt hat, bekommt nach dem Anmelden einmal „Mein Konto“ aufgemacht – mit dem Hinweis, wofuer die ID gut ist.",
          "Ohne ID sagt dir der Bot NICHT Bescheid, wenn dein Essen bereitliegt.",
          "Einmal je Name und Geraet – wer sie eintraegt oder wegklickt, wird nicht wieder gefragt. Ueber den eigenen Namen oben rechts kommst du jederzeit hin."
      ]},
    ],
  },
  {
    version: "6.2",
    groups: [
      { title: "Erster Besuch: direkt zum Konto anlegen", items: [
          "Wer die Seite zum ersten Mal oeffnet, landet nach dem Klick auf eine Kachel sofort in der Maske „Konto anlegen“ statt im Anmeldeformular.",
          "Wer schon ein Konto auf diesem Geraet hat, kommt wie bisher direkt zum Anmelden – mit vorbelegtem Namen.",
          "Konto auf einem anderen Geraet? Der Knopf „Ich habe schon ein Konto“ schaltet mit einem Klick um."
      ]},
    ],
  },
  {
    version: "6.1",
    groups: [
      { title: "Neuer Reiter „Uebersicht“: alles Wichtige auf einem Blatt", items: [
          "Ganz vorn steht jetzt eine Uebersicht: wer gerade sendet und wie lange noch, wer danach dran ist, welcher Programmpunkt laeuft.",
          "Dein Essen steht dort mit Stand – „Liegt bereit – abholen!“, sobald die Lieferung da ist und Bescheid gegeben wurde.",
          "Dazu Bestellschluss des Fruehstuecks und die laufenden Turniere.",
          "Veranstalter und Orga sehen zusaetzlich, wer sein Essen noch nicht geholt hat, wie viel noch zu kassieren ist und wie viele Bestellungen im Stapel warten. Fuer alle anderen wird dieser Kasten gar nicht erst gebaut – dort stehen fremde Namen und Betraege.",
          "Die Uebersicht aendert nichts: jeder Kasten fuehrt per Knopf in den Bereich, der die Sache wirklich kann."
      ]},
      { title: "Programmpunkt: Haken „Dafuer wird ein Streamer gebraucht“", items: [
          "Am Programmpunkt steht ein Haken, ob dafuer jemand senden soll. Bei neuen Punkten ist er gesetzt.",
          "Im Kalender, in der Liste und in der Kopfzeile ist danach zu sehen, wo noch ein Streamer fehlt – samt der Zeit, die offen ist.",
          "Loesen sich zwei Streamer mitten im Programmpunkt ab, gilt er als abgedeckt.",
          "Das Abzeichen sehen alle, setzen darf den Haken nur der Veranstalter."
      ]},
      { title: "Streamkalender: mehr Luft und ein Tipp an der Maus", items: [
          "Eine Stunde ist im Kalender jetzt deutlich hoeher – kurze Eintraege schneiden ihren Text nicht mehr ab.",
          "Beim Fahren mit der Maus ueber einen Eintrag erscheint der volle Inhalt am Zeiger: Zeit, Titel, Notiz und der Streamer-Stand.",
          "Laesst die Datenbank einen Vorgang nicht zu, sagt der Streamplan das jetzt im Klartext, statt still nichts zu tun."
      ]}
    ]
  },
  {
    version: "6.0",
    groups: [
      { title: "Im Vorraum steht jetzt, was die App kann", items: [
          "Die Liste der Aenderungen und die Versionsnummer sind aus der Anzeige verschwunden – zuletzt standen sie zugeklappt im Reiter „Einstellungen“ und nur Veranstalter sahen sie.",
          "Stattdessen steht im Vorraum ueber dem Datenschutz-Hinweis die Karte „Funktionen“: was die App kann, nach Themen geordnet. Die sieht jede:r, auch vor der Anmeldung.",
          "Die Aenderungsliste selbst wird in app.js weitergepflegt – sie ist die Quelle fuer Anleitungen und Meldungen."
      ]}
    ]
  },
  {
    version: "5.9",
    groups: [
      { title: "Vorleseprogramm: die Symbol-Knoepfe sagen jetzt, wozu sie gehoeren", items: [
          "24 Knoepfe trugen nur ein Zeichen – ▲ ▼ ✎ 🗑 − + – und sonst nichts. Ein Vorleseprogramm liest davon nur „Schaltflaeche“ vor; welches Gericht oder Paket gemeint ist, war nicht zu erfahren. Jetzt heisst es „Pizza Diavolo nach oben“, „Broetchen und Ei loeschen“, „Eins mehr von …“.",
          "Ebenso das Sonderwunsch-Feld im Essenskorb (hatte nur einen Platzhalter, und der ist keine Beschriftung), die beiden Haekchen 🛠 und 🎥 in der Konten-Liste und der Loeschen-Knopf daneben – die nennen jetzt den Namen des Kontos.",
          "Dazu die drei Rating-Felder in Lobby und Anmeldung: der Regler hing an keiner Beschriftung."
      ]}
    ]
  },
  {
    version: "5.8",
    groups: [
      { title: "Passwort-Fenster quer am Handy: Zurueck-Knopf und Fehlermeldung sind wieder da", items: [
          "Quer gehaltenes Handy (812x375): der Kasten ist 483 Pixel hoch und wurde oben wie unten abgeschnitten – er sass von −54 bis 429. Damit lagen der Knopf „← Zurueck zur Uebersicht“ (341–375) und die Fehlerzeile (385–403) unter dem Bildrand, und das Fenster liess sich nicht scrollen. Wer sein Passwort falsch eintippte, sah schlicht nichts passieren.",
          "Das Fenster scrollt jetzt, wenn der Inhalt nicht hineinpasst. Gemessen nach der Aenderung: Kasten 20–503, nach dem Scrollen Zurueck-Knopf 267–302 und Fehlerzeile 312–329 – beide im Bild. Hochkant bleibt alles wie es war (Kasten 165–647, mittig).",
          "Betrifft alle drei Fenster dieser Bauart: Anmelden, Mein Konto und der QR-Code."
      ]}
    ]
  },
  {
    version: "5.7",
    groups: [
      { title: "Datenschutz: der Text sagt jetzt, was „Konto loeschen“ wirklich macht", items: [
          "Im Datenschutz-Hinweis im Vorraum stand „dein Konto samt Bestellungen ist in einer Minute weg“. Das stimmte nicht: geloescht werden nur Anmeldedaten und Discord-ID bei Cloudflare. Bestellungen, Turnier-Anmeldung und Streamplan-Zeiten bleiben mit Namen in der Datenbank stehen – die Rueckfrage vor dem Loeschen sagte das sogar richtig.",
          "Der Text nennt jetzt beides: was das Loeschen entfernt, was stehen bleibt (Essen samt Sonderwunsch, Fruehstueck, Turnier, Streamplan) und wie man es loswird – beim Veranstalter melden, der loescht es auf Zuruf."
      ]}
    ]
  },
  {
    version: "5.6",
    groups: [
      { title: "Lobby: der Rating-Regler bleibt stehen, wo man ihn hinzieht", items: [
          "Sobald sich jemand anders an- oder abmeldete, sprang der eigene Rating-Regler auf den gespeicherten Wert zurueck – und „Speichern“ schrieb genau diesen alten Wert wieder in die Datenbank. Gemerkt hat man es erst beim Auslosen, weil aus dem Rating die Teams gebaut werden.",
          "Der Regler gehoert jetzt ab der ersten Bewegung dem Spieler; erst nach dem Speichern zieht die Anzeige wieder nach.",
          "Unter dem Knopf steht jetzt <b>„Gespeichert ✓“</b> – vorher war der Klick vollstaendig stumm."
      ]}
    ]
  },
  {
    version: "5.5",
    groups: [
      { title: "Melde-Dialog nennt den richtigen Modus", items: [
          "Im Fenster „Ergebnis melden“ stand bisher immer <b>„Sieger braucht 2 Sätze“</b> – auch bei Best of 5 oder Best of 7. Wer sich daran hielt, bekam beim Absenden eine Absage.",
          "Im Finale kam dazu, dass der Hinweis das allgemeine Best-of nannte und nicht das eigene des Finales („Finale Best of 5“). Wer sich schon beim Spielen daran gehalten hat, hat einen Satz zu wenig gespielt.",
          "Der Hinweis rechnet jetzt mit genau dem Modus, den das Absenden gleich darauf prueft – Finale eingeschlossen."
      ]}
    ]
  },
  {
    version: "5.4",
    groups: [
      { title: "Fruehstueck: die Einstellungen bleiben stehen, bis gespeichert ist", items: [
          "„Morgen“ und „Bestellschluss“ wurden bei jedem Update neu befuellt – und die Frühstücksliste aktualisiert sich bei jeder fremden Bestellung und zusaetzlich alle 30 Sekunden von selbst. Wer laenger als eine halbe Minute tippte, hatte danach wieder die alten Werte im Feld; „Speichern“ schrieb sie zurueck und meldete Erfolg.",
          "Ab der ersten Aenderung fasst kein Update die beiden Felder mehr an. Erst nach dem Speichern zieht die Anzeige wieder nach."
      ]}
    ]
  },
  {
    version: "5.3",
    groups: [
      { title: "Stream: der Veranstalter darf jetzt auch, was ihm angeboten wird", items: [
          "Wer sich mit dem Stream-PIN als Veranstalter angemeldet hatte (oder den Plan selbst angelegt hat), sah den Knopf <b>„Zeit belegen“</b> – und bekam danach „Nur freigegebene Streamer koennen sich eintragen. Melde dich bei Michel.“ Also eine Absage, die ihn zu sich selbst schickt. Dasselbe beim Verschieben und Loeschen eines Blocks mit der Maus.",
          "Anzeige und Schreibweg fragen jetzt dieselbe Stelle. Fuer alle anderen aendert sich nichts: eintragen darf weiterhin nur, wer freigegeben ist."
      ]}
    ]
  },
  {
    version: "5.2",
    groups: [
      { title: "Fruehstueck: eine abgegebene Bestellung behaelt ihren Preis", items: [
          "Bisher holte die Anzeige Name und Preis bei jedem Aufruf frisch aus dem Paket. Wer den Preis eines Pakets spaeter aenderte, rechnete damit <b>alle</b> Bestellungen aller vergangenen Morgen um – auch die, die in der Abrechnung schon als bezahlt abgehakt waren. Der Haken blieb stehen, der Betrag daneben war ploetzlich ein anderer.",
          "Name und Preis werden jetzt beim Abschicken auf der Bestellung festgeschrieben, so wie es das Essen schon macht. Eine abgegebene Bestellung ist ein Beleg – eine Preisaenderung gilt ab jetzt und nicht rueckwirkend.",
          "Bestellungen von vorher rechnen unveraendert weiter mit dem Paketpreis."
      ]}
    ]
  },
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
      { title: "Zeitplan: Spiele terminieren", items: [
          "Der Veranstalter sagt einmal, wann es losgeht, wie lange ein Spiel dauert, wie lang die Pause ist und wie viele Spiele gleichzeitig laufen – die App verteilt daraufhin alle offenen Spiele.",
          "Ein Spiel darf bis zu zehn Stunden dauern. Passt es nicht mehr vor den Schluss des Tages, geht es am nächsten Tag zur Beginnzeit weiter.",
          "Kein Team steht auf zwei Plätzen gleichzeitig, und eine Runde fängt erst an, wenn die vorige durch ist.",
          "Der Anstoß steht danach an jedem Spiel – in der Gruppenliste und im K.-o.-Baum, für alle sichtbar.",
          "Einzelne Spiele lassen sich im selben Fenster von Hand verschieben. Schon bestätigte Spiele rührt der Automat nicht an, man kann also mittendrin nachplanen."
      ]},
      { title: "Streamkalender", items: [
          "Der Reiter „Stream“ zeigt einen Kalender über die Tage der Veranstaltung, in den sich die Streamer selbst eintragen.",
          "Eintragen heißt: Tag, Von, Bis, Name und wahlweise, was in der Zeit läuft. Der eigene Eintrag lässt sich jederzeit ändern oder wieder entfernen.",
          "Mehrere dürfen sich dieselbe Zeit nehmen. Die Maske sagt beim Eintragen, wer dort schon steht, und im Kalender stehen die Streams dann nebeneinander.",
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
  document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => {
    // aria-current: Vorleseprogramme erkennen den aktiven Reiter nicht an der Klasse (Abnahme D 21.09.2026).
    const an = b.dataset.tab === name;
    b.classList.toggle("active", an);
    if (an) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
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
  // Das Dashboard stellt seine Kacheln ab 700 px zweispaltig – in den 560 px
  // der Turnier-Screens waere davon nichts zu sehen.
  if (app) app.classList.toggle("ub-breit", name === "uebersicht");
  // ⚠️ Das Dashboard zeichnet nur, solange sein Reiter offen ist – sonst
  // rechnete es bei jeder fremden Bestellung im Hintergrund mit. Beim
  // Hereinwechseln muss es deshalb HIER angestossen werden. Aus demselben
  // Grund wie die sk-breit-Zeile darueber steht das in activateTab und nicht
  // am Klickhorcher: es gibt drei Wege in einen Reiter.
  // Kontoliste: lädt beim Öffnen selbst und hält sich dann im Hintergrund aktuell.
  if (typeof kontenReiterGewechselt === "function") {
    kontenReiterGewechselt(name === "einstellungen");
  }
  if (name === "uebersicht" && typeof ubRender === "function") {
    try {
      ubRender();
    } catch (e) {
      console.error("[Übersicht] Zeichnen fehlgeschlagen:", e);
    }
  }
  try {
    localStorage.setItem(AGELAN_TAB_KEY, name);
  } catch (e) { /* privater Modus: dann startet es eben wieder im Turnier */ }
}

// Die Änderungsliste steht seit 07.09.2026 NICHT mehr in der Anzeige — weder im
// Info-Reiter (den gibt es seit 2026-09-03 nicht mehr) noch im Reiter
// „Einstellungen“, wo sie zuletzt zugeklappt stand. Was die App kann, steht
// stattdessen im Vorraum unter „Funktionen“. APP_CHANGELOG bleibt hier gepflegt
// und wird weiter geschrieben. Diese Funktion steigt darum still aus, wenn es
// das Ziel nicht gibt, statt beim Seitenstart mit einem Fehler abzubrechen.
// Die Versionsplakette stand an derselben Überschrift und ist mit ihr weg; die
// Kopfzeile der App trägt keine.
function renderVersionInfo() {
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

// Suche und Filter der Kontoliste. ⚠️ Modulweit gehalten, nicht im DOM der
// Liste: ladeKonten() zeichnet nach jedem Orga-Haken alles neu, und die Suche
// soll das überstehen.
const KONTEN_FILTER = [
  { id: "alle", label: "Alle", passt: () => true },
  { id: "veranstalter", label: "⭐ Veranstalter", passt: (z) => z.dataset.admin === "1" },
  { id: "orga", label: "🛠 Orga", passt: (z) => z.dataset.orga === "1" },
  { id: "streamer", label: "🎥 Streamer", passt: (z) => z.dataset.streamer === "1" },
  { id: "kein-streamer", label: "ohne 🎥", passt: (z) => z.dataset.streamer !== "1" },
  { id: "kein-discord", label: "💬❌ ohne Discord", passt: (z) => z.dataset.discord !== "1" },
];
let kontenFilterAktiv = "alle";

function kontenFiltern() {
  const box = document.getElementById("konten-liste");
  const chips = document.getElementById("konten-chips");
  const suche = (document.getElementById("konten-suche").value || "").trim().toLowerCase();
  const zeilen = Array.from(box.querySelectorAll(".konto-zeile"));
  const filter = KONTEN_FILTER.find((f) => f.id === kontenFilterAktiv) || KONTEN_FILTER[0];
  const nachName = (z) => !suche || z.dataset.name.indexOf(suche) >= 0;

  let sichtbar = 0;
  zeilen.forEach((z) => {
    const zeigen = nachName(z) && filter.passt(z);
    z.hidden = !zeigen;
    if (zeigen) sichtbar += 1;
  });

  // Die Zahl an jedem Chip richtet sich nach der Suche: „🛠 Orga 2" heißt,
  // zwei Orga-Leute passen zum eingegebenen Namen.
  chips.innerHTML = KONTEN_FILTER.map((f) => {
    const n = zeilen.filter((z) => nachName(z) && f.passt(z)).length;
    return `<button type="button" class="sk-chip${f.id === kontenFilterAktiv ? " aktiv" : ""}" data-konten-filter="${f.id}" aria-pressed="${f.id === kontenFilterAktiv}">${escapeHtml(f.label)} <span class="sk-chip-zahl">${n}</span></button>`;
  }).join("");

  const treffer = document.getElementById("konten-treffer");
  if (treffer) {
    treffer.textContent = sichtbar === zeilen.length
      ? zeilen.length + " " + (zeilen.length === 1 ? "Konto" : "Konten")
      : sichtbar + " von " + zeilen.length + " Konten";
  }
  const leer = document.getElementById("konten-kein-treffer");
  if (leer) leer.hidden = sichtbar > 0 || !zeilen.length;
}

function kontenDatum(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.getDate() + "." + (d.getMonth() + 1) + "." + d.getFullYear();
}

// Hintergrund-Aktualisierung der Kontoliste. ⚠️ Nur solange der Reiter offen
// und die Seite sichtbar ist – jede Runde ist ein Aufruf beim Worker.
const KONTEN_TAKT_MS = 30000;
let kontenTakt = null;
let kontenLaeuft = false;
let kontenLetzterStand = "";

function kontenUhr() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function kontenReiterOffen() {
  const tab = document.getElementById("tab-einstellungen");
  return !!tab && tab.classList.contains("active") && document.visibilityState !== "hidden";
}

// still = Hintergrundrunde: kein „Lade …“, kein Fehlerkasten, und neu
// gezeichnet wird nur, wenn sich an den Konten wirklich etwas geändert hat –
// sonst sprängen Liste und Fokus alle 30 Sekunden.
async function ladeKonten(optionen) {
  const still = !!(optionen && optionen.still);
  if (kontenLaeuft) return;
  kontenLaeuft = true;
  const box = document.getElementById("konten-liste");
  const stand = document.getElementById("konten-stand");
  if (!still) {
    zeigeFehler("konten-fehler", "");
    if (stand && !kontenLetzterStand) stand.textContent = "Lade …";
  }
  try {
    const daten = await kontenRufe("konto-liste");
    const eigener = (window.__AGELAN_KONTO__ || {}).nickname;
    const neuerStand = JSON.stringify(daten.konten);
    if (stand) stand.textContent = "Aktualisiert sich von selbst · Stand " + kontenUhr();
    if (still && neuerStand === kontenLetzterStand) return;
    kontenLetzterStand = neuerStand;
    zeigeFehler("konten-fehler", "");

    // ⚠️ Die Nachfassliste. Wer keine Discord-ID hinterlegt hat, bekommt
    // KEINE Nachricht, wenn sein Essen bereitliegt - und merkt das von selbst
    // nie. Ohne diesen Satz haelt der Veranstalter alle fuer informiert und
    // drei Leute holen ihr Essen nicht ab.
    const ohneId = daten.konten.filter((k) => !k.discord).map((k) => k.nickname);
    const fehlend = ohneId.length
      ? `<p class="konten-fehlend"><b>⚠️ ${ohneId.length} ohne Discord-ID:</b> ${escapeHtml(ohneId.join(", "))}<br>
         Diese Leute bekommen keine Nachricht, wenn ihr Essen da ist. Jede:r trägt sie selbst ein – oben auf den eigenen Namen tippen, dann „Mein Konto“.</p>`
      : "";

    // ⚠️ Der Worker meldet eine neue Anmeldung per Discord an die VERANSTALTER
    // (admin), bewusst nicht an die Orga. Diese Meldung läuft NACH der Antwort
    // an den neuen Nutzer – ein Fehlschlag ist also nirgends zu sehen. Deshalb
    // steht hier, wen sie überhaupt erreicht: sonst wäre „es kam nichts“ nicht
    // von „es gibt niemanden zum Anschreiben“ zu unterscheiden.
    const melder = daten.konten.filter((k) => k.admin && k.discord).map((k) => k.nickname);
    const meldung = melder.length
      ? `<p class="hinweis-text">🆕 Neue Anmeldungen meldet der Bot per Discord an: ${escapeHtml(melder.join(", "))}.</p>`
      : `<p class="konten-fehlend"><b>⚠️ Neue Anmeldungen meldet dir niemand.</b><br>
         Der Bot schreibt sie an jeden Veranstalter mit hinterlegter Discord-ID – gerade hat keiner eine. Trag deine oben über deinen Namen unter „Mein Konto“ ein.</p>`;

    box.innerHTML = daten.konten.length
      ? fehlend + meldung + `<p class="hinweis-text" id="konten-treffer"></p>` +
        `<p class="hinweis-text" id="konten-kein-treffer" hidden>Niemand passt zu Suche und Filter.</p>` +
        daten.konten.map((k) => `
          <div class="konto-zeile" data-name="${escapeHtml(String(k.nickname || "").toLowerCase())}" data-admin="${k.admin ? 1 : 0}" data-orga="${k.orga || k.admin ? 1 : 0}" data-streamer="${k.streamer ? 1 : 0}" data-discord="${k.discord ? 1 : 0}">
            <span class="konto-name">${k.admin ? "⭐ " : (k.orga ? "🛠 " : "👤 ")}${escapeHtml(k.nickname)}${k.nickname === eigener ? " <span class=\"konto-du\">(du)</span>" : ""}</span>
            ${k.discord ? "" : `<span class="konto-kein-discord" title="Keine Discord-ID hinterlegt – bekommt keine Nachricht, wenn das Essen bereitliegt">💬❌</span>`}
            <label class="konto-streamer" title="Gehört zur Organisation: hat alle Rechte und zahlt beim Essen nichts">
              <input type="checkbox" data-konto-orga="${escapeHtml(k.nickname)}" ${k.orga || k.admin ? "checked" : ""} ${k.admin ? "disabled" : ""}
                     aria-label="${escapeHtml(k.nickname)} gehört zur Organisation">
              🛠
            </label>
            <label class="konto-streamer" title="Darf sich in den Streamplan eintragen. Gilt auch für Orga und Veranstalter – ohne diesen Haken trägt sich niemand ein.">
              <input type="checkbox" data-konto-streamer="${escapeHtml(k.nickname)}" ${k.streamer ? "checked" : ""}
                     aria-label="${escapeHtml(k.nickname)} darf sich in den Streamplan eintragen">
              🎥
            </label>
            <span class="konto-datum">${kontenDatum(k.angelegtAm)}</span>
            <button type="button" class="mini-btn" data-konto-loeschen="${escapeHtml(k.nickname)}" title="Konto löschen" aria-label="Konto ${escapeHtml(k.nickname)} löschen">🗑</button>
          </div>`).join("")
      : `<p class="hinweis-text">Noch niemand hat sich ein Konto angelegt.</p>`;
    document.getElementById("konten-filter").hidden = !daten.konten.length;
    kontenFiltern();

    // ⚠️ Nach dem Umstellen die ganze Liste neu holen: „Orga" aendert das
    // Symbol vor dem Namen und die Rechte in der ganzen App. Ohne Neuladen
    // behauptet die Zeile daneben etwas, das nicht mehr stimmt.
    // ⚠️ Den Streamer-Haken fasst „Orga" seit 2026-09-14 NICHT mehr an: der
    // steht fuer sich und bleibt jederzeit abwaehlbar (siehe kontoDarfStreamen).
    box.querySelectorAll("[data-konto-orga]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        try {
          await kontenRufe("konto-orga", { nickname: cb.dataset.kontoOrga, orga: cb.checked });
          kontenLetzterStand = "";
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
          // Der Streamer-Haken lädt die Liste nicht neu – Filter und Zahlen
          // trotzdem nachziehen, sonst steht jemand unter „ohne 🎥“, der es hat.
          cb.closest(".konto-zeile").dataset.streamer = cb.checked ? "1" : "0";
          kontenFiltern();
          kontenLetzterStand = "";   // nächste Runde zeichnet mit dem neuen Stand
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
          kontenLetzterStand = "";
          await ladeKonten();
        } catch (e) {
          zeigeFehler("konten-fehler", e.message);
        }
      });
    });
  } catch (e) {
    // ⚠️ Eine fehlgeschlagene Hintergrundrunde (Funkloch) lässt die zuletzt
    // geladene Liste stehen – nur ein Laden ohne Liste meldet den Fehler.
    if (stand) stand.textContent = kontenLetzterStand
      ? "Aktualisieren fehlgeschlagen · Stand von vorhin" : "";
    if (!still || !kontenLetzterStand) {
      if (!kontenLetzterStand) box.innerHTML = "";
      zeigeFehler("konten-fehler", e.message);
    }
  } finally {
    kontenLaeuft = false;
  }
}

// Beim Hereinwechseln in den Reiter sofort laden und den Takt starten; beim
// Verlassen stoppen. Aufgerufen aus activateTab (drei Wege in einen Reiter).
function kontenReiterGewechselt(offen) {
  if (kontenTakt) {
    clearInterval(kontenTakt);
    kontenTakt = null;
  }
  if (!offen) return;
  ladeKonten({ still: !!kontenLetzterStand });
  kontenTakt = setInterval(() => {
    if (kontenReiterOffen()) ladeKonten({ still: true });
  }, KONTEN_TAKT_MS);
}

function setupEinstellungenTab() {
  if (!document.getElementById("konten-liste")) return;
  // Seite war im Hintergrund und kommt zurück: gleich nachsehen statt bis zur
  // nächsten Runde zu warten.
  document.addEventListener("visibilitychange", () => {
    if (kontenReiterOffen()) ladeKonten({ still: true });
  });

  document.getElementById("konten-suche").addEventListener("input", kontenFiltern);
  document.getElementById("konten-chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-konten-filter]");
    if (!chip) return;
    kontenFilterAktiv = chip.dataset.kontenFilter;
    kontenFiltern();
  });

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
  } else if (document.getElementById("tab-uebersicht")) {
    // ⚠️ Nur wenn NICHTS gemerkt ist. Der gemerkte Reiter schlaegt die
    // Uebersicht – wer zuletzt Essen abgerechnet hat, will dort weitermachen
    // und nicht jedes Mal einen Klick weiter weg starten.
    activateTab("uebersicht");
  }
  zeigeEinstellungenTab();
  renderVersionInfo();
}

// Die Skripte werden vom Passwort-Gate erst nach der Freigabe nachgeladen –
// dann ist DOMContentLoaded längst durch und würde nie mehr feuern.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupInfoTab);
else setupInfoTab();
