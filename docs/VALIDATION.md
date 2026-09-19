# Validation status

Recorded September 20, 2026. This release integrates account recovery, V2 human relay/rewards, durable chain synchronization, operations/data lifecycle controls, the offline agent harness, and a separately deployed community ledger. All documents describe development evidence, not an audited emergency-response service.

## Automated checks

The current [simplified interface](FRONTEND_SIMPLIFICATION.md) is frontend version 9, accessible to the owner and the same authorized demo viewer. This profile refinement moves introduction editing to an **Edit** button beside the name and compresses the honor cabinet into compact responsive entries. Frontend type checking, lint, build, and [20 published checks](deployment/frontend.profile.validation.json) passed, including exact JavaScript and root stylesheet hashes. No contract or Worker code changed, no new blockchain transaction was submitted, and AI remains an offline mock. Browser visual and interaction acceptance was not performed because no browser was available. See the [profile release receipt](deployment/profile.layout.validation.json).

The earlier frontend version 8 passed seven journey-progress tests, 14 honor-projection tests, eight proxy tests, frontend type checking, lint, build, and [27 published checks](deployment/frontend.simple.validation.json). Its first-check-in prompt and zero-contribution arrival feedback cover the diagnosed missing-check-in flow. Those unchanged logic tests were not rerun for the version 9 layout refinement. See the [version 8 release receipt](deployment/frontend.core.validation.json).

The earlier [honors presentation release](deployment/community.honors.validation.json) deployed frontend version 7. It passed 14 honor-projection tests, eight proxy tests, frontend type checking, lint, build, and [18 published checks](deployment/frontend.honors.validation.json).

The earlier [community-ledger release](deployment/community.ledger.validation.json) deployed frontend version 6 with the production Worker and a separate Solana Devnet program. That release passed 166 Worker tests, 41 chain-client tests, 24 Rust tests, 18 operations tests, eight proxy tests, and frontend type checking, lint and production build. The [signed local community run](deployment/verification.community.localnet.json) confirmed 20 transactions and 19 expected rejection scenarios. The [hosted ledger workflow](deployment/community.ledger.hosted.devnet.json) passed 17 checks and independently verified 20 finalized public records, including an administrator-signed withdrawal. Five hosted HTTP workflows and eighteen published frontend checks also passed. All fourteen synthetic accounts from the two hosted runs were deleted.

The earlier [community v1 release](deployment/community.v1.validation.json) established the application-only baseline in frontend version 5: 137 Worker tests, five hosted HTTP workflows with 11 synthetic accounts removed, and 13 published asset checks. Its no-chain-change statement applies only to that earlier revision. Historical V2 and identity evidence below remains distinct from the new community program.

| Check | Result | What it establishes |
| --- | --- | --- |
| Journey progress tests | 7 passed | Missing guardian check-in, first-check-in prompts, relay participation, pending settlement, demo/cancelled states and simulated-guardian exclusion |
| Published simplified frontend | 27 checks passed | Exact application and root stylesheet hashes, primary actions, receipt paths, core navigation and removal of promotion/simulation entry points |
| Honor projection tests | 14 passed | Received versus sent banners, confirmation/withdrawal, cancellation, pagination, aggregate milestones, identity isolation, and safe receipts |
| Published honors frontend | 18 checks passed | Exact deployed application assets and pennant artwork, collection styles, receipt controls, health response, and offline AI configuration |
| Worker runtime tests | 166 passed | Existing API, identity, V2, offline agent and privacy controls, community profiles, durable source intents and community publisher/corrections |
| Chain client tests | 41 passed | V1/V2 and community wire formats, signers, ownership, independent reconstruction, withdrawal and test-network constraints |
| Frontend proxy tests | 8 passed | Trusted-origin forwarding, credential transport, redirect rejection, bounded bodies and controlled upstream errors |
| Operations CLI tests | 18 passed | Backup/recovery, deployment readiness, private RPC configuration and isolated community binding/program/secret preflight |
| Local HTTP tests through frontend | 5 passed | Guest approval/relay, former-guardian access revocation, app-only rewards, and demo isolation |
| Hosted HTTP tests through frontend | 5 passed | The same workflows through the published private site and production Worker; 11 synthetic accounts deleted |
| Hosted chain preparation | 17 checks passed on each path | Direct Worker and private frontend proxy both prepared the expected unsigned V2 transaction; synthetic accounts/journeys cleaned up |
| Hosted signed Devnet workflow | 14 checks passed | Direct production Worker flow finalized 10 journey transactions, revoked former private access, and credited exactly one 25/10 reward pool |
| Native Rust tests | 24 passed | 9 V1, 8 V2 and 7 community tests covering layout, chronology, reward allocation and authorization |
| TypeScript | Passed | Worker source/tests, frontend, and chain client/scripts |
| Frontend lint | Passed | Final application, wallet, privacy and operator screens |
| Production build | Passed | Full Vinext build and Worker deployment dry run |
| Hosted community ledger | 17 checks passed | Walletless A-to-B-to-A assignments, fixed allocation, free banners, independent chain/profile reconstruction, cancellation, withdrawal and retained public records after private erasure |
| Published community frontend | 18 checks passed | Exact deployed bundle hashes, public-record notice, separate finalized/pending/legacy totals, receipt links and administrator correction UI |

