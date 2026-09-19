#!/usr/bin/env bash
set -euo pipefail
CONTRACT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CONTRACT_DIR"
RPC=https://api.devnet.solana.com
test "$(solana genesis-hash --url "$RPC")" = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' || { echo 'Unexpected network.' >&2; exit 1; }
test -f .keys/deployer.json
test -f target/deploy/safety_guard_v2.so
test -f target/deploy/safety_guard_v2-keypair.json
V2_ID="$(solana-keygen pubkey target/deploy/safety_guard_v2-keypair.json)"
test "$V2_ID" != '6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK'
grep -Fq "declare_id!(\"$V2_ID\")" programs/safety-guard-v2/src/lib.rs
solana program deploy --url "$RPC" --keypair .keys/deployer.json --program-id target/deploy/safety_guard_v2-keypair.json target/deploy/safety_guard_v2.so
