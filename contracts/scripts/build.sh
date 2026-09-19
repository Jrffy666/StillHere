#!/usr/bin/env bash
set -euo pipefail
CONTRACT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CONTRACT_DIR"
command -v anchor >/dev/null || { echo "Install Anchor CLI 0.32.1." >&2; exit 1; }
if [[ "$(anchor --version)" != "anchor-cli 0.32.1" ]]; then
  echo "This project requires Anchor CLI 0.32.1." >&2
  exit 1
fi
# Separate SBF arguments from the host IDL compiler arguments.
anchor build --no-idl -- --tools-version v1.56 --arch v3
mkdir -p target/idl target/types
RUSTUP_TOOLCHAIN=1.94.1 anchor idl build -o target/idl/safety_guard.json -t target/types/safety_guard.ts
