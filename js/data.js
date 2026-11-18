// Etap 1: dane wpisane na sztywno. Od etapu 4 przychodzą z Krakena (synchronizacja).
// Format zgodny z docs/koncepcja.md §10.

export const exercises = {
  pajacyki:      { id: 'pajacyki', name: 'Pajacyki', family: 'rozgrzewka', level: 1, levels: 1, mode: 'czas', target: 30 },
  krazenia:      { id: 'krazenia', name: 'Krążenia ramion', family: 'rozgrzewka', level: 1, levels: 1, mode: 'czas', target: 30 },
  pompki_kolana: { id: 'pompki_kolana', name: 'Pompki na kolanach', family: 'pompki', level: 2, levels: 4, mode: 'ilosc', target: 12, clip: 'klipy/pompki_kolana.mp4' },
  przysiady:     { id: 'przysiady', name: 'Przysiady', family: 'przysiady', level: 2, levels: 4, mode: 'czas', target: 40 },
  plank:         { id: 'plank', name: 'Plank', family: 'plank', level: 1, levels: 4, mode: 'czas', target: 30 },
  australijskie: { id: 'australijskie', name: 'Podciąganie australijskie', family: 'podciaganie', level: 1, levels: 4, mode: 'ilosc', target: 10 },
  rozciaganie_plecy: { id: 'rozciaganie_plecy', name: 'Rozciąganie pleców', family: 'schladzanie', level: 1, levels: 1, mode: 'czas', target: 30 },
  // filmy testowe: 3 z HyperFrames + 1 prawdziwy (Navy SEALs, domena publiczna)
  hf_pompki_sciana: { id: 'pompki_sciana', name: 'Pompki przy ścianie', family: 'pompki', level: 1, levels: 4, mode: 'czas', target: 10, clip: 'klipy/pompki_sciana.mp4' },
  hf_pompki_kolana: { id: 'pompki_kolana', name: 'Pompki na kolanach', family: 'pompki', level: 2, levels: 4, mode: 'czas', target: 10, clip: 'klipy/pompki_kolana.mp4' },
  hf_pompki: { id: 'pompki', name: 'Pompki klasyczne', family: 'pompki', level: 3, levels: 4, mode: 'czas', target: 10, clip: 'klipy/pompki.mp4' },
  navy_pompki: { id: 'pompki', name: 'Pompki klasyczne (film Navy SEALs)', family: 'pompki', level: 3, levels: 4, mode: 'czas', target: 10, clip: 'klipy/navy_seal_pompki.mp4' },
  rozciaganie_klatka: { id: 'rozciaganie_klatka', name: 'Rozciąganie klatki', family: 'schladzanie', level: 1, levels: 1, mode: 'czas', target: 30 },
};

export const sets = {
  rozgrzewka_ogolna: {
    id: 'rozgrzewka_ogolna', name: 'Rozgrzewka ogólna', kind: 'rozgrzewka',
    blocks: [{ items: [{ ex: 'pajacyki' }, { ex: 'krazenia' }], rounds: 1, restItem: 10, restRound: 0 }],
  },
  schladzanie_plecy: {
    id: 'schladzanie_plecy', name: 'Schładzanie: plecy', kind: 'schladzanie',
    blocks: [{ items: [{ ex: 'rozciaganie_plecy' }, { ex: 'rozciaganie_klatka' }], rounds: 1, restItem: 5, restRound: 0 }],
  },
};

export const trainings = [
  {
    id: 'probny', name: 'Trening próbny', warmup: 'rozgrzewka_ogolna', cooldown: 'schladzanie_plecy',
    blocks: [
      { items: [{ ex: 'pompki_kolana' }], rounds: 3, restItem: 60, restRound: 60 },
      { items: [{ ex: 'przysiady' }, { ex: 'plank' }, { ex: 'australijskie' }], rounds: 2, restItem: 20, restRound: 60 },
    ],
  },
  {
    id: 'test_filmow', name: 'Test filmów', warmup: null, cooldown: null,
    blocks: [{ items: [{ ex: 'hf_pompki_sciana' }, { ex: 'hf_pompki_kolana' }, { ex: 'hf_pompki' }, { ex: 'navy_pompki' }], rounds: 1, restItem: 5, restRound: 0 }],
  },
];
