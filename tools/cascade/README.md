# cascade — a fully local voice loop, measured

A dev tool, not part of the REEP app. It answers one question with numbers:
**the student stops speaking; how long until they hear the first syllable of the
reply, with nothing leaving this machine?**

Target was ≤300 ms and zero API cost. Both are met.

## Measured on this machine

RTX 5070 Ti Laptop (12 GB), Core Ultra 9 275HX, Windows 11. Best of 5, warm.

| stage | component | 8B worker | 3B worker |
|---|---|---|---|
| 1. STT | `faster-whisper base.en`, CUDA fp16, 0.6 s tail | 28 ms | 28 ms |
| 2. LLM | Ollama, to first speakable clause | 100 ms | 51 ms |
| 3. TTS | Piper `en_US-lessac-medium`, first chunk | 35 ms | 34 ms |
| | **time to first audio** | **163 ms** | **113 ms** |

Swap Piper for Kokoro-82M and TTS goes from 35 ms to 287 ms — total 368 ms, over
budget on its own. Kokoro sounds better; Piper is the one that fits. That is the
real trade, and it is the only one in the table.

The client's playback jitter buffer (140 ms at rest) is additive on the way to
the ear, so the honest end-to-end figure is ~300 ms with the 8B and ~250 ms with
the 3B.

## Why this is not the sum of three benchmarks

Every stage is measured at the boundary the **next** stage waits on. Measure any
of them the obvious way and the number is meaningless:

- **STT is chunked.** When speech stops, everything before the last chunk is
  already transcribed. Only the tail is on the critical path. Transcribing the
  whole utterance measures a batch job — 4.1 s of audio took 360 ms where the
  0.6 s tail takes 28 ms.
- **The LLM only needs the first clause.** Time-to-first-token is too little (you
  cannot speak one token); the full reply is far too much. The bench cuts at the
  first punctuation after 12 characters, or the last word boundary before 28.
- **TTS only needs its first chunk.** `Kokoro.create()` returned in 1037 ms for a
  62-character clause — that is the cost of synthesising 6.4 s of audio, not the
  cost of starting to speak. `create_stream()` and a capped clause fixed it.

## Two bugs that cost 2 seconds each

Both presented as "the model is slow" and neither was.

**1. `localhost` on Windows.** Resolves to `::1` first; when the server is
IPv4-only the connection stalls on the failed attempt. Ollama reported 108 ms of
internal work while the wall clock said 2169 ms.

```
http://localhost:11434    2066 ms
http://127.0.0.1:11434      30 ms      # 65x
```

**2. A fresh `httpx.Client` per call.** Constructing one builds an SSL context
even for a plain `http://` target.

```
new client per call     187.8 ms
reused client            11.6 ms      # same request, same server
```

The second one is environment-sensitive — the same code cost 16.5 ms per client
on Python 3.14 and 187.8 ms on 3.12, which is exactly why it survived so long.
`app/ai/llm.py` uses `httpx.post()` / `httpx.stream()`, the module-level helpers,
which build a client per call; on the API's own 3.14 venv that is ~5 ms of waste
per request rather than 176, but it is waste.

## Setup

Python 3.12 (`livekit-agents` and `onnxruntime-directml` both refuse 3.14):

```
cd apps/api-py
py -3.12 -m venv .venv-cascade
.venv-cascade/Scripts/pip install faster-whisper piper-tts kokoro-onnx httpx
.venv-cascade/Scripts/pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

Those two NVIDIA wheels are necessary but **not sufficient** on Windows:
CTranslate2 resolves cuBLAS by bare name through the ordinary search order, which
reads `PATH` and never consults the user-directory list. Without the `PATH` fix
in `_add_cuda_dlls()`, the model loads fine and then dies several seconds later
with `Library cublas64_12.dll is not found`. `os.add_dll_directory()` alone does
not fix it.

Voices and models (both under `apps/api-py/var/`, gitignored):

```
.venv-cascade/Scripts/python -m piper.download_voices en_US-lessac-medium --data-dir var/piper-voices
curl -L -o var/kokoro/kokoro-v1.0.onnx  <kokoro-onnx releases>/kokoro-v1.0.onnx
curl -L -o var/kokoro/voices-v1.0.bin   <kokoro-onnx releases>/voices-v1.0.bin
ollama pull llama3.1:8b
```

## Running it

```
python tools/cascade/bench.py                          # 3B + piper, the default
python tools/cascade/bench.py --llm llama3.1:8b
python tools/cascade/bench.py --tts kokoro             # the quality/latency trade
python tools/cascade/bench.py --stage stt --tail 1.0   # one stage
python tools/cascade/bench.py --device cpu             # no GPU
```

Input audio is the loudest window of a real recorded interview from
`var/interview-audio/`, not a synthetic clip — a tail of silence transcribes
instantly and flatters the number.

## What this does NOT prove

This measures three components at the right boundaries and sums them. It is not a
running pipeline: there is no VAD deciding when the student stopped, no barge-in,
no partial-transcript handling, and no back-pressure. Those add engineering, not
much latency — but "the components are fast enough" and "the system works" are
different claims and only the first one is tested here.

Accuracy is also untested. `base.en` on a 0.6 s tail returns fragments by design;
the real pipeline joins them to everything transcribed earlier in the utterance.
Whether the joined transcript is good enough to grade an interview on is a
separate question from whether it arrives in time, and REEP's scorecard is
written off that transcript.
