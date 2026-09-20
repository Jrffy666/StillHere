# Journey agent harness: personal, offline, and gated API paths

Product direction update: [Personal agent guarding](PERSONAL_AGENT_GUARDING.md) is implemented and is the primary product path. It provides a guardian-owned agent identity, exact rider approval, scoped capability tools, an owner-operated watcher, and a local STDIO MCP bridge. The backend and interface are deployed; a [hosted watcher acceptance](deployment/personal-agent.hosted.validation.json) passed 23 checks with one real Codex assessment and human handback. This establishes one bounded workflow, not broad model quality. Separate [chain verification](deployment/personal-agent.chain.validation.json) passed 36 checks covering that journey's nine finalized receipts after the compatible Devnet upgrade. The hosted model API remains disabled. A separate manual local Codex flow previously passed its recorded [acceptance check](deployment/codex.demo.validation.json).

Updated September 20, 2026. The real Responses adapter and semantic execution path are implemented, while `OPENAI_ENABLED` remains `"false"` in checked-in development, staging, and production configuration. No paid Responses API validation is claimed. The separate [local Codex demonstration](CODEX_DEMO.md) has completed one real subscription-authenticated assessment and hosted import. Use [DEMO.md](DEMO.md) for human guarding, [AI_DEMO.md](AI_DEMO.md) for a truthful semantic demonstration, and authenticated participant APIs for developer inspection. [VALIDATION.md](VALIDATION.md) separately records tests and deployment evidence.

StillHere retains a deterministic mock provider as the default and fallback. When separately activated with a key, eligible model, current processing consent, and available budgets, the implemented real path makes one structured semantic assessment request per eligible run. Both paths use the same journey-scoped tools, durable authority checks, receipts, cancellation, and private evidence. Activation instructions and data-retention details are in [OPENAI_INTEGRATION.md](OPENAI_INTEGRATION.md); this change has not executed that activation.

Those platform-run paths are distinct from the personal runtime described next. Connecting or active personal delegation suppresses competing autonomous platform assessment, while ordinary human controls and deterministic help remain available. Personal capability operations submit validated proposals directly; they do not acquire the older platform harness's five-tool authority.

The mock provider selects from explicit rules and fixed messages. Its outputs and the product's agent trace must identify this mode. A successful mock workflow is evidence about application orchestration, not evidence of real-world safety, language comprehension, or qualification for an LLM-based award.

## Personal delegation and execution

[`worker/src/personal-agent.ts`](../worker/src/personal-agent.ts) defines the strict protocol; `TripRoom` implements its state and effects. The assigned nonsimulated guardian requests a named agent for 5–120 minutes under `personal-agent-v1`, and the rider approves that exact request. Management uses the existing participant session at `/api/trips/:tripId/delegation`. The guardian then obtains a connection file with one revocable journey capability. Only its verifier is stored. Downloading again before runtime acceptance rotates the previous token; after acceptance, changing runtimes requires a fresh approved delegation.

The separate `/api/agent/trips/:tripId/delegations/:delegationId/:operation` route requires that capability. Its six operations are `status`, `accept`, `updates`, `heartbeat`, `assess`, and `release`. Account sessions cannot substitute for it, and it grants no ordinary participant API access. The [CLI and local STDIO MCP bridge](PERSONAL_AGENT_CLIENT.md) expose exactly that scope; tool arguments cannot select another journey, credential, arbitrary destination, wallet, or notification recipient. See [the HTTP contract](PERSONAL_AGENT_PROTOCOL.md) for exact bodies and response shapes.

Acceptance enters `connecting`. Only the first valid assessment establishes `active` coverage; a heartbeat alone cannot do so. The server issues a minimized context with a job ID, revision, and expiry. `assess` validates sources again against current time and rechecks assignment, approval, lifecycle, revision, and current context. It atomically persists canonical questions, retained concerns, eligible recruitment, follow-up, and their receipt. Submitted text cannot invent a completed action. An identical retry returns the original receipt only while authority is valid; changed or stale replay is rejected, including after eviction and concurrent submission.

