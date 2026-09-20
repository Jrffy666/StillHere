# Keep your StillHere demo accounts

Create a separate registered account for each demo participant. A username and password let you return to the same account after signing out or changing browser or device, with its profile and retained history. Ordinary companionship needs no email address, wallet, payment, or participant SOL.

These instructions describe the username/password registration update. Historical guest-account receipts do not verify it; consult [Validation](VALIDATION.md) for deployment and acceptance evidence.

## Create an account and return later

1. Open [StillHere](https://safety-guard-htn2026.klavander56.chatgpt.site) and select **Create account**.
2. Enter your display name, a username and a password. The display name is how other participants recognize you; it is not your sign-in credential.
3. Use 3–32 ASCII letters, numbers, or underscores for the username. Usernames are normalized to lowercase, so `Rider_One` and `rider_one` identify the same username. Leading and trailing whitespace is removed; spaces inside a username and other punctuation are not allowed.
4. Use a password of 12–128 characters and save it with the username in a password manager. Passwords are used exactly as entered, including any spaces.
5. After signing out, select **Sign in** and enter those credentials. Do the same from another browser or device to reopen the same account rather than creating a new one.

For a rider/guardian demonstration on one computer, use two browser profiles or a normal and private window, each signed in to a different registered account. Sessions remain tab-specific. Closing a tab requires signing in again; it does not delete the server account. Duplicating an authenticated tab can copy its session, so a duplicated tab is not a reliable way to create another participant.

Keep each participant's credentials private. Demo accounts are ordinary application accounts and do not grant administrator access.

## Save an existing guest account

If the older guest account is still signed in, open **Account & settings** and select **Save my account**. Choose a username and password using the same limits above. This upgrades the existing account: its ID, display name, profile, contributions and available history remain attached to it. Saving replaces the current session and revokes any other old sessions.

Do this before closing the guest tab or signing out. Creating a new account with the same display name does not claim the old identity or transfer its history. If an unbound guest session has already been lost, its display name alone cannot recover it. An existing linked wallet remains a separate way to sign in to its account.

## Change a password or add a fallback

Open **Account & settings** to change the password using the current password and a new one. A successful change replaces the current session and invalidates all old sessions; other tabs or devices must sign in again with the new password. Save the replacement in your password manager.

The same settings provide optional wallet linking and recovery. Wallet linking authorizes account access through a signed message; it does not require an on-chain payment. A linked wallet supplies an additional sign-in method. Save any issued recovery code and account ID privately, following [Identity and recovery](IDENTITY.md).

Wallet recovery or rotation using a recovery code clears the previous password sign-in. From the recovered session, use **Save my account** to set up password access again. The old username remains reserved to the same account and can be reused for that account.

There is no email password-reset provider. Keep your username and password available, and set up the optional wallet fallback before losing access. A public name or contribution receipt is not proof of account ownership.

## History, privacy and deletion

Signing out ends a session, not the account. Signing in again restores access to data the account is still authorized to read; it does not reverse guardian replacement, journey erasure or account deletion.

Private state for closed ordinary journeys expires after 30 days, and closed simulated demo journeys after 7 days. Using an ordinary **New journey** during a demonstration does not make it a simulated demo journey. Account deletion removes private account access and starts the existing cleanup process. Public chain records and minimal deletion/anti-replay protections can remain. Registration is not a promise of unlimited history retention; see [Data handling](DATA_POLICY.md#retention-and-deletion).

Passwords are not published on chain or included in account data exports. Do not include passwords, recovery codes, session tokens or private agent connection files in screenshots, shared demo notes or source control.

## API entry points

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/register` | Submit `{name, username, password}` to create an account, or save the authenticated guest account. |
| `POST /api/auth/login` | Submit `{username, password}` to sign in to the existing account. |
| `POST /api/auth/password` | Submit `{currentPassword, newPassword}` to change the authenticated account's password and revoke old sessions. |

Successful responses return the account and a replacement session token. Registration returns HTTP 201; sign-in and password change return HTTP 200. The browser applies the returned session. Signing out revokes only the current session.

These account operations do not create chain transactions. Continue with [Public trial](PUBLIC_TRIAL.md) to rehearse the human journey and [Personal trial](PERSONAL_TRIAL.md) for the optional personal-agent handoff.
