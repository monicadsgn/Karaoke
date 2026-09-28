// Detecção de altura (pitch) da voz com o algoritmo YIN.
(function (K) {
  // Retorna { freq, clarity, rms } ou null se não houver voz clara.
  function detectPitch(buf, sampleRate, opts = {}) {
    const minFreq = opts.minFreq || 65;     // ~Dó2
    const maxFreq = opts.maxFreq || 1100;   // ~Dó#6
    const threshold = opts.threshold || 0.15;
    const minRms = opts.minRms ?? 0.01;

    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < minRms) return null;

    const half = Math.floor(buf.length / 2);
    const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    const tauMax = Math.min(half - 1, Math.floor(sampleRate / minFreq));
    const d = K._yinBuf && K._yinBuf.length === tauMax + 1 ? K._yinBuf : (K._yinBuf = new Float32Array(tauMax + 1));

    // função diferença
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const delta = buf[i] - buf[i + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }
    // diferença média normalizada cumulativa
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      d[tau] = running ? (d[tau] * tau) / running : 1;
    }
    // primeiro mínimo abaixo do limiar
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau === -1) return null;

    // interpolação parabólica para precisão sub-amostra
    let better = tau;
    if (tau > 1 && tau < tauMax) {
      const s0 = d[tau - 1], s1 = d[tau], s2 = d[tau + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom) better = tau + (s2 - s0) / denom;
    }
    return { freq: sampleRate / better, clarity: 1 - d[tau], rms };
  }

  // Suaviza leituras: mediana das últimas N e descarta saltos isolados
  class PitchSmoother {
    constructor(size = 5) { this.size = size; this.hist = []; }
    push(midi) {
      if (midi == null) { this.hist.push(null); } else { this.hist.push(midi); }
      if (this.hist.length > this.size) this.hist.shift();
      const vals = this.hist.filter((v) => v != null);
      if (midi == null || vals.length < Math.ceil(this.size / 2)) return midi == null ? null : midi;
      vals.sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)];
    }
    reset() { this.hist = []; }
  }

  Object.assign(K, { detectPitch, PitchSmoother });
})(globalThis.K = globalThis.K || {});
