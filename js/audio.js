// Dźwięki (bipy z Web Audio, bez plików) i lektor po polsku (systemowy głos iPada).
// iPad wymaga, żeby dźwięk „odblokować” pierwszym dotknięciem – robi to unlock().

let ctx = null;
export const settings = { sounds: true, voice: true };

export function getAudioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Gdy apka sama coś mówi albo bipa, komendy głosowe są ignorowane (żeby lektor nie „wydał” komendy).
let quietUntil = 0;
let speechUntil = 0, sayId = 0;   // szacowany koniec wypowiedzi lektora (iPad bywa, że nie zgłasza końca – nie ufamy speechSynthesis.speaking)
export function isSpeaking() {
  const t = Date.now();
  return t < quietUntil || t < speechUntil;
}

export function unlock() {
  try {
    getAudioContext();
    // pusta wypowiedź odblokowuje lektora na iOS
    if ('speechSynthesis' in window && !unlock.done) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; speechSynthesis.speak(u); unlock.done = true;
    }
  } catch { /* brak dźwięku nie blokuje treningu */ }
}

function tone(freq, ms, { gain = 0.35, delay = 0 } = {}) {
  if (!settings.sounds || !ctx) return;
  quietUntil = Math.max(quietUntil, Date.now() + delay + ms + 250);
  const t = ctx.currentTime + delay / 1000;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + ms / 1000 + 0.05);
}

export const beep = {
  start: () => { tone(880, 180); tone(1320, 320, { delay: 190 }); },
  stop: () => { tone(660, 200); tone(440, 380, { delay: 210 }); },
  tick: () => tone(1000, 90, { gain: 0.25 }),
  soft: () => tone(520, 120, { gain: 0.2 }),
};

let plVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith('pl'));
  plVoice = vs.find(v => v.localService) || vs[0] || null;
  return plVoice;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = pickVoice;

export function hasPolishVoice() { return !!(plVoice || pickVoice()); }

export function say(text, { interrupt = true } = {}) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pl-PL';
  const v = plVoice || pickVoice();
  if (v) u.voice = v;
  u.rate = 1.05;
  // ok. 65 ms na znak + zapas; gdy lektor skończy wcześniej, onend skraca blokadę
  speechUntil = Math.max(interrupt ? 0 : speechUntil, Date.now()) + Math.min(9000, 700 + text.length * 65);
  const id = ++sayId;   // koniec starej (przerwanej) wypowiedzi nie skraca blokady nowej
  u.onend = u.onerror = () => { if (id === sayId) speechUntil = Date.now() + 300; };
  speechSynthesis.speak(u);
}

/** Polska odmiana: 1 powtórzenie, 2 powtórzenia, 5 powtórzeń */
export function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14) ? few : many;
}
export function describeTarget(step) {
  if (step.mode === 'czas' && step.target >= 120) { const m = Math.round(step.target / 60); return `${m} ${plural(m, 'minuta', 'minuty', 'minut')}`; }
  return step.mode === 'czas'
    ? `${step.target} ${plural(step.target, 'sekunda', 'sekundy', 'sekund')}`
    : `${step.target} ${plural(step.target, 'powtórzenie', 'powtórzenia', 'powtórzeń')}`;
}

// --- blokada wygaszania ekranu podczas treningu ---
let lock = null;
export async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !lock) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } else if (!on && lock) { await lock.release(); lock = null; }
  } catch { /* np. karta w tle */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && keepAwake.wanted) keepAwake(true);
});
