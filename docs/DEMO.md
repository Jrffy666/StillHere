# Human guarding and relay demonstration

This walkthrough exercises the local human workflow without model credentials, voice, external notifications, or new chain transactions. Use the [README](../README.md) to start the app and [VALIDATION.md](VALIDATION.md) for checks already completed.

## Prepare three independent sessions

Use separate browser profiles or private windows for a rider, guardian A, and guardian B. Duplicating a tab can copy its guest session. Use fictional route and contact details; live GPS permission is optional.

The guest sessions demonstrate role authorization, not verified real-world identities. Keep the local Worker running throughout the walkthrough. Its server alarms do not continue after the developer machine or Worker stops.

## Suggested four-minute walkthrough

**Create a private request.** As the rider, create a journey and copy its invitation. Open it as guardian A. Point out that A can see the public request but not the route, precise position, Uber link, contact, or conversation.

**Apply, then approve.** A opens the invitation, acknowledges the role, and chooses **Apply to guard**. From the community list, first select **Review request**. Show the rider's pending candidate and the application deadline. Choose **Approve** in the rider's candidate review (use **Decline** for rejection). A now receives the private trip view and selects **I am here · Check in**. If already marked unavailable, the button is **Resume & check in**. Explain that applying alone never grants access.

**Request a relay.** Select **Request a human relay** from the rider or A, then **Copy relay invite**. The request has a ten-minute window; A stays assigned until a replacement is approved. Open the relay invitation as B, acknowledge the role, and choose **Apply to take over**. B still sees a redacted request.

**Complete the handoff.** Approve B as the rider, then record B's check-in. Refresh A's earlier trip view or attempt an action: A no longer has permission to receive private trip updates or act as the guardian. A's earned balance is still available in **My impact**. Show the handoff in the activity history.

**Arrive and share the contribution.** The rider confirms arrival. Two eligible guardians share one pool of 25 app points and 10 reputation. The guardian whose ID sorts first receives 13 points; the other receives 12. Both receive 5 reputation. No additional pool is created by the relay, and another arrival request cannot settle again.

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
| Journey is cancelled | Pending applications/relay end and no real app rewards are issued |
| Journey is completed twice | No duplicate reward allocations |
| Guest session attempts a private read | Access is denied or a permitted redacted request is returned |

Revocation cannot erase route details or messages that A already saw. Demonstrate that future access is blocked without claiming deletion from somebody else's browser or screenshots.

## Sample journey versus the human workflow

The single-person sample journey with simulated guardian Alex is useful for trying map events and reminders. Demo events stay labeled, demo alerts do not contact real recipients, and demo completion awards no real points.

Use separate actual guest sessions for approval, relay, privacy, and shared-reward evidence. A simulated handoff is not evidence of two independent participants.

## Optional blockchain evidence

The Solana program is already deployed and its CLI lifecycle has been verified on Devnet; see the [public report](deployment/verification.devnet.json). Showing that report or its transaction links does not require a new deployment.

The chain remains a **single designated guardian** commitment with a 10-point reward. It does not follow app relays or the app's 25-point/10-reputation split. Guest identities are not bound to wallets. Browser-wallet signing remains a separate manual verification step; do not present this human-relay demo as proof that wallet transactions were exercised.

## Questions to be ready for

**Who chooses the guardian?** The rider approves an unexpired application. Guest identity verification is outside this prototype.

**What happens while nobody has replaced an overdue guardian?** The old assignment remains visible, a relay is open, and rules-based reminders continue. No human coverage guarantee is made.

**Can relays mint more points?** No. Distinct eligible guardians divide one fixed pool. Returning participants have one cumulative share.

**What counts as participation?** An approved guardian explicitly checking in or resuming. Approval alone does not qualify, and the reward does not measure attention quality or duration.

**Does sharing an Uber link give live tracking?** No. It is an optional link; coordinates come from sample data or the rider's explicit browser location sharing.

**Can this replace emergency services?** No. The current work coordinates people and records actions; no emergency dispatch is implemented.

See [HUMAN_GUARDING.md](HUMAN_GUARDING.md) for the full rules and [SPONSORS.md](SPONSORS.md) for the earlier award research. AI/provider demonstrations are deferred from this walkthrough.

