# StillHere

**Be there for someone.** StillHere means a volunteer stays with you, and their personal agent can help carry that care forward during an approved break. See the [product story and handoff design](docs/STILLHERE.md). This is the final hackathon project name; existing infrastructure names and protocol identifiers remain compatible.

A community journey-guarding application for Hack the North 2026. Riders approve human guardians and arrange relays when someone needs a break. Optional deterministic reminders continue after missed check-ins. The implemented [personal-agent workflow](docs/PERSONAL_AGENT_GUARDING.md) lets an assigned volunteer request a named agent for a limited period, obtain rider approval, and connect their own runtime through six scoped tools. Coverage becomes active only after a valid assessment. The existing OpenAI API adapter remains disabled and is outside the primary development path.

The personal-agent backend and interface are deployed; the owner-operated CLI watcher and local MCP bridge are implemented. A [hosted acceptance run](docs/deployment/personal-agent.hosted.validation.json) passed 23 checks with one real Codex assessment. A separate [published-browser run](docs/deployment/personal-agent.browser.validation.json) passed 12 checks through the actual interface: two participants, named-agent consent, a real Codex response, human return, capability revocation, arrival, and a free banner. Agent activity added no human check-ins. These bounded runs do not establish broad model quality, unattended overnight availability, or finalized new chain publication. Start with the [personal trial checklist](docs/PERSONAL_TRIAL.md); implementation details are in the [client guide](docs/PERSONAL_AGENT_CLIENT.md) and [HTTP protocol](docs/PERSONAL_AGENT_PROTOCOL.md).

The new zero-award agent-service contract extension is built and tested, but its Devnet upgrade is waiting for test-SOL funding. Those service receipts and later records in the same journey remain pending/retry until the upgrade. See the [release boundary](docs/deployment/personal-agent.release.validation.json); do not present those pending records as confirmed chain evidence.

For a private rehearsal without API credits, [Local Codex demo](docs/CODEX_DEMO.md) exports a five-minute, rider-only snapshot for an operator-reviewed Codex CLI run using the operator's own ChatGPT login. The rider reviews and imports its structured result; the server rechecks sources, current authority and single-use status before executing allowed tools. This manual workflow is separate from the Responses API and does not provide continuous AI monitoring. Imported execution metadata is supplied by the operator, not independently verified by the server.

The [assistance harness](docs/AGENT_HARNESS.md) provides rider-controlled reminders, separate timeout-contact authorization, private unresolved concerns, and evidence-based handoffs. Personal agents submit bounded findings, source references, a question category, and a proposed human relay. The server validates current authority and evidence, renders the question, and records its actual actions. The personal-agent tools expose no contact-notification or wallet operations. The optional [OpenAI integration](docs/OPENAI_INTEGRATION.md) has separate consent and spending controls; its live requests remain disabled. Open a journey's **Automated assistance** disclosure to review preferences and resolve concerns.

The accepted [community v1 scope](docs/COMMUNITY_V1.md) adds member profiles, contextual contribution records, and free structured appreciation banners. Profiles and contribution values are visible to other authenticated community members before applying or approving; there is no visibility toggle or sitewide leaderboard. Availability and language matching remain future work in the [community direction](docs/COMMUNITY_DIRECTION.md).

Companionship remains accessible without payment, staking, or a token balance. The [gratitude rules](docs/GRATITUDE_MECHANISM.md) allow optional free banners after closure without adding points or reputation. Financial tips and transferable tokens are deferred; translation is not integrated. Site access is limited to the owner and the owner-requested demo viewer.

The [community ledger](docs/COMMUNITY_LEDGER.md) implements the requirement for appreciation, contributions and guarding history to have Solana records. It adds a separate program, free sponsored platform attestations, ordered participation history, durable publication, independently readable receipts and administrator-signed corrections. The implementation report records deployment and validation status. See [the original design](docs/ONCHAIN_COMMUNITY.md) for the reasoning and trust boundaries.

Sponsor research is in [SPONSORS.md](docs/SPONSORS.md). The current design is documented in [ARCHITECTURE_V2.md](docs/ARCHITECTURE_V2.md).

## Run locally

Install Node.js 22.13 or later, then run from this folder:

```sh
npm run setup
npm run dev
```

On Windows, double-click [start.bat](start.bat), or use `npm.cmd` from PowerShell. Open **http://localhost:5173**. The frontend proxies API requests to the Worker at **http://127.0.0.1:8787**. Keep both processes running for local monitoring and transaction reconciliation.

## Try a journey

Use separate browser profiles for the rider and two guardians. Guests can participate without a wallet or SOL: accept the public-record notice, create a journey, share its invite, have a guardian apply, then approve them from the rider session. New real journeys automatically queue minimal history and recognition for sponsored publication on Solana. Only approved participants can see route, location, and conversation. Request a relay to recruit a replacement. Confirm arrival to end monitoring.

