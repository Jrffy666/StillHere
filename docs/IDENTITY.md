# Account identity and recovery

Safety Guard uses an application account ID to keep a guardian's history and contribution ledger consistent across browsers. A Solana wallet can prove access to that account. Wallet ownership does not verify a person's real-world identity.

## User flow

1. Create a guest account to try the application. A guest session lasts up to 30 days. Without a linked wallet or saved recovery code, losing that session means losing access to the account.
2. Open **Your account & privacy** and select **Link wallet**. The wallet signs an account authorization message; this operation does not submit a blockchain transaction or transfer funds.
3. Download the recovery code when it appears. Store it privately together with the account ID. The server keeps only its SHA-256 digest and cannot display the original code again.
4. On another browser, select **Sign in with linked wallet**. A fresh signature opens another session on the same account, preserving earned points and reputation.
5. If the old wallet is unavailable, enter the account ID and recovery code under account recovery, select a new wallet, and sign the new account message. Successful recovery replaces the wallet and recovery code, revokes all previous sessions, and returns one new session.

Wallet rotation from an existing session requires a signature from the new wallet plus either a signature from the old wallet or the current recovery code. The current interface uses the recovery-code path; the API also supports an old-wallet signature. Changing an account wallet does not transfer authority over existing Solana journeys. Each journey retains its original rider and guardian wallet addresses, so those old wallets are still needed to sign its transactions.

Recovery-code replacement and session revocation require a fresh signature from the currently linked wallet. **Revoke other sessions** invalidates all existing sessions and returns one replacement session for the current browser. Signing out revokes only the current session.

## Signed challenge protocol

The browser requests `POST /api/auth/challenge` with an intent and wallet address. The server creates a random nonce, a five-minute expiry, and a canonical UTF-8 message containing:

- Signing origin, intent, wallet address, and application account ID.
- Current wallet and account authorization version.
- Random nonce and issue/expiry timestamps.
- A statement that the signature authorizes an account operation rather than a transaction.

`POST /api/auth/verify` receives the challenge ID and a base64 Ed25519 signature. It verifies the stored message, never a client-supplied replacement message. The challenge is consumed atomically before verification and cannot be replayed, including after an invalid signature or origin mismatch. A failed attempt requires a fresh challenge.

Each wallet registry object serializes ownership reservations. A verified wallet remains associated with one account, including after rotation or deletion. Historical wallet ownership is also registered with governance for complete backup and restoration of anti-replay records. Restored ownership records are checked before a new registry reservation is created. A concurrent identity update that loses its account-version check may leave a reservation owned by the same account; that account can retry. The reservation does not allow login unless the account's current wallet matches it.

Each account serializes identity changes using an authorization version and a synchronous SQL transaction. If a request supplies both a current session and a recovery proof, both must still be valid at commit time. A successful bind, rotation, recovery, recovery-code replacement, or session reset increments the version and revokes all previous sessions. Concurrent changes cannot both commit against the same version.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/session` | Create a guest account and bearer session. |
| `POST /api/auth/challenge` | Request a `bind`, `login`, `rotate`, `recover`, `recovery-code`, or `revoke-sessions` challenge. |
| `POST /api/auth/verify` | Verify the signed challenge and return `{ user, token, recoveryCode? }`. |
| `POST /api/auth/logout` | Revoke the current bearer session. |
| `POST /api/auth/recovery` | Create/replace a guest recovery code. Linked accounts must use a signed challenge. |
| `POST /api/auth/revoke-sessions` | Revoke guest sessions and issue one replacement. Linked accounts must use a signed challenge. |
| `GET /api/account/export` | Download private account records and currently accessible journey data. |
| `POST /api/account/delete` | Erase private account data and begin durable journey cleanup. |

Challenge creation for `recover` also requires `accountId`. Verification accepts `oldSignature` or `recoveryCode` when required by the intent. Recovery codes are single-use for recovery or rotation: successful use replaces the digest and returns a new code.

## Deployment configuration

For staging and production, set `SITE_ORIGIN` to the exact HTTPS frontend origin, with no trailing slash or path. Set `AUTH_DOMAIN` to that URL's host, including a non-default port if present. For example, `SITE_ORIGIN=https://guard.example` pairs with `AUTH_DOMAIN=guard.example`.

Hosted challenges always use that configured frontend origin, even when a server client omits the `Origin` header. A supplied origin must match it exactly; another CORS-allowed origin cannot sign account messages. Invalid or missing hosted signing configuration fails closed. The frontend API proxy forwards the browser's origin for this check.

Development accepts the request's server origin or an exact origin from `ALLOWED_ORIGINS`. This supports the local frontend and direct local API tests. Do not use `APP_ENV=development` for hosted staging or production.

## Storage and restoration

Session tokens have an account UUID and a random 256-bit secret. Only SHA-256 token digests are stored. At most ten sessions remain active per account; older sessions are evicted. Pre-upgrade guest tokens migrate once into the session table, preserving their original expiry. They cannot reappear through the legacy-token fallback after eviction or revocation.

Account backups contain profile fields, the current wallet, the authorization version, journey IDs, and the contribution credit ledger. They exclude session tokens, session digests, recovery digests, and plaintext recovery codes. Restore validates the entire strict schema, unique ledger entries, account ID, and aggregate score totals before writing. Restored accounts receive a newer authorization version with no restored sessions or recovery code. A wallet-linked account can log in after its wallet registry is restored. A guest account without a wallet has no usable sign-in credential after restore.

Restoration cannot overwrite an existing account or reactivate a deleted account. Deletion clears sessions and recovery access, replaces the private profile, and keeps minimal wallet and credit tombstones. The durable deletion journal blocks new wallet login and recovery challenges immediately, including while private cleanup is still pending. Governance deletion records also prevent older backups from restoring deleted accounts into an environment. Public blockchain history remains public.

## Verification

Run `npm --prefix worker test -- test/identity.test.ts` for real Ed25519 tests of binding, login, nonce consumption, origin and expiry checks, concurrent mutations, rotation, recovery, session revocation, migration, strict snapshot validation, and deletion protection. Run `npm --prefix worker run typecheck` to validate the Worker and test types.
