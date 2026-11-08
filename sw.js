// Service worker: la app funciona sin conexión y las portadas ya vistas se guardan.
const V = 'backlog-shell-v32', IMG = 'backlog-img-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, {cache: 'reload'}))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== V && k !== IMG).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  // Portadas externas: cache primero
  if (r.destination === 'image' && u.origin !== location.origin) {
    e.respondWith(caches.open(IMG).then(async c => {
      const hit = await c.match(r);
      if (hit) return hit;
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 12000);   // si el CDN está bloqueado no esperamos eternamente
      try {
        const res = await fetch(r, {signal: ac.signal});
        if (res.ok || res.type === 'opaque') c.put(r, res.clone());   // las respuestas de error no se guardan
        return res;
      } catch (_) { return Response.error(); }
      finally { clearTimeout(to); }
    }));
    return;
  }
  // Archivos de la app: cache primero y se actualiza en segundo plano
  if (u.origin === location.origin) {
    e.respondWith(caches.match(r).then(hit => {
      const net = fetch(r).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(r, copy)); }
        return res;
      });
      if (hit) { net.catch(() => {}); return hit; }
      return net;
    }));
  }
});
