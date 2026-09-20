# Community contribution, appreciation, and human relay demonstration

Updated September 20, 2026. This walkthrough exercises ordinary human journeys and their sponsored Solana Devnet records. No model credentials, voice, or external notifications are needed. The [hosted ledger verification](deployment/community.ledger.hosted.devnet.json) already passed the HTTP-to-chain workflow; the steps below are a browser rehearsal, not a claim that manual browser acceptance has been completed. Use [COMMUNITY_LEDGER.md](COMMUNITY_LEDGER.md) for current rules and [VALIDATION.md](VALIDATION.md) for evidence.

## What is implemented

Contribution points, completion records, free appreciation categories, public member profiles, an appreciation wall, an honor cabinet, and chain receipt links are implemented. Points are non-transferable recognition, not cash or a tradable token. Appreciation has no purchase price and adds no points. Cabinet milestones are visual summaries of confirmed records, not separately minted awards. There is no collectible NFT or global leaderboard.

The simplified interface has three destinations: **My journeys**, **Guard network**, and **My profile**. It no longer exposes the one-person simulated journey launcher. Existing simulated journeys remain labeled and do not award official contributions. To demonstrate the recognition mechanism, use ordinary **New journey** creation with separate rider and guardian accounts. A controlled demonstration can use fictional participants and routes while creating actual Devnet records. Identify those participants as demonstration accounts; do not present their activity as real passenger trips.

## Prepare access and accounts

The published site allows the owner and the additional demo viewer requested by the owner. Both browser contexts must first pass that website access gate using an allowed login. Viewer access permits using the application, not editing or administering the site. Inside the application, create different guest identities with **Enter StillHere**, for example `Demo Rider` and `Demo Guardian`. Separate browser profiles or different browsers are preferable to duplicated tabs. Application identity and the website access login are different layers.

Guest credentials are held in session storage. Keep the rehearsal sessions available; without an established recovery method or linked wallet, closing a session or signing out can lose access. Wallet identity is optional for participation and separate from the wallet-signed commitment option.

Automated verification removed its synthetic accounts. It did not leave a populated demonstration profile for reuse. Prepare a dedicated rehearsal journey in advance and retain its accounts if you want existing records available during judging. Use a profile introduction that identifies the account as a controlled demonstration.

## Minimal two-account contribution and banner walkthrough

1. In the guardian session, open **My profile** and show the initial counters. A fresh account should have zero confirmed points, contributions, and banners.
2. In the rider session, choose **New journey**, enter fictional route details, accept the public-record notice using **Continue with public records**, and choose **Create guarded journey**. Keep **More options** closed for the ordinary walletless flow, or open it to select a 300-second check-in interval for narration. Leave the optional wallet-signed commitment unchecked. Community publication still applies automatically.
3. Use **Copy guardian invite** and open it in the separate guardian context. Review the rider profile, accept the public-record notice and the check-in commitment, then choose **Apply to guard**.
4. As the rider, review the candidate's profile and choose **Approve guardian**. As the guardian, select **I am here · Check in** at least once; **Resume & check in** is the equivalent control when marked unavailable. Approval alone does not qualify for a completion allocation.
5. As the rider, choose **I've arrived**. The journey closes and its eligible contribution is queued for publication. Open **Contribution & chain receipts** to show **Public guarding history** and the distinction between pending, submitted, and **Chain confirmed** records. Publication is asynchronous; do not promise a fixed confirmation time.
6. Once the contribution is confirmed and the profile refreshes, open the guardian's **My profile**. For a fresh account with exactly this one eligible journey, expect **Confirmed points: 25**, **Confirmed contributions: 1**, and **Confirmed banners: 0**. Expand **Contribution history & receipts**; the contribution record itself also shows **+10 reputation**. Creating a journey as the rider does not award the rider these guardian points.
7. In the rider's closed journey, find **Say thank you** Choose a category and select **Send free banner**. Options are **Thank you for being there**, **Thank you for listening**, and **Thank you for taking over**. Sending is optional.
8. After the gratitude record is chain confirmed, the guardian's **Confirmed banners** becomes **1**, while confirmed points remain **25**. Open **My profile**: **First watch** and **A grateful connection** are now recognized in the **Honor cabinet**. **A steady presence** remains at **1 / 5 contributions**. The received pennant appears on the **Appreciation wall**, with its category, date, sender's public community reference, and **View receipt** link. Use that link to open its Devnet account evidence. Profile data refreshes periodically; saved gratitude and finalized on-chain gratitude are separate states.

