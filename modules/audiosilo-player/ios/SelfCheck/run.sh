#!/bin/sh
# Compile and run the host self-check for the iOS engine's pure Swift parts (the lock screen's
# chapter-clip maths; Voice Boost's DSP on synthetic signals and on `say` speech).
# Needs only the Xcode toolchain (no simulator). Usage: modules/audiosilo-player/ios/SelfCheck/run.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
xcrun swiftc -O -o "$out/selfcheck" \
  "$here/../VoiceBoostDSP.swift" "$here/../ChapterClips.swift" "$here/main.swift"
"$out/selfcheck"
