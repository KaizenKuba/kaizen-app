// Zapis na iPadzie. Etap 1: localStorage. Od etapu 4 wyniki trafiają też do kolejki synchronizacji.

const KEY_SESSIONS = 'kaizen.sessions';
const KEY_SETTINGS = 'kaizen.settings';

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* pełna pamięć / tryb prywatny */ }
}

export const loadSessions = () => read(KEY_SESSIONS, []);
export function saveSession(s) { const all = loadSessions(); all.push(s); write(KEY_SESSIONS, all); }

export const loadSettings = () => read(KEY_SETTINGS, { sounds: true, voice: true, weeklyGoal: 4 });
export const saveSettings = (s) => write(KEY_SETTINGS, s);

/** Ostatni wynik danego ćwiczenia (z poprzednich treningów). */
export function lastResult(exId) {
  const all = loadSessions();
  for (let i = all.length - 1; i >= 0; i--) {
    const ser = all[i].series.filter(x => x.exId === exId);
    if (ser.length) return ser[ser.length - 1];
  }
  return null;
}

function weekStart(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // poniedziałek
  return x.getTime();
}

/** Passa tygodniowa: ile treningów w tym tygodniu i ile pełnych tygodni z rzędu z celem. */
export function weeklyStreak(goal) {
  const all = loadSessions();
  const perWeek = new Map();
  for (const s of all) { const w = weekStart(s.end); perWeek.set(w, (perWeek.get(w) || 0) + 1); }
  const now = weekStart(Date.now());
  const thisWeek = perWeek.get(now) || 0;
  let streak = 0;
  const prev = (t) => { const d = new Date(t); d.setDate(d.getDate() - 7); return d.getTime(); };
  for (let w = prev(now); (perWeek.get(w) || 0) >= goal; w = prev(w)) streak++;
  if (thisWeek >= goal) streak++;
  return { thisWeek, streak };
}
