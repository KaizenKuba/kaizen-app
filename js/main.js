// Kaizen Workout – apka na iPada (etap 4: dane z Krakena przez synchronizację + komendy głosowe).
import * as sync from './sync.js';
import * as filmy from './filmy.js';
import { buildSteps, Engine } from './engine.js';
import { beep, say, unlock, settings as audioSettings, describeTarget, hasPolishVoice, keepAwake } from './audio.js';
import * as voice from './voice.js';
import { loadSettings, saveSettings, saveSession, lastResult, weeklyStreak } from './store.js';

const $ = (id) => document.getElementById(id);

// ?speed=10 przyspiesza zegar (do testów na komputerze)
const SPEED = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1);
const now = () => performance.now() * SPEED;

const settings = loadSettings();
if (settings.commands === undefined) settings.commands = true;
Object.assign(audioSettings, { sounds: settings.sounds, voice: settings.voice });

let { exercises, sets, trainings } = sync.loadData();
let engine = null;
const MIN_SEC = 60;   // krótsze treningi nie są zapisywane
let training = null;
let rpe = null;

// ---------------- nawigacja ----------------
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

// ---------------- ekran główny ----------------
const PHASE_NAMES = { rozgrzewka: 'Rozgrzewka', trening: 'Trening', schladzanie: 'Schładzanie' };

