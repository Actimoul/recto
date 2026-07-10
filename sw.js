// Recto Service Worker — v88 (cache propre + anti vieux-chunk)
const CACHE = 'recto-v200';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest'];

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

// v195 : un asset hashé absent du serveur = index.html périmé servi depuis le cache.
// On purge tout et on se désinscrit ; le prochain chargement repart d'un serveur propre.
let _destroying = false;
function selfDestruct() {
  if (_destroying) return;
  _destroying = true;
  caches.keys()
    .then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
    .catch(() => {})
    .then(() => self.registration.unregister())
    .catch(() => {});
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Web Share Target (v170) : Android partage un document vers Recto via un POST.
  // On stocke les fichiers dans un cache dédié puis on redirige vers l'app,
  // qui les récupérera (?shared=1) même si l'utilisateur doit d'abord se connecter.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const files = form.getAll('files');
        const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', names: [], types: [], when: Date.now() };
        const cache = await caches.open('recto-share');
        await cache.put('meta', new Response(JSON.stringify(meta)));
        let i = 0;
        for (const f of files) {
          meta.names.push(f.name || ('fichier-' + i)); meta.types.push(f.type || '');
          await cache.put('file-' + i, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
          i++;
        }
        await cache.put('meta', new Response(JSON.stringify(meta)));
      } catch (err) { /* partage illisible : on redirige quand même */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // Supabase & co : réseau direct

  // Navigation : réseau d'abord, fallback shell hors-ligne
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r && r.ok) caches.open(CACHE).then((c) => c.put('./index.html', r.clone())).catch(() => {});
          return r || Response.error();
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || Response.error()))
    );
    return;
  }

  // Assets hashés par Vite : réseau d'abord (évite de servir un vieux chunk en cache),
  // on met en cache la version fraîche, et on retombe sur le cache uniquement hors-ligne.
  // v195 : ne jamais résoudre respondWith(undefined) — ça fait planter le SW ("erreur
  // inattendue") et laisse une page blanche. Si un asset a disparu du serveur (404),
  // c'est que l'index.html servi est périmé : le SW se saborde pour repartir propre.
  if (url.pathname.includes('/assets/')) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
            return r;
          }
          if (r && r.status === 404) selfDestruct();
          return r || Response.error();
        })
        .catch(() => caches.match(e.request).then((hit) => hit || Response.error()))
    );
    return;
  }

  // Reste : cache d'abord
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r && r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return r || Response.error();
    })).catch(() => caches.match(e.request).then((hit) => hit || Response.error()))
  );
});