The latest targeted runtime run passed 25 chain/integration tests, adding five regression cases to the earlier 80-test baseline. The Worker suite includes 14 real Ed25519 identity tests and 17 chain synchronization tests using real transaction signatures with mocked RPC responses. These exercise challenge replay/expiry, concurrent wallet binding, recovery rotation, revocation, retries across object eviction, rejection of changed signed bytes, stale state, network mismatches, delayed consent, idempotent two-guardian credit and in-flight deletion.

The test runtime bundles the Solana dependency graph and explicitly resolves the browser Buffer package, following the [Cloudflare module-resolution guidance](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/). No test credentials, sessions, wallet private keys, or backup plaintext are included in the public evidence.

## Actual chain and application integration

Community program: `7vuz78V9Tu53Bpt3iXHc37VSDBmRSYxcEguWewR9LXzm`. The [deployment receipt](deployment/deployment.community.devnet.json) verifies executable ownership, upgrade authority and byte-for-byte equality with the validated binary. The dedicated issuer and sponsor differ from the administrator. The hosted workflow covers fourteen records on a completed relay journey, five on a cancelled journey, and one append-only withdrawal; these are platform attestations, separate from the historical V2 wallet-signed evidence below. The hosted workflow's public receipt addresses and transaction signatures are retained for independent verification.

The new interface and operator route are published; [asset verification](deployment/frontend.ledger.validation.json) confirms the exact production JavaScript and ledger styles. Browser rendering and wallet-extension interaction remain manual acceptance checks because no browser was available. AI and external notifications remain disabled.

The frontend's Obsidian redesign passed type checking, lint, the production build, eight proxy tests, and a source review of role-sensitive controls. The [published frontend check](deployment/frontend.web3.validation.json) verified the updated homepage, dark styles, social metadata, exact artwork hashes, admin route, production readiness, and unchanged V2 Devnet configuration. The browser connection was unavailable; screenshot-based layout review and interactive wallet acceptance are not claimed. See [FRONTEND_DESIGN.md](FRONTEND_DESIGN.md).

V2 program: `23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb`.

| Run | Evidence | Observed result |
| --- | --- | --- |
| Local validator | [verification.v2.localnet.json](deployment/verification.v2.localnet.json) | 19 signed transactions and 11 expected rejections |
| Solana Devnet | [verification.v2.devnet.json](deployment/verification.v2.devnet.json) | 19 signed transactions and 11 expected rejections |
| HTTP backend plus local validator | [application.v2.localnet.json](deployment/application.v2.localnet.json) | 10 finalized transactions, two guardian accounts, exactly 25 points and 10 reputation in application balances |
| Production Worker plus Devnet | [application.v2.hosted.devnet.json](deployment/application.v2.hosted.devnet.json) | 14 checks, 10 finalized journey transactions, 12/13 points and 5/5 reputation; all three synthetic accounts and private journey deleted |

Both contract runs exercised creation, rider proposal, guardian acceptance, replacement, a returning guardian, contribution check-ins, completion, separate claims and cancellation. They rejected stale revisions, unauthorized signers, former-guardian check-ins, stale returning-guardian sequence, completion without a check-in, duplicate completion/claim, and cancelled recruitment. They used only test SOL.

The local application run exercised real wallet-signed account binding and the HTTP preparation/submission/reconciliation APIs. It checked private access after handoff, former-guardian rejection, zero app reward before chain claims, duplicate-claim rejection, and continuing receipt access after private access was revoked. Final balances were 13/12 points and 5/5 reputation. Keys were generated in memory for that run.

The full hosted run completed at 01:09 CST on September 20 through the production Worker directly. Its 10 finalized journey transactions covered creation, proposal/acceptance for each guardian, both contribution check-ins, completion, and individual claims. Independent finalized chain reads matched the application balances of 12/13 points and 5/5 reputation. The project test funder transferred 0.06 Devnet SOL to three ephemeral wallets in one additional funding transaction, with a 5,000-lamport funding fee. Cleanup stopped monitoring, removed the private journey, and deleted all three synthetic accounts. Public chain records remain; no generated credentials were persisted.

The V2 SBF binary and IDL were built in the existing isolated Linux toolchain. V2 uses a separate program ID; the previously deployed V1 program was preserved. The local UI and API configuration report V2 Devnet. Browser wallet-extension approval is a separate manual acceptance check; the HTTP/CLI checks do not claim to automate a wallet extension.

## Deployment and recovery boundaries

The offline-agent revision passed the complete 114-test Worker suite, frontend type checking/lint/build, Worker type checking and production dry-run, eight proxy tests, and 16 operations tests. Its 29 new tests cover tool schemas, timestamp conflicts, stale GPS, actual local effects, eviction/replay, bounded retry, no API call with a configured key, stale-context refresh, consent and notification checks, private access, participant erasure, and backup restoration without agent replay. These are synthetic deterministic tests; no live LLM capability or general language understanding is claimed. No chain program changed or new signed chain transaction was needed for this revision.

