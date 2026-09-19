#!/usr/bin/env bash
set -euo pipefail
source /root/.local/share/safety-guard-env.sh
GUARD_SOURCE="/mnt/c/Users/20120/Desktop/HTN/safety-guard"
GUARD_WORK="/root/safety-guard"
test -f "$GUARD_WORK/.deployment-workspace" || { echo 'Missing recognized Linux workspace.' >&2; exit 1; }
case "${1:-build}" in
  build)
    rsync -a --exclude=node_modules --exclude=target --exclude=.keys --exclude=deployment.json --exclude=deployment-v2.json --exclude=Anchor.toml --exclude=programs/safety-guard/src/lib.rs "$GUARD_SOURCE/contracts/" "$GUARD_WORK/contracts/"
    rsync -a --exclude=node_modules "$GUARD_SOURCE/chain/" "$GUARD_WORK/chain/"
    cd "$GUARD_WORK"
    npm ci --prefix chain
    npm --prefix chain run setup:v2
    bash contracts/scripts/build-v2.sh
    ;;
  local)
    cd "$GUARD_WORK"
    mkdir -p artifacts
    if ! curl --fail --silent http://127.0.0.1:8899/health | grep -q '^ok'; then
      nohup solana-test-validator --ledger "$GUARD_WORK/test-ledger-v2" --bind-address 127.0.0.1 --rpc-port 8899 --quiet > artifacts/validator-v2.log 2>&1 < /dev/null &
      echo "$!" > artifacts/validator-v2.pid
      for attempt in $(seq 1 30); do
        if curl --fail --silent http://127.0.0.1:8899/health | grep -q '^ok'; then break; fi
        sleep 1
      done
    fi
    bash contracts/scripts/deploy-v2-local.sh
    GUARD_V2_VERIFICATION_REPORT="$GUARD_WORK/artifacts/verification.v2.localnet.json" npm --prefix chain run verify:v2:local
    cp artifacts/verification.v2.localnet.json "$GUARD_SOURCE/docs/deployment/verification.v2.localnet.json"
    cp contracts/deployment-v2.json "$GUARD_SOURCE/contracts/deployment-v2.json"
    ;;
  *) echo 'Use build or local.' >&2; exit 1 ;;
esac
