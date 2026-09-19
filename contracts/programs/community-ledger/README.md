# Community Ledger v1

This separate Solana program records **platform-attested** community participation, contribution allocations, and appreciation. It does not validate real-world safety, verify the existing V2 program's accounts, or turn a platform signature into a participant signature. V1 and V2 deployments are preserved.

## Authorities and sponsorship

`initialize(issuer, sponsor)` creates the singleton `community_config` account. Only the deployed program's current upgrade authority may initialize it, using the canonical upgradeable program-data account. The administrator, issuer, and sponsor must be three distinct nonzero public keys.

The administrator can rotate all three authorities with an expected configuration revision. Every ordinary event requires both the configured issuer and configured sponsor to sign. The sponsor pays for new journey/record account storage; it can also be the transaction fee payer. Members need no wallet or SOL for this attestation path. Never install the administrator or program upgrade key as an ordinary Worker secret.

The retained upgrade authority remains capable of replacing the program. These records are append-only under the deployed instruction set, not a claim that governance can never change.

## Public schema

All identity references are nonzero random 32-byte pseudonyms, independent of private application IDs. Never use names, destinations, contact details, invitation URLs, or predictable hashes of private identifiers. A pseudonym is linkable and is not a promise of anonymity.

`append_event(EventInput)` accepts:

| Field | Encoding | Meaning |
| --- | --- | --- |
| `journey_id` | 32 bytes | Public random journey reference |
| `sequence` | u32 | Zero-based ordered source-event sequence |
| `kind` | u8 | One of the kinds below |
| `actor_id` | 32 bytes | Attributed actor, not a claim of their signature |
| `subject_id` | 32 bytes | Rider or guardian concerned by this event |
| `assignment` | u32 | Accepted responsibility period; returning guardians get a new period |
| `observed_at` | i64 | Issuer-reported observation time in Unix seconds |
| `value` | u8 | Typed outcome, category, or automated-request marker |

Every receipt additionally contains version 1, provenance 1 (`platform-attested`), rule version 1, the actual issuer public key, chain clock time, computed points and reputation, and an optional correction target sequence. Claimed observation time and chain inclusion time are separate.

| Kind | Value | Actor and subject |
| --- | --- | --- |
| 1 `created` | 0 | Both are the rider |
| 2 `assigned` | 0 | Rider, newly accepted guardian; assignment increments |
| 3 `check_in` | 0 | Both are the current guardian; current assignment required |
| 4 `relay_requested` | 0 human / 1 automated | Rider/current guardian for human requests; zero actor for an automated request; subject is current guardian |
| 5 `closed` | 1 arrived / 2 cancelled / 3 expired | Both are the rider |
| 6 `contribution` | 0 | Both identify the credited guardian; their last accepted assignment required |
| 7 `gratitude` | 1 companionship / 2 thoughtfulness / 3 relay | Rider, eligible guardian; their last accepted assignment required |
| 8 `withdrawn` | Correction reason 1–4 | Rider references; actual signer is administrator, not rider |

Source-event receipts use PDA seeds `[community_record, journey_id, sequence_le]`. Journey state uses `[community_journey, journey_id]`. Assignments A → B → A therefore produce three assignment events while retaining two unique contribution slots. There are at most 16 distinct guardians per journey. Observation times must be nondecreasing, positive, and at most 300 seconds ahead of the chain clock; delayed historical submission is allowed.

## Recognition rule

Only guardians with at least one accepted check-in qualify. An arrived journey splits exactly 25 points and 10 reputation equally among qualifying unique guardians. Remaining units go in lexicographic order of the public member reference. Repeated assignments and extra check-ins do not create extra shares. Each guardian can receive its contribution receipt once.

This is community rule version 1. The older wallet-signed V2 protocol uses wallet ordering for remainder allocation; its receipts are separate evidence and must not be added again to community totals. Do not silently represent the two protocols as an identical allocation.

The rider can issue one appreciation per eligible guardian after closure, including former guardians and cancelled journeys. Appreciation never changes points. Acceptance without a check-in does not qualify, and a cancelled or expired journey cannot issue contribution points.

## Administrative correction

`withdraw_journey(journey_id, expected_next_sequence, target_sequence, reason, observed_at)` requires the administrator and sponsor. The journey must already be closed. The target must be an existing source receipt in that journey. Reasons are `incorrect_evidence` (1), `duplicate_identity` (2), `invalid_authorization` (3), and `administrative_correction` (4). Raw reports and accusations stay private.

There is one withdrawal PDA per journey: `[community_withdrawal, journey_id]`. It stores the ordinary next-sequence snapshot for audit, but **does not consume a source-event sequence or change ordinary observation ordering**. This prevents an already authorized, durably queued appreciation from colliding with a correction.

The withdrawal permanently excludes all contributions and appreciation from that journey from effective recognition. Original receipts remain. Late eligible contribution and appreciation receipts can still be published to preserve the audit trail, but remain excluded. This first version supports whole-journey withdrawal only, not partial editing, replacement amounts, automatic restoration, or redistribution. A duplicate withdrawal fails.

## Independent reading

Account sizes including the Anchor discriminator are configuration 109 bytes, journey 796 bytes, and record 173 bytes. The portable TypeScript module is `chain/src/community.ts`.

`fetchFinalizedCommunityJourney(connection, programId, journeyId)` fetches a bounded finalized journal, verifies every account owner and deterministic identity, and reads the separate withdrawal PDA when relevant. It returns records and the journey snapshot slot. `reconstructCommunityProfile(memberId, records)` deduplicates receipts and excludes withdrawn journeys. Only pass independently verified finalized records to reconstruction; a JSON response by itself is not proof of chain ownership or finality. Complete member discovery requires a reproducible index of all relevant journey references, with pagination and archival storage for larger deployments.

## Development commands

From `chain/`, run `npm run setup:community` to prepare a separate program key plus issuer and sponsor keys. Keys are stored only under ignored `contracts/.keys/` and `contracts/target/deploy/`; deployment metadata contains public keys only. Setup refuses missing or conflicting previously recorded keys and never submits a transaction.

Build with `bash contracts/scripts/build-community.sh` in the Linux toolchain. It pins SBF tools v1.56, architecture v3, and size optimization. Only the community binary is built. Deploy with an explicit test RPC and a reviewed `--max-len`; never rely on a global CLI RPC configuration.

`npm run verify:community:local` runs signed transaction scenarios against localhost after local deployment. Set `COMMUNITY_TEST_ADMIN_KEYPAIR` to the local program upgrade-authority key. The script may airdrop local-validator SOL to the administrator and sponsor.

`npm run verify:community:devnet` uses the exact Devnet genesis and requires an explicitly selected administrator key plus a separately funded sponsor. It initializes/rotates this program configuration, creates synthetic public journeys, and submits signed test transactions. It never funds a wallet automatically on Devnet. Report paths are separate per cluster. Devnet records are development evidence, not a promise of permanent production archival service.
