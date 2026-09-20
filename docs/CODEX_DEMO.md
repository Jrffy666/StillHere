# Private Codex demo

This manual workflow uses the owner's local Codex CLI and existing ChatGPT login for reviewed, synthetic rider data. It does not activate the OpenAI Responses API. Codex credits and Platform API credit are separate; the runner cannot verify a credit balance or guarantee the cost of a run.

The computer must remain online during inference. This is a private demonstration workflow, not a public inference endpoint or a service backed by shared account credentials. OpenAI documents saved-login automation and structured output in [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), and warns against exposing Codex execution in public or untrusted environments in [authentication guidance](https://learn.chatgpt.com/docs/auth).

## One export, one inference, one import

1. Use your own rider account and a synthetic active journey in AI mode. Review all rider messages and retained concerns. Do not include another person's messages, real contact details, personal locations, credentials, or copied instructions. Confirm the demo notice and export `safety-guard-request.json` using the app. The export expires five minutes after creation.
2. Confirm local readiness without calling a model:

   ```powershell
   npm run codex:demo -- --check
   ```

3. Read the exported JSON yourself. Its `context` is the evidence sent to Codex. The export acknowledgement and the command flag are assertions by the operator; the program cannot prove that free text is synthetic. Run exactly one inference:

   ```powershell
   npm run codex:demo -- --input "$env:USERPROFILE\Downloads\safety-guard-request.json" --output ".dev/codex-demo-result.json" --confirm-synthetic
   ```

4. Review `.dev/codex-demo-result.json`, choose it in the app, inspect the preview, and explicitly apply it before the original five-minute expiry. Files are never uploaded or applied by the runner. The server checks the pending job, owner, current consent, revision, lifecycle, expiry and source references before consuming the result once.
5. For another rehearsal, create a fresh export and choose a new output filename, such as `.dev/codex-demo-result-2.json`. The runner refuses to overwrite any existing output. Remove obsolete exports/results yourself when finished; they remain private local data.

If the journey changes, the rider resumes human assistance, consent is withdrawn, the job expires, or it is cancelled, discard the old result and create a fresh export if still appropriate. Avoid running repeated inference on the same export: every invocation can consume Codex allowance even if the server later rejects its result. The wrapper does not retry inference automatically; Codex may make multiple HTTP requests or retry internally within its one invocation.

## Installed runtime and controls

The runner requires the official npm Codex CLI **0.155.1**, the release inspected for this workflow. It resolves the native executable within that npm installation and checks its reported version. Another version fails closed until reviewed. It checks `codex login status` and requires ChatGPT authentication. The runner code does not inspect, copy, upload or edit authentication files, and it does not change `CODEX_HOME`. The official CLI uses the existing login and may refresh its own credentials normally. Sign in normally with the CLI yourself if needed.

The process environment is an allowlist of ordinary OS, path, locale and existing authentication-location variables. API keys, access-token environment variables, alternate service URLs, Node preload options and unrelated application secrets are omitted. The model is the CLI's permitted default; the result must not be presented as a specific API model.

Each run uses a freshly created temporary directory outside this repository, with only the assessment schema written there. The snapshot goes through UTF-8 stdin, never through a shell command or prompt file. Subprocesses are launched directly with `shell:false` and hidden windows. The temporary directory is removed afterward.

The execution command adds `--ignore-user-config --ignore-rules --ephemeral --sandbox read-only --skip-git-repo-check --output-schema <temporary schema> --json --color never -`, together with `-a never`. Configuration overrides enforce ChatGPT login, read-only sandbox, no approval escalation, no web search, no agents, no app defaults, no image-view tool, no project instruction bytes, no history persistence, and no inherited shell environment.

The runner also disables shell tools; unified execution and TTY requests; shell snapshots; code mode; multi-agent features; apps; browser and computer use; in-app browser/chat/automation; plugins and remote plugins; plugin sharing and bundled dependencies; image generation/viewing; tool suggestions; skill search/install; hooks; sleep/goals; auth elicitation; memories/context management; artifacts; realtime capabilities; MCP apps; and plugin recommendations. Host skill discovery is skipped, and the documented unstable-feature warning switch suppresses that configuration notice. These are explicit settings, not instructions asking the model to avoid tools. The complete arguments are in `configurationArgs()` and `buildExecArgs()` in `scripts/codex-demo.ts`. Supported settings are described in the official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Before inference, a read-only preflight verifies required feature states. An empty `mcp_servers` table does not erase inherited entries, so the configuration inspection lists servers without starting them and verifies that explicit `enabled=false` overrides work. Raw MCP configuration is never printed. Names that cannot be safely expressed as a simple config key fail closed. Execution itself excludes the entire user configuration with `--ignore-user-config`; it must not add back those partial server entries, which lack transport definitions after their original configuration is excluded. Managed/system settings remain part of the isolation limitation described below.

There is one observed CLI quirk: `features list` reports the `unified_exec` backend as enabled despite its explicit disable. `shell_tool=false` does verify. A bounded offline probe of this exact installed CLI and restriction set sent a Responses request to a fake provider bound to `127.0.0.1`, with a dummy per-process API credential, and exposed **zero tools**. The local server returned HTTP 400; there was no connected model or OpenAI request. The provider, synthetic prompt, output schema, authentication selection and explicit probe model (`gpt-5.6-terra`) differed from the production command, which uses the permitted CLI default; saved authentication was untouched. This evidence supports treating that backend flag separately from shell-tool registration.

The observed zero-tool request is not a universal guarantee for every CLI release, managed configuration or model. The runner retains the read-only sandbox and requires reviewed synthetic input. It rejects command execution, file changes, MCP calls, searches and other unexpected tool events, but detecting an event cannot undo an action that already occurred. Network restrictions for local commands do not themselves disable hosted search or connectors, which are separately disabled. [Web-search controls](https://learn.chatgpt.com/docs/web-search)

The pinned CLI represents one intentional restriction as a startup error item: its Code Mode host is disabled, so Code Mode is unavailable and fails closed. The parser accepts only the exact known diagnostic, once before the turn starts, with the expected event fields. It does not enable the host or accept arbitrary error items. Unknown event failures expose bounded event/item types, field names and field-value types for diagnosis; message text, prompts and identifier values are excluded.

## Bounds and validation

| Boundary | Limit |
| --- | --- |
| Export lifetime | Five minutes from server export creation |
| Input file and final UTF-8 prompt | 32,000 bytes each |
| Inference | One fresh invocation; at most 60 seconds, further shortened by export expiry |
| Child shutdown after failure | Wait for process close, bounded at two seconds |
| Each preflight subprocess | 10 seconds |
| Stdout / stderr per subprocess | 64,000 / 16,000 bytes |
| Accepted final response | One schema-valid assessment with valid citations |
| Output file | Exclusive create; no overwrite |

On timeout, excessive output or a forbidden event, the runner requests native-child termination and waits up to two seconds for its close event before cleaning the temporary directory. Windows cleanup retries transient locks five times with a 100 ms incremental delay. Cleanup failure never replaces the original provider error; a fixed cleanup-pending or termination-pending notice identifies any remaining local work. No result is accepted after a provider failure. This cannot guarantee that upstream processing immediately stops or that no credits were consumed. Raw stderr, model failures and rejected text are not exposed in error messages.

The strict semantic schema accepts only the existing assessment fields. Citations are checked against the original snapshot and again at completion time. Server import repeats validation against its saved job and current authority. An assessment can propose a follow-up or human relay; it cannot authorize a notification or change the existing deterministic explicit-help rules.

`execution` records CLI version, claimed authentication mode, completion time and reported input/output/cached-input tokens when available. These fields are ordinary operator-supplied JSON, **not cryptographic proof** of execution, model identity, authenticity or payment. Never use them to grant additional authority. Token counts are not Codex credits; hidden CLI instructions and other context make the Responses adapter's byte-based reservation unsuitable as a Codex spend guarantee. No provider `max_output_tokens` or credit ceiling is configured. The byte and time bounds do not provide one. Missing usage is recorded as `null`.

The runner's `--ephemeral` flag avoids local session rollout files; it does not assert the API's `store:false` behavior or override ChatGPT account data handling. ChatGPT-authenticated Codex follows the applicable ChatGPT workspace settings. [Authentication and data handling](https://learn.chatgpt.com/docs/auth)

## Validation status

The Node tests cover input restrictions, subprocess arguments, authentication/MCP preflight, environment scrubbing, semantic evidence validation, output bounds, timeout/late events, non-overwrite behavior and safe error classification. When the pinned npm CLI is installed, the suite also runs the final restriction arguments against a local fake provider and verifies a Responses request with zero tools. The fake provider returns a controlled HTTP 200 SSE assessment; the actual CLI's JSONL output passes through the real event collector and yields the expected assessment and token counts. That test uses a dummy per-process credential and no real model; otherwise it is explicitly skipped. `--check` passed on the installed Windows CLI.

The final hosted demonstration passed 42 checks and completed one real Codex CLI assessment, followed by a successful import through the existing guarded executor. The invocation took 9,792 ms and reported 12,292 input tokens and 198 output tokens. These are one synthetic case's measurements, not a credit-price estimate or a reliability benchmark. The server still treats imported execution metadata as operator-supplied, unverified provenance. See the [release evidence](deployment/codex.demo.validation.json) and [hosted checks](deployment/codex.hosted.validation.json).

Three earlier attempts exposed an inherited MCP configuration conflict, a Windows cleanup error that masked its original failure, and a pinned CLI startup diagnostic rejected before the turn. The runner now passes the relevant offline regressions; the original second-attempt failure remains unknown. All eight synthetic accounts created across the four attempts were deleted. The hosted Responses API and external notifications remained disabled, and validation submitted no chain transactions.

This manual, rider-operated demonstration validates the analysis protocol. Guardian-owned delegation, direct agent tools and continuous personal-agent participation remain proposed in [PERSONAL_AGENT_GUARDING.md](PERSONAL_AGENT_GUARDING.md).

Failure messages expose only fixed categories: `CLI_ARGUMENT_UNSUPPORTED`, `CLI_CONFIGURATION_INVALID`, `AUTHENTICATION_FAILED`, `MODEL_UNAVAILABLE`, `RATE_OR_CREDIT_LIMIT`, `NETWORK_FAILED`, or a generic process/model failure, each prefixed with `CODEX_DEMO_`. Raw diagnostics, response bodies and credentials are never echoed. Configuration or argument errors require reviewing the runner/CLI version; login and account errors require checking the normal Codex account interface. Do not repeatedly rerun an expired export while diagnosing a failure.

```powershell
npm run test:codex-demo
```

The existing Responses provider remains disabled as an optional legacy path. The primary development direction is personal-agent delegation and platform tools. This workflow does not turn on the API production gate or create any API credential.
