# Offline agent harness

Safety Guard develops its agent workflow with a deterministic mock provider. It does not call an OpenAI model, spend API credits, or demonstrate language-model reasoning. The purpose of this phase is to exercise the application's context, tool permissions, persistence, and failure handling before a live provider is introduced.

The mock provider selects from explicit rules and fixed messages. Its outputs and the product's agent trace must identify this mode. A successful mock workflow is evidence about application orchestration, not evidence of real-world safety, language comprehension, or qualification for an LLM-based award.

## Responsibilities and authority

The journey's `TripRoom` Durable Object remains the owner of private journey state and scheduled monitoring. The harness operates within that journey. It does not receive a general-purpose application session or permission to invoke arbitrary participant actions.

The five tool names define a narrow application boundary:

| Tool | Intended responsibility | Authority it does not grant |
| --- | --- | --- |
| `get_journey_context` | Read bounded, relevant context for the current journey, including the freshness of messages and location observations; accepts only `{}` | Read other journeys, wallet secrets, or arbitrary application data |
| `send_check_in` | Add a clearly attributed automated question to the journey; text is limited to 600 characters | Pretend a rider or human guardian has checked in, or earn contribution credit |
| `schedule_follow_up` | Arrange a server-side follow-up 30 to 300 seconds away | Disable baseline monitoring or defer an explicit request for help |
| `request_human_relay` | Open recruitment for a replacement human guardian; reason is limited to 300 characters | Select or approve a guardian, grant a candidate private access, or sign a handoff |
| `notify_trusted_contact` | Request a notification through the existing configured-contact and consent checks; reason is limited to 300 characters | Choose an arbitrary recipient, provider URL, or emergency-service destination |

Rider approval still controls human assignment. Wallet signatures still control chain operations. The harness cannot confirm arrival, complete a journey, mint rewards, sign a transaction, or downgrade an explicit emergency. A replacement candidate receives private journey information only after the normal approval process.

The protocol is defined in [`worker/src/agent.ts`](../worker/src/agent.ts). Unknown tools, additional properties, noninteger delays, and arguments outside the stated limits are rejected. The provider reads context before selecting an action and attempts each tool at most once in a run. The executor remains responsible for validating the current state immediately before any effect; a valid tool schema is not sufficient authorization.

Triggers distinguish human unavailability (`takeover`), a rider message (`rider-message`), an alarm-driven follow-up (`follow-up`), stale location (`stale-location`), and failed notification delivery (`notification-failure`). The mock requests a new relay only for takeover or rider-message triggers. Periodic checks do not reopen a cancelled relay. A notification-failure run reports the failed status instead of starting a second notification-delivery loop.

## Durable execution

[`worker/src/trips.ts`](../worker/src/trips.ts) persists the harness with the journey in the existing SQLite state row. A run records its trigger, journey revision, status, attempt count, retry deadline, lease, tool calls, results, and completion summary. The participant response exposes this as `trip.agent` with `provider: "mock"` and `liveModel: false`.

The execution sequence is:

1. Persist a queued trigger and schedule a Durable Object alarm.
2. Acquire a bounded run lease and request the mock provider's next decision.
3. Persist the proposed call before executing it.
4. Revalidate the tool and current journey state, apply the local effect, and persist that effect together with its result in one SQLite write.
5. Continue from recorded results until completion, cancellation, or a limit is reached.

A new instance can resume a persisted pending call after eviction. Already recorded local effects are not repeated when resuming the same run. Duplicate trigger IDs are ignored while their runs remain in the retained history. This bounded history is not a permanent global deduplication ledger.

The current limits are 20 retained runs per journey, eight recorded steps per run, three execution attempts, a 10-minute run age, a 10-second lease, and a three-second provider-decision deadline. Provider failures schedule retries after five seconds multiplied by the current attempt number. Exhausting the run budget leaves the existing rules-based monitoring active.

New participant intent invalidates older runs by revision. Ending the journey or resuming human monitoring cancels pending runs and clears the harness follow-up. The executor reloads state after asynchronous provider work, so a delayed decision cannot continue a superseded run. A follow-up can bring the next wake-up earlier; it cannot postpone the baseline check-in deadline.

A change in location freshness, recorded risk, consent availability, or notification status also invalidates a stored context before the next action. The runner cancels that run and queues a fresh context read. The contact tool checks for an existing notification immediately before execution; replaying an old proposal cannot bypass the existing outbox by waiting past its rate limit.

## Data freshness and uncertainty

Location updates come from the browser or an explicitly marked simulation. A shared Uber URL is a stored link; the application does not fetch live Uber telemetry. An old location may indicate a closed browser, missing GPS permission, or a network interruption. It does not establish a route deviation or prove danger.

Compare timestamps and sources before treating messages as current evidence. An earlier reassurance does not cancel a later concern. A newer ordinary message also does not automatically clear an urgent state. The deterministic mock can recognize a small set of fixture phrases; it is not a general multilingual classifier or a route-analysis model.

