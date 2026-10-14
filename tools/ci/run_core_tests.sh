#!/usr/bin/env bash
# Тесты ядра MMX на JVM: компилятор языка, .c-модули, крипто-конвейер.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/ci-out/core"; mkdir -p "$OUT/classes"
export MMX_SIGNER_SHA256="${MMX_SIGNER_SHA256:-$(printf 'ab%.0s' {1..32})}"
echo "=== [1/4] компиляция ядра ==="
javac -encoding UTF-8 --release 17 -d "$OUT/classes" \
  $(find "$ROOT/android/app/src/main/java/com/mehhanz/engine" -name '*.java') 2>&1 | tee "$OUT/javac.log" || { echo "КОМПИЛЯЦИЯ ЯДРА УПАЛА"; exit 1; }
echo "=== [2/4] ключ сборки ==="
python3 "$ROOT/tools/ci/genkey.py" | tee "$OUT/genkey.log"
echo "=== [3/4] нативные тесты ==="
bash "$ROOT/tools/ci/run_native_crypto_test.sh" 2>&1 | tee "$OUT/native.log"
echo "=== [4/4] сценарные тесты движка ==="
if [ -f "$ROOT/tools/ci/javatest/CoreSmoke.java" ]; then
  javac -encoding UTF-8 -cp "$OUT/classes" -d "$OUT/classes" "$ROOT/tools/ci/javatest/CoreSmoke.java"
  java -cp "$OUT/classes" CoreSmoke | tee "$OUT/smoke.log"
else
  echo "[smoke] CoreSmoke.java ещё не добавлен — пропускаю"
fi
echo "=== тесты ядра пройдены ==="
