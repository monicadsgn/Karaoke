// Interface: navegação entre telas, importação, ajustes e resultados.
(function (K) {
  const $ = (id) => document.getElementById(id);
  const state = { song: null, settings: null, audioBlob: null, ctx: null, mic: null, game: null, lastPractice: null };

  // ---------------- utilidades ----------------
  function toast(msg, ms = 3200) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    document.body.dataset.screen = name;
    if (name !== 'game' && state.game && state.game.running) state.game.stop();
    if (name === 'library') renderLibrary();
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      if (go.dataset.go === 'setup' && !state.song) return show('library');
      show(go.dataset.go);
    }
  });

  function allSongs() {
    return K.DEMOS.concat(K.Store.songs().map((s) => (s.type === 'stems' ? { ...s, voices: K.stemsVoices(s) } : s)));
  }

  function busy(text) {
    let el = document.querySelector('.busy');
    if (text == null) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'busy'; document.body.appendChild(el); }
    el.textContent = text;
  }
  function newId() { return 'song-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function fmtTime(s) { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

  async function ensureAudio() {
    if (!state.ctx) state.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    return state.ctx;
  }

  async function ensureMic() {
    const ctx = await ensureAudio();
    const headphones = $('headphones').checked;
    const deviceId = $('micDevice').value;
    if (state.mic && state.mic.headphones === headphones && state.mic.deviceId === deviceId) return state.mic;
    if (state.mic) state.mic.stop();
    const mic = new K.Mic();
    try {
      await mic.start(ctx, { headphones, deviceId });
    } catch (e) {
      toast('Não consegui acessar o microfone. Permita o acesso no navegador e tente de novo.', 6000);
      throw e;
    }
    mic.headphones = headphones;
    mic.deviceId = deviceId;
    state.mic = mic;
    if (state.game) state.game.mic = mic;
    $('micPill').classList.add('on');
    $('micPillText').textContent = 'mic ligado';
    listMicDevices();
    return mic;
  }

  // lista as entradas de áudio (os nomes só aparecem depois de dar permissão ao microfone)
  async function listMicDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('micDevice');
    const cur = sel.value || K.Store.globalPrefs().micDevice || '';
    sel.innerHTML = '<option value="">Microfone padrão</option>' + devs
      .filter((d) => d.deviceId && d.deviceId !== 'default')
      .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Entrada ' + (i + 1))}</option>`).join('');
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  }

  function ensureGame() {
    if (!state.game) {
      state.game = new K.Game({
        canvas: $('stage'),
        lyricsEl: $('lyrics'),
        hud: {
          score: $('hudScore'), combo: $('hudCombo'), target: $('hudTarget'), sung: $('hudSung'),
          tuner: $('hudTuner'), cents: $('hudCents'), interval: $('hudInterval'), feedback: $('hudFeedback'),
          progress: $('hudProgress'), stage: $('hudStage'), stageName: $('hudStageName'),
        },
        onFinish: showResults,
      });
      state.game.init(state.ctx, state.mic);
    }
    return state.game;
  }

  // ---------------- biblioteca ----------------
  function renderLibrary() {
    const list = $('songList');
    const songs = allSongs();
    list.innerHTML = songs.map((s) => {
      const best = bestFor(s.id);
      const voices = s.voices.map((v) => esc(v.name)).join(' + ');
      return `<article class="song" data-id="${esc(s.id)}">
        <div class="song-main">
          <h3>${esc(s.title)}</h3>
          <p class="muted">${esc(s.artist || '')}${s.artist ? ' · ' : ''}${s.voices.length === 2 ? 'dueto' : '1 voz'} · ${esc(s.source)}</p>
          <p class="muted small">${voices}</p>
        </div>
        <div class="song-side">
          ${best ? `<span class="best">🏆 ${best}</span>` : ''}
          ${s.source !== 'demo' ? `<button class="link small danger" data-del="${esc(s.id)}">excluir</button>` : ''}
        </div>
      </article>`;
    }).join('');
  }

  function bestFor(songId) {
    let best = 0;
    const song = allSongs().find((s) => s.id === songId);
    if (!song) return '';
    song.voices.forEach((_, i) => {
      const b = K.Store.best(songId + '#' + i);
      if (b && b.score > best) best = b.score;
    });
    return best ? best.toLocaleString('pt-BR') : '';
  }

  $('songList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      if (confirm('Excluir esta música?')) { K.Store.deleteSong(del.dataset.del); renderLibrary(); }
      return;
    }
    const card = e.target.closest('.song');
    if (card) openSong(card.dataset.id);
  });

  // ---------------- importação ----------------
  $('importUltrastar').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const song = K.parseUltraStar(K.decodeText(await f.arrayBuffer()));
      song.id = newId();
      K.Store.saveSong(song);
      toast(`"${song.title}" importada${song.voices.length === 2 ? ' como dueto' : ''}!` +
        (song.audioHint ? ` Se tiver o áudio (${song.audioHint}), adicione na próxima tela.` : ''), 5000);
      openSong(song.id);
    } catch (err) {
      toast('Erro ao importar: ' + err.message, 6000);
    }
  });

  $('importKaraoke').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    busy('Importando…');
    try {
      const { song, blobs } = K.parseKaraokeFile(await f.text());
      song.id = newId();
      await K.Store.saveAudio(song.id + ':inst', blobs.inst);
      await K.Store.saveAudio(song.id + ':voc', blobs.voc);
      K.Store.saveSong(song);
      busy(null);
      toast(`"${song.title}" importada! Confira quem canta cada trecho.`, 5000);
      openSong(song.id);
    } catch (err) {
      busy(null);
      toast('Erro ao importar: ' + err.message, 6000);
    }
  });

  let midiParsed = null;
  $('importMidi').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      midiParsed = K.parseMidi(await f.arrayBuffer());
    } catch (err) {
      return toast('Erro ao ler MIDI: ' + err.message, 6000);
    }
    const parts = midiParsed.parts.filter((p) => !p.drums);
    if (!parts.length) return toast('Esse MIDI não tem faixas com notas.');
    $('midiTitle').value = midiParsed.title || f.name.replace(/\.(mid|midi|kar)$/i, '');
    $('midiArtist').value = '';
    $('midiTracks').innerHTML = parts.map((p) => `
      <div class="track">
        <button type="button" class="btn small" data-preview="${p.id}">▶</button>
        <div><b>${esc(p.name)}</b><br><span class="muted small">${p.count} notas · ${K.noteName(p.range[0])}–${K.noteName(p.range[1])}
        · ${p.polyphony < 0.1 ? 'melódica' : 'acordes'}</span></div>
      </div>`).join('');
    // sugestão: faixas melódicas em região de voz
    const melodic = parts
      .filter((p) => p.polyphony < 0.15 && p.range[0] >= 45 && p.range[1] <= 88)
      .sort((a, b) => b.count - a.count);
    const opts = (sel) => '<option value="">— nenhuma / gerar automática —</option>' +
      parts.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    $('midiV1').innerHTML = opts(melodic[0]?.id || parts[0].id).replace('— nenhuma / gerar automática —', '— escolha —');
    $('midiV2').innerHTML = opts(melodic[1]?.id || '');
    $('midiLyricsInfo').textContent = midiParsed.lyrics.length
      ? `Letra encontrada (${midiParsed.lyrics.length} sílabas) — vai para a voz que combinar melhor.`
      : 'Sem letra neste arquivo (você vai ver só as notas).';
    $('midiDialog').showModal();
  });

  $('midiTracks').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-preview]');
    if (!b) return;
    const ctx = await ensureAudio();
    const part = midiParsed.parts.find((p) => p.id === b.dataset.preview);
    if (!state.preview) state.preview = new K.Scheduler(ctx);
    const pv = state.preview;
    pv.stopAll();
    pv.setVolume('partner', 0.8);
    const t0 = part.notes[0].t;
    const now = ctx.currentTime + 0.05;
    for (const n of part.notes) {
      if (n.t - t0 > 8) break;
      pv.playNote('partner', n.midi, now + n.t - t0, n.d, 1);
    }
  });

  $('midiDialog').addEventListener('close', () => {
    if (state.preview) state.preview.stopAll();
    if ($('midiDialog').returnValue !== 'ok' || !midiParsed) return;
    try {
      const song = K.buildSongFromMidi(midiParsed, {
        voice1: $('midiV1').value,
        voice2: $('midiV2').value && $('midiV2').value !== $('midiV1').value ? $('midiV2').value : '',
        accompaniment: $('midiAccomp').checked,
        title: $('midiTitle').value.trim(),
        artist: $('midiArtist').value.trim(),
        names: ['Primeira voz', 'Segunda voz'],
      });
      song.id = newId();
      K.Store.saveSong(song);
      toast(`"${song.title}" importada!`);
      openSong(song.id);
    } catch (err) {
      toast('Erro: ' + err.message, 6000);
    }
  });

  // ---------------- tela da música ----------------
  const DEFAULTS = {
    myVoice: 0, partner: null, transpose: 0, rate: 1, tolerance: 45, octaveFree: true,
    partnerVol: 0.8, guideVol: 0.25, accompVol: 0.6, audioVol: 0.8, audioOffset: 0, jointMode: 'play',
  };

  async function openSong(id) {
    const song = allSongs().find((s) => s.id === id);
    if (!song) return;
    state.song = song;
    const g = K.Store.globalPrefs();
    const s = (state.settings = { ...DEFAULTS, latency: g.latency ?? 0.08, ...K.Store.prefs(id) });
    if (!s.partner) s.partner = song.voices.length > 1 ? 'voice:' + (s.myVoice === 0 ? 1 : 0) : 'third_above';
    if (s.myVoice >= song.voices.length) s.myVoice = 0;
    $('headphones').checked = g.headphones ?? true;
    const stems = song.type === 'stems';
    $('partnerBlock').hidden = stems;
    $('audioBlock').hidden = stems;
    $('phraseCard').hidden = !stems;
    $('accompVolLabel').textContent = stems ? 'Instrumental' : 'Acompanhamento';
    $('guideVolLabel').textContent = stems ? 'Voz original da minha parte' : 'Guia da minha voz';
    $('guideHelp').textContent = stems
      ? 'Nos seus trechos, a voz original fica neste volume: alto para aprender, zero para cantar só você.'
      : '"Guia da minha voz" toca a sua própria parte baixinho. Ótimo para aprender; tire quando já souber.';
    if (stems) renderPhrases();

    $('setupTitle').textContent = song.title;
    $('setupArtist').textContent = song.artist || '';
    state.audioBlob = null;
    try { state.audioBlob = (await K.Store.loadAudio(id)) || null; } catch (e) { /* sem IndexedDB */ }
    syncSetupForm();
    show('setup');
  }

  function syncSetupForm() {
    const song = state.song, s = state.settings;
    $('voiceChoice').innerHTML = song.voices.map((v, i) => `
      <label class="choice ${i === s.myVoice ? 'sel' : ''}">
        <input type="radio" name="myVoice" value="${i}" ${i === s.myVoice ? 'checked' : ''}>
        <b>${esc(v.name)}</b><span class="muted small">${rangeText(v.notes, s.transpose)}</span>
      </label>`).join('');

    if (song.type === 'stems') {
      const other = song.voices.find((_, i) => i !== s.myVoice);
      $('partnerVolLabel').textContent = other ? 'Voz de ' + other.name : 'Outra voz';
    } else {
      $('partnerVolLabel').textContent = 'Outra voz';
    }
    const partnerOpts = [];
    song.voices.forEach((v, i) => { if (i !== s.myVoice) partnerOpts.push([`voice:${i}`, v.name]); });
    for (const [k, cfg] of Object.entries(K.HARMONY_MODES)) partnerOpts.push([k, cfg.label]);
    partnerOpts.push(['none', 'Ninguém — só eu']);
    if (!partnerOpts.some(([k]) => k === s.partner)) s.partner = partnerOpts[0][0];
    $('partnerSelect').innerHTML = partnerOpts.map(([k, l]) => `<option value="${k}" ${k === s.partner ? 'selected' : ''}>${esc(l)}</option>`).join('');

    const my = song.voices[s.myVoice];
    const key = K.detectKey(my.notes);
    $('rangeInfo').textContent = `Sua parte: ${rangeText(my.notes, s.transpose)} · tom aproximado: ${K.keyName({ ...key, tonic: (key.tonic + s.transpose + 120) % 12 })}`;

    $('trOut').textContent = (s.transpose > 0 ? '+' : '') + s.transpose;
    $('rate').value = s.rate;
    $('rateOut').textContent = Math.round(s.rate * 100) + '%';
    document.querySelectorAll('input[name=diff]').forEach((r) => { r.checked = +r.value === s.tolerance; });
    $('octaveFree').checked = s.octaveFree;
    $('startNote').checked = s.startNote !== false;
    for (const k of ['partnerVol', 'guideVol', 'accompVol', 'audioVol']) $(k).value = s[k];
    $('accompRow').hidden = !(song.accomp && song.accomp.length);
    const hasAudio = !!state.audioBlob;
    $('audioVolRow').hidden = !hasAudio;
    $('audioOffsetRow').hidden = !hasAudio;
    $('audioRemove').hidden = !hasAudio;
    $('audioName').textContent = hasAudio ? (state.audioBlob.name || 'áudio carregado') : 'nenhum';
    $('audioOffset').value = s.audioOffset;
    $('audioOffsetOut').textContent = s.audioOffset.toFixed(2).replace('.', ',') + ' s';
    $('audioTransposeWarn').hidden = !(hasAudio && s.transpose);
    $('latency').value = s.latency;
    $('latencyOut').textContent = Math.round(s.latency * 1000) + ' ms';

    const lines = K.linesOf(my.notes);
    $('lineList').innerHTML = lines.map((l) => `
      <div class="line-item"><span class="time">${fmtTime(l.start)}</span><span class="txt">${esc(l.text || '(sem letra)')}</span>
      <button class="btn small" data-practice="${l.start}:${l.end}">praticar</button></div>`).join('');
  }

  function rangeText(notes, tr) {
    const lo = Math.min(...notes.map((n) => n.midi)) + tr, hi = Math.max(...notes.map((n) => n.midi)) + tr;
    return `${K.noteName(lo)} a ${K.noteName(hi)}`;
  }

  function saveSettings() { K.Store.savePrefs(state.song.id, state.settings); }

  $('voiceChoice').addEventListener('change', (e) => {
    const s = state.settings;
    s.myVoice = +e.target.value;
    if (s.partner === 'voice:' + s.myVoice) s.partner = null;
    if (!s.partner) s.partner = state.song.voices.length > 1 ? 'voice:' + (s.myVoice === 0 ? 1 : 0) : 'third_above';
    saveSettings(); syncSetupForm();
  });
  $('partnerSelect').addEventListener('change', (e) => { state.settings.partner = e.target.value; saveSettings(); });
  $('trDown').onclick = () => { state.settings.transpose = Math.max(-12, state.settings.transpose - 1); saveSettings(); syncSetupForm(); };
  $('trUp').onclick = () => { state.settings.transpose = Math.min(12, state.settings.transpose + 1); saveSettings(); syncSetupForm(); };
  $('rate').oninput = (e) => { state.settings.rate = +e.target.value; $('rateOut').textContent = Math.round(state.settings.rate * 100) + '%'; saveSettings(); };
  $('difficulty').addEventListener('change', (e) => { state.settings.tolerance = +e.target.value; saveSettings(); });
  $('octaveFree').onchange = (e) => { state.settings.octaveFree = e.target.checked; saveSettings(); };
  $('startNote').onchange = (e) => { state.settings.startNote = e.target.checked; saveSettings(); };
  for (const k of ['partnerVol', 'guideVol', 'accompVol', 'audioVol']) {
    $(k).oninput = (e) => { state.settings[k] = +e.target.value; saveSettings(); };
  }
  $('audioOffset').oninput = (e) => {
    state.settings.audioOffset = +e.target.value;
    $('audioOffsetOut').textContent = state.settings.audioOffset.toFixed(2).replace('.', ',') + ' s';
    saveSettings();
  };
  $('latency').oninput = (e) => {
    state.settings.latency = +e.target.value;
    $('latencyOut').textContent = Math.round(state.settings.latency * 1000) + ' ms';
    K.Store.saveGlobalPrefs({ latency: state.settings.latency });
    saveSettings();
  };
  $('headphones').onchange = (e) => K.Store.saveGlobalPrefs({ headphones: e.target.checked });

  $('audioFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    state.audioBlob = f;
    try { await K.Store.saveAudio(state.song.id, f); } catch (err) { toast('Áudio carregado (não deu pra salvar no navegador; escolha de novo na próxima vez).'); }
    syncSetupForm();
  });
  $('audioRemove').onclick = async () => {
    state.audioBlob = null;
    try { await K.Store.deleteAudio(state.song.id); } catch (e) { /* ok */ }
    syncSetupForm();
  };

  // teste de microfone
  let micTestOn = false;
  $('micTest').onclick = async () => {
    try { await ensureMic(); } catch (e) { return; }
    micTestOn = !micTestOn;
    $('micTest').textContent = micTestOn ? 'Parar teste' : 'Testar microfone';
    const tick = () => {
      if (!micTestOn || document.body.dataset.screen !== 'setup') { micTestOn = false; $('micTest').textContent = 'Testar microfone'; return; }
      const m = state.mic.read();
      $('micLevel').style.width = Math.min(100, state.mic.level * 600) + '%';
      $('micNote').textContent = m != null ? K.noteName(m) : '–';
      requestAnimationFrame(tick);
    };
    if (micTestOn) tick();
  };

  // ---------------- editor de trechos (músicas gravadas) ----------------
  function storedSong() { return K.Store.songs().find((x) => x.id === state.song.id); }

  function renderPhrases() {
    const song = storedSong();
    $('singerA').value = song.singers.A;
    $('singerB').value = song.singers.B;
    $('jointMode').value = state.settings.jointMode || 'play';
    const opt = (v, l, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    $('phraseList').innerHTML = song.phrases.map((p, i) => `
      <div class="phrase" data-i="${i}" data-who="${p.who}">
        <button class="btn small" data-play="${i}" title="Ouvir">▶</button>
        <span class="time">${fmtTime(p.t0)}</span>
        <select data-who-sel="${i}">
          ${opt('A', song.singers.A, p.who)}${opt('B', song.singers.B, p.who)}${opt('AB', 'Juntos', p.who)}${opt('-', 'Ignorar', p.who)}
        </select>
        <input data-lyric="${i}" value="${esc(p.lyric || '')}" placeholder="letra deste trecho (opcional)">
      </div>`).join('');
  }

  function updateStoredSong(fn) {
    const song = storedSong();
    fn(song);
    K.Store.saveSong(song);
    const fresh = allSongs().find((x) => x.id === song.id);
    state.song = fresh;
    if (state.settings.myVoice >= fresh.voices.length) state.settings.myVoice = 0;
  }

  $('phraseList').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-who-sel]');
    const inp = e.target.closest('[data-lyric]');
    if (sel) {
      const i = +sel.dataset.whoSel;
      updateStoredSong((song) => { song.phrases[i].who = sel.value; });
      sel.closest('.phrase').dataset.who = sel.value;
      syncSetupForm();
    } else if (inp) {
      updateStoredSong((song) => { song.phrases[+inp.dataset.lyric].lyric = inp.value; });
    }
  });

  $('phraseList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-play]');
    if (!b) return;
    await ensureAudio();
    const g = ensureGame();
    try { await loadStems(g); } catch (err) { return; }
    const p = state.song.phrases[+b.dataset.play];
    g.stems.preview(Math.max(0, p.t0 - 0.2), p.t1 + 0.3);
  });

  for (const k of ['A', 'B']) {
    $('singer' + k).addEventListener('change', (e) => {
      updateStoredSong((song) => { song.singers[k] = e.target.value.trim() || (k === 'A' ? 'Voz aguda' : 'Voz grave'); });
      renderPhrases();
      syncSetupForm();
    });
  }
  $('jointMode').onchange = (e) => { state.settings.jointMode = e.target.value; saveSettings(); };
  $('lyricsApply').onclick = () => {
    const lines = $('lyricsPaste').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    updateStoredSong((song) => {
      let li = 0;
      for (const p of song.phrases) {
        if (p.who === '-') continue;
        p.lyric = lines[li++] || '';
      }
    });
    renderPhrases();
    toast(`${lines.length} linhas distribuídas. Confira ouvindo cada trecho.`);
  };

  async function loadStems(g) {
    const id = state.song.id;
    if (g.stems.songId === id && g.stems.raw) return;
    busy('Carregando áudio…');
    try {
      const blobs = { inst: await K.Store.loadAudio(id + ':inst'), voc: await K.Store.loadAudio(id + ':voc') };
      if (!blobs.inst || !blobs.voc) throw new Error('Áudio desta música não encontrado. Importe o .karaoke de novo.');
      await g.stems.load(id, blobs);
    } catch (err) {
      toast(err.message, 6000);
      throw err;
    } finally {
      busy(null);
    }
  }

  // ---------------- calibração de atraso ----------------
  $('calibrate').onclick = async () => {
    let mic;
    try { mic = await ensureMic(); } catch (e) { return; }
    const ctx = state.ctx;
    const N = 8, gap = 0.8, t0 = ctx.currentTime + 1;
    for (let i = 0; i < N; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 1000;
      g.gain.setValueAtTime(0, t0 + i * gap);
      g.gain.linearRampToValueAtTime(0.5, t0 + i * gap + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * gap + 0.12);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + i * gap); o.stop(t0 + i * gap + 0.15);
    }
    $('calibrateInfo').textContent = 'Diga "tá" junto com cada bipe…';
    const samples = [];
    await new Promise((resolve) => {
      const tick = () => {
        mic.read();
        samples.push([ctx.currentTime, mic.level]);
        if (ctx.currentTime < t0 + N * gap + 0.6) requestAnimationFrame(tick); else resolve();
      };
      tick();
    });
    const noise = samples.filter(([t]) => t < t0 - 0.1).map(([, l]) => l).sort((a, b) => a - b);
    const floor = noise.length ? noise[Math.floor(noise.length / 2)] : 0.005;
    const thr = Math.max(0.02, floor * 4);
    const offsets = [];
    for (let i = 0; i < N; i++) {
      const beep = t0 + i * gap;
      const hit = samples.find(([t, l], k) => t > beep - 0.15 && t < beep + gap - 0.1 && l > thr && (k === 0 || samples[k - 1][1] <= thr));
      if (hit) offsets.push(hit[0] - beep);
    }
    if (offsets.length < 4) {
      $('calibrateInfo').textContent = 'Não consegui ouvir você direito. Fale "tá" mais alto e tente de novo (e confira a entrada escolhida).';
      return;
    }
    offsets.sort((a, b) => a - b);
    const lat = Math.max(0, Math.min(0.6, offsets[Math.floor(offsets.length / 2)]));
    state.settings.latency = +lat.toFixed(2);
    $('latency').value = state.settings.latency;
    $('latencyOut').textContent = Math.round(lat * 1000) + ' ms';
    K.Store.saveGlobalPrefs({ latency: state.settings.latency });
    saveSettings();
    $('calibrateInfo').textContent = `Pronto! Atraso medido: ${Math.round(lat * 1000)} ms (${offsets.length} de ${N} bipes).`;
  };

  $('micDevice').onchange = (e) => { K.Store.saveGlobalPrefs({ micDevice: e.target.value }); };

  // ---------------- jogo ----------------
  async function play(practice = null) {
    try { await ensureMic(); } catch (e) { return; }
    micTestOn = false;
    const game = ensureGame();
    game.mic = state.mic;
    const song = state.song;
    const s = { ...state.settings };
    if (s.partner === 'none') s.partner = null;
    if (song.type === 'stems') {
      if (!song.voices.length) return toast('Marque pelo menos um trecho para cada cantor.');
      try { await loadStems(game); } catch (e) { return; }
      const needs = s.rate !== 1 || s.transpose !== 0;
      if (needs) busy('Ajustando tom/velocidade… 0%');
      await game.stems.prepare(s.rate, s.transpose, (p) => busy(`Ajustando tom/velocidade… ${Math.round(p * 100)}%`));
      busy(null);
      const other = song.voices.findIndex((_, i) => i !== s.myVoice);
      s.partner = other >= 0 ? 'voice:' + other : null;
      s.myKey = song.voices[s.myVoice].key;
      s.partnerName = other >= 0 ? song.voices[other].name : '';
      game.load(song, s, { stems: true });
    } else {
      game.load(song, s, { audioBlob: state.audioBlob });
    }
    state.lastPractice = practice;
    show('game');
    $('pauseBtn').textContent = 'Pausar';
    game.start(practice ? { from: practice.from, to: practice.to, loop: true } : {});
  }

  $('startBtn').onclick = () => play();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-practice]');
    if (!b) return;
    const [from, to] = b.dataset.practice.split(':').map(Number);
    play({ from, to });
  });

  $('stagePrev').onclick = () => state.game.changeStage(-1);
  $('stageNext').onclick = () => state.game.changeStage(1);
  $('noteBtn').onclick = () => {
    const n = state.game.playNextNote();
    if (n) toast('🎵 ' + K.noteName(n.midi), 1200);
  };
  $('pauseBtn').onclick = () => { const p = state.game.togglePause(); $('pauseBtn').textContent = p ? 'Continuar' : 'Pausar'; };
  $('quitBtn').onclick = () => {
    const g = state.game;
    if (g.practice) { g.finish(); } else { g.stop(); show('setup'); }
  };
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.screen !== 'game') return;
    if (e.code === 'Space') { e.preventDefault(); $('pauseBtn').click(); }
    if (e.code === 'Escape') $('quitBtn').click();
    if (e.code === 'KeyN') $('noteBtn').click();
  });

  // ---------------- resultado ----------------
  function showResults(r) {
    const song = state.song, s = state.settings;
    if (r.practice && r.loops > 0 && r.lines.every((l) => l.acc === 0) && state.game.lastLoopResult) r = { ...state.game.lastLoopResult, practice: true, loops: r.loops };
    $('resStars').textContent = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
    $('resScore').textContent = r.score.toLocaleString('pt-BR') + ' pontos';
    $('resPct').textContent = Math.round(r.pct) + '%';
    $('resCombo').textContent = r.maxCombo;
    $('resTend').textContent = r.tendency == null ? '–' : Math.abs(r.tendency) < 8 ? 'no centro' : (r.tendency > 0 ? '+' : '') + Math.round(r.tendency) + '¢';

    let bestTxt = '';
    if (!r.practice) {
      const key = song.id + '#' + s.myVoice;
      const prev = K.Store.best(key);
      const isNew = K.Store.saveBest(key, { score: r.score, date: Date.now(), partner: s.partner, tolerance: s.tolerance });
      bestTxt = isNew ? '🏆 Novo recorde pra essa voz!' : `Recorde nessa voz: ${prev.score.toLocaleString('pt-BR')}`;
      K.Store.addHistory({ song: song.id, voice: s.myVoice, score: r.score, date: Date.now() });
    } else {
      bestTxt = `Treino de trecho${r.loops ? ` · ${r.loops + 1} repetições` : ''}`;
    }
    $('resBest').textContent = bestTxt;

    $('resTip').textContent = tipFor(r);
    if (state.recUrl) URL.revokeObjectURL(state.recUrl);
    state.recUrl = r.recording ? URL.createObjectURL(r.recording) : null;
    $('resRec').hidden = !r.recording;
    if (r.recording) {
      const au = $('resAudio');
      au.src = state.recUrl;
      // gravações do navegador vêm sem duração; isso força o cálculo para a barra funcionar
      au.onloadedmetadata = () => {
        if (au.duration === Infinity) {
          au.ontimeupdate = () => { au.ontimeupdate = null; au.currentTime = 0; };
          au.currentTime = 1e7;
        }
      };
      $('resDownload').href = state.recUrl;
      const ext = (r.recording.type.split('/')[1] || 'webm').split(';')[0];
      $('resDownload').download = `${song.title} - ${song.voices[s.myVoice].name}.${ext}`;
    }
    const worst = r.lines.slice().sort((a, b) => a.acc - b.acc);
    const worstIdx = new Set(worst.slice(0, 3).filter((l) => l.acc < 0.8).map((l) => l.idx));
    $('resLines').innerHTML = r.lines.map((l) => `
      <div class="line-item ${worstIdx.has(l.idx) ? 'weak' : ''}">
        <span class="time">${fmtTime(l.start)}</span>
        <span class="txt">${esc(l.text)}</span>
        <span class="bar"><i style="width:${Math.round(l.acc * 100)}%"></i></span>
        <span class="pct">${Math.round(l.acc * 100)}%</span>
        <button class="btn small" data-practice="${l.start}:${l.end}">praticar</button>
      </div>`).join('');
    $('swapBtn').hidden = state.song.voices.length < 2;
    show('results');
  }

  function tipFor(r) {
    const t = r.tendency;
    if (r.pct < 15) return 'Dica: confira se o microfone está captando (teste na tela de ajustes) e se você está de fone. Aumentar o "guia da minha voz" ajuda a aprender a melodia.';
    if (t != null && t > 20) return `Você tende a ficar um pouco acima (${Math.round(t)} cents) — comum quando a outra voz puxa pra cima. Pense em "apoiar" a nota por baixo.`;
    if (t != null && t < -20) return `Você tende a ficar um pouco abaixo (${Math.round(-t)} cents) — clássico em segunda voz. Tente pensar a nota "mais alta" e mais brilhante.`;
    if (r.pct >= 85) return 'Excelente! Tente trocar de voz, tirar o guia da sua voz ou subir a dificuldade.';
    return 'Pratique em repetição os trechos marcados abaixo; depois baixe o volume do guia para cantar só com a outra voz.';
  }

  $('againBtn').onclick = () => play(state.lastPractice);
  $('swapBtn').onclick = () => {
    const s = state.settings;
    const other = s.myVoice === 0 ? 1 : 0;
    s.myVoice = other;
    s.partner = 'voice:' + (other === 0 ? 1 : 0);
    saveSettings();
    syncSetupForm();
    toast('Agora você canta: ' + state.song.voices[s.myVoice].name);
    play(null);
  };

  renderLibrary();
  show('library');
})(globalThis.K = globalThis.K || {});