| Personal-runtime limit | Bound |
| --- | --- |
| Delegation | 5–120 minutes, one current guardian assignment |
| Last valid heartbeat | 45 seconds |
| Initial or pending assessment | At most 90 seconds, never beyond delegation expiry |
| Follow-up delay | 30–300 seconds |
| Minimized context | 12 eligible messages and eight retained rider concerns |
| Private receipt/delegation history | 40 receipts and 12 previous delegation views |
| Watch defaults / configurable maxima | 12 turns and 20 minutes / 60 turns and 120 minutes |
| Watch model subprocess | 60 seconds |

New rider input replaces stale jobs without extending the original pending-response deadline. Heartbeats update connectivity, never that deadline or human contribution. Human resume/check-in, replacement, closure, explicit help, assistance being turned off, revocation, expiry, deletion, or unavailability ends access. Personal-agent consent is independent of the hosted API's v2 choice; use the delegation revoke action to withdraw it. The frontend checks expiry/connectivity/response timestamps locally to avoid showing old active coverage while awaiting refresh.

The watcher polls every five seconds and sends ten-second heartbeats during inference. It invokes the owner's supported Codex CLI in an isolated assessment process without giving the model its capability. The runtime discards stale results and does not rerun inference after uncertain submission; it may retry the same proposal at most twice. Turn/time bounds are not a token or monetary guarantee. The owner must keep the environment awake and connected. The STDIO MCP bridge invokes no model and starts no watch loop by itself; remote hosted-client support is not implied.

Only current rider and owning-guardian messages authorized by the two personal-agent approvals enter the job. Former guardians, applicants, system/agent text, dedicated account and journey fields, contacts, wallet data, shared links, and exact coordinates are excluded. Text redaction is heuristic. Source IDs and times are retained for checks; the exact context and receipts remain private. Backup export omits private capabilities and pending jobs; restoration ends the old delegation rather than resurrecting it. Automated-service ledger events are separate minimal provenance and earn no human contribution points.

## Platform harness responsibilities and authority

The journey's `TripRoom` Durable Object remains the owner of private journey state and scheduled monitoring. The harness operates within that journey. It does not receive a general-purpose application session or permission to invoke arbitrary participant actions.

The rider updates choices through authenticated `POST /api/trips/:id/assistance`. Boolean fields are strict; strings, numbers, or unknown properties cannot silently grant consent. Defaults remain `automatedCheckIns: true`, `timeoutContact: false`, and `liveAiConsent: false`, with the legacy notice version `openai-assistance-v1`. That v1 preference cannot authorize live processing. The current notice is `openai-assistance-v2`; each current participant can update only their own processing choice through `POST /api/trips/:id/ai-consent` with `{ "consent": true, "noticeVersion": "openai-assistance-v2" }`, or `consent: false` to revoke.

The rider's current v2 consent gates a platform Responses request. Its provider snapshot includes only the current consenting rider's and current consenting guardian's messages; former guardians, candidates, nonconsenting authors, and agent/system messages are excluded. Guardian consent does not enable the rider's request or change the rider's reminder policy. Community publication, personal delegation, and trusted-contact notification consent remain separate choices. Turning automated check-ins off cancels pending agent work; ordinary human controls and deterministic explicit help remain available. Revocation cannot recall data already transmitted to a provider.

The five platform tool names define a narrow application boundary. They are internal execution tools, not the personal capability's six public operations:

