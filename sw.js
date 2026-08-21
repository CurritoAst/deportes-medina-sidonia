/* ==========================================================================
   Deportes · Medina Sidonia — service worker
   Red primero con copia en caché: siempre fresco con conexión y usable
   sin ella (la web funciona con los datos ya guardados en el dispositivo).
   ========================================================================== */

'use strict';

const CACHE = 'msd-v5';
const NUCLEO = [
  './',
  'index.html',
  'admin.html',
  'css/styles.css',
  'js/data.js',
  'js/qr.js',
  'js/sync.js',
  'js/auth.js',
  'js/app.js',
  'js/admin.js',
  'js/vendor/jsQR.js',
  'manifest.webmanifest',
  'icono.svg',
  'icono-180.png'
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(NUCLEO))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  // La API y los eventos en directo nunca pasan por la caché
  if (ev.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  ev.respondWith(
    fetch(ev.request)
      .then((respuesta) => {
        // Solo se cachea lo propio y nunca una respuesta que fije cookies
        // (una sesión no debe quedar guardada en la caché del navegador).
        if (respuesta.ok && url.origin === location.origin && !respuesta.headers.get('set-cookie')) {
          const copia = respuesta.clone();
          caches.open(CACHE).then((cache) => cache.put(ev.request, copia));
        }
        return respuesta;
      })
      .catch(() =>
        caches.match(ev.request).then((guardada) => {
          if (guardada) return guardada;
          // Sin red y sin copia: solo las NAVEGACIONES (abrir una página) caen a
          // index.html; un script/css/icono sin copia simplemente falla.
          if (ev.request.mode === 'navigate' && !url.pathname.startsWith('/admin')) {
            return caches.match('index.html');
          }
          return Response.error();
        })
      )
  );
});
