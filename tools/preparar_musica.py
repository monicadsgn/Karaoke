#!/usr/bin/env python3
"""Prepara uma música de verdade para o Karaokê de Harmonia.

Etapas:
  1. separa voz e instrumental (modelo UVR MDX-Net, via audio-separator)
  2. extrai a melodia da voz (CREPE; pYIN se o torchcrepe não estiver instalado) e transforma em notas
  3. divide a voz em trechos curtos e dá um primeiro chute de quem canta (voz aguda x grave).
     O chute é só um ponto de partida: no app, a pessoa marca quem canta ouvindo a música.
  4. transcreve a letra de cada trecho (Whisper via sherpa-onnx), se o modelo estiver disponível
  5. gera um arquivo único  <nome>.karaoke  (JSON com os áudios embutidos) para importar no app

Uso:
  python tools/preparar_musica.py musica.mp3 --titulo "Beauty and the Beast" --artista "Celine Dion & Peabo Bryson" \
      --cantores "Celine,Peabo" [--saida pasta/]

Dependências: pip install -r tools/requirements.txt  (e ffmpeg no PATH)
Letra (opcional): baixe e descompacte em --modelos o modelo
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

MODEL = "UVR-MDX-NET-Voc_FT.onnx"
HOP = 0.01  # 10 ms por quadro de análise


def log(*a):
    print("·", *a, file=sys.stderr, flush=True)


def separate(src, workdir, model_dir):
    from audio_separator.separator import Separator

    sep = Separator(output_dir=workdir, model_file_dir=model_dir, output_format="WAV")
    sep.load_model(model_filename=MODEL)
    outs = sep.separate(src)
    paths = [o if os.path.isabs(o) else os.path.join(workdir, o) for o in outs]
    voc = next(p for p in paths if "(Vocals)" in p)
    inst = next(p for p in paths if "(Instrumental)" in p)
    return voc, inst


def track_pitch(vocals_path, method="auto", cache=None):
    """Curva de altura (MIDI por quadro de 10 ms; NaN = sem voz).
    CREPE erra bem menos a oitava que o pYIN em voz cantada (testado em dueto real)."""
    import librosa

    sr = 16000
    y, _ = librosa.load(vocals_path, sr=sr, mono=True)
    hop = int(sr * HOP)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
    loud = rms > max(0.01, np.percentile(rms, 60) * 0.25)

    if method == "auto":
        try:
            import torchcrepe  # noqa: F401
            method = "crepe"
        except ImportError:
            method = "pyin"

    if cache and os.path.exists(cache):
        z = np.load(cache)
        f0, voiced = z["f0"], z["voiced"]
    elif method == "crepe":
        import torch
        import torchcrepe

        torch.set_num_threads(os.cpu_count() or 4)
        f0, per = torchcrepe.predict(
            torch.tensor(y[None, :]), sr, hop_length=hop, fmin=65, fmax=1100, model="full",
            decoder=torchcrepe.decode.viterbi, return_periodicity=True, batch_size=1024, device="cpu",
        )
        f0, per = f0.numpy()[0], per.numpy()[0]
        voiced = per > 0.5
    else:
        f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1100, sr=sr, frame_length=1024, hop_length=hop, fill_na=np.nan)
    if cache and not os.path.exists(cache):
        np.savez(cache, f0=f0, voiced=voiced)

    n = min(len(f0), len(rms))
    f0, voiced, rms, loud = f0[:n], voiced[:n], rms[:n], loud[:n]
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69 + 12 * np.log2(f0 / 440.0)
    ok = voiced & loud & np.isfinite(midi)
    midi = np.where(ok, midi, np.nan)
    return midi, rms, len(y) / sr


def median_filter_nan(x, k=5):
    out = x.copy()
    h = k // 2
    for i in range(len(x)):
        w = x[max(0, i - h): i + h + 1]
        w = w[np.isfinite(w)]
        out[i] = np.median(w) if np.isfinite(x[i]) and len(w) else np.nan
    return out


def energy_dips(rms):
    """Quadros onde a energia afunda (consoante / nova sílaba na mesma nota)."""
    dips = np.zeros(len(rms), dtype=bool)
    for i in range(3, len(rms) - 3):
        w = rms[max(0, i - 12): i + 13]
        if rms[i] <= rms[i - 1] and rms[i] <= rms[i + 1] and rms[i] < 0.55 * min(w[: len(w) // 2].max(), w[len(w) // 2:].max()):
            dips[i] = True
    return dips


def segment_notes(midi, rms=None):
    """Quebra a curva de altura em notas (início, duração, nota MIDI inteira)."""
    dips = energy_dips(rms) if rms is not None else np.zeros(len(midi), dtype=bool)
    notes = []
    i, n = 0, len(midi)
    while i < n:
        if not np.isfinite(midi[i]):
            i += 1
            continue
        start = i
        vals = [midi[i]]
        i += 1
        drift = 0
        while i < n and np.isfinite(midi[i]):
            if dips[i] and i - start >= 8:
                break
            ref = np.median(vals[-15:])
            if abs(midi[i] - ref) > 0.75:
                drift += 1
                if drift >= 4:  # mudou de nota de verdade (40 ms)
                    i -= drift - 1
                    break
            else:
                drift = 0
            vals.append(midi[i])
            i += 1
        dur = (i - start) * HOP
        if dur >= 0.09:
            core = np.array(vals[len(vals) // 5: len(vals) - len(vals) // 5 or None])
            notes.append({"t": round(start * HOP, 3), "d": round(dur, 3), "midi": int(round(np.median(core if len(core) else vals)))})
    # junta notas iguais separadas por buracos minúsculos
    merged = []
    for nt in notes:
        if merged and merged[-1]["midi"] == nt["midi"] and nt["t"] - (merged[-1]["t"] + merged[-1]["d"]) < 0.02 and nt["d"] < 0.12:
            merged[-1]["d"] = round(nt["t"] + nt["d"] - merged[-1]["t"], 3)
        else:
            merged.append(nt)
    return merged


def split_long(a, b, active, max_len=6.0):
    """Divide um trecho longo na maior pausa interna (os cantores costumam trocar nas pausas)."""
    if (b - a) * HOP <= max_len:
        return [(a, b)]
    best, best_len, i = None, 0, a + 50
    while i < b - 50:  # não corta a menos de 0,5 s das pontas
        if not active[i]:
            j = i
            while j < b and not active[j]:
                j += 1
            if j - i > best_len:
                best, best_len = (i, j), j - i
            i = j
        else:
            i += 1
    if not best or best_len < 5:
        return [(a, b)]
    return split_long(a, best[0], active, max_len) + split_long(best[1], b, active, max_len)


def find_phrases(midi, rms, notes):
    """Trechos = voz separada por pausas >= 0,25 s; trechos com mais de 6 s são divididos."""
    active = np.isfinite(midi)
    spans, i, n = [], 0, len(active)
    while i < n:
        if not active[i]:
            i += 1
            continue
        s = i
        gap = 0
        while i < n and gap < 25:
            gap = 0 if active[i] else gap + 1
            i += 1
        spans.extend(split_long(s, i - gap, active))
    phrases = [
        {"t0": round(a * HOP, 2), "t1": round(b * HOP, 2)} for a, b in spans if (b - a) * HOP >= 0.3
    ]
    # altura mediana de cada frase -> chute de cantor (2 grupos: agudo/grave)
    meds = []
    for p in phrases:
        seg = midi[int(p["t0"] / HOP): int(p["t1"] / HOP)]
        seg = seg[np.isfinite(seg)]
        meds.append(float(np.median(seg)) if len(seg) else np.nan)
    meds = np.array(meds)
    good = meds[np.isfinite(meds)]
    who = ["A"] * len(phrases)
    if len(good) >= 4:
        lo, hi = np.percentile(good, 20), np.percentile(good, 80)
        for _ in range(20):  # 2-means simples
            mid = (lo + hi) / 2
            a, b = good[good >= mid], good[good < mid]
            if not len(a) or not len(b):
                break
            hi, lo = a.mean(), b.mean()
        if hi - lo >= 3.5:
            mid = (lo + hi) / 2
            who = ["A" if (not np.isfinite(m) or m >= mid) else "B" for m in meds]
    for p, w, m in zip(phrases, who, meds):
        p["who"] = w
        p["pitch"] = round(float(m), 1) if np.isfinite(m) else None
        p["lyric"] = ""
    return phrases


def fix_octaves(notes, phrases):
    """Corrige erros de oitava da leitura: cada cantor tem uma região típica;
    trechos e notas muito fora dela são puxados uma oitava pra cima/baixo."""
    def phrase_of(n):
        mid = n["t"] + n["d"] / 2
        for i, p in enumerate(phrases):
            if p["t0"] - 0.2 <= mid <= p["t1"] + 0.2:
                return i
        return None

    groups = {}
    for n in notes:
        i = phrase_of(n)
        if i is not None:
            groups.setdefault(i, []).append(n)
    for who in ("A", "B"):
        meds = [np.median([n["midi"] for n in groups[i]]) for i, p in enumerate(phrases) if p["who"] == who and i in groups]
        if not meds:
            continue
        center = float(np.median(meds))
        for i, p in enumerate(phrases):
            if p["who"] != who or i not in groups:
                continue
            ns = groups[i]
            med = float(np.median([n["midi"] for n in ns]))
            shift = 12 * round((center - med) / 12) if abs(center - med) > 7 else 0
            for n in ns:
                n["midi"] += shift
            med += shift
            for n in ns:  # notas soltas fora do trecho
                if abs(n["midi"] - med) > 9:
                    n["midi"] += 12 * round((med - n["midi"]) / 12)
            p["pitch"] = round(float(np.median([n["midi"] for n in ns])), 1)
    return notes, phrases


def transcribe(vocals_path, phrases, model_dir):
    """Letra de cada trecho com Whisper (sherpa-onnx). Sem o modelo, a letra fica vazia."""
    d = os.path.join(model_dir, "sherpa-onnx-whisper-small.en")
    try:
        import sherpa_onnx
        import librosa
    except ImportError:
        log("sherpa-onnx não instalado: sem letra automática")
        return
    if not os.path.isdir(d):
        log("modelo Whisper não encontrado em", d, ": sem letra automática")
        return
    rec = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=os.path.join(d, "small.en-encoder.int8.onnx"),
        decoder=os.path.join(d, "small.en-decoder.int8.onnx"),
        tokens=os.path.join(d, "small.en-tokens.txt"),
        num_threads=os.cpu_count() or 4,
    )
    y, sr = librosa.load(vocals_path, sr=16000, mono=True)
    for p in phrases:
        seg = y[max(0, int((p["t0"] - 0.15) * sr)): int((p["t1"] + 0.25) * sr)]
        st = rec.create_stream()
        st.accept_waveform(sr, seg)
        rec.decode_stream(st)
        text = st.result.text.strip()
        # Whisper às vezes "inventa" em trechos só de vocalise
        p["lyric"] = "" if text.startswith("[") or text.startswith("(") else text


def contour(midi, step=0.02):
    k = int(step / HOP)
    out = []
    for i in range(0, len(midi), k):
        w = midi[i: i + k]
        w = w[np.isfinite(w)]
        out.append(round(float(np.median(w)), 1) if len(w) else 0)
    return {"step": step, "data": out}


def encode_mp3(wav, bitrate="160k"):
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        out = f.name
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ac", "2", "-ar", "44100", "-b:a", bitrate, out], check=True)
    with open(out, "rb") as fh:
        data = fh.read()
    os.unlink(out)
    return base64.b64encode(data).decode("ascii")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio")
    ap.add_argument("--titulo")
    ap.add_argument("--artista", default="")
    ap.add_argument("--cantores", default="Voz aguda,Voz grave", help='nomes "aguda,grave", ex.: "Celine,Peabo"')
    ap.add_argument("--saida", default=".")
    ap.add_argument("--modelos", default=os.path.expanduser("~/.cache/karaoke-models"))
    ap.add_argument("--stems", nargs=2, metavar=("VOZ.wav", "INSTRUMENTAL.wav"), help="reaproveita uma separação já feita")
    ap.add_argument("--cache-altura", help="arquivo .npz para guardar/reaproveitar a curva de altura")
    ap.add_argument("--altura", choices=["auto", "crepe", "pyin"], default="auto")
    args = ap.parse_args()

    title = args.titulo or os.path.splitext(os.path.basename(args.audio))[0]
    work = tempfile.mkdtemp(prefix="karaoke-")
    if args.stems:
        voc, inst = args.stems
    else:
        log("separando voz e instrumental (demora ~1-2x a duração da música)...")
        voc, inst = separate(os.path.abspath(args.audio), work, args.modelos)
    log("extraindo a melodia da voz (alguns minutos)...")
    midi, rms, duration = track_pitch(voc, args.altura, args.cache_altura)
    midi = median_filter_nan(midi)
    notes = segment_notes(midi, rms)
    phrases = find_phrases(midi, rms, notes)
    notes, phrases = fix_octaves(notes, phrases)
    for p in phrases:
        p["guess"] = True  # quem canta ainda é um chute; o app pede para confirmar ouvindo
    log("transcrevendo a letra...")
    transcribe(voc, phrases, args.modelos)
    names = [s.strip() for s in args.cantores.split(",")] + ["Voz grave"]
    log(f"{len(notes)} notas, {len(phrases)} trechos, "
        f"{sum(p['who'] == 'A' for p in phrases)} de {names[0]} / {sum(p['who'] == 'B' for p in phrases)} de {names[1]}")
    log("compactando áudios...")
    song = {
        "format": "karaoke-harmonia/1",
        "type": "stems",
        "title": title,
        "artist": args.artista,
        "duration": round(duration, 2),
        "singers": {"A": names[0], "B": names[1]},
        "phrases": phrases,
        "notes": notes,
        "contour": contour(midi),
        "audio": {"instrumental": encode_mp3(inst, "192k"), "vocals": encode_mp3(voc, "160k"), "mime": "audio/mpeg"},
    }
    os.makedirs(args.saida, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in title).strip() or "musica"
    out = os.path.join(args.saida, safe + ".karaoke")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(song, fh, ensure_ascii=False, separators=(",", ":"))
    log("pronto:", out, f"({os.path.getsize(out) / 1e6:.1f} MB)")
    print(out)


if __name__ == "__main__":
    main()
