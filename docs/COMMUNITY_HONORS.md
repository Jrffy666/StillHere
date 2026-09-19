# Appreciation wall and honor cabinet

Implemented September 20, 2026. This release extends the existing personal community profile. It does not change the community program, contribution allocation, publication service, or AI behavior.

## Experience

The **Honor cabinet** displays three personal milestones: **First watch** (one confirmed contribution), **A grateful connection** (one confirmed received banner), and **A steady presence** (five confirmed contributions). Each shows its criterion, progress, and current recognition state. These are derived presentation milestones rather than separately published awards, tokens, or assessments of character. The existing 25-point / 10-reputation completion pool is unchanged.

The **Appreciation wall** displays received banners using original pennant artwork and accessible HTML inscriptions. Categories are companionship, thoughtfulness, and human relay. Each card includes the actual event date in UTC, the sender's pseudonymous community reference, the recipient and journey references in expandable details, and a finalized Devnet receipt link when available. No invented sender names, personalized messages, travel routes, or contact details appear.

Full personal profiles and member-profile dialogs show both collections. Compact candidate profiles preserve the short counters and community-record summary. There is no global leaderboard, purchase flow, manual award grant, or prepopulated recognition.

## Data rules

- Use the shared `useCommunityRecords` infinite query and its existing 15-second refresh. No extra API or contract is required.
- Use `ledger.finalized` for lifetime counters and cabinet milestones. Never reconstruct totals from a partially loaded list.
- A wall card requires `event.kind === 'gratitude'`, `event.subjectId === ledger.memberId`, `status === 'finalized'`, and `withdrawn === false`. The comparison uses the public community reference, not an application account UUID.
- Member history includes sent gratitude and other journey events. Those remain inspectable in the ledger but do not become received banners.
- Deduplicate loaded pages by record ID, preferring the first/newest page's representation, and sort cards by event time descending with a deterministic ID tie-breaker. Ignore pages for another community identity.
- Category controls filter loaded records. The footer states whether earlier records remain available and exposes pagination. The confirmed-banner total is account-wide; the displayed count is only loaded matching cards.
- A pending gratitude record is acknowledged separately. It does not unlock milestones or enter the confirmed wall. Retry and submitted records follow the same rule.
- A confirmed withdrawal removes a record from current recognition. A correction that has not finalized does not yet withdraw recognition. Original receipts remain in the record history.
- A valid appreciation banner can follow a cancelled journey with no contribution points. Appreciation is independent of completed-journey contribution eligibility.
- Unknown future category values display a neutral appreciation title rather than disappearing or being mislabeled.
- Legacy application records do not unlock confirmed honors. New accounts have locked milestones and an explanatory empty wall.

Receipt URLs use the existing allowlisted Solana Explorer helper. Only finalized Devnet records with a valid-looking account address receive external links; localnet records remain explicitly labeled localnet.

## Access and demonstration

The existing Sites audience is preserved, with one owner-requested external viewer added for the two-account demo. The viewer can access the deployed application but cannot administer or edit the site. The Sites login and the application's guest identity are separate. Follow [DEMO.md](DEMO.md) to create a normal rider/guardian journey and retain its guest sessions.

This release does not invent a prefilled demo account or grant an account points. Controlled demonstration trips create actual Devnet attestations and should be introduced as demonstrations, not real passenger activity.

## Validation

`npm run test:honors` runs focused projection tests against the actual TypeScript helpers, including received-versus-sent eligibility, status and withdrawal handling, pagination, authoritative aggregate milestones, and safe receipt links. Frontend type checking, lint, and production build are also required. Validation does not imply manual browser interaction or wallet-extension acceptance; record those separately when performed.

The generated artwork source and prompt are kept under `design-assets/`. Only the final raster asset under `web/public/images/` is used by the website. Inscriptions, counts, and status labels are rendered as text rather than embedded in the image.
