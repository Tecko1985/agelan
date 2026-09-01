# 🎮 AgeLan – Turniere & Streamplan

Turnier- und Streamplan-Seite der AgeLan. Im Reiter **Turnier** stehen alle
Turniere der Veranstaltung nebeneinander — jede:r schreibt sich in die ein, bei
denen sie oder er mitspielen will. Im Reiter **Stream** tragen die Streamer
selbst ein, wer wann vom Kanal sendet.

**➡️ [AgeLan öffnen](https://tecko1985.github.io/agelan/)**

## Was drin ist

| Reiter | Wofür |
|---|---|
| **Turnier** | Alle Turniere nebeneinander, zum Selbst-Eintragen. Der Veranstalter legt neue an und pflegt die **K.-o.-Runde** |
| **Stream** | Der Sendeplan über die Veranstaltungstage — die Streamer tragen sich selbst ein |

Unter **Alle Einträge** steht der Gesamtstand, das Anlegen von Turnier und
Streamplan bleibt dem **Veranstalter** vorbehalten.

**Das Format kommt erst nach der Anmeldung.** Ein neues Turnier braucht nur Name und PIN.
Erst wenn feststeht, wer alles da ist, wählt der Veranstalter Turnierform und Ablauf —
und sieht dabei für jeden Ablauf vorgerechnet, wie viele Partien und Runden dabei
herauskämen und wie oft jede:r drankäme.

## Zugang

Die Seite ist mit einem **eigenen Passwort** geschützt, nicht über das
Vereinskonto. Erst nach der Freigabe werden die App-Skripte überhaupt geladen —
vorher besteht keine Verbindung zur Datenbank.

## Lokal starten

Über den Eintrag `agelan` in `E:\.claude\launch.json` — der Server läuft dann auf `http://localhost:8791/`.

Für die Offline-Fassung gibt es den eigenen Eintrag `age-lan-offline` auf `http://localhost:8807/`.

## Technik

Vanilla JavaScript ohne Build-Schritt — die Dateien werden so ausgeliefert, wie sie im Repo liegen. Veröffentlicht über GitHub Pages. Die Live-Daten liegen in einer Firebase-Datenbank, damit mehrere Geräte denselben Stand sehen.

---

Ein Werkzeug des 1. SC 1911 Heiligenstadt. Alle Werkzeuge auf einen Blick: [Tools-Übersicht](https://sc1911heiligenstadt.github.io/ToolsUebersicht/) · Erklärungen im [Toolbox Wiki](https://sc1911heiligenstadt.github.io/Vereinswiki/).
