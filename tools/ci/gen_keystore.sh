#!/usr/bin/env bash
# Ключ подписи релиза (генерируется в CI, в git не попадает) + печать подписи.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KS="$ROOT/android/app/release.keystore"
PROPS="$ROOT/android/keystore.properties"
PASS="${MMX_KS_PASS:-$(openssl rand -hex 20)}"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -storepass "$PASS" -keypass "$PASS" \
    -alias mmx -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Mehhanz MMX Engine, OU=Studio, O=Mehhanz, L=Paris, C=FR" >/dev/null
  printf 'storeFile=release.keystore\nstorePassword=%s\nkeyAlias=mmx\nkeyPassword=%s\n' "$PASS" "$PASS" > "$PROPS"
  chmod 600 "$KS" "$PROPS" || true
fi
keytool -exportcert -keystore "$KS" -storepass "$PASS" -alias mmx -file /tmp/mmx-release.der >/dev/null
SIGNER_SHA256="$(openssl dgst -sha256 -hex /tmp/mmx-release.der | awk '{print $NF}' | tr 'A-Z' 'a-z')"
echo "[keys] signer SHA-256 = $SIGNER_SHA256"
{ echo "MMX_SIGNER_SHA256=$SIGNER_SHA256"; echo "MMX_KS_PASS=$PASS"; } >> "${GITHUB_ENV:-/dev/null}"
mkdir -p "$ROOT/ci-out/keys"
echo "$SIGNER_SHA256" > "$ROOT/ci-out/keys/signer-sha256.txt"
keytool -printcert -file /tmp/mmx-release.der > "$ROOT/ci-out/keys/certificate.txt" 2>/dev/null || true
