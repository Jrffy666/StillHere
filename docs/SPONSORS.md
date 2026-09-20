# Sponsor fit and development priorities

## StillHere: current decision, September 20, 2026

The final project name is **StillHere**. Its primary direction is voluntary human companionship with [personal-agent delegation](PERSONAL_AGENT_GUARDING.md). The platform provides authorized tools; each volunteer brings a compatible runtime. Hosted model API activation is outside the primary roadmap.

The [official award page](https://hackthenorth2026.devpost.com/#prizes) was rechecked for these two awards:

| Award | Published requirement | Assessment for StillHere |
| --- | --- | --- |
| Rox: Best AI Agent | An LLM handles messy, incomplete or conflicting information and takes meaningful actions; technical execution and practical utility matter. No Rox API requirement is stated. | A plausible target with one now-validated personal-agent handoff and real executed check-in. A broader demonstration of ambiguous chat, stale observations, source conflicts and recovery remains useful. |
| OpenAI: API Prizes | Meaningful OpenAI API use in the product, plus a concrete Codex contribution to development. | Codex-assisted development is established. A subscription-authenticated Codex runtime calling our MCP does not establish the separate API condition. Do not claim qualification without sponsor confirmation or an implemented, meaningful API use. |

The existing API adapter is disabled. The delegated runtime is now implemented: a [hosted acceptance run](deployment/personal-agent.hosted.validation.json) passed 23 checks with one real owner-authenticated Codex assessment, retained route concern, posted check-in, and human return with immediate capability revocation. This is one bounded workflow; it does not establish broad model quality, uninterrupted overnight service or new chain-event finality. The [StillHere product story](STILLHERE.md) guides the next demonstration. No sponsor was contacted, and no Devpost submission was edited by this review.

Our recommendation is to prioritize the community and Rox demonstration. Preserve the API adapter as optional; do not add nominal API traffic just to display a sponsor logo. If the owner later chooses actual API use, a personal agent could use its owner's API credentials without changing the community model, subject to sponsor interpretation. That is not the current implementation or a requirement for StillHere itself.

## Earlier research and development context

Prepared: September 19, 2026. Event: [Hack the North 2026](https://hackthenorth2026.devpost.com/).

This document translates and consolidates the sponsor research recorded before development. The unchanged Chinese source is [SPONSORS.zh-CN.md](SPONSORS.zh-CN.md). Award descriptions and deadlines below reflect that research, not a new verification of the event website. Confirm the linked official requirements before submitting. Project fit is our assessment; implementing an integration does not guarantee eligibility or an award.

The September 20 [AI scope and award review](AI_DESIGN.md) rechecks Rox and OpenAI requirements, compares them with the current offline implementation, and proposes permissions and evaluation criteria for a future live provider. It does not enable a model or claim award qualification.

## Project positioning

**StillHere is a trip companion network where a human guardian and an AI assistant can hand over responsibility, with blockchain records for commitments and community contributions.**

The rider shares a journey, a guardian accepts the task, and the system tracks explicit check-ins. If the guardian stops responding, a backend timer activates AI assistance. The assistant can ask clarifying questions and request authorized notifications. Rider confirmation closes the task and permits contribution settlement.

Uber already offers [trip-status sharing](https://www.uber.com/us/en/ride/how-it-works/share-status/). The project should therefore demonstrate acknowledged responsibility, visible handovers, delivery status, and contribution records, alongside its trip-sharing interface.

## Recommended awards

The initial priorities are **Solana, Rox, and Cloudflare**. Requirements and reward summaries below were recorded from the [official prize page](https://hackthenorth2026.devpost.com/#prizes).

| Award | Project fit | Evidence to prepare | Recorded reward |
| --- | --- | --- | --- |
| Solana: Best Use of Solana | Very strong if the contract is deployed and exercised | Actual create, accept, and completion transactions; program state; rejection of duplicate settlement | USD 5,000 and Ledger Nano S Plus |
| Rox: Best AI Agent | Very strong if the agent handles uncertainty and takes useful action | Ambiguous rider message, missing or stale information, clarification, and an observable tool result | First: $10,000; second: $2,000 |
| Cloudflare: Best Agent with a Brain | Very strong if Workers runs the guardian backend | Durable trip state, alarm-triggered takeover, tool execution, and failure handling; Pages-only hosting is insufficient | Not specified in the recorded main-page listing |
| OpenAI: API Prizes | Strong with actual API use and a concrete Codex development example | A live model response or tool decision, plus an example of code or tests improved with Codex | Pro subscriptions and merchandise by placement; first-place team interaction/meal also listed |
| Linq: Best Use of Linq | Strong if a messaging integration is implemented | Actual iMessage-based trip sharing, check-ins, or alerts | First: $1,000 and three months of API credits; second: $500 |
| MLH: Best Use of ElevenLabs | Strong if an audio integration is implemented | Actual voice check-ins or spoken assistance that helps the rider | Wireless earbuds |

The [Linq event page](https://linqapp.com/s/events/hack-the-north) provides additional messaging-agent context. Do not describe a planned integration, a provider logo, or a local mock as actual use. The separate Solana Badge Hack award concerns badge hardware and should be evaluated separately.

## Optional directions

| Award | When to consider it | Recorded reward or condition |
| --- | --- | --- |
| Unto Labs: Best Use of Thru | If Thru becomes the implemented chain instead of Solana | Actual Thru SDK use; one Nintendo Switch per team member |
| Huawei: openJiuwen Multi-Agent Challenge | If distinct agents genuinely coordinate monitoring, rider communication, and escalation | Demonstrate handoffs and collaboration; JiuwenSwarm/WorkSwarm were recommended, not mandatory |
| Composio | If the platform actually executes notification or contact tools | Six-month subscription and $10,000 in platform credits; credits are not cash |

See the [official prize descriptions](https://hackthenorth2026.devpost.com/#prizes). Add integrations only when they improve the demonstrated journey. A complete flow on one chain is the priority.

## Development decisions behind the pitch

1. **Use an existing chain.** Solana stores public commitments and contribution outcomes. A new blockchain, bridge, or tradeable token is unnecessary for the first version.
2. **Run monitoring off-chain.** Cloudflare Workers and a Durable Object for each trip maintain state and timers. A blockchain cannot independently know whether a guardian is awake or a rider has arrived.
3. **Trigger takeover from missed check-ins.** An observable timeout is sufficient; sleep detection is outside the first version.
4. **Keep sensitive data off-chain.** Exact locations, contact details, chat text, and Uber links belong in access-controlled application storage.
5. **Make AI actions visible and bounded.** Ask for clarification, summarize the situation, and request authorized notification. A tool attempt, provider acceptance, and human acknowledgment are different outcomes.
6. **Credit actual participation.** Record check-ins and rider completion separately from AI work. Prevent duplicate settlement. Simple reputation does not solve collusion or fake accounts.

Uber sharing links do not grant API access. The [Uber scope documentation](https://developer.uber.com/docs/riders/guides/scopes) identifies `all_trips` as privileged. Until an approved integration is available, demonstrate clearly labeled sample trip data or location sharing explicitly initiated by the rider.

## Judge-facing demonstration

Create a trip → guardian accepts → guardian check-in expires → AI takes over → rider sends an ambiguous concern → assistant clarifies or requests notification → rider confirms arrival → show contribution settlement.

- **Solana:** show real transaction signatures and account state, or state clearly that the chain path is not deployed yet.
- **Rox:** show the context given to the assistant, its uncertainty, and the result of the permitted action.
- **Cloudflare:** show that a backend alarm triggers takeover independently of an open browser.
- **OpenAI:** distinguish real API execution from deterministic fallback and show a concrete Codex development contribution.
- **Messaging/audio sponsors:** show real provider interaction only if implemented and configured.

Use [DEMO.md](DEMO.md) to prepare the walkthrough and the project README for the current implementation and verification status.

## Recorded submission schedule

The following schedule and participation requirements come from the earlier reading of the [official rules](https://hackthenorth2026.devpost.com/rules).

| Milestone | Event time, EDT (UTC−4) | Beijing time (UTC+8) |
| --- | --- | --- |
| Code and design creation window opens | September 19, 2026, 00:00 | September 19, 2026, 12:00 |
| Initial submission, final team and badge IDs, sponsor award selection | **September 19, 2026, 14:00** | **September 20, 2026, 02:00** |
| Final edits close | September 20, 2026, 08:00 | September 20, 2026, 20:00 |

One project may enter several sponsor categories, but award selection has an earlier deadline. The recorded rules limit teams to four approved, in-person participants and one project per team. Follow the event's creation window and source/design submission requirements. These notes do not replace the current official rules.
