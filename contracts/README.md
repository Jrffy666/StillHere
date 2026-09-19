# Safety Guard Solana program

This is the blockchain component of Safety Guard. A Solana program is shared code executed by the network. Each guarding commitment is stored in a program-derived account (PDA), whose address is deterministically calculated from the rider wallet and a random trip ID. The program checks signatures and state transitions before changing these accounts.

The rider and guardian use separate wallets. The app never needs either wallet's private key. In this first version, points are non-transferable counters, not tokens or money. There is no escrow, deposit, payment, token mint, withdrawal, or AI wallet. Transactions still require small network fees and account rent in test SOL.

## What is implemented

| Instruction | Required signer | Effect |
| --- | --- | --- |
| `create_task(trip_id, deadline)` | Rider | Creates a pending commitment to a designated guardian. Deadline must be within 24 hours. |
| `accept_task()` | Designated guardian | Accepts a pending task before its deadline. |
| `check_in()` | Designated guardian | Records activity on an active, unexpired task. Subsequent check-ins require a 15 second gap. |
| `complete_task()` | Rider | Confirms an active task after at least one check-in and awards the guardian exactly 10 points. Late arrival confirmation is allowed. |
| `cancel_task()` | Rider | Cancels pending or active tasks, including expired tasks, without awarding points. |

Completed and cancelled accounts stay on chain. They cannot be closed, reset, accepted again, or rewarded again. Rider and guardian public keys must differ. A guardian cannot award points to themselves or cancel the rider's commitment. The rider pays the reputation account's rent on that guardian's first completion.

## Privacy and trust boundaries

Only wallet public keys, a cryptographically random 32-byte trip ID, timestamps, counts, and state go on chain. Never use an Uber URL, location, name, phone, or an unsalted hash of those values as the trip ID. Public keys and transaction timing remain publicly linkable.

Live location, messages, check-in reminders, incidents, notifications, and AI handoffs run off chain. AI can continue those services without a blockchain transaction. It cannot impersonate a guardian, sign a guardian check-in, or confirm the rider's arrival. If a guardian completed no signed check-in before handoff, no on-chain reward can be settled for that task.

The ledger proves who signed and what transitions occurred; it cannot prove that a human was awake, that a ride was safe, or that two distinct addresses belong to different people. Two colluding wallets can farm points. These points have no financial value, and production reputation needs abuse controls, identity/trust signals, and dispute policy. A rider can cancel even after a guardian has worked; version one deliberately gives the rider control and does not settle compensation disputes.

## Run the checks that do not require a blockchain

Requirements: Rust and Node.js 22 or later.

```sh
# From safety-guard/contracts
cargo test --workspace
cargo fmt --all -- --check

# From safety-guard/chain
npm ci
npm test
npm run typecheck
```

Rust tests cover transitions, invalid input, expiry, rate limits, single-use reward, overflow, account sizes, and signer/account constraints. TypeScript tests cover instruction bytes, signers, PDA derivation, decoders, validation, and account ownership. These are host-side tests, not a substitute for a validator execution.

## Build and deploy to a local validator

Windows users use the project's dedicated `Ubuntu-24.04` WSL distribution. It is now installed on the development machine, reports Ubuntu 24.04.5, and supports commands as Linux `root`. The [bootstrap script](../scripts/bootstrap-solana-wsl.sh) installs Node 24.14.1, host Rust 1.94.1, Agave/Solana CLI 4.1.2, and system build dependencies into that environment. These tools and Anchor CLI 0.32.1 have now been installed and their versions checked.

After bootstrap succeeds, [scripts/solana-wsl.sh](../scripts/solana-wsl.sh) provides `prepare`, `build`, `local`, `devnet-fund`, `devnet`, `verify-devnet`, and `status` stages. It uses the marked deployment workspace `/root/safety-guard`, copies only the contract/client sources, preserves deployment keys and Windows dependencies, and sources `/root/.local/share/safety-guard-env.sh`. Its `prepare` stage installs the Anchor 0.32.1 release executable under `/root/.local/bin/anchor`; the build script rejects other CLI versions. See the [deployment walkthrough](../docs/DEPLOYMENT.md) for exact Windows commands.

`scripts/build.sh` performs two separate steps:

```sh
anchor build --no-idl -- --tools-version v1.56 --arch v3
mkdir -p target/idl target/types
RUSTUP_TOOLCHAIN=1.94.1 anchor idl build -o target/idl/safety_guard.json -t target/types/safety_guard.ts
```

The SBF build uses platform-tools v1.56 and architecture v3. IDL generation pins host Rust 1.94.1 and runs separately so SBF arguments are not forwarded into that compilation. Host Rust updates alone do not update the SBF compiler. The SBF and IDL builds have both succeeded, and the complete local-validator and Devnet transaction workflows have passed. The downloaded Devnet bytecode also matches the built binary.

