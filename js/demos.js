// Músicas de demonstração (domínio público) com duas vozes escritas à mão.
// Notação compacta: "Nota/duração-em-tempos/sílaba", "_" vira espaço, "|" quebra a frase, "R/n" = pausa.
(function (K) {
  function seq(bpm, startBeat, text) {
    const beat = 60 / bpm;
    let b = startBeat, line = 0;
    const notes = [];
    for (const tok of text.trim().split(/\s+/)) {
      if (tok === '|') { line++; continue; }
      const [note, dur, syl = ''] = tok.split('/');
      const d = parseFloat(dur);
      if (note !== 'R') {
        notes.push({ t: b * beat, d: d * beat * 0.92, midi: K.parseNote(note), lyric: syl.replace(/_/g, ' '), line });
      }
      b += d;
    }
    return notes;
  }

  // Brilha, brilha, estrelinha — melodia + segunda voz uma terça acima
  const brilhaMel = (start) => `
    C4/1/Bri C4/1/lha,_ G4/1/bri G4/1/lha,_ A4/1/es A4/1/tre G4/1/li G4/1/nha |
    F4/1/Que F4/1/ro_ E4/1/ver_ E4/1/vo D4/1/cê_ D4/1/bri C4/2/lhar |`;
  const brilhaHar = `
    E4/1/Bri E4/1/lha,_ B4/1/bri B4/1/lha,_ C5/1/es C5/1/tre B4/1/li B4/1/nha |
    A4/1/Que A4/1/ro_ G4/1/ver_ G4/1/vo F4/1/cê_ F4/1/bri E4/2/lhar |`;
  const brilhaMid = `
    G4/1/Faz_ G4/1/de_ F4/1/con F4/1/ta_ E4/1/queé_ E4/1/só_ D4/1/mi D4/1/nha |
    G4/1/Só_ G4/1/pra_ F4/1/ti_ F4/1/i E4/1/rei_ E4/1/can D4/2/tar |`;
  const brilhaMidHar = `
    B4/1/Faz_ B4/1/de_ A4/1/con A4/1/ta_ G4/1/queé_ G4/1/só_ F4/1/mi F4/1/nha |
    B4/1/Só_ B4/1/pra_ A4/1/ti_ A4/1/i G4/1/rei_ G4/1/can F4/2/tar |`;

  const brilha = {
    id: 'demo-brilha',
    title: 'Brilha, brilha, estrelinha',
    artist: 'Tradicional (demo)',
    source: 'demo',
    bpm: 92,
    voices: [
      { name: 'Primeira voz (melodia)', notes: seq(92, 4, brilhaMel() + brilhaMid + brilhaMel()) },
      { name: 'Segunda voz (terça acima)', notes: seq(92, 4, brilhaHar + brilhaMidHar + brilhaHar) },
    ],
  };

  // Frère Jacques em cânone: a segunda voz entra 2 compassos depois, uma oitava abaixo
  const jacques = (oct) => {
    const o = (n) => n.replace(/(\d)$/, (d) => String(+d + oct));
    const verse = [
      `${o('C4')}/1/Frè ${o('D4')}/1/re_ ${o('E4')}/1/Jac ${o('C4')}/1/ques,_`,
      `${o('C4')}/1/Frè ${o('D4')}/1/re_ ${o('E4')}/1/Jac ${o('C4')}/1/ques |`,
      `${o('E4')}/1/Dor ${o('F4')}/1/mez ${o('G4')}/2/vous?_`,
      `${o('E4')}/1/Dor ${o('F4')}/1/mez ${o('G4')}/2/vous? |`,
      `${o('G4')}/0.5/Son ${o('A4')}/0.5/nez_ ${o('G4')}/0.5/les_ ${o('F4')}/0.5/ma ${o('E4')}/1/ti ${o('C4')}/1/nes,_`,
      `${o('G4')}/0.5/Son ${o('A4')}/0.5/nez_ ${o('G4')}/0.5/les_ ${o('F4')}/0.5/ma ${o('E4')}/1/ti ${o('C4')}/1/nes |`,
      `${o('C4')}/1/Ding,_ ${o('G3')}/1/dang,_ ${o('C4')}/2/dong,_`,
      `${o('C4')}/1/ding,_ ${o('G3')}/1/dang,_ ${o('C4')}/2/dong |`,
    ].join(' ');
    return verse + ' ' + verse;
  };

  const frere = {
    id: 'demo-frere',
    title: 'Frère Jacques (cânone)',
    artist: 'Tradicional (demo)',
    source: 'demo',
    bpm: 100,
    voices: [
      { name: 'Voz aguda (começa)', notes: seq(100, 4, jacques(0)) },
      { name: 'Voz grave (entra depois)', notes: seq(100, 12, jacques(-1)) },
    ],
  };

  K.DEMOS = [brilha, frere];
})(globalThis.K = globalThis.K || {});
