// Importadores de músicas: UltraStar (.txt, inclusive duetos P1/P2) e MIDI / KAR.
//
// Formato interno de uma música:
// {
//   id, title, artist, source,
//   voices: [{ name, notes: [{ t, d, midi, lyric, line, free }] }],
//   accomp: [{ t, d, midi, vel }]   // opcional: acompanhamento (vindo do MIDI)
// }
// t e d em segundos; midi = número MIDI (60 = Dó central); line = índice da frase.
(function (K) {
  function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
    } catch (e) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  function num(s) { return parseFloat(String(s).replace(',', '.')); }

  // ---------------- UltraStar ----------------
  function parseUltraStar(text) {
    const lines = text.split(/\r?\n/);
    const header = {};
    const voiceData = { 1: [], 2: [] };
    const lineBreakPending = { 1: false, 2: false };
    let current = [1];
    let relBase = 0;
    let sawDuet = false;

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line) continue;
      if (line[0] === '#') {
        const idx = line.indexOf(':');
        if (idx > 0) header[line.slice(1, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
        continue;
      }
      if (line[0] === 'E') break;
      const p = /^P\s*(\d)/.exec(line);
      if (p) {
        sawDuet = true;
        const n = parseInt(p[1], 10);
        current = n === 3 ? [1, 2] : [n === 2 ? 2 : 1];
        relBase = 0;
        continue;
      }
      if (line[0] === '-') {
        const parts = line.slice(1).trim().split(/\s+/).map(Number);
        for (const v of current) lineBreakPending[v] = true;
        if (/^yes$/i.test(header.RELATIVE || '')) relBase += parts.length > 1 ? parts[1] : parts[0];
        continue;
      }
      const m = /^([:*FRG])\s*(-?\d+)\s+(\d+)\s+(-?\d+)(?: (.*))?$/.exec(line);
      if (!m) continue;
      const [, type, start, len, pitch, txt] = m;
      for (const v of current) {
        voiceData[v].push({
          beat: parseInt(start, 10) + relBase,
          len: parseInt(len, 10),
          pitch: parseInt(pitch, 10),
          lyric: txt || '',
          free: type === 'F' || type === 'R' || type === 'G',
          golden: type === '*',
          lineStart: lineBreakPending[v],
        });
        lineBreakPending[v] = false;
      }
    }

    const bpm = num(header.BPM || '0');
    if (!bpm) throw new Error('Arquivo UltraStar sem #BPM.');
    const gap = num(header.GAP || '0') / 1000;
    const beatSec = 60 / (bpm * 4);

    const names = {
      1: header.P1 || header.DUETSINGERP1 || (sawDuet ? 'Cantor 1' : 'Melodia'),
      2: header.P2 || header.DUETSINGERP2 || 'Cantor 2',
    };
    const voices = [];
    for (const v of [1, 2]) {
      const data = voiceData[v];
      if (!data.length) continue;
      data.sort((a, b) => a.beat - b.beat);
      let lineIdx = 0;
      const notes = data.map((n, i) => {
        if (n.lineStart && i > 0) lineIdx++;
        return {
          t: gap + n.beat * beatSec,
          d: Math.max(n.len, 1) * beatSec,
          midi: n.pitch + 60,
          lyric: n.lyric.replace(/~/g, ''),
          line: lineIdx,
          free: n.free,
        };
      });
      voices.push({ name: names[v], notes });
    }
    if (!voices.length) throw new Error('Nenhuma nota encontrada no arquivo UltraStar.');

    // Normaliza altura: UltraStar às vezes usa oitava arbitrária. Centraliza perto do Dó4
    // (mesmo deslocamento para as duas vozes, para não estragar o intervalo entre elas).
    normalizeOctave(voices.flatMap((v) => v.notes));

    return {
      title: header.TITLE || 'Sem título',
      artist: header.ARTIST || '',
      audioHint: header.MP3 || header.AUDIO || '',
      source: 'ultrastar',
      voices,
    };
  }

  function normalizeOctave(notes) {
    if (!notes.length) return;
    const avg = notes.reduce((s, n) => s + n.midi, 0) / notes.length;
    const shift = 12 * Math.round((64 - avg) / 12);
    if (Math.abs(avg - 64) > 9 && shift) for (const n of notes) n.midi += shift;
  }

  // ---------------- MIDI / KAR ----------------
  function parseMidi(buffer) {
    const data = new DataView(buffer);
    let pos = 0;
    const u8 = () => data.getUint8(pos++);
    const u16 = () => { const v = data.getUint16(pos); pos += 2; return v; };
    const u32 = () => { const v = data.getUint32(pos); pos += 4; return v; };
    const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
    const varint = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    const bytesToText = (bytes) => decodeText(new Uint8Array(bytes).buffer);

    if (str(4) !== 'MThd') throw new Error('Não é um arquivo MIDI válido.');
    const hdrLen = u32();
    const format = u16(), ntrks = u16(), division = u16();
    pos = 8 + hdrLen;
    let smpteTicksPerSec = 0;
    if (division & 0x8000) {
      const fps = 256 - (division >> 8);
      smpteTicksPerSec = fps * (division & 0xff);
    }

    const tempos = [];
    const tracks = [];
    for (let t = 0; t < ntrks && pos < data.byteLength; t++) {
      const id = str(4);
      const len = u32();
      const end = pos + len;
      if (id !== 'MTrk') { pos = end; continue; }
      const track = { name: '', notes: [], texts: [], lyrics: [] };
      const open = {};
      let tick = 0, status = 0;
      while (pos < end) {
        tick += varint();
        let b = data.getUint8(pos);
        if (b & 0x80) { status = b; pos++; } else if (!status) { pos++; continue; }
        const type = status & 0xf0, ch = status & 0x0f;
        if (status === 0xff) {
          const mt = u8(); const ml = varint();
          const bytes = []; for (let i = 0; i < ml; i++) bytes.push(u8());
          if (mt === 0x51 && ml === 3) tempos.push({ tick, uspq: (bytes[0] << 16) | (bytes[1] << 8) | bytes[2] });
          else if (mt === 0x03 && !track.name) track.name = bytesToText(bytes).trim();
          else if (mt === 0x05) track.lyrics.push({ tick, text: bytesToText(bytes) });
          else if (mt === 0x01) track.texts.push({ tick, text: bytesToText(bytes) });
          else if (mt === 0x2f) break;
          status = 0;
        } else if (status === 0xf0 || status === 0xf7) {
          pos += varint(); status = 0;
        } else if (type === 0x90 || type === 0x80) {
          const note = u8(), vel = u8();
          const k = ch * 128 + note;
          if (type === 0x90 && vel > 0) {
            (open[k] = open[k] || []).push({ tick, vel });
          } else if (open[k] && open[k].length) {
            const on = open[k].shift();
            track.notes.push({ ch, midi: note, startTick: on.tick, endTick: tick, vel: on.vel });
          }
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
          pos += 2;
        } else if (type === 0xc0 || type === 0xd0) {
          pos += 1;
        } else {
          pos++;
        }
      }
      pos = end;
      tracks.push(track);
    }

    // mapa de tempo: tick -> segundos
    tempos.sort((a, b) => a.tick - b.tick);
    const segs = [{ tick: 0, sec: 0, uspq: 500000 }];
    for (const tp of tempos) {
      const last = segs[segs.length - 1];
      const sec = last.sec + ((tp.tick - last.tick) * last.uspq) / 1e6 / division;
      if (tp.tick === last.tick) last.uspq = tp.uspq;
      else segs.push({ tick: tp.tick, sec, uspq: tp.uspq });
    }
    const toSec = (tick) => {
      if (smpteTicksPerSec) return tick / smpteTicksPerSec;
      let s = segs[0];
      for (let i = 1; i < segs.length && segs[i].tick <= tick; i++) s = segs[i];
      return s.sec + ((tick - s.tick) * s.uspq) / 1e6 / division;
    };

    // Parte cada faixa por canal (arquivos formato 0 têm tudo numa faixa só)
    const parts = [];
    tracks.forEach((tr, ti) => {
      const byCh = {};
      for (const n of tr.notes) (byCh[n.ch] = byCh[n.ch] || []).push(n);
      for (const ch of Object.keys(byCh)) {
        const notes = byCh[ch]
          .map((n) => ({ t: toSec(n.startTick), d: Math.max(0.05, toSec(n.endTick) - toSec(n.startTick)), midi: n.midi, vel: n.vel / 127 }))
          .sort((a, b) => a.t - b.t || b.midi - a.midi);
        const lo = Math.min(...notes.map((n) => n.midi)), hi = Math.max(...notes.map((n) => n.midi));
        parts.push({
          id: ti + ':' + ch,
          name: (tr.name || 'Faixa ' + (ti + 1)) + (Object.keys(byCh).length > 1 || format === 0 ? ' (canal ' + (+ch + 1) + ')' : ''),
          drums: +ch === 9,
          notes,
          count: notes.length,
          range: [lo, hi],
          polyphony: polyphonyRatio(notes),
        });
      }
    });

    // Letras: prefere eventos "lyric"; senão, texto de .kar (ignorando cabeçalhos @)
    let lyricEvents = [];
    let title = '';
    const lyricTrack = tracks.slice().sort((a, b) => b.lyrics.length - a.lyrics.length)[0];
    if (lyricTrack && lyricTrack.lyrics.length > 5) {
      lyricEvents = lyricTrack.lyrics;
    } else {
      for (const tr of tracks) {
        for (const e of tr.texts) if (/^@T/.test(e.text) && !title) title = e.text.slice(2).trim();
      }
      const textTrack = tracks
        .map((tr) => ({ tr, n: tr.texts.filter((e) => e.text[0] !== '@').length }))
        .sort((a, b) => b.n - a.n)[0];
      if (textTrack && textTrack.n > 5) lyricEvents = textTrack.tr.texts.filter((e) => e.text[0] !== '@');
    }
    const lyrics = lyricEvents.map((e) => ({ t: toSec(e.tick), text: e.text }));

    return { title, parts: parts.filter((p) => p.count > 0), lyrics };
  }

  function polyphonyRatio(notes) {
    let overlaps = 0;
    for (let i = 1; i < notes.length; i++) {
      const prev = notes[i - 1];
      if (notes[i].t < prev.t + prev.d - 0.03) overlaps++;
    }
    return notes.length ? overlaps / notes.length : 0;
  }

  // Deixa uma linha monofônica: em notas sobrepostas, fica a mais aguda
  function toMonophonic(notes) {
    const sorted = notes.slice().sort((a, b) => a.t - b.t || b.midi - a.midi);
    const out = [];
    for (const n of sorted) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(n.t - prev.t) < 0.02) continue; // mesma hora: já ficou a mais aguda
      if (prev && n.t < prev.t + prev.d) prev.d = Math.max(0.05, n.t - prev.t);
      out.push({ t: n.t, d: n.d, midi: n.midi, lyric: '', line: 0 });
    }
    return out;
  }

  // Encaixa as sílabas do .kar/.mid nas notas mais próximas
  function attachLyrics(notes, lyrics) {
    if (!lyrics.length || !notes.length) return false;
    let hits = 0;
    for (const l of lyrics) {
      let text = l.text;
      const breakBefore = /^[\/\\]/.test(text) || /^\r|^\n/.test(text);
      text = text.replace(/^[\/\\\r\n]+/, '').replace(/[\r\n]+$/, '');
      // nota mais próxima
      let best = -1, bestDist = 0.25;
      for (let i = 0; i < notes.length; i++) {
        const dist = Math.abs(notes[i].t - l.t);
        if (dist < bestDist) { bestDist = dist; best = i; }
        if (notes[i].t > l.t + 0.3) break;
      }
      if (best < 0) continue;
      hits++;
      notes[best].lyric += text;
      if (breakBefore) notes[best].lineStart = true;
    }
    return hits > lyrics.length * 0.4;
  }

  // Define as frases: usa quebras marcadas; senão, pausas longas.
  function assignLines(notes) {
    const hasMarks = notes.some((n) => n.lineStart);
    let line = 0, count = 0;
    notes.forEach((n, i) => {
      if (i > 0) {
        const prev = notes[i - 1];
        const gap = n.t - (prev.t + prev.d);
        const breakHere = hasMarks ? n.lineStart : gap > 0.7 || count >= 12 || (count >= 6 && gap > 0.35);
        if (breakHere) { line++; count = 0; }
      }
      n.line = line;
      count++;
      delete n.lineStart;
    });
  }

  function buildSongFromMidi(parsed, choice) {
    const byId = Object.fromEntries(parsed.parts.map((p) => [p.id, p]));
    const voices = [];
    for (const [idx, id] of [choice.voice1, choice.voice2].entries()) {
      if (!id) continue;
      const part = byId[id];
      const notes = toMonophonic(part.notes);
      voices.push({ name: choice.names?.[idx] || part.name, notes, _id: id });
    }
    if (!voices.length) throw new Error('Escolha pelo menos uma faixa para a voz.');

    // letra vai para a voz cujas notas batem melhor com ela
    let bestVoice = null, bestScore = -1;
    for (const v of voices) {
      const copy = v.notes.map((n) => ({ ...n, lyric: '' }));
      attachLyrics(copy, parsed.lyrics);
      const score = copy.filter((n) => n.lyric).length;
      if (score > bestScore) { bestScore = score; bestVoice = v; }
    }
    if (bestVoice && bestScore > 0) attachLyrics(bestVoice.notes, parsed.lyrics);
    for (const v of voices) { assignLines(v.notes); delete v._id; }

    const used = new Set([choice.voice1, choice.voice2]);
    const accomp = [];
    if (choice.accompaniment !== false) {
      for (const p of parsed.parts) {
        if (used.has(p.id) || p.drums) continue;
        for (const n of p.notes) accomp.push({ t: n.t, d: Math.min(n.d, 4), midi: n.midi, vel: n.vel });
      }
      accomp.sort((a, b) => a.t - b.t);
    }
    return { title: choice.title || parsed.title || 'MIDI importado', artist: choice.artist || '', source: 'midi', voices, accomp };
  }

  Object.assign(K, {
    decodeText, parseUltraStar, parseMidi, toMonophonic, attachLyrics, assignLines, buildSongFromMidi,
  });
})(globalThis.K = globalThis.K || {});
