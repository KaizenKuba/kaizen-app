// Komendy głosowe po polsku, w całości na iPadzie (Vosk + mały polski model, bez internetu).
// Rozpoznajemy tylko krótką listę słów. Mikrofon działa wyłącznie podczas treningu.
import { getAudioContext, isSpeaking } from './audio.js';

export const WORDS = ['start', 'stop', 'dalej', 'pauza', 'wróć', 'jeszcze', 'koniec', 'tak', 'nie'];
// Inne słowa, które też działają (łatwiej trafić, gdy powiesz to po swojemu albo model słabiej usłyszy).
const SYNONYMS = {
  startuj: 'start', zaczynaj: 'start', jedziemy: 'start', dawaj: 'start',
  stój: 'stop', zatrzymaj: 'stop', czekaj: 'pauza',
  następne: 'dalej', następny: 'dalej', pomiń: 'dalej',
  wstecz: 'wróć', cofnij: 'wróć', poprzednie: 'wróć',
  więcej: 'jeszcze', dodaj: 'jeszcze',
  zakończ: 'koniec', tak: 'tak', nie: 'nie',
};
const GRAMMAR = JSON.stringify([...new Set([...WORDS, ...Object.keys(SYNONYMS)]), '[unk]']);
const toCommand = (w) => WORDS.includes(w) ? w : SYNONYMS[w];
const MODEL_URL = 'vosk/model-pl.tar.gz';
const MODEL_CACHE = 'kaizen-model-pl-0.22';   // osobna pamięć: model nie jest pobierany przy każdej wersji apki
const REPEAT_MS = 1500;                         // to samo słowo z wyniku częściowego i końcowego liczymy raz

let model = null, recognizer = null, stream = null, source = null, node = null;
let loading = null;
let last = { word: null, at: 0 };
let used = 0;          // ile słów-komend z bieżącej wypowiedzi już obsłużyliśmy (wyniki częściowe rosną)
let lastAudio = 0, watchdog = 0, onCmd = null;
let handler = () => {};
let statusCb = () => {};
export let status = 'off';   // off | loading | listening | error
export let errorText = '';

function setStatus(s, err = '') { status = s; errorText = err; statusCb(s, err); }
export function onStatus(cb) { statusCb = cb; }

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Vosk) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Nie udało się wczytać Vosk'));
    document.head.append(s);
  });
}

/** Model z pamięci iPada (Cache API); z sieci tylko za pierwszym razem. */
async function modelBlobUrl() {
  let res;
  if ('caches' in window) {
    const c = await caches.open(MODEL_CACHE);
    res = await c.match(MODEL_URL);
    if (!res) {
      const net = await fetch(MODEL_URL);
      if (!net.ok) throw new Error('Brak modelu mowy');
      await c.put(MODEL_URL, net.clone());
      res = net;
    }
  } else {
    res = await fetch(MODEL_URL);
  }
  return URL.createObjectURL(await res.blob());
}

/** Czy model jest już zapisany na iPadzie (wtedy działa bez internetu). */
export async function modelCached() {
  try { return !!(await (await caches.open(MODEL_CACHE)).match(MODEL_URL)); } catch { return false; }
}

async function ensureModel() {
  if (model) return model;
  if (!loading) loading = (async () => {
    await loadScript('vosk/vosk.js');
    const url = await modelBlobUrl();
    model = await window.Vosk.createModel(url, -1);
    URL.revokeObjectURL(url);
    return model;
  })().catch(e => { loading = null; throw e; });
  return loading;
}

// Wynik częściowy rośnie w trakcie mówienia („start”, „start [unk]”, „start stop”…) – obsługujemy tylko NOWE komendy.
function handleText(text, final) {
  const cmds = (text || '').split(/\s+/).map(toCommand).filter(Boolean);
  const fresh = cmds.slice(used);
  used = final ? 0 : Math.max(used, cmds.length);
  for (const word of fresh) {
    const now = Date.now();
    if (word === last.word && now - last.at < REPEAT_MS) continue;
    if (isSpeaking()) continue;   // nie reagujemy na własnego lektora i bipy
    last = { word, at: now };
    handler(word, { final });
  }
}

/** Wczytuje model z wyprzedzeniem (np. na ekranie głównym), bez włączania mikrofonu. */
export function preload() { return ensureModel().catch(() => {}); }

/** Włącza słuchanie. onCommand(słowo) dostaje rozpoznane komendy. */
export async function listen(onCommand) {
  handler = onCommand; onCmd = onCommand;
  if (status === 'listening' || status === 'loading') return;
  try {
    setStatus('loading');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Ta przeglądarka nie daje dostępu do mikrofonu');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await ensureModel();
    const ctx = getAudioContext();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    used = 0;
    recognizer = new model.KaldiRecognizer(ctx.sampleRate, GRAMMAR);
    recognizer.on('result', (m) => handleText(m.result?.text, true));
    recognizer.on('partialresult', (m) => handleText(m.result?.partial, false));
    source = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => { lastAudio = Date.now(); try { recognizer?.acceptWaveform(e.inputBuffer); } catch { /* chwilowy błąd */ } };
    source.connect(node);
    node.connect(ctx.destination);   // bez tego Safari nie wywołuje onaudioprocess (węzeł nic nie gra)
    lastAudio = Date.now();
    // iPad potrafi „uśpić” dźwięk po wypowiedzi lektora albo wyciszyć mikrofon – pilnujemy i wznawiamy.
    ctx.onstatechange = () => { if (status === 'listening' && ctx.state !== 'running') ctx.resume().catch(() => {}); };
    stream.getAudioTracks().forEach(t => { t.onended = restart; t.onmute = () => setTimeout(() => { if (t.muted) restart(); }, 1500); });
    clearInterval(watchdog);
    watchdog = setInterval(() => {
      if (status !== 'listening') return;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      if (Date.now() - lastAudio > 3000) restart();   // dźwięk przestał płynąć
    }, 1000);
    setStatus('listening');
  } catch (e) {
    stop();
    setStatus('error', e && e.name === 'NotAllowedError' ? 'Brak zgody na mikrofon' : (e?.message || 'Błąd mikrofonu'));
  }
}

let restarting = false;
async function restart() {
  if (restarting || status !== 'listening' || !onCmd) return;
  restarting = true;
  try { stop(); await listen(onCmd); } finally { restarting = false; }
}

export function stop() {
  clearInterval(watchdog);
  try { node?.disconnect(); source?.disconnect(); } catch { /* już rozłączone */ }
  try { recognizer?.remove(); } catch { /* już usunięty */ }
  stream?.getTracks().forEach(t => t.stop());
  node = source = recognizer = stream = null;
  if (status !== 'error') setStatus('off');
}

// Do testów na komputerze: podaj próbki dźwięku zamiast mikrofonu.
export async function testRecognize(float32, sampleRate) {
  await ensureModel();
  const rec = new model.KaldiRecognizer(sampleRate, GRAMMAR);
  return new Promise((res) => {
    const heard = [];
    rec.on('result', (m) => { if (m.result?.text) heard.push(m.result.text); });
    for (let i = 0; i < float32.length; i += 4096) rec.acceptWaveformFloat(float32.subarray(i, i + 4096), sampleRate);
    rec.retrieveFinalResult();
    setTimeout(() => { rec.remove(); res(heard); }, 1500);
  });
}
