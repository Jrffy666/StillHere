# Community ledger implementation

Updated September 20, 2026. This is the implementation companion to [ONCHAIN_COMMUNITY.md](ONCHAIN_COMMUNITY.md). Deployment and end-to-end validation must be read from the release evidence below; source implementation alone is not proof of a live deployment.

## Product behavior

New real journeys publish minimal guarding history, contribution allocations and voluntarily sent appreciation banners. Publication is required for eligible records. Helping, checking in, handing off and closing a journey do not wait for blockchain finality. Demo journeys do not create official recognition. Existing private journeys are not silently imported.

Before creating a new real journey or volunteering on one that uses the ledger, a member accepts the `community-v1` public-record notice. A cryptographically random community identity is assigned separately from the account ID. Each new official journey receives an independent random public reference. The member is told that public chain records can outlive account deletion and be read outside the website.

Profiles remain visible to other authenticated community members. Their primary statistics are finalized community-ledger points, contributions and banners. Pending recognition and earlier application records are displayed separately. Reading a profile before application or approval includes its ledger status. Nobody can hide their contribution value or buy priority or recognition.

## What the records mean

The initial program supports **platform attestations**. The backend authenticates application actions and a designated issuer signs their public records. The sponsor pays transaction fees and account creation costs. Neither the issuer nor sponsor is the deployment/upgrade administrator.

Every record is labelled platform-attested, including application observations associated with a V2 journey. Blockchain confirmation verifies publication by that authority under the program rules. It does not create a participant wallet signature, establish that a human was attentive, or independently establish physical safety. Direct V2-state verification as a separate provenance class remains future work.

The original V2 wallet-signed commitment program is preserved. Its wallet-order allocations are protocol receipts, not an additional source of points to add to the new community ledger. A two-guardian remainder can be assigned differently because the new community rule orders pseudonymous member references. The interface identifies the two record systems separately.

## Rules and event schema

The first community rule distributes one 25-point and 10-reputation pool equally among distinct guardians with an observed check-in when the rider reports arrival. Integer remainders go to eligible members in ascending public-reference order. Additional check-ins, repeated assignments and banners do not increase the pool. Cancelled and expired journeys retain participation history without completion allocations.

The ordered event families are `created`, `assigned`, `check_in`, `relay_requested`, `closed`, `contribution`, `gratitude`, and `agent_service`. The minimal payload is:

```typescript
{
  journeyId: string;   // random 32-byte public reference, lowercase hex
  sequence: number;    // zero-based event order within this journey
  kind: string;
  actorId: string;     // pseudonymous member; zero for declared platform automation
  subjectId: string;
  assignment: number; // distinct period of responsibility, independent of guardian identity
  observedAt: number; // Unix seconds, distinct from receipt recordedAt
  value: number;      // bounded event-specific category
}
```

Assignments A-to-B-to-A retain three periods of responsibility. A requested relay is separate from an accepted assignment. A check-in attests an observed application action, not continuous attention. Closure categories distinguish rider-reported arrival, cancellation and expiry. At most sixteen distinct guardians participate in one journey.

The additive `agent_service` event uses wire kind 9 and rule version 2 with the unchanged 173-byte receipt layout. Values are 0 (first validated agent response establishes service), 1 (service ended), 2 (service unavailable), and 3 (human returned). These observations bind to the current guardian and assignment. Automatic end/unavailable records have a zero actor; start/return records refer to the owning guardian. They always carry zero points and reputation and cannot satisfy human check-in or banner eligibility. Source capture places service termination before reassignment or closure. Repeated heartbeats create no public events. Private execution receipts, source citations, agent names, messages, locations and capabilities are excluded from chain payloads.

An upgraded program is required to publish kind 9. During an upgrade delay the durable publisher retains such records as pending/retry and later records in that journey wait in order; the UI must not show them as chain confirmed. Existing reward rule 1 and prior account layouts remain compatible. Deployment and independent chain verification are recorded in the release evidence.

An eligible rider can send at most one fixed-category banner per journey and guardian, including a former guardian or a guardian on a cancelled journey. Categories are companionship, thoughtfulness and relay. Banners never add contribution points. Neither contributions nor banners are transferable tokens or NFTs.

Duplicate-event protection and a fixed per-journey pool do not establish one-person-one-account or prevent colluding accounts from inventing journeys. Identity assurance, suspicious-activity review and sustainable sponsorship quotas require further work before open community operation. Recognition describes recorded participation; it is not a certification of moral character or professional competence.

## Publication and independent verification

TripRoom persists minimal source intents in the same SQLite transaction as the authorized business change. A separate journal per public journey owns chain publication, and a derived per-member index supports profile reads. Publication intent survives private trip erasure. No route, coordinates, Uber link, chat, contact details, display name or application bearer credential belongs in the public payload.

The journal validates chronology and eligibility, deduplicates the same event identity, rejects conflicting content, signs with dedicated issuer/sponsor keys, persists the exact transaction before sending, and uses alarms to retry. Receipt reconciliation checks finalized account ownership, deterministic address, decoded event content and allocation. A lost acknowledgement is resolved against the same receipt rather than issuing additional recognition.

The UI distinguishes `pending`, `submitted`, `finalized` and `retry`. An RPC outage or empty sponsor wallet does not become a fabricated success. Finalized platform attestations still identify their provenance. Index updates are durable and idempotent; reading a profile may briefly lag chain confirmation.