| Tool | Intended responsibility | Authority it does not grant |
| --- | --- | --- |
| `get_journey_context` | Read bounded, relevant context for the current journey, including the freshness of messages and location observations; accepts only `{}` | Read other journeys, wallet secrets, or arbitrary application data |
| `send_check_in` | Request an attributed automated question; proposed text is limited to 600 characters and the server renders canonical text | Impersonate a rider or guardian check-in, invent success, or earn contribution credit |
| `schedule_follow_up` | Arrange a server-side follow-up 30 to 300 seconds away | Disable baseline monitoring or defer an explicit request for help |
| `request_human_relay` | Open recruitment for a replacement human guardian; reason is limited to 300 characters | Select or approve a guardian, grant a candidate private access, or sign a handoff |
| `notify_trusted_contact` | Request the configured-contact workflow with a permitted escalation cause and current consent; reason is limited to 300 characters | Choose a recipient, provider URL, emergency-service destination, or its own authorization |

Rider approval still controls human assignment. Wallet signatures still control chain operations. The harness cannot confirm arrival, complete a journey, mint rewards, sign a transaction, or downgrade an explicit emergency. A replacement candidate receives private journey information only after the normal approval process.

The protocol is defined in [`worker/src/agent.ts`](../worker/src/agent.ts). Unknown tools, extra properties, noninteger delays, and arguments outside the limits are rejected. The executor requires a successful `get_journey_context` receipt from the same run before every effectful tool, including recovered or injected pending calls. The mock attempts each tool at most once in a run; the executor independently validates current state and duplicate effects. A valid tool schema is not authorization.

Escalation distinguishes `explicit_help`, `user_authorized_timeout_policy`, and `model_concern`. Explicit help follows the server workflow immediately without waiting for a provider or an available provider budget. Chat keywords or rule/model inference may prompt clarification or human attention, but cannot authorize a contact notification. Timeout contact requires both the rider's `timeoutContact` opt-in and separate current notification consent. A risk label alone is insufficient. Configured-contact and notification-consent requirements still apply to any external contact.

Triggers distinguish human unavailability (`takeover`), a rider message (`rider-message`), an alarm-driven follow-up (`follow-up`), stale location (`stale-location`), and failed notification delivery (`notification-failure`). The mock requests a new relay only for takeover or rider-message triggers. Periodic checks do not reopen a cancelled relay. A notification-failure run reports the failed status instead of starting a second notification-delivery loop.

## Generic offline provider boundary

[`worker/src/agent-provider.ts`](../worker/src/agent-provider.ts) exports `runProviderDecision`, `createMockProvider`, and `createDisabledOpenAIProvider`. The interface has an ID (`mock` or `openai`), a `live` flag, and `decide({ trigger, steps, signal })`. Inputs are detached JSON snapshots; adapter mutation cannot modify durable state. No executor, fetch callback, credentials, or application binding is passed to the provider.

The boundary accepts exactly one tool proposal validated by `parseAgentToolCall`, or a completion with a nonempty summary of at most 1,200 characters. Extra fields, malformed decisions, and forbidden tools are rejected. Serialized input is limited to 32,000 characters and output to 8,000. Optional limits can be lowered but cannot exceed these ceilings.

An eight-second deadline actively aborts the provider signal. Caller cancellation does the same, including cancellation before invocation. A provider that ignores cancellation cannot apply a late result; late rejection remains handled. Success or failure clears the timer and detaches the external abort listener. An abort signal cannot interrupt arbitrary synchronous JavaScript, so adapters must cooperate with cancellation.

The legacy disabled OpenAI factory still rejects with `LIVE_PROVIDER_DISABLED` before reading a key or making a request. It is not the real adapter, and the generic offline boundary still refuses providers marked live. The implemented paid assessment path below is separate. A key or `liveAiConsent: true` alone cannot enable it; it additionally requires server activation, an allowlisted model, the current v2 choice, eligible lifecycle state, and budgets.

## Optional one-call Responses assessment

[`worker/src/openai-provider.ts`](../worker/src/openai-provider.ts) implements the real foreground Responses request. It forces the strict function `propose_journey_assistance`, disables parallel calls, sets `store: false`, and accepts only a complete, source-valid structured assessment with valid provider metadata and usage. The allowlist contains `gpt-4.1-mini` and `gpt-4.1-mini-2025-04-14`; the unpinned alias is the current default. The adapter is implemented, but server configuration leaves it disabled.

