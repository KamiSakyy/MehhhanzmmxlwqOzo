#!/usr/bin/env bash
# Публикация артефактов сборки в handoff/ и автокоммит из CI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p handoff/modules handoff/libs
APK="${APK_PATH:-$(find android/app/build/outputs/apk/release -name '*.apk' | head -1)}"
[ -n "$APK" ] || { echo "APK не найден"; exit 1; }
cp "$APK" handoff/mehhanz-studio.apk
SIZE=$(stat -c %s handoff/mehhanz-studio.apk)
SAH=$(sha256sum handoff/mehhanz-studio.apk | awk '{print $1}')
if [ -d ci-out/demo/modules ]; then cp -f ci-out/demo/modules/* handoff/modules/ 2>/dev/null || true; fi
if [ -d ci-out/demo/lib ]; then cp -rf ci-out/demo/lib/* handoff/libs/ 2>/dev/null || true; fi
[ -f ci-out/demo/open.log ] && cp -f ci-out/demo/open.log handoff/native-open-log.txt || true
[ -f ci-out/apksigner.txt ] && cp -f ci-out/apksigner.txt handoff/apk-signature.txt || true
{
  echo "MEHHANZ MMX STUDIO — артефакты сборки"
  echo "build:      #${GITHUB_RUN_NUMBER:-1}  commit ${GITHUB_SHA:-local}"
  echo "key fp:     ${MMX_KEY_FP:-n/a}"
  echo "apk size:   $SIZE байт ($(python3 -c "print(f'{$SIZE/1048576:.2f}')") МиБ)"
  echo "apk sha256: $SAH"
  echo "signer:     ${MMX_SIGNER_SHA256:-n/a}"
} > handoff/BUILD-INFO.txt
cp -f handoff/BUILD-INFO.txt ci-out/ 2>/dev/null || true
python3 - <<'PY'
import pathlib, hashlib
root = pathlib.Path('handoff')
lines = []
for p in sorted(root.rglob('*')):
    if p.is_file() and p.name != 'SHA256SUMS.txt':
        lines.append(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(root)}")
(root / 'SHA256SUMS.txt').write_text("\n".join(lines) + "\n", encoding='utf-8')
print("checksums:")
print("\n".join(lines))
PY
cat handoff/BUILD-INFO.txt
git config user.name "mmx-ci[bot]"
git config user.email "mmx-ci@users.noreply.github.com"
git add -f handoff/
if git diff --cached --quiet; then echo "[handoff] без изменений"; exit 0; fi
git commit -m "ci: сборка APK #${GITHUB_RUN_NUMBER:-1} (${MMX_KEY_FP:0:12}) + демо .c-модули [skip ci]" || true
for i in 1 2 3; do
  if git push origin "HEAD:${GITHUB_REF_NAME:-${GITHUB_REF#refs/heads/}}"; then echo "[handoff] запушено"; exit 0; fi
  echo "[handoff] push не удался, попытка $i"; git pull --rebase origin "${GITHUB_REF_NAME:-main}" || true; sleep 5
done
echo "[handoff] не удалось запушить (не критично, APK есть в artifact)"; exit 0
