// Silnik treningu: czysta logika, bez ekranu i dźwięku. Czas podawany z zewnątrz (now w ms),
// zdarzenia (onEvent) słuchają dźwięki i lektor. Opis zachowania: docs/koncepcja.md §6–7.

const REPS_SEC = 3;          // szacowany czas jednego powtórzenia (do paska postępu)
const COUNTDOWN_MS = 3000;   // odliczanie przed pierwszym ćwiczeniem na czas
const CORRECT_MS = 4000;     // okno poprawki powtórzeń
const CONFIRM_MS = 5000;     // czas na „tak” po „koniec”
const MORE_MS = 10000;       // „jeszcze”
const PHASE_REST = 15;       // przerwa między rozgrzewką, treningiem i schładzaniem

/** Rozkłada trening na płaską listę kroków: praca / przerwa. */
export function buildSteps(training, { exercises, sets }) {
  const phases = [];
  if (training.warmup && sets[training.warmup]) phases.push({ phase: 'rozgrzewka', blocks: sets[training.warmup].blocks });
  phases.push({ phase: 'trening', blocks: training.blocks });
  if (training.cooldown && sets[training.cooldown]) phases.push({ phase: 'schladzanie', blocks: sets[training.cooldown].blocks });

  const steps = [];
  phases.forEach((ph, pi) => {
    ph.blocks.forEach((block, bi) => {
      for (let r = 1; r <= block.rounds; r++) {
        block.items.forEach((item, ii) => {
          const ex = exercises[item.ex];
          steps.push({
            kind: 'work', phase: ph.phase, block: bi, round: r, rounds: block.rounds,
            item: ii, items: block.items.length, ex,
            mode: ex.mode, target: item.target ?? ex.target,
          });
          const lastItem = ii === block.items.length - 1;
          const lastRound = r === block.rounds;
          const lastBlock = bi === ph.blocks.length - 1;
          let rest = 0;
          if (!lastItem) rest = block.restItem;
          else if (!lastRound) rest = block.restRound;
          else if (!lastBlock) rest = block.restRound || block.restItem;
          else if (pi < phases.length - 1) rest = PHASE_REST;
          if (rest > 0) steps.push({ kind: 'rest', phase: ph.phase, duration: rest });
        });
      }
    });
  });
  // przerwa wie, co będzie dalej (podgląd i lektor)
  steps.forEach((s, i) => { if (s.kind === 'rest') s.next = steps.slice(i + 1).find(x => x.kind === 'work'); });
  return steps;
}

export class Engine {
  constructor(steps, onEvent = () => {}) {
    this.steps = steps;
    this.emit = onEvent;
    this.index = 0;
    this.status = 'waiting';   // waiting | countdown | running | paused | correcting | confirmEnd | finished
    this.results = {};         // indeks kroku -> wynik serii
    this.endsAt = 0;           // dla odliczania w dół
    this.startedAt = 0;        // dla stopera (ćwiczenia na ilość)
    this.frozen = null;        // zapamiętany stan przy pauzie / pytaniu o koniec
    this.correction = 0;
    this.lastSpoken = null;
    this.startTime = null;
    this.skipped = { rozgrzewka: false, schladzanie: false };
  }

  get step() { return this.steps[this.index]; }

  // ---- odczyt do ekranu ----
  remainingMs(now) {
    if (this.status === 'paused' || this.status === 'confirmEnd') return this.frozen.remaining ?? 0;
    return Math.max(0, this.endsAt - now);
  }
  elapsedMs(now) {
    if (this.status === 'paused' || this.status === 'confirmEnd') return this.frozen.elapsed ?? 0;
    return Math.max(0, now - this.startedAt);
  }
  /** Szacunek: ile zostało do końca całego treningu (s). */
  remainingTotal(now) {
    let sum = 0;
    for (let i = this.index; i < this.steps.length; i++) {
      const s = this.steps[i];
      let sec = s.kind === 'rest' ? s.duration : s.mode === 'czas' ? s.target : s.target * REPS_SEC;
      if (i === this.index && ['running', 'paused', 'confirmEnd'].includes(this.innerStatus())) {
        if (s.kind === 'rest' || s.mode === 'czas') sec = this.remainingMs(now) / 1000;
        else sec = Math.max(0, sec - this.elapsedMs(now) / 1000);
      }
      sum += sec;
    }
    return Math.round(sum);
  }
  progress(now) {
    const total = this.steps.reduce((a, s) => a + (s.kind === 'rest' ? s.duration : s.mode === 'czas' ? s.target : s.target * REPS_SEC), 0);
    return total ? 1 - this.remainingTotal(now) / total : 1;
  }
  innerStatus() { return (this.status === 'paused' || this.status === 'confirmEnd') ? this.frozen.status : this.status; }

