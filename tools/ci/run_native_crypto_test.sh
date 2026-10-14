#!/usr/bin/env bash
# KAT-тесты криптоядра + кросс-проверка Java(JCE) <-> C++(libmmxsec).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/ci-out/native"; mkdir -p "$OUT"
export MMX_SIGNER_SHA256="${MMX_SIGNER_SHA256:-$(printf 'ab%.0s' {1..32})}"
echo "=== [1/5] генерация ключа сборки ==="
python3 "$ROOT/tools/ci/genkey.py" | tee "$OUT/genkey.log"
echo "=== [2/5] KAT криптопримитивов ==="
g++ -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -I"$ROOT/native/crypto" \
  -o "$OUT/crypto_kat" "$ROOT/native/crypto/mmx_crypto.cpp" "$ROOT/native/host_test/mmx_kat_test.cpp"
"$OUT/crypto_kat" | tee "$OUT/kat.log"
echo "=== [3/5] Java(JCE) шифрует модуль ==="
if command -v javac >/dev/null 2>&1; then
  mkdir -p "$OUT/classes"
  javac -encoding UTF-8 -d "$OUT/classes" "$ROOT/tools/ci/javatest/mmxtest/CrossSealFixture.java"
  java -cp "$OUT/classes" mmxtest.CrossSealFixture seal "$OUT/cross" | tee "$OUT/cross-java1.log"
else
  echo "[cross] JDK отсутствует — кросс-тест пропущен"; exit 0
fi
echo "=== [4/5] C++ расшифровывает модуль Java и шифрует свой ==="
g++ -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -I"$ROOT/native/crypto" \
  -o "$OUT/crypto_cross" "$ROOT/native/crypto/mmx_crypto.cpp" "$ROOT/native/host_test/mmx_cross_test.cpp"
"$OUT/crypto_cross" "$OUT/cross" | tee "$OUT/cross-cpp.log"
echo "=== [5/5] Java расшифровывает модуль C++ ==="
java -cp "$OUT/classes" mmxtest.CrossSealFixture verify "$OUT/cross" | tee "$OUT/cross-java2.log"
echo "=== нативные тесты и кросс-проверка пройдены ==="