The wall initially previews up to three received banners. Choose **View all banners** to see the full pennants and category buttons. **Load earlier records** loads another page of public history; older banners can be beyond the first page. Cabinet progress and the confirmed-banner total cover the whole account, whereas the displayed card count covers loaded matching banners. Open **Dedication details** on a full pennant to show the public sender, recipient, and journey references. A rider's sent banners remain in history but do not appear as received honors on the rider's wall.

The ended journey prioritizes the outcome and optional free thank-you. Conversation history and contribution receipts start folded. After all eligible guardians have a recorded banner, a sent summary replaces the composer; **View details** reopens it. This is application delivery, not a claim of chain confirmation. Wallet and account tools are in the header avatar menu under **Wallet & settings**.

Every full community profile includes this collection, including profiles opened through **View profile**. Compact candidate previews retain their existing counters. With no received banners, the wall shows an honest empty state; there are no seeded awards. A confirmed withdrawal removes recognition from the wall and cabinet totals while retaining original receipts in the community record. Appreciation after a cancelled journey may unlock **A grateful connection** without unlocking **First watch**.

For accounts with earlier activity, demonstrate the corresponding changes (+25 points, +1 contribution, +1 banner) rather than claiming their total must equal those values. Do not manually edit a balance or label hardcoded counters as finalized receipts.

If the counters stay zero, first check that you are viewing the guardian account, that the journey is ordinary rather than the built-in sample, that an approved guardian actually checked in, and that the rider confirmed arrival rather than cancelled. Then inspect publication status; pending/retry records are not included in confirmed totals. Previously created legacy journeys are not automatically backfilled. An unresolved publication problem should be investigated through the existing operator tools, not disguised with seeded numbers.

## Optional three-account relay demonstration

Use separate browser profiles or private windows for a rider, guardian A, and guardian B. Duplicating a tab can copy its guest session. Use fictional route and contact details; live GPS permission is optional.

The guest sessions demonstrate role authorization, not verified real-world identities. The hosted backend runs its own alarms. When rehearsing locally instead, keep the local Worker running; its alarms stop with that process.

## Suggested four-minute walkthrough

**Create a private request.** As the rider, create a journey and copy its invitation. Open it as guardian A. Point out that A can see the public request but not the route, precise position, Uber link, contact, or conversation.

**Apply, then approve.** A opens the invitation, acknowledges the role, and chooses **Apply to guard**. From the community list, first select **Review request**. Show the rider's pending candidate and the application deadline. Choose **Approve** in the rider's candidate review (use **Decline** for rejection). A now receives the private trip view and selects **I am here · Check in**. If already marked unavailable, the button is **Resume & check in**. Explain that applying alone never grants access.

**Request a relay.** Select **Request a human relay** from the rider or A, then **Copy relay invite**. The request has a ten-minute window; A stays assigned until a replacement is approved. Open the relay invitation as B, acknowledge the role, and choose **Apply to take over**. B still sees a redacted request.

**Complete the handoff.** Approve B as the rider, then record B's check-in. Refresh A's earlier trip view or attempt an action: A no longer has permission to receive private trip updates or act as the guardian. A's public participation evidence remains accessible in **My profile**; this journey's completion contribution is allocated after arrival. Show the handoff in the activity history.

**Arrive and share the contribution.** The rider confirms arrival. Two distinct eligible guardians share one community pool of 25 points and 10 reputation. The guardian whose public community reference sorts first receives 13 points; the other receives 12. Both receive 5 reputation. No additional pool is created by the relay, and another arrival request cannot settle again. Wait for chain confirmation before presenting the allocations as confirmed. The rider may send one free banner to each eligible guardian, including A after handoff; each banner adds no points.

## Explain missed check-ins accurately

As an alternative to the manual relay request, let the current guardian's server check-in deadline expire. Show the overdue state, relay request, and deterministic reminders.

Say: "The guardian missed a check-in, so the app is seeking a rider-approved replacement. Reminders continue while we wait."

