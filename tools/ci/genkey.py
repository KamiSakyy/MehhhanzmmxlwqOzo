#!/usr/bin/env python3
# ============================================================================
#  Мастер-ключ MMX: НИКОГДА не в git и не в DEX — только в .so (libmmxsec).
# ============================================================================
import os, secrets, hashlib, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "android/app/src/main/cpp/generated"
OUT.mkdir(parents=True, exist_ok=True)
key, mask, salt2 = secrets.token_bytes(32), secrets.token_bytes(32), secrets.token_bytes(16)
enc = bytes(a ^ b ^ c for a, b, c in zip(key, mask, salt2))
build_tag = os.environ.get("MMX_BUILD_TAG") or secrets.token_hex(8)
run_id = os.environ.get("GITHUB_RUN_ID", "0")
sha = os.environ.get("GITHUB_SHA", "")[:12]
signer = os.environ.get("MMX_SIGNER_SHA256", "").lower().strip()
if len(signer) != 64:
    print("[genkey] warn: печать подписи не задана", file=sys.stderr); signer = "00" * 32

def carr(data, per=12, ind="    "):
    return "\n".join(ind + ", ".join("0x%02X" % b for b in data[i:i+per]) + "," for i in range(0, len(data), per))

fp = hashlib.sha256(key).hexdigest()
(OUT / "mmx_keys_generated.h").write_text(f"""// СГЕНЕРИРОВАНО АВТОМАТИЧЕСКИ (genkey.py) — НЕ КОММИТИТЬ!
// run={run_id} sha={sha} tag={build_tag}
#pragma once
#define MMX_GENERATED 1
static const char MMX_BUILD_TAG[] = "{build_tag}";
static const unsigned MMX_BUILD_RUN = {int(run_id) if run_id.isdigit() else 0}U;
static const unsigned char MMX_K_ENC[32] = {{
{carr(enc)}
}};
static const unsigned char MMX_K_MASK1[32] = {{
{carr(mask)}
}};
static const unsigned char MMX_K_MASK2[32] = {{
{carr(salt2)}
}};
static const unsigned char MMX_SIGNER_SHA256[32] = {{
{carr(bytes.fromhex(signer))}
}};
""", encoding="utf-8")
(OUT / "mmx_keys_generated.cpp").write_text(
    '#include "mmx_keys_generated.h"\nextern const int mmx_generated_keys_link;\nconst int mmx_generated_keys_link = 1;\n', encoding="utf-8")
print(f"[genkey] fingerprint={fp[:16]} tag={build_tag}")
env = os.environ.get("GITHUB_ENV")
if env:
    with open(env, "a", encoding="utf-8") as fh:
        fh.write(f"MMX_KEY_FP={fp}\nMMX_BUILD_TAG={build_tag}\nMMX_BUILD_RUN_ID={run_id}\n")