[`worker/src/agent-semantic.ts`](../worker/src/agent-semantic.ts) allows up to four findings: `concern`, `conflict`, `reassurance`, or `uncertainty`, each associated with a topic and source references. The proposal also selects one question kind, a Boolean recruitment proposal, and an integer follow-up delay of 30–300 seconds. It contains no arbitrary participant-facing prose, notification recipient, safety verdict, or authority field. Each source list is bounded to four unique references and the assessment to eight distinct references overall.

Only supplied rider/guardian message references and retained rider concern references are accepted. New concerns need rider messages from the last five minutes; old retained concerns remain eligible for preservation. Conflicts need at least two distinct message sources. Question references need recent rider messages or retained concerns; limited source-free questions need a valid server condition. Unknown, future, ambiguous, agent/system, and ineligible-author sources are rejected. These checks establish source validity, not semantic correctness.

The server then uses [`worker/src/ai-runtime.ts`](../worker/src/ai-runtime.ts) to select from the existing scoped tools. It writes fixed, targeted question wording with a quoted source excerpt, may open eligible recruitment, and schedules the bounded follow-up. Current notification authority is independent of semantic output. The model is not called again with tool results, does not choose arbitrary effectful tools, and does not run a free-form chat or a multi-agent loop. An active explicit-help request bypasses this interpretation path and keeps the canonical safety workflow.

## Platform-run durable execution

[`worker/src/trips.ts`](../worker/src/trips.ts) persists the harness with the journey in the existing SQLite state row. A run records its trigger, revision, status, attempts, retry deadline, lease, tool calls, receipts, completion, and cumulative use. Real-path records additionally preserve the assessment attempt/reservation, safe failure code, validated semantic assessment and source snapshot, model/prompt identifiers, available request/response IDs, and reported usage. Participant responses expose these as private agent records. Offline runs identify `provider: "mock"`; an accepted real assessment is identified as `openai`, while fallback remains explicit.

The execution sequence is:

1. Persist a queued trigger and schedule a Durable Object alarm.
2. Obtain a successful scoped context receipt. When the real path is eligible, persist its one-attempt marker and journey reservation, reserve the global budget, renew the lease, and request one semantic assessment. Otherwise select the mock path.
3. Reload state and check revision, ownership, lease, consent, and current context before accepting any decision or assessment. Validate semantic references before storing an accepted assessment.
4. Select the next tool from the accepted semantic plan or the bounded offline provider. Persist the validated proposal; require the same run's context receipt before any effect.
5. Revalidate authority, render canonical server text, apply the local effect, and persist it with its receipt in one SQLite write.
6. Continue local tool work from receipts until completion, cancellation, or a limit, then build the private handoff. No second paid assessment is purchased inside that run.

A new instance can resume a persisted pending call after eviction. Already recorded local effects are not repeated when resuming the same run. Duplicate trigger IDs are ignored while their runs remain in the retained history. This bounded history is not a permanent global deduplication ledger.

| Limit | Bound |
| --- | --- |
| Request/decision deadline / renewed run lease | 8 seconds / 15 seconds |
| Generic offline boundary input / output | 32,000 / 8,000 serialized characters |
| Cumulative local decisions / input per run | 24 decisions / 120,000 characters |
| Cumulative local decisions / input per journey | 240 decisions / 1,200,000 characters |
| Retained runs / recorded steps per run | 20 / 8 |
| Execution attempts / maximum run age | 3 / 10 minutes |
| Paid assessment attempts | At most one per run; no automatic paid retry inside a run |
| Real request / response | 32,000 / 64,000 bytes; at most 1,200 output tokens |
| Journey paid reservations / units | 12 / 120,000, with a ten-second cooldown |
| Deployment-wide daily reservations / units | 50 / 500,000 per UTC day |

