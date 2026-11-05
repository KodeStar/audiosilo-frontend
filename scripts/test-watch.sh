#!/bin/sh
# Build and test the Apple Watch app's Foundation-only core (targets/watch/Core, compiled by the
# SwiftPM package in watch-core/ through a symlink) on this machine. Skips, and passes, where
# there is no Swift toolchain (Linux CI, Windows): the macOS CI job runs it.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
if ! command -v swift >/dev/null 2>&1; then
  echo "test:watch: no swift toolchain here, skipped"
  exit 0
fi
exec swift test --package-path "$root/watch-core" "$@"
