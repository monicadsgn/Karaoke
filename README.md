# 🎤 Karaokê de Harmonia

Um karaokê feito para quem gosta de **cantar harmonizando**. Você escolhe se é a **primeira** ou a **segunda voz**,
o app canta a outra parte com você, e o microfone mostra em tempo real se você está no tom.

## Como abrir

É só um site estático, sem instalação:

```bash
npx http-server -p 8080      # ou: python3 -m http.server 8080
```

Depois abra `http://localhost:8080` no Chrome, Edge ou Firefox e permita o microfone.
(Também dá pra publicar grátis na Vercel, Netlify ou GitHub Pages.)

> **Use fone de ouvido.** Sem fone, o microfone escuta a outra voz saindo da caixa de som e confunde a detecção da sua nota.

## Como funciona o jogo

- **Trilha de notas**: as barras rosa são a sua parte, as verdes são a outra voz; a linha amarela é a sua voz.
  O trecho da nota fica verde quando você está afinado(a).
- **Afinador**: mostra a nota alvo, a nota que você está cantando e quantos *cents* está acima/abaixo.
- **Harmonia**: mostra o intervalo que você deveria formar com a outra voz (ex.: "3ª maior") e o que você está formando.
- **Pontuação** até 10.000, combo, estrelas, recorde por música e por voz.
- **Resultado trecho a trecho**: os trechos mais fracos ficam marcados e dá pra **praticar em loop**.
- **Tendência**: diz se você costuma ficar acima ou abaixo da nota (muito comum na segunda voz).

## Ajustes pra deixar do seu jeito

| Ajuste | Pra quê |
|---|---|
| Qual voz você canta | Primeira, segunda — e o botão **Trocar de voz ⇄** no resultado |
| Quem canta com você | A outra voz da música, uma **harmonia automática** (terça acima/abaixo, sexta, quinta) ou ninguém |
| Tom (± semitons) | Levar a música pra sua extensão vocal |
| Velocidade | Treinar devagar (50%–125%) |
| Dificuldade | Tolerância de afinação: fácil ±70¢, médio ±45¢, difícil ±25¢ |
| Qualquer oitava | Cantar a parte masculina com voz feminina (e vice-versa) sem perder ponto |
| Guia da minha voz | Toca a sua parte baixinho enquanto você aprende |
| Áudio da música | Carregue o MP3 (instrumental ou original) e ajuste a sincronia |
| Atraso do microfone | Compensa a latência do seu microfone/placa de som |

## Colocando as músicas que você gosta

1. **UltraStar (.txt)** — formato de karaokê "estilo SingStar", com muitos arquivos feitos pela comunidade.
   Os **duetos** (com `P1`/`P2`) já trazem as duas vozes separadas. Depois de importar, adicione o MP3 na tela da música.
2. **MIDI / KAR** — escolha qual faixa é a primeira voz e qual é a segunda (dá pra ouvir cada faixa antes).
   As demais faixas viram acompanhamento e a letra do `.kar` é importada.
3. **Música com uma voz só** — o app detecta a tonalidade e gera uma segunda voz automática.

As músicas importadas, o áudio e os recordes ficam salvos no seu navegador.

## Estrutura

```
index.html        telas
css/style.css     visual (claro/escuro, funciona no celular)
js/music.js       notas, intervalos, tonalidade, harmonia automática
js/pitch.js       detecção de altura da voz (algoritmo YIN)
js/parsers.js     importação UltraStar e MIDI/KAR
js/demos.js       músicas de demonstração (domínio público)
js/synth.js       sintetizador da outra voz / guia / acompanhamento
js/game.js        relógio, pontuação e desenho da trilha
js/app.js         interface
tests/run.js      testes (node tests/run.js)
```
