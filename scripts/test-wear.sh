#!/bin/sh
# Test the Wear OS app's pure Kotlin core (wear-core/: the rules ported from targets/watch/Core,
# with the watch-core Swift suites' vectors) on any JDK 17 or later. Skips, and passes, where
# there is no Java (a machine set up for the web only); CI's wear.yml always runs it. The
# Android module itself (`:wear`) builds and tests from android/ after a prebuild:
#   ./gradlew :wear:assembleDebug :wear:testDebugUnitTest :app:assembleDebug
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${JAVA_HOME:-}" ] && ! command -v java >/dev/null 2>&1; then
  echo "test:wear: no JDK here, skipped"
  exit 0
fi
exec "$root/wear-core/gradlew" -p "$root/wear-core" --console=plain test "$@"
