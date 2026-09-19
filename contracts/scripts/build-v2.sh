#!/usr/bin/env bash
set -euo pipefail
CONTRACT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CONTRACT_DIR"
test -f target/deploy/safety_guard_v2-keypair.json || { echo "Run npm --prefix ../chain run setup:v2 first." >&2; exit 1; }
EXPECTED_ID="$(solana-keygen pubkey target/deploy/safety_guard_v2-keypair.json)"
grep -Fq "declare_id!(\"$EXPECTED_ID\")" programs/safety-guard-v2/src/lib.rs || { echo "V2 source ID and key do not match." >&2; exit 1; }
cargo build-sbf --manifest-path programs/safety-guard-v2/Cargo.toml --sbf-out-dir target/deploy --tools-version v1.56 --arch v3
mkdir -p target/idl target/types
cd programs/safety-guard-v2
RUSTUP_TOOLCHAIN=1.94.1 anchor idl build -o ../../target/idl/safety_guard_v2.json -t ../../target/types/safety_guard_v2.ts
