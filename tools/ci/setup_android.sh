#!/usr/bin/env bash
# ============================================================================
#  Настройка Android SDK / NDK / CMake внутри GitHub Actions.
# ============================================================================
set -euo pipefail
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/usr/local/lib/android/sdk}}"
export ANDROID_SDK_ROOT="$SDK"; export ANDROID_HOME="$SDK"
echo "[setup] ANDROID_SDK_ROOT=$SDK"
SDKMANAGER=""
for c in "$SDK"/cmdline-tools/*/bin/sdkmanager "$SDK"/cmdline-tools/latest/bin/sdkmanager; do
  [ -x "$c" ] && SDKMANAGER="$c" && break
done
[ -z "$SDKMANAGER" ] && SDKMANAGER="$(command -v sdkmanager || true)"
echo "[setup] sdkmanager=$SDKMANAGER"
if [ -n "$SDKMANAGER" ]; then
  yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
  for pkg in "platform-tools" "platforms;android-36" "build-tools;36.0.0" "cmake;3.22.1"; do
    echo "[setup] $pkg"
    "$SDKMANAGER" --install "$pkg" >/tmp/sdk-install.log 2>&1 || echo "[setup] warn: $pkg"
  done
fi
NDK_ROOT="$SDK/ndk"; NDK_VER=""
if [ -d "$NDK_ROOT" ] && [ -n "$(ls -A "$NDK_ROOT" 2>/dev/null || true)" ]; then
  NDK_VER="$(ls "$NDK_ROOT" | sort -V | tail -1)"
fi
if [ -z "$NDK_VER" ]; then
  NDK_VER="27.0.12077973"
  "$SDKMANAGER" --install "ndk;$NDK_VER" >/tmp/ndk-install.log 2>&1 || { tail -40 /tmp/ndk-install.log; exit 1; }
fi
echo "[setup] NDK=$NDK_VER"
{ echo "MMX_NDK_VERSION=$NDK_VER"; echo "ANDROID_SDK_ROOT=$SDK"; echo "ANDROID_HOME=$SDK"; } >> "${GITHUB_ENV:-/dev/null}"
echo "[setup] platforms: $(ls "$SDK/platforms" 2>/dev/null | tr '\n' ' ')"
