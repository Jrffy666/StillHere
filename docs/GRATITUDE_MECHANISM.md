# Free companionship and optional gratitude

Updated September 20, 2026. The user accepted free structured appreciation banners and contextual contribution records for community v1. Financial tips and transferable tokens are deferred. See [COMMUNITY_V1.md](COMMUNITY_V1.md) for implementation and validation status.

The next-version requirement now makes **on-chain records mandatory for eligible sent banners, community contributions and guarding history**. Sending a banner remains optional; the recipient cannot opt out of its official contribution/recognition visibility. See [ONCHAIN_COMMUNITY.md](ONCHAIN_COMMUNITY.md) for the proposed Solana implementation and explicit trust/privacy boundaries. The app-only v1 behavior described below is the current deployment, not the completed next-version implementation.

## Core rule

Everyone can request and receive companionship without payment, tokens, a deposit, collateral, or a promise to give something afterward. A guardian volunteers their attention. Gratitude expresses appreciation for that experience; it does not purchase the right to receive care.

Financial circumstances, expected tips, wallet wealth, and donation history are not matching or private-access criteria. The existing application-only flow does not require a wallet.

## Three distinct records

| Record | V1 decision | Effect on recognition |
| --- | --- | --- |
| Contribution record | Show observed participation through a redacted community profile | Describes application evidence; cannot be bought |
| Free appreciation banner | Let the rider choose a predefined appreciation category for an eligible guardian after closure | No additional points, reputation, monetary value, or access privileges |
| Financial gift or transferable token | Deferred; no transfer flow in this release | Must remain separate from contribution evidence if introduced later |

A banner is a structured record, not unrestricted public thank-you text, an NFT, or an on-chain credential. Community v1 does not require tokenization or a contract upgrade.

## Accepted v1 flow

1. A rider requests companionship through the application-only or existing optional chain-linked path.
2. A prospective guardian can review the rider's profile before applying. The rider can review the applicant's profile and contribution values before approving them.
3. The approved guardian accompanies the rider through existing chat, availability check-ins, and handoff controls.
4. The rider ends monitoring as arrived or cancelled. Closure and eligible contribution settlement do not depend on giving thanks.
5. On the closed journey, the rider may send a free predefined banner to an actual checked-in guardian, including a guardian replaced earlier in that journey.
6. The guardian's community profile includes the appreciation in its category counts without exposing the sender or private journey details. Repeating the request cannot create a second banner for the same journey and guardian.

Skipping thanks requires no explanation and causes no penalty, debt reminder, loss of access, or reduced matching priority. A missing banner is not a negative review. There is no payment action or suggested tip in this release.

## Eligibility and permissions

- Only the journey's rider can create its appreciation banners.
- The journey must be closed with status arrived or cancelled.
- The recipient must be a real participant recorded as a guardian with at least one check-in in the journey's contribution state. Application check-ins and reconciled signed-chain contribution check-ins can establish this; the completed-journey reward keeps its separate eligibility rules. A pending applicant, outsider, simulated guardian, or assigned guardian with no check-in does not qualify.
- A rider may thank each eligible guardian from a relay journey, but at most once per journey and guardian.
- The backend validates both the recipient and the predefined category; a client cannot manufacture participation by sending arbitrary identifiers.
- A cancelled journey can receive appreciation for an eligible contribution without becoming reward-eligible. No arrival declaration is required merely to send thanks.
- Creating, retrying, skipping, or failing to send a banner does not alter the 25-point / 10-reputation reward pool.
- Viewing a profile or receiving a banner never grants private journey access, approves a guardian, closes a report, or hides a complaint.
- Agent tools cannot create a financial transfer or sign a wallet transaction.

## Community visibility

Community profiles, contribution values, redacted earned-credit records, and received appreciation counts are visible to other authenticated community members. There is no per-member opt-in switch for that visibility. This information is available before application or approval, so participants can review one another before entering a guarding relationship.

A biography can be blank and sending a banner is optional. Those choices do not make contribution values private. The distinction is between optional content and mandatory visibility of the community profile.

This release does not publish the profile to unauthenticated internet visitors or change the owner-only hosted site's access policy. It also does not introduce a sitewide leaderboard.

Freeform private chat, routes, location, contact information, and agent context stay within their existing authorization boundary. Structured banner records avoid publishing a personal thank-you message that could reveal a route, sensitive event, or another person's identity. A profile must not turn an internal journey or sender identifier into a public private-trip link.

## Acceptance checks

A complete v1 check should demonstrate:

1. A member with no wallet and no points can request and receive companionship.
2. Authenticated members can read a rider or candidate profile before approval, while unauthenticated requests fail and private journey data remains inaccessible.
3. The rider can thank an eligible guardian after arrival or cancellation, including an earlier guardian from a relay.
4. Outsiders, guardians acting as senders, active journeys, nonparticipants, unchecked-in recipients, and demo recipients are rejected.
5. A retry cannot create a duplicate banner for the same journey and guardian.
6. Contribution balances and reward settlement stay unchanged by thanks.
7. Profile projections omit routes, chat, precise coordinates, contacts, internal gratitude sender/journey identifiers, and private agent traces.
8. Account deletion and backup restoration follow the documented retention and deletion protections.

Actual test results belong in [COMMUNITY_V1.md](COMMUNITY_V1.md) and [VALIDATION.md](VALIDATION.md). This list is an acceptance specification, not proof of a hosted test run.

## Deferred financial features

The user deferred tips and tradable community tokens. This release creates no payment contract, escrow, financial gift transaction, token issuance, fee sponsorship, or monetary-value promise.

If financial gifts are revisited, they need a separate post-journey flow with an actual participating recipient, an explicit amount/asset/network, clear fees, user-owned signing, and honest transaction status. A failed gift must leave closure and contribution evidence intact. The gift cannot buy reputation or preferred access. These are future design constraints, not implemented controls for a current payment feature.

On-chain participation already has network and account-creation costs. The current application-only path remains the no-wallet alternative. Neither “free thanks” nor “free companionship” claims that infrastructure is costless or that current Devnet signing flows are gasless.

Blocking, payment-pressure reporting, and former-participant reporting are useful future community work but are outside this v1 implementation. Existing moderation remains available within its documented scope.
