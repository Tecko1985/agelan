// Minimaler Service Worker, nur damit die App als PWA installierbar ist.
// Kein Offline-Caching: die App braucht immer die Live-Verbindung zur Firebase-DB.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());
self.addEventListener("fetch", () => {});
