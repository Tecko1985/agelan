# Firebase einrichten (einmalig, ~10 Minuten)

Solange in `firebase-config.js` noch die Platzhalter (`DEIN_...`) stehen, läuft die App im
**lokalen Test-Modus** (Daten nur im eigenen Browser). Für den echten Mehrgeräte-Betrieb einmalig
ein Firebase-Projekt anlegen:

## 1. Projekt anlegen
1. https://console.firebase.google.com/ öffnen → **Projekt hinzufügen**.
2. Name z. B. `agelan-turnier` (falls vergeben, `agelan-sc1911`). Google Analytics kann **aus** bleiben.

## 2. Realtime Database anlegen
1. Linkes Menü → **Erstellen › Realtime Database** → **Datenbank erstellen**.
2. Standort: **europe-west1 (Belgien)**.
3. Sicherheitsregeln: erst **im gesperrten Modus** starten (ändern wir gleich).

## 3. Sicherheitsregeln setzen
1. In der Realtime Database → Tab **Regeln**.
2. Kompletten Inhalt von **`database.rules.json`** (liegt in diesem Ordner) einfügen → **Veröffentlichen**.
   - Öffentlich lesbar (Zuschauer), schreiben nur nach anonymer Anmeldung, Grundstruktur wird geprüft.

## 4. Anonyme Anmeldung aktivieren
1. Linkes Menü → **Erstellen › Authentication** → **Jetzt starten**.
2. Tab **Sign-in-Methode** → **Anonym** → aktivieren → speichern.

## 5. Web-App registrieren & Schlüssel eintragen
1. Projektübersicht → Zahnrad **Projekteinstellungen** → unten **Meine Apps** → **Web** (`</>`).
2. Spitzname `agelan`, **ohne** Hosting → registrieren.
3. Den angezeigten `firebaseConfig`-Block kopieren und in **`firebase-config.js`** die Platzhalter
   ersetzen (v. a. `apiKey`, `authDomain`, `databaseURL`, `projectId`, `appId`).
   - Wichtig: die `databaseURL` muss dabei sein (steht bei Realtime-DB-Projekten in der Config).
4. Speichern, `?v=`-Version in `index.html` hochzählen, committen, deployen.

## Sicherheits-Hinweis (ehrlich)
Anonyme Anmeldung heißt: **jede:r** mit dem Link bekommt eine gültige (anonyme) Kennung und darf
schreiben. Die Regeln verhindern kaputte Datenstruktur und beschränken das Rating auf 500–3000, aber
sie sind **keine** echte Zugriffskontrolle. Der Admin-PIN steckt im öffentlich lesbaren Datensatz und
schützt nur vor versehentlichem Zugriff. Das ist für ein Vereins-/Fun-Event völlig ok – es ist aber
**kein** abgesichertes System, und so sollte es auch nicht verkauft werden.
