# Offline agent harness

Updated September 20, 2026. The simplified frontend removed the original sample launcher, scenario controls, and agent trace dashboard. Use [DEMO.md](DEMO.md) for the current human guarding demonstration and authenticated participant APIs for developer inspection. This document describes local offline behavior; [VALIDATION.md](VALIDATION.md) separately records test and deployment evidence.

Safety Guard develops its agent workflow with a deterministic mock provider. It does not call an OpenAI model, spend API credits, or demonstrate language-model reasoning. The purpose of this phase is to exercise the application's context, tool permissions, persistence, and failure handling before a live provider is introduced.

The mock provider selects from explicit rules and fixed messages. Its outputs and the product's agent trace must identify this mode. A successful mock workflow is evidence about application orchestration, not evidence of real-world safety, language comprehension, or qualification for an LLM-based award.

## Responsibilities and authority

The journey's `TripRoom` Durable Object remains the owner of private journey state and scheduled monitoring. The harness operates within that journey. It does not receive a general-purpose application session or permission to invoke arbitrary participant actions.

The rider updates choices through authenticated `POST /api/trips/:id/assistance`. Boolean fields are strict; strings, numbers, or unknown properties cannot silently grant consent. Defaults are `automatedCheckIns: true`, `timeoutContact: false`, and `liveAiConsent: false`, with `noticeVersion: "openai-assistance-v1"`. The live-AI choice cannot activate the disabled provider. Community publication and trusted-contact notification consent remain separate choices. Turning automated check-ins off cancels pending agent work; ordinary human controls and deterministic explicit help remain available.

The five tool names define a narrow application boundary:

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

## Abortable provider boundary

[`worker/src/agent-provider.ts`](../worker/src/agent-provider.ts) exports `runProviderDecision`, `createMockProvider`, and `createDisabledOpenAIProvider`. The interface has an ID (`mock` or `openai`), a `live` flag, and `decide({ trigger, steps, signal })`. Inputs are detached JSON snapshots; adapter mutation cannot modify durable state. No executor, fetch callback, credentials, or application binding is passed to the provider.

The boundary accepts exactly one tool proposal validated by `parseAgentToolCall`, or a completion with a nonempty summary of at most 1,200 characters. Extra fields, malformed decisions, and forbidden tools are rejected. Serialized input is limited to 32,000 characters and output to 8,000. Optional limits can be lowered but cannot exceed these ceilings.

An eight-second deadline actively aborts the provider signal. Caller cancellation does the same, including cancellation before invocation. A provider that ignores cancellation cannot apply a late result; late rejection remains handled. Success or failure clears the timer and detaches the external abort listener. An abort signal cannot interrupt arbitrary synchronous JavaScript, so adapters must cooperate with cancellation.

The disabled OpenAI factory always rejects with `LIVE_PROVIDER_DISABLED` before reading a key or making a request. It has no environment/configuration parameter and is not a real API adapter. The generic boundary also refuses providers marked live. The production runner selects the offline mock; neither `OPENAI_API_KEY` nor `liveAiConsent: true` enables a model call.

## Durable execution

[`worker/src/trips.ts`](../worker/src/trips.ts) persists the harness with the journey in the existing SQLite state row. A run records its trigger, revision, status, attempts, retry deadline, lease, tool calls, receipts, completion, and cumulative provider use. Participant responses expose `trip.agent` with `provider: "mock"` and `liveModel: false`.

The execution sequence is:

1. Persist a queued trigger and schedule a Durable Object alarm.
2. Check cumulative budgets, renew the 15-second persisted lease, persist the decision/input-character charge, and request the next decision.
3. Reload state and check revision, ownership, lease, consent, and current context before accepting a decision.
4. Persist the validated tool proposal; require a successful context receipt before any effect.
5. Revalidate current authority, render canonical server text, apply the local effect, and persist it with its receipt in one SQLite write.
6. Continue from receipts until completion, cancellation, or a limit, then build the handoff from server evidence.

