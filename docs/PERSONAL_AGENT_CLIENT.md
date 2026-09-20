# StillHere personal agent client

StillHere exposes a journey-scoped tool interface to a volunteer's own agent. The platform does not receive the owner's Codex login or buy model inference on the owner's behalf. This client provides an owner-operated Codex watch loop and a separate STDIO MCP bridge for an already running compatible agent.

## Create the delegation

1. Use two real accounts for the journey: the rider and the assigned volunteer guardian.
2. The guardian requests a named personal agent for a bounded period. The rider approves that exact request and its processing notice.
3. The guardian downloads the connection file from the journey page. It contains one revocable journey capability, not an account session or model credential.
4. Store the file privately outside the repository. Do not paste it into chat, a model prompt, screenshots, source control, or an MCP tool argument. Before a runtime accepts, downloading a replacement rotates the previous capability. After acceptance, revoke and create a new approved delegation to connect another runtime.
5. Start one client for that connection. The UI remains `connecting` until a valid assessment produces a server receipt. A connection or heartbeat alone does not establish working automated coverage.

The `--allow-processing` flag explicitly acknowledges that the approved, minimized rider and owning guardian context may be processed by the owner's chosen agent. Server-side participant consent is checked separately; the flag cannot grant missing consent. Free text can still contain sensitive information after minimization. Use synthetic journeys when rehearsing or demonstrating the product.

## Prerequisites

- Run `npm run setup` in the repository if its dependencies are not installed.
- Node.js 22.13 or newer.
- For `watch`, the verified official npm Codex CLI release **0.155.1**, with an existing owner-controlled ChatGPT login. `npm run codex:demo -- --check` verifies the CLI and capabilities without a model call.
- An awake execution environment, working network, and available model usage. A sleeping laptop or exhausted account cannot continue guarding. The client does not install a daemon or change power settings.

The watch runner rejects unverified Codex versions rather than assuming their capability configuration is equivalent. It does not edit saved authentication, personal config, or MCP configuration. The STDIO bridge itself does not require Codex and never invokes a model.

## Bounded Codex watch

From the repository root in PowerShell:

```powershell
npm run agent -- watch --connection "$env:USERPROFILE\Downloads\stillhere-agent-connection.json" --allow-processing
```

The defaults are **12 model turns and 20 minutes**, whichever ends first; the server delegation expiry can end the run sooner. Override with `--max-turns` (1–60) and `--max-minutes` (1–120). These are execution bounds, not a token, money, or credit guarantee. One CLI turn may involve provider retries.

The runtime polls every five seconds, sends connectivity heartbeats every ten seconds during inference, and obeys jobs expiring within 90 seconds. Codex inference has a maximum 60-second subprocess deadline and receives only minimized context through stdin. The isolated temporary directory contains an output schema, not journey messages or model output. Existing tested tool restrictions disable shell, browser, plugins, MCP tools and other external actions inside this assessment subprocess.

The model returns a structured proposal. The server validates sources and current authority, then decides whether to store a canonical check-in, preserve concerns, request human relay, or schedule follow-up. Only returned server receipts establish execution. An ambiguous submission retries the **same proposal** at most twice; it never starts another model turn to replace an uncertain action. Newer input invalidates stale work.

Console events contain only a state label and turn count. `connected` means transport accepted, while `completed` means a proposal returned a receipt. Neither proves that the rider is safe or that a human has taken over. Press Ctrl+C to stop. The runner attempts a bounded release on shutdown, model failure or an execution limit. If connectivity is lost, server deadlines expose unavailable coverage independently.

## Single operations

```powershell
npm run agent -- status --connection "$env:USERPROFILE\Downloads\stillhere-agent-connection.json" --allow-processing
npm run agent -- release --connection "$env:USERPROFILE\Downloads\stillhere-agent-connection.json" --allow-processing --reason stopped
```

Supported commands are `status`, `accept`, `updates`, `heartbeat`, `assess`, `release`, `watch` and `mcp`. `assess` also requires `--input <private-json-file>` containing exactly `{ "jobId": "<current-job-id>", "assessment": <bounded-proposal> }`. See [the HTTP protocol](PERSONAL_AGENT_PROTOCOL.md) for the assessment contract. Single operations return JSON and can expose authorized journey context in the caller's terminal; do not record it in shared logs.

