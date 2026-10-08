#!/bin/sh
# Compile and run the host self-check for the iOS engine's pure Swift parts (Smart Speed's
# silence detector, span planner and saved-time meter; the lock screen's chapter-clip maths).
# Needs only the Xcode toolchain (no simulator). Usage: modules/audiosilo-player/ios/SelfCheck/run.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
xcrun swiftc -O -o "$out/selfcheck" \
  "$here/../SmartSpeedPlanner.swift" "$here/../ChapterClips.swift" "$here/main.swift"
"$out/selfcheck"
