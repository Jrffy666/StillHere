# Deploy Safety Guard to Solana Devnet

> This guide documents the preserved **V1** deployment. New integrated journeys use **V2**, program `23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb`. See [OPERATIONS.md](OPERATIONS.md) for current hosting, [ARCHITECTURE_V2.md](ARCHITECTURE_V2.md) for the design, and [V2 Devnet evidence](deployment/verification.v2.devnet.json). V2 scripts are `chain/scripts/setup-v2.ts`, `contracts/scripts/build-v2.sh`, `contracts/scripts/deploy-v2-devnet.sh`, and `chain/scripts/verify-v2.ts`.

The separate community program publishes mandatory guarding history, contributions and appreciation. Its deployment procedure appears at the end of this guide; [COMMUNITY_LEDGER.md](COMMUNITY_LEDGER.md) is the canonical reference for its rules, provenance and release evidence.

The deployment toolchain is installed, the Solana SBF binary and IDL have built successfully, and both the local-validator and Devnet transaction workflows have passed. The program is deployed on Devnet; browser-wallet interaction and website hosting are separate checks. Start with a local validator, then use Devnet. Devnet is a public development blockchain using test SOL; no purchase of real SOL is required. The website can remain local while its wallets submit Devnet transactions.

Current deployment artifacts and public addresses:

| Item | Value |
| --- | --- |
| Program ID, localnet and Devnet | `6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK` |
| Test deployer public address | `AHdX6zJn3xYQXCBix3TvEqXUyV9x8PdPcEstsCkyhdE8` |
| Built SBF SHA-256 | `3498385acf3b75e857220f9676e3bb374d047da01b2558ffcb585c53d5232fda` |