A new instance can resume a persisted pending call after eviction. Already recorded local effects are not repeated when resuming the same run. Duplicate trigger IDs are ignored while their runs remain in the retained history. This bounded history is not a permanent global deduplication ledger.

| Limit | Bound |
| --- | --- |
| Provider decision deadline / renewed run lease | 8 seconds / 15 seconds |
| Serialized input / output per decision | 32,000 / 8,000 characters |
| Cumulative provider decisions / input per run | 24 decisions / 120,000 characters |
| Cumulative provider decisions / input per journey | 240 decisions / 1,200,000 characters |
| Retained runs / recorded steps per run | 20 / 8 |
| Execution attempts / maximum run age | 3 / 10 minutes |

Cumulative use is persisted before invocation, including calls that fail or time out. Retry, eviction, and retained-run pruning do not reset journey totals. Character budgets bound serialized input; their relationship to future tokens is an estimate, not measured token accounting or billing. Real token and spend accounting is deferred with the real adapter. Provider retry delays remain bounded by attempt count. Exhausted budgets prevent another provider call while human monitoring and help controls remain usable.

New participant intent invalidates older runs by revision. Ending the journey, resuming human monitoring, or turning automated check-ins off cancels pending runs and clears the follow-up. The executor reloads state after asynchronous provider work and checks ownership and lease, so a delayed decision cannot continue a superseded run. A follow-up can bring the next wake-up earlier; it cannot postpone the baseline deadline.

A change in location freshness, risk, escalation cause, consent, or notification status invalidates stale context before the next effect. The runner cancels that run and can queue a fresh context read when current policy permits it. The contact tool checks for an existing notification immediately before execution; an old proposal cannot bypass the durable outbox by waiting past its rate limit.

## Data freshness and uncertainty

Location updates come from the browser or an explicitly marked simulation. A shared Uber URL is a stored link; the application does not fetch live Uber telemetry. An old location may indicate a closed browser, missing GPS permission, or a network interruption. It does not establish a route deviation or prove danger.

Compare timestamps and sources before treating messages as current evidence. An earlier reassurance does not cancel a later concern. A newer ordinary message also does not automatically clear an urgent state. The deterministic mock can recognize a small set of fixture phrases; it is not a general multilingual classifier or a route-analysis model.

The context contains at most 12 recent messages, with each text limited to 800 characters, and five notification statuses. Dedicated identity, contact-address, wallet, shared-URL, and coordinate fields are omitted. It includes location age and observation time instead of the precise position. The mock considers rider messages from the preceding five minutes, sorts by timestamp rather than array order, ignores future timestamps, and preserves uncertainty when same-time statements conflict. The stale-location threshold is two minutes.

The journey also retains at most eight unresolved rider concerns with source identifiers and observed/received timestamps. These bounded records can outlive the recent-message window. Neutral messages do not create concerns. Once eight are pinned, additional concerns remain in the bounded conversation history with a capacity event; they never silently evict earlier unresolved items. A reassurance, provider summary, or human handoff does not resolve them. The rider resolves one through `POST /api/trips/:id/actions` with `{ "action": "resolve-concern", "requestId": "<concern.id>" }`; the server records a resolution event tied to that source and invalidates the current handoff. This is bounded working context, not an unlimited transcript or permanent history of every concern.

The appropriate response to incomplete evidence is a bounded check-in and, when indicated, a request for human attention. The system must distinguish what it observed, what it did, and what remains unknown.

## Notification evidence

Notifications use the application's durable outbox. Creating a tool result or queuing a notification is not proof of delivery. The existing transport distinguishes queued, failed, provider-accepted, recipient-acknowledged, and simulated results.

