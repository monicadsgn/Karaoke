// Utilitários de teoria musical: nomes de notas, intervalos, tonalidade e harmonia automática.
(function (K) {
  const NOTE_NAMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
  const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  const INTERVALS = [
    'uníssono', '2ª menor', '2ª maior', '3ª menor', '3ª maior', '4ª justa',
    'trítono', '5ª justa', '6ª menor', '6ª maior', '7ª menor', '7ª maior',
  ];

  function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function noteName(midi, withOctave = true) {
    const r = Math.round(midi);
    const name = NOTE_NAMES[((r % 12) + 12) % 12];
    return withOctave ? name + (Math.floor(r / 12) - 1) : name;
  }

  // "C4", "F#3", "Bb4" -> número MIDI
  function parseNote(s) {
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(s);
    if (!m) throw new Error('Nota inválida: ' + s);
    let v = LETTER[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return v + (parseInt(m[3], 10) + 1) * 12;
  }

  // Nome do intervalo entre duas alturas (ignora oitavas compostas, mas avisa)
  function intervalName(a, b) {
    const semis = Math.round(Math.abs(a - b));
    const base = INTERVALS[semis % 12];
    if (semis === 0) return 'uníssono';
    if (semis % 12 === 0) return semis === 12 ? 'oitava' : semis / 12 + ' oitavas';
    return semis > 12 ? base + ' (+8ª)' : base;
  }

  // Desloca m por oitavas até ficar o mais perto possível de ref
  function foldToward(m, ref) {
    return m + 12 * Math.round((ref - m) / 12);
  }

  // --- Detecção de tonalidade (perfis de Krumhansl-Kessler) ---
  const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function correlate(a, b) {
    const ma = a.reduce((s, x) => s + x, 0) / 12, mb = b.reduce((s, x) => s + x, 0) / 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  function detectKey(notes) {
    const hist = new Array(12).fill(0);
    for (const n of notes) hist[((Math.round(n.midi) % 12) + 12) % 12] += n.d;
    let best = { tonic: 0, minor: false, score: -Infinity };
    for (let t = 0; t < 12; t++) {
      const rot = hist.slice(t).concat(hist.slice(0, t));
      const maj = correlate(rot, MAJOR_PROFILE), min = correlate(rot, MINOR_PROFILE);
      if (maj > best.score) best = { tonic: t, minor: false, score: maj };
      if (min > best.score) best = { tonic: t, minor: true, score: min };
    }
    return best;
  }

  function keyName(key) {
    return NOTE_NAMES[key.tonic] + (key.minor ? ' menor' : ' maior');
  }

  const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
  const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

  // Move a nota `degrees` graus dentro da escala (ex.: +2 = terça acima, -2 = terça abaixo)
  function diatonicShift(midi, key, degrees) {
    const steps = key.minor ? MINOR_STEPS : MAJOR_STEPS;
    const rel = Math.round(midi) - key.tonic;
    const oct = Math.floor(rel / 12);
    const pc = ((rel % 12) + 12) % 12;
    // grau mais próximo da escala (notas cromáticas "caem" no grau vizinho)
    let deg = 0, bestDist = 99;
    for (let i = 0; i < 7; i++) {
      const d = Math.abs(steps[i] - pc);
      if (d < bestDist) { bestDist = d; deg = i; }
    }
    const chromatic = pc - steps[deg];
    const total = deg + degrees;
    const newOct = oct + Math.floor(total / 7);
    const newDeg = ((total % 7) + 7) % 7;
    return key.tonic + newOct * 12 + steps[newDeg] + chromatic;
  }

  const HARMONY_MODES = {
    third_above: { label: 'Terça acima (automática)', degrees: 2, octave: 0 },
    third_below: { label: 'Terça abaixo (automática)', degrees: -2, octave: 0 },
    sixth_below: { label: 'Sexta abaixo (automática)', degrees: 2, octave: -1 },
    fifth_below: { label: 'Quinta abaixo (automática)', degrees: -4, octave: 0 },
  };

  function generateHarmony(voice, mode) {
    const cfg = HARMONY_MODES[mode];
    const key = detectKey(voice.notes);
    return {
      name: cfg.label,
      generated: true,
      key,
      notes: voice.notes.map((n) => ({
        ...n,
        midi: diatonicShift(n.midi, key, cfg.degrees) + 12 * cfg.octave,
      })),
    };
  }

  Object.assign(K, {
    NOTE_NAMES, freqToMidi, midiToFreq, noteName, parseNote, intervalName, foldToward,
    detectKey, keyName, diatonicShift, generateHarmony, HARMONY_MODES,
  });
})(globalThis.K = globalThis.K || {});