The frontend and production Worker were republished with offline mode explicitly reported by `/api/config`. The companion trace is private to current journey participants. Published asset validation is recorded separately in [frontend.agent.validation.json](deployment/frontend.agent.validation.json); it checks the actual served bundle and styles, not browser rendering or wallet interaction.

All five hosted HTTP workflows were rerun through the published frontend for this revision and passed. The demo workflow now also checks actual mock tool results, a newer route concern after reassurance, stale-location context, and a failed-notification run. All 11 synthetic accounts were deleted after closing the test journeys. The [offline agent validation receipt](deployment/agent.offline.validation.json) records the current checks; no real model API or external notification was used.

The production Worker is deployed at [safety-guard-api-production.2012044zj.workers.dev](https://safety-guard-api-production.2012044zj.workers.dev/api/ready); its version is recorded in the [hosting receipt](deployment/hosting.production.json). Its readiness endpoint returned HTTP 200 with `ready: true` and `environment: production` during the ledger release checks. The frontend is published with access for its owner and the owner-requested demo viewer at [safety-guard-htn2026.klavander56.chatgpt.site](https://safety-guard-htn2026.klavander56.chatgpt.site). The Worker signing domain, site origin, and allowed origins use this actual published domain.

The [hosted identity evidence](evidence/hosted-identity-2026-09-20.json) records 36 passing checks against the production Worker at 00:45 CST on September 20. Real ephemeral Ed25519 signatures verified binding, login to the same account, recovery to a replacement wallet, session revocation, replay rejection, cross-origin rejection, and rejection of old recovery credentials. A challenge requested without an `Origin` header still used the configured published frontend origin. The synthetic account was deleted, and subsequent session and wallet-login attempts were rejected. This run submitted zero blockchain transactions and persisted no keys, sessions, signatures, or recovery codes.

**All five integration tests through the published frontend passed.** These exercised public-data redaction, approval, relay, old-guardian access revocation, help, exactly-once application rewards, invalid applications, and demo isolation. Cleanup closed the synthetic journeys and deleted all 11 accounts created by the run. The homepage, admin page, health, readiness, and configuration requests returned HTTP 200. A workerd redirect-option incompatibility was reproduced and fixed in the proxy and notification transport; redirects are handled manually and rejected before credentials can follow them.

**Hosted chain preparation passed all 17 checks after configuring a private Helius Devnet RPC.** The [hosted preparation check](evidence/hosted-chain-prepare-2026-09-20.json) bound an ephemeral wallet, read the deployed V2 program, prepared an unsigned create transaction with the expected program and signer, discarded the unsigned intent, and deleted its synthetic journey/account. It broadcast no blockchain transaction. The same 17 checks also passed through the [published frontend proxy](evidence/hosted-frontend-chain-prepare-2026-09-20.json). Direct and frontend-proxied configuration responses were checked for API-key/endpoint redaction.

The [complete signed hosted workflow](deployment/application.v2.hosted.devnet.json) also passed, using direct production Worker HTTP calls and ephemeral signing keys. This is separate from the unsigned frontend-proxy checks. Browser wallet-extension approval remains a manual acceptance check; no browser was available to automate that interaction in this session.

Backup tests include an actual local HTTP CLI export/verify/restore round trip, wrong-key and ciphertext/header tampering, no-overwrite writes outside the checkout, identity-version overlays and deletion protections. Worker tests restore into empty objects and reject stale-session reuse and erased-record resurrection. No production recovery-time target or hosted disaster-recovery drill is claimed.

The current Solana web3.js dependency audit reports four moderate transitive findings through jayson, uuid and stream-json. The audit's suggested automatic fix downgrades web3.js to an incompatible release and was not applied. The Worker uses bounded JSON RPC responses and no JSON-RPC server/stream filters or uuid v3/v5/v6 APIs. This is an explicit dependency-maintenance item, not a claim that every vulnerable dependency path is unreachable.

External notifications, live AI/voice APIs, and Uber telemetry remain disabled. No real person was contacted during validation. Map/location behavior and emergency-response guarantees are outside these automated checks.

## Reproduce

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
cargo test --manifest-path contracts/Cargo.toml --workspace --locked
```

For V2 local contract verification, use `scripts/solana-v2-wsl.sh build` then `local` from the configured Ubuntu environment. The application integration script `npm --prefix chain run verify:app:v2` explicitly uses a separately persisted Worker on port 8788 configured with `SOLANA_NETWORK=localnet` and the local validator on 8899. It refuses a Devnet configuration. Devnet verification requires the project's explicit test-funder path; no global wallet is selected implicitly.

The hosted identity check is explicitly invoked and creates then deletes one synthetic account. It signs account messages only and does not use test SOL:

```sh
node scripts/verify-hosted-identity.mjs --api https://safety-guard-api-production.2012044zj.workers.dev --origin https://safety-guard-htn2026.klavander56.chatgpt.site --evidence docs/evidence/hosted-identity-2026-09-20.json
```
