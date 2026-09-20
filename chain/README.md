# StillHere chain client

This package builds unsigned Solana transactions. It is compatible with wallets that support legacy `@solana/web3.js` v1 transactions. The code imports `Buffer` explicitly for browser bundlers. It does not manage keys, request wallet connection, or submit transactions automatically.

```ts
import { Connection, PublicKey } from '@solana/web3.js';
import { SafetyGuardClient, randomTripId, tripIdToHex } from './src/index';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const client = new SafetyGuardClient(connection, new PublicKey(deployedProgramId));
if (!(await client.isProgramDeployed())) throw new Error('Deploy StillHere first.');
const tripId = randomTripId();
const reference = { rider: riderWallet.publicKey, guardian: guardianPublicKey, tripId };
const tx = client.createTask({ ...reference, deadline: Math.floor(Date.now() / 1000) + 3600 });
const prepared = await client.prepareTransaction(tx, riderWallet.publicKey);
const signed = await riderWallet.signTransaction(prepared.transaction);
const signature = await connection.sendRawTransaction(signed.serialize());
const confirmed = await connection.confirmTransaction({
  signature,
  blockhash: prepared.blockhash,
  lastValidBlockHeight: prepared.lastValidBlockHeight,
}, 'confirmed');
if (confirmed.value.err) throw new Error('Chain transaction failed.');
// Save this random reference with the private trip data after confirmation.
const publicTripReference = tripIdToHex(tripId);
```

Use the guardian wallet for `acceptTask(reference)` and `checkIn(reference)`. Use the rider wallet for `completeTask(reference)` and `cancelTask(reference)`. Each method returns a new unsigned `Transaction`; prepare and sign it with the appropriate wallet using the same sequence. Completion also needs the guardian public key to derive the reputation account.

`fetchTask({rider, tripId})` returns `null` until the account exists, or a decoded task whose `state` is `pending`, `active`, `completed`, or `cancelled`. All timestamps are Unix seconds. `fetchReputation(guardian)` returns `null` until the first reward, or `{guardian, points, completedTasks, bump}`. Points and completed-task counts are `bigint`; convert them to strings before JSON serialization.

Helpers: `randomTripId`, `tripIdToHex`, `tripIdFromHex`, `deriveTaskAddress`, `deriveReputationAddress`, `decodeTask`, and `decodeReputation`. Always pass a configured deployed program ID to both the client and standalone PDA helpers when overriding the source default.

Chain transaction signatures should be displayed as pending until RPC confirmation succeeds. A failed wallet prompt, expired blockhash, rejected instruction, or unavailable RPC is not a completed commitment. Keep off-chain trip monitoring operational while reporting the chain status separately.

Run `npm test` and `npm run typecheck` here. Deployment setup and real RPC verification scripts are documented in [`../contracts/README.md`](../contracts/README.md).

## Verifying a deployed test program

After deployment, run `npm run verify:local` or `npm run verify:devnet` in this directory. These scripts create temporary rider, guardian, and outsider wallets, exercise create/accept/check-in/complete/cancel, and assert that unauthorized acceptance, duplicate rewards, and reuse of terminal tasks fail. Participant private keys stay in process memory and are discarded on exit; any leftover test SOL is not recovered. Only the hard-coded localhost and official Devnet RPC endpoints are supported.

By default the script requests one test SOL airdrop for each participant. Devnet faucets can rate-limit requests. To avoid three new faucet requests, explicitly select the isolated deployer created by this project's setup script using `GUARD_TEST_FUNDER_KEYPAIR`. The script accepts only this project's `contracts/.keys/deployer.json`, never a default CLI wallet or another wallet path. It checks the RPC genesis before reading the key, then transfers **0.05 test SOL to each of the three participants** in one transaction. The deployer needs at least **0.15001 test SOL remaining after deployment**. No funds are requested on Mainnet or Testnet.

Run these commands in Ubuntu/WSL from `safety-guard/chain`:

```bash
# Optional explicit program ID; omit after the setup script updates the source.
export SOLANA_PROGRAM_ID="YOUR_DEPLOYED_PROGRAM_ID"

# Devnet: use only the project's isolated test deployer.
GUARD_TEST_FUNDER_KEYPAIR=../contracts/.keys/deployer.json \
GUARD_VERIFICATION_REPORT=reports/verification.devnet.json \
npm run verify:devnet

# Local validator: the built-in faucet needs no deployer key.
GUARD_VERIFICATION_REPORT=reports/verification.localnet.json npm run verify:local

# Optional local deployer funding: local validators have their own genesis hash.
GUARD_LOCALNET_GENESIS_HASH="$(solana genesis-hash --url http://127.0.0.1:8899)" \
GUARD_TEST_FUNDER_KEYPAIR=../contracts/.keys/deployer.json \
GUARD_VERIFICATION_REPORT=reports/verification.localnet.json \
npm run verify:local
```

`GUARD_LOCALNET_GENESIS_HASH` is required only when using a deployer on localnet; it must match the running validator. Devnet always requires its known genesis hash. Resetting a local validator may change its genesis, so obtain the hash again after a reset.

`GUARD_VERIFICATION_REPORT` optionally writes a public JSON report. Its filename must contain the selected cluster as a separate component, such as `verification.localnet.json` or `verification.devnet.json`, and must not contain the other cluster. Reusing the same path replaces that cluster's earlier report. The report records public participant/program/account addresses, cluster and genesis, confirmed funding and program transaction signatures, rejected-operation results, and final reputation counters. Rejected simulations do not have confirmed transaction signatures. No private keys, wallet file contents, or trip details are included. Reports update during execution; only `status: "passed"` together with `verified: true` means the complete run passed. A failed or interrupted run is not successful verification, and these reports do not certify real-world safety or production readiness.
