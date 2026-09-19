# Human guarding and relay

Safety Guard coordinates a rider and community guardians through applications, rider approval, explicit check-ins, and a controlled relay. The current work focuses on that human workflow. AI, voice, provider APIs, external notification setup, and hosting authentication are deferred; the core can be exercised locally without service credentials.

This is a coordination prototype. A display name is a guest identity, approval is the rider's selection of that identity, and a check-in is a recorded action. None independently verifies who the person is, whether they are continuously attentive, or whether a journey is safe.

## 1. Request a guardian without exposing the trip

The rider creates a journey and shares its invitation link. A volunteer opens the invitation, acknowledges the guarding role, and selects **Apply to guard**. From the community view, first select **Review request**. Other authenticated guests can see a redacted request, but cannot see its route, exact position, contact, Uber link, or conversation merely by applying.

A volunteer submits an application. The rider can choose **Approve** or **Decline** in the review dialog; the applicant can withdraw it. Approval is required before the first guardian receives private trip access.

- An initial open request lasts at most 24 hours.
- At most five pending applications may exist for the trip.
- An application lasts at most five minutes and never outlives the request it targets.
- The backend validates the request identifier so an application for an old request cannot become an application for its replacement.

Application expiry or rejection does not automatically select another person. The rider makes the approval decision.

## 2. Keep the current assignment separate from availability

An approved guardian receives the private trip view and a check-in deadline. A guardian check-in confirms that they are responding now; the absence of a missed deadline is not a guarantee of continuous attention.

If the guardian misses a deadline or selects **I am unavailable**, the backend opens a relay request and continues deterministic reminders. The current guardian remains assigned until the rider approves a replacement. An assigned guardian may therefore be overdue: the UI must distinguish an assigned person from currently confirmed human availability.

The legacy API value `guardMode: "ai"` means automated companion mode. Without a configured provider, that mode uses deterministic rules. It does not mean that another human is watching or that an AI can guarantee protection.

## 3. Relay to another approved guardian

The rider or current guardian can select **Request a human relay** during an active journey, then use **Copy relay invite** to share it. The relay window lasts ten minutes. Volunteers open that relay invitation and choose **Apply to take over**, then the rider selects a replacement.

The current guardian stays assigned while the request is open. A volunteer applying does not remove the current guardian, receive private access, or complete a handoff.

Approval changes the assignment atomically:

1. Confirm the application is still pending and belongs to the current, unexpired request.
2. Assign the selected volunteer as the current guardian.
3. Close the relay and clear its remaining applications.
4. Revoke the previous guardian's future private reads and participant actions.
5. Start the replacement guardian's check-in window.

Former guardians retain their earned app balance in **My impact**, but lose private journey access. Revocation cannot erase information already seen, downloaded, or captured by the former guardian. Treat the trip invitation as a way to find a request, not a trusted-identity credential.

A former guardian may apply again after replacement. They need another rider approval and retain one cumulative contribution record for the trip.

If a relay expires, its applications are cleared while the current assignment and monitoring mode remain. Resuming check-ins does not automatically cancel an open relay. Cancelling a relay is separate from cancelling the journey; neither action certifies that a human is available.

## 4. One reward pool for the whole journey

An eligible, rider-confirmed, non-demo journey has one fixed application reward pool: **25 points and 10 reputation**. Relays do not create additional pools.

Eligibility requires a distinct approved guardian to explicitly check in or resume at least once. Application, approval, and passive assignment alone do not qualify. Repeated check-ins or returning for another guarding period do not create extra participant shares.

Eligible guardian IDs are sorted lexically. For each of the two integer pools:

- Every eligible guardian receives `floor(pool / eligibleGuardianCount)`.
- The first `pool % eligibleGuardianCount` IDs receive one additional unit.
- Each guardian's allocation is recorded once for that trip.

The ordering is by opaque guardian ID, not display name, approval time, duration, or number of check-ins.

| Eligible distinct guardians | Points, in guardian-ID order | Reputation, in the same order |
| --- | --- | --- |
| 1 | 25 | 10 |
| 2 | 13, 12 | 5, 5 |
| 3 | 9, 8, 8 | 4, 3, 3 |
| 4 | 7, 6, 6, 6 | 3, 3, 2, 2 |

There is no additional cap on cumulative distinct guardians in this version. If there are more participants than units in a pool, some allocations are zero. The five-application cap applies to pending applicants, not to all guardians over the lifetime of a journey.

Only the rider can confirm arrival. No eligible guardian means no reward allocation. Demo journeys and cancelled journeys issue no real application credits. Duplicate completion or settlement retries must not issue another allocation. The split recognizes participation; it does not measure the duration or quality of guarding and does not prevent collusion between guest identities.

## 5. Privacy and identity limits

| Person | Private trip access |
| --- | --- |
| Rider | Own trip and approval controls |
| Current approved guardian | Assigned trip while authorized |
| Pending applicant | Redacted request and their own application only |
| Other authenticated guest | Redacted public request, when available |
| Replaced guardian | No future private read or participant action; may see or apply to a new public request |
| Unauthenticated visitor | No authenticated trip access |

Sessions are opaque bearer credentials stored in browser session storage. Duplicating a tab can copy its session; use separate browser profiles or private windows to test different people. Session loss currently has no production account-recovery flow. App identities are not verified people and are not bound to wallets.

Location sharing is initiated by the rider. An Uber sharing URL is an optional link, not a live Uber telemetry integration. Local backend alarms work only while the Worker process is running; leaving a browser open is different from running a remotely hosted service.

### Existing local journeys

The backend upgrades older stored trips when they are read. Existing guardian assignments and previously earned rewards are preserved; the update does not invent retrospective rider approvals or pay an already-credited reward again. New recruitment uses the approval flow. Compatibility reconstruction of old contribution eligibility is described in the [API reference](../worker/API.md#existing-local-data).

## 6. The blockchain workflow remains separate

The deployed Solana program has a single designated guardian per commitment and awards **10 chain points** after that guardian's signed check-in and the rider's signed completion. It does not follow application approvals, relay replacements, or the shared application reward pool.

This human-relay update does not redeploy the chain program. A current application guardian is not automatically the wallet named in an earlier chain commitment. Wallet participants still share the public receipt reference manually and approve transactions themselves. There is no escrow, payment, transferable token, or automatic reconciliation of the two point systems.

## Read next

- [Local setup and project status](../README.md)
- [Human relay demonstration](DEMO.md)
- [Exact HTTP actions and schemas](../worker/API.md)
- [Architecture and trust boundaries](ARCHITECTURE.md)
- [Verified checks and remaining limits](VALIDATION.md)

