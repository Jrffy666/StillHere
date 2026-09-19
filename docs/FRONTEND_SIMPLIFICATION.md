# Core journey interface

Updated September 20, 2026. The simplified interface uses the existing application API and community ledger. No contract, points rule, identity service, or AI provider changed.

## Three destinations

- **My journeys:** create a journey, choose an existing journey, review a guardian, check in, exchange messages, request a relay, and confirm arrival.
- **Guard network:** review open guardian and relay requests. Public profiles remain available before approval; private route and conversation access still requires rider approval.
- **My profile:** introduction, confirmed contribution counters, honor cabinet, received appreciation wall, and expandable contribution history with chain receipts.

The persistent sidebar, standalone About page, promotional panels, repeated onboarding steps, integration inventory, simulated-journey launcher, scenario controls, agent trace dashboard, and voice playback controls were removed from the main interface. Existing sample journeys still have an explicit simulation label and do not earn recognition. The offline agent backend remains unchanged; automated messages are labeled as reminders.

## Journey priorities

The assigned guardian's explicit **I am here · Check in** action is in the main journey card. When unavailable, it remains **Resume & check in** and sends the existing `resume` action. Both roles can see the countdown. A first-check-in prompt explains that approval alone is insufficient for contribution.

The rider retains arrival, status check-in, help, and cancellation. Missing guardian participation produces a warning before arrival, without blocking closure. An arrived journey with zero recorded guardian check-ins explains that no contribution was earned. The UI never treats an arrival receipt or application reward status as finalized community contribution evidence.

Prior guardians' participation is retained during a relay. A new guardian's missing first check-in does not erase earlier checked-in guardians. The profile and chain receipts remain the authoritative place to distinguish pending and confirmed publication.

The desktop journey workspace puts current actions and guardian requests beside the conversation. On narrower screens they stack in that order. A normal active assignment with an on-time check-in uses a compact relay row; the full relay panel remains visible for a missing/overdue check-in, attention or urgent status, unavailable guardian, live relay request, or applicant. Rider approval and the public-profile review remain required.

Ended journeys prioritize the outcome and free appreciation. Conversation history and contribution receipts start collapsed. Participation details share the **Contribution & chain receipts** entry, with application check-ins and chain confirmation explicitly distinguished. Route/map, application activity, alert delivery status, and privacy/reporting remain individually expandable in a compact details grid. The map mounts when opened. New messages and history expansion scroll only the message container. The journey selector includes earlier journeys.

## Creation and recognition

New journey creation emphasizes origin, destination, and optional Uber link. **More options** contains check-in timing, a trusted contact and its existing delivery consent, and the optional wallet-signed commitment. The mandatory public-record notice remains visible and enforced. Form errors stay outside collapsed options.

The closed rider view offers **Say thank you** using the existing free-banner mechanism. The personal profile retains public contribution counters, a compact honor cabinet, and the appreciation wall. Raw evidence is under **Contribution history & receipts**. The **Edit** button beside the member name opens an introduction dialog with Save and Cancel; editing no longer occupies a separate profile section. Honor entries keep their icon, name, requirement, status, and progress in a compact grid that stacks on phones. Compact approval previews show public counters and an explicit link to the full profile. Initial record-loading errors remain visible outside the collapsed ledger.

The appreciation wall previews up to three received, confirmed banners with direct receipts. **View all banners** reveals the full artwork, category filters and earlier-record pagination. Empty walls use a short message without filters. A nonzero aggregate count with no banners on the current mixed-record page still provides access to older records. Preview mode ignores any full-wall category filter.

Once every eligible guardian's banner is recorded by the application, the thank-you composer collapses to a sent summary with **View details**. This does not claim chain confirmation; the summary points to contribution receipts. Pending recording, retry and errors remain accessible. Technical event numbers and identifiers live under **Record details**; event names, time, confirmation status and receipt links remain in the list.

The header retains three destinations and one avatar menu with **Wallet & settings** and **Sign out**. Sign-out uses the existing guest-access-loss confirmation. The account dialog returns focus to that header control; appreciation transitions preserve focus when the active control is removed.

## Compatibility and access

The obsolete primary **View contribution** button opened the legacy V1 manual wallet path and has been removed. Ordinary community evidence now uses **Contribution & chain receipts**. Existing V2 signed journeys retain their required signing controls; former guardians retain access through **My profile → Wallet-signed journeys**.

Account/wallet access, recovery, the guest sign-out warning, reporting, and private-journey deletion remain available. The existing owner and authorized demo viewer retain website access. The change neither grants public access nor modifies stored journeys or contribution records.

## Validation

- Seven journey-progress regression tests cover the diagnosed zero-check-in arrival, first-check-in prompts, relay history, demo/cancelled states, and simulated-participation exclusion.
- Six additional layout-state tests cover attention and expiry, first/overdue check-ins, and empty/partial/pending/complete gratitude delivery.
- Fourteen honor-projection tests pass; the unchanged proxy was covered by its earlier eight-test run.
- Frontend type checking, lint, and production build pass.
- Published asset validation checks the exact shipped JavaScript/CSS, retained pennant artwork, core actions, account menu, ended-journey history, compact relay and appreciation controls, and receipt access.

No browser was available for visual or interactive acceptance. Source, build, logic, and served-asset checks do not substitute for that acceptance. No new blockchain transactions or synthetic contribution records were created for this UI release.
