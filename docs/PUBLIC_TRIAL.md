# Invite friends to StillHere

Open **https://safety-guard-htn2026.klavander56.chatgpt.site**. The site is public; no invitation email, ChatGPT login, wallet, payment, or participant SOL is needed. Enter your name and select **Enter StillHere**. Each person should use their own browser or device.

## Try a human journey together

1. One person selects **New journey**, enters fictional places for the trial, and accepts the public-record notice. Leave the optional wallet-signed commitment off. Create the journey.
2. Copy the guardian invitation and share it with a friend.
3. The friend opens the link, joins under their own name, reviews the rider's profile, accepts the community notice and availability commitment, and selects **Apply to guard**.
4. The rider reviews the application and selects **Approve guardian**. The guardian selects **I am here · Check in**. Both people can send messages.
5. With a third person, request a human relay and approve the replacement. The replacement should check in too.
6. The rider selects **I've arrived** and may send a free appreciation banner. Open **Contribution & chain receipts** and the guardian's **My profile** to see recognition. Publication on Solana Devnet is asynchronous: wait for **Chain confirmed** before presenting a record as finalized.

Use ordinary **New journey** creation for contribution records. A simulated sample does not earn official recognition. For detailed award expectations and the honor cabinet, follow [the demonstration guide](DEMO.md).

## Keep your identity

Guest credentials are stored in the current tab. Keep it open during the trial; signing out or closing it can lose access. For return visits, use **Wallet & settings** to link a wallet and save the recovery code. Email registration and password accounts are not implemented. Linking a wallet is optional for companionship and separate from signing a chain commitment.

Public access does not grant site administration or access to another person's private route and conversation. Profiles, contributions and public chain receipts are visible to community members as described in the public-record notice.

## Optional personal-agent handoff

Human companionship works without a model. To demonstrate a personal agent, follow [Personal trial](PERSONAL_TRIAL.md): the guardian requests a named agent, the rider approves it, and the guardian starts their own Codex watcher. The computer and watcher must remain awake and connected. Publishing the site does not start an agent for visitors; the hosted OpenAI API adapter remains disabled.

## Release evidence and limits

The [public-access check](deployment/public-access.validation.json) made unauthenticated HTTP requests through the published frontend, created two independent guest identities, authenticated both, and deleted both test accounts. It used no site bypass, cookies, operator credential, model call, or blockchain transaction. Earlier journey, browser and chain checks are linked from [Validation](VALIDATION.md).

The current trial is intended for a small group. Guest creation is limited to 20 requests per minute per Worker-observed IP; visitors using the frontend proxy can share this bucket. A rate-limit response asks visitors to retry after a minute. This release does not establish capacity for a large simultaneous audience.

Community publication uses sponsored Devnet funds. This is a companionship demo; external notifications and emergency dispatch are not configured. Do not present an inactive local agent or pending chain record as active coverage or finalized evidence.
