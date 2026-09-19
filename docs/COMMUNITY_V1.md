# Community v1

This document describes the historical app-only community baseline. The successor [community ledger](COMMUNITY_LEDGER.md) adds required Solana records, separate confirmed/pending/legacy profile totals, sponsored publication and append-only corrections. Its release evidence is tracked separately.

Community v1 covers the accepted first step toward a volunteer companionship community: member profiles, redacted contribution records, and free structured appreciation banners. The frontend and backend are deployed to the existing owner-only demo, with release evidence in [community.v1.validation.json](deployment/community.v1.validation.json). See [community direction](COMMUNITY_DIRECTION.md) and [gratitude rules](GRATITUDE_MECHANISM.md) for product decisions.

## Scope

Profiles and contribution values are visible to every other authenticated community member. There is no visibility toggle, and visibility does not depend on approving a guardian or completing a journey together. A short biography is optional content; the member's contribution values remain visible even when the biography is blank.

Prospective guardians can review the rider's profile before applying. Riders can review candidate profiles before approval. This helps both participants understand whom they are choosing while the existing rider-approved process still controls private trip access.

The release includes free predefined appreciation banners after an arrived or cancelled journey. Only the rider can thank an actual checked-in guardian, once per journey and guardian. Application check-ins and reconciled signed-chain contribution check-ins can establish gratitude eligibility; a relay journey can recognize more than one eligible guardian. Thanks does not increase points or reputation, change reward eligibility, or require a wallet.

There is no language matching, translation integration, sitewide leaderboard, payment, transferable token, new blockchain program, or live OpenAI call. Availability management, a one-active-journey capacity rule, member blocking, and broader reporting after replacement remain future work.

## Data boundaries

| Information | Audience |
| --- | --- |
| Display name, short biography, contribution values, redacted earned-credit history, received appreciation counts | Other authenticated community members, including before a guarding relationship exists |
| Profile editing | The profile owner |
| Appreciation creation | The closed journey's rider, for an eligible guardian |
| Route, location, chat, contact details, notification content, private agent trace | Existing private-journey authorization only |
| Credentials, wallet secrets, operator configuration | Existing server/user-owned secret boundaries; never a profile field |

Profile projections omit the dedicated private journey fields and other participants' identities. Internal references used for deduplication are not invitations to expose the rider or link visitors to a private trip. A biography is member-authored visible text and could itself contain information the member types; excluding private system fields does not guarantee that all freeform content is anonymous. The community profile is not an unrestricted account export.

The authenticated API boundary is distinct from the hosted website's audience. The current site is owner-only. This release does not authorize opening it to all internet users or claim a public community rollout.

## API contract

All routes below require the existing application authentication. Invalid identifiers or bodies are rejected; successful responses use the named envelope shown in the table.

| Method and route | Request | Response and access |
| --- | --- | --- |
| `GET /api/members/:memberId` | None | `{member}` for any authenticated community member; a deleted or missing target returns 404 |
| `POST /api/me/profile` | `{bio: string}`; trimmed, at most 280 characters | `{member}` for the current account; no request field selects another account or controls visibility |
| `GET /api/trips/:tripId/gratitude` | None | `{gratitude}`; only the rider of a closed, non-demo journey |
| `POST /api/trips/:tripId/gratitude` | `{guardianId, kind}` | `{gratitude}` under the same rider authorization and recipient eligibility checks |

The member projection contains exactly `id`, `name`, `bio`, `points`, `reputation`, `completedGuards`, `contributions`, and `gratitude`. `contributions` is the latest 20 earned-credit ledger entries, each containing only `points` and `reputation`. It does not expose journey IDs, timestamps, other participants, routes, wallet addresses, or private receipts. `completedGuards` follows the existing credited-journey counter; it is not a count of all attempts, handoffs, or cancellations.

The member's `gratitude` contains category counts: `total`, `companionship`, `thoughtfulness`, and `relay`. The three labels are **Thank you for being there**, **Thank you for listening**, and **Thank you for taking over**. Categories express the rider's appreciation; they do not add independently verified evidence about the quality of listening or a handoff. The community view does not publish individual sender identities, internal receipt IDs, send times, or journey links.

The rider-only gratitude response contains `eligibleGuardians: [{id, name}]` and `banners: [{guardianId, kind, createdAt, status}]`. Status is `pending` or `recorded`. Repeating the same guardian/category request returns the existing result; trying to choose a different category after the original banner is selected returns 409. There is no edit, withdrawal, or arbitrary message endpoint in this v1 contract.

The authenticated journey summary includes a limited `riderProfile: {id, name}` reference, or `null` where unavailable. It enables a prospective guardian to open the community profile without reading the private journey. Candidate profile reads similarly use the existing candidate identity; they do not require approval first. The application and chain-acceptance screens show the rider profile, while candidate approval embeds the candidate profile. These UI controls wait for a successful profile load before continuing, so an unavailable profile is not silently skipped.