Timeout jobs are reauthorized before dispatch and retry. A rider response, resumed human coverage, revoked timeout choice, disabled automation, or revoked contact consent stops an unsent timeout job. Explicit help remains separate: a routine check-in does not downgrade its urgent status. A provider request already dispatched cannot be recalled. Existing journeys receive safe default preferences; legacy real notification jobs without a recorded authorization cause cannot dispatch.

Webhook requests reuse the notification ID as the provider idempotency key. A crash or timeout can leave the application unable to tell whether the provider accepted a request; a retry may occur. Actual duplicate suppression depends on the provider honoring that key. The application does not claim exactly-once external delivery.

Demo notifications are simulated and do not contact a person. In an ordinary journey with external notifications disabled, the application reports that no external message was sent. Failed delivery must remain visible rather than being described as a successful escalation.

## Private records

Action traces describe the trigger, tool request, validation result, and observable outcome. They are operational records, not a model's hidden reasoning. A handoff summary should help the currently authorized human understand the last known state and unresolved work without claiming a rescue or recipient response.

Provider text is a proposal, not evidence. The server renders canonical check-ins and handoffs from context and actual tool receipts instead of publishing arbitrary provider claims about assignment, delivery, or safety. The structured handoff records source references, actor roles, timestamps, freshness, unresolved concerns, actions, and notification states. References are validated against supplied evidence. Canonical summary text can be up to 4,000 characters, separate from the provider completion proposal's 1,200-character bound. Detailed receipts remain the source of truth. A summary is a snapshot and does not refresh itself after a later delivery receipt or location update.

Journey context, concerns, traces, and handoffs are private application data. Dedicated contact and wallet fields are omitted, but a user can still type personal information into chat. Free-text redaction is heuristic, not a guarantee of anonymity or removal of all personal information. Use synthetic data for published evidence. Private messages, interpretations, concerns, handoffs, and exact locations never become chain evidence or community recognition; existing authorized system events remain separate from model opinions.

The public directory and pending-candidate responses exclude private agent records. Replacing a guardian revokes private journey access, including context and handoff. Participant deletion clears retained agent records that could quote that participant; journey erasure removes them with the journey. Backup restoration discards runs, concerns, follow-ups, and handoffs and closes previously active journeys instead of replaying background work.

## Local inspection

Start the application with `npm run dev` from the project root using the existing local setup. No OpenAI key or credits are required. Keep external notifications disabled for the demo. A local build or test does not publish this change to the existing hosted site; deployment status is recorded separately in [VALIDATION.md](VALIDATION.md).

Use synthetic participant sessions and the current human guarding flow in [DEMO.md](DEMO.md). Exercise stale location, old reassurance followed by newer concern, explicit concern resolution, timeout policy consent, human resumption, and assistance being turned off. Inspect actual receipts and server handoff text through the authenticated participant response. Known fixture phrases exercise deterministic rules, not general language comprehension. The removed sample launcher and scenario buttons are not required for these checks.

The journey's **Automated assistance** disclosure exposes reminder and timeout choices, pinned concerns, rider resolution, and the last historical handoff. Other current participants can read it but cannot change the rider's preferences. It states that OpenAI is not connected. No live-AI activation control is shown; the API's future preference does not constitute activation or replace the data-transfer notice needed for a later live release.

For a developer inspection, the authenticated `GET /api/trips/:id` response includes `trip.agent.runs`, per-step results, `followUpAt`, and `handoffSummary`. Use the same participant authentication as the ordinary journey view; do not export tokens or private response bodies as public demo evidence.

To demonstrate actual human access transfer, use an ordinary application journey with synthetic rider and guardian accounts in separate sessions, rather than the demo guardian. Request a replacement, apply from a second guardian session, and have the rider approve it. Confirm that the new guardian sees the private handoff information and that the former guardian loses access. An application-only journey can exercise this without a wallet; a chain-linked journey still requires the existing explicit wallet-signing flow.

## Fixture tests

The fixtures use synthetic messages, timestamps, coordinates, identities, and provider results. Some runtime tests edit persisted deadlines or insert a pending step to reconstruct an interruption without waiting several minutes. These are deterministic orchestration tests, not an LLM benchmark or evidence that the application has monitored actual Uber rides.

