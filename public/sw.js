/* Service worker minimal de claude-comm :
 * - met en cache la coquille du dashboard (/, manifeste, icône) pour le
 *   démarrage hors-ligne / instantané de la PWA
 * - ne met JAMAIS en cache les appels API (/c/..., /pair, /channels...) :
 *   tout le temps réel passe en réseau pur
 */
'use strict';

const CACHE = 'claude-comm-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = e.request.method === 'GET' && url.origin === self.location.origin &&
    SHELL.includes(url.pathname);
  if (!isShell) return; // API et tout le reste : réseau direct, zéro cache
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