function fmt(sec) {
  sec = Math.max(0, Math.ceil(sec));
  if (sec < 60) return String(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function fmtLong(sec) { sec = Math.round(sec); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

function renderHome() {
  const { thisWeek, streak } = weeklyStreak(settings.weeklyGoal);
  $('streak').innerHTML =
    `<div><b>${thisWeek}/${settings.weeklyGoal}</b> <span>treningów w tym tygodniu</span></div>` +
    `<div><b>${streak}</b> <span>${streak === 1 ? 'tydzień' : 'tygodni'} z rzędu z celem</span></div>`;

  $('tiles').innerHTML = '';
  for (const t of trainings) {
    const steps = buildSteps(t, { exercises, sets });
    const work = steps.filter(s => s.kind === 'work' && s.phase === 'trening').length;
    const mins = Math.round(new Engine(steps).remainingTotal(0) / 60);
    const b = document.createElement('button');
    b.className = 'tile';
    b.innerHTML = `<div class="thumb">${t.name[0]}</div><div class="meta"><b>${t.name}</b><small>${work} serii · ok. ${mins} min</small></div>`;
    b.onclick = () => startTraining(t);
    $('tiles').append(b);
  }
  $('tgl-voice').setAttribute('aria-pressed', settings.voice);
  $('tgl-sounds').setAttribute('aria-pressed', settings.sounds);
  $('tgl-commands').setAttribute('aria-pressed', settings.commands);
  renderModelNote();
  renderSyncNote();
  renderFilmyOffline();
  setTimeout(() => { $('voice-warn').hidden = !('speechSynthesis' in window) || hasPolishVoice() || !settings.voice; }, 600);
}

function toggleSetting(key) {
  settings[key] = !settings[key];
  audioSettings[key] = settings[key];
  saveSettings(settings);
  renderHome();
}
$('tgl-voice').onclick = () => toggleSetting('voice');
$('tgl-sounds').onclick = () => toggleSetting('sounds');
$('tgl-commands').onclick = () => toggleSetting('commands');

// Model mowy pobiera się raz (przy internecie) i potem działa bez sieci.
async function renderModelNote() {
  const el = $('voice-model');
  if (!settings.commands) { el.textContent = ''; return; }
  if (await voice.modelCached()) { el.textContent = 'Komendy głosowe gotowe, działają bez internetu.'; el.className = 'note ok'; return; }
  el.textContent = 'Pobieram model mowy (ok. 50 MB, jednorazowo)…'; el.className = 'note';
  await voice.preload();
  const ok = await voice.modelCached();
  el.textContent = ok ? 'Komendy głosowe gotowe, działają bez internetu.' : 'Nie udało się pobrać modelu mowy. Połącz się z internetem i otwórz apkę ponownie.';
  el.className = ok ? 'note ok' : 'note';
}

// ---------------- trening ----------------
function startTraining(t) {
  unlock();
  training = t;
  engine = new Engine(buildSteps(t, { exercises, sets }), onEvent);
  const klipyTreningu = engine.steps.map(st => st.ex?.clip);
  let pominieto = false;
  $('btn-load-skip').onclick = () => { pominieto = true; $('ov-load').hidden = true; };
  rozgrzejKlipy(klipyTreningu, (n, all) => {   // wszystkie filmiki treningu od razu do pamięci
    if (pominieto) return;
    $('ov-load').hidden = n >= all;
    $('load-text').textContent = `${n} z ${all} filmów${navigator.onLine ? '' : ' – brak internetu, zacznij bez czekania'}`;
    $('load-bar').style.width = `${Math.round(n / all * 100)}%`;
  });
  keepAwake.wanted = true; keepAwake(true);
  show('workout');
  engine.enter(0, now());
  loop();
  if (settings.commands) voice.listen(onVoice);
}

// ---------------- komendy głosowe ----------------
voice.onStatus((st, err) => {
  const m = $('mic');
  m.hidden = !settings.commands;
  m.className = 'mic ' + st;
  $('mic-text').textContent = { listening: 'słucham', loading: 'włączam mikrofon…', error: err, off: 'mikrofon wył.' }[st] || st;
});

let heardTimer = 0;
function showHeard(word) {
  const h = $('heard');
  h.textContent = word; h.hidden = false;
  clearTimeout(heardTimer); heardTimer = setTimeout(() => { h.hidden = true; }, 1500);
}

function onVoice(word) {
  if (!engine || engine.status === 'finished') return;
  const t = now(), e = engine;
  if (e.status === 'confirmEnd') {
    if (word === 'tak' || word === 'koniec') { showHeard(word); e.answerEnd(true, t); }
    else if (word === 'nie') { showHeard(word); e.answerEnd(false, t); }
    return render();
  }
  const ex = e.step.kind === 'rest' ? e.step.next?.ex : e.step.ex;
  if (ex && ex.voice === false) return;          // głos wyłączony dla tego ćwiczenia
  switch (word) {
    case 'start': mainStart(t); break;
    case 'stop': e.stop(t); break;
    case 'pauza': e.pause(t); break;
    case 'dalej': e.next(t); break;
    case 'wróć': e.back(t); break;
    case 'jeszcze': e.more(t); break;
    case 'koniec': e.requestEnd(t); break;
    default: return;                              // „tak”/„nie” poza pytaniem o koniec
  }
  showHeard(word);
  render();
}

// tryb testowy (?speed=…): komendy można podać z konsoli, bez mikrofonu
if (SPEED > 1) window.kaizenCommand = onVoice;

/** START: z przyciskiem i głosem działa tak samo. */
function mainStart(t) {
  const e = engine;
  if (e.status === 'paused') return e.start(t);
  if (e.step.kind === 'rest' && e.status === 'running') {   // w przerwie: od razu następne ćwiczenie
    e.stop(t);
    if (e.status === 'waiting') e.start(t);
    return;
  }
  if (e.status === 'waiting') e.start(t);
}

function onEvent(e) {
  const s = e.step;
  switch (e.type) {
    case 'waiting':
      say(`${s.ex.name}, ${describeTarget(s)}. ${s.mode === 'ilosc' ? 'Start, gdy będziesz gotowy.' : 'Naciśnij start.'}`);
      break;
    case 'workStart': beep.start(); break;
    case 'workEnd': beep.stop(); break;
    case 'restStart':
      say(s.next ? `Przerwa. Następne: ${s.next.ex.name}, ${describeTarget(s.next)}.` : 'Przerwa.', { interrupt: false });
      break;
    case 'count': beep.tick(); say(['', 'jeden', 'dwa', 'trzy'][e.n] || String(e.n)); break;
    case 'tickEnd': beep.tick(); break;
    case 'paused': say('Pauza'); break;
    case 'confirmEnd': say('Na pewno zakończyć? Powiedz tak albo nie.'); break;
    case 'finished': onFinished(); break;
  }
}

// Zegar na setInterval (nie requestAnimationFrame), żeby bipy i przejścia działały nawet przy przyciemnionym ekranie.
let raf = 0;
function loop() {
  clearInterval(raf);
  raf = setInterval(() => {
    if (!engine || engine.status === 'finished') return clearInterval(raf);
    engine.tick(now());
    if (engine.status !== 'finished') render();
  }, 100);
}

let shownEx = null;
function setMedia(ex, isPreview) {
  $('media-label').hidden = !isPreview;
  if (shownEx === ex) return;
  shownEx = ex;
  const v = $('video');
  zamknijFilm();
  if (ex.film) { pokazFilm(ex); return; }
  if (ex.clip) {
    v.src = ex.clip; v.hidden = false; $('placeholder').hidden = true; v.play().catch(() => {});
  } else {
    v.removeAttribute('src'); v.hidden = true; $('placeholder').hidden = false;
    $('ph-letter').textContent = ex.name[0];
  }
  layoutForClip();
}

// ---- cały film-trening: z pamięci iPada (gdy pobrany) albo z YouTube ----
let filmTryb = null, filmGra = null;
function zamknijFilm() {
  $('yt')?.remove();
  const v = $('video');
  if (filmTryb === 'plik') { v.pause(); v.removeAttribute('src'); v.load(); }
  v.muted = true; v.loop = true;
  filmTryb = null; filmGra = null;
  $('placeholder').querySelector('small').textContent = 'film dojdzie z kreatora';
}
async function pokazFilm(ex) {
  const v = $('video'), id = ex.film.yt;
  if (await filmy.isCached(id)) {
    v.muted = false; v.loop = false; v.src = await filmy.objectUrl(id);
    v.hidden = false; $('placeholder').hidden = true; filmTryb = 'plik';
  } else if (navigator.onLine) {
    v.removeAttribute('src'); v.hidden = true; $('placeholder').hidden = true;
    const f = filmy.youtubeFrame(id);
    f.onload = () => { if (filmGra) setTimeout(() => filmy.youtubeCommand(f, 'playVideo'), 400); };
    $('media').append(f); filmTryb = 'yt';
  } else {
    v.hidden = true; $('placeholder').hidden = false; $('ph-letter').textContent = '▶';
    $('placeholder').querySelector('small').textContent = 'Brak internetu – ten film trzeba wcześniej pobrać na iPada (ekran główny → Pobierz).';
  }
  layoutForClip(); filmGra = null; syncFilm();
}
// film gra, gdy trening trwa (START), stoi przy pauzie i w przerwie
function syncFilm() {
  if (!shownEx?.film || !engine || !filmTryb) return;
  const st = engine.step;
  const want = engine.status === 'running' && st.kind === 'work' && st.ex === shownEx;
  if (want === filmGra) return;
  filmGra = want;
  if (filmTryb === 'plik') { const v = $('video'); want ? v.play().catch(() => {}) : v.pause(); }
  else filmy.youtubeCommand($('yt'), want ? 'playVideo' : 'pauseVideo');
}

// iPad zatrzymuje filmik, gdy lektor zaczyna mówić albo włącza się mikrofon – wznawiamy pętlę (najwyżej raz na sekundę).
let klipCheck = 0;
function pilnujKlipu() {
  const v = $('video'), t = Date.now();
  if (t - klipCheck < 1000 || !shownEx || shownEx.film || !shownEx.clip || v.hidden) return;
  klipCheck = t;
  if (v.paused || v.ended) { v.muted = true; v.loop = true; v.play().catch(() => {}); }
}
$('video').addEventListener('pause', () => { if (shownEx && !shownEx.film && shownEx.clip) setTimeout(() => { klipCheck = 0; pilnujKlipu(); }, 300); });

// Układ ekranu zależy od filmu: pionowy – film na całą wysokość, dane obok; poziomy – film na całą szerokość, dane pod spodem.
function layoutForClip() {
  const v = $('video'), wo = document.querySelector('.wo');
  const ar = shownEx?.film ? 16 / 9 : !v.hidden && v.videoWidth ? v.videoWidth / v.videoHeight : 0;
  const landscapeScreen = innerWidth > innerHeight;
  wo.classList.toggle('clip-pion', landscapeScreen && ar > 0 && ar < 1);
  wo.classList.toggle('clip-poziom', landscapeScreen && ar >= 1);
  if (landscapeScreen && ar > 0 && ar < 1) {
    const h = $('media').clientHeight;
    wo.style.setProperty('--left-w', Math.round(Math.max(360, Math.min(innerWidth * 0.58, h * ar))) + 'px');
  }
}
$('video').addEventListener('loadedmetadata', layoutForClip);
window.addEventListener('resize', layoutForClip);

function render() {
  syncFilm();
  pilnujKlipu();
  const t = now();
  const e = engine, s = e.step, st = e.status, inner = e.innerStatus();
  const isRest = s.kind === 'rest';
  const work = isRest ? s.next : s;

  // ramka
  const fr = $('frame');
  fr.className = 'frame ' + (st === 'paused' ? 'paused' : isRest ? 'rest' : (inner === 'running' || st === 'correcting') ? 'work' : '');

  // lewa strona
  $('phase').textContent = PHASE_NAMES[s.phase];
  $('btn-skip-phase').hidden = s.phase === 'trening';
  $('btn-skip-phase').textContent = s.phase === 'rozgrzewka' ? 'Pomiń rozgrzewkę' : 'Pomiń schładzanie';
  if (work) {
    setMedia(work.ex, isRest);
    $('ex-name').innerHTML = `${work.ex.name}<small>${describeTarget(work)}</small>`;
  }

  // licznik
  const c = $('counter'), lbl = $('counter-label');
  let txt = '', label = '';
  if (st === 'countdown' || (st === 'paused' && inner === 'countdown')) { txt = fmt(e.remainingMs(t) / 1000); label = 'przygotuj się'; }
  else if (isRest) { txt = fmt(e.remainingMs(t) / 1000); label = 'przerwa'; }
  else if (s.mode === 'czas') {
    txt = inner === 'running' ? fmt(e.remainingMs(t) / 1000) : fmt(s.target);
    label = inner === 'running' ? 'pracuj' : 'naciśnij start';
  } else {
    txt = String(s.target);
    label = inner === 'running' ? `powtórzeń · czas ${fmtLong(e.elapsedMs(t) / 1000)}` : st === 'correcting' ? 'powtórzeń' : 'powtórzeń · naciśnij start';
  }
  if (st === 'paused') label = 'pauza';
  c.textContent = txt;
  c.classList.toggle('small', txt.length > 3);
  lbl.textContent = label;

  // panel informacji
  if (work) {
    const multi = work.items > 1;
    $('lbl-set').textContent = multi ? 'Runda' : 'Seria';
    $('i-set').textContent = `${work.round} z ${work.rounds}`;
    $('i-level').textContent = work.ex.levels > 1 ? `${work.ex.level} z ${work.ex.levels}` : '–';
    const last = lastResult(work.ex.id);
    $('i-last').textContent = last ? (last.mode === 'czas' ? `${last.done} s` : `${last.done} powt.`) : '–';
  }
  const nextIdx = e.steps.findIndex((x, k) => k > e.index && x.kind === 'work' && x !== work);
  $('i-next').textContent = nextIdx >= 0 ? e.steps[nextIdx].ex.name : 'koniec';
  $('bar').style.width = `${Math.round(e.progress(t) * 100)}%`;
  $('left-total').textContent = fmtLong(e.remainingTotal(t));

  // przyciski
  const main = $('btn-main');
  if (st === 'paused') { main.textContent = 'WZNÓW'; main.className = 'big'; }
  else if (!isRest && inner === 'running') { main.textContent = 'STOP'; main.className = 'big stop'; }
  else { main.textContent = 'START'; main.className = 'big'; }
  $('btn-pause').textContent = st === 'paused' ? 'Wznów' : 'Pauza';
  $('btn-pause').disabled = !['running', 'countdown', 'paused'].includes(st);
  $('btn-more').disabled = !(inner === 'running' && (isRest || s.mode === 'czas'));

  // nakładki
  $('ov-correct').hidden = st !== 'correcting';
  if (st === 'correcting') {
    $('correct-n').textContent = s.target + e.correction;
    $('correct-bar').style.width = `${Math.round(e.remainingMs(t) / 40)}%`;
  }
  $('ov-end').hidden = st !== 'confirmEnd';
  if (st === 'confirmEnd') $('end-bar').style.width = `${Math.max(0, Math.round((e.frozen.confirmDeadline - t) / 50))}%`;
}

// przyciski ekranu ćwiczenia
const act = (fn) => () => { unlock(); if (engine) { fn(now()); render(); } };
$('btn-main').onclick = act((t) => {
  const e = engine;
  if (e.step.kind === 'work' && (e.status === 'running' || e.status === 'countdown')) return e.stop(t);
  mainStart(t);
});
$('btn-pause').onclick = act((t) => engine.status === 'paused' ? engine.start(t) : engine.pause(t));
$('btn-more').onclick = act((t) => engine.more(t));
$('btn-next').onclick = act((t) => engine.next(t));
$('btn-back').onclick = act((t) => engine.back(t));
$('btn-skip-phase').onclick = act((t) => engine.skipPhase(t));
$('btn-end').onclick = act((t) => engine.requestEnd(t));
$('btn-end-yes').onclick = act((t) => engine.answerEnd(true, t));
$('btn-end-no').onclick = act((t) => engine.answerEnd(false, t));
$('btn-minus').onclick = act(() => engine.adjust(-1));
$('btn-plus').onclick = act(() => engine.adjust(+1));
$('btn-correct-ok').onclick = act((t) => engine.confirmCorrection(t));

// ---------------- koniec: ocena i podsumowanie ----------------
function onFinished() {
  clearInterval(raf);
  voice.stop();
  keepAwake.wanted = false; keepAwake(false);
  // trening krótszy niż minuta nie trafia do wyników (np. przypadkowy start)
  const dur = Math.round(engine.session(training.id, null).durationSec / SPEED);
  if (dur < MIN_SEC) {
    say('Trening krótszy niż minuta. Nie zapisuję.');
    $('sum-title').textContent = 'Nie zapisano';
    $('sum-stats').innerHTML = '';
    $('sum-list').innerHTML = `<li>Trening trwał ${dur} s – krócej niż minutę, więc nie liczy się do wyników ani passy.</li>`;
    show('summary');
    return;
  }
  $('sum-title').textContent = 'Dobra robota';
  say('Koniec treningu. Dobra robota.');
  rpe = null;
  const g = $('rpe-grid'); g.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const b = document.createElement('button');
    b.textContent = i; b.setAttribute('aria-pressed', 'false');
    b.onclick = () => {
      rpe = i;
      g.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      $('btn-rpe-save').disabled = false;
    };
    g.append(b);
  }
  $('btn-rpe-save').disabled = true;
  show('rpe');
}

$('btn-rpe-save').onclick = () => {
  const s = engine.session(training.id, rpe);
  s.durationSec = Math.round(s.durationSec / SPEED);
  saveSession(s);
  runSync();
  const main = s.series.filter(x => x.phase === 'trening');
  const reps = main.filter(x => x.mode === 'ilosc').reduce((a, x) => a + x.done, 0);
  $('sum-stats').innerHTML =
    `<div><b>${fmtLong(s.durationSec)}</b><span>czas</span></div>` +
    `<div><b>${main.length}</b><span>serii</span></div>` +
    `<div><b>${reps}</b><span>powtórzeń</span></div>` +
    `<div><b>${rpe}</b><span>zmęczenie</span></div>`;
  const per = new Map();
  for (const x of s.series) {
    const k = x.name; const p = per.get(k) || { mode: x.mode, sum: 0, n: 0 };
    p.sum += x.done; p.n++; per.set(k, p);
  }
  $('sum-list').innerHTML = [...per].map(([name, p]) =>
    `<li>${name}<span>${p.n} × · ${p.mode === 'czas' ? p.sum + ' s' : p.sum + ' powt.'}</span></li>`).join('');
  show('summary');
};
$('btn-home').onclick = () => { $('ov-load').hidden = true; zamknijFilm(); engine = null; shownEx = null; renderHome(); show('home'); };

// ---------------- filmy-treningi offline (Pobierz / Usuń) ----------------
async function renderFilmyOffline() {
  const box = $('films-off');
  const lista = [];
  for (const ex of Object.values(exercises)) if (ex.film && (ex.film.offline || await filmy.isCached(ex.film.yt))) lista.push(ex);
  box.hidden = !lista.length;
  if (!lista.length) return;
  const h = document.createElement('h3'); h.textContent = 'Filmy-treningi offline';
  const rows = [];
  for (const ex of lista) {
    const id = ex.film.yt, m = await filmy.meta(id);
    const row = document.createElement('div'); row.className = 'film-row';
    const name = document.createElement('b'); name.textContent = ex.name;
    const info = document.createElement('small');
    const b = document.createElement('button'); b.className = 'chip';
    const ustaw = () => {
      if (filmy.downloading(id)) { b.disabled = true; b.textContent = 'Pobieram…'; return; }
      b.disabled = false;
      if (m?.complete) { info.textContent = `na iPadzie · ${Math.round(m.rozmiar / 1048576)} MB · działa bez internetu`; b.textContent = 'Usuń z iPada'; }
      else { info.textContent = 'leci z YouTube (potrzebny internet)'; b.textContent = 'Pobierz'; }
    };
    ustaw();
    b.onclick = async () => {
      if (m?.complete) { if (!confirm(`Usunąć „${ex.name}” z iPada? Dalej będzie można go oglądać z YouTube.`)) return; await filmy.remove(id); return renderFilmyOffline(); }
      b.disabled = true;
      try {
        await filmy.download(id, (f) => { b.textContent = `Pobieram… ${Math.round(f * 100)}%`; });
        renderFilmyOffline();
      } catch (e) { info.textContent = e.message; b.disabled = false; b.textContent = 'Spróbuj ponownie'; }
    };
    row.append(name, info, b); rows.push(row);
  }
  box.replaceChildren(h, ...rows);
}

// ---------------- synchronizacja ----------------
let syncMsg = '';
const SYNC_TEXT = {
  'wyslane': 'Wyniki wysłane na Krakena.', 'aktualne': 'Wszystko zsynchronizowane.',
  'brak-tokenu': 'Wyniki zostają na iPadzie: wklej klucz GitHub, żeby szły na Krakena.',
  'zly-token': 'Klucz GitHub nie działa. Wklej nowy.', 'blad': 'Nie udało się wysłać wyników. Spróbuję przy następnym połączeniu.',
};
function renderSyncNote() {
  const st = sync.syncState();
  const when = st.lastDown ? new Date(st.lastDown).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  $('sync-note').textContent = (navigator.onLine ? '' : 'Bez internetu – działam na zapisanych danych. ') +
    (when ? `Dane z Krakena: ${when}. ` : '') + (syncMsg || '');
  $('sync-form').hidden = !!st.token && syncMsg !== SYNC_TEXT['zly-token'];
  $('pass-form').hidden = !(st.brakHasla || st.zleHaslo);
  if (st.brakHasla) $('sync-note').textContent += ' Wpisz hasło do treningów (jest w kreatorze, zakładka Statystyki).';
  if (st.zleHaslo) $('sync-note').textContent += ' Hasło do treningów się nie zgadza – wpisz je jeszcze raz.';
}
$('btn-pass-save').onclick = () => {
  const v = $('inp-pass').value.trim();
  if (!v) return;
  sync.setPassword(v); $('inp-pass').value = ''; runSync();
};
async function runSync() {
  const res = await sync.syncAll(() => {
    ({ exercises, sets, trainings } = sync.loadData());
    if (!engine) renderHome();
  });
  if (res) syncMsg = SYNC_TEXT[res] || '';
  renderSyncNote();
}
$('btn-token-save').onclick = () => {
  const v = $('inp-token').value.trim();
  if (!v) return;
  sync.setToken(v); $('inp-token').value = ''; syncMsg = ''; runSync();
};
window.addEventListener('online', runSync);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(); });

