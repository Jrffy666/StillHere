# StillHere Worker

Cloudflare Workers API with one SQLite Durable Object per trip, persisted monitoring alarms, private rider/guardian sessions, and idempotent contribution rewards. It runs locally without a cloud account, wallet, or API keys. See [API.md](API.md) for endpoint schemas, authorization, state transitions, and provider contracts.

## Run locally

Use Node.js 22.13 or later. From this directory:

```sh
npm install
npm run dev
```

The API listens on `http://127.0.0.1:8787`. Local Durable Object data persists under `.wrangler/state`. The repository's root `npm run dev` starts this API together with the web app; do not start a second API process on the same port.

```sh
npm run types
npm run typecheck
npm test
npm run build
```

`build` performs a deployment dry run. The tests run in the Workers runtime and mock optional providers. Root `npm run test:integration` tests the running web proxy; set `GUARD_TEST_ORIGIN=http://127.0.0.1:8787` to test the running Worker directly.

## Optional services

For local secrets, copy `.dev.vars.example` to `.dev.vars` and enter only the services you intend to use. `.dev.vars` is ignored by Git. Non-secret defaults are in `wrangler.jsonc`; regenerate types after changing that configuration.

| Feature | Required settings |
| --- | --- |
| OpenAI assessment | `OPENAI_API_KEY`; optionally change `OPENAI_MODEL`. Without a valid model response, the UI reports the rules fallback. |
| Contact notifications | `NOTIFICATIONS_ENABLED=true`, `NOTIFICATION_WEBHOOK_URL`, and `NOTIFICATION_WEBHOOK_SECRET`; the rider must also provide a contact and opt in. |
| Recipient acknowledgement | Separate `NOTIFICATION_ACK_SECRET` for the provider callback. |
| Spoken agent messages | `ELEVENLABS_API_KEY`; optionally change `ELEVENLABS_VOICE_ID`. |
| Public Solana wallet configuration | `SOLANA_PROGRAM_ID` and public `SOLANA_RPC_URL`. Do not put private RPC credentials in these public settings. |

`GET /api/config` reports which integrations are configured. Demo trips never send contact notifications or award real account points, even when services are configured. Model calls can occur on a demo trip if OpenAI is enabled.

## Deploy

From this directory, authenticate and verify the intended Cloudflare account:

```sh
npx wrangler login
npx wrangler whoami
npm run build
npm run deploy
```

Wrangler creates the declared SQLite Durable Object namespaces through the migration in `wrangler.jsonc`. A Cloudflare API token may be supplied securely through `CLOUDFLARE_API_TOKEN` in CI instead of interactive login. Deployment has not been performed automatically by the local setup.

To enable optional services on the deployed Worker, add only the relevant secrets through interactive prompts:

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put NOTIFICATION_WEBHOOK_URL
npx wrangler secret put NOTIFICATION_WEBHOOK_SECRET
npx wrangler secret put NOTIFICATION_ACK_SECRET
```

Set `NOTIFICATIONS_ENABLED` to `true` in `wrangler.jsonc` only after configuring your owned HTTPS provider, then deploy the configuration again. Leave it `false` for the default demonstration. Configure the web deployment's server-side `GUARD_API_ORIGIN` to the resulting HTTPS Worker origin. If browsers call the Worker directly, add their exact origin to `ALLOWED_ORIGINS` and redeploy.

## Data, monitoring, and notifications

- Sessions use random bearer credentials; only token digests are stored. Sessions expire after 30 days. The prototype has no account recovery or verified human identity.
- Only the rider and assigned guardian can read private route, location, contact, and conversation data. Open lobby entries expose only request metadata. Uber links are stored as links and are never fetched; positions must come from the rider or explicit demo simulation.
- Alarm execution continues without an open browser on a deployed Worker. Local alarms require the local process to remain running. Human timeout triggers automated monitoring; recurring check-ins and stale-location detection continue on server alarms. Two unanswered automated prompts queue one consent-gated escalation.
- Open guard requests expire after 24 hours. Active monitoring expires six hours after it starts. Expiry closes monitoring; **it does not delete stored data**. Private trip records, contacts, session records, and reward ledgers currently have no automatic deletion/retention job. Do not collect real personal data in this prototype until a retention/deletion policy is implemented.
- External delivery uses only the operator-configured HTTPS webhook. The provider receives the contact, rider name, latest location, message, trip ID, and stable notification ID. It must honor the `Idempotency-Key` header. Failed provider attempts retry up to three times; delivery may be uncertain after network failure.
- `sent` means the provider accepted a message. Only the separately authenticated callback can mark `acknowledged`. `simulated` means no contact message was sent. A failed or disabled provider remains visible as a failure; it is never shown as successful delivery.
- Application code does not log bearer tokens, contact details, or coordinates. OpenAI receives the rider message and current risk label, with storage disabled; messages may themselves contain personal information. ElevenLabs receives the selected agent message only when speech is requested.
- Community points are application records. Solana transactions are a separate wallet flow; points are not automatically minted tokens or money. This prototype does not verify that a guardian stayed attentive or prevent colluding accounts from farming points.

The service does not call emergency services or guarantee human response. Production readiness also requires durable login/recovery, contact verification, abuse controls, monitoring, and operational ownership. Detailed implementation limits and tests are documented in [API.md](API.md).

Deployment note: anonymous session creation is limited to 20 requests per minute per server-observed client IP. A cross-zone Cloudflare proxy can give multiple visitors the same upstream IP, so they may share this limit. This is a potential availability limitation; it does not grant access to another user's session. Production deployments should implement trusted proxy identity or an appropriate edge limiter instead of trusting arbitrary forwarded headers. See [Cloudflare's Worker subrequest header behavior](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests).
