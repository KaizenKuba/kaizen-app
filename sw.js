// Tryb offline: wszystkie pliki apki trafiają do pamięci iPada przy pierwszym wczytaniu.
// Zmień VERSION przy każdej nowej wersji, żeby iPad pobrał nowe pliki.
const VERSION = 'kaizen-20261118-090302';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/main.js', 'js/engine.js', 'js/audio.js', 'js/store.js', 'js/data.js', 'js/voice.js', 'js/sync.js', 'js/filmy.js', 'vosk/vosk.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/space-grotesk-latin-500-normal.woff2', 'fonts/space-grotesk-latin-700-normal.woff2',
  'fonts/space-grotesk-latin-ext-500-normal.woff2', 'fonts/space-grotesk-latin-ext-700-normal.woff2',
  'fonts/jetbrains-mono-latin-700-normal.woff2',
  'klipy/pompki_sciana.mp4', 'klipy/pompki_kolana.mp4', 'klipy/pompki.mp4', 'klipy/navy_seal_pompki.mp4',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Najpierw sieć (świeża wersja), a gdy jej nie ma albo milczy dłużej niż 2 s – pamięć iPada.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  if (e.request.url.endsWith('.tar.gz')) return;
  if (new URL(e.request.url).pathname.endsWith('/dane.json')) return;   // dane trzyma sync.js   // model mowy ma własną pamięć (voice.js)
  // Filmiki: Safari na iPadzie prosi o kawałki pliku (nagłówek Range) i bez odpowiedzi 206 nie odtwarza pętli.
  const range = e.request.headers.get('range');
  if (range) { e.respondWith(rangeResponse(e.request, range)); return; }
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const net = fetch(e.request).then(r => { if (r.status === 200) c.put(e.request, r.clone()).catch(() => {}); return r; });
    const timeout = new Promise(res => setTimeout(res, 2000));
    try {
      const r = await Promise.race([net, timeout]);
      if (r) return r;
    } catch { /* brak sieci */ }
    return (await c.match(e.request, { ignoreSearch: true })) || net;
  }));
});

// Odpowiedź 206 z pamięci (cały plik zapisany raz); gdy pliku nie ma – z sieci, a w tle zapisujemy cały plik na później.
async function rangeResponse(req, range) {
  const c = await caches.open(VERSION);
  let full = await c.match(req.url, { ignoreSearch: true });
  if (!full) {
    try {
      const r = await fetch(req.url, { cache: 'no-store' });
      if (r.status !== 200) return fetch(req);
      await c.put(req.url, r.clone());
      full = r;
    } catch { return fetch(req); }
  }
  const buf = await full.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let a = m[1] ? Number(m[1]) : size - Number(m[2] || size);
  let b = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (!(a >= 0) || a >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(buf.slice(a, b + 1), { status: 206, headers: {
    'Content-Type': full.headers.get('Content-Type') || 'video/mp4', 'Content-Length': String(b - a + 1),
    'Content-Range': `bytes ${a}-${b}/${size}`, 'Accept-Ranges': 'bytes' } });
}