Cumulative use is persisted before invocation, including attempts that fail or time out. Retry, eviction, and retained-run pruning do not reset journey totals. Character budgets bound local decision input and are distinct from paid-call reservations. Each paid reservation is the full request body's UTF-8 byte length plus 1,200 output units, capped at 33,200. The governance-owned `AiBudgetLedger` serializes daily reservations across journeys and rejects reuse of a reservation ID. These conservative units are not measured tokens, a dollar limit, or an invoice; actual provider-reported input/output/total tokens are recorded separately. Uncertain or aborted work keeps its reservation. Limits can block a request before dispatch without consuming an actual model call.

Local execution retry delays remain bounded by attempt count. A persisted paid-attempt marker survives recovery: an interrupted reserved attempt is marked failed with `AI_INTERRUPTED`, keeps its conservative reservation, and is not redispatched. Eviction or a failed assessment therefore does not purchase a second request in the same run. A later independent run still needs current consent, cooldown, and remaining budgets. Exhausted budgets preserve human controls and explicit help, and the real path records an explicit rules-based fallback.

New participant intent invalidates older runs by revision. Ending the journey, resuming human monitoring, or turning automated check-ins off cancels pending runs and clears the follow-up. The executor reloads state after asynchronous provider work and checks ownership and lease, so a delayed decision cannot continue a superseded run. A follow-up can bring the next wake-up earlier; it cannot postpone the baseline deadline.

A change in location freshness, risk, escalation cause, consent, or notification status invalidates stale context before the next effect. The runner cancels that run and can queue a fresh context read when current policy permits it. The contact tool checks for an existing notification immediately before execution; an old proposal cannot bypass the durable outbox by waiting past its rate limit.

## Data freshness and uncertainty

Location updates come from the browser or an explicitly marked simulation. A shared Uber URL is a stored link; the application does not fetch live Uber telemetry. An old location may indicate a closed browser, missing GPS permission, or a network interruption. It does not establish a route deviation or prove danger.

Compare timestamps and sources before treating messages as current evidence. An earlier reassurance does not cancel a later concern. A newer ordinary message also does not automatically clear an urgent state. The deterministic mock can recognize a small set of fixture phrases; it is not a general multilingual classifier or a route-analysis model.

The local executor context contains at most 12 messages, with each text limited to 800 characters, and five notification statuses. Message age is checked separately; inclusion does not establish freshness. Dedicated identity, contact-address, wallet, shared-URL, and coordinate fields are omitted. It includes location age and observation time instead of the precise position. The mock considers rider messages from the preceding five minutes, sorts by timestamp rather than array order, ignores future timestamps, and preserves uncertainty when same-time statements conflict. The stale-location threshold is two minutes.

The external snapshot is further restricted to at most 12 messages from current consenting authors and eight retained rider concerns. It excludes structured account/journey identifiers, notification details, exact coordinates, shared ride links, and credentials. It includes evidence IDs, roles, timestamps, text excerpts, and location freshness. The model's semantic interpretations remain uncertain even after their source references pass validation; language comprehension and useful clarification are live-evaluation questions.

The journey also retains at most eight unresolved rider concerns with source identifiers and observed/received timestamps. These bounded records can outlive the recent-message window. Neutral messages do not create concerns. Once eight are pinned, additional concerns remain in the bounded conversation history with a capacity event; they never silently evict earlier unresolved items. A reassurance, provider summary, or human handoff does not resolve them. The rider resolves one through `POST /api/trips/:id/actions` with `{ "action": "resolve-concern", "requestId": "<concern.id>" }`; the server records a resolution event tied to that source and invalidates the current handoff. This is bounded working context, not an unlimited transcript or permanent history of every concern.

The appropriate response to incomplete evidence is a bounded check-in and, when indicated, a request for human attention. The system must distinguish what it observed, what it did, and what remains unknown.

## Notification evidence

Notifications use the application's durable outbox. Creating a tool result or queuing a notification is not proof of delivery. The existing transport distinguishes queued, failed, provider-accepted, recipient-acknowledged, and simulated results.