The helper's `local` stage starts the validator on loopback port 8899 and writes its log and verification report under `/root/safety-guard/artifacts/`. To run the equivalent deployment manually, use the prepared Linux copy and source the environment in each terminal.

In terminal one:

```sh
solana-test-validator
```

In terminal two, from `safety-guard/chain`, install dependencies with `npm ci`. Then from `safety-guard/contracts`:

```sh
bash scripts/deploy.sh localnet
npm --prefix ../chain run verify:local
```

The deployment script creates a new test-only deployer key under `.keys/` and a program key under `target/deploy/`; both directories are gitignored. It synchronizes the program ID in the Rust program, `Anchor.toml`, and the client, calls `scripts/build.sh` for the SBF binary and IDL, requests 10 test SOL from the local faucet, and deploys using explicit paths. It never changes your global wallet configuration or uses an existing wallet. Keep the generated program key if you need to redeploy the same address; a clean deletion of `target` will remove it.

The verification script generates temporary rider, guardian, and attacker wallets in memory. It checks create, accept, check-in, complete, a 10-point reputation increase, duplicate reward rejection, wrong-guardian rejection, terminal account reuse rejection, and cancellation. It does not save these temporary keys.

## Deploy to devnet

Devnet uses test SOL. Do not fund these keys with real SOL. From `safety-guard/contracts`:

```sh
bash scripts/deploy.sh devnet
npm --prefix ../chain run verify:devnet
```

Devnet faucets can rate-limit airdrops. If an airdrop fails, the script stops before deployment. After funding the printed deployer address with enough test SOL, run `SKIP_AIRDROP=1 bash scripts/deploy.sh devnet` to skip another faucet request. The initial 2 SOL request is not a guaranteed deployment budget: required rent depends on the compiled program size. Manual verification uses participant airdrops by default. The WSL helper's `devnet` stage instead funds three temporary wallets with 0.05 test SOL each from the isolated project deployer, then writes its verification report. The scripts intentionally do not accept mainnet or arbitrary RPC URLs. Set `SOLANA_PROGRAM_ID` on the Worker to the address printed by setup only after successful deployment, then use a devnet wallet and devnet RPC. A source ID or generated program key is not a claim of deployment.

After an RPC failure following successful deployment, use the WSL helper's `verify-devnet` phase to rerun the lifecycle verification without rebuilding or redeploying:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/solana-wsl.sh verify-devnet
```

Each run funds three new temporary participant wallets with 0.05 test SOL each, consuming 0.15 test SOL plus fees. Their private keys are discarded at exit and leftover test funds are not recovered. A failed or interrupted run is not verified, even if earlier transactions confirmed.

For the Windows/WSL walkthrough, toolchain caveats, and application configuration, see [Deployment walkthrough](../docs/DEPLOYMENT.md).

## Client integration

See [`../chain/README.md`](../chain/README.md). No Anchor JavaScript runtime is required; the small client encodes the five instructions directly with `@solana/web3.js` v1 for browser-wallet compatibility. The program remains the authority for validation.

## Current verification status

Native Rust tests, TypeScript client tests, and client typechecking passed during development. Ubuntu-24.04 and the pinned toolchain are now installed. Both the SBF v3 build and IDL generation succeeded. The built `safety_guard.so` SHA-256 is `3498385acf3b75e857220f9676e3bb374d047da01b2558ffcb585c53d5232fda`.

Program `6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK` is [deployed on Devnet](https://explorer.solana.com/address/6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK?cluster=devnet). The [deployment receipt](../docs/deployment/deployment.devnet.json) records slot 500893192 and a downloaded bytecode SHA-256 matching the build. The [local-validator report](../docs/deployment/verification.localnet.json) passed with 9 confirmed transactions and 6 expected rejection checks.

The [Devnet report](../docs/deployment/verification.devnet.json) passed at 2026-09-19T14:11:03.558Z, with 7 confirmed transactions, 6 expected signed-simulation rejections, exactly 10 guardian points, and 1 completed task. [View the completion transaction](https://explorer.solana.com/tx/55GTQfXib8QTN6xV7ccc2nX8DiHCWea62TpZxLSw6x2Y1uuuaV69FhveautRRwq7r79AS9k54Now6Ehe6JmdVQJL?cluster=devnet). The project test deployer and upgrade authority is `AHdX6zJn3xYQXCBix3TvEqXUyV9x8PdPcEstsCkyhdE8`. These are CLI/client verification results; browser-wallet interaction remains unverified.

## References

- [Anchor account constraints](https://www.anchor-lang.com/docs/references/account-constraints)
- [Anchor PDAs](https://www.anchor-lang.com/docs/basics/pda)
- [Anchor account space](https://www.anchor-lang.com/docs/references/space)
- [Solana web3.js transaction reference](https://solana-foundation.github.io/solana-web3.js/classes/Transaction.html)
