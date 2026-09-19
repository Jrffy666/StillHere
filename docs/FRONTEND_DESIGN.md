# Frontend design: Obsidian

Safety Guard uses an app-focused Web3 visual system: an obsidian background, lime primary actions, lavender chain details, and a generated glass shield with a chrome orbit. Geist handles interface copy; Geist Mono distinguishes transaction labels and reward numbers. The interface stays in English.

## Visual system

| Token | Value | Use |
| --- | --- | --- |
| Background | `#0c0e11` | Application canvas |
| Card | `#14171c` | Journey, guardian, and account surfaces |
| Primary | `#b6f569` | Main actions and successful states |
| Accent | `#b6a3f5` | Wallet and blockchain details |
| Text | `#edf0f4` | Primary content |
| Secondary text | `#a1aab8` | Supporting content |
| Border | `#2a3039` | Surface separation |
| Danger | `#ff9b92` | Help and error states |

Theme tokens apply at the document root, including portal-rendered dialogs. Existing hardcoded light surfaces now use shared tokens. Forms, focus indicators, warning states, map attribution, and reduced-motion preferences retain distinct treatments.

## Product changes

- The dashboard prioritizes guest onboarding or starting a journey. A wallet is optional for app-only participation; wallet sign-in is labeled separately from guest registration.
- The visual identity card explains the fixed 25-point / 10-reputation pool. It does not present simulated community totals or suggest a monetary token.
- All four navigation destinations remain available on mobile.
- Existing rider controls appear before the map and activity feed. On phones, guardian availability and human relay controls precede the map.
- Chain actions remain visible. Transaction details can be expanded; pending or error states automatically reveal those details, including discarding an unsigned request.
- Maps retain OpenStreetMap attribution and the existing endpoint-line disclaimer. Dark styling changes presentation only.
- Guest sessions, wallet signing, role-based private access, invite links, polling, location consent, account recovery, and API contracts are preserved.
- **Companion activity** extends the same theme with an **OFFLINE MOCK** badge, expandable action results, context freshness, and a timestamped **For the next guardian** summary. It shows five recent runs and distinguishes queued, completed, cancelled, and failed work. Product copy states that no live AI model is connected.

## Assets and validation

The original shield artwork and social card were generated for this project. Only public artwork is included in the frontend; no provider credential is embedded. Private site access remains owner-only.

Validation for this revision includes frontend type checking, lint, the production build, eight existing API proxy tests, and a source review of role-sensitive controls. The local page compiled and returned HTTP 200. The browser connection was unavailable, so this revision does not claim screenshot-based visual QA, viewport measurements, or a completed browser-wallet acceptance test.

The private publication succeeded at the existing URL. [Hosted checks](deployment/frontend.web3.validation.json) verified the new homepage content, stylesheet delivery, social metadata, exact image hashes, admin route, production API readiness, and unchanged V2 Devnet configuration.
