// Całe filmy-treningi: odtwarzanie z YouTube albo – jeśli pobrane – z pamięci iPada.
// Pobieranie: części filmu z prywatnego repo KaizenKuba/kaizen-filmy (ten sam klucz GitHub co do wyników).
import { syncState } from './sync.js';

const REPO = 'KaizenKuba/kaizen-filmy';
const CACHE = 'kaizen-filmy-pelne';
const key = (id, n) => `film/${id}/${n}`;

async function gh(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' }, cache: 'no-store' });
  if (r.status === 401 || r.status === 403) throw new Error('Klucz GitHub nie ma dostępu do repo kaizen-filmy (dodaj je do klucza).');
  if (r.status === 404) throw new Error('Tego filmu nie ma do pobrania. Zaznacz go w kreatorze („Do pobrania na iPada”).');
  if (!r.ok) throw new Error('Błąd pobierania (' + r.status + ')');
  return r;
}

export async function meta(id) {
  try { const r = await (await caches.open(CACHE)).match(key(id, 'meta')); return r ? await r.json() : null; } catch { return null; }
}
export const isCached = async (id) => !!(await meta(id))?.complete;

let pobierane = {};
export const downloading = (id) => pobierane[id];

export async function download(id, onProgress = () => {}) {
  if (pobierane[id]) return pobierane[id];
  const token = syncState().token;
  if (!token) throw new Error('Najpierw wklej klucz GitHub (na dole ekranu głównego).');
  pobierane[id] = (async () => {
    const c = await caches.open(CACHE);
    const info = await (await gh(`${id}/info.json`, token)).json();
    for (let n = 0; n < info.czesci; n++) {
      if (await c.match(key(id, n))) { onProgress((n + 1) / info.czesci); continue; }   // wznowienie po przerwie
      const blob = await (await gh(`${id}/czesc-${String(n).padStart(3, '0')}`, token)).blob();
      await c.put(key(id, n), new Response(blob));
      onProgress((n + 1) / info.czesci);
    }
    await c.put(key(id, 'meta'), new Response(JSON.stringify({ ...info, complete: true, at: Date.now() })));
    try { await navigator.storage?.persist?.(); } catch { /* opcjonalne */ }
  })().finally(() => { delete pobierane[id]; });
  return pobierane[id];
}

export async function remove(id) {
  const c = await caches.open(CACHE);
  const m = await meta(id);
  for (let n = 0; n < (m?.czesci || 50); n++) await c.delete(key(id, n));
  await c.delete(key(id, 'meta'));
  if (urls[id]) { URL.revokeObjectURL(urls[id]); delete urls[id]; }
}

const urls = {};
export async function objectUrl(id) {
  if (urls[id]) return urls[id];
  const c = await caches.open(CACHE), m = await meta(id);
  const parts = [];
  for (let n = 0; n < m.czesci; n++) parts.push(await (await c.match(key(id, n))).blob());
  return (urls[id] = URL.createObjectURL(new Blob(parts, { type: m.typ || 'video/mp4' })));
}

// ---- odtwarzacz YouTube (iframe) sterowany komendami start/pauza ----
export function youtubeFrame(id) {
  const f = document.createElement('iframe');
  f.id = 'yt';
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.setAttribute('allowfullscreen', '');
  f.src = `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(location.origin)}`;
  return f;
}
export function youtubeCommand(frame, func, args = []) {
  try { frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*'); } catch { /* ramka jeszcze się ładuje */ }
}
