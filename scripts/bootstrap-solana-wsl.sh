#!/usr/bin/env bash
set -euo pipefail
# Run explicitly in the project's Ubuntu WSL distribution as root.
if [[ "$(id -u)" != "0" || "$(uname -m)" != "x86_64" ]]; then
  echo "This bootstrap expects root in x86_64 Ubuntu WSL." >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git rsync \
  build-essential pkg-config libssl-dev libudev-dev clang llvm cmake \
  protobuf-compiler libclang-dev bzip2 xz-utils unzip
GUARD_DOWNLOADS="/root/.cache/safety-guard-tools"
GUARD_NODE_VERSION="24.14.1"
mkdir -p "$GUARD_DOWNLOADS" /root/.local/bin
cd "$GUARD_DOWNLOADS"
if [[ ! -x "/opt/safety-guard/node-v${GUARD_NODE_VERSION}-linux-x64/bin/node" ]]; then
  curl --fail --location --retry 3 --connect-timeout 30 \
    "https://nodejs.org/dist/v${GUARD_NODE_VERSION}/node-v${GUARD_NODE_VERSION}-linux-x64.tar.xz" \
    --output "node-v${GUARD_NODE_VERSION}-linux-x64.tar.xz"
  curl --fail --location --retry 3 --connect-timeout 30 \
    "https://nodejs.org/dist/v${GUARD_NODE_VERSION}/SHASUMS256.txt" --output node-shasums.txt
  awk -v file="node-v${GUARD_NODE_VERSION}-linux-x64.tar.xz" '$2 == file' node-shasums.txt > node-checksum.txt
  test -s node-checksum.txt
  sha256sum --check node-checksum.txt
  mkdir -p /opt/safety-guard
  tar -xJf "node-v${GUARD_NODE_VERSION}-linux-x64.tar.xz" -C /opt/safety-guard
fi
export PATH="/opt/safety-guard/node-v${GUARD_NODE_VERSION}-linux-x64/bin:/root/.local/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:$PATH"
if [[ ! -x /root/.cargo/bin/rustup ]]; then
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --connect-timeout 30 \
    https://sh.rustup.rs --output rustup-install.sh
  sh rustup-install.sh -y --profile minimal --default-toolchain 1.94.1
else
  rustup toolchain install 1.94.1 --profile minimal
  rustup default 1.94.1
fi
if ! solana --version 2>/dev/null | grep -q 'solana-cli 4.1.2'; then
  curl --fail --location --retry 3 --connect-timeout 30 \
    https://release.anza.xyz/v4.1.2/install --output agave-install.sh
  sh agave-install.sh
fi
# Anchor is installed separately from its verified official release asset.
cat > /root/.local/share/safety-guard-env.sh <<'ENV'
export PATH="/opt/safety-guard/node-v24.14.1-linux-x64/bin:/root/.local/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:$PATH"
ENV
node --version
node -p process.platform
rustc --version
solana --version
echo "Base toolchain installed. Source /root/.local/share/safety-guard-env.sh in subsequent shells."