The existing assignment does not guarantee availability. An open relay, a rules-based message, and an approved replacement are different states. The system does not detect sleep or promise that a human is continuously watching.

## Useful follow-up scenarios

These are rehearsal steps, not assertions that browser interaction tests have passed.

| Scenario | Expected behavior |
| --- | --- |
| Candidate withdraws or rider rejects | That application cannot later be approved to grant access |
| Application expires | It cannot be approved after its deadline; it lasts at most five minutes and never outlives its request |
| Too many pending candidates | More than five pending applications are not accepted |
| Relay expires or is cancelled | Its applications are cleared; the current assignment and monitoring mode remain |
| Guardian selects Resume & check in while a relay is open | Check-in availability resumes, but the relay is not automatically cancelled |
| Former guardian applies again | Another rider approval is required; contribution stays one cumulative entry per person |
| Approve two competing applications | Only a valid current application can become the guardian; a stale request cannot replace them |
| Journey is cancelled | Pending applications/relay end; no completion contribution is issued, but eligible checked-in guardians can still receive a free banner |
| Journey is completed twice | No duplicate reward allocations |
| Guest session attempts a private read | Access is denied or a permitted redacted request is returned |

Revocation cannot erase route details or messages that A already saw. Demonstrate that future access is blocked without claiming deletion from somebody else's browser or screenshots.

## Sample journey versus the human workflow

The old single-person sample journey with simulated guardian Alex remains supported by the backend, but its launcher and scenario controls are no longer part of the simplified interface. Existing sample journeys stay labeled; demo completion awards no real points. Use ordinary two-account journeys for the current demonstration.

Use separate actual guest sessions for approval, relay, privacy, and shared-reward evidence. A simulated handoff is not evidence of two independent participants.

## Blockchain evidence and the separate wallet-signed path

The community program is deployed at `7vuz78V9Tu53Bpt3iXHc37VSDBmRSYxcEguWewR9LXzm` on Devnet. See the [deployment receipt](deployment/deployment.community.devnet.json) and [hosted workflow](deployment/community.ledger.hosted.devnet.json). Each ordinary new journey publishes minimal platform attestations through dedicated issuer and sponsor identities. Participants need no wallet or SOL for this path. Public evidence excludes private routes, coordinates, and conversation.

The retained V2 wallet-signed commitment is an additional flow with separate receipts. Its protocol allocation is not added to community-ledger recognition. It is unnecessary for the minimal contribution/banner demonstration above. Browser wallet-extension acceptance is a separate manual check. Earlier V1-only descriptions and application-only allocation rules do not describe this current community workflow.

## Questions to be ready for

**Who chooses the guardian?** The rider approves an unexpired application. Guest identity verification is outside this prototype.

**What happens while nobody has replaced an overdue guardian?** The old assignment remains visible, a relay is open, and rules-based reminders continue. No human coverage guarantee is made.

**Can relays mint more points?** No. Distinct eligible guardians divide one fixed pool. Returning participants have one cumulative share.

**What counts as participation?** An approved guardian explicitly checking in or resuming. Approval alone does not qualify, and the reward does not measure attention quality or duration.

**Does sharing an Uber link give live tracking?** No. It is an optional link; coordinates come from sample data or the rider's explicit browser location sharing.

**Can this replace emergency services?** No. The current work coordinates people and records actions; no emergency dispatch is implemented.

See [COMMUNITY_LEDGER.md](COMMUNITY_LEDGER.md) for current community rules and [SPONSORS.md](SPONSORS.md) for award research. AI/provider demonstrations are deferred from this walkthrough.


## Simplified completion feedback

The assigned guardian now sees **I am here ? Check in** in the main journey card, with a first-check-in prompt and countdown. Rider status check-ins do not count as guardian participation. If no guardian has checked in, the rider sees that arriving will earn no contribution points; arrival remains available. An arrived journey with no recorded guardian participation explicitly explains that no contribution was earned. A confirmed arrival receipt alone is not a contribution receipt.

The route/map, activity, participation details, and privacy controls are expandable. Chat, guardian applications, relay actions, arrival, and help stay directly accessible. In **My profile**, contribution totals, the honor cabinet, and appreciation wall remain visible; raw records and profile editing are expandable.
