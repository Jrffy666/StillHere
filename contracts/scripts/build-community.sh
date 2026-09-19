#!/usr/bin/env bash
set -euo pipefail
CONTRACT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CONTRACT_DIR"
test -f target/deploy/community_ledger-keypair.json || { echo "Run npm --prefix ../chain run setup:community first." >&2; exit 1; }
EXPECTED_ID="$(solana-keygen pubkey target/deploy/community_ledger-keypair.json)"
grep -Fq "declare_id!(\"$EXPECTED_ID\")" programs/community-ledger/src/lib.rs || { echo "Community source ID and key do not match." >&2; exit 1; }
# This invocation builds only the community crate; existing V1/V2 artifacts are unchanged.
CARGO_PROFILE_RELEASE_OPT_LEVEL=z cargo build-sbf --manifest-path programs/community-ledger/Cargo.toml --sbf-out-dir target/deploy --tools-version v1.56 --arch v3
