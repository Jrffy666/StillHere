#!/usr/bin/env bash
set -euo pipefail
CONTRACT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CONTRACT_DIR"
RPC=http://127.0.0.1:8899
GENESIS="$(solana genesis-hash --url "$RPC")"
case "$GENESIS" in
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG|5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d|4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY) echo "Refusing public network." >&2; exit 1 ;;
esac
test -f target/deploy/safety_guard_v2.so
test -f target/deploy/safety_guard_v2-keypair.json
mkdir -p .keys
if [[ ! -f .keys/v2-local-deployer.json ]]; then
  solana-keygen new --no-bip39-passphrase --silent --outfile .keys/v2-local-deployer.json
  chmod 600 .keys/v2-local-deployer.json
fi
LOCAL_PAYER="$(solana-keygen pubkey .keys/v2-local-deployer.json)"
solana airdrop 10 "$LOCAL_PAYER" --url "$RPC"
solana program deploy --url "$RPC" --keypair .keys/v2-local-deployer.json --program-id target/deploy/safety_guard_v2-keypair.json target/deploy/safety_guard_v2.so