Timeout jobs are reauthorized before dispatch and retry. A rider response, resumed human coverage, revoked timeout choice, disabled automation, or revoked contact consent stops an unsent timeout job. Explicit help remains separate: a routine check-in does not downgrade its urgent status. A provider request already dispatched cannot be recalled. Existing journeys receive safe default preferences; legacy real notification jobs without a recorded authorization cause cannot dispatch.

Webhook requests reuse the notification ID as the provider idempotency key. A crash or timeout can leave the application unable to tell whether the provider accepted a request; a retry may occur. Actual duplicate suppression depends on the provider honoring that key. The application does not claim exactly-once external delivery.

Demo notifications are simulated and do not contact a person. In an ordinary journey with external notifications disabled, the application reports that no external message was sent. Failed delivery must remain visible rather than being described as a successful escalation.

## Private records

Action traces describe the trigger, tool request, validation result, and observable outcome. They are operational records, not a model's hidden reasoning. A handoff summary should help the currently authorized human understand the last known state and unresolved work without claiming a rescue or recipient response.

Provider text is a proposal, not evidence. The server renders canonical check-ins and handoffs from context and actual tool receipts instead of publishing arbitrary claims about assignment, delivery, or safety. In the real path the model selects the question category, topic labels, and quoted sources; it does not author the factual wording. The structured handoff records source references, actor roles, timestamps, freshness, unresolved concerns, actions, and notification states. A completion snapshot is not attributed to an earlier context-read receipt unless those snapshots match. References are validated against supplied evidence.

Canonical summary text can be up to 4,000 characters. The runtime textual handoff contains server action receipts plus a pointer to the AI interpretation panel, rather than a truncated combination of two summaries. The complete assessment and exact minimized context are stored in `semanticHandoff`; the UI renders that record independently so all semantic citations remain available. The standalone `renderSemanticHandoff` helper remains bounded and tested, but it is not the runtime UI's source of a combined prose summary.

The generic offline completion proposal has a separate 1,200-character bound and is not the trusted narrative. Real assessment output has its own 1,200-token limit; tokens and characters are different units. Detailed receipts and structured source records remain the source of truth. A summary is a snapshot and does not refresh itself after every later delivery receipt or location update. Concern changes, explicit resolution, and processing-choice changes invalidate the current handoff.

Journey context, concerns, traces, and handoffs are private application data. Dedicated contact and wallet fields are omitted, but a user can still type personal information into chat. Free-text redaction is heuristic, not a guarantee of anonymity or removal of all personal information. Use synthetic data for published evidence. Private messages, interpretations, concerns, handoffs, and exact locations never become chain evidence or community recognition; existing authorized system events remain separate from model opinions.

