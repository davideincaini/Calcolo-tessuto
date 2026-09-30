/* =============================================================================
 * sw.js — service worker di Trama (funzionamento offline)
 * -----------------------------------------------------------------------------
 * Un service worker è uno script che il browser tiene "tra" l'app e la rete:
 *  1) alla prima visita salva in cache tutti i file dell'app;
 *  2) alle visite successive risponde dalla cache, così l'app si apre anche
 *     in reparto senza campo.
 *
 * IMPORTANTE: quando modifichi index.html, app.js, calc.js o styles.css,
 * incrementa CACHE_VERSION (es. trama-v2-3 → trama-v2-4). Altrimenti gli iPhone
 * continuano a usare la versione in cache. fibers.json invece non lo richiede
 * (strategia "prima la rete", più sotto).
 *
 * Differenza rispetto a Trama v1: in pulizia cancelliamo SOLO le cache che
 * iniziano con "trama-". Le cache sono condivise da tutte le app pubblicate
 * sullo stesso dominio (utente.github.io): cancellarle tutte, come faceva la
 * v1, svuota anche le cache delle tue altre PWA e le lascia senza offline
 * finché non le riapri con la rete.
 * ===========================================================================*/

const CACHE_PREFIX = "trama-";
const CACHE_VERSION = CACHE_PREFIX + "v2-3";

// Percorsi relativi alla cartella del service worker: funzionano sia su
// utente.github.io/repo/ sia in locale.
const APP_SHELL = [
  "./",
  "index.html",
  "styles.css",
  "calc.js",
  "app.js",
  "fibers.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // waitUntil: installazione completa solo a cache piena.
  // skipWaiting: la nuova versione si attiva subito.
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Solo le GET verso il nostro sito; il resto passa com'è.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.endsWith("fibers.json")) {
    // PRIMA LA RETE per il database: online ricevi l'ultima versione
    // pubblicata su GitHub (e la salviamo); offline, la copia in cache.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.open(CACHE_VERSION).then((c) => c.match(req)))
    );
    return;
  }

  // PRIMA LA CACHE per tutto il resto: apertura istantanea e offline.
  // Cerchiamo solo nella NOSTRA cache: un'altra PWA sullo stesso dominio
  // potrebbe avere un "index.html" suo.
  event.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(req).catch(() =>
          req.mode === "navigate" ? cache.match("index.html") : Response.error()
        );
      })
    )
  );
});