`fetchFinalizedCommunityJourney` reads the journey and its sequence-addressed accounts directly from Solana, verifies program ownership and receipt identities, and includes any separate withdrawal receipt. `reconstructCommunityProfile` derives recognition from those verified records. This supports independent reconstruction without relying on the website's counters. A production-scale complete index and archival retention service remain operational work beyond the Devnet prototype.

## Corrections and administrator powers

The first correction operation withdraws an entire closed journey's recognition. It is intentionally coarse: all its contribution points and banners stop counting, while original history and receipts remain. Reasons are bounded categories: incorrect evidence, duplicate identity, invalid authorization, or administrative correction. Private report text is never copied on chain.

A withdrawal is a separate one-per-journey account and does not consume normal source-event sequence numbers. Late eligible contribution or gratitude intents can still be recorded for the audit history; they have no effective recognition while the journey is withdrawn. This avoids losing an already authorized action during a correction race.

The operator prepares a withdrawal, reviews its target and reason, and signs with the configured administrator wallet. The Worker never receives that administrator's private key. An operator API credential alone cannot authorize the chain withdrawal. This release has no reinstatement or partial redistribution instruction. Configuration rotation and retained program-upgrade authority remain explicit administrative powers; the program is not advertised as immune to all future governance changes.

Withdrawals submitted outside the application are reconciled on reads and operator retry. A member-page read audits at most five visible journeys, throttled to once per five minutes per journey. Older unloaded history requires its page, the journey detail, or an explicit operator retry; there is no complete historical sweep in this prototype. Until reconciliation, an application index can lag an external withdrawal. Independent finalized chain reconstruction includes the withdrawal directly.

## API

All member and trip endpoints require an application session. Administrator endpoints require the existing operator credential; correction submission additionally requires the exact prepared administrator-signed transaction.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/me/community-notice` | Accept `{version: "community-v1"}` and establish the member reference |
| `GET /api/members/:id/records?cursor=...` | Read `{ledger, legacy}` with finalized/pending totals and paginated public evidence |
| `GET /api/trips/:id/community?cursor=...` | Read the journey's enabled state, public reference, records and correction |
| `GET /api/admin/community/journeys/:publicReference` | Inspect the public journal and correction state |
| `POST /api/admin/community/retry` | Request reconciliation/publication for `{journeyId}` |
| `POST /api/admin/community/corrections/prepare` | Prepare `{journeyId, targetSequence, reason}` for administrator review |
| `POST /api/admin/community/corrections/submit` | Persist and publish `{journeyId, transaction}` after signature verification |

Existing gratitude and guarding action endpoints are retained. Account deletion removes the private identity mapping and profile; it cannot remove chain history or copies held by others. Restoring old snapshots must not create an invented historical ledger or duplicate already published recognition.

## Configuration and deployment

The publisher supports Solana Devnet and explicit local development only. It verifies the RPC genesis and program configuration rather than trusting a URL label. It does not enable Mainnet.

- `COMMUNITY_ENABLED`: publisher activation.
- `COMMUNITY_PROGRAM_ID`: separately deployed community program.
- `COMMUNITY_ISSUER_SECRET_KEY`: dedicated issuer keypair JSON, stored as a Worker secret.
- `COMMUNITY_SPONSOR_SECRET_KEY`: dedicated fee/storage sponsor keypair JSON, stored as a Worker secret.
- `SOLANA_PRIVATE_RPC_URL`: existing private RPC secret when configured; never exposed in public configuration.

`contracts/deployment-community.json` contains public identities and layout metadata, not private keys. `chain/scripts/setup-community.ts` preserves existing key identities and refuses inconsistent replacements. `contracts/scripts/build-community.sh` builds the community program with the documented size optimization. The original V2 program and its deployment identity remain separate.

Sponsor funding, RPC availability and key rotation need ongoing operation. Devnet is a development environment, not a production permanence promise. AI remains offline; the agent cannot issue gratitude for a member, attest their arrival or increase its own contributions.

## Release evidence

The community program is deployed on Solana Devnet at [`7vuz78V9Tu53Bpt3iXHc37VSDBmRSYxcEguWewR9LXzm`](https://explorer.solana.com/address/7vuz78V9Tu53Bpt3iXHc37VSDBmRSYxcEguWewR9LXzm?cluster=devnet). The [deployment receipt](deployment/deployment.community.devnet.json) verifies the executable, upgrade authority and exact validated binary hash. Dedicated issuer and sponsor identities are initialized, and the Worker publisher is configured.

The [release receipt](deployment/community.ledger.validation.json) records frontend version 6, the production Worker, 166 Worker tests, 41 chain-client tests, 24 Rust tests, 18 operations tests, eight proxy tests, and successful type checking, lint and build. The [local signed contract run](deployment/verification.community.localnet.json) confirmed 20 transactions and 19 expected rejections.

The [hosted Devnet workflow](deployment/community.ledger.hosted.devnet.json) passed 17 checks with 20 finalized public records, including the separate withdrawal. It exercised walletless A-to-B-to-A guarding, the fixed contribution pool, duplicate banner protection, independent receipt/profile reconstruction, cancellation without completion credit, administrator-signed withdrawal and private erasure with retained public evidence. Its three synthetic accounts were removed. Five additional hosted HTTP workflows passed and removed eleven synthetic accounts.

The [published frontend checks](deployment/frontend.ledger.validation.json) passed eighteen checks, including exact served JavaScript hashes. The [website](https://safety-guard-htn2026.klavander56.chatgpt.site) retains owner-only access. Browser rendering and wallet-extension interaction were unavailable; those acceptance checks are not claimed. This release uses Devnet, platform attestations and offline AI, with the operational boundaries described above.
