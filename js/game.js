// Motor do jogo: relógio da música, microfone, pontuação e desenho da "trilha" de notas.
(function (K) {
  // ---------------- Microfone ----------------
  class Mic {
    async start(ctx, { headphones = true, deviceId = '' } = {}) {
      this.ctx = ctx;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: !headphones, // sem fone, tenta remover o som do alto-falante
          noiseSuppression: false,
          autoGainControl: false,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      this.src = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.src.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);
      this.smoother = new K.PitchSmoother(5);
      this.level = 0;
    }
    read() {
      if (!this.analyser) return null;
      this.analyser.getFloatTimeDomainData(this.buf);
      let s = 0;
      for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
      this.level = Math.sqrt(s / this.buf.length);
      const r = K.detectPitch(this.buf, this.ctx.sampleRate, { minRms: 0.008 });
      const midi = r ? K.freqToMidi(r.freq) : null;
      return this.smoother.push(midi);
    }
    stop() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.analyser = null;
    }
  }

  // ---------------- Preparação da música ----------------
  function prepare(song, s) {
    const tr = s.transpose || 0;
    const copy = (notes) => notes.map((n) => ({ ...n, midi: n.midi + tr }));
    const mine = copy(song.voices[s.myVoice].notes);

    let partner = [];
    let partnerName = '';
    if (s.partner && s.partner.startsWith('voice:')) {
      const v = song.voices[+s.partner.slice(6)];
      if (v) { partner = copy(v.notes); partnerName = v.name; }
    } else if (s.partner && K.HARMONY_MODES[s.partner]) {
      const g = K.generateHarmony(song.voices[s.myVoice], s.partner);
      partner = copy(g.notes);
      partnerName = g.name + ' · tom: ' + K.keyName(g.key);
    }

    // músicas gravadas: a letra fica no trecho; vai na 1ª nota de cada trecho
    if (song.type === 'stems') {
      for (const list of [mine, partner]) {
        let last = -1;
        for (const n of list) {
          n.lyric = '';
          if (n.line !== last) { n.lyric = (song.phrases[n.line] && song.phrases[n.line].lyric) || ''; last = n.line; }
        }
      }
    }
    for (const n of mine) { n.hit = 0; n.total = 0; n.samples = []; n.done = false; }
    const accomp = (song.accomp || []).map((n) => ({ ...n }));
    return { mine, partner, partnerName, accomp, transpose: tr };
  }

  function linesOf(notes) {
    const lines = [];
    for (const n of notes) {
      const l = (lines[n.line] = lines[n.line] || { idx: n.line, notes: [] });
      l.notes.push(n);
    }
    return lines.filter(Boolean).map((l) => ({
      ...l,
      start: l.notes[0].t,
      end: l.notes[l.notes.length - 1].t + l.notes[l.notes.length - 1].d,
      text: l.notes.map((n) => n.lyric).join('').trim(),
    }));
  }

  // Etapas do treino de um trecho: vai tirando a ajuda conforme você acerta
  const STAGES = [
    { name: 'Etapa 1 · Ouvir a sua parte', guide: 1, listen: true },
    { name: 'Etapa 2 · Cantar junto com o guia', guide: 0.7 },
    { name: 'Etapa 3 · Guia baixinho', guide: 0.3 },
    { name: 'Etapa 4 · Sem guia', guide: 0 },
    { name: 'Etapa 5 · Sem ver as notas', guide: 0, hideNotes: true },
  ];
  const STAGE_PASS = 75; // % de afinação para passar de etapa

  // ---------------- Jogo ----------------
  class Game {
    constructor({ canvas, lyricsEl, hud, onFinish }) {
      this.canvas = canvas;
      this.g = canvas.getContext('2d');
      this.lyricsEl = lyricsEl;
      this.hud = hud;
      this.onFinish = onFinish;
      this.running = false;
      this.trail = [];
      this._frame = this._frame.bind(this);
    }

    async init(ctx, mic) {
      this.ctx = ctx;
      this.mic = mic;
      this.out = ctx.createGain(); // tudo que o app toca passa aqui (e pode ser gravado)
      this.out.connect(ctx.destination);
      this.sched = new K.Scheduler(ctx, this.out);
      this.stems = new K.StemPlayer(ctx, this.out);
    }

    // media: { audioBlob } para MP3 simples, ou { stems: true } quando o StemPlayer já está carregado
    load(song, settings, media = {}) {
      this.song = song;
      this.s = settings;
      this.stemMode = !!media.stems;
      const audioBlob = media.audioBlob;
      this.data = prepare(song, settings);
      this.lines = linesOf(this.data.mine);
      this.partnerName = settings.partnerName || '';
      this.partnerLines = linesOf(this.data.partner);

      const all = this.data.mine.concat(this.data.partner);
      let lo = Math.min(...all.map((n) => n.midi)), hi = Math.max(...all.map((n) => n.midi));
      const pad = Math.max(3, (14 - (hi - lo)) / 2);
      this.yLo = Math.floor(lo - pad);
      this.yHi = Math.ceil(hi + pad);

      this.sched.setTracks([
        { bus: 'partner', events: this.stemMode ? [] : this.data.partner },
        { bus: 'guide', events: this.stemMode ? [] : this.data.mine },
        { bus: 'accomp', events: this.data.accomp, transpose: this.data.transpose },
      ]);
      this.sched.setVolume('partner', settings.partnerVol);
      this.sched.setVolume('guide', settings.guideVol);
      this.sched.setVolume('accomp', settings.accompVol);

      if (this.stemMode) this.stems.setVolumes({ inst: settings.accompVol, partner: settings.partnerVol, guide: settings.guideVol });
      if (this.audio) { this.audio.pause(); URL.revokeObjectURL(this.audio.src); this.audioNode.disconnect(); this.audio = null; }
      if (audioBlob) {
        this.audio = new Audio(URL.createObjectURL(audioBlob));
        this.audio.volume = settings.audioVol ?? 1;
        this.audio.preservesPitch = true;
        this.audioNode = this.ctx.createMediaElementSource(this.audio);
        this.audioNode.connect(this.out);
      }
      const lastMine = this.data.mine[this.data.mine.length - 1];
      const lastPartner = this.data.partner[this.data.partner.length - 1];
      this.songEnd = Math.max(lastMine.t + lastMine.d, lastPartner ? lastPartner.t + lastPartner.d : 0) + 1.5;
    }

    setGuide(v) {
      if (this.stemMode) this.stems.setVolumes({ guide: v });
      else this.sched.setVolume('guide', v);
    }

    // from/to: trecho (segundos) para praticar; loop repete o trecho
    start({ from = null, to = null, loop = false } = {}) {
      const first = this.data.mine[0].t;
      this.range = { from: from ?? 0, to: to ?? this.songEnd, loop };
      this.practice = from != null;
      const preroll = 3 * this.s.rate;
      const hasBacking = this.audio || this.stemMode || this.data.accomp.length;
      this.startSong = this.practice ? from - 2.5 : hasBacking ? Math.min(0, first - preroll) : first - preroll;
      for (const n of this.data.mine) n.inRange = !n.free && n.t >= this.range.from - 0.01 && n.t < this.range.to;
      this.scored = this.data.mine.filter((n) => n.inRange);
      this.totalDur = this.scored.reduce((s, n) => s + n.d, 0) || 1;
      this.resetScore();
      this.loops = 0;
      this.stage = this.practice && this.s.stages !== false ? 0 : null;
      this._applyStage();
      this.recording = null;
      if (!this.practice && this.s.record !== false) this._startRecording();
      this._seekTo(this.startSong);
      this.running = true;
      this.paused = false;
      this.lastFrame = performance.now();
      requestAnimationFrame(this._frame);
    }

    resetScore() {
      for (const n of this.data.mine) { n.hit = 0; n.total = 0; n.samples = []; n.done = false; }
      this.combo = 0;
      this.maxCombo = 0;
      this.centsSum = 0;
      this.centsCount = 0;
      this.voicedTime = 0;
      this.feedback = null;
      this.trail = [];
    }

    _seekTo(t) {
      this.anchorCtx = this.ctx.currentTime + 0.08;
      this.anchorSong = t;
      this.sched.seek(t);
      this.noteIdx = 0;
      if (this.audio) { this.audio.pause(); this.audioStarted = false; }
      if (this.stemMode) this.stems.play(t, this.anchorCtx, this.song.phrases, this.s.myKey, this.s.jointMode);
    }

    _applyStage() {
      const st = this.stage == null ? null : STAGES[this.stage];
      this.hideNotes = !!(st && st.hideNotes);
      this.setGuide(st ? st.guide * Math.max(this.s.guideVol, 0.6) : this.s.guideVol);
      if (this.hud.stage) {
        this.hud.stage.hidden = !st;
        if (st) this.hud.stageName.textContent = st.name + (st.listen ? ' (só escute)' : ` · passe com ${STAGE_PASS}%`);
      }
    }

    changeStage(delta) {
      if (this.stage == null) return;
      this.stage = Math.max(0, Math.min(STAGES.length - 1, this.stage + delta));
      this._applyStage();
    }

    _endLoop() {
      this.loops++;
      const r = (this.lastLoopResult = this.results());
      if (this.stage != null) {
        const st = STAGES[this.stage];
        if (st.listen || r.pct >= STAGE_PASS) {
          if (this.stage < STAGES.length - 1) {
            this.stage++;
            this._stageMsg(st.listen ? 'Agora é sua vez de cantar!' : `Passou com ${Math.round(r.pct)}%! Menos ajuda agora.`);
          } else {
            this._stageMsg(`Trecho dominado! (${Math.round(r.pct)}%)`);
          }
        } else {
          this._stageMsg(`${Math.round(r.pct)}% — mais uma vez`);
        }
        this._applyStage();
      }
      this.resetScore();
      this._seekTo(Math.max(this.range.from - 2, -1));
    }

    _stageMsg(text) {
      this.feedback = { text, cls: 'stage', at: performance.now(), long: true };
    }

    // grava a sua voz junto com o que está tocando (o playback atrasa o mesmo tanto que o microfone)
    _startRecording() {
      if (!window.MediaRecorder || !this.mic.src) return;
      try {
        const ctx = this.ctx;
        const dest = ctx.createMediaStreamDestination();
        const delay = ctx.createDelay(1.5);
        delay.delayTime.value = Math.min(1.4, this.s.latency || 0);
        const back = ctx.createGain(); back.gain.value = 0.7;
        const voice = ctx.createGain(); voice.gain.value = 1.4;
        this.out.connect(delay).connect(back).connect(dest);
        this.mic.src.connect(voice).connect(dest);
        const rec = new MediaRecorder(dest.stream);
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        this.recorder = { rec, chunks, nodes: [delay, back, voice], done: new Promise((r) => (rec.onstop = r)) };
        rec.start(1000);
      } catch (e) {
        console.warn('Gravação indisponível', e);
        this.recorder = null;
      }
    }

    async _stopRecording(keep) {
      const r = this.recorder;
      if (!r) return null;
      this.recorder = null;
      if (r.rec.state !== 'inactive') r.rec.stop();
      await r.done;
      try { this.out.disconnect(r.nodes[0]); } catch (e) { /* ok */ }
      try { this.mic.src.disconnect(r.nodes[2]); } catch (e) { /* ok */ }
      r.nodes.forEach((n) => n.disconnect());
      return keep && r.chunks.length ? new Blob(r.chunks, { type: r.rec.mimeType || 'audio/webm' }) : null;
    }

    songTime() {
      if (this.paused) return this.pausedAt;
      return this.anchorSong + (this.ctx.currentTime - this.anchorCtx) * this.s.rate;
    }

    togglePause() {
      if (!this.running) return;
      if (!this.paused) {
        this.pausedAt = this.songTime();
        this.paused = true;
        this.sched.stopAll();
        this.stems.stop();
        if (this.audio) this.audio.pause();
        if (this.recorder && this.recorder.rec.state === 'recording') this.recorder.rec.pause();
      } else {
        if (this.recorder && this.recorder.rec.state === 'paused') this.recorder.rec.resume();
        this.paused = false;
        this._seekTo(this.pausedAt);
      }
      return this.paused;
    }

    stop() {
      this.running = false;
      this.sched.stopAll();
      this.stems.stop();
      if (this.audio) this.audio.pause();
      this._stopRecording(false);
    }

    _syncAudio(t) {
      const a = this.audio;
      if (!a) return;
      const at = t + (this.s.audioOffset || 0);
      if (at < 0 || at > (a.duration || Infinity)) { if (!a.paused) a.pause(); return; }
      a.playbackRate = this.s.rate;
      if (a.paused) {
        a.currentTime = at;
        a.play().catch(() => {});
      } else if (Math.abs(a.currentTime - at) > 0.15) {
        a.currentTime = at;
      }
    }

    _frame(now) {
      if (!this.running) return;
      const dtReal = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      const t = this.songTime();

      if (!this.paused) {
        const toCtx = (st) => this.anchorCtx + (st - this.anchorSong) / this.s.rate;
        this.sched.pump(t, this.s.rate, toCtx);
        this._syncAudio(t);
      }

      // pitch do microfone (compensa a latência)
      const raw = this.mic.read();
      const tt = t - (this.s.latency || 0);
      if (!this.paused) this._score(tt, raw, this.stage != null && STAGES[this.stage].listen ? 0 : dtReal * this.s.rate);

      this._render(t, tt);
      this._renderLyrics(t);
      this._renderHud();

      if (!this.paused) {
        if (t > this.range.to + (this.practice ? 0.6 : 0)) {
          if (this.range.loop) {
            this._endLoop();
          } else if (this.practice || t > this.songEnd) {
            this.finish();
            return;
          }
        }
      }
      requestAnimationFrame(this._frame);
    }

    _currentNote(tt) {
      const notes = this.data.mine;
      while (this.noteIdx < notes.length && notes[this.noteIdx].t + notes[this.noteIdx].d < tt) {
        this._closeNote(notes[this.noteIdx]);
        this.noteIdx++;
      }
      const n = notes[this.noteIdx];
      return n && n.t <= tt ? n : null;
    }

    _closeNote(n) {
      if (n.done || n.free || !n.inRange) { n.done = true; return; }
      n.done = true;
      const frac = Math.min(1, n.hit / (n.d * 0.8));
      n.frac = frac;
      if (frac >= 0.6) { this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo); } else this.combo = 0;
      this.feedback = {
        text: frac >= 0.9 ? 'Perfeito!' : frac >= 0.7 ? 'Muito bom!' : frac >= 0.45 ? 'Quase!' : 'Ops...',
        cls: frac >= 0.9 ? 'perfect' : frac >= 0.7 ? 'good' : frac >= 0.45 ? 'ok' : 'miss',
        at: performance.now(),
      };
    }

    _score(tt, raw, dtSong) {
      const note = this._currentNote(tt);
      this.currentNote = note;
      let shown = raw;
      const ref = note ? note.midi : this._nearestTarget(tt);
      if (raw != null && this.s.octaveFree && ref != null) shown = K.foldToward(raw, ref);
      this.currentPitch = shown;
      this.trail.push({ t: tt, m: shown });
      while (this.trail.length && this.trail[0].t < tt - 3) this.trail.shift();

      if (!note || note.free || !note.inRange) return;
      note.total += dtSong;
      if (shown == null) { note.samples.push([tt, 0]); return; }
      this.voicedTime += dtSong;
      const cents = (shown - note.midi) * 100;
      const tol = this.s.tolerance;
      let w = 0;
      if (Math.abs(cents) <= tol) w = 1;
      else if (Math.abs(cents) <= tol * 2) w = 1 - (Math.abs(cents) - tol) / tol;
      note.hit += dtSong * w;
      note.samples.push([tt, w]);
      if (Math.abs(cents) < 150) { this.centsSum += cents; this.centsCount++; }
      this.currentCents = cents;
    }

    _nearestTarget(tt) {
      const n = this.data.mine[Math.min(this.noteIdx, this.data.mine.length - 1)];
      return n ? n.midi : null;
    }

    _partnerAt(tt) {
      for (const n of this.data.partner) {
        if (n.t > tt) break;
        if (tt < n.t + n.d) return n;
      }
      return null;
    }

    score() {
      let s = 0;
      for (const n of this.scored) s += (n.d / this.totalDur) * Math.min(1, n.hit / (n.d * 0.8));
      return Math.round(s * 10000);
    }

    results() {
      const score = this.score();
      const pct = score / 100;
      const lines = this.lines
        .filter((l) => l.notes.some((n) => n.inRange))
        .map((l) => {
          const ns = l.notes.filter((n) => n.inRange);
          const dur = ns.reduce((s, n) => s + n.d, 0) || 1;
          const acc = ns.reduce((s, n) => s + n.d * Math.min(1, n.hit / (n.d * 0.8)), 0) / dur;
          return { idx: l.idx, text: l.text || '(sem letra)', start: l.start, end: l.end, acc };
        });
      return {
        score,
        pct,
        stars: pct >= 90 ? 5 : pct >= 75 ? 4 : pct >= 60 ? 3 : pct >= 40 ? 2 : pct >= 20 ? 1 : 0,
        maxCombo: this.maxCombo,
        tendency: this.centsCount > 20 ? this.centsSum / this.centsCount : null,
        lines,
        practice: this.practice,
        loops: this.loops,
      };
    }

    async finish() {
      // fecha notas pendentes
      for (const n of this.data.mine) if (!n.done) this._closeNote(n);
      const res = this.results();
      this.running = false;
      this.sched.stopAll();
      this.stems.stop();
      if (this.audio) this.audio.pause();
      res.recording = await this._stopRecording(true);
      res.stage = this.stage != null ? STAGES[this.stage].name : null;
      if (this.onFinish) this.onFinish(res);
    }

    // ---------------- desenho ----------------
    _resize() {
      const c = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    _render(t, tt) {
      const { w, h } = this._resize();
      const g = this.g;
      const css = getComputedStyle(document.documentElement);
      const col = (name) => css.getPropertyValue(name).trim();
      const secs = w < 600 ? 4.5 : 6.5;
      const pxs = w / secs;
      const px = w * 0.24;
      const x = (time) => px + (time - t) * pxs;
      const span = this.yHi - this.yLo;
      const rowH = h / span;
      const y = (m) => h - (m - this.yLo) * rowH;

      g.clearRect(0, 0, w, h);

      // linhas das notas (destaque no Dó)
      g.font = '11px system-ui, sans-serif';
      for (let m = this.yLo; m <= this.yHi; m++) {
        const isC = ((m % 12) + 12) % 12 === 0;
        g.fillStyle = isC ? col('--grid-strong') : col('--grid');
        g.fillRect(0, Math.round(y(m)), w, 1);
        if (isC) { g.fillStyle = col('--muted'); g.fillText(K.noteName(m), 6, y(m) - 3); }
      }

      // notas da outra voz
      const tStart = t - secs * 0.3, tEnd = t + secs;
      g.fillStyle = col('--partner');
      for (const n of this.data.partner) {
        if (n.t + n.d < tStart || n.t > tEnd) continue;
        roundRect(g, x(n.t), y(n.midi + 0.5) + rowH * 0.25, Math.max(3, n.d * pxs), rowH * 0.5, 4);
        g.fill();
      }

      // minhas notas
      for (const n of this.data.mine) {
        if (n.t + n.d < tStart || n.t > tEnd) continue;
        if (this.hideNotes && n.t > tt) continue; // etapa "sem ver as notas": só aparece depois de cantar
        const nx = x(n.t), nw = Math.max(4, n.d * pxs), ny = y(n.midi + 0.5) + 1, nh = rowH - 2;
        g.fillStyle = n.free ? col('--free') : col('--mine');
        roundRect(g, nx, ny, nw, nh, 6);
        g.fill();
        // partes acertadas
        if (n.samples.length) {
          g.save();
          roundRect(g, nx, ny, nw, nh, 6);
          g.clip();
          for (const [st, wgt] of n.samples) {
            if (wgt <= 0) continue;
            g.fillStyle = wgt >= 1 ? col('--hit') : col('--hit-soft');
            g.fillRect(x(st) - 1.5, ny, 3.5, nh);
          }
          g.restore();
        }
        if (n.lyric && nw > 18) {
          g.fillStyle = col('--note-text');
          g.font = `${Math.min(13, Math.max(9, rowH * 0.7))}px system-ui, sans-serif`;
          g.fillText(n.lyric.trim(), nx + 4, ny + nh * 0.72, nw - 6);
        }
      }

      // linha do "agora"
      g.fillStyle = col('--playhead');
      g.fillRect(px - 1, 0, 2, h);

      // rastro da sua voz
      g.strokeStyle = col('--voice');
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      let pen = false;
      for (const p of this.trail) {
        if (p.m == null || p.m < this.yLo - 1 || p.m > this.yHi + 1) { pen = false; continue; }
        const X = x(p.t), Y = y(p.m);
        if (!pen) { g.moveTo(X, Y); pen = true; } else g.lineTo(X, Y);
      }
      g.stroke();

      // bolinha da voz atual
      if (this.currentPitch != null) {
        const Y = y(Math.max(this.yLo, Math.min(this.yHi, this.currentPitch)));
        g.fillStyle = col('--voice');
        g.beginPath();
        g.arc(x(tt), Y, 7, 0, Math.PI * 2);
        g.fill();
      }

      // contagem regressiva
      const firstNote = this.scored[0];
      if (firstNote && t < firstNote.t && firstNote.t - t < 3.2 * this.s.rate && !this.paused) {
        const left = Math.ceil((firstNote.t - t) / this.s.rate);
        g.fillStyle = col('--muted');
        g.font = 'bold 42px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(String(left), w / 2, h / 2);
        g.textAlign = 'left';
      }
      if (this.paused) {
        g.fillStyle = col('--overlay');
        g.fillRect(0, 0, w, h);
        g.fillStyle = col('--text');
        g.font = 'bold 28px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('Pausado (espaço para continuar)', w / 2, h / 2);
        g.textAlign = 'left';
      }
    }

    _renderLyrics(t) {
      const tt = t;
      const lineIdx = (lines) => {
        for (let i = 0; i < lines.length; i++) if (tt < lines[i].end + 0.3) return i;
        return lines.length;
      };
      const i = lineIdx(this.lines);
      const cur = this.lines[i], next = this.lines[i + 1];
      const pi = lineIdx(this.partnerLines);
      const pcur = this.partnerLines[pi];
      const key = [i, pi, pcur && pcur.start - tt < 4].join(':');
      if (key !== this._lyricsKey) {
        this._lyricsKey = key;
        const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const syl = (l) => {
          if (!l) return '';
          if (this.stemMode) return `<span class="wipe">${esc(l.text) || '♪ ♪ ♪'}</span>`;
          return l.notes.map((n) => `<span>${esc(n.lyric)}</span>`).join('');
        };
        let partnerTxt = pcur && pcur.start - tt < 4 ? esc(pcur.text || (this.stemMode ? '…' : '')) : '';
        if (partnerTxt && this.stemMode && this.partnerName) partnerTxt = `<b>${esc(this.partnerName)}:</b> ` + partnerTxt;
        this.lyricsEl.innerHTML =
          `<div class="ly-partner">${partnerTxt ? '♪ ' + partnerTxt : '&nbsp;'}</div>` +
          `<div class="ly-cur">${syl(cur) || '&nbsp;'}</div>` +
          `<div class="ly-next">${next ? esc(next.text) : '&nbsp;'}</div>`;
        this._curSpans = this.lyricsEl.querySelectorAll('.ly-cur span');
      }
      if (cur && this.stemMode && this._curSpans[0]) {
        const p = Math.max(0, Math.min(1, (tt - cur.start) / Math.max(0.1, cur.end - cur.start)));
        this._curSpans[0].style.setProperty('--p', (p * 100).toFixed(1) + '%');
      } else if (cur && this._curSpans) {
        cur.notes.forEach((n, k) => {
          const el = this._curSpans[k];
          if (!el) return;
          const state = tt >= n.t + n.d ? 'sung' : tt >= n.t ? 'now' : '';
          if (el.className !== state) el.className = state;
        });
      }
    }

    _renderHud() {
      const h = this.hud;
      h.score.textContent = this.score().toLocaleString('pt-BR');
      h.combo.textContent = this.combo > 1 ? `${this.combo}x combo` : '';
      const n = this.currentNote;
      const p = this.currentPitch;
      h.target.textContent = n && !n.free ? K.noteName(n.midi) : '–';
      h.sung.textContent = p != null ? K.noteName(p) : '–';
      if (n && p != null && !n.free) {
        const c = Math.round((p - n.midi) * 100);
        h.tuner.style.setProperty('--off', Math.max(-100, Math.min(100, c)) + '');
        h.tuner.dataset.state = Math.abs(c) <= this.s.tolerance ? 'ok' : c > 0 ? 'high' : 'low';
        h.cents.textContent = Math.abs(c) <= this.s.tolerance ? 'afinado' : c > 0 ? `${c}¢ acima` : `${-c}¢ abaixo`;
      } else {
        h.tuner.dataset.state = 'idle';
        h.tuner.style.setProperty('--off', '0');
        h.cents.textContent = '';
      }
      // intervalo com a outra voz
      const tt = this.songTime() - (this.s.latency || 0);
      const pn = this._partnerAt(tt);
      if (pn && n && !n.free) {
        const target = K.intervalName(n.midi, pn.midi);
        const sung = p != null ? K.intervalName(p, pn.midi) : null;
        const ok = p != null && Math.abs((p - n.midi) * 100) <= this.s.tolerance;
        h.interval.innerHTML = `Harmonia: <b>${target}</b>` + (sung ? ` · você: <b class="${ok ? 'ok' : 'off'}">${sung}</b>` : '');
      } else {
        h.interval.textContent = pn ? 'A outra voz está sozinha agora' : n ? 'Só você canta agora' : '';
      }
      const fb = this.feedback;
      if (fb && performance.now() - fb.at < (fb.long ? 2500 : 900)) {
        h.feedback.textContent = fb.text;
        h.feedback.className = 'feedback show ' + fb.cls;
      } else {
        h.feedback.className = 'feedback';
      }
      h.progress.style.width = Math.max(0, Math.min(100, (this.songTime() / this.songEnd) * 100)) + '%';
    }
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  Object.assign(K, { Mic, Game, linesOf });
})(globalThis.K = globalThis.K || {});
