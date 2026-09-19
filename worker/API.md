# Safety Guard API

The [community ledger API](../docs/COMMUNITY_LEDGER.md#api) adds notice acceptance, paginated member/journey evidence and administrator-signed corrections. New real journeys require `POST /api/me/community-notice` with `{ "version": "community-v1" }` first. Existing help and closure actions remain available. `GET /api/me` includes `communityNoticeVersion`; the old app totals in that response must not be added to the new ledger's finalized profile totals.

The standalone Cloudflare Worker runs at `http://127.0.0.1:8787` with `npm run dev` in this directory. The web app can proxy `/api/*` to this address. Participants need no API key or wallet for human approval and relay. The operator configures dedicated issuer/sponsor keys and Devnet funding for community publication; local development can retain pending intents with publication disabled. AI/provider integration work is deferred; existing optional routes are documented separately below.

## Authentication and errors

Create a session with `POST /api/session` and JSON `{ "name": "Morgan" }`. The response includes a bearer `token` and the current `user`, initially with zero app points, reputation and completed guards. Send `Authorization: Bearer <token>` on subsequent requests. Tokens expire after 30 days. The server stores a SHA-256 token digest in the user's Durable Object. There is no default shared signing secret, and trip responses never contain session tokens. Wallet binding, login, wallet rotation and recovery are implemented in the [identity API](../docs/IDENTITY.md). A guest without a linked wallet or another valid session cannot recover access solely from a display name.

All POST JSON requests use `Content-Type: application/json`. The request size limit is 16 KB. Errors have `{ "error": "Human-readable message", "details": [] }`; `details` appears only for validation errors. Codes include 400 invalid input, 401 invalid session, 403 forbidden participant/origin, 409 state conflict, 415 unsupported content type, 429 rate limited, and 503 optional integration unavailable. All responses disable caching.

## Routes

| Method | Route | Result / input |
| --- | --- | --- |
| GET | `/api/health` | Public service health and capability names. |
| GET | `/api/config` | Public integration capability status. No secrets. |
| POST | `/api/session` | `{name}` → `{token,user}`. |
| GET | `/api/me` | `{user}` with current app points and reputation. |
| GET | `/api/trips` | `{trips: TripSummary[], myTrips: (Trip | TripSummary)[]}`; pending applicants appear in `myTrips` only as personalized redacted summaries. |
| POST | `/api/trips` | Create a private trip and publish a redacted guard request. |
| POST | `/api/demo/start` | `{}` → `{trip}` with a simulated guardian, Alex, in Waterloo. |
| GET | `/api/trips/:id` | `{trip: Trip | TripSummary}`; rider/current guardian receive private state, candidates/guests receive only an available redacted request. |
| POST | `/api/trips/:id/actions` | `{action,requestId?,...}` → `{trip: Trip | TripSummary}`, filtered for the current caller. |
| POST | `/api/trips/:id/voice` | Reads the latest agent message as `audio/mpeg`; requires ElevenLabs configuration. No arbitrary speech input. |
| POST | `/api/notifications/:tripId/:notificationId/ack` | Provider-only acknowledgement; uses `NOTIFICATION_ACK_SECRET` as its Bearer token. |

Create trip input:

```json
{
  "origin": { "label": "University of Waterloo", "lat": 43.4723, "lng": -80.5449 },
  "destination": { "label": "Uptown Waterloo", "lat": 43.4643, "lng": -80.5204 },
  "checkInIntervalSeconds": 60,
  "shareUrl": "https://trip.uber.com/example",
  "emergencyContact": { "name": "A trusted person", "contact": "provider-specific recipient" },
  "notificationConsent": false
}
```

`shareUrl` and `emergencyContact` are optional. Optional `chainEnabled: true` selects the additional V2 wallet-signed commitment and requires a linked rider wallet and V2 configuration. Omitting it still creates mandatory sponsored community records for a new real journey. Check-in intervals range from 30 to 300 seconds and default to 60. Only HTTPS URLs on `uber.com` or its subdomains are accepted. Shared links are never fetched, and no Uber telemetry integration is implied. The rider must supply positions through the app. Contact information is private to trip participants. Real outbound notifications require rider consent AND enabled, server-configured provider credentials.

## Human recruitment and actions

All actions use `POST /api/trips/:tripId/actions`. The historical action name `accept` now **submits an application**; it no longer grants guardian access directly.

Recruitment references are UUIDs returned by the API. Replace symbolic IDs in the examples with those actual UUIDs. The `requestId` field identifies different records depending on the action:

| Action | Required reference | Authorization and effect |
| --- | --- | --- |
| `accept` | Current `TripSummary.requestId`: trip ID initially, relay ID for a replacement | A guest who is neither rider nor current guardian applies; response stays redacted until rider approval |
| `withdraw-application` | Applicant's `application.id` | The candidate withdraws their own pending application |
| `approve-guardian` | Selected `GuardianRequest.id` | Rider only; approves an unexpired candidate for the current request, changes assignment, and closes competing recruitment |
| `reject-guardian` | Selected `GuardianRequest.id` | Rider only; removes that pending application |
| `request-relay` | None | Active rider or current guardian requests a ten-minute replacement window |
| `cancel-relay` | Current `relay.id` | Rider or current guardian cancels that relay and clears its applications; current assignment remains |
| `check-in` | None | Rider reports being okay; current guardian records an explicit eligible check-in; optional `text` |
| `takeover` | None | An authorized participant enters automated reminder mode and opens relay recruitment; no replacement human is implied |
| `resume` | None | Current guardian explicitly resumes, increments their check-in contribution, and restarts their deadline; an open relay remains open |
| `arrive` | None | Rider only; confirms arrival, closes recruitment, and settles the fixed eligible contribution pool |
| `cancel` | None | Rider only; closes the journey/recruitment without completion contribution points; eligible free banners remain available after closure |
| `help` | None | Participant requests immediate escalation; optional `text`; does not wait for a model |
| `message` | None | Current participant sends `text`, maximum 1,500 characters |
| `location` | None | Rider submits valid `lat`/`lng`; receipt time is assigned by the server |
| `simulate` | None | Demo rider only; `scenario` is `guardian-offline`, `route-deviation`, `stale-location`, or `notification-failure` |

An initial request lasts at most 24 hours; a relay lasts ten minutes. At most five pending applications exist per trip. Application expiry is the earlier of five minutes after submission and the current request's expiry.

For V2-linked journeys, `approve-guardian` returns 409: the rider signs a proposal and the guardian signs acceptance through the chain API instead. Private assignment changes only after finalized acceptance. Ordinary walletless journeys use the application approval action above; their community records are platform attestations, not participant wallet signatures.

Example application body, using the current public request reference:

```json
{ "action": "accept", "requestId": "CURRENT_REQUEST_ID" }
```

The rider approves the returned application's ID, not the trip or relay ID:

```json
{ "action": "approve-guardian", "requestId": "APPLICATION_ID" }
```

Approval alone is not reward eligibility. A replacement approval revokes the former guardian's future private reads and actions. Former guardians can apply again to a later available request and must be approved again. Expired, withdrawn, rejected, stale, or already-consumed applications cannot grant access.

Journey completion/cancellation clears pending applications and relay. Closed journeys reject trip actions. The demo guardian has no real account; demo completion issues no real credits, and demo notifications do not call real recipients.

## Response model and privacy

Exact TypeScript models are in [src/types.ts](src/types.ts) and [src/community-types.ts](src/community-types.ts). Application journey, session and expiry timestamps use Unix milliseconds. Community event/correction `observedAt` and the raw on-chain receipt's `recordedAt` use Unix seconds. The HTTP community `finalizedAt` field is the finalized receipt's `recordedAt` converted to milliseconds; it is distinct from the event's claimed observation time. Correction preparation `expiresAt` also uses milliseconds.

`Trip` retains its journey fields and adds:

| Field | Shape |
| --- | --- |
| `guardianRequests` | Pending `GuardianRequest[]`: `{id,kind,candidate,createdAt,expiresAt}`; `kind` is `initial` or `relay` |
| `relay` | `{id,requestedBy,requestedAt,expiresAt}` or `null` |
| `contributions` | One cumulative entry per guardian: `{guardian,checkIns,startedAt,endedAt,points,reputation,rewardStatus}` |
| `reward` | Fixed pool `{points:25,reputation:10,status}`; `status` is `pending`, `credited`, `demo`, or `ineligible` |

The lifecycle is `open | active | arrived | cancelled`. `guardMode` remains `waiting | human | ai`; `ai` is a legacy name for the automated companion path, which uses deterministic rules without a configured provider. It is not a promise of human coverage.

A `TripSummary` contains `id`, `demo`, `chainEnabled`, `status`, `createdAt`, `checkInIntervalSeconds`, `rewardPoints`, `requestKind`, `requestId`, `requestExpiresAt`, `riderProfile`, and `application`. `riderProfile` contains only the rider's public `{id,name}` or is `null`. Request fields are `null` when no applicable public request exists. `application` is only the current viewer's `{id,expiresAt}` or `null`.

Candidate journey summaries include the rider's public profile reference and display name, while excluding routes, exact positions, contacts, Uber links, conversations and the candidate roster. Every active member's profile, contribution values and public evidence are available to other authenticated community members, with no visibility toggle. Wallet/authentication metadata is excluded from that public profile. Private trip state is available only to the rider and currently approved guardian. Historical contribution does not preserve private access after replacement. Former guardians can inspect the public community journey evidence and their V2 receipts; `/api/me` continues to expose older application counters. Data already seen or copied by a former guardian cannot be recalled. Authorization is rechecked after asynchronous work before private action or voice responses are returned.

A guardian qualifies for a new community contribution through a check-in observed during an accepted assignment, followed by rider-reported arrival. Eligible public community references are sorted lexically; the 25-point and 10-reputation pool is divided equally with integer remainders assigned in that order. With two eligible guardians the shares are 13/12 points and 5/5 reputation. Returning guardians retain separate assignment histories and one cumulative contribution share. Additional check-ins and banners do not increase the pool. Older unimported application journeys retain account-ID ordering; optional V2 protocol allocations use wallet ordering and require signed check-ins.

Application contribution `rewardStatus` is `pending | credited | ineligible | demo`. Settlement retries use each user's trip-keyed credit ledger to avoid duplicate credit. Community publication separately reports `pending | submitted | finalized | retry`; app credit is not proof of chain confirmation. Cancelled or expired journeys retain history without completion allocations, while eligible guardians can still receive one free fixed-category banner. A late aggregate V2 check-in for a former guardian does not establish the captured assignment evidence needed to issue a new official banner. Demo journeys produce no official recognition. A participant's allocation can be zero when eligible participants outnumber pool units.

`GET /api/members/:id/records` separates finalized and pending community recognition from legacy application totals. Publishing an existing eligible contribution changes its verification status without adding another award. V2 claims and `/api/me` counters must not be added to community totals; V1's separate single-guardian 10-point receipt remains historical. An administrator-signed correction withdraws the entire closed journey's effective contributions and banners while retaining its records; partial redistribution and reinstatement are not implemented.

Notification status remains `queued | sent | failed | acknowledged | simulated`. A provider accepting a request is not recipient acknowledgment. These existing optional integration paths do not establish that external messages were sent during human-relay testing.

## Existing local data

Stored schema version 1 is upgraded lazily to version 2. Existing assignments are retained; pending applications start empty and no relay is invented. One contribution is reconstructed for the existing guardian, with one compatibility check-in only when the old eligibility flag or already-credited reward established eligibility. Previously credited 25-point/10-reputation rewards remain credited and are not reissued.

This preserves old local records; it does not create retrospective rider approval or identity verification. New recruitment follows the application-and-approval rules above.

## Server monitoring

Each trip has a SQLite-backed Durable Object and persisted alarms. A missed guardian check-in opens relay recruitment and enables deterministic reminders without requiring a browser request. Assignment remains with the old guardian until rider-approved replacement; an overdue assigned guardian is not confirmed available.

Application and relay expiry are enforced by the backend. Relay expiry clears its applications and preserves the current guardian and mode. Explicit resumption does not automatically cancel an open relay. A stale-location warning occurs after two minutes without position updates; missing data is uncertainty, not proof of danger.

Existing recurring companion prompts run at `max(60, checkInIntervalSeconds)` seconds in automated mode. Two unanswered prompts can queue one existing contact escalation, subject to consent and configured delivery. A rider okay confirmation resets that count. No provider credentials are required or configured by this update.

Open journeys expire after 24 hours. Active monitoring has a six-hour limit; arrival/cancellation ends it sooner. Pending directory synchronization and reward settlement are persisted and recovered by alarms. Local alarms require the local Worker process to remain running.

## Configuration and deferred integrations

`wrangler.jsonc` declares non-secret settings and seven Durable Object bindings, including `COMMUNITY` for independent publication journals and member indexes. `npm run types` regenerates runtime and binding types. The compatibility date is pinned to `2026-08-22`.

Participants supply no provider credentials. The operator configures publication authorities separately from optional voice and notification services. The companion always remains offline in this implementation. Preserve existing Solana configuration, keep `.dev.vars` credentials private and use Worker secrets for hosted credentials:

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Do not enable model calls. The current companion remains an offline mock regardless of these values; live API integration needs further implementation. |
| `NOTIFICATIONS_ENABLED` | Must be `true` to enable external notification dispatch. Defaults to `false`. |
| `NOTIFICATION_WEBHOOK_URL` | HTTPS endpoint owned/configured by the operator. Users cannot choose the outbound destination. |
| `NOTIFICATION_WEBHOOK_SECRET` | Bearer credential sent only to the configured provider. |
| `NOTIFICATION_ACK_SECRET` | Separate provider callback credential. |
| `ELEVENLABS_API_KEY` | Enables speech for existing agent messages. |
| `ELEVENLABS_VOICE_ID` | Server-selected voice ID. |
| `SOLANA_PROGRAM_ID`, `SOLANA_V2_PROGRAM_ID`, `SOLANA_RPC_URL` | Preserved V1, optional V2 wallet commitments and public Devnet RPC configuration. |
| `SOLANA_PRIVATE_RPC_URL` | Optional server-only RPC secret; provider credentials never belong in public configuration. |
| `COMMUNITY_ENABLED`, `COMMUNITY_PROGRAM_ID` | Community publisher activation and its separate program address. Disabled publication retains pending intents. |
| `COMMUNITY_ISSUER_SECRET_KEY`, `COMMUNITY_SPONSOR_SECRET_KEY` | Dedicated issuer and fee/storage sponsor keypair JSON in Worker secrets. Participant and administrator/deployment private keys stay outside the Worker. |
| `ALLOWED_ORIGINS` | Comma-separated direct browser origins. A same-origin frontend proxy avoids cross-origin requests. |

The notification webhook receives `{id,tripId,recipient,message,location,rider}` and the stable `Idempotency-Key` header. The receiver must enforce idempotency and take responsibility for routing, delivery reporting, and recipient acknowledgement. The worker never calls emergency services. No notification provider or real recipient is contacted by the automated tests.

Rider approval is not real-world identity verification. Wallet authentication/recovery, moderation and retention/deletion are implemented; contact verification, stronger abuse controls, operational alerting and provider delivery monitoring require further work before broader use. This prototype stores private trip data in controlled server storage, excludes coordinates and contacts from the public community ledger, and never logs tokens, contact values or coordinates from application code.

## Verification

```sh
npm install
npm run types
npm run typecheck
npm test
npm run build
npm run dev
```

`build` is a Wrangler dry run. `npm run deploy` performs the actual cloud deployment and requires a valid Cloudflare login or API token.

Official implementation references: [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [SQLite-backed storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Workers practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [ElevenLabs text to speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
