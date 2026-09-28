// Sintetizador simples com agendamento antecipado (lookahead) para tocar a outra voz,
// a sua voz-guia e o acompanhamento do MIDI.
(function (K) {
  const TIMBRES = {
    // "voz": triângulo + seno uma oitava acima, com vibrato suave
    partner: { waves: [['triangle', 1, 0.8], ['sine', 2, 0.18]], attack: 0.04, release: 0.1, vibrato: 14, gain: 0.35 },
    guide: { waves: [['sine', 1, 1]], attack: 0.03, release: 0.08, vibrato: 0, gain: 0.22 },
    accomp: { waves: [['triangle', 1, 0.7], ['sine', 2, 0.2]], attack: 0.01, release: 0.25, decay: 0.8, vibrato: 0, gain: 0.07 },
  };

  class Scheduler {
    constructor(ctx) {
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.buses = {};
      for (const k of Object.keys(TIMBRES)) {
        const g = ctx.createGain();
        g.connect(this.master);
        this.buses[k] = g;
      }
      this.tracks = [];
      this.active = new Set();
    }

    setVolume(bus, v) { this.buses[bus].gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }

    // events: [{t, d, midi, vel?}] ordenados por t
    setTracks(tracks) { this.tracks = tracks.map((tr) => ({ ...tr, idx: 0 })); }

    // Posiciona os ponteiros no tempo da música
    seek(songTime) {
      this.stopAll();
      for (const tr of this.tracks) {
        let i = 0;
        while (i < tr.events.length && tr.events[i].t < songTime - 0.01) i++;
        tr.idx = i;
      }
    }

    // Agenda o que cair na janela [songTime, songTime + ahead]
    // toCtx(songT) converte tempo da música para tempo do AudioContext.
    pump(songTime, rate, toCtx, ahead = 0.3) {
      const horizon = songTime + ahead * rate;
      for (const tr of this.tracks) {
        while (tr.idx < tr.events.length && tr.events[tr.idx].t < horizon) {
          const ev = tr.events[tr.idx++];
          if (ev.t + ev.d < songTime) continue;
          const start = Math.max(this.ctx.currentTime, toCtx(ev.t));
          const dur = (ev.t + ev.d - Math.max(ev.t, songTime)) / rate;
          this.playNote(tr.bus, ev.midi + (tr.transpose || 0), start, dur, ev.vel ?? 1);
        }
      }
    }

    playNote(bus, midi, start, dur, vel = 1) {
      const tb = TIMBRES[bus];
      const ctx = this.ctx;
      const f = K.midiToFreq(midi);
      const env = ctx.createGain();
      const peak = tb.gain * vel;
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(peak, start + tb.attack);
      const end = start + Math.max(dur, tb.attack + 0.02);
      if (tb.decay) env.gain.setTargetAtTime(peak * 0.25, start + tb.attack, tb.decay / 3);
      env.gain.setValueAtTime(tb.decay ? peak * 0.25 : peak, end);
      env.gain.linearRampToValueAtTime(0, end + tb.release);
      env.connect(this.buses[bus]);

      const oscs = [];
      let lfo = null;
      if (tb.vibrato) {
        lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = 5.3;
        lfoGain.gain.setValueAtTime(0, start);
        lfoGain.gain.linearRampToValueAtTime(tb.vibrato, start + Math.min(0.35, dur));
        lfo.connect(lfoGain);
        lfo._g = lfoGain;
      }
      for (const [type, mult, g] of tb.waves) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * mult;
        if (lfo) lfo._g.connect(o.detune);
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(env);
        o.start(start);
        o.stop(end + tb.release + 0.05);
        oscs.push(o);
      }
      if (lfo) { lfo.start(start); lfo.stop(end + tb.release + 0.05); oscs.push(lfo); }
      const handle = { oscs, env };
      this.active.add(handle);
      oscs[0].onended = () => { this.active.delete(handle); env.disconnect(); };
    }

    stopAll() {
      const now = this.ctx.currentTime;
      for (const h of this.active) {
        try {
          h.env.gain.cancelScheduledValues(now);
          h.env.gain.setTargetAtTime(0, now, 0.02);
          for (const o of h.oscs) o.stop(now + 0.1);
        } catch (e) { /* nota já terminou */ }
      }
      this.active.clear();
    }
  }

  K.Scheduler = Scheduler;
})(globalThis.K = globalThis.K || {});
