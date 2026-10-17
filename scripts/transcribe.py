"""Bounded, offline CPU/int8 faster-whisper worker. No model downloads."""

import argparse
import io
import json
import math
import os
from pathlib import Path
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

SAMPLE_RATE = 16000
MAX_SECONDS = 1800
MAX_JSON_BYTES = 16 * 1024 * 1024
DETAIL = (
    "Offline faster-whisper on CPU int8. The default tiny model is low quality; "
    "recognition and word timing can be inaccurate. Review captions and cut proposals. "
    "Repeated speech is retained; semantic duplicate removal is not automatic."
)


def load_model(model_path):
    directory = Path(model_path)
    if not directory.is_dir():
        raise ValueError(f"Local model directory does not exist: {directory}")
    for name in ("model.bin", "config.json", "tokenizer.json"):
        if not (directory / name).is_file():
            raise ValueError(f"Local model is incomplete: missing {name} in {directory}")
    from faster_whisper import WhisperModel

    return WhisperModel(
        str(directory), device="cpu", compute_type="int8",
        cpu_threads=2, num_workers=1, local_files_only=True,
    )


def vad_support():
    try:
        from faster_whisper.vad import get_vad_model

        get_vad_model()
        return True, "Local Silero VAD enabled."
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        return False, f"VAD unavailable; transcribing without VAD: {error}"


def decode_bounded(path):
    import av
    import numpy as np

    if not path.is_file() or not 0 < path.stat().st_size <= 2 * 1024 ** 3:
        raise ValueError("Input must be a nonempty local file of at most 2 GiB")
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    buffer = io.BytesIO()
    samples = 0

    def append(frames):
        nonlocal samples
        for frame in frames:
            samples += frame.samples
            if samples > MAX_SECONDS * SAMPLE_RATE:
                raise ValueError(f"Audio exceeds the {MAX_SECONDS}-second transcription limit")
            buffer.write(frame.to_ndarray().tobytes())

    with av.open(str(path), mode="r", metadata_errors="ignore") as container:
        if not container.streams.audio:
            raise ValueError("Input has no audio stream")
        stream = container.streams.audio[0]
        stream.codec_context.thread_count = 2
        if stream.duration is not None and stream.time_base is not None:
            if float(stream.duration * stream.time_base) > MAX_SECONDS:
                raise ValueError(f"Audio exceeds the {MAX_SECONDS}-second transcription limit")
        for frame in container.decode(stream):
            frame.pts = None
            append(resampler.resample(frame))
        append(resampler.resample(None))
    if not samples:
        raise ValueError("Input has no decodable audio samples")
    return np.frombuffer(buffer.getbuffer(), dtype=np.int16).astype(np.float32) / 32768.0


def timestamp(seconds):
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError("Invalid caption timestamp")
    total = int(math.floor(seconds * 1000 + 0.5))
    hours, remainder = divmod(total, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def render_srt(segments):
    cues = []
    for segment in segments:
        # Embedded blank lines must not accidentally terminate a caption cue.
        text = " ".join(segment["text"].split())
        if not text:
            continue
        start = timestamp(segment["start"])
        end = timestamp(max(segment["end"], segment["start"] + 0.001))
        cues.append(f'{len(cues) + 1}\n{start} --> {end}\n{text}\n')
    return "\n".join(cues)


def transcribe(args, model):
    audio = decode_bounded(Path(args.input))
    vad, vad_detail = vad_support()
    iterator, info = model.transcribe(
        audio, language=args.language, word_timestamps=True, vad_filter=vad,
        beam_size=5, condition_on_previous_text=False,
    )
    segments = []
    word_count = 0
    for segment in iterator:
        text = segment.text.strip()
        if not text:
            continue
        start, end = float(segment.start), float(segment.end)
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError("ASR returned invalid segment timestamps")
        words = []
        for word in segment.words or []:
            word_start, word_end = float(word.start), float(word.end)
            probability = float(word.probability)
            if (not all(math.isfinite(x) for x in (word_start, word_end, probability))
                    or word_start < start - 0.001 or word_end > end + 0.001
                    or word_end < word_start or not 0 <= probability <= 1):
                raise ValueError("ASR returned invalid word timestamps or probability")
            words.append({
                "start": word_start, "end": word_end,
                "word": word.word, "probability": probability,
            })
        word_count += len(words)
        if len(segments) >= 100000 or word_count > 500000:
            raise ValueError("ASR exceeded its segment/word output limit")
        segments.append({"start": start, "end": end, "text": text, "words": words})
    result = {
        "segments": segments, "language": info.language, "modelPath": args.model_path,
        "detail": DETAIL, "vad": vad, "vadDetail": vad_detail,
    }
    serialized = json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(serialized) > MAX_JSON_BYTES:
        raise ValueError("Transcript exceeds the 16 MiB output limit")
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    (output / "transcript.json").write_bytes(serialized)
    (output / "transcript.srt").write_text(render_srt(segments), encoding="utf-8")
    print(json.dumps({"ok": True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--capabilities", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output-dir")
    parser.add_argument("--language")
    args = parser.parse_args()
    try:
        model = load_model(args.model_path)
        if args.capabilities:
            _, detail = vad_support()
            print(json.dumps({"available": True, "detail": f"{DETAIL} {detail}"}))
            return 0
        if not args.input or not args.output_dir:
            raise ValueError("--input and --output-dir are required for transcription")
        transcribe(args, model)
        return 0
    except Exception as error:
        if args.capabilities:
            print(json.dumps({"available": False, "detail": f"{type(error).__name__}: {error}"}))
            return 0
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