  // ---- przejścia ----
  enter(i, now, { auto = false } = {}) {
    if (i >= this.steps.length) return this.finish(now);
    this.index = i;
    this.lastSpoken = null;
    const s = this.step;
    if (s.kind === 'rest') {
      this.status = 'running';
      this.endsAt = now + s.duration * 1000;
      this.emit({ type: 'restStart', step: s });
    } else if (auto && s.mode === 'czas') {
      this.beginWork(now);
    } else {
      this.status = 'waiting';
      this.emit({ type: 'waiting', step: s });
    }
  }

  beginWork(now) {
    const s = this.step;
    this.status = 'running';
    this.startedAt = now;
    if (s.mode === 'czas') this.endsAt = now + s.target * 1000;
    this.emit({ type: 'workStart', step: s });
  }

  finishWork(now) {
    const s = this.step;
    if (s.mode === 'ilosc') {
      this.status = 'correcting';
      this.correction = 0;
      this.workDuration = Math.round(this.elapsedMs(now) / 1000);
      this.endsAt = now + CORRECT_MS;
      this.emit({ type: 'workEnd', step: s });
      return;
    }
    const done = Math.round((now - this.startedAt) / 1000);
    this.record(s, done, done);
    this.emit({ type: 'workEnd', step: s });
    this.enter(this.index + 1, now, { auto: true });
  }

  record(s, done, durationSec) {
    this.results[this.index] = {
      exId: s.ex.id, name: s.ex.name, family: s.ex.family, level: s.ex.level, phase: s.phase,
      round: s.round, mode: s.mode, target: s.target, done, durationSec,
    };
  }

  finish(now) {
    this.status = 'finished';
    this.endTime = now;
    this.emit({ type: 'finished' });
  }

  // ---- akcje (przyciski i głos) ----
  start(now) {
    if (this.startTime == null) this.startTime = now;
    if (this.status === 'paused') return this.resume(now);
    if (this.status !== 'waiting') return;
    if (this.step.mode === 'czas') {
      this.status = 'countdown';
      this.endsAt = now + COUNTDOWN_MS;
      this.lastSpoken = null;
    } else {
      this.beginWork(now);
    }
  }

  pause(now) {
    if (!['running', 'countdown'].includes(this.status)) return;
    this.frozen = { status: this.status, remaining: this.endsAt - now, elapsed: now - this.startedAt };
    this.status = 'paused';
    this.emit({ type: 'paused' });
  }

  resume(now) {
    const f = this.frozen;
    this.status = f.status;
    this.endsAt = now + f.remaining;
    this.startedAt = now - f.elapsed;
    this.frozen = null;
    this.emit({ type: 'resumed' });
  }

  /** start/pauza jednym przyciskiem */
  toggle(now) {
    if (this.status === 'waiting' || this.status === 'paused') this.start(now);
    else if (this.status === 'running' && this.step.kind === 'work') this.stop(now);
    else if (this.status === 'running' || this.status === 'countdown') this.pause(now);
  }

  stop(now) {
    if (this.status === 'paused') this.resume(now);
    if (this.status === 'running') {
      if (this.step.kind === 'work') this.finishWork(now);
      else this.enter(this.index + 1, now, { auto: true });
    } else if (this.status === 'countdown') {
      this.status = 'waiting';
    } else if (this.status === 'correcting') {
      this.confirmCorrection(now);
    }
  }

  next(now) {
    if (this.status === 'finished' || this.status === 'confirmEnd') return;
    if (this.status === 'correcting') return this.confirmCorrection(now);
    if (this.step.kind === 'rest') return this.enter(this.index + 1, now, { auto: true });
    const j = this.steps.findIndex((s, k) => k > this.index && s.kind === 'work');
    if (j < 0) return this.finish(now);
    this.enter(j, now);
  }

