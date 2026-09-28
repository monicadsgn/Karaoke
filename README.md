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

## Microfone e caixa de som

O app precisa **ouvir a sua voz** para saber se você está no tom. Na tela da música:

- **Entrada**: escolha qual microfone o app usa.
- **Anti-eco**: deixe desligado. No celular ele coloca o som em "modo ligação"; só ligue se o app confundir sua voz com a música.
- **Calibrar atraso**: caixas Bluetooth atrasam o som. Toque em "Calibrar", diga "tá" junto com os 8 bipes e o app
  mede o atraso total (caixa + microfone) sozinho.

## Músicas de verdade (ex.: um dueto)

Para cantar com a gravação original — por exemplo, você faz a parte da cantora e o cantor continua cantando a dele:

1. Prepare a música a partir do MP3 (separa voz e instrumental, extrai as notas e divide em trechos):

   ```bash
   pip install -r tools/requirements.txt      # precisa também do ffmpeg
   python tools/preparar_musica.py musica.mp3 --titulo "Nome" --artista "Artistas" --cantores "Ela,Ele"
   ```

   Isso gera um arquivo `Nome.karaoke` (demora ~2× a duração da música). O Claude também pode preparar para você.
2. No app, **Importar música preparada (.karaoke)**.
3. Marque **quem canta cada trecho**: toque em **🎧 Marcar ouvindo** e, ouvindo a música uma vez, toque no nome de
   quem está cantando sempre que a voz mudar. (O app só dá um chute inicial pela altura da voz.)
   A letra vem transcrita automaticamente da gravação; dá pra corrigir cada trecho na lista.
4. Escolha a sua voz: nos seus trechos a voz original some (ou fica baixinha como guia); nos do outro cantor, ela toca.

## Treino por etapas e gravação

- **Praticar um trecho** abre o treino em etapas: 1) ouvir a sua parte → 2) cantar com o guia → 3) guia baixinho →
  4) sem guia → 5) sem ver as notas. Você sobe de etapa quando acerta 75% do trecho (ou usa ◀ ▶).
- Quando você canta a música inteira, o app **grava você junto com a música**. No resultado dá para ouvir e baixar.

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
js/stems.js       músicas gravadas: trechos, tom/velocidade (SoundTouch), player
js/vendor/        SoundTouchJS (LGPL-2.1)
tools/            preparar_musica.py: MP3 -> arquivo .karaoke
js/game.js        relógio, pontuação e desenho da trilha
js/app.js         interface
tests/run.js      testes (node tests/run.js)
```
