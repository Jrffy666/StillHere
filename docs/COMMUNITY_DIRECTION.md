# Community direction and development priorities

Updated September 20, 2026. This document records the accepted product direction. The current implementation and validation checkpoint belongs in [COMMUNITY_V1.md](COMMUNITY_V1.md); a design decision alone does not establish that a hosted release includes it.

## Product purpose

Safety Guard is a community where people voluntarily accompany one another through journeys. A member can be a rider on one occasion and a guardian on another. People with available time can contribute attention, including across time zones.

Human relationships, dependable handoffs, and free participation are central. Blockchain receipts record specific actions. The offline agent supports check-ins and continuity. Neither a receipt nor an automated message certifies a person's character, professional competence, uninterrupted attention, or future conduct.

Companionship does not require payment, a wallet, tokens, staking, a deposit, a donation, or a promise to return the favor. The existing application-only journey remains available alongside optional signed Devnet commitments.

## Accepted community v1

The user subsequently required **appreciation banners, community contributions, and guarding history to have Solana records**, rather than optional on-chain publication. [On-chain community records](ONCHAIN_COMMUNITY.md) defines this next-version requirement and the proposed evidence, identity, sponsorship, privacy and synchronization design. The v1 implementation below remains the shipped baseline; accepting the next-version direction does not imply it has already been deployed.

The first community release focuses on profiles, contribution records, and free appreciation banners. Transferable tokens and financial tips are deferred.

| Decision | Community v1 |
| --- | --- |
| Profile | A display name, an optional short biography, and application-derived contribution information |
| Visibility | Every member's profile and contribution values are visible to other authenticated community members; there is no opt-in visibility toggle |
| Before application | A prospective guardian can review the rider's community profile before applying |
| Before approval | The rider can review a candidate's profile and contribution history before approving private journey access |
| Recognition | Contextual contribution records and a free structured appreciation banner after a journey closes |
| Gratitude eligibility | The rider can thank an actual guardian with a recorded check-in; one banner per journey and guardian |
| No financial influence | Banners do not award points or reputation, buy access, or change reward settlement |
| Discovery | The existing request board and application flow; no sitewide leaderboard |
| Language | No language matching or translation integration in this demo release |

Profile visibility is a membership rule, not a separate publishing feature. A member may leave their biography blank, but cannot hide their contribution values from other authenticated community members. The interface should make this visibility understandable when members edit a profile or review another participant.

“Visible to the community” does not mean unrestricted access from the public internet. Profile reads require application authentication. The existing hosted site remains owner-only until a separate access-policy decision changes it.

## Public community information and private journey information

A member profile shows the member's display name, biography, earned application counters, redacted earned-credit entries, and appreciation category counts. Contribution values describe recorded participation, not a universal trust score. The first projection does not expose individual banner senders or private journey links.

Routes, precise locations, destination labels, chat, contact details, notification content, credentials, and private agent traces remain private journey data. Looking at a profile, applying to guard, or sending thanks does not grant access to them. The rider still approves a guardian, and a replacement still revokes the former guardian's private access.

Contribution records must not expose another participant's identity or private journey details through their display fields. Chain-linked receipts already have public ledger semantics; a community profile must not quietly add new links from a wallet to a private trip or conversation.

## What recognition means

The existing reward is one 25-point / 10-reputation pool per eligible completed journey. Guardians share that pool after the relevant qualifying check-in; linked journeys retain their existing signed-chain requirements. Repeated check-ins and relays do not enlarge the pool. Demo and cancelled journeys do not earn that pool.

A cancelled journey may still contain a real act of companionship. A qualifying guardian can receive a free appreciation banner after cancellation without requiring the rider to claim arrival. The banner does not convert cancellation into reward eligibility.

Points, reputation, contribution records, and banners are separate observations. A free banner is an optional expression of thanks. Not receiving one is not negative feedback, proof of poor conduct, or a reason to restrict future participation.

Current check-in evidence does not measure sustained attention or the quality of care. One qualifying check-in can remain eligible despite later missed coverage. Per-journey settlement prevents duplicate settlement for that journey, but does not prevent colluding accounts from creating additional journeys. Do not present these counters as verified safe trips or a moral rating.

## Free participation and open development

The product direction is free, voluntary companionship and transparent development. Hosting, notification delivery, and on-chain transactions still consume resources. Donations or sponsorship could fund operations without purchasing recognition or preferred access; a sustainable funding system is separate work.

The current V2 contract stores contribution counters in application-defined Solana accounts. It does not mint a transferable community currency. No token sale, exchange listing, staking return, cash redemption, or monetary-value promise is included in community v1.

Open development should expose source code, protocol rules, recognition criteria, and contribution instructions while protecting private data and credentials. An appropriate project license, maintained public source repository, and invited-member rollout remain separate release decisions. Owner-only deployment must not be described as a public community launch.

Suggested community statement:

> We make time for one another. Our community recognizes the care people choose to give, and everyone can ask for companionship without buying it.

## V1 member experience

1. Join with a display name and, optionally, add a short biography. Understand that the community profile and contribution values are visible to other signed-in members.
2. Browse requests and review a rider's profile before applying. Availability is agreed through the existing flow; an open browser does not prove attentiveness.
3. The rider reviews candidate profiles and chooses whether to approve one. Viewing a profile alone reveals no route, chat, or contact details.
4. Accompany the rider using conversation and explicit check-ins. Request a human relay when needed; the rider approves the replacement.
5. End the journey without waiting for thanks. On an arrived or cancelled journey, the rider can optionally send a free structured banner to an eligible checked-in guardian.
6. Review the member's contextual contribution history. There is no sitewide ranking or financial reward for receiving thanks.

## Deferred roadmap

The following are future proposals, not dependencies or delivered features of community v1:

- Expiring availability sessions, time-zone preferences, expected commitment windows, and an enforced active-assignment capacity limit.
- Language-based discovery and any translation service. Fixed multilingual mock-agent fixture phrases do not constitute translation integration.
- Member blocking, repeat invitations, reciprocal feedback, and a reporting route available to former participants without restoring private journey access.
- More contextual reliability measurements with sample sizes and explicit limits; raw assignment duration must not be labelled verified attention time.
- Required on-chain appreciation, contribution and guarding-history records under [the next-version design](ONCHAIN_COMMUNITY.md). Sending thanks remains voluntary; publishing an eligible sent banner is part of the required record workflow.
- Financial gifts remain deferred. A transferable balance must never become purchased guarding experience.
- A small invited-community pilot and a separately decided change to hosted access.

The current turn does not add availability management, a one-active-journey rule, blocking, a new chain program, or live AI. Live-model integration remains deferred until credits and an explicit integration decision are available.

## What to measure

Measure requests that find an accepted guardian, unfilled requests, responsible handoffs, return participation, and resolution of reported concerns. Include sample counts and the measurement period. Avoid optimizing for always-online status, total chat volume, cumulative wealth, or a public ranking of members.

Implementation references: [community v1](COMMUNITY_V1.md), [gratitude rules](GRATITUDE_MECHANISM.md), [human guarding](HUMAN_GUARDING.md), and [V2 architecture](ARCHITECTURE_V2.md).
