# agelan

Vanilla-JS-Turnier-App für die „AgeLan" (2er-Team-Turnier, Gruppenphase + K.-o.) über **Firebase
Realtime Database + Anonymous Auth**. Eigenständige App nach dem Muster von `E:\familien-quartett`.
Deploy geplant über **GitHub Pages** (`Tecko1985/agelan`, Branch `main` → `tecko1985.github.io/agelan/`).
Lokaler Dev-Server: Eintrag `agelan` in `E:\.claude\launch.json`, **Port 8791**.

## Ablauf & Rollen
Ein aktives Turnier unter `turniere/aktuell`. Phasen: `anmeldung → teams → gruppen → ko → beendet`.
- **Veranstalter/Admin** = Ersteller (`meta.hostId` == eigene UID) **oder** wer den `meta.adminPin` kennt
  (in localStorage `agelan_admin_pin`). Aktionen: Teams bilden, Gruppen auslosen, K.-o. auslosen,
  Ergebnisse überschreiben (✎), Turnier zurücksetzen, Turnier löschen.
- **Zurücksetzen ≠ Löschen** (beide im Veranstalter-Modal): `setzeTurnierZurueck()` verwirft nur
  `teams`/`gruppen`/`spiele` und setzt `meta.phase` auf `anmeldung` + `siegerTeamId` auf null — die
  angemeldeten Spieler:innen, der PIN und die zuletzt gewählten Auslosungs-Optionen bleiben stehen
  (zweiter Durchlauf ohne Neuanmeldung). `loescheTurnier()` entfernt den ganzen Baum (`BASIS.remove()`),
  danach steht die App wieder auf „Turnier anlegen".
- **Spieler** = meldet sich mit Name + Rating (500–3000) an; meldet/bestätigt Ergebnisse **seiner** Team-Spiele.
- **Zuschauer** = jede:r mit Link sieht Lobby, Teams, Tabellen, Bracket live (read-only).

## Architektur
- `turnier-service.js` kapselt Firebase komplett und liefert über `getZustand()`/`onZustandsAenderung()`
  einen **fertig aufbereiteten** Zustand: Gruppentabellen und K.-o.-Bracket werden dort berechnet, nicht in app.js.
- `app.js` macht nur Screens/Rendering/Events. Screen-Routing in `bestimmeScreen()` ist phasengetrieben.
- Kein „Schiedsrichter-Gerät" nötig (anders als beim Quartett): alle Daten sind öffentlich, Tabellen/Bracket
  sind reine Ableitungen aus den `bestaetigt`-Spielen. Die K.-o.-**Auto-Progression** (nächste Runde /
  Sieger) läuft in `pruefeKoProgression()`, angestoßen von dem Client, der das letzte Ergebnis einer
  Runde bestätigt (idempotent per Existenz-Guard; Admin-Knopf „nächste Runde" als Fallback).
- **Balanced-Pairing** (`balancedPaare`): nach Rating sortiert, Bester + Schlechtester; ungerade Zahl →
  3er-Team ans schwächste Paar. **K.-o.-Seeding** (`bracketSeedReihenfolge` + platz-major): ergibt das
  klassische Über-Kreuz (A1–B2, B1–A2 …), Freilose bei nicht-2er-Potenz-Teilnehmerzahl.

## Datenmodell (Realtime Database)
```
turniere/aktuell/
  meta    : { name, erstelltAm, hostId, adminPin, phase, bestOf, anzahlGruppen, weiterProGruppe, punkteSieg, siegerTeamId }
  spieler/$uid : { name, rating, beigetretenAm }
  teams/$tid   : { name, ratingSchnitt, mitglieder:{uid:true}, gruppe }
  gruppen/$gid : { name, teamIds:{tid:true} }
  spiele/$sid  : { phase:"gruppe"|"ko", gruppe?, runde?, position?, teamA, teamB, saetzeA, saetzeB, status:"offen"|"gemeldet"|"bestaetigt", gemeldetVon }
```
Best-of-X ist ungerade ⇒ nie Unentschieden. Gruppentabelle: Punkte (`punkteSieg`, Sieg=3/Niederlage=0)
→ Satzdifferenz → erzielte Sätze → direktes Duell → Name.

## Gotchas
- **escapeHtml ist PFLICHT (XSS):** `app.js` rendert Spieler-/Teamnamen (= Firebase-Fremdeingaben) per
  innerHTML in Lobby, Team-Karten, Tabellen, Spielzeilen, Bracket und Melde-Dialog. Alle Namen laufen
  durch `escapeHtml()`. Bei neuen Render-Stellen mitziehen (verifiziert: `<img onerror>`-Name wird escaped).
- **Firebase erst konfigurieren:** solange `firebase-config.js` Platzhalter (`DEIN_...`) hat, aktiviert
  `firebase-mock.js` einen **localStorage-basierten** Ersatz (siehe unten). Live-Betrieb → `FIREBASE-SETUP.md`.
- **Cache-Busting:** JS/CSS-Änderungen brauchen ein Hochzählen von `?v=X.Y` in `index.html` (sonst sehen
  Rückkehrer die alte Version).
- **Sicherheit ehrlich benennen:** Anonymous Auth ⇒ jede:r mit Link darf schreiben; der Admin-PIN steht
  im öffentlich lesbaren `meta` und wird clientseitig geprüft. Die Regeln (`database.rules.json`) sichern
  nur Struktur + Rating-Bereich. Fun-Event-Niveau, **kein** abgesichertes System.

## firebase-mock.js (nur Tests/Offline-Demo, nie im Live-Pfad aktiv)
- Kompletter DB-Baum als ein JSON in `localStorage['agelan_mock_db']`; Cross-Tab-Sync über das native
  `storage`-Event ⇒ echte Mehr-Tab-Echtzeit lokal testbar.
- **Bewusster Unterschied zum echten Firebase:** die anonyme UID liegt in **sessionStorage** (`agelan_mock_uid`),
  ist also pro Tab verschieden ⇒ mehrere Spieler:innen in mehreren Tabs desselben Browsers simulierbar.
  Beim echten Anonymous Auth wäre die UID pro Profil geteilt (im Multi-Device-Live-Betrieb egal).

## Verifiziert (lokal, Mock, 2026-07-15)
Turnier anlegen · Login (Name+Rating) · Balanced-Pairing · manueller Tausch · Gruppen-Auslosung +
Round-Robin · Melde-Dialog · Zwei-Parteien-Bestätigung + Echtzeit-Sync zwischen Tabs · Rollen-Logik
(beteiligt/Gegner/Admin) · Gruppentabellen · K.-o.-Cross-Seeding · Auto-Progression bis Sieger ·
XSS-Escaping · Dark-Mode + Mobile (kein H-Scroll). Keine Konsolenfehler.

## Offen
- Optional: mehrere parallele Turniere über Codes (statt dem einen festen `turniere/aktuell`).
- **Bewusst nicht gebaut:** ToolsUebersicht-Kachel (AgeLan ist eigenständig, Zielgruppe = Event-Teilnehmer)
  und ein „PIN vergessen"-Weg (würde jeder Teilnehmer:in das Löschen erlauben — der PIN steht öffentlich
  lesbar im `meta` und lässt sich im Notfall per Firebase-Abfrage nachschlagen).
