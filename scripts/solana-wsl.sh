#!/usr/bin/env bash
set -euo pipefail
source /root/.local/share/safety-guard-env.sh
GUARD_SOURCE="/mnt/c/Users/20120/Desktop/HTN/safety-guard"
GUARD_WORK="/root/safety-guard"
PHASE="${1:-status}"
if [[ -d "$GUARD_WORK" && ! -f "$GUARD_WORK/.deployment-workspace" ]]; then
  echo "Refusing to modify an unrecognized existing Linux workspace." >&2
  exit 1
fi
case "$PHASE" in
  prepare)
    mkdir -p "$GUARD_WORK" /root/.local/bin
    touch "$GUARD_WORK/.deployment-workspace"
    if [[ ! -x /root/.local/bin/anchor ]]; then
      curl --fail --location --retry 3 --connect-timeout 30 --max-time 300 \
        https://github.com/otter-sec/anchor/releases/download/v0.32.1/anchor-0.32.1-x86_64-unknown-linux-gnu \
        --output /root/.local/bin/anchor.download
      chmod 755 /root/.local/bin/anchor.download
      /root/.local/bin/anchor.download --version
      mv /root/.local/bin/anchor.download /root/.local/bin/anchor
    fi
    rsync -a --exclude=node_modules --exclude=target --exclude=.keys \
      "$GUARD_SOURCE/contracts" "$GUARD_SOURCE/chain" "$GUARD_WORK/"
    cd "$GUARD_WORK"
    npm ci --prefix chain
    npm --prefix chain run setup
    mkdir -p artifacts
    chmod 700 contracts/.keys
    chmod 600 contracts/.keys/deployer.json contracts/target/deploy/safety_guard-keypair.json
    if [[ -f contracts/.keys/program-backup.json ]]; then
      test "$(solana-keygen pubkey contracts/.keys/program-backup.json)" = "$(solana-keygen pubkey contracts/target/deploy/safety_guard-keypair.json)"
    else
      cp contracts/target/deploy/safety_guard-keypair.json contracts/.keys/program-backup.json
      chmod 600 contracts/.keys/program-backup.json
    fi
    echo "Prepared an isolated Linux deployment workspace. No deployment was submitted."
    ;;
  build)
    cd "$GUARD_WORK/contracts"
    bash scripts/build.sh
    sha256sum target/deploy/safety_guard.so
    ;;
  local)
    cd "$GUARD_WORK"
    mkdir -p artifacts
    if ! curl --fail --silent http://127.0.0.1:8899/health | grep -q '^ok'; then
      nohup solana-test-validator --ledger "$GUARD_WORK/test-ledger" \
        --bind-address 127.0.0.1 --rpc-port 8899 --quiet \
        > "$GUARD_WORK/artifacts/validator.log" 2>&1 < /dev/null &
      echo "$!" > artifacts/validator.pid
      for attempt in $(seq 1 30); do
        if curl --fail --silent http://127.0.0.1:8899/health | grep -q '^ok'; then break; fi
        sleep 1
      done
    fi
    curl --fail --silent http://127.0.0.1:8899/health
    cd contracts
    bash scripts/deploy.sh localnet
    GUARD_VERIFICATION_REPORT="$GUARD_WORK/artifacts/verification.localnet.json" npm --prefix ../chain run verify:local
    ;;
  devnet-fund|devnet|verify-devnet)
    cd "$GUARD_WORK/contracts"
    GUARD_RPC="https://api.devnet.solana.com"
    GUARD_GENESIS="$(solana genesis-hash --url "$GUARD_RPC")"
    if [[ "$GUARD_GENESIS" != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ]]; then
      echo "Unexpected network genesis. Refusing test-wallet use." >&2
      exit 1
    fi
    if [[ "$PHASE" == "devnet-fund" ]]; then
      GUARD_ADDRESS="$(solana-keygen pubkey .keys/deployer.json)"
      solana airdrop 2 "$GUARD_ADDRESS" --url "$GUARD_RPC"
      solana balance "$GUARD_ADDRESS" --url "$GUARD_RPC"
    else
      if [[ "$PHASE" == "devnet" ]]; then SKIP_AIRDROP=1 bash scripts/deploy.sh devnet; fi
      cd ../chain
      GUARD_TEST_FUNDER_KEYPAIR=../contracts/.keys/deployer.json \
        GUARD_VERIFICATION_REPORT="$GUARD_WORK/artifacts/verification.devnet.json" \
        npm run verify:devnet
    fi
    ;;
  status)
    node --version
    rustc --version
    solana --version
    anchor --version
    if [[ -f "$GUARD_WORK/contracts/target/deploy/safety_guard-keypair.json" ]]; then
      solana-keygen pubkey "$GUARD_WORK/contracts/target/deploy/safety_guard-keypair.json"
    fi
    ;;
  *) echo "Supported phases: prepare, build, local, devnet-fund, devnet, verify-devnet, status." >&2; exit 1 ;;
esac
