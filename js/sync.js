// Synchronizacja (etap 4).
// W dół: apka pobiera dane.json (treningi, ćwiczenia, zestawy) przy otwarciu i gdy wraca internet.
// W górę: wyniki treningów idą do prywatnego repo GitHub (kaizen-wyniki), skąd pobiera je Kraken.
import * as fallback from './data.js';
import { loadSessions } from './store.js';

const KEY_DATA = 'kaizen.dane';
const KEY_SYNC = 'kaizen.sync';      // { token, device, lastUp, lastDown }
const REPO = 'KaizenKuba/kaizen-wyniki';

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export function syncState() {
  const s = read(KEY_SYNC, {});
  if (!s.device) { s.device = 'ipad-' + Math.random().toString(36).slice(2, 8); write(KEY_SYNC, s); }
  return s;
}
export function setToken(token) { const s = syncState(); s.token = token.trim(); write(KEY_SYNC, s); }
export function setPassword(p) { const s = syncState(); s.haslo = p.trim().toLowerCase(); s.zleHaslo = false; s.brakHasla = false; write(KEY_SYNC, s); }

// Treningi są szyfrowane na Krakenie (AES-GCM, klucz z hasła przez PBKDF2). Hasło zna tylko iPad i Kraken.
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function decrypt(d, pass) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(d.salt), iterations: d.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(d.iv) }, key, unb64(d.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// Dane z Krakena mają format kreatora; dopisujemy liczbę poziomów w rodzinie (do ekranu treningu).
function fromKreator(d) {
  const ex = structuredClone(d.cwiczenia);
  const fam = {};
  for (const e of Object.values(ex)) (fam[e.family] ??= new Set()).add(e.level);
  for (const e of Object.values(ex)) e.levels ??= fam[e.family].size;
  return { wersja: d.wersja, exercises: ex, sets: d.zestawy, trainings: d.treningi };
}

export function loadData() {
  const d = read(KEY_DATA, null);
  if (d?.cwiczenia) { try { return fromKreator(d); } catch {} }
  return { wersja: null, exercises: fallback.exercises, sets: fallback.sets, trainings: fallback.trainings };
}

// Zwraca true, gdy przyszły nowe dane.
export async function pullData() {
  const r = await fetch('dane.json?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return false;
  let d = await r.json();
  const old = read(KEY_DATA, null);
  const s = syncState();
  if (old?.wersja === d.wersja && !s.zleHaslo) { s.lastDown = Date.now(); write(KEY_SYNC, s); return false; }
  if (d.enc) {
    if (!s.haslo) { s.brakHasla = true; write(KEY_SYNC, s); return false; }
    try { d = await decrypt(d, s.haslo); s.zleHaslo = false; }
    catch { s.zleHaslo = true; write(KEY_SYNC, s); return false; }
  }
  s.brakHasla = false;
  if (d.klucz && d.klucz !== s.token) s.token = d.klucz;   // klucz GitHub przychodzi z Krakena (zaszyfrowany)
  if (!d?.cwiczenia || !Array.isArray(d.treningi)) { write(KEY_SYNC, s); return false; }
  // Kraken poprosił o wyzerowanie wyników (kreator → Statystyki): czyścimy zapisane treningi na iPadzie
  const reset = d.ustawienia?.resetWynikow;
  if (reset && reset !== s.resetDone) { localStorage.setItem('kaizen.sessions', '[]'); s.resetDone = reset; delete s.lastUpCount; }
  s.lastDown = Date.now(); write(KEY_SYNC, s);
  write(KEY_DATA, d);
  // filmy do pamięci iPada, żeby działały bez internetu
  const clips = new Set(Object.values(d.cwiczenia).flatMap(e => [e.clip, e.clipAlt]).filter(Boolean));
  for (const c of clips) fetch(c).catch(() => {});
  return true;
}

const b64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

// Wysyła wszystkie sesje z tego iPada jako jeden plik sesje/<urządzenie>.json.
export async function pushResults() {
  const s = syncState();
  if (!s.token) return 'brak-tokenu';
  const sessions = loadSessions();
  if (s.lastUpCount === sessions.length) return 'aktualne';
  const url = `https://api.github.com/repos/${REPO}/contents/sesje/${s.device}.json`;
  const h = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' };
  const cur = await fetch(url, { headers: h, cache: 'no-store' });
  if (cur.status === 401 || cur.status === 403) return 'zly-token';
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const body = { message: `Wyniki ${s.device}: ${sessions.length} treningów`, content: b64(JSON.stringify({ device: s.device, sessions }, null, 1)), sha };
  const r = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify(body) });
  if (!r.ok) return r.status === 401 || r.status === 403 || r.status === 404 ? 'zly-token' : 'blad';
  s.lastUp = Date.now(); s.lastUpCount = sessions.length; write(KEY_SYNC, s);
  return 'wyslane';
}

let busy = false;
export async function syncAll(onNewData) {
  if (busy || !navigator.onLine) return;
  busy = true;
  try {
    if (await pullData().catch(() => false)) onNewData?.();
    return await pushResults().catch(() => 'blad');
  } finally { busy = false; }
}
