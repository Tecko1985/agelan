// ===========================================================================
// app.js – Screens, Rendering, Events. Redet nur über turnierService.
// Alle aus Firebase stammenden Werte (v. a. Namen) werden mit escapeHtml()
// escaped, bevor sie per innerHTML eingesetzt werden (XSS-Schutz).
// ===========================================================================

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
  if (!z.vorhanden) return "screen-start";
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

  if (screen === "screen-start") renderStart(z);
  if (screen === "screen-lobby") renderLobby(z);
  if (screen === "screen-teams") renderTeams(z);
  if (screen === "screen-gruppen") renderGruppen(z);
  if (screen === "screen-ko") renderKo(z);
  if (screen === "screen-beendet") renderBeendet(z);

  // Admin-Zahnrad nur zeigen, wenn ein Turnier existiert
  document.getElementById("btn-admin-oeffnen").style.display = z.vorhanden ? "" : "none";
}

// --- START -----------------------------------------------------------------
function renderStart(z) {
  const keins = document.getElementById("start-kein-turnier");
  const laeuft = document.getElementById("start-turnier-laeuft");
  if (!z.vorhanden) {
    keins.style.display = "";
    laeuft.style.display = "none";
    return;
  }
  keins.style.display = "none";
  laeuft.style.display = "";
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

  const adminBlock = document.getElementById("teams-admin");
  adminBlock.style.display = z.istAdmin ? "" : "none";
  document.getElementById("teams-warte").style.display = z.istAdmin ? "none" : "";

  if (z.istAdmin) {
    const optionen = z.teams
      .flatMap((t) => t.mitgliederUids.map((uid) => ({ uid, name: spielerNameVon(z, uid), team: t.name })))
      .map((o) => `<option value="${escapeHtml(o.uid)}">${escapeHtml(o.name)} — ${escapeHtml(o.team)}</option>`)
      .join("");
    document.getElementById("tausch-a").innerHTML = optionen;
    document.getElementById("tausch-b").innerHTML = optionen;

    document.getElementById("los-teamzahl").textContent = "(" + z.teams.length + " Teams)";
    if (!losFelderInit) {
      losFelderInit = true;
      document.getElementById("los-gruppen").value = Math.max(1, Math.ceil(z.teams.length / 4));
    }
    aktualisiereLosVorschau(z.teams.length);
  }
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
  vorschauEl.textContent = "→ " + (alleGleich
    ? gruppen + " Gruppe" + (gruppen > 1 ? "n" : "") + " à " + groessen[0] + " Teams"
    : gruppen + " Gruppen: " + groessen.join(", ") + " Teams");
}

// --- GRUPPEN ---------------------------------------------------------------
function renderGruppen(z) {
  const container = document.getElementById("gruppen-container");
  container.innerHTML = z.gruppen
    .map((g) => {
      const zeilen = g.tabelle
        .map((r, i) => {
          const qual = i < (z.meta.weiterProGruppe || 2) ? " qual" : "";
          return `<tr class="${qual.trim()}">
            <td class="pos">${i + 1}</td>
            <td class="tname">${escapeHtml(r.name)}</td>
            <td>${r.spiele}</td>
            <td>${r.siege}-${r.niederlagen}</td>
            <td>${r.saetzePlus}:${r.saetzeMinus}</td>
            <td class="punkte">${r.punkte}</td>
          </tr>`;
        })
        .join("");
      const spiele = g.spiele.map((s) => spielZeileHtml(z, s)).join("");
      return `<div class="gruppe">
        <h3>Gruppe ${escapeHtml(g.name)}</h3>
        <table class="tabelle">
          <thead><tr><th></th><th>Team</th><th>Sp</th><th>S-N</th><th>Sätze</th><th>Pkt</th></tr></thead>
          <tbody>${zeilen}</tbody>
        </table>
        <div class="spiel-liste">${spiele}</div>
      </div>`;
    })
    .join("");

  const offen = z.spiele.filter((s) => s.phase === "gruppe" && s.status !== "bestaetigt").length;
  const adminBlock = document.getElementById("gruppen-admin");
  adminBlock.style.display = z.istAdmin ? "" : "none";
  if (z.istAdmin) {
    const btn = document.getElementById("btn-ko-losen");
    btn.disabled = offen > 0;
    document.getElementById("gruppen-admin-hinweis").textContent =
      offen > 0 ? `Noch ${offen} unbestätigte(s) Gruppenspiel(e).` : "Alle Gruppenspiele bestätigt – bereit für die K.-o.-Runde.";
  }
  const warte = document.getElementById("gruppen-warte");
  warte.style.display = z.istAdmin ? "none" : "";
  warte.textContent = offen > 0 ? `Noch ${offen} Gruppenspiel(e) offen.` : "Alle Gruppenspiele fertig – warte auf die K.-o.-Auslosung.";
}

