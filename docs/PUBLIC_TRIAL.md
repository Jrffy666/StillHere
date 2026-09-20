# Invite friends to StillHere

Open [StillHere](https://safety-guard-htn2026.klavander56.chatgpt.site). The site is public; no invitation email, email address, ChatGPT login, wallet, payment, or participant SOL is needed. Select **Create account**, enter your display name, choose a username and password, and save your credentials in a password manager. Returning participants select **Sign in** to reopen the same account.

Usernames contain 3–32 ASCII letters, numbers, or underscores and are case-insensitive. Passwords contain 12–128 characters. Each person should use their own account. For a two-person demo on one computer, use separate browser profiles or a normal and private window. See [Demo accounts](DEMO_ACCOUNTS.md) for registration, returning visits, and saving an existing guest account.

## Try a human journey together

1. One person selects **New journey**, enters fictional places for the trial, and accepts the public-record notice. Leave the optional wallet-signed commitment off. Create the journey.
2. Copy the guardian invitation and share it with a friend.
3. The friend opens the link, creates their own account or signs in, reviews the rider's profile, accepts the community notice and availability commitment, and selects **Apply to guard**.
4. The rider reviews the application and selects **Approve guardian**. The guardian selects **I am here · Check in**. Both people can send messages.
5. With a third person, request a human relay and approve the replacement. The replacement should check in too.
6. The rider selects **I've arrived** and may send a free appreciation banner. Open **Contribution & chain receipts** and the guardian's **My profile** to see recognition. Publication on Solana Devnet is asynchronous: wait for **Chain confirmed** before presenting a record as finalized.

Use ordinary **New journey** creation for contribution records. A simulated sample does not earn official recognition. For detailed award expectations and the honor cabinet, follow [the demonstration guide](DEMO.md).

## Keep your identity

Your username and password reopen the same account after signing out, closing a tab, or changing browser or device. The current session stays in that tab; sign in again when opening a new session. Avoid duplicating an authenticated tab to represent another person, because the copied tab may inherit the same session.

If you are still signed in to an older guest account, open **Account & settings** and select **Save my account** before signing out. Adding a username and password preserves that account's ID, profile and available history. A display name alone cannot recover an old guest account after its session has been lost.

**Account & settings** also offers password changes and optional wallet login/recovery. Changing the password replaces the current session and invalidates other sessions. There is no email password-reset service; keep your credentials in a password manager and consider linking a wallet as an additional sign-in method. Wallet linking is separate from signing a chain commitment. See [Demo accounts](DEMO_ACCOUNTS.md#change-a-password-or-add-a-fallback) for recovery behavior.

Registration does not extend data retention. Closed ordinary journeys retain private state for 30 days; closed simulated demo journeys retain it for 7 days. Account deletion and journey erasure still apply, and public chain records can remain after private data is removed. See [Data handling](DATA_POLICY.md#retention-and-deletion).

Public access does not grant site administration or access to another person's private route and conversation. Profiles, contributions and public chain receipts are visible to community members as described in the public-record notice.

## Optional personal-agent handoff

Human companionship works without a model. To demonstrate a personal agent, follow [Personal trial](PERSONAL_TRIAL.md): the guardian requests a named agent, the rider approves it, and the guardian starts their own Codex watcher. The computer and watcher must remain awake and connected. Publishing the site does not start an agent for visitors; the hosted OpenAI API adapter remains disabled.

## Release evidence and limits

The earlier [public-access check](deployment/public-access.validation.json) made unauthenticated HTTP requests through the published frontend, created two independent guest identities, authenticated both, and deleted both test accounts. It used no site bypass, cookies, operator credential, model call, or blockchain transaction. That receipt describes the historical guest release; it does not validate username/password registration or sign-in. The account instructions above describe the registration update. Check [Validation](VALIDATION.md) for its deployment and acceptance evidence, along with earlier journey, browser and chain checks.

The current trial is intended for a small group. Account requests are rate-limited; follow the retry guidance if a request is rejected. Visitors using the frontend proxy can share a Worker-observed IP. This release does not establish capacity for a large simultaneous audience.

Community publication uses sponsored Devnet funds. This is a companionship demo; external notifications and emergency dispatch are not configured. Do not present an inactive local agent or pending chain record as active coverage or finalized evidence.
