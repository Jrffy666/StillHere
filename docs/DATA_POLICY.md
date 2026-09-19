# Data handling implemented by Safety Guard

This document describes current application behavior and operator responsibilities. It is a technical data policy, not a claim of regulatory certification.

The [community ledger release](COMMUNITY_LEDGER.md) adds mandatory publication of minimal records for new official journeys after a member accepts the public-record notice. Guarding assignments, check-ins, relay requests, closure, contribution allocations and voluntarily sent banners use random community references on Solana Devnet. These records are readable beyond authenticated website members. Stable identifiers and timing can reveal participation relationships; pseudonyms are not anonymity. Names, biographies, private journey IDs, routes, locations, conversations and contacts are not part of the ledger payload.

Minimal publication intents and public receipt indexes are retained independently of private journey state, so deleting a journey does not cancel an already authorized public record. Account deletion removes its private identity mapping; public records and downloaded copies can remain. Corrections append an authorized withdrawal instead of erasing prior evidence. Older private journeys are not automatically backfilled. These rules are distinct from the site's current owner-only access policy.

## What is stored

| Data | Storage and access |
| --- | --- |
| Display name, biography, contribution values and banner counts | Account data and community index; visible to all authenticated community members, with no visibility toggle |
| Account-to-wallet mapping and account-to-community-reference mapping | Protected account storage; the member's public community reference is exposed through their community evidence, while wallet/authentication metadata is excluded from the public profile |
| Session and recovery credentials | Hashes in the account object; plaintext returned only when issued |
| Wallet authorization challenges | Short-lived challenge object, bound to account operation, origin, nonce, and expiration |
| Route labels, shared ride link, locations, chat, check-ins, escalation contacts | Private journey object; rider and currently approved guardian |
| Lobby entries | Minimal journey summaries without the private route, contacts, or chat |
| Chain journey reference, wallets, handovers, signed contribution counts, reward allocations | Public Solana accounts/transactions |
| Community references, ordered participation, contribution allocations and banners | Minimal publication intents and independent public receipt indexes; finalized Solana records are readable outside the website and labelled platform-attested |
| Reports | Categorical reason and account/journey identifiers; operator access |
| Transaction outbox | Signed transaction bytes, hashes, statuses, and public chain metadata; no wallet signing key |
| Community issuer and sponsor signing keys | Dedicated Worker secrets used for publication and fees; participant and administrator/deployment private keys are not held by the Worker |

The backend generates a random 32-byte reference for each linked journey. It does not publish a hash of an Uber URL, a location, a phone number, a name, or chat contents. A random reference still links public wallet activity within that journey; using a blockchain does not make wallet behavior anonymous. A wallet signature proves wallet control, not a verified real-world identity.

When a guardian is replaced, the old guardian loses the private journey view. Their public contribution and reward receipt can remain accessible. Account data exports contain the user's own account/credit records and only journey content they are currently authorized to see; an export does not recover another participant's revoked private view.

## Retention and deletion

| Record | Implemented retention |
| --- | --- |
| Closed ordinary journey private state | 30 days after closure, then alarm/read-triggered purge |
| Closed demo journey | 7 days after closure |
| Open journey | Until closed or explicitly removed by account erasure; closed-record retention does not start while monitoring is active |
| Reports, operator audit records, backup manifests | 90 days; daily cleanup alarm |
| Report rate counters | One-day window, cleaned by the governance alarm |
| Session | 30-day expiration, bounded active-session count; individually or collectively revocable |
| Pending account deletion journal | Until all referenced private objects have been scrubbed |
| Completed deletion, purged-journey, wallet-reservation, and reward-credit tombstones | Minimal records retained to prevent resurrection, identity reuse, or duplicate credit |
| External encrypted backups | Controlled by the operator; the optional manual GitHub workflow retains artifacts for 14 days |
| Public blockchain records | Permanent from the application's perspective |

`POST /api/account/delete` requires an authenticated session and `{ "confirmation": "DELETE MY ACCOUNT" }`. It immediately marks the account deleted, revokes access, scrubs participant records, and anonymizes the account. A persistent deletion journal allows the five-minute maintenance cron to finish work after an interruption. Completed journals discard their list of journey IDs while retaining the account deletion marker.

Riders can erase their closed private journey using `POST /api/trips/:id/delete` with `{ "confirmation": "DELETE JOURNEY" }`. The purge removes private state and directory visibility and records a permanent erasure marker. Other participants cannot erase the rider's journey. Removing an account also removes or anonymizes its private participation in affected journeys. Where freeform text may have quoted a deleted participant, the implementation can remove additional conversation/event context instead of attempting unreliable string redaction.

Deletion does not remove public Solana transactions or previously downloaded copies. Points already finalized on chain remain publicly visible. Minimal account/wallet/credit protections can remain after private profile removal; the account cannot sign in or be recreated from an older backup under the same identity.

## Backups and restored data

Backups contain private data and must remain encrypted outside the source checkout. Store the encryption key separately. Sessions and recovery credentials are excluded, and active journeys never restart monitoring automatically after restoration.

Restoring an old backup merges current destination protections and the supplied latest source governance journal before applying resource data. The CLI also preserves the latest wallet authorization and all historical wallet ownership reservations, so a revoked wallet does not regain account access merely because older business data was selected. An old archive alone cannot know later deletions or wallet rotations in a new empty destination. Keep a current protection archive for as long as older archives are recoverable; follow the [recovery procedure](OPERATIONS.md#recovery-drill) before making restored data accessible.

An account deletion does not rewrite archives already held by an operator. Their expiration must follow the operator's backup policy, and restoration must reapply erasure protections. Operators should restrict archive/key access, use a dedicated secret manager, and record recovery drills without logging plaintext participant data.

## Current limits

This release does not use an official Uber order API or promise emergency dispatch. Ride details are shared by users. The AI companion remains an offline mock even if an OpenAI key is present; enabling a live model requires further implementation. Voice and outbound notifications remain separately configured optional services. Participants need no provider credential or wallet for ordinary human guarding; sponsored community publication requires the operator's issuer, sponsor and Devnet funding. Community reports and fixed reward pools reduce some abuse but do not establish real-world identity or prevent all collusion.