Production connections are pinned to `https://safety-guard-api-production.2012044zj.workers.dev`. Local development accepts an exact `localhost`, `127.0.0.1` or `[::1]` origin only with `--allow-loopback`. URLs containing credentials, paths, queries or fragments are rejected. Requests never follow redirects. A different production deployment requires an explicit reviewed client origin change.

## STDIO MCP

The bridge exposes exactly six tools:

| Tool | Meaning |
| --- | --- |
| `stillhere_status` | Read the configured delegation |
| `stillhere_accept` | Connect an explicitly authorized runtime |
| `stillhere_updates` | Read the current minimized job, or null |
| `stillhere_heartbeat` | Report connectivity without proving progress |
| `stillhere_assess` | Submit one source-cited proposal and receive its execution receipt |
| `stillhere_release` | End this delegation |

All tools use the same configured journey capability. Arguments cannot select another trip, arbitrary URL, account, token, wallet or notification destination. The bridge does not provide model sampling, shell execution or free-form messaging.

Codex supports STDIO MCP commands through its configuration. Add an entry like the following **after replacing the example absolute paths for your checkout and private connection file**. This guide does not modify configuration automatically. See [official OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

```toml
[mcp_servers.stillhere]
command = "node"
args = [
  "C:/path/to/safety-guard/chain/node_modules/tsx/dist/cli.mjs",
  "C:/path/to/safety-guard/scripts/personal-agent.ts",
  "mcp",
  "--connection", "C:/private/stillhere-agent-connection.json",
  "--allow-processing"
]
```

Use `node` directly for STDIO; package-manager banners can corrupt protocol output. The bridge writes only newline-delimited JSON-RPC to stdout and sanitized errors to stderr. It supports MCP versions `2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25`, with required initialization followed by `notifications/initialized`. Standard request `_meta`, including a progress token, is accepted within a 4 KB metadata limit and discarded locally; metadata never enters a backend action, credential header, model prompt or result. Progress notifications and task augmentation are not advertised. Implementation follows the [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [request schema](https://modelcontextprotocol.io/specification/2025-11-25/schema), and [STDIO transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

The calling agent is responsible for issuing tools and continuing execution. **Connecting MCP does not start a watch loop.** If an agent accepts but stops processing, heartbeats cannot indefinitely postpone a job deadline. The bridge attempts to release an accepted delegation on clean EOF or termination; server expiry handles abrupt termination. Remote ChatGPT Work support is not implied by this local STDIO implementation.

The packaged [StillHere guarding skill](../integrations/stillhere-guard/SKILL.md) describes the handoff workflow. It can be installed in a compatible agent's skills directory separately; it never grants authority by itself.

## Validation and limits

Run `npm run test:personal-agent` for client/runner/MCP boundary tests and `npm run test:codex-demo` for the existing isolated CLI regression suite. These tests use mocked inference and loopback HTTP servers, with no real model calls. The current client suite passes 31 tests, including an actual STDIO process, the official TypeScript MCP SDK 1.30.0 performing initialization, discovery and a tool call with standard metadata, and native Codex 0.155.1 invoking the real bridge. The SDK and native interoperability tests skip only when their respective optional local installations are absent. The separate isolated assessment suite passes 24 tests.

The native MCP regression uses a scripted loopback provider and backend with the installed Codex 0.155.1 executable. It verifies initialization, tool discovery, a Code Mode call to `stillhere_status`, and the returned backend result. This CLI's bundled model configuration uses Code Mode and Responses Lite, so an absent HTTP `tools` array does not indicate absent MCP tools. Only this isolated interoperability fixture enables the Code Mode host; the assessment runner's existing tool restrictions remain unchanged. No saved Codex configuration or authentication is modified. See [MCP validation evidence](deployment/personal-agent.mcp.validation.json). This verifies native protocol and tool execution, not model quality or a complete interactive client session. The bounded `watch` integration has separate hosted real-model evidence.

The model never holds chain signing keys or award authority. Automated service history is separate from human contribution. Human return, revocation, replacement, arrival, cancellation, expiry and runtime unavailability stop capability access on the server. A synthetic hosted delegated-watch run is recorded in [the validation evidence](deployment/personal-agent.hosted.validation.json); that single run does not establish broad model quality, emergency response or continuous availability. Chain finality and independent decoding are reported separately from model and application execution.
