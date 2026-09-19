#!/usr/bin/env bash
set -euo pipefail

# Run in Linux, macOS, or WSL after installing Anchor and the Solana CLI.
CONTRACT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${1:-localnet}"
case "$CLUSTER" in
  localnet) RPC_URL="http://127.0.0.1:8899" ;;
  devnet) RPC_URL="https://api.devnet.solana.com" ;;
  *) echo "Only localnet and devnet are supported." >&2; exit 1 ;;
esac

command -v anchor >/dev/null || { echo "Install Anchor 0.32.1 first (see README)." >&2; exit 1; }
command -v solana >/dev/null || { echo "Install the Solana CLI first (see README)." >&2; exit 1; }
case "${SKIP_AIRDROP:-0}" in
  0|1) ;;
  *) echo "SKIP_AIRDROP must be 0 or 1." >&2; exit 1 ;;
esac
cd "$CONTRACT_DIR"
npm --prefix ../chain run setup
bash scripts/build.sh
DEPLOYER="$CONTRACT_DIR/.keys/deployer.json"
PROGRAM_KEY="$CONTRACT_DIR/target/deploy/safety_guard-keypair.json"
DEPLOYER_ADDRESS="$(solana-keygen pubkey "$DEPLOYER")"
if [[ "${SKIP_AIRDROP:-0}" != "1" ]]; then
  AIRDROP_AMOUNT=2
  if [[ "$CLUSTER" == "localnet" ]]; then AIRDROP_AMOUNT=10; fi
  if ! solana airdrop "$AIRDROP_AMOUNT" "$DEPLOYER_ADDRESS" --url "$RPC_URL"; then
    echo "The test-SOL faucet failed. Deployment has not been attempted." >&2
    echo "Fund test deployer $DEPLOYER_ADDRESS on $CLUSTER, then retry with SKIP_AIRDROP=1." >&2
    exit 1
  fi
fi
echo "Test deployer: $DEPLOYER_ADDRESS ($CLUSTER). Required deployment rent depends on the compiled program size."
solana balance "$DEPLOYER_ADDRESS" --url "$RPC_URL"
solana program deploy "$CONTRACT_DIR/target/deploy/safety_guard.so" \
  --program-id "$PROGRAM_KEY" --keypair "$DEPLOYER" --url "$RPC_URL"
solana program show "$(solana-keygen pubkey "$PROGRAM_KEY")" --keypair "$DEPLOYER" --url "$RPC_URL"
if [[ "$CLUSTER" == "localnet" ]]; then
  echo "Deployment finished. Run npm --prefix ../chain run verify:local to verify the full workflow."
else
  echo "Deployment finished. Run npm --prefix ../chain run verify:devnet to verify the full workflow."
fi
