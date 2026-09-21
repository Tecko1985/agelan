// Minimaler Service Worker, nur damit die App als PWA installierbar ist.
// Kein Offline-Caching: die App braucht immer die Live-Verbindung zur Firebase-DB.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());
// Bewusst KEIN fetch-Handler (entfernt 2026-09-21): Chrome verlangt ihn seit
// Version 108/112 nicht mehr fuer die Installation, und ein leerer Handler
// bremst auf dem iPhone jede Anfrage aus. Nicht zurueckbauen.
