# On-chain community records

Updated September 20, 2026. Status: accepted product requirement with a proposed implementation design. This document does not claim that the new program, sponsorship service, or community synchronization has been implemented or deployed.

Development is tracked separately in [COMMUNITY_LEDGER.md](COMMUNITY_LEDGER.md), including the exact first-version provenance, allocation rules, correction scope and release evidence. This document preserves the design rationale; consult the implementation report for current delivery status.

## User decision

Appreciation banners, community contributions, and guarding history must have records on Solana. This replaces the earlier suggestion that publishing these records could remain an optional extra. Members must be able to inspect the evidence behind a guardian's community recognition independently of a mutable website counter.

Sending appreciation remains voluntary. Once an eligible real banner is sent, its inclusion in the community ledger is required. Members cannot hide earned contribution values from the community. There is no sitewide ranking, payment requirement, staking requirement, transferable recognition market, or financial tip in this release direction.

Mandatory recording means every eligible production event enters a durable publication workflow. It does not mean waiting for a network confirmation before helping a rider, handing off responsibility, or ending monitoring. Unconfirmed work is shown as pending and never counted as finalized on-chain evidence.

## Current implementation boundary

- The existing V2 program is deployed on Solana Devnet and integrated with wallet-signed journey creation, guardian proposals and acceptance, check-ins, completion/cancellation, and contribution claims.
- V2 has a fixed 25-point / 10-reputation pool for an eligible completed journey. It does not mint a tradable currency.
- Community v1 stores profiles, biography text, contribution projections, and free appreciation in the application's Durable Objects. A public contribution total can contain both app-only and finalized chain-derived credits; it has no per-record provenance field today.
- V2's aggregate contribution state does not by itself provide the proposed complete, indexed, versioned community history. Current gratitude receipts have no on-chain counterpart.
- Fee sponsorship, walletless community attestations, independent community-ledger reconstruction, correction records, and migration of retained historical data are new work.

Existing implementation and evidence remain in [COMMUNITY_V1.md](COMMUNITY_V1.md) and [ARCHITECTURE_V2.md](ARCHITECTURE_V2.md). Do not relabel the current site as fully on chain because this requirement has been accepted.

## Three linked record families

| Family | Proposed record | Required behavior |
| --- | --- | --- |
| Guarding history | A pseudonymous journey reference; guardian/member reference; accepted assignment; observed check-in evidence; accepted handoff; and a closed outcome such as arrived, cancelled, or expired | Preserve order and the distinction between observed actions and inferred qualities; retain cancelled participation without converting it into a success |
| Community contribution | Reference to eligible guarding evidence; rule version; allocation or claim; evidence source; any later correction reference | Prevent duplicate issuance and imported/app credit being counted again as an additional chain reward |
| Appreciation | Reference to an eligible participation record; recipient; predefined banner category; sender authorization or declared attestor; unique issuance reference | One banner per journey and guardian; allow eligible former guardians and cancelled journeys; never add points or transfer contribution history |

Guarding history means relevant participation events, not the full route, every location ping, message text, or raw automated-agent trace. Record timestamps must distinguish the claimed observation time from the actual chain inclusion time. An accepted handoff is distinct from requesting a handoff; a check-in is distinct from uninterrupted attention; a rider-declared arrival is distinct from independently verified physical safety.

Assign each period of responsibility its own assignment reference and preserve event order. An A-to-B-to-A relay contains three assignments even though it involves only two guardians. V2's per-guardian contribution slots cannot reconstruct that complete chronology. Journey creation, relay requests, accepted assignments and closure should have distinct event types; requesting a relay does not itself earn a completed handoff.

Recognition should remain bound to its earned identity rather than being tradable. The contract can store structured records directly; an SPL token or NFT is not required to satisfy this product requirement. Full minimal records should be independently interpretable. A bare hash whose underlying document disappears is not sufficient community history.

## Recommended program design

Add a separately versioned community-record program alongside V2. Preserve existing V2 journeys and receipts. The exact schema and instruction interface require an implementation review and tests before deployment; no address is allocated by this document.

The proposed primitives are a stable member reference, ordered participation records, contribution records, appreciation records, and explicit correction/withdrawal references. Use deterministic record identities to reject duplicate submissions. Bind each record to its network, program version, source and responsible signer so a receipt cannot be reused in another environment or represented as stronger evidence than it is.

For chain-backed records, validate the referenced V2 account's owner program, journey identity, participant, relevant final state and qualifying contribution. Merely attaching a transaction URL or accepting an application-provided `verified: true` flag is insufficient.

For app-only events, use a clearly declared attestation path rather than pretending the program can read a private database. This path requires a designated issuer, constrained issuance rules, a stable identity mapping, and a funded transaction service. Its trust boundary must be visible in each record and in the profile.

## Identity, signatures and free participation

Free participation without owning SOL or installing a wallet remains a requirement. Recommended initial design:

1. A stable pseudonymous community identity is assigned to the account. It is separate from a changeable display name and from the private journey ID.
2. Wallet-linked actions can carry the member's own authorization and reuse relevant verified V2 state.
3. For a member without a wallet, the application authenticates the action and a designated platform issuer records an attestation. Label it **Platform-attested**. A platform signature does not become a signature by the rider or guardian.
4. Linking or rotating a wallet later proves control and appends the identity association under documented recovery rules; it must not rewrite who signed earlier records or duplicate accumulated contributions.
5. A dedicated, limited sponsor pays eligible transaction fees and account-storage funding. Separate sponsorship from authority to issue recognition. Do not deploy a project upgrade/deployer key as an ordinary web-server secret.

The exact walletless identity and issuer model above is an implementation recommendation, not an already deployed trust system. The user has required on-chain records and free access; the design must satisfy both transparently.

Solana transactions require fees in SOL, and on-chain data accounts require a minimum storage balance. Sponsoring both is real application work, with abuse controls and funding monitoring; calling the service free does not remove these costs. See [Solana fees](https://solana.com/docs/core/fees) and [Solana accounts](https://solana.com/docs/core/accounts).

## Privacy and persistence

On-chain records are observable beyond authenticated community members. Explain this expanded audience before users create new official records. Do not publish display names, biographies, routes, precise location, destination labels, chat, contact details, private trip invitation URLs, report contents, or agent context to the chain.

Use pseudonymous references and minimal typed facts. Pseudonyms do not guarantee anonymity: repeated references, transaction timing and wallet associations can reveal relationships. Hashing a predictable private value does not make it confidential. Keep the mapping to app identities protected, and avoid exposing private trip identifiers as public record identifiers.

Community profile visibility remains mandatory within the application; this does not require publishing every profile field on Solana. Website owner-only access is also independent of public blockchain visibility.

Design issuance records without ordinary overwrite or deletion instructions. Corrections should be new, linked records that preserve the original and disclose the reason category, authority and version. A dispute is not an automatic finding of misconduct, and raw accusations must stay off chain. If an aggregate changes, expose which accepted correction explains it.

Solana accounts are not inherently immutable documents: their owner program controls permitted updates. The implementation must specify record-write rules and upgrade authority, and disclose those governance powers. Do not claim that a program with retained upgrade authority makes future changes impossible.

Account deletion can remove app data and private mappings; it cannot promise removal of copies of public blockchain history. This limitation must be stated in onboarding and data handling documentation before rollout. Archival retrieval/indexing and replay must also be designed; Devnet is a development network, not a promise of permanent production archival service.

## Synchronization and display

Persist each authorized source event and its publication intent before attempting a transaction. Submit and reconcile using a durable outbox with retry, duplicate suppression, expiry handling and confirmation checks. Solana applies the instructions of a transaction atomically, but this does not make the application database and blockchain a single atomic system; see [Solana transactions](https://solana.com/docs/core/transactions).

The publication queue must survive private TripRoom retention and deletion. Carry only the minimum authorized public payload into this separate durable queue. On recovery, reconcile deterministic record identities against the chain before resubmitting; do not inherit v1's policy of cancelling pending gratitude during snapshot restoration. That policy cannot fulfill mandatory publication.

The interface should show **Pending on chain**, **Submitted**, **Finalized**, and **Needs retry** distinctly. Each finalized record exposes its receipt address or transaction and its evidence class. A chain-confirmed platform attestation must still say **Platform-attested**; finality does not remove dependence on the issuer.

Profiles should derive finalized recognition from verified records or a reproducible index. Pending contributions may be displayed separately, without presenting them as finalized. The backend can cache and index records for speed, while retaining enough publicly readable data and rules for independent reconstruction.

Recognize the same contribution once across app and chain representations. A newly published receipt of an already credited journey changes its verification status, not the user's score for a second time. Banners never alter contribution points.

## Migration and validation

Begin on Devnet, using synthetic data for contract and integration validation. Do not bulk-publish existing members' historical private data simply because the new direction requires future records on chain. Prepare a data-minimizing migration specification and make the new public-record terms clear before any real historical publication.

Retained v1 data can support an explicitly labelled historical platform attestation where evidence exists. It cannot manufacture old participant signatures, exact events already discarded, or independent validation of an app-only trip. Unsupported old records stay labelled as legacy evidence; do not invent history to make a ledger appear complete.

Required acceptance cases include unauthorized issuers and participants, duplicate/replayed records, stale or out-of-order transitions, former-guardian appreciation, cancellation without successful-arrival credit, simulated-demo exclusion, absent wallets, sponsor failure, lost transaction acknowledgements, delayed confirmation, crash/restart, app-to-chain double counting, wallet association changes, corrections, data deletion boundaries, and rebuilding a profile from the published records.

Development sequence: specify source/evidence and versioned record schema; implement and test the community program and client; add durable publication and sponsorship; expose provenance and receipts in the profile; run signed Devnet end-to-end validation; then plan any historical migration or broader rollout. AI provider integration and visual frontend work can continue independently of this record layer.

Agent support does not authorize an AI to issue appreciation on a member's behalf, declare their safe arrival, or award itself community contributions. Existing human authorization boundaries remain in effect when adding the record layer.
