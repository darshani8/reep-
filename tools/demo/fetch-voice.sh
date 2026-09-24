#!/usr/bin/env bash
# Fetch the narration voice the recorder uses by default: Piper's
# en_US-lessac-medium (MIT-licensed, ~63 MB), into tools/demo/voices/ (gitignored).
# Piper itself: `pip install piper-tts` (Python 3.11/3.12), then point PIPER at
# the binary if it is not on PATH.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/voices"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
for f in en_US-lessac-medium.onnx en_US-lessac-medium.onnx.json; do
  [ -s "$HERE/voices/$f" ] || curl -sSL -o "$HERE/voices/$f" "$BASE/$f"
  echo "voices/$f $(stat -c %s "$HERE/voices/$f") bytes"
done
