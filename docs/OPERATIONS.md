# Application operations

The application has separate frontend, Worker, and Solana releases. The code includes environment validation, deployment and rollback commands, encrypted maintenance backups, account erasure, and moderation APIs. A successful local test or dry run does not mean a hosted service has been published. Check the deployment receipts for actual network evidence.

## Environment configuration

`worker/wrangler.jsonc` defines independent `staging` and `production` Worker names and seven SQLite Durable Object bindings in each environment, including `COMMUNITY` mapped to `CommunityLedger` through the additive `v3` migration. Keep their names distinct. Never point a staging binding at a production script. Production is deployed at `https://safety-guard-api-production.2012044zj.workers.dev`; staging has configuration but has not been published. The frontend is owner-private at `https://safety-guard-htn2026.klavander56.chatgpt.site`. See the [hosting receipt](deployment/hosting.production.json) for observed checks and remaining browser-wallet acceptance. The binding configuration does not itself establish a live community-ledger release; use [COMMUNITY_LEDGER.md](COMMUNITY_LEDGER.md) for its release evidence and behavior.

Set these non-secret values in the selected environment's `vars`:

| Setting | Required value |
| --- | --- |
| `APP_ENV` | The environment name, `staging` or `production` |
| `SITE_ORIGIN` | Exact frontend HTTPS origin, without a trailing slash |
| `AUTH_DOMAIN` | The frontend hostname and optional port, matching `SITE_ORIGIN` |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTPS frontend origins, including `SITE_ORIGIN` |
| `SOLANA_NETWORK` | `devnet`; hosted mainnet operation is not implemented |
| `SOLANA_V2_PROGRAM_ID` | Separately deployed V2 program address |
| `SOLANA_PROGRAM_ID` | Existing V1 address, if retaining the legacy proof demonstration |
| `SOLANA_RPC_URL` | HTTPS Devnet RPC endpoint, without embedded username/password |
| `COMMUNITY_ENABLED` | Explicit `true` or `false`; disabled staging is supported |
| `COMMUNITY_PROGRAM_ID` | When enabled, a valid separate Devnet program address, distinct from V1/V2 |
| `RESTORE_ALLOWED` | `false`; temporarily `true` only for an isolated recovery environment |
| `NOTIFICATIONS_ENABLED` | `false` for the current human guarding release |

The browser never receives the operator secret, backup key, or a wallet private key. The frontend server's `GUARD_API_ORIGIN` must point to the deployed Worker. Do not publish a frontend proxy configured with `localhost`.

The companion currently uses the [offline mock harness](AGENT_HARNESS.md). Public configuration must report `ai.provider: "mock"`, `ai.configured: false`, and `ai.liveModel: false`. The runtime makes no language-model API calls, even if an old `OPENAI_API_KEY` secret exists. This release has no switch to enable a paid provider. Restoring a backup discards agent runs and follow-ups, preserving the existing rule that restored journeys cannot restart monitoring.

For a provider endpoint containing an API key, use the optional server secret `SOLANA_PRIVATE_RPC_URL`, not the public Wrangler configuration. Follow [RPC_SETUP.md](RPC_SETUP.md). The Worker uses this override for V2 requests and keeps its public configuration on the known public Devnet URL. The private Helius Devnet RPC is configured and passed hosted preparation. A configuration-readiness response alone does not establish RPC connectivity; rerun the preparation check after rotating the endpoint.

The initial production operator credential is stored locally in the ignored file `.dev/deploy/production-operator-secret.txt` and in Cloudflare Secrets. Keep that local file private and back it up securely. It is not included in the frontend source or publication archive.

Configure a random operator secret of at least 32 characters through Wrangler's secure prompt, from `worker/`:

```text
npx wrangler login
npx wrangler secret put OPERATOR_SECRET --env staging
npx wrangler secret put OPERATOR_SECRET --env production
```

Use separate secrets for the two environments. Do not place secret values in shell command arguments, source files, screenshots, or CI output. The deployed secret is checked by `/api/ready`; an unset or short secret prevents hosted readiness.

## Validate, deploy, and verify

Run these commands from the project root after installing dependencies:

```text
npm run typecheck
npm run lint
npm test
npm run build
node scripts/deploy.mjs check --env staging
node scripts/deploy.mjs deploy --env staging --api-origin https://YOUR-STAGING-WORKER.workers.dev --apply
node scripts/deploy.mjs status --env staging --api-origin https://YOUR-STAGING-WORKER.workers.dev
```

