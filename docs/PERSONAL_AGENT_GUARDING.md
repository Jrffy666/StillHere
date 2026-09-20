# StillHere: personal agents in a voluntary guarding community

Status: implemented, September 20, 2026. The backend delegation protocol and journey interface are deployed; the owner-operated Codex watcher and local STDIO MCP bridge are implemented. The [hosted acceptance receipt](deployment/personal-agent.hosted.validation.json) records 23 passed checks with one real Codex assessment and human-to-agent-to-human handback. The compatible community-program upgrade is finalized on Devnet; [independent chain verification](deployment/personal-agent.chain.validation.json) passed 36 checks covering that journey's nine finalized records, including separate automated-service history, human contribution and a free banner. Broader validation is tracked in [VALIDATION.md](VALIDATION.md).

## Product and delivered interfaces

StillHere lets an assigned volunteer bring their own agent into an approved journey. The volunteer requests a named agent for a limited period; the rider permits participation and processing; the owner's runtime submits bounded assistance proposals. The platform owns permissions, source validation, human handoffs, truthful coverage state, and execution receipts. The rider can distinguish a person from that person's agent and from a runtime that has stopped responding.

The primary deliverable is the authorized tool interface and its runtime. A demonstration is a separate acceptance exercise. See the [HTTP contract](PERSONAL_AGENT_PROTOCOL.md), [CLI and MCP guide](PERSONAL_AGENT_CLIENT.md), and packaged [guarding skill](../integrations/stillhere-guard/SKILL.md). The skill explains usage; it cannot grant access. The local STDIO bridge can connect an already running compatible agent. It does not imply remote ChatGPT Work support or start continuous execution by itself.

A platform-funded model API is not required. Each owner operates their own compatible runtime and account; StillHere does not receive the owner's Codex login or expose that login as a shared inference service. The existing Responses adapter remains an optional disabled path. Connecting a personal agent does not establish that a person is awake or that the rider is safe.

## Implemented handoff

1. A rider approves a human guardian through the ordinary journey workflow.
2. That currently assigned, nonsimulated guardian requests a named agent for 5–120 minutes and accepts the `personal-agent-v1` processing notice.
3. The rider approves that exact delegation with the same notice. Refusal leaves it inactive. Natural-language intent alone grants nothing.
4. The guardian downloads a journey-scoped connection file. Reissuing it before runtime acceptance rotates the earlier capability. After acceptance, changing runtimes requires revocation and a new approved delegation.
5. The runtime accepts and enters `connecting`. Only its first valid assessment establishes `active` coverage. The interface shows whose agent it is, its response/connectivity times, and permission expiry.
6. The server validates each proposal, publishes attributed canonical questions, retains eligible unresolved concerns, and may open human recruitment. The rider still approves any replacement guardian.

Either the rider or owning guardian can revoke the delegation. Human resume/check-in, replacement, arrival, cancellation, explicit help, assistance being turned off, expiry, deletion, or runtime unavailability invalidates its capability and outstanding work. The hosted API's older `ai-consent` choice is separate; withdrawing personal-agent permission uses the delegation's revoke action. A new guardian assignment requires fresh delegation and approval.

If a runtime disconnects or a guardian leaves before replacement coverage is ready, the interface must expose the gap. The application retains ordinary human controls and deterministic monitoring; it does not invent a human check-in or claim someone has accepted recruitment.

## Scoped tools and server authority

Participant management uses `POST /api/trips/:tripId/delegation` and an ordinary authenticated account session. The separate capability endpoint is `POST /api/agent/trips/:tripId/delegations/:delegationId/:operation`. Account sessions cannot substitute for its capability, and the capability grants no ordinary participant API access.

| Operation | Allowed behavior |
| --- | --- |
| `status` | Read the configured delegation's nonsecret status |
| `accept` | Confirm runtime connection and receive the initial job |
| `updates` | Retrieve the current minimized job, or null when none is due |
| `heartbeat` | Renew connectivity without proving model progress |
| `assess` | Submit one strict, source-cited assessment for a server-issued job |
| `release` | End this delegation with a bounded reason |

The MCP equivalents are `stillhere_status`, `stillhere_accept`, `stillhere_updates`, `stillhere_heartbeat`, `stillhere_assess`, and `stillhere_release`. Their configured connection chooses the journey; model arguments cannot select another journey, token, arbitrary URL, recipient, or account.

An assessment has at most four categorized findings, a bounded question selection, a Boolean human-relay proposal, and a follow-up delay of 30–300 seconds. It contains no free-form participant message or claim of completed action. Source references must come from the supplied context. New concern findings require recent rider evidence or a retained rider concern; conflicts require distinct message sources. The server checks source age again at execution, renders the question, applies permitted effects, and records a receipt.

Every submission rechecks assignment, consent, lifecycle, delegation expiry, revision, current context, and source freshness. An identical retry for a completed job returns its original receipt only while authority remains valid. A changed or stale replay is rejected; concurrent duplicates cannot repeat effects. A receipt establishes what StillHere executed, not independent proof that a particular model performed inference or that a rider read the message.

Personal-agent tools cannot notify contacts, approve guardians, change human contribution counters, manage accounts, award recognition, sign wallets, transfer funds, confirm arrival, or dispatch emergency services. Explicit help remains a direct platform workflow. Trusted-contact authorization is separate and is not granted by semantic concern.

## Operational limits and availability