The real request sets `store: false`; this is not a Zero Data Retention guarantee. Standard provider abuse-monitoring retention may still apply, and account-specific controls must be verified before activation. Current v2 processing consent must describe the actual transfer and retention configuration. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and [OPENAI_INTEGRATION.md](OPENAI_INTEGRATION.md#consent-and-the-data-boundary).

The public directory and pending-candidate responses exclude private agent records. Replacing a guardian revokes private journey access, including context and handoff. Participant deletion clears retained agent records that could quote that participant; journey erasure removes them with the journey. Backup restoration discards runs, concerns, follow-ups, and handoffs and closes previously active journeys instead of replaying background work.

## Local inspection

Start the application with `npm run dev` from the project root using the existing local setup. The offline path needs no OpenAI key or credits. Keep `OPENAI_ENABLED` and external notification delivery disabled for offline inspection. A local build or test does not publish this change to the hosted site; deployment status is recorded separately in [VALIDATION.md](VALIDATION.md). Do not enable the real path merely to reproduce mocked contract tests.

Use synthetic participant sessions and the current human guarding flow in [DEMO.md](DEMO.md). Exercise stale location, old reassurance followed by newer concern, explicit concern resolution, timeout policy consent, human resumption, and assistance being turned off. Inspect actual receipts and server handoff text through the authenticated participant response. Known fixture phrases exercise deterministic rules, not general language comprehension. The removed sample launcher and scenario buttons are not required for these checks.

Participant assistance choices expose reminder and timeout policy, retained concerns, and the rider's explicit resolution workflow. Other participants cannot change those rider preferences. Each current participant controls only their own AI processing choice under the v2 notice. Client consent does not change the server's `OPENAI_ENABLED` setting. Inspect actual server availability, run provider, semantic attempt, and fallback fields instead of inferring live execution from a checked consent box or an available key.

For developer inspection, authenticated `GET /api/trips/:id` includes `trip.agent.runs`, per-step results, `followUpAt`, `handoffSummary`, structured evidence, and any accepted semantic assessment or failed attempt. Use the same participant authentication as the ordinary journey view. Check actual source references, model/prompt identifiers, reported usage, reservations, and receipts when a real request is later authorized; do not export authentication tokens or private response bodies as public evidence.

To demonstrate actual human access transfer, use an ordinary application journey with synthetic rider and guardian accounts in separate sessions, rather than the demo guardian. Request a replacement, apply from a second guardian session, and have the rider approve it. Confirm that the new guardian sees the private handoff information and that the former guardian loses access. An application-only journey can exercise this without a wallet; a chain-linked journey still requires the existing explicit wallet-signing flow.

## Fixture tests

The dedicated personal-agent integration suite exercises real application routes with synthetic rider/guardian accounts. Its 30 cases cover strict approval, token scope and rotation, readiness, minimized eligible authors, source/time freshness, newer input, concurrent and repeated submissions, actual canonical actions, unchanged human awards, human return, revocation, expiry, disconnect and response deadlines, restore, and directory privacy. Model calls and real chain transactions are excluded. Separate client tests cover the watcher and MCP; interface tests cover truthful coverage and connection-file handling.

The fixtures use synthetic messages, timestamps, coordinates, identities, and provider results. Some runtime tests edit persisted deadlines or insert a pending step to reconstruct an interruption without waiting several minutes. These are deterministic orchestration tests, not an LLM benchmark or evidence that the application has monitored actual Uber rides.

| Scenario | Expected application behavior | Test coverage |
| --- | --- | --- |
| Stale GPS and no fresh observation | Ask for a check-in, preserve uncertainty, and avoid declaring danger or sending a contact notification solely because location is old | Mock provider and Durable Object alarm tests |
| Old reassurance, newer route concern, and out-of-order or future timestamps | Use rider-message timestamps; request clarification; keep urgent state active despite reassurance | Mock provider tests, including fixed English, Chinese, Spanish, and French phrases |
| Malicious instructions or malformed tool arguments | Reject unsupported tools, arbitrary recipients, extra fields, and invalid limits; recheck current contact consent before an effect | Strict protocol and durable pending-call tests |
| Eviction, provider failure, or replay after a committed tool | Resume persisted work, retry within the budget, and avoid repeating the recorded local effect | Durable Object restart and retry tests |
| Human resumes, journey ends, or a new participant action supersedes old context | Cancel obsolete work; keep traces private from candidates and former guardians; clear retained context affected by participant deletion | Runtime lifecycle and access tests |
| API key present while server activation is false, or notification delivery fails | Make no OpenAI request on the disabled path; report failed, simulated, accepted, and acknowledged notification states distinctly | No-network, mock status, and integration-adapter tests |
| Missing successful context or provider prose invents delivery/assignment | Refuse effectful calls without a context receipt; render factual participant claims from canonical server evidence | Context-first execution and canonical handoff tests |
| Chat implies danger or timeout contact consent is absent | Do not authorize contact based on inferred concern; require timeout opt-in plus notification consent | Escalation and rider-choice tests |
| Saved concern falls outside recent chat or reassurance arrives | Retain bounded source/timestamp evidence until explicit rider resolution | Retained concern and handoff tests |
| Provider times out, is aborted, returns oversized data, or exceeds persisted budgets | Abort or reject within limits, discard late results, handle late rejection, and preserve human controls | Provider boundary and durable-budget tests |
| Assistance is off, server activation is false, or only v1 processing consent is present | Cancel or exclude ineligible work; a key or legacy choice cannot activate live processing | Rider-choice lifecycle and gated OpenAI tests |
| Mocked Responses output has forged sources, unsupported categories, missing usage, or extra prose | Reject the assessment and retain an explicit fallback; no arbitrary factual claims enter the UI | Semantic protocol and Responses adapter tests |
| Current guardian declines processing or a former guardian authored the message | Exclude those messages from the external snapshot; preserve current participant access boundaries | OpenAI harness consent and author-filtering tests |
| Multiple journeys reserve paid requests or a run is recovered | Enforce UTC-day and journey limits, reject reservation replay, and avoid a second paid assessment inside a run | AI budget ledger and OpenAI harness tests |

Run the focused tests from the project root:

```sh
npm --prefix worker test -- test/agent.test.ts test/agent-provider.test.ts test/agent-semantic.test.ts test/agent-authority.test.ts test/agent-harness.test.ts test/openai-provider.test.ts test/openai-harness.test.ts test/ai-budget.test.ts test/integrations.test.ts
npm --prefix worker test -- test/personal-agent-integration.test.ts
npm run test:personal-agent
npm run test:personal-agent-ui
npm --prefix worker run typecheck
```

Run the broader Worker suite after changes to journey state, privacy, recovery, or relay behavior:

```sh
npm --prefix worker test
```

Refer to [VALIDATION.md](VALIDATION.md) for recorded execution results. The commands above are reproducible checks, not a claim that a newer local change or a hosted deployment has already passed.

## Disabled API integration and remaining validation

The primary personal runtime has a [recorded hosted acceptance run](deployment/personal-agent.hosted.validation.json): 23 checks, two synthetic accounts, one real Codex assessment in 8.683 seconds, and a two-turn/two-minute watcher limit. The server recorded a cited concern, a posted canonical question, and scheduled follow-up. Human return revoked the old capability; arrival and a free banner followed without agent-earned human check-ins. Zero hosted Responses calls or external notifications occurred. A separate [published-browser run](deployment/personal-agent.browser.validation.json) passed 12 checks through the actual consent, connection, real Codex response, human return, arrival and free-banner interfaces. These bounded runs do not establish broad model quality, sustained availability, or finalized new chain publication. The owner's model account and retention settings remain separate from the optional platform API configuration below.

See [AI_DESIGN.md](AI_DESIGN.md) for product scope and authority, [OPENAI_INTEGRATION.md](OPENAI_INTEGRATION.md) for the implemented adapter and activation runbook, and [AI_DEMO.md](AI_DEMO.md) for evaluation cases and presentation. Implementation is complete for the bounded one-assessment path; actual account compatibility, model quality, latency, usage, and end-to-end paid behavior still require authorized live evaluation. The generic boundary's disabled factory remains a legacy stub, distinct from the real adapter.

The semantic boundary separates interpretation from effect execution. An accepted real assessment selects from bounded categories and sources, then the server applies the existing journey permissions and receipt-based tools. Neither source validity nor model confidence grants permission to notify, approve a guardian, sign a transaction, or publish private evidence.

With the current `OPENAI_ENABLED: "false"` configuration, a key and consent still produce no model request. The earlier assessment entry point remains rules-only. The real route requires explicit server activation after credits are available, an allowlisted model, current v2 rider consent, consent-filtered authors, appropriate automated coverage, and both budget reservations. External notification delivery remains a separate disabled setting. No activation or paid call is recorded by this document.

Before presenting a demonstration as live LLM execution, obtain explicit activation authorization, exercise actual model and tool calls, and measure useful interpretation and failure behavior on held-out scenarios. Record actual successes and failures with their denominators. Clearly distinguish synthetic inputs, mocked API responses, and real execution evidence. Passing contract tests cannot establish language-model quality or a prize's live LLM requirement.