The [program is executable on Devnet](https://explorer.solana.com/address/6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK?cluster=devnet). The [deployment receipt](deployment/deployment.devnet.json) records slot 500893192 and confirms that the downloaded on-chain bytecode matches the built SHA-256 above. The [Devnet verification report](deployment/verification.devnet.json) passed at 2026-09-19T14:11:03.558Z, with 7 confirmed transactions, 6 expected signed-simulation rejections, exactly 10 guardian points, and 1 completed task.

The [completion transaction](https://explorer.solana.com/tx/55GTQfXib8QTN6xV7ccc2nX8DiHCWea62TpZxLSw6x2Y1uuuaV69FhveautRRwq7r79AS9k54Now6Ehe6JmdVQJL?cluster=devnet) is public. The [status snapshot](deployment/status.json), recorded at 2026-09-19T14:11:16.977Z, independently records an executable program and a passed workflow. Its remaining deployer balance was 3.615447520 test SOL after funding, deployment, and verification; this timestamped balance is not a fixed deployment cost.

## 1. Install Ubuntu on Windows

On a new Windows machine, install the dedicated distribution from an administrator PowerShell terminal:

```powershell
wsl --install -d Ubuntu-24.04
```

Follow any installation or restart prompts. On this development machine, installation has succeeded, the distribution reports Ubuntu 24.04.5, and commands run as the Linux `root` user. Open that same environment explicitly:

```powershell
wsl -d Ubuntu-24.04 -u root
```

Source: [Microsoft WSL installation](https://learn.microsoft.com/en-us/windows/wsl/install).

## 2. Install and check the Linux tools

The reproducible base-toolchain installer is [scripts/bootstrap-solana-wsl.sh](../scripts/bootstrap-solana-wsl.sh). It expects Linux `root` on x86-64 in the project's dedicated Ubuntu WSL environment. Run it from Windows PowerShell:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/bootstrap-solana-wsl.sh
```

The installer adds the required Ubuntu build packages and pins these tools:

| Tool | Version | Installation location |
| --- | --- | --- |
| Node.js | 24.14.1 | `/opt/safety-guard/node-v24.14.1-linux-x64/` |
| Host Rust | 1.94.1 | Root's rustup toolchain under `/root/.cargo/` and `/root/.rustup/` |
| Agave / Solana CLI | 4.1.2 | Root's Solana installation under `/root/.local/share/solana/` |
| Anchor CLI | 0.32.1 | `/root/.local/bin/anchor`, installed by the later `prepare` phase |
| SBF platform-tools | v1.56 | Requested during the contract build, with architecture `v3` |

The script verifies the Node archive against its published SHA-256 list and writes an environment file. After bootstrap succeeds, source that file in every interactive Ubuntu terminal:

```bash
source /root/.local/share/safety-guard-env.sh
node --version
node -p process.platform
rustc --version
solana --version
```

Verified installed: Node v24.14.1, platform `linux`, Rust 1.94.1, Solana CLI 4.1.2, and Anchor CLI 0.32.1. Use Linux dependencies in the Linux deployment copy; do not use Windows Node or Windows-installed `node_modules`. This bootstrap changes the dedicated Ubuntu environment, including its root Rust default, rather than the Windows installation or Docker's WSL distribution.

Host Rust and the compiler used by `cargo build-sbf` are distinct. The repository's [contracts/scripts/build.sh](../contracts/scripts/build.sh) keeps the SBF build and host IDL compilation separate:

```bash
anchor build --no-idl -- --tools-version v1.56 --arch v3
mkdir -p target/idl target/types
RUSTUP_TOOLCHAIN=1.94.1 anchor idl build -o target/idl/safety_guard.json -t target/types/safety_guard.ts
```

The first command builds the Solana binary. The second Anchor command pins host Rust 1.94.1 and generates the IDL without forwarding SBF-only arguments into IDL compilation. Both steps have succeeded with this configuration. Compilation does not by itself establish passing on-chain transactions; validator verification remains a separate check.

References: [Anchor 0.32.1](https://www.anchor-lang.com/docs/updates/release-notes/0-32-1), [host Rust requirement](https://www.anchor-lang.com/docs/updates/release-notes/0-32-0), [Solana toolchain compatibility](https://github.com/solana-foundation/solana-dev-skill/blob/main/skills/solana-dev/references/compatibility-matrix.md).

## 3. Prepare the isolated Linux workspace

After bootstrap succeeds, use [scripts/solana-wsl.sh](../scripts/solana-wsl.sh). From Windows PowerShell:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/solana-wsl.sh prepare
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/solana-wsl.sh status
```

`prepare` performs the following:

- Creates `/root/safety-guard` and a `.deployment-workspace` marker. It refuses to modify an existing directory without that marker.
- Installs the [Anchor 0.32.1 Linux release executable](https://github.com/otter-sec/anchor/releases/download/v0.32.1/anchor-0.32.1-x86_64-unknown-linux-gnu) under `/root/.local/bin/anchor` if absent. The build script requires `anchor-cli 0.32.1`.
- Copies `contracts/` and `chain/` with `rsync`, excluding `node_modules`, `target`, and `.keys`, then installs Linux chain dependencies.
- Generates isolated test deployment keys and synchronizes the program ID in the Linux copy. It preserves existing deployment keys on later runs.
- Restricts key permissions and creates or checks the backup `contracts/.keys/program-backup.json`.

The helper sources `/root/.local/share/safety-guard-env.sh` itself. Its stages are `prepare`, `build`, `local`, `devnet-fund`, `devnet`, `verify-devnet`, and `status`. `status` prints tool versions and, after preparation, the public program ID. Neither `prepare` nor `status` deploys anything. This Linux directory is a source snapshot; rerun `prepare` deliberately after source changes rather than mixing Windows and Linux dependencies.

## 4. Build and verify on the local validator

From Windows PowerShell:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/solana-wsl.sh build
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/solana-wsl.sh local
```

`build` runs the separate SBF/IDL steps and prints a SHA-256 digest of `contracts/target/deploy/safety_guard.so` if compilation succeeds. `local` starts a local validator when needed, using `/root/safety-guard/test-ledger` and loopback RPC port 8899, then builds/deploys the program and runs the transaction verification script. The local deployment requests 10 test SOL from the local faucet; the Devnet request is 2 test SOL.

Validator output is written to `/root/safety-guard/artifacts/validator.log`. The completed local run wrote `/root/safety-guard/artifacts/verification.localnet.json` with `status: passed` and `verified: true`. The [exported public verification report](deployment/verification.localnet.json) records 9 confirmed transactions (3 airdrops and 6 program transactions), 6 expected rejection checks, and a guardian account with exactly 10 points and one completed task. Local validator genesis: `7o7dDFsXPTFxqwPWfDYbkZXK5U9mvUevZrKYxKGHumN3`.

The verification submits real local-validator transactions for create, accept, check-in, complete, and cancel. It checks the 10-point reward and rejects unauthorized participation, completion without a check-in, duplicate rewards, and reuse of terminal tasks. Build or verification errors stop the flow; resolve them before using Devnet.

Keep `contracts/.keys/deployer.json`, `contracts/.keys/program-backup.json`, and `contracts/target/deploy/safety_guard-keypair.json` private and backed up. Do not delete `target` after deployment without preserving the program key. No private key needs to be pasted into the website or chat.

## 5. Deploy and verify on Devnet

For a new deployment after local validation succeeds, use the helper from Windows PowerShell. The program identified above is already deployed; use `verify-devnet` below to check it again without redeploying:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/solana-wsl.sh devnet-fund
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/solana-wsl.sh devnet
```

Both stages verify the RPC genesis hash before using the project test wallet. `devnet-fund` requests 2 test SOL from the public faucet, which may rate-limit requests. If necessary, use the official [Devnet faucet](https://faucet.solana.com/) with the deployer public address shown above. This deployment proceeded after 5 Devnet SOL was available in the test wallet. Never provide a private key or buy real SOL for this workflow.

`devnet` uses the existing funded deployer and skips another airdrop. After deployment, it runs the verification script with `GUARD_TEST_FUNDER_KEYPAIR` pointing to this project's test deployer. That mode transfers 0.05 test SOL to each of three temporary participant wallets instead of making three further faucet requests. The completed workflow wrote `/root/safety-guard/artifacts/verification.devnet.json`; the [public copy](deployment/verification.devnet.json) records the passing result.

If an RPC failure interrupts verification after deployment, rerun verification without rebuilding or redeploying:

```powershell
wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/20120/Desktop/HTN/safety-guard/scripts/solana-wsl.sh verify-devnet
```

Every verification run creates three new temporary wallets and transfers 0.05 test SOL to each (0.15 total), plus transaction fees. Their private keys are discarded when the process exits; leftover participant test funds are not recovered. Retrying therefore consumes additional test funds. The script paces RPC calls and retries transient failures, but an incomplete report is not a passing run.

For manual operation, open Ubuntu as root, source the environment, and enter the prepared Linux contract directory:

```bash
source /root/.local/share/safety-guard-env.sh
cd /root/safety-guard/contracts
bash scripts/deploy.sh devnet
npm --prefix ../chain run verify:devnet
```

The program ID identifies the deployed contract. The verification output also contains a completion transaction signature and a task account address. Inspect them on [Solana Explorer](https://explorer.solana.com/?cluster=devnet) with Devnet selected.

The script initially requests 2 test SOL. This may be insufficient for deployment rent, which depends on the compiled program size. The public faucet may also rate-limit requests. Display the deployer address and balance with:

```bash
solana-keygen pubkey .keys/deployer.json
solana balance --keypair .keys/deployer.json --url devnet
```

After obtaining enough Devnet SOL for that address, retry without requiring another airdrop:

```bash
SKIP_AIRDROP=1 bash scripts/deploy.sh devnet
```

The manual verification command above requests funds for three new test wallets by default, so faucet failures can block it even after successful deployment. The helper's `devnet` stage avoids those requests by funding them from the project test deployer. A faucet error is not proof of a contract error or successful validation. Never substitute real SOL or mainnet for a development faucet.

## 6. Connect the existing Windows application

In a fresh Windows checkout, add these settings to `worker/.dev.vars` to use the verified Devnet program. Preserve any existing values in that file.

```dotenv
SOLANA_PROGRAM_ID=6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK
SOLANA_RPC_URL=https://api.devnet.solana.com
```

The current local application is already configured: both the backend and frontend proxy returned this Devnet program in `/api/config`, as recorded in [application.local.json](deployment/application.local.json) at 2026-09-19T14:12:21.0944008Z. Restart the app after changing `.dev.vars`; its `/api/config` response should report the configured program ID; the wallet panel also checks that an executable program exists before constructing transactions. The frontend reads this backend setting, so `VITE_SOLANA_PROGRAM_ID` is not used. There is no need to copy deployment private keys to the Windows app.

Use separate rider and guardian test wallets, select Devnet, and obtain test SOL for both. In **View contribution**, connect the rider wallet, enter the guardian's public address, and create a receipt. Share the public reference fields with the guardian. The guardian reads the task, accepts, and checks in; the rider then confirms completion. Verify the displayed confirmed state and the guardian's 10 chain points.

Guest app identities remain separate from wallets. App arrival and app rewards do not automatically become blockchain transactions. This workflow records only signed commitments and completion; private routes, contacts, and chat stay off chain.

## Completion evidence

- A successful SBF build and a passing local validator workflow.
- A program ID with an executable deployment visible on Devnet.
- A passing Devnet workflow with confirmed transaction signatures and on-chain account reads.
- A browser workflow with two test wallets, confirmed completion, and exactly one 10-point reward.

Cloudflare authentication and online website hosting are separate tasks. They are not prerequisites for submitting Devnet transactions from the local website.

## Community ledger deployment

The community ledger is a separate Devnet program with its own program identity, issuer and sponsor. Preserve the V1 and V2 addresses and keys. Prepare the community artifact in the isolated Linux deployment copy with the existing Linux toolchain:

```bash
npm --prefix chain run setup:community
bash contracts/scripts/build-community.sh
```

Setup preserves existing identities, refuses inconsistent key replacements and writes public metadata to `contracts/deployment-community.json`. Keep the generated program, issuer and sponsor keys and the separate administrator key private and backed up. Deploy `contracts/target/deploy/community_ledger.so` to the program address in that metadata using the program key and the separate deployment administrator.

Before enabling the hosted publisher, fund the sponsor with Devnet SOL for transaction fees and account storage, initialize the on-chain configuration with the intended issuer and sponsor, and verify the executable program and configuration. The test verifier can initialize an absent configuration using the program upgrade authority. In the isolated deployment environment, set `COMMUNITY_TEST_ADMIN_KEYPAIR` to the private administrator key file and run `npm --prefix chain run verify:community:devnet`. This submits synthetic transactions and exercises administrative changes; use it before opening traffic, retain its report, and verify the final authorities. A build or configuration file alone does not establish a successful deployment.

Configure the selected Worker environment with `COMMUNITY_ENABLED="true"` and the distinct `COMMUNITY_PROGRAM_ID`. Preserve the `COMMUNITY` binding to `CommunityLedger` and its additive `v3` SQLite migration. Store the dedicated issuer and sponsor keypair JSON as Worker secrets, using secure prompts from `worker/`:

```text
npx wrangler secret put COMMUNITY_ISSUER_SECRET_KEY --env production
npx wrangler secret put COMMUNITY_SPONSOR_SECRET_KEY --env production
```

Use independent environment credentials. The Worker must never receive the administrator or deployment private key. The issuer and sponsor must be distinct and match the program configuration. Staging may keep `COMMUNITY_ENABLED="false"`; publication intents remain pending until a publisher is configured.

Run `node scripts/deploy.mjs check --env production` before the normal Worker deployment command in [OPERATIONS.md](OPERATIONS.md). Preflight requires the community binding and migration, an explicit activation flag, and a valid nonzero program address distinct from V1/V2 when enabled. Applying a deployment also checks remote operator, issuer and sponsor secret names. Those metadata checks do not prove key correctness, sponsor funding, RPC connectivity or finalized publication.

Verify a walletless synthetic journey through creation, accepted relay, closure and a free banner. Confirm that pending records become finalized platform attestations without a second contribution award, then inspect their public receipts. Participants pay no fee; the sponsor covers publication. Help and closure remain usable while publication is pending. Record exact program, Worker and frontend deployment identifiers and verification results in the [community release evidence](COMMUNITY_LEDGER.md#release-evidence) before claiming that this release is live.

For hosted verification, set `GUARD_TEST_ORIGIN` to the Worker or frontend origin and `SOLANA_RPC_URL` to the intended Devnet endpoint, then run:

```text
npm --prefix chain run verify:community:hosted
```

An owner-only frontend requires `GUARD_TEST_GATEWAY_TOKEN`. Set `GUARD_TEST_OPERATOR_SECRET` and `GUARD_COMMUNITY_ADMIN_KEYPAIR` only when exercising the administrator-signed correction flow, and use `GUARD_COMMUNITY_REPORT` for the report destination. Supply credentials through the process environment or secret manager, never command arguments or committed files. The verifier uses synthetic sessions and cleans up private test data; public Devnet receipts remain. Retain the resulting report as evidence only when the workflow passes.