| Limit | Implemented behavior |
| --- | --- |
| Delegation | 5–120 minutes, bound to one current guardian assignment |
| Connectivity | Unavailable after 45 seconds without a valid heartbeat |
| Initial or pending response | At most 90 seconds, never beyond delegation expiry |
| Follow-up | A new job after the accepted 30–300 second delay |
| Context | At most 12 eligible messages and eight retained rider concerns |
| Private history | At most 40 receipts per delegation and 12 previous delegation views |
| Watch defaults | 12 model turns or 20 minutes; delegation expiry can stop it sooner |
| Watch configurable ceilings | 60 turns and 120 minutes |
| Model subprocess | At most 60 seconds; stale work is aborted/discarded |
| Watch connectivity | Poll every five seconds; heartbeat every ten seconds during inference |

A heartbeat does not make `connecting` active and cannot extend a pending response deadline. New rider input invalidates the previous job, but replacement work retains the original response deadline. This prevents a busy conversation or healthy polling loop from hiding a stalled model. The frontend also computes expired coverage from its timestamps while waiting for a refreshed server response.

The owner must keep their machine, network, and model allowance available. The client installs no daemon and changes no power settings. MCP connectivity alone is not an event listener. The supplied watch loop provides bounded event processing, not an unlimited promise of attendance. Its turn/time limits are not token, money, or credit guarantees; a CLI turn can involve provider retries.

The watcher uses the verified Codex CLI version described in the [client guide](PERSONAL_AGENT_CLIENT.md), with an isolated assessment subprocess and tested tool restrictions. It never automatically reruns inference after an ambiguous submission. It may retry the identical proposal at most twice, then exposes failure. Console watch events contain state labels and turn counts; single-operation JSON output may contain private authorized context and must not enter shared logs.

## Privacy, consent, and recovery

Guardian request and rider approval each require literal `consent: true` and the exact personal-agent notice. The runtime receives only the current rider's and current owning guardian's eligible messages plus retained rider concerns. Former guardians, applicants, agent/system messages, dedicated account/journey identifiers, contact fields, wallet details, shared Uber links, and exact coordinates are excluded from model context. Source identifiers and timestamps remain for validation. Free-text minimization is heuristic and does not guarantee anonymity; an author can type another person's details.

The connection file contains one revocable journey capability, not a browser session or a model credential. Keep it outside the repository, prompts, screenshots, and shared logs. The Worker stores only its verifier. The model assessment receives minimized context, never the connection file. The owner's `--allow-processing` flag acknowledges external processing but cannot replace missing participant consent.

At most eight unresolved rider concerns remain in working context beyond the recent-message window. Reassurance and handoff do not resolve them; only an explicit rider resolution does. Additional concerns remain in message history with a capacity event rather than evicting earlier unresolved evidence. Categories and source checks constrain output; they do not prove that the interpretation is correct.

Participant responses contain private execution evidence. Directory and applicant projections omit it. Replacing a guardian revokes private access. Deletion clears affected retained data. Backup export omits the private capability and pending-job state; restore closes old journeys and ends previous delegations instead of restarting their runtimes or making an exported capability usable.

## Community recognition and chain records

Automated support is attributed to the named owner's agent. Heartbeats, agent questions, and model responses never increment human check-in counters or earn human contribution points. Existing human contribution and voluntary free-banner rules remain separate.

The community ledger implementation adds versioned `agent_service` events for active service, ended service, unavailable service, and human return. They carry minimal references, timing, and recorded outcomes through the existing attestation workflow. Publication and finality are separate from local execution, and deployment requires its own evidence. Private messages, sources, model opinions, locations, contacts, prompts, and credentials stay off chain. An attestation describes what the platform recorded; it is not proof of a person's character or a passenger's safety.

## Validation and demonstration

The personal-agent backend security suite uses real application routes and synthetic guest identities, with model/network calls and real chain transactions excluded. It covers exact approval, scoped tokens, readiness, source minimization and freshness, replay/concurrent retry, canonical action receipts, response deadlines, revocation, restore, and public projections. Separate client and interface tests cover the runner, MCP boundary, and truthful state labels. These fixture tests establish protocol behavior, not general model quality.

The [hosted watcher acceptance](deployment/personal-agent.hosted.validation.json) separately passed 23 checks using two synthetic accounts on an ordinary journey. Under a two-turn/two-minute limit, one real Codex invocation completed in 8.683 seconds, reporting 12,331 input tokens and 147 output tokens. The server retained a cited concern, posted its canonical route question, and scheduled follow-up. Human return revoked the scoped token; arrival and a free banner completed the flow. Human check-ins stayed at one during agent execution and rose to two only on explicit human return. The receipt records zero hosted Responses API calls and zero external notifications. A subsequent [published-browser run](deployment/personal-agent.browser.validation.json) passed 12 checks with another real Codex turn and actual participant interactions, including the scoped connection download, revocation, arrival and free banner. These bounded scenarios are not a model benchmark or an overnight-availability test. Separate [chain verification](deployment/personal-agent.chain.validation.json) confirmed finality and independently decoded all nine records from the hosted watcher journey; it does not claim that every other journey was independently checked.

Demonstrate useful judgment with synthetic content in an ordinary application journey: an old reassurance, a newer uncertain concern, conflicting accounts, and an instruction embedded in untrusted text. Show the current sources, model-selected question category, actual server receipt, human recruitment, approved human return, and rejection of a late proposal. Record real success/failure counts and timings; distinguish fixture output from actual model execution.

The earlier [manual Codex export/import rehearsal](CODEX_DEMO.md) completed one real assessment and hosted import, recorded in [its evidence](deployment/codex.demo.validation.json). That rider-operated one-shot workflow remains distinct from the newer hosted watcher acceptance above. Additional scenarios, failure rates and sustained availability still need measured evidence.

The StillHere rename preserves existing deployment names, repository paths, package identifiers, contract addresses, and historical receipts. Infrastructure migration is a separate compatibility task.