`check` validates the public configuration and runs Wrangler's deployment dry run, including the community binding, migration and enabled program address. `deploy` repeats those checks, verifies remote operator secret metadata and, when community publication is enabled, the issuer and sponsor secret metadata, then publishes the selected Worker and checks its readiness response. Deployment and rollback tolerate transient propagation errors for at most six attempts within 45 seconds; invalid configuration or the wrong environment fail immediately. `status` checks once. These commands do not publish the frontend or deploy a Solana program. A post-deployment readiness failure requires investigation; it does not automatically roll back database migrations.

Verify a complete staging journey with separate rider and guardian wallets, including relay, loss of the previous guardian's private access, an RPC failure, resumption of pending transactions, completion, and individual reward claims. Confirm that app help and arrival controls work while chain confirmation is pending. After the staging checks, use the same commands with an explicit `--env production`. There is no automatic production deployment workflow.

The frontend is published separately through its Sites project. Preserve its previous deployment ID, configure `GUARD_API_ORIGIN`, and verify its `/api/ready` proxy against the intended Worker before sharing the URL. The application and Worker must agree on the exact frontend origin used by wallet authorization messages.

`/api/ready` checks configuration, including identity domain, allowed origins, operator secret, V2 address format, network setting, and disabled production restore. It is not a continuous Solana RPC availability probe. The chain coordinator independently verifies the RPC network and program account before preparing a transaction.

Community publisher availability is separate from active-care readiness. An unfunded sponsor or unavailable RPC leaves recognition pending or awaiting retry; it must not block help, check-ins, relay or closure. Inspect `/api/config` for public community configuration and the journal for publication status. A healthy readiness response does not certify that community records are finalized.

## Community publication and corrections

