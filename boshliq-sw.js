/* BOSHLIQ ILOVASI — xizmat ishchisi (service worker)
   Faqat ilova qobig'ini (sahifa, belgi, manifest) saqlaydi: internet yo'q
   paytda ham ilova ochiladi va oxirgi raqamlar (sahifa o'zi saqlaydi)
   ko'rinadi. API so'rovlariga TEGMAYDI — raqamlar doim serverdan.
   Har doim avval tarmoq: yangi versiya chiqsa darhol ko'rinadi. */
const CACHE = 'boshliq-v1';
const SHELL = ['/boshliq', '/boshliq.webmanifest', '/boshliq-icon-180.png', '/boshliq-icon-192.png', '/boshliq-icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => null).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('boshliq-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const isPage = req.mode === 'navigate' && url.pathname.startsWith('/boshliq');
  const isShell = SHELL.includes(url.pathname);
  if (!isPage && !isShell) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          /* sahifa kalit (?k=) bilan ochilsa ham bitta nusxa saqlanadi */
          caches.open(CACHE).then((c) => c.put(isPage ? '/boshliq' : url.pathname, copy)).catch(() => null);
        }
        return res;
      })
      .catch(() => caches.match(isPage ? '/boshliq' : url.pathname).then((r) => r || Response.error())),
  );
});