For personal-agent assistance, use an ordinary journey with synthetic content during rehearsal. The assigned guardian requests 5–120 minutes of assistance, the rider approves the named delegation, and the guardian downloads its connection file. The [local watcher](docs/PERSONAL_AGENT_CLIENT.md) or a compatible agent using the MCP bridge then accepts and submits an assessment. A connection alone does not activate coverage. A 45-second connectivity limit and a 90-second pending-response deadline expose loss of availability. The owner must keep the runtime awake and connected; agent heartbeats and actions do not earn human contribution points.

For an **optional V2 wallet-signed commitment**:

1. Each participant opens **Account & wallet**, links a Solana wallet, and saves the recovery code. Select Devnet in the wallet and obtain test SOL for transaction fees.
2. The rider creates a journey with **Use a shared Solana guardian commitment** selected, then chooses **Create chain commitment**.
3. A guardian applies. The rider signs a proposal; the guardian signs acceptance. Private access changes after acceptance is finalized.
4. Guardians continue ordinary availability check-ins and sign at least one **contribution check-in** while assigned to qualify for a chain reward.
5. For a relay, open a replacement request and repeat the rider proposal and new guardian acceptance. The former guardian loses private access.
6. The rider confirms arrival in the app, then signs arrival and reward allocation. Each eligible guardian claims their contribution. Former guardians find receipts under **My profile → Wallet-signed journeys**.

One V2 journey shares **25 points and 10 reputation** across up to **16 distinct eligible guardian wallets**. Returning guardians have one cumulative share. Finalized V2 claims update the older application balance exactly once. Separately, new official community journeys, including walletless journeys, share a 25/10 community contribution pool among guardians with recorded check-ins. Their public-reference ordering can allocate remainders differently from V2's wallet ordering. Profiles show finalized community records, pending recognition and legacy application records separately; V2 and community totals must not be added as additional rewards. Older journeys are not automatically imported.

Help, conversation, availability check-ins, and ending monitoring require no participant wallet signature or wait for blockchain finality. The sponsor covers community publication fees and account storage costs. Pending signed transactions survive closing the browser: the Worker checks their signatures and retries the same bytes. It stores dedicated community issuer and sponsor keys as Worker secrets; participant wallet keys and administrator/deployment keys remain outside the Worker.

## Implemented architecture

| Area | Implementation |
| --- | --- |
| Accounts | Verified wallet binding, stable identities, expiring/revocable sessions, wallet rotation, single-use recovery codes |
| Human relay | Rider approval plus guardian acceptance, private-access changes, contributions across returning guardians |
| Community | Always-visible member profiles, pre-decision profile review, redacted contribution history, a received-appreciation wall, and a contribution honor cabinet |
| Personal agents | Guardian request, rider approval, expiring journey capability, six CLI/MCP operations, owner-run watcher, validated assessments, attributed messages, and revocable coverage |
| Journey assistant | Five validated platform tools, offline reminders, source-based handoffs, and a separately gated OpenAI adapter with spending reservations; live API activation pending |
| Chain synchronization | Persistent journey mapping, durable outbox, finalized receipt verification, failure/expiry handling, idempotent credit |
| Operations | Isolated environments, readiness checks, deployment/rollback tooling, reports/restrictions, retention/deletion, encrypted backup/restore |

React/Vinext serves the interface. Cloudflare Workers and SQLite-backed Durable Objects coordinate private data. Solana stores public commitments and rewards. Names, routes, contact details, messages, location, and credentials stay off chain.

The [agent guide](docs/AGENT_HARNESS.md) distinguishes the owner's personal runtime, offline rule planner, manual Codex rehearsal, and optional API adapter. Fixture and mocked-provider tests exercise authorization and execution without model calls; they do not measure real-model quality. Adding an OpenAI key alone does not enable platform API requests. The journey interface keeps private evidence and settings beside the core human controls.

## Deployment status

The personal-agent release includes production Worker version `d05822bb-5a48-44ca-9bda-fd18db4a4c7d` and frontend version 16. Its [hosted validation](docs/deployment/personal-agent.hosted.validation.json) records one real model turn in 8.683 seconds under a two-turn/two-minute watcher limit, with zero hosted OpenAI API calls and zero external notifications. Community events were journaled; independent decoding and finality of the new automated-service records remain pending in that receipt.