// --- K.O. ------------------------------------------------------------------
function renderKo(z) {
  document.getElementById("ko-container").innerHTML = bracketHtml(z);
  document.getElementById("ko-admin").style.display = z.istAdmin ? "" : "none";
}

// --- BEENDET ---------------------------------------------------------------
function renderBeendet(z) {
  const sieger = z.bracket && z.bracket.siegerTeamId ? teamNameVon(z, z.bracket.siegerTeamId) : "—";
  document.getElementById("beendet-sieger").textContent = "🥇 " + sieger;
  document.getElementById("beendet-bracket").innerHTML = bracketHtml(z);
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
    .join("");
}

// --- Spiel-Zeile (Gruppe) + Aktionen --------------------------------------
function spielZeileHtml(z, s) {
  const ergebnis =
    s.status === "offen"
      ? '<span class="spiel-status">offen</span>'
      : `<span class="spiel-ergebnis${s.status === "bestaetigt" ? " ok" : ""}">${s.saetzeA}:${s.saetzeB}${s.status === "gemeldet" ? " ?" : " ✓"}</span>`;
  return `<div class="spiel-zeile">
    <div class="spiel-teams"><span>${escapeHtml(teamNameVon(z, s.teamA))}</span> <span class="vs">vs</span> <span>${escapeHtml(teamNameVon(z, s.teamB))}</span></div>
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

  // Turnier erstellen
  document.getElementById("btn-turnier-erstellen").addEventListener("click", async () => {
    const res = await turnierService.erstelleTurnier({
      name: document.getElementById("neu-name").value,
      adminPin: document.getElementById("neu-pin").value,
    });
    zeigeFehler("neu-fehler", res.erfolg ? "" : res.fehler);
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
    const res = await turnierService.loseGruppen({
      modus: modusEl ? modusEl.value : "setzliste",
      bestOf: document.getElementById("los-bestof").value,
      anzahlGruppen: document.getElementById("los-gruppen").value,
      weiterProGruppe: document.getElementById("los-weiter").value,
    });
    zeigeFehler("teams-fehler", res.erfolg ? "" : res.fehler);
  });
  document.getElementById("los-gruppen").addEventListener("input", () => {
    if (zustand) aktualisiereLosVorschau(zustand.teams.length);
  });

  // Gruppen: K.o. auslosen
  document.getElementById("btn-ko-losen").addEventListener("click", async () => {
    const res = await turnierService.starteKoAuslosung();
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
      { title: "Turnier aufsetzen", items: [
          "Teams anlegen und auf Gruppen verteilen.",
          "Gruppenphase mit automatischem Spielplan.",
          "K.-o.-Runde aus den Gruppenergebnissen."
      ]},
      { title: "Während des Turniers", items: [
          "Ergebnisse eintragen, Tabellen aktualisieren sich sofort.",
          "Alle Geräte sehen denselben Stand live.",
          "Eigener Veranstalter-Zugang für Änderungen am Turnier."
      ]},
      { title: "Turnier beenden oder neu starten", items: [
          "Zurücksetzen: Teams, Gruppen und Ergebnisse werden verworfen, alle Angemeldeten bleiben drin – ihr könnt sofort neu auslosen.",
          "Löschen: das komplette Turnier wird entfernt, danach lässt sich ein neues anlegen.",
          "Beides findest du als Veranstalter hinter dem Zahnrad oben rechts."
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
  const badge = document.getElementById("version-badge");
  if (badge) {
    badge.addEventListener("click", () => activateTab("info"));
    badge.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateTab("info"); }
    });
  }
  renderVersionInfo();
}

document.addEventListener("DOMContentLoaded", setupInfoTab);
