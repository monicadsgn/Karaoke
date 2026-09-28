// Testes rápidos sem dependências: node tests/run.js
const assert = require('assert');
for (const f of ['music', 'pitch', 'parsers', 'demos']) require('../js/' + f + '.js');
const K = globalThis.K;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

test('YIN detecta tons de voz (incl. harmônicos)', () => {
  const sr = 48000;
  for (const midi of [45, 52, 57, 64, 69, 76, 81]) {
    const f = K.midiToFreq(midi);
    const buf = new Float32Array(2048);
    for (let i = 0; i < buf.length; i++) {
      const t = i / sr;
      buf[i] = 0.3 * Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(4 * Math.PI * f * t) + 0.1 * Math.sin(6 * Math.PI * f * t);
    }
    const r = K.detectPitch(buf, sr);
    assert(r, 'sem leitura para ' + midi);
    assert(Math.abs(K.freqToMidi(r.freq) - midi) < 0.1, `midi ${midi} -> ${K.freqToMidi(r.freq)}`);
  }
  assert.strictEqual(K.detectPitch(new Float32Array(2048), sr), null);
});

test('nomes de nota e intervalos', () => {
  assert.strictEqual(K.noteName(60), 'Dó4');
  assert.strictEqual(K.parseNote('A4'), 69);
  assert.strictEqual(K.intervalName(64, 60), '3ª maior');
  assert.strictEqual(K.intervalName(67, 60), '5ª justa');
  assert.strictEqual(K.foldToward(48, 62), 60);
});

test('tonalidade e harmonia automática', () => {
  const mel = K.DEMOS[0].voices[0];
  const key = K.detectKey(mel.notes);
  assert.strictEqual(K.keyName(key), 'Dó maior');
  const h = K.generateHarmony(mel, 'third_above');
  // terça diatônica acima: Dó->Mi, Sol->Si, Lá->Dó
  assert.deepStrictEqual(h.notes.slice(0, 5).map((n) => n.midi), [64, 64, 71, 71, 72]);
  const low = K.generateHarmony(mel, 'third_below');
  assert.strictEqual(low.notes[0].midi, 57); // Dó4 -> Lá3
});

test('demos: vozes e frases', () => {
  for (const s of K.DEMOS) {
    assert.strictEqual(s.voices.length, 2);
    for (const v of s.voices) assert(v.notes.length > 20 && v.notes.every((n) => n.d > 0 && Number.isFinite(n.midi)));
  }
  const b = K.DEMOS[0];
  assert.strictEqual(b.voices[0].notes.length, b.voices[1].notes.length);
});

test('UltraStar dueto P1/P2', () => {
  const txt = [
    '#TITLE:Teste', '#ARTIST:Alguém', '#BPM:120', '#GAP:1000', '#P1:Ela', '#P2:Ele',
    'P1', ': 0 4 5 Can', ': 4 4 7 ta', '- 10', '* 12 4 9 mos', 'P2', ': 0 4 0 Can', ': 4 4 4 ta', 'F 12 2 0 hey', 'E',
  ].join('\n');
  const s = K.parseUltraStar(txt);
  assert.strictEqual(s.voices.length, 2);
  assert.strictEqual(s.voices[0].name, 'Ela');
  const n0 = s.voices[0].notes[0];
  assert.strictEqual(n0.t, 1);
  assert.strictEqual(n0.midi, 65);
  assert(Math.abs(s.voices[0].notes[1].t - (1 + 4 * 60 / 480)) < 1e-9);
  assert.strictEqual(s.voices[0].notes[2].line, 1);
  assert.strictEqual(s.voices[1].notes[2].free, true);
});

test('MIDI: tempo, faixas, letra .kar', () => {
  // monta um MIDI formato 1: faixa de tempo, melodia com letra, acordes
  const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const trk = (events) => { const d = events.flat(); return [0x4d, 0x54, 0x72, 0x6b, (d.length >> 24) & 255, (d.length >> 16) & 255, (d.length >> 8) & 255, d.length & 255, ...d]; };
  const txt = (dt, type, s) => [...vlq(dt), 0xff, type, ...vlq(s.length), ...Buffer.from(s, 'latin1')];
  const tempo = trk([[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], [0, 0xff, 0x2f, 0]]); // 500000 us = 120bpm
  const melEv = [txt(0, 3, 'Voz')];
  const sy = ['Oi ', 'tu', 'do ', '/bem? ', 'Sim ', 'sim'];
  melEv.push(txt(0, 1, '@TMinha Musica'));
  sy.forEach((s, i) => {
    melEv.push(txt(i === 0 ? 0 : 0, 1, s));
    melEv.push([0, 0x90, 60 + i, 100]);
    melEv.push([...vlq(480), 0x80, 60 + i, 0]);
  });
  melEv.push([0, 0xff, 0x2f, 0]);
  const chords = trk([[0, 0x91, 48, 80], [0, 52, 80], [...vlq(960), 0x81, 48, 0], [0, 52, 0], [0, 0xff, 0x2f, 0]]);
  const bytes = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, 0x01, 0xe0, ...tempo, ...trk(melEv), ...chords];
  const buf = new Uint8Array(bytes).buffer;
  const p = K.parseMidi(buf);
  assert.strictEqual(p.title, 'Minha Musica');
  assert.strictEqual(p.parts.length, 2);
  const mel = p.parts.find((x) => x.name.startsWith('Voz'));
  assert.strictEqual(mel.count, 6);
  assert(Math.abs(mel.notes[1].t - 0.5) < 1e-9, 'tempo 120bpm: 2ª nota em 0.5s');
  assert(p.parts.find((x) => x !== mel).polyphony > 0.4);
  const song = K.buildSongFromMidi(p, { voice1: mel.id, voice2: '', accompaniment: true });
  const v = song.voices[0];
  assert.strictEqual(v.notes.map((n) => n.lyric).join(''), 'Oi tudo bem? Sim sim');
  assert.strictEqual(v.notes[3].line, 1);
  assert.strictEqual(song.accomp.length, 2);
});

test('toMonophonic mantém a nota mais aguda', () => {
  const m = K.toMonophonic([{ t: 0, d: 1, midi: 60 }, { t: 0, d: 1, midi: 64 }, { t: 0.5, d: 1, midi: 62 }]);
  assert.deepStrictEqual(m.map((n) => [n.midi, n.d]), [[64, 0.5], [62, 1]]);
});

console.log(`\n${passed} testes passaram`);
