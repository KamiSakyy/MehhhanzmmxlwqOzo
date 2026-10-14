#!/usr/bin/env bash
# Экспорт демо-модуля .c и проверка открытия его нативным C++ (безинтернетно).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CPP="$ROOT/android/app/src/main/cpp"
OUT="$ROOT/ci-out/demo"; mkdir -p "$OUT/classes" "$OUT/lib"
export MMX_SIGNER_SHA256="${MMX_SIGNER_SHA256:-$(printf 'ab%.0s' {1..32})}"
python3 "$ROOT/tools/ci/genkey.py" >/dev/null
echo "=== [1/5] компиляция ядра ==="
javac -encoding UTF-8 --release 17 -d "$OUT/classes" \
  $(find "$ROOT/android/app/src/main/java/com/mehhanz/engine" -name '*.java') \
  "$ROOT/tools/ci/javatest/mmxtest/DemoExport.java"
echo "=== [2/5] экспорт демо-модулей (hello.c, pingpong.c) ==="
if [ -f "$ROOT/tools/ci/javatest/mmxtest/DemoExport.java" ]; then
  java -cp "$OUT/classes" mmxtest.DemoExport "$OUT/modules"
else
  echo "[demo] DemoExport.java ещё не добавлен — пропускаю"; mkdir -p "$OUT/modules"
fi
echo "=== [3/5] сборка libmmxsec.so для 4 ABI через NDK ==="
NDK="${ANDROID_NDK_ROOT:-${ANDROID_NDK_HOME:-/usr/local/lib/android/sdk/ndk/${MMX_NDK_VERSION:-27.0.12077973}}}"
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
ls "$TC" >/dev/null || { echo "NDK toolchain не найден: $TC"; ls "$NDK" || true; exit 1; }
declare -A ABIS=( [arm64-v8a]=aarch64-linux-android24 [armeabi-v7a]=armv7a-linux-androideabi24 [x86_64]=x86_64-linux-android24 [x86]=i686-linux-android24 )
for abi in "${!ABIS[@]}"; do
  t="${ABIS[$abi]}"; mkdir -p "$OUT/lib/$abi"
  "$TC/${t}-clang++" -std=c++17 -O2 -fPIC -shared -Wl,-soname,libmmxsec.so \
    -o "$OUT/lib/$abi/libmmxsec.so" \
    "$ROOT/native/crypto/mmx_crypto.cpp" "$CPP/mmx_jni.cpp" "$CPP/generated/mmx_keys_generated.cpp" \
    -I"$CPP" -I"$ROOT/native/crypto" -llog
  echo "  $abi: $(stat -c %s "$OUT/lib/$abi/libmmxsec.so") байт"
done
echo "=== [4/5] host-сборка утилит открытия/запечатывания ==="
g++ -std=c++17 -O2 -I"$ROOT/native/crypto" -o "$OUT/mmx_open_module" \
  "$ROOT/native/crypto/mmx_crypto.cpp" "$ROOT/tools/ci/cpp_demo/mmx_open_module.cpp"
g++ -std=c++17 -O2 -I"$ROOT/native/crypto" -o "$OUT/mmx_seal_file" \
  "$ROOT/native/crypto/mmx_crypto.cpp" "$ROOT/tools/ci/cpp_demo/mmx_seal_file.cpp"
echo "=== [5/5] нативное открытие модуля .c ==="
KEY=$(cat "$OUT/modules/pingpong.c.key")
"$OUT/mmx_open_module" "$OUT/modules/pingpong.c" "$KEY" | tee "$OUT/open.log"
echo "=== демо-экспорт готов ==="
