#!/usr/bin/env bash
# Turn the recorder's .webm captures into MP4s (H.264, plays everywhere —
# PowerPoint, phones, browsers) at their capture size, and one combined walkthrough.
#
#   bash tools/demo/render.sh [out-dir]        (default tools/demo/out)
#
# Needs a full ffmpeg build (apt: ffmpeg). The one Playwright bundles cannot
# encode H.264 or concatenate, which is why this is not done by the recorder.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "${1:-$HERE/out}" && pwd)"
cd "$OUT"

# Presentation order — the same order as the slide deck.
ORDER=(student faculty admin interlinked onboarding alumni)

encode() {
  local name="$1"
  [ -f "$OUT/$name.webm" ] || { echo "skip $name (no $name.webm)"; return; }
  echo "encoding $name.mp4"
  # H.264 at the capture's own size, with the narration laid on at the times
  # the recorder logged (a silent track when a segment has none).
  node "$HERE/mix-narration.mjs" "$OUT" "$name"
}

for name in "${ORDER[@]}"; do encode "$name"; done

# One file for the people who want to press play once.
LIST=$(mktemp)
for name in "${ORDER[@]}"; do [ -f "$name.mp4" ] && printf "file '%s/%s.mp4'\n" "$PWD" "$name" >> "$LIST"; done
if [ -s "$LIST" ]; then
  echo "concatenating reep-full-walkthrough.mp4"
  ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$LIST" -c copy -movflags +faststart reep-full-walkthrough.mp4
fi
rm -f "$LIST"

# Durations, for the deck's video cards (build-deck.cjs reads this file).
{
  echo "{"
  first=1
  for name in "${ORDER[@]}" reep-full-walkthrough; do
    [ -f "$name.mp4" ] || continue
    d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$name.mp4")
    [ $first = 1 ] || echo ","
    first=0
    printf '  "%s": %s' "$name" "${d%.*}"
  done
  echo
  echo "}"
} > durations.json

echo
for f in *.mp4; do
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" | cut -d. -f1)
  printf "%-32s %3d:%02d  %7.1f MB\n" "$f" $((d/60)) $((d%60)) "$(awk "BEGIN{printf \"%.1f\", $(stat -c %s "$f")/1048576}")"
done
