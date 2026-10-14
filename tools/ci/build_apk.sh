#!/usr/bin/env bash
# Сборка release APK в GitHub Actions.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/android"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/usr/local/lib/android/sdk}}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
if [ ! -f gradle/wrapper/gradle-wrapper.jar ]; then
  echo "[build] генерирую gradle wrapper…"
  gradle wrapper --gradle-version "${GRADLE_VERSION:-8.13}"
fi
chmod +x gradlew
VC="${GITHUB_RUN_NUMBER:-1}"
./gradlew --no-daemon --stacktrace :app:assembleRelease \
  -PmmxVersionCode="$VC" \
  -PmmxVersionName="1.0.$VC"
echo "[build] артефакты:"
find "$ROOT/android/app/build/outputs/apk" -name '*.apk' -exec ls -la {} +