Implementation references: [routing](../worker/src/index.ts), [community projections and account storage](../worker/src/accounts.ts), [journey eligibility and delivery](../worker/src/trips.ts), and [shared types](../worker/src/types.ts).

## Durable gratitude and lifecycle

The journey stores a unique pending receipt before delivering it to the recipient account. The account inserts that receipt idempotently, and the journey records acknowledgement. An alarm retries pending work after an interruption. This application receipt flow changes appreciation counts only; it does not send an external notification, create a financial transfer, or credit points.

Account export and backup include the biography and an anonymous gratitude receipt ledger. The authenticated account export also includes the rider's `sentGratitude` for retained private journeys, containing the journey ID and its recipient/category/status records. This private export is distinct from the community projection; received-account receipt records omit source journey and sender IDs. Older account and journey snapshots remain accepted. Restoring a journey cancels pending appreciation delivery instead of resending old work. Restoring account records preserves already recorded anonymous receipt counts under the existing deletion protections.

Deleting the recipient removes their profile and received gratitude data. Erasing the private journey, or deleting its rider, removes the journey linkage while the recipient's anonymous category counts can remain. Those counts do not identify the rider or journey in the community projection. This is a deliberate separation between private journey retention and accumulated appreciation; do not promise that erasing a journey subtracts every recipient counter.

## Interpretation of contribution data

Points and reputation are application counters, not money or a universal trust score. Existing completed-journey reward rules retain their 25-point / 10-reputation pool and their separate application-only or signed Devnet eligibility. A profile must preserve the difference between recorded activity, a completed journey, a handoff, a claimed reward, and an appreciation banner.

No claim of verified safe arrival, continuous attention, moral character, or professional competence follows from these records. Empty histories are valid for new members. Do not fabricate contribution examples as real account activity, and do not rank all members by their balances.

Appreciation on a cancelled journey records voluntary thanks for an eligible contribution. It does not award the completed-journey pool or reinterpret the journey as arrived. A missing banner has no negative meaning.

## Local walkthrough

Use an ordinary application-only journey with synthetic accounts in separate browser sessions. Demo journeys intentionally do not issue appreciation banners. No wallet, token, OpenAI key, or translation configuration is needed.

1. Open **My community profile**, edit the short biography, and save it. The profile states that community members can see it; no visibility toggle is offered.
2. Create a rider request. From the prospective guardian session, review the rider's profile in the application flow before applying. The full **View profile** dialog shows contribution values and earned-credit history.
3. From the rider session, review the applicant's profile before approving them. Confirm that the profile read did not itself grant private journey access.
4. Have the guardian perform an availability check-in. Optionally arrange an ordinary rider-approved relay and have the replacement check in too.
5. Close the journey as arrived or cancelled. The rider sees **A little thank-you, freely given.** and can choose a category and **Send free banner** for each eligible guardian, or select **Done for now**.
6. Inspect the recipient's profile. Its category count increases while its contribution points and reputation remain unchanged by the banner. A recorded banner cannot be chosen a second time for that guardian and journey.

If recording is interrupted, the rider sees a pending state and can **Retry recording**. Repeated requests use the same durable receipt. A banner marked pending is not yet proof that the recipient's count has updated.

This walkthrough describes the implemented screens and expected behavior; it is not a claim of completed interactive browser validation. Record that evidence separately when a browser is available.

## Validation and release evidence

The focused suite is [worker/test/community.test.ts](../worker/test/community.test.ts). It tests authenticated profile visibility before application and approval, owner-only editing, private-field exclusion, genuine contribution projection, gratitude authorization and eligibility, duplicate suppression, unchanged balances, and data lifecycle behavior. Run from the project root:

```sh
npm --prefix worker test -- test/community.test.ts
npm --prefix worker run typecheck
```

The focused community suite passed **23 tests**. It includes retry after a failed account write and Durable Object eviction, recovery when a recorded receipt's acknowledgement is lost, and restoration without replaying pending appreciation. These tests use synthetic accounts and controlled failures; they do not claim that real community members were contacted.

Local validation passed:

| Check | Result |
| --- | --- |
| Full Worker suite | 137 passed across 10 files, including the 23 community tests |
| Backend and frontend type checks | Passed |
| Frontend lint and production build | Passed |
| Frontend proxy tests | 8 passed |
| Operations tests | 16 passed |

The owner-only frontend version 5 and production Worker passed all five expanded hosted HTTP workflows, covering mandatory profile visibility, privacy, biography editing, pre-approval discovery, gratitude after arrival/cancellation/relay, duplicate suppression, unchanged balances, and demo isolation. The run deleted all 11 synthetic accounts. Thirteen [published asset checks](deployment/frontend.community.validation.json) confirmed the deployed bundle matches the validated build and contains the profile/gratitude interface.

The browser connection was unavailable, so screenshot review and interactive browser acceptance are not claimed. This release made no Solana program change and submitted no blockchain transactions. Earlier signed Devnet evidence in [VALIDATION.md](VALIDATION.md) remains historical; the new community checks validate application behavior separately.
