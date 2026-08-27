# 🎮 AgeLan – Turniere & Streamplan

Turnier- und Streamplan-Seite der AgeLan. Im Tab **Turnier** stehen alle Turniere der Veranstaltung nebeneinander — jede:r schreibt sich in die ein, bei denen sie oder er mitspielen will. Im Tab **Stream** tragen die Streamer selbst ein, wer wann vom Kanal sendet.

**➡️ [AgeLan öffnen](https://sc1911heiligenstadt.github.io/agelan/)**

## Zugang

Die Seite ist mit einem eigenen Passwort geschützt, nicht über das Vereinskonto. Erst nach der Freigabe werden die App-Skripte überhaupt geladen — vorher besteht keine Verbindung zur Datenbank.

## Lokal starten

Über den Eintrag `agelan` in `E:\.claude\launch.json` — der Server läuft dann auf `http://localhost:8791/`.

## Technik

Vanilla JavaScript ohne Build-Schritt — die Dateien werden so ausgeliefert, wie sie im Repo liegen. Veröffentlicht über GitHub Pages. Die Live-Daten liegen in einer Firebase-Datenbank, damit mehrere Geräte denselben Stand sehen.

---

Ein Werkzeug des 1. SC 1911 Heiligenstadt. Alle Werkzeuge auf einen Blick: [Tools-Übersicht](https://sc1911heiligenstadt.github.io/ToolsUebersicht/) · Erklärungen im [Toolbox Wiki](https://sc1911heiligenstadt.github.io/Vereinswiki/).