// ---------------- start ----------------
renderHome();
runSync();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // gdy pamięć offline jest gotowa: dociągnij brakujące filmiki wszystkich treningów (pętle mają startować od razu)
  navigator.serviceWorker.ready.then(() => setTimeout(() => {
    const ids = new Set(trainings.flatMap(t => buildSteps(t, { exercises, sets }).map(st => st.ex?.clip)));
    rozgrzejKlipy([...ids], (n, all) => {
      $('load-home').hidden = n >= all;
      $('load-home-text').textContent = `Pobieram filmy do pamięci iPada: ${n} z ${all}. Po pobraniu działają od razu, także bez internetu.`;
      $('load-home-bar').style.width = `${Math.round(n / all * 100)}%`;
    });
  }, 1500)).catch(() => {});
}

// Pobiera do pamięci iPada filmiki, których jeszcze tam nie ma (po kilka naraz).
async function rozgrzejKlipy(lista, postep = () => {}) {
  const urls = [...new Set(lista.filter(Boolean))];
  if (!('caches' in window)) return;
  const brak = [];
  for (const u of urls) { try { if (!(await caches.match(u, { ignoreSearch: true }))) brak.push(u); } catch { /* bez pamięci */ } }
  if (!brak.length) return postep(1, 1);
  let gotowe = 0;
  postep(0, brak.length);
  for (let i = 0; i < brak.length; i += 4) {
    await Promise.all(brak.slice(i, i + 4).map(u => fetch(u).then(r => r.blob()).catch(() => {}).finally(() => postep(++gotowe, brak.length))));
  }
}
