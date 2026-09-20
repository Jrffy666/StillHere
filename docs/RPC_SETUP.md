# Connect a private Devnet RPC

The hosted human-guarding application is available at [StillHere](https://safety-guard-htn2026.klavander56.chatgpt.site), with owner-only access. Its application-only approval, relay, help, and reward workflows passed five live HTTP integration tests. The separate V2 Solana program is deployed on Devnet.

A private Helius Devnet endpoint is now configured as a Cloudflare secret. All 17 hosted preparation checks passed on both the direct Worker and frontend-proxy paths, resolving the public endpoint HTTP 403 failure. The [signed hosted verification](deployment/application.v2.hosted.devnet.json) also passed: ten finalized journey transactions, successful relay and access revocation, and a single 25-point / 10-reputation reward pool. No private endpoint or API key appears in public configuration. The steps below describe setup or credential rotation. This RPC transports blockchain requests; it is separate from the deferred AI API integration.

## Obtain a free endpoint

1. Register or sign in at the [Helius dashboard](https://dashboard.helius.dev/). Choose the **Free** plan. At verification time it provides 1 million monthly credits, 10 RPC requests per second, and 1 transaction submission per second; see [current pricing](https://www.helius.dev/pricing).
2. Create an API key in the dashboard and select the **Devnet** HTTP RPC endpoint. The documented endpoint format is `https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY`; see the [Helius Devnet guide](https://demo.helius.dev/sandbox).
3. Open the local ignored file `worker/.dev.vars` and set the existing field:

```dotenv
SOLANA_PRIVATE_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY"
```

Replace the placeholder with your own key. Keep the quotes. Do not paste the full endpoint into chat, screenshots, documentation, `wrangler.jsonc`, frontend code, or version control. No real SOL purchase is required for these development-network operations.

## Configure the hosted Worker

After the field is filled, the deployment operator can run from the repository root:

```sh
node scripts/configure-rpc.mjs --env production --apply
node scripts/verify-hosted-chain-prepare.mjs --api https://safety-guard-api-production.2012044zj.workers.dev --origin https://safety-guard-htn2026.klavander56.chatgpt.site --evidence docs/evidence/hosted-chain-prepare-2026-09-20.json
```

The configuration helper checks the Devnet genesis hash before changing Cloudflare, verifies the Worker already exists in the authenticated account, and uploads the URL through standard input as the `SOLANA_PRIVATE_RPC_URL` secret. It does not print the URL. The Worker prefers this secret over its public fallback. Its public configuration response never includes the private URL, and redirects cannot carry the credential to another host.

The preparation check creates and deletes a synthetic wallet-bound account and journey. It reads the deployed program and prepares an unsigned transaction; it spends no test SOL and broadcasts no transaction. A successful preparation check is not a complete hosted signed-transaction workflow. After it passes, verify a funded Devnet journey through proposal, acceptance, relay, contribution check-ins, completion, and separate claims. Browser wallet-extension approval remains a manual acceptance check.

## Verify the hosted signed workflow

The explicit `verify:hosted:v2` command uses the existing project Devnet funder, three temporary signing wallets, and the production Worker. From this Windows project folder:

```powershell
npm.cmd --prefix chain run verify:hosted:v2 -- --apply --funder '\\wsl.localhost\Ubuntu-24.04\root\safety-guard\contracts\.keys\deployer.json' --rpc-env-file "$PWD\worker\.dev.vars" --report "$PWD\docs\deployment\application.v2.hosted.devnet.json"
```

On Linux, the funder argument must be `/root/safety-guard/contracts/.keys/deployer.json`; pass absolute paths for the RPC settings and report. The Windows command reads the same WSL project key without copying it. The script checks the exact Devnet genesis and deployed program before reading that key, and verifies the funder's expected public address. It funds each temporary wallet with 0.02 test SOL, checks actual rent requirements, and caps the funding transaction's total debit at 0.15 test SOL including its fee.

The script checks all ten transaction messages before signing, waits for finalization, tests private-access revocation and shared rewards, and deletes the three synthetic application accounts. Temporary signing keys and sessions are never written to disk. Public Devnet transactions and residual test-wallet balances remain; the report contains signatures and verification results only. Run this command deliberately: it creates real test-network records, unlike the unsigned preparation check.