The separate [V2 program is deployed on Solana Devnet](https://explorer.solana.com/address/23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb?cluster=devnet). Both [local-validator](docs/deployment/verification.v2.localnet.json) and [Devnet](docs/deployment/verification.v2.devnet.json) checks completed 19 signed transactions and 11 expected rejection checks. The [local application integration report](docs/deployment/application.v2.localnet.json) records 10 finalized transactions through the HTTP backend, private-access revocation, and a single shared 25/10 reward pool.

The existing V1 program remains a legacy, separate single-guardian receipt. New linked journeys use V2. Never configure the V1 address as `SOLANA_V2_PROGRAM_ID`.

The frontend is published at **[StillHere](https://safety-guard-htn2026.klavander56.chatgpt.site)**. The [production Worker](https://safety-guard-api-production.2012044zj.workers.dev/api/ready) is deployed and passes readiness checks, with the published site configured as its canonical signing origin. A [hosted identity verification](docs/evidence/hosted-identity-2026-09-20.json) passed 36 checks covering wallet binding/login, recovery, replay/origin rejection, session revocation, and synthetic-account deletion. It submitted no blockchain transactions and persisted no credentials.

The site permits its owner and one owner-requested demo viewer. The [simplified frontend](docs/FRONTEND_SIMPLIFICATION.md) puts active journey controls beside conversation, folds ended-journey history, and combines account actions in an avatar menu. The [appreciation wall and honor cabinet](docs/COMMUNITY_HONORS.md) remain public to members, with compact previews and complete receipt access. Thirteen journey-interface tests, 14 honor-projection tests, frontend type checking, lint, and build pass. See [DEMO.md](docs/DEMO.md) to demonstrate recognition using separate rider and guardian identities.

**All five live HTTP integration tests through the earlier published ledger release passed**, covering application-only guardian approval, relay, former-guardian access revocation, shared rewards, and isolated demonstrations. The 11 synthetic test accounts were deleted. Homepage, admin page, health, readiness, and configuration routes returned HTTP 200 in that run; see the [hosting receipt](docs/deployment/hosting.production.json).

**The complete signed workflow through the production Worker passed:** [14 checks and 10 finalized journey transactions](docs/deployment/application.v2.hosted.devnet.json) covered creation, guardian approval/acceptance, relay, contribution check-ins, completion, and both reward claims. Guardians received 12/13 points and 5/5 reputation; old private access and duplicate claims were rejected. The three synthetic accounts and private journey were deleted. This run used 0.06 test SOL plus a 5,000-lamport funding fee.

Separately, unsigned transaction preparation passed all 17 checks through both the Worker and the published frontend proxy. The private RPC credential stays in a Cloudflare secret and is absent from public configuration. Browser wallet-extension interaction still needs a manual acceptance check. See [RPC_SETUP.md](docs/RPC_SETUP.md) for configuration and rotation.

## Accounts and data

**Account & wallet** supports signing in, recovery, wallet replacement, revoking other sessions, export, and deletion. Changing an account wallet does not transfer existing chain authority: outstanding journeys still require their original signing wallet.

Closed private journeys expire after 30 days (7 days for demos). Riders may erase a closed journey earlier. Public chain records and minimal anti-replay/ownership tombstones remain. Restores preserve deletion protections and do not restart old active journeys. See [DATA_POLICY.md](docs/DATA_POLICY.md).

Participants can report concerns from a journey. Operators review reports at **/admin** using the configured operator credential. Reports do not send emergency alerts. External notifications, voice, Uber telemetry, and AI APIs are not configured in this release. Location sharing is opt-in and stops when the page closes; maps are illustrative. The application does not dispatch emergency services or guarantee continuous human coverage.

## Checks and guides

```sh
npm run typecheck
npm run lint
npm test
npm run test:personal-agent
npm run test:personal-agent-ui
npm run build
# With local frontend and backend running:
npm run test:integration
```

- [Current architecture](docs/ARCHITECTURE_V2.md)
- [Frontend design system](docs/FRONTEND_DESIGN.md)
- [Identity and recovery](docs/IDENTITY.md)
- [Deployment, rollback and encrypted backup](docs/OPERATIONS.md)
- [Data policy](docs/DATA_POLICY.md)
- [Human guarding workflow](docs/HUMAN_GUARDING.md)
- [Personal-agent guarding and operational limits](docs/PERSONAL_AGENT_GUARDING.md)
- [Personal-agent CLI and MCP client](docs/PERSONAL_AGENT_CLIENT.md)
- [Personal trial checklist](docs/PERSONAL_TRIAL.md)
- [Personal-agent HTTP protocol](docs/PERSONAL_AGENT_PROTOCOL.md)
- [Community v1 scope and validation](docs/COMMUNITY_V1.md)
- [Validation evidence](docs/VALIDATION.md)
- [Sponsor analysis](docs/SPONSORS.md)

The chain integration scripts require an explicitly configured local validator or Devnet test funding. Production rejects incomplete configuration and keeps restore disabled. No real-value payment, escrow, tradable token, or autonomous AI wallet is included.
