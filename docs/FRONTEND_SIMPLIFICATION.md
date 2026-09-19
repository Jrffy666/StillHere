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

Conversation and approval/relay controls remain directly accessible. Route/map, application activity, participation detail, alert delivery status, and privacy/reporting controls are expandable. The map mounts when opened. New messages scroll only the message container, so they do not move the page away from its primary actions. The journey selector includes earlier journeys instead of showing a row of competing journey buttons.

## Creation and recognition

New journey creation emphasizes origin, destination, and optional Uber link. **More options** contains check-in timing, a trusted contact and its existing delivery consent, and the optional wallet-signed commitment. The mandatory public-record notice remains visible and enforced. Form errors stay outside collapsed options.

The closed rider view offers **Say thank you** using the existing free-banner mechanism. The personal profile retains public contribution counters, a compact honor cabinet, and the appreciation wall. Raw evidence is under **Contribution history & receipts**. The **Edit** button beside the member name opens an introduction dialog with Save and Cancel; editing no longer occupies a separate profile section. Honor entries keep their icon, name, requirement, status, and progress in a compact grid that stacks on phones. Compact approval previews show public counters and an explicit link to the full profile. Initial record-loading errors remain visible outside the collapsed ledger.

## Compatibility and access

The obsolete primary **View contribution** button opened the legacy V1 manual wallet path and has been removed. Ordinary community evidence now uses **Contribution & chain receipts**. Existing V2 signed journeys retain their required signing controls; former guardians retain access through **My profile → Wallet-signed journeys**.

Account/wallet access, recovery, the guest sign-out warning, reporting, and private-journey deletion remain available. The existing owner and authorized demo viewer retain website access. The change neither grants public access nor modifies stored journeys or contribution records.

## Validation

- Seven journey-progress regression tests cover the diagnosed zero-check-in arrival, first-check-in prompts, relay history, demo/cancelled states, and simulated-participation exclusion.
- Fourteen honor-projection tests and eight proxy tests continue to pass.
- Frontend type checking, lint, and production build pass.
- Published asset validation checks the exact shipped JavaScript/CSS, retained pennant artwork, primary actions, simplified navigation, receipt paths, and removal of the old promotion/simulation entry points.

No browser was available for visual or interactive acceptance. Source, build, logic, and served-asset checks do not substitute for that acceptance. No new blockchain transactions or synthetic contribution records were created for this UI release.
