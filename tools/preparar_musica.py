#!/usr/bin/env python3
"""Prepara uma música de verdade para o Karaokê de Harmonia.

Etapas:
  1. separa voz e instrumental (modelo UVR MDX-Net, via audio-separator)
  2. extrai a melodia da voz (pYIN) e transforma em notas
  3. divide a voz em trechos (frases) e chuta quem canta cada um (voz aguda x grave)
  4. gera um arquivo único  <nome>.karaoke  (JSON com os áudios embutidos) para importar no app

Uso:
  python tools/preparar_musica.py musica.mp3 --titulo "Beauty and the Beast" --artista "Celine Dion & Peabo Bryson" \
      --cantores "Celine,Peabo" [--saida pasta/]

Dependências: pip install "audio-separator[cpu]" librosa soundfile  (e ffmpeg no PATH)
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


def track_pitch(vocals_path):
    import librosa

    sr = 16000
    y, _ = librosa.load(vocals_path, sr=sr, mono=True)
    hop = int(sr * HOP)
    f0, voiced, prob = librosa.pyin(
        y, fmin=65, fmax=1100, sr=sr, frame_length=1024, hop_length=hop, fill_na=np.nan
    )
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0][: len(f0)]
    midi = 69 + 12 * np.log2(f0 / 440.0)
    loud = rms > max(0.01, np.percentile(rms, 60) * 0.25)
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


def find_phrases(midi, rms, notes):
    """Frases = trechos com voz separados por pausas >= 0.4 s."""
    active = np.isfinite(midi)
    spans, i, n = [], 0, len(active)
    while i < n:
        if not active[i]:
            i += 1
            continue
        s = i
        gap = 0
        while i < n and gap < 40:
            gap = 0 if active[i] else gap + 1
            i += 1
        spans.append([s * HOP, (i - gap) * HOP])
    phrases = [
        {"t0": round(a, 2), "t1": round(b, 2)} for a, b in spans if b - a >= 0.4
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
    args = ap.parse_args()

    title = args.titulo or os.path.splitext(os.path.basename(args.audio))[0]
    work = tempfile.mkdtemp(prefix="karaoke-")
    log("separando voz e instrumental (demora ~2x a duração da música)...")
    voc, inst = separate(os.path.abspath(args.audio), work, args.modelos)
    log("extraindo a melodia da voz...")
    midi, rms, duration = track_pitch(voc)
    midi = median_filter_nan(midi)
    notes = segment_notes(midi, rms)
    phrases = find_phrases(midi, rms, notes)
    notes, phrases = fix_octaves(notes, phrases)
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