The context contains at most 12 recent messages, with each text limited to 800 characters, and five notification statuses. Dedicated identity, contact-address, wallet, shared-URL, and coordinate fields are omitted. It includes location age and observation time instead of the precise position. The mock considers rider messages from the preceding five minutes, sorts by timestamp rather than array order, ignores future timestamps, and preserves uncertainty when same-time statements conflict. The stale-location threshold is two minutes.

The appropriate response to incomplete evidence is a bounded check-in and, when indicated, a request for human attention. The system must distinguish what it observed, what it did, and what remains unknown.

## Notification evidence

Notifications use the application's durable outbox. Creating a tool result or queuing a notification is not proof of delivery. The existing transport distinguishes queued, failed, provider-accepted, recipient-acknowledged, and simulated results.

Webhook requests reuse the notification ID as the provider idempotency key. A crash or timeout can leave the application unable to tell whether the provider accepted a request; a retry may occur. Actual duplicate suppression depends on the provider honoring that key. The application does not claim exactly-once external delivery.

Demo notifications are simulated and do not contact a person. In an ordinary journey with external notifications disabled, the application reports that no external message was sent. Failed delivery must remain visible rather than being described as a successful escalation.

## Private records

Action traces describe the trigger, tool request, validation result, and observable outcome. They are operational records, not a model's hidden reasoning. A handoff summary should help the currently authorized human understand the last known state and unresolved work without claiming a rescue or recipient response.

The current summary is a fixed-format report of the context snapshot time, recorded risk, location freshness, a bounded quote of the most recent rider message, relay and notification state, and tool outcomes. It is limited to 1,200 characters and is not an LLM-written narrative. Detailed call results remain the source of truth for which actions ran. The summary does not itself refresh after a later provider receipt or a later location update.

Journey context and traces are private application data. Excluding dedicated contact and wallet fields from model context is useful data minimization, but a user can still type personal information into a chat message. Do not claim that freeform context is anonymous or guaranteed to contain no personal information. Use synthetic names, messages, and coordinates for published test evidence.

The public journey directory and pending-candidate responses do not contain the trace. Replacing a guardian revokes their access to the private journey, including its context snapshots and summary. Participant deletion clears retained agent records that could quote that participant; private-journey erasure removes them with the rest of the journey. Backup restoration discards agent runs, follow-ups, and summaries, and closes formerly active journeys rather than replaying old background work.

## Local demo walkthrough

Start the application with `npm run dev` from the project root using the existing local setup. No OpenAI key or credits are required. Keep external notifications disabled for the demo. A local build or test does not publish this change to the existing hosted site; deployment status is recorded separately in [VALIDATION.md](VALIDATION.md).

1. Open **Explore a demo journey** with a synthetic display name. The guardian, location, notifications, and rewards in this path are explicitly simulated.
2. Select **Guardian offline**. Open **Companion activity**, labeled **OFFLINE MOCK**, and expand a run to inspect checks and actual results. **For the next guardian** contains the timestamped handoff summary. A run should record a context read before its check-in and scheduled follow-up. Any relay action remains a simulation in a demo journey.
3. Send `I'm okay`, then send `The route seems wrong and I am not sure`. Inspect the clarification message and timestamped handoff summary. These are known fixture phrases; do not present them as evidence of general language understanding.
4. Select **Stale location**. The response should describe uncertainty and request a fresh update; it should not claim that a stale position proves danger.
5. Select **Alert fails**. Inspect the failed notification and the corresponding status message. The run must not report delivery or create a second notification retry loop.
6. End the demo journey. Monitoring and pending runs stop; the simulated run does not award real points.

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

Run the focused tests from the project root:

```sh
npm --prefix worker test -- test/agent.test.ts test/agent-harness.test.ts test/integrations.test.ts
npm --prefix worker run typecheck
```

Run the broader Worker suite after changes to journey state, privacy, recovery, or relay behavior:

```sh
npm --prefix worker test
```

Refer to [VALIDATION.md](VALIDATION.md) for recorded execution results. The commands above are reproducible checks, not a claim that a newer local change or a hosted deployment has already passed.

## Future live-provider integration

See [AI_DESIGN.md](AI_DESIGN.md) for the proposed award fit, live-provider scope, data notice, escalation authority changes, and evaluation plan. That proposal is not an enabled runtime mode.

The provider seam separates choosing a tool from executing that tool. A future live provider should return proposed actions through the same validated, journey-scoped tool boundary; it must not bypass application authorization or call participant actions directly.

The current workflow remains offline even if `OPENAI_API_KEY` is present. The earlier assessment entry point uses the rule fallback, and public configuration reports `provider: "mock"`, `configured: false`, and `liveModel: false`. No environment setting in this release enables a live model. Live OpenAI work remains an explicit, later implementation and opt-in after credits are available; simply adding a key is insufficient.

Before presenting the system as a live LLM agent, implement the provider adapter, exercise actual model and tool calls, measure failure behavior on held-out scenarios, and clearly distinguish simulated inputs from actual execution evidence. Mock fixture tests cannot establish language-model quality or compliance with a prize's live LLM requirement.