  back(now) {
    if (this.status === 'finished' || this.status === 'confirmEnd') return;
    let j;
    if (this.step.kind === 'rest' || this.status === 'correcting') {
      j = this.step.kind === 'rest' ? this.index - 1 : this.index;
    } else {
      j = -1;
      for (let k = this.index - 1; k >= 0; k--) if (this.steps[k].kind === 'work') { j = k; break; }
      if (j < 0) j = this.index;
    }
    delete this.results[j];
    this.enter(j, now);
  }

  more(now) {
    if (this.status === 'running' && (this.step.kind === 'rest' || this.step.mode === 'czas')) {
      this.endsAt += MORE_MS;
      this.lastSpoken = null;
      this.emit({ type: 'more' });
    } else if (this.status === 'paused' && this.frozen.status === 'running') {
      this.frozen.remaining += MORE_MS;
    }
  }

  adjust(delta) {
    if (this.status !== 'correcting') return;
    this.correction = Math.max(-this.step.target, this.correction + delta);
  }

  confirmCorrection(now) {
    const s = this.step;
    this.record(s, s.target + this.correction, this.workDuration);
    this.enter(this.index + 1, now, { auto: true });
  }

  skipPhase(now) {
    const ph = this.step.phase;
    if (ph === 'trening') return;
    this.skipped[ph] = true;
    for (const k of Object.keys(this.results)) if (this.steps[k].phase === ph) delete this.results[k];
    const j = this.steps.findIndex((s, k) => k > this.index && s.phase !== ph && s.kind === 'work');
    if (j < 0) return this.finish(now);
    this.enter(j, now);
  }

  requestEnd(now) {
    if (this.status === 'finished' || this.status === 'confirmEnd') return;
    if (this.status === 'paused') { this.frozen.confirmDeadline = now + CONFIRM_MS; }
    else this.frozen = { status: this.status, remaining: this.endsAt - now, elapsed: now - this.startedAt, confirmDeadline: now + CONFIRM_MS };
    this.frozen.wasPaused = this.status === 'paused';
    this.status = 'confirmEnd';
    this.emit({ type: 'confirmEnd' });
  }

  answerEnd(yes, now) {
    if (this.status !== 'confirmEnd') return;
    if (yes) return this.finish(now);
    if (this.frozen.wasPaused) { this.status = 'paused'; }
    else this.resume(now);
    this.emit({ type: 'endCancelled' });
  }

  // ---- zegar ----
  tick(now) {
    const st = this.status;
    if (st === 'confirmEnd') {
      if (now >= this.frozen.confirmDeadline) this.answerEnd(false, now);
      return;
    }
    if (st === 'countdown') {
      const left = Math.ceil((this.endsAt - now) / 1000);
      if (left !== this.lastSpoken && left > 0) { this.lastSpoken = left; this.emit({ type: 'count', n: left }); }
      if (now >= this.endsAt) this.beginWork(now);
      return;
    }
    if (st === 'correcting') {
      if (now >= this.endsAt) this.confirmCorrection(now);
      return;
    }
    if (st !== 'running') return;
    const s = this.step;
    if (s.kind === 'rest') {
      const left = Math.ceil((this.endsAt - now) / 1000);
      if (s.next && s.next.mode === 'czas' && left <= 3 && left > 0 && left !== this.lastSpoken) {
        this.lastSpoken = left; this.emit({ type: 'count', n: left });
      }
      if (now >= this.endsAt) this.enter(this.index + 1, now, { auto: true });
    } else if (s.mode === 'czas') {
      const left = Math.ceil((this.endsAt - now) / 1000);
      if (left <= 3 && left > 0 && left !== this.lastSpoken) { this.lastSpoken = left; this.emit({ type: 'tickEnd', n: left }); }
      if (now >= this.endsAt) this.finishWork(now);
    }
  }

  /** Wynik sesji do zapisu. */
  session(trainingId, rpe) {
    const series = Object.keys(this.results).map(Number).sort((a, b) => a - b).map(k => this.results[k]);
    return {
      id: `s_${Date.now()}`, trainingId,
      start: this.startTime != null ? new Date(Date.now() - (this.endTime - this.startTime)).toISOString() : new Date().toISOString(),
      end: new Date().toISOString(),
      durationSec: this.startTime != null ? Math.round((this.endTime - this.startTime) / 1000) : 0,
      skippedWarmup: this.skipped.rozgrzewka, skippedCooldown: this.skipped.schladzanie,
      rpe, series,
    };
  }
}
