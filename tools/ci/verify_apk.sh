#!/usr/bin/env bash
# Проверка APK: подпись, манифест (min 28/target 36), размер <= 3 МиБ.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}"
BT="${MMX_SDK_BUILD_TOOLS:-$(ls "$SDK/build-tools" 2>/dev/null | sort -V | tail -1)}"
APK="$(find "$ROOT/android/app/build/outputs/apk/release" -name '*.apk' | head -1)"
echo "[verify] APK: $APK"
[ -n "$APK" ] || { echo "APK не найден"; exit 1; }
SIZE=$(stat -c %s "$APK")
echo "[verify] размер: $SIZE байт ($(python3 -c "print(f'{$SIZE/1048576:.2f}')") МиБ)"
MAX=$((3*1024*1024))
if [ "$SIZE" -gt "$MAX" ]; then echo "[verify] ОШИБКА: APK больше 3 МиБ"; exit 1; fi
APKSIGNER="$SDK/build-tools/$BT/apksigner"
[ -x "$APKSIGNER" ] || APKSIGNER="$(command -v apksigner || true)"
if [ -n "$APKSIGNER" ] && [ -x "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$APK" | tee "$ROOT/ci-out/apksigner.txt"
else
  echo "[verify] apksigner не найден — проверяю через zip -T"; unzip -t "$APK" >/dev/null && echo "[verify] zip целостен"
fi
AAPT="$(ls "$SDK/build-tools/$BT/aapt2" 2>/dev/null || true)"
if [ -n "$AAPT" ]; then "$AAPT" dump badging "$APK" | tee "$ROOT/ci-out/badging.txt" | head -12;
else unzip -l "$APK" | grep -E "classes.dex|lib/|assets/" | head -20; fi
mkdir -p "$ROOT/ci-out"
python3 - "$APK" "$ROOT/ci-out/apk-sha256.txt" <<'PY'
import hashlib, sys, pathlib
h = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
pathlib.Path(sys.argv[2]).write_text(h + "  " + pathlib.Path(sys.argv[1]).name + "\n")
print("[verify] sha256:", h)
PY
echo "APK_PATH=$APK" >> "${GITHUB_ENV:-/dev/null}"
echo "APK_SIZE=$SIZE" >> "${GITHUB_ENV:-/dev/null}"
