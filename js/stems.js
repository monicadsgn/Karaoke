// Músicas "de verdade": instrumental + voz original separados, preparados por tools/preparar_musica.py.
// A voz original é dividida por trechos: nos seus trechos ela vira "guia" (volume ajustável, pode ser zero),
// nos trechos do outro cantor ela toca normalmente.
(function (K) {
  // ---------------- importação do arquivo .karaoke ----------------
  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function parseKaraokeFile(text) {
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* não é JSON */ }
    if (!data || data.type !== 'stems' || !data.audio) {
      throw new Error('esse arquivo não é uma música preparada (.karaoke). Escolha o arquivo que o Claude te mandou.');
    }
    const mime = data.audio.mime || 'audio/mpeg';
    const blobs = {
      inst: b64ToBlob(data.audio.instrumental, mime),
      voc: b64ToBlob(data.audio.vocals, mime),
    };
    const song = { ...data, source: 'gravação original' };
    delete song.audio;
    song.phrases = song.phrases.map((p) => ({ who: 'A', lyric: '', ...p }));
    return { song, blobs };
  }

  // Monta as vozes do jogo a partir dos trechos (A = aguda, B = grave, AB = juntos, - = ignorar)
  function stemsVoices(song) {
    const voices = { A: [], B: [] };
    const ph = song.phrases;
    const seen = new Set();
    let pi = 0;
    for (const n of song.notes) {
      const mid = n.t + n.d / 2;
      while (pi < ph.length - 1 && mid > ph[pi].t1 + 0.05) pi++;
      const p = ph[pi];
      if (!p || mid < p.t0 - 0.2 || mid > p.t1 + 0.2 || p.who === '-') continue;
      const first = !seen.has(pi + p.who);
      seen.add(pi + p.who);
      const note = { t: n.t, d: n.d, midi: n.midi, lyric: first ? p.lyric || '' : '', line: pi };
      if (p.who === 'AB') {
        // juntos: a curva extraída mistura as duas vozes, então não pontua
        voices.A.push({ ...note, free: true });
        voices.B.push({ ...note, free: true });
      } else {
        voices[p.who].push(note);
      }
    }
    return [
      { name: song.singers.A, key: 'A', notes: voices.A },
      { name: song.singers.B, key: 'B', notes: voices.B },
    ].filter((v) => v.notes.length);
  }

  // ---------------- mudar tempo/tom sem distorcer (SoundTouch, processado antes de tocar) ----------------
  async function stretch(buffer, ctx, rate, semitones, onProgress) {
    const { SoundTouch, SimpleFilter } = globalThis.SoundTouchLib;
    const st = new SoundTouch();
    st.tempo = rate;
    st.pitchSemitones = semitones;
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const total = L.length;
    const source = {
      extract(target, numFrames, position) {
        const n = Math.max(0, Math.min(numFrames, total - position));
        for (let i = 0; i < n; i++) { target[i * 2] = L[position + i]; target[i * 2 + 1] = R[position + i]; }
        return n;
      },
    };
    const filter = new SimpleFilter(source, st);
    const outLen = Math.ceil(total / rate) + 8192;
    const out = ctx.createBuffer(2, outLen, buffer.sampleRate);
    const oL = out.getChannelData(0), oR = out.getChannelData(1);
    const CH = 16384;
    const tmp = new Float32Array(CH * 2);
    let written = 0, chunks = 0;
    for (;;) {
      const n = filter.extract(tmp, CH);
      if (!n) break;
      for (let i = 0; i < n && written + i < outLen; i++) { oL[written + i] = tmp[i * 2]; oR[written + i] = tmp[i * 2 + 1]; }
      written += n;
      if (++chunks % 8 === 0) {
        if (onProgress) onProgress(Math.min(1, (written * rate) / total));
        await new Promise((r) => setTimeout(r, 0)); // não travar a tela
      }
    }
    return out;
  }

  // ---------------- player ----------------
  class StemPlayer {
    constructor(ctx, out) {
      this.ctx = ctx;
      this.out = out;
      this.cache = {};
      this.gains = {};
      for (const k of ['inst', 'partner', 'guide']) {
        const g = ctx.createGain();
        g.connect(out);
        this.gains[k] = g;
      }
      this.sources = [];
    }

    async load(songId, blobs) {
      if (this.songId === songId && this.raw) return;
      this.songId = songId;
      this.cache = {};
      const dec = async (b) => this.ctx.decodeAudioData(await b.arrayBuffer());
      this.raw = { inst: await dec(blobs.inst), voc: await dec(blobs.voc) };
    }

    async prepare(rate, semitones, onProgress) {
      const key = rate + ':' + semitones;
      if (!this.cache[key]) {
        if (rate === 1 && semitones === 0) {
          this.cache[key] = this.raw;
        } else {
          const inst = await stretch(this.raw.inst, this.ctx, rate, semitones, (p) => onProgress && onProgress(p / 2));
          const voc = await stretch(this.raw.voc, this.ctx, rate, semitones, (p) => onProgress && onProgress(0.5 + p / 2));
          this.cache = { [key]: { inst, voc } }; // guarda só a última versão (memória)
          this.cache['1:0'] = this.raw;
        }
      }
      this.bufs = this.cache[key];
      this.rate = rate;
    }

    setVolumes({ inst, partner, guide }) {
      const now = this.ctx.currentTime;
      if (inst != null) this.gains.inst.gain.setTargetAtTime(inst, now, 0.03);
      if (partner != null) this.gains.partner.gain.setTargetAtTime(partner, now, 0.03);
      if (guide != null) this.gains.guide.gain.setTargetAtTime(guide, now, 0.05);
    }

    // phrases: [{t0,t1,who}], mine: 'A'|'B'; jointMode: 'play' | 'mute'
    play(songTime, whenCtx, phrases, mine, jointMode) {
      this.stop();
      const ctx = this.ctx, rate = this.rate;
      const delay = songTime < 0 ? -songTime / rate : 0;
      const offset = Math.max(0, songTime) / rate;
      const startAt = whenCtx + delay;
      const inst = ctx.createBufferSource();
      inst.buffer = this.bufs.inst;
      inst.connect(this.gains.inst);
      const voc = ctx.createBufferSource();
      voc.buffer = this.bufs.voc;
      const maskOther = ctx.createGain(), maskMine = ctx.createGain();
      voc.connect(maskOther).connect(this.gains.partner);
      voc.connect(maskMine).connect(this.gains.guide);

      // automação das máscaras (tempo da música -> tempo do AudioContext)
      const toCtx = (t) => whenCtx + (t - songTime) / rate;
      const isMine = (p) => p.who === mine || (p.who === 'AB' && jointMode === 'mute');
      maskOther.gain.setValueAtTime(1, ctx.currentTime);
      maskMine.gain.setValueAtTime(0, ctx.currentTime);
      const pad = 0.12, ramp = 0.04;
      for (const p of phrases) {
        if (!isMine(p) || p.t1 + pad < songTime) continue;
        const a = Math.max(ctx.currentTime, toCtx(p.t0 - pad)), b = Math.max(a + ramp * 2, toCtx(p.t1 + pad));
        maskOther.gain.setValueAtTime(1, a);
        maskOther.gain.linearRampToValueAtTime(0, a + ramp);
        maskOther.gain.setValueAtTime(0, b);
        maskOther.gain.linearRampToValueAtTime(1, b + ramp);
        if (p.who === mine) {
          maskMine.gain.setValueAtTime(0, a);
          maskMine.gain.linearRampToValueAtTime(1, a + ramp);
          maskMine.gain.setValueAtTime(1, b);
          maskMine.gain.linearRampToValueAtTime(0, b + ramp);
        }
      }
      inst.start(startAt, offset);
      voc.start(startAt, offset);
      this.sources = [inst, voc];
    }

    stop() {
      for (const s of this.sources) { try { s.stop(); } catch (e) { /* já parou */ } s.disconnect(); }
      this.sources = [];
    }

    // toca só um trecho (prévia no editor)
    preview(t0, t1) {
      this.stop();
      const ctx = this.ctx;
      const mk = (buf, g) => { const s = ctx.createBufferSource(); s.buffer = buf; s.connect(g); return s; };
      const a = mk(this.raw.inst, this.out), b = mk(this.raw.voc, this.out);
      const now = ctx.currentTime + 0.05;
      const dur = Math.max(0.1, Math.min(t1, this.raw.inst.duration) - t0);
      a.start(now, t0, dur); b.start(now, t0, dur);
      this.sources = [a, b];
    }
  }

  Object.assign(K, { parseKaraokeFile, stemsVoices, stretch, StemPlayer });
})(globalThis.K = globalThis.K || {});