| Scenario | Expected application behavior | Test coverage |
| --- | --- | --- |
| Stale GPS and no fresh observation | Ask for a check-in, preserve uncertainty, and avoid declaring danger or sending a contact notification solely because location is old | Mock provider and Durable Object alarm tests |
| Old reassurance, newer route concern, and out-of-order or future timestamps | Use rider-message timestamps; request clarification; keep urgent state active despite reassurance | Mock provider tests, including fixed English, Chinese, Spanish, and French phrases |
| Malicious instructions or malformed tool arguments | Reject unsupported tools, arbitrary recipients, extra fields, and invalid limits; recheck current contact consent before an effect | Strict protocol and durable pending-call tests |
| Eviction, provider failure, or replay after a committed tool | Resume persisted work, retry within the budget, and avoid repeating the recorded local effect | Durable Object restart and retry tests |
| Human resumes, journey ends, or a new participant action supersedes old context | Cancel obsolete work; keep traces private from candidates and former guardians; clear retained context affected by participant deletion | Runtime lifecycle and access tests |
| API key present or notification delivery fails | Make no OpenAI request in this workflow; report failed, simulated, accepted, and acknowledged notification states distinctly | No-network, mock status, and integration-adapter tests |
| Missing successful context or provider prose invents delivery/assignment | Refuse effectful calls without a context receipt; render factual participant claims from canonical server evidence | Context-first execution and canonical handoff tests |
| Chat implies danger or timeout contact consent is absent | Do not authorize contact based on inferred concern; require timeout opt-in plus notification consent | Escalation and rider-choice tests |
| Saved concern falls outside recent chat or reassurance arrives | Retain bounded source/timestamp evidence until explicit rider resolution | Retained concern and handoff tests |
| Provider times out, is aborted, returns oversized data, or exceeds persisted budgets | Abort or reject within limits, discard late results, handle late rejection, and preserve human controls | Provider boundary and durable-budget tests |
| Assistance is turned off, or live-AI consent and a dummy key are present | Cancel obsolete automated work; remain offline regardless of key or live-processing preference | Rider-choice lifecycle and disabled-provider tests |

Run the focused tests from the project root:

```sh
npm --prefix worker test -- test/agent.test.ts test/agent-provider.test.ts test/agent-authority.test.ts test/agent-harness.test.ts test/integrations.test.ts
npm --prefix worker run typecheck
```

Run the broader Worker suite after changes to journey state, privacy, recovery, or relay behavior:

```sh
npm --prefix worker test
```

Refer to [VALIDATION.md](VALIDATION.md) for recorded execution results. The commands above are reproducible checks, not a claim that a newer local change or a hosted deployment has already passed.

## Future live-provider integration

See [AI_DESIGN.md](AI_DESIGN.md) for product scope, award fit, current offline authority controls, and the deferred live evaluation plan. A real API adapter, measured token/spend accounting, evaluations, and activation remain future work. The disabled factory is not that adapter.

The provider seam separates choosing a tool from executing that tool. A future live provider should return proposed actions through the same validated, journey-scoped tool boundary; it must not bypass application authorization or call participant actions directly.

The workflow remains offline even if `OPENAI_API_KEY` is present and `liveAiConsent` is true. The earlier assessment entry point uses its rule fallback, and public configuration reports `provider: "mock"`, `configured: false`, and `liveModel: false`. No environment setting or consent choice in this release enables a live model. Real OpenAI work remains a later implementation, processing choice, and explicit activation after credits are available.

Before presenting the system as a live LLM agent, implement the provider adapter, exercise actual model and tool calls, measure failure behavior on held-out scenarios, and clearly distinguish simulated inputs from actual execution evidence. Mock fixture tests cannot establish language-model quality or compliance with a prize's live LLM requirement.
