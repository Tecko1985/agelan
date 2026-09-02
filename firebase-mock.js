// ---------------------------------------------------------------------------
// Lokaler Firebase-Mock (NUR für Tests/Offline-Demo ohne echtes Firebase-Projekt).
//
// Bildet den kleinen Ausschnitt der Realtime-Database- und Anonymous-Auth-API
// nach, den turnier-service.js benutzt: db.ref(...).on/once/set/update/remove/child
// sowie firebase.database.ServerValue.{TIMESTAMP,increment} und auth.
//
// Persistenz: der komplette DB-Baum liegt als ein JSON in localStorage
// (Schlüssel agelan_mock_db). Änderungen in einem Tab lösen im selben Tab direkt
// und in anderen Tabs über das native 'storage'-Event ein Neu-Rendern aus – so
// funktioniert Echtzeit-Sync zwischen mehreren lokalen Tabs.
//
// WICHTIGER Unterschied zum echten Firebase (bewusst, fürs Testen): die anonyme
// UID liegt in sessionStorage, ist also PRO TAB verschieden. So kann man in
// mehreren Tabs desselben Browsers verschiedene Spieler:innen simulieren. Echtes
// Anonymous Auth teilt die UID über Tabs desselben Profils – im Live-Betrieb mit
// echten Geräten kein Thema.
//
// Aktiviert wird der Mock ausschließlich von firebase-config.js, solange dort
// noch die Platzhalter-Konfiguration steht.
// ---------------------------------------------------------------------------

(function () {
  const DB_KEY = "agelan_mock_db";
  const UID_KEY = "agelan_mock_uid";

  // --- Pfad-Helfer ---------------------------------------------------------
  function normalise(path) {
    return String(path || "").replace(/^\/+|\/+$/g, "");
  }
  function join(base, child) {
    base = normalise(base);
    child = normalise(child);
    return base && child ? base + "/" + child : base || child;
  }
  function readTree() {
    try {
      return JSON.parse(localStorage.getItem(DB_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function writeTree(tree) {
    localStorage.setItem(DB_KEY, JSON.stringify(tree));
  }
  function getAt(tree, path) {
    const parts = normalise(path).split("/").filter(Boolean);
    let node = tree;
    for (const p of parts) {
      if (node == null || typeof node !== "object") return null;
      node = node[p];
    }
    return node === undefined ? null : node;
  }
  // Setzt value an path; null/undefined bzw. leere Objekte löschen den Knoten
  // (Realtime-Database-Semantik: leere Knoten existieren nicht).
  function setAt(tree, path, value) {
    const parts = normalise(path).split("/").filter(Boolean);
    if (parts.length === 0) return value == null ? {} : value;
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (node[p] == null || typeof node[p] !== "object") node[p] = {};
      node = node[p];
    }
    const last = parts[parts.length - 1];
    if (value == null || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)) {
      delete node[last];
    } else {
      node[last] = value;
    }
    return tree;
  }

  // --- ServerValue-Sentinels auflösen -------------------------------------
  function resolveSentinels(value, absPath, tree) {
    if (value && typeof value === "object" && value.__sv) {
      if (value.__sv === "timestamp") return Date.now();
      if (value.__sv === "increment") return (Number(getAt(tree, absPath)) || 0) + value.delta;
    }
    if (Array.isArray(value)) return value.map((v, i) => resolveSentinels(v, join(absPath, i), tree));
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value)) out[k] = resolveSentinels(value[k], join(absPath, k), tree);
      return out;
    }
    return value;
  }

  // --- Listener-Verwaltung -------------------------------------------------
  const listeners = []; // { path, cb, lastJson }

  function snapshotFor(path, value) {
    return {
      key: normalise(path).split("/").pop() || null,
      val: () => (value === undefined ? null : value),
      exists: () => value !== null && value !== undefined,
      child: (p) => snapshotFor(join(path, p), getAt(readTree(), join(path, p))),
      hasChild: (p) => getAt(value, p) != null,
      numChildren: () => (value && typeof value === "object" ? Object.keys(value).length : 0),
      forEach: (fn) => {
        if (value && typeof value === "object") {
          Object.keys(value).forEach((k) => fn(snapshotFor(join(path, k), value[k])));
        }
      },
    };
  }

  function notifyAll() {
    const tree = readTree();
    listeners.forEach((l) => {
      const value = getAt(tree, l.path);
      const json = JSON.stringify(value === undefined ? null : value);
      if (json !== l.lastJson) {
        l.lastJson = json;
        try {
          l.cb(snapshotFor(l.path, value));
        } catch (e) {
          console.error("[mock] Listener-Fehler:", e);
        }
      }
    });
  }

  // Änderungen aus anderen Tabs
  window.addEventListener("storage", (e) => {
    if (e.key === DB_KEY) notifyAll();
  });

  // --- Reference -----------------------------------------------------------
  function makeRef(path) {
    path = normalise(path);
    return {
      key: path.split("/").pop() || null,
      child: (p) => makeRef(join(path, p)),
      on: (event, cb) => {
        if (event !== "value") return cb;
        const entry = { path, cb, lastJson: undefined };
        listeners.push(entry);
        const value = getAt(readTree(), path);
        entry.lastJson = JSON.stringify(value === undefined ? null : value);
        setTimeout(() => cb(snapshotFor(path, value)), 0); // async wie Firebase
        return cb;
      },
      off: (event, cb) => {
        for (let i = listeners.length - 1; i >= 0; i--) {
          if (listeners[i].path === path && (!cb || listeners[i].cb === cb)) listeners.splice(i, 1);
        }
      },
      once: (event) => Promise.resolve(snapshotFor(path, getAt(readTree(), path))),
      set: (value) => {
        const tree = readTree();
        const resolved = resolveSentinels(value, path, tree);
        writeTree(setAt(tree, path, resolved));
        notifyAll();
        return Promise.resolve();
      },
      update: (updates) => {
        const tree = readTree();
        for (const key of Object.keys(updates)) {
          const abs = join(path, key);
          setAt(tree, abs, resolveSentinels(updates[key], abs, tree));
        }
        writeTree(tree);
        notifyAll();
        return Promise.resolve();
      },
      remove: () => {
        const tree = readTree();
        writeTree(setAt(tree, path, null));
        notifyAll();
        return Promise.resolve();
      },
    };
  }

  // --- Auth ----------------------------------------------------------------
  function makeAuth() {
    let uid = null;
    try {
      uid = sessionStorage.getItem(UID_KEY);
      if (!uid) {
        uid = "u_" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(UID_KEY, uid);
      }
    } catch (e) {
      uid = "u_" + Math.random().toString(36).slice(2, 10);
    }
    const cbs = [];
    let user = null;
    return {
      onAuthStateChanged: (cb) => {
        cbs.push(cb);
        if (user) setTimeout(() => cb(user), 0);
        return () => {};
      },
      signInAnonymously: () => {
        user = { uid, isAnonymous: true };
        setTimeout(() => cbs.forEach((cb) => cb(user)), 0);
        return Promise.resolve({ user });
      },
      get currentUser() {
        return user;
      },
    };
  }

  // --- Öffentliches Mock-firebase-Objekt ----------------------------------
  const databaseFn = () => ({ ref: (p) => makeRef(p || "") });
  databaseFn.ServerValue = {
    TIMESTAMP: { __sv: "timestamp" },
    increment: (delta) => ({ __sv: "increment", delta }),
  };
  const authSingleton = makeAuth();

  window.createFirebaseMock = function () {
    return {
      initializeApp: () => {},
      database: databaseFn,
      auth: () => authSingleton,
    };
  };
})();