Follow [community deployment](DEPLOYMENT.md#community-ledger-deployment) for the separate Devnet program and [COMMUNITY_LEDGER.md](COMMUNITY_LEDGER.md) for record rules. Configure dedicated `COMMUNITY_ISSUER_SECRET_KEY` and `COMMUNITY_SPONSOR_SECRET_KEY` Worker secrets containing the corresponding keypair JSON. Keep them distinct from each other and from the deployment/upgrade administrator. Keep the administrator private key outside the Worker. Preflight verifies secret names; runtime program checks establish whether the configured keys match the on-chain authorities.

Members can participate without a wallet or SOL after accepting the public-record notice. The sponsor pays fees and storage costs. Monitor its Devnet balance, RPC availability and the ages of pending records. Source intents persist with business changes and transfer to independent journey journals; deleting private journey data does not cancel publication. UI states distinguish pending, submitted, finalized and retry. Finalized records remain labelled **platform-attested**. Pending recognition, finalized recognition and legacy application totals must not be added together as separate rewards.

The following endpoints require the existing operator bearer credential and are called against the Worker. Use public journey references from community records, rather than private trip IDs.

| Endpoint | Request or result |
| --- | --- |
| `GET /api/admin/community/journeys/:publicReference?cursor=...` | Inspect ordered records, publication errors and any correction |
| `POST /api/admin/community/retry` | `{ "journeyId": "PUBLIC_REFERENCE" }` requests reconciliation and publication retry |
| `POST /api/admin/community/corrections/prepare` | `{ "journeyId": "PUBLIC_REFERENCE", "targetSequence": 0, "reason": 1 }` returns the prepared transaction, administrator address and expiry |
| `POST /api/admin/community/corrections/submit` | `{ "journeyId": "PUBLIC_REFERENCE", "transaction": "SIGNED_BASE64_TRANSACTION" }` submits the exact prepared transaction after external administrator signing |

For a correction, first inspect the closed journey and finalize its original records. Review the target and reason, prepare the transaction, sign it with the configured administrator wallet outside the Worker, then submit the signed transaction and monitor the journal until finalized. Reason codes are `1` incorrect evidence, `2` duplicate identity, `3` invalid authorization and `4` administrative correction. Preparation, submission and retry attempts enter the existing operator audit log at `GET /api/admin/audit`; private accusations and freeform report text stay off chain.

A finalized correction withdraws the entire journey's contribution and banner totals while retaining original history and receipts. It does not delete records, reinstate recognition or redistribute a partial allocation. Late authorized intents may still publish as withdrawn audit history. The operator credential alone cannot sign a withdrawal. Retained program upgrade authority and authority rotation remain administrative powers.

An administrator can also withdraw a journey outside the application. Detection is bounded: each member-profile read requests withdrawal audits for at most five distinct journeys in the visible record page, and each journey is normally throttled to one audit every five minutes. Reading a journey's detail page requests its audit; an explicit operator retry can request reconciliation sooner. Older history requires pagination, a detail read or an operator retry. There is no full historical sweep, so an externally withdrawn older journey can remain in cached totals until audited. A read schedules reconciliation and is not a synchronous guarantee that every displayed record has just been rechecked.

## Release and rollback

Record the Worker version ID, frontend deployment ID, V2 program address, source revision, test results, and a verified encrypted backup before changing live traffic. A backup made while users are writing across multiple Durable Objects is a sequential snapshot, not a globally atomic transaction. Use a quiesced maintenance window for a consistent recovery checkpoint.

List previous Worker versions and roll back to a specific known-good version:

```text
cd worker
npx wrangler deployments list --env production
cd ..
node scripts/deploy.mjs rollback --env production --version KNOWN-GOOD-VERSION-UUID --api-origin https://YOUR-PRODUCTION-WORKER.workers.dev --apply
```

The rollback script invokes the repository's installed Wrangler with the correct working directory.

A code rollback does not undo SQLite writes, Durable Object migrations, or finalized Solana transactions. Keep schema migrations additive and preserve all existing class bindings. Do not roll back across an incompatible storage schema. For incompatible changes, deploy a forward fix or recover into an isolated namespace. V2 uses a separate Solana program; upgrading or reverting a program is a separate release operation. [Cloudflare rollback behavior](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Encrypted backups

The backup CLI uses Node's built-in cryptography and file APIs. No extra package is required. Configure these process environment variables from your secret manager:

- `SAFETY_GUARD_OPERATOR_SECRET`: operator secret for the source or destination API.
- `SAFETY_GUARD_BACKUP_KEY`: a cryptographically random 32-byte key, encoded as canonical base64. Keep it separately from the archive.

The key is never uploaded to the Worker. Export and verification commands:

```text
node scripts/backup.mjs export --api-origin https://YOUR-WORKER.workers.dev --file C:\GuardBackups\2026-09-19.sgbackup
node scripts/backup.mjs verify --file C:\GuardBackups\2026-09-19.sgbackup
```

Use an absolute path outside the checkout; Linux uses a path such as `/srv/guard-backups/2026-09-19.sgbackup`. An existing output file is never overwritten. Only ciphertext touches disk. AES-256-GCM authenticates the ciphertext and header; a SHA-256 checksum identifies the decrypted snapshot. Altered ciphertext, metadata, tags, and incorrect keys are rejected before restore.

The export includes account records and credit ledgers, private journey state, current and historical wallet reservations (including those of erased accounts), chain bindings and transaction recovery state, and governance protections. It excludes bearer sessions, recovery secrets, signing keys, provider API secrets, and notification credentials. Historical moderation reports and audit entries are also outside the recovery archive; preserve those separately if your operations require them. The export is intentionally bounded to 2,000 users, 2,000 journeys, 2,000 wallet reservations, and 8 MB of JSON; larger installations need a paginated coordinated backup service. A server manifest confirms export generation, not successful external storage; the CLI reports the final archive path only after an atomic encrypted write.

The manual GitHub Actions backup workflow reads secrets from the selected GitHub environment, writes encrypted data outside the checkout, verifies it, and retains the encrypted artifact for 14 days. Configure its `SAFETY_GUARD_API_ORIGIN` environment variable and the two secrets above. There is no enabled automatic backup schedule. Operators must configure their own schedule and external retention policy. Retain a current deletion/protection journal for as long as any older backup can be restored.

## Recovery drill

Recovery is disabled in production. Create an isolated staging Worker/namespace with fresh storage, correct domain configuration, external notifications disabled, and `RESTORE_ALLOWED=true`. Keep it disconnected from public frontend traffic during the drill.

Preserve a recent encrypted backup from the same source environment as a protection overlay. It must contain the latest deletion and suspension records, even when restoring older account/journey data:

```text
node scripts/backup.mjs restore --api-origin https://YOUR-RECOVERY-WORKER.workers.dev --file C:\GuardBackups\older-data.sgbackup --protection C:\GuardBackups\latest-protection.sgbackup --apply
```

The protection input is an ordinary encrypted full backup. Its governance state, latest account wallet/authorization version, and immutable wallet reservations are overlaid while the selected older business ledger and journey data are retained. This prevents a rotated-away wallet from becoming the restored login authority. Missing current identity for a non-deleted account, conflicting wallet ownership, or an authorization version regression stops recovery.

The CLI rejects an older protection snapshot or a different source environment. It cannot prove that a supplied file is the latest available: the operator must preserve and select the current journal. Without that journal, a new empty destination cannot infer deletions or wallet rotations that happened after an old backup. Do not expose a recovered environment until this check is complete.

The Worker validates all resource schemas before writing. It merges deletion/suspension protections first, restores only empty objects, and refuses to overwrite existing live records. Repeating the same data/protection pair is idempotent; a partially completed restore can resume. Cross-object restoration is not a database transaction. Keep recovery isolated until the entire operation succeeds and inspect restore audit records.

Restored sessions and recovery codes are invalid. Wallet-bound users sign in again; guest-only accounts cannot be recovered from a backup without a bound wallet. Restored active private journeys are closed rather than silently resuming unattended monitoring. Old notification work is discarded. Chain state must be reconciled with the configured public program before presenting rewards as settled. Do not treat an app snapshot as permission to rewrite public chain history.

Official community snapshots retain their ordered source intents and retry the same event identities. A stale snapshot is rejected when the independent journal already contains conflicting or newer events; restoration must not insert a cancellation over an existing arrival. Legacy private journeys remain legacy and are not automatically backfilled. Community source intents are included for retained private journeys, but the bounded maintenance export is not a complete archive of all independent journals or already-erased journeys. Preserve independent ledger data and chain retrieval capability as part of recovery planning.

Check readiness, wallet login, private access restrictions, account deletion, journey expiration, and transaction reconciliation in the recovery environment. Set `RESTORE_ALLOWED=false` before promoting it. Record the time needed for the drill; this project does not claim a tested production recovery-time guarantee.

## Reports and operator actions

A current participant can submit a categorical report through `POST /api/reports` with `tripId`, `subjectId`, `category`, and a unique `idempotencyKey`. Supported categories are `harassment`, `unsafe-conduct`, `spam`, `reward-abuse`, and `privacy`. The subject must have participated in that journey. Outsiders, self-reports, demo participants, and more than five new reports per account per day are rejected. Repeating the same request is idempotent. Reports do not include private route or freeform chat contents.

These operator endpoints require `Authorization: Bearer <OPERATOR_SECRET>` and must be called directly against the Worker:

| Endpoint | Operation |
| --- | --- |
| `GET /api/admin/reports` | Read report metadata; optional `status`, `limit`, and paired `before` timestamp / `beforeId` cursor |
| `POST /api/admin/reports/:id/resolve` | Set `{ "status": "dismissed" }` or `{ "status": "actioned" }` |
| `POST /api/admin/users/:id/suspension` | Set `{ "suspended": true, "reason": "abuse" }` |
| `GET /api/admin/audit` | Read recent operator actions |
| `GET /api/admin/backups/manifests` | Read export identifiers/checksums/counts |

Other suspension reasons are `safety`, `fraud`, `spam`, `appeal`, and `administrative`. Resolving a report does not automatically suspend its subject. An explicit suspension blocks taking new guarding assignments and earning new app credit; it does not erase already finalized public chain history. Ordinary help and ending a journey remain available. Readiness, categorical logs, and audit entries intentionally avoid operator secrets and route contents.

One `GovernanceStore` coordinates low-volume moderation, resource registration, and erasure metadata. It is not the storage owner for every journey. For larger traffic, shard reporting/registry work and replace bounded maintenance exports before scaling the deployment.

## Current publication checkpoint

The owner-only frontend project is recorded in `web/.openai/hosting.json`; reuse its existing project ID. Its published origin is `https://safety-guard-htn2026.klavander56.chatgpt.site`. Frontend version 3 uses the Obsidian Web3 design and points to the deployed production Worker. Staging and production signing/CORS configuration use this actual origin. Operator credentials are configured, and five live frontend-proxy workflow tests passed before the presentation update. The [hosting receipt](deployment/hosting.production.json) records current deployment identifiers and the redesign's separate publication checks.

The [complete signed hosted verification](deployment/application.v2.hosted.devnet.json) passed 14 checks and finalized 10 journey transactions through the production Worker, including relay, private-access revocation, completion, and both claims. It credited exactly 25 points and 10 reputation, then deleted all three synthetic accounts and the private journey. Funding used 0.06 Devnet SOL plus a 5,000-lamport transfer fee. Separately, the unsigned preparation check passed 17 checks on both the Worker and frontend-proxy paths. The private Helius Devnet RPC is configured; follow [RPC_SETUP.md](RPC_SETUP.md) for endpoint rotation. Browser wallet-extension acceptance remains a manual check, and AI-provider integration remains deferred.
