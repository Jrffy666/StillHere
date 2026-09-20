# StillHere personal-agent implementation contract

Implemented interface contract, September 20, 2026. Deployment evidence is tracked separately.

## Participant management

`POST /api/trips/:tripId/delegation` uses the existing participant bearer session and returns `{trip}` except `connect`, which additionally returns `{connection}`.

- `{action:"request", agentName:string, minutes:integer, consent:true, noticeVersion:"personal-agent-v1"}`: assigned nonsimulated guardian only; 5–120 minutes, bounded agent name. The guardian acknowledges processing of their own eligible messages by their personal runtime.
- `{action:"approve", delegationId:uuid, consent:true, noticeVersion:"personal-agent-v1"}`: rider only, for the exact pending request. The rider permits the named guardian's runtime to process minimized rider context.
- `{action:"connect", delegationId:uuid}`: current guardian only, after approval and before runtime acceptance. Issue/rotate a short-lived journey-only bearer capability and return its one-time connection file. A connected runtime requires revocation and a new delegation to replace it. Store only its verifier; never expose it in a trip response, snapshot export or prompt.
- `{action:"revoke", delegationId:uuid}`: current rider or owning guardian. End delegation and reject pending actions. Existing guardian `resume`/`check-in` also ends active/connecting delegated coverage.

Connection file: `{version:1,kind:"stillhere-agent-connection",origin:string,tripId:uuid,delegationId:uuid,token:string,expiresAt:number}`. `origin` is the backend API origin, HTTPS except explicit loopback development. No account session or Codex credential is included.

## Capability tools

`POST /api/agent/trips/:tripId/delegations/:delegationId/:operation` authenticates the scoped capability, never an ordinary account session. Every body is strict JSON.

| Operation | Body | Purpose |
| --- | --- | --- |
| `status` | `{}` | Read nonsecret delegation status |
| `accept` | `{}` | Declare runtime connection; receive the first assessment job |
| `updates` | `{}` | Retrieve the current pending job, or `job:null` if no work is due |
| `heartbeat` | `{}` | Renew bounded connectivity, without proving model progress or earning contribution |
| `assess` | `{jobId:uuid,assessment:SemanticAssessment}` | Validate and execute the bounded cited proposal once |
| `release` | `{reason:"stopped"|"model_unavailable"|"limit_reached"}` | End this delegation and expose loss of agent coverage |

Success shape: `{delegation:PersonalAgentView,job:PersonalAgentJob|null,receipt?:PersonalAgentReceipt}`. Errors use `{error:string}` with appropriate HTTP status. Assessment retries for an already consumed job return its original receipt only if the identical assessment matches and authority is still valid; changed/stale input is rejected. No action may execute twice. Clients must not automatically rerun inference after an uncertain assessment submission.

Job: `{id:uuid,revision:integer,createdAt:number,expiresAt:number,context:AgentContext}`. This contains minimized sources, source IDs, timestamps and uncertainty, never bearer credentials or exact location/account fields. The existing semantic schema governs `assessment`. Relay is requested through the proposal's `requestRelay`, not a tool that approves guardians or contacts arbitrary people.

Public participant view (`Trip.personalAgent`, optional): `{id,ownerId,ownerName,agentName,status,createdAt,expiresAt,riderApprovedAt,connectedAt,lastSeenAt,lastProcessedAt,nextResponseDueAt,lastActionAt,endedAt,endReason,connectionIssued,receipts}`. Nullable times are explicitly null. Status is `requested|approved|connecting|active|revoked|expired|unavailable|ended`. Receipts are bounded and contain server-issued IDs/times, action names/outcomes and source-cited interpretations; never credentials. Private job context remains outside the public directory.

## Execution and continuity

The first validated assessment establishes readiness. `accept` alone leaves the state `connecting`; heartbeats alone cannot make it `active`. Connectivity lease: 45 seconds. Initial/pending work response deadline: at most 90 seconds and never later than delegation expiry. Heartbeats cannot postpone pending-work deadlines. A newer rider input invalidates an old job but cannot continually extend a missed response deadline. Follow-up work is due after the accepted bounded assessment delay. Polling should normally use five seconds; heartbeats every ten seconds while inference runs.

Apply source validation at snapshot and action time, recheck current assignment, consent, lifecycle, revision and location freshness, and atomically persist effects plus receipts. Reuse canonical question rendering, retained concerns and authorized relay behavior. The agent cannot trigger contact notifications, change human contribution counters or sign chain operations. Render its messages as the named guardian's personal agent. Normal human controls and deterministic help remain available.

Reject current capability access after revocation, replacement, human return, arrival, cancellation, deletion, expiry or unavailable runtime. A new guardian cycle requires a new delegation. Backup restore must discard capabilities/jobs and stop active delegation. Keep existing wire identifiers, chain programs and disabled OpenAI API configuration compatible.

## Client deliverables

An owner-controlled CLI reads the connection file, exposes status/accept/updates/assess/release and can run a bounded watch loop with isolated local Codex assessment, heartbeats, strict output checks, stale-result rejection, no duplicate inference after ambiguous submission, clean shutdown and hard turn/time limits. The model never receives the connection file or credentials.

A STDIO MCP adapter exposes these same narrow tools to an already-running compatible client. Its configured process reads the connection file; tool arguments never accept credentials or arbitrary destinations. A packaged skill explains authorized handoff and the requirement for a running execution environment. STDIO integration is the first implemented surface; remote hosted Work integration is not implied.
