#!/usr/bin/env python
"""cascade bench - measure TIME TO FIRST AUDIO for a fully local voice loop.

This is a DEV TOOL. It imports nothing from apps/ and nothing in apps/ imports
it. It answers exactly one question, with numbers rather than argument:

    the student stops speaking. How long until they hear the first syllable
    of the reply, with STT, an LLM and TTS all running on this machine?

WHY THIS IS NOT THE SUM OF THREE BENCHMARKS. Each stage has a fixed cost and a
per-unit cost, and a naive benchmark measures the wrong unit for all three:

  STT   is CHUNKED. At the moment speech stops, everything before the last
        chunk has already been transcribed. Only the TAIL is on the critical
        path - transcribing the whole utterance measures a batch job.
  LLM   only has to produce the first SPEAKABLE CLAUSE, not the whole answer.
        Time-to-first-token is not enough (you cannot speak one token) and
        time-to-full-reply is far too much.
  TTS   only has to emit its first CHUNK. A sentence-at-a-time engine that
        returns 3 s of audio in 90 ms has a 90 ms first-audio latency, not a
        3 s one - but only if the caller streams it.

So every stage here is measured at the boundary the NEXT stage actually waits
on, which is the only definition under which the total means anything.

    python bench.py                     # full cascade, default models
    python bench.py --llm llama3.1:8b   # a different worker
    python bench.py --tail 0.8          # a longer STT tail
    python bench.py --stage tts         # one stage only

Everything runs on 127.0.0.1. Never `localhost`: on Windows that name resolves
to ::1 first, and when the server is IPv4-only the connection stalls on the
failed attempt. Measured on this machine it cost 2036 ms PER CALL - 65x the
30 ms the same request takes over the literal address, and it looked exactly
like a slow model.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np


def _add_cuda_dlls() -> None:
    """Put the pip-installed NVIDIA runtime on the DLL search path (Windows).

    CTranslate2 links cuBLAS and cuDNN by name and does NOT look inside
    site-packages for them, so `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`
    is necessary but not sufficient: without this the model loads and then dies
    at the first encode with "Library cublas64_12.dll is not found", several
    seconds into what looks like a working run. Harmless on Linux, where the
    wheels' RPATH already handles it.
    """
    if os.name != "nt":
        return
    root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    dirs = [str(b) for b in sorted(root.glob("*/bin"))]
    if not dirs:
        return
    # BOTH mechanisms, because they cover different loaders. add_dll_directory
    # only helps callers that pass LOAD_LIBRARY_SEARCH_USER_DIRS; CTranslate2
    # resolves cuBLAS by bare name through the ordinary search order, which
    # reads PATH and never consults the user-directory list.
    for d in dirs:
        try:
            os.add_dll_directory(d)
        except OSError:
            pass
    os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")


_add_cuda_dlls()

TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parent.parent
API_DIR = REPO_ROOT / "apps" / "api-py"

OLLAMA = "http://127.0.0.1:11434"
KOKORO_DIR = API_DIR / "var" / "kokoro"
AUDIO_DIR = API_DIR / "var" / "interview-audio"

# A clause is speakable as soon as it hits one of these. Waiting for a full
# sentence adds the rest of the sentence to first-audio latency for nothing:
# the TTS engine will be fed the remainder while the first clause is playing.
CLAUSE_ENDS = ".?!,;:"
# Below this, a "clause" is a fragment like "Well," and synthesising it alone
# produces an audible stutter before the real answer starts.
MIN_CLAUSE_CHARS = 12
# Hard ceiling on the first chunk. Past this, break at the next word boundary
# rather than waiting for punctuation: a clause that never punctuates until
# character 62 has already cost more than the whole latency budget.
MAX_CLAUSE_CHARS = 28

PROMPT = (
    "You are conducting a mock job interview. Ask one short follow-up "
    "question about what the candidate just said. One sentence, no preamble."
)

# ONE client for the process, not one per call. Constructing httpx.Client builds
# an SSL context even for a plain http:// target, and that cost lands on every
# request that makes its own client. Measured here against a warm local Ollama:
# a fresh client per call was 187.8 ms to first token, the SAME request on a
# reused client was 11.6 ms. It presents as a slow model and is not one.
_CLIENT: "httpx.Client | None" = None


def client():
    global _CLIENT
    if _CLIENT is None:
        import httpx

        _CLIENT = httpx.Client(timeout=None)
    return _CLIENT


def die(msg: str) -> None:
    print(f"bench: {msg}", file=sys.stderr)
    raise SystemExit(2)


def ms(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000


# --------------------------------------------------------------------- audio


def load_tail(seconds: float) -> np.ndarray:
    """The last `seconds` of real speech, at 16 kHz - the STT critical path."""
    files = sorted(AUDIO_DIR.glob("*.interviewer.wav"))
    if not files:
        die(f"no audio in {AUDIO_DIR}. Run an interview first, or pass --wav.")
    with wave.open(str(files[-1])) as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    a = pcm.astype(np.float32) / 32768.0
    # Pick the loudest window so we measure speech, not the silence between
    # turns - a tail of silence transcribes in no time and flatters the number.
    win = int(4 * sr)
    best_i, best_e = 0, -1.0
    for i in range(0, max(1, len(a) - win), sr // 4):
        e = float(np.sqrt(np.mean(a[i : i + win] ** 2)))
        if e > best_e:
            best_e, best_i = e, i
    seg = a[best_i : best_i + win]
    idx = np.linspace(0, len(seg) - 1, int(len(seg) * 16000 / sr))
    a16 = np.interp(idx, np.arange(len(seg)), seg).astype(np.float32)
    return a16[-int(seconds * 16000) :]


# --------------------------------------------------------------------- stages


def build_stt(model_size: str, device: str):
    from faster_whisper import WhisperModel

    t0 = time.perf_counter()
    try:
        m = WhisperModel(model_size, device=device, compute_type="float16" if device == "cuda" else "int8")
    except Exception as exc:
        if device != "cuda":
            raise
        print(f"  cuda unavailable ({type(exc).__name__}), falling back to cpu/int8", file=sys.stderr)
        m = WhisperModel(model_size, device="cpu", compute_type="int8")
        device = "cpu"
    load = ms(t0)

    def transcribe(audio: np.ndarray) -> str:
        segs, _ = m.transcribe(audio, beam_size=1, language="en")
        return "".join(s.text for s in segs).strip()

    return transcribe, load, device


def build_tts_piper():
    """Piper: one ONNX pass per sentence on CPU, no GPU, no streaming API.

    Measured RTF 0.028 against Kokoro's 0.205 on this machine - Piper is the
    latency choice and Kokoro the quality one, and for a first chunk the
    difference is the whole budget.
    """
    from piper import PiperVoice

    onnx = API_DIR / "var" / "piper-voices" / "en_US-lessac-medium.onnx"
    if not onnx.exists():
        die(f"piper voice missing at {onnx}")
    t0 = time.perf_counter()
    v = PiperVoice.load(str(onnx))
    load = ms(t0)

    def synth(text: str):
        buf, rate = [], 22050
        for ch in v.synthesize(text):
            buf.append(np.frombuffer(ch.audio_int16_bytes, dtype=np.int16))
            rate = ch.sample_rate
            break                     # FIRST chunk only - the rest streams
        return (np.concatenate(buf).astype(np.float32) / 32768.0 if buf
                else np.zeros(0, dtype=np.float32)), rate

    return synth, load


def build_tts():
    """Returns a synth that yields only the FIRST audio chunk.

    `Kokoro.create()` is the wrong call for this measurement: it returns when
    the WHOLE utterance is synthesised, so feeding it a 62-character clause
    reported 1037 ms - which is the cost of 6.4 s of audio, not the cost of
    starting to speak. `create_stream()` is an async generator, and the first
    tuple it yields is the only thing the student waits for; everything after
    it is synthesised while that chunk is already playing.
    """
    import asyncio

    from kokoro_onnx import Kokoro

    onnx = KOKORO_DIR / "kokoro-v1.0.onnx"
    voices = KOKORO_DIR / "voices-v1.0.bin"
    if not onnx.exists() or not voices.exists():
        die(f"kokoro model files missing in {KOKORO_DIR}")
    t0 = time.perf_counter()
    k = Kokoro(str(onnx), str(voices))
    load = ms(t0)

    async def _first(text: str):
        async for samples, rate in k.create_stream(
            text, voice="af_heart", speed=1.0, lang="en-us"
        ):
            return samples, rate
        return np.zeros(0, dtype=np.float32), 24000

    def synth(text: str):
        return asyncio.run(_first(text))

    return synth, load


def llm_first_clause(model: str, transcript: str) -> tuple[float, float, str, float]:
    """(ttft_ms, first_clause_ms, clause_text, tok_per_s) streaming from Ollama."""
    body = {
        "model": model,
        "stream": True,
        "keep_alive": "20m",
        "messages": [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": transcript or "(inaudible)"},
        ],
        "options": {"num_ctx": 2048, "temperature": 0.3, "num_predict": 80},
    }
    t0 = time.perf_counter()
    ttft = None
    clause_at = None
    text = ""
    clause = ""
    pieces = 0
    final: dict = {}
    with client().stream("POST", f"{OLLAMA}/api/chat", json=body) as r:
        if True:
            for line in r.iter_lines():
                if not line:
                    continue
                o = json.loads(line)
                piece = (o.get("message") or {}).get("content") or ""
                if piece:
                    pieces += 1
                    if ttft is None:
                        ttft = ms(t0)
                text += piece
                if clause_at is None and len(text) >= MIN_CLAUSE_CHARS:
                    cut = None
                    for i, ch in enumerate(text):
                        if ch in CLAUSE_ENDS and i + 1 >= MIN_CLAUSE_CHARS:
                            cut = i + 1
                            break
                    if cut is None and len(text) >= MAX_CLAUSE_CHARS:
                        space = text.rfind(" ", MIN_CLAUSE_CHARS, MAX_CLAUSE_CHARS)
                        cut = space if space > 0 else None
                    if cut:
                        clause_at = ms(t0)
                        clause = text[:cut]
                if o.get("done"):
                    final = o
                    break
                if clause_at is not None:
                    # The rest of the answer keeps streaming in the real
                    # pipeline; for the measurement the clock has stopped.
                    break
    # NOT eval_count: this loop breaks at the first clause, so `done` (and the
    # counters it carries) never arrives. Ollama streams one message per token,
    # so counting pieces over the window after the first token is the rate that
    # actually produced this clause.
    span = (clause_at - ttft) if (clause_at and ttft and clause_at > ttft) else 0.0
    rate = (pieces - 1) / (span / 1000) if span > 0 and pieces > 1 else float("nan")
    return ttft or float("nan"), clause_at or ms(t0), (clause or text), rate


# --------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(prog="cascade-bench", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--llm", default="llama3.2:3b", help="Ollama model for the worker")
    ap.add_argument("--stt", default="base.en", help="faster-whisper size (tiny.en/base.en/small.en)")
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    ap.add_argument("--tail", type=float, default=0.6, help="seconds of audio on the STT critical path")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--stage", default="all", choices=["all", "stt", "llm", "tts"])
    ap.add_argument("--tts", default="piper", choices=["piper", "kokoro"])
    args = ap.parse_args()

    print(f"cascade: {args.stt}({args.device}) -> {args.llm} -> {args.tts}")
    print(f"         STT tail {args.tail}s, {args.runs} runs, best-of reported\n")

    audio = load_tail(args.tail)
    stt = tts = None
    transcript = "I led a team of four on a React dashboard that cut load times by half."

    if args.stage in ("all", "stt"):
        stt, load, dev = build_stt(args.stt, args.device)
        for _ in range(2):
            stt(audio)
        t = []
        for _ in range(args.runs):
            t0 = time.perf_counter()
            transcript = stt(audio)
            t.append(ms(t0))
        stt_ms = min(t)
        print(f"  1. STT   {args.stt} on {dev}, {args.tail}s tail   {stt_ms:7.1f} ms   (load {load:.0f} ms once)")
        print(f"           heard: {transcript[:64]!r}")
    else:
        stt_ms = float("nan")

    if args.stage in ("all", "llm"):
        llm_first_clause(args.llm, transcript)
        best = min((llm_first_clause(args.llm, transcript) for _ in range(args.runs)),
                   key=lambda r: r[1])
        ttft, llm_ms, clause, rate = best
        print(f"  2. LLM   {args.llm} to first clause              {llm_ms:7.1f} ms   "
              f"(ttft {ttft:.0f} ms, {rate:.0f} tok/s)")
        print(f"           clause: {clause.strip()[:64]!r}")
    else:
        llm_ms, clause = float("nan"), "Could you tell me more about that?"

    if args.stage in ("all", "tts"):
        tts, load = build_tts_piper() if args.tts == "piper" else build_tts()
        for _ in range(2):
            tts(clause.strip() or "Could you tell me more?")
        t = []
        for _ in range(args.runs):
            t0 = time.perf_counter()
            samples, rate_hz = tts(clause.strip() or "Could you tell me more?")
            t.append(ms(t0))
        tts_ms = min(t)
        audio_ms = len(samples) / rate_hz * 1000
        print(f"  3. TTS   {args.tts}, first chunk                     {tts_ms:7.1f} ms   "
              f"({audio_ms:.0f} ms of audio, RTF {tts_ms/audio_ms:.3f}, load {load:.0f} ms once)")
    else:
        tts_ms = float("nan")

    if args.stage == "all":
        total = stt_ms + llm_ms + tts_ms
        print(f"\n  {'TIME TO FIRST AUDIO':<44} {total:7.1f} ms")
        target = 300.0
        verdict = "UNDER" if total <= target else "OVER"
        print(f"  {verdict} the {target:.0f} ms target by {abs(target-total):.0f} ms")
        print("\n  Not included: the client jitter buffer (140 ms at rest), which is")
        print("  additive on the way to the student's ear.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
