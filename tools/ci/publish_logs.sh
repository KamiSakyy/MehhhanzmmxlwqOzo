#!/usr/bin/env bash
# Публикует логи CI в репозиторий (ci-logs/), чтобы их было видно извне Actions.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p ci-logs
{
  echo "run:        ${GITHUB_RUN_ID:-?}"
  echo "commit:     ${GITHUB_SHA:-?}"
  echo "ref:        ${GITHUB_REF_NAME:-?}"
  echo "дата(UTC):  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "--- артефакты логов ---"
  find ci-logs -type f | sort
} > ci-logs/RUN.txt
git config user.name "mmx-ci[bot]"
git config user.email "mmx-ci@users.noreply.github.com"
git add -f ci-logs >/dev/null
if git diff --cached --quiet; then echo "[logs] без изменений"; exit 0; fi
git commit -q -m "ci: логи прогона ${GITHUB_RUN_ID:-?} [skip ci]" || true
for i in 1 2 3; do
  if git push origin "HEAD:${GITHUB_REF_NAME}"; then echo "[logs] запушено"; exit 0; fi
  git pull --rebase origin "${GITHUB_REF_NAME}" || true; sleep 4
done
echo "[logs] не удалось запушить"; exit 0
