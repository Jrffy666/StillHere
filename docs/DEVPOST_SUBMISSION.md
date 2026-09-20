## Inspiration

I traveled for nearly 24 hours to get to Hack the North.

I arrived hoping to find teammates and build something together. But I never found the right team. Almost everyone I met eventually asked the same question:

"Are you solo?"

Every time, my answer was yes.

After the hackathon began, exhaustion and jet lag caught up with me. I decided to walk back to where I was staying and sleep for a few hours. Walking alone late at night, far from home, I wondered:

**Who is watching out for me right now?**

That question became StillHere.

I wanted to build a community where people volunteer their attention to someone else's journey. Someone working from home could accompany a traveler in another time zone. A freelancer could build a history of helping others. A stranger could become the person who checks in and stays to listen.

Companionship should be available regardless of someone's ability to pay. I wanted recognition to grow from participation and gratitude, with no payment or deposit required to receive care.

Then another question emerged: what happens when a willing guardian needs to rest?

Their personal AI agent could help continue that companionship, with the traveler's permission, until a human returns.

That is the double meaning of **StillHere**: a person is here for you, and their agent can help carry that presence forward during an approved break.

I came to the hackathon alone. Being alone became the reason I built StillHere.

## What it does

**StillHere is a free community for accompanying one another's journeys, with personal AI agents that can assist during an explicitly approved break.**

A traveler creates a journey and shares a guardian invitation. A volunteer reviews their profile and applies; the traveler reviews the volunteer's public contribution history before approving them. They can exchange messages, check in, optionally share location, and arrange a relay to another human.

When the guardian needs a break, they request a named personal agent for a limited period. The traveler approves that specific handoff. The guardian then connects their own agent using a temporary authorization restricted to that journey.

The agent can interpret an expressed concern, preserve unresolved issues, propose a focused follow-up question, and request a human relay. The backend validates its evidence and permissions before executing an allowed action. Human return ends the delegation.

The interface distinguishes human presence, agent assistance, and unavailable coverage. A missed check-in does not silently authorize an AI takeover.

After arrival, eligible human guardians receive non-transferable contribution recognition. The traveler can also send a free appreciation banner, displayed on the guardian's appreciation wall and honor cabinet. Banners are optional and add no contribution points.

For ordinary community journeys, minimal guarding history, contributions, appreciation, and separate agent-service events are published to **Solana Devnet**. Participants do not need a wallet or SOL; the platform sponsors publication. Private routes, precise locations, and conversations stay off chain.

The public app is open for people to try. The current agent demonstration uses my own Codex runtime. External SMS and emergency-contact notifications are not enabled; StillHere provides companionship and bounded assistance, not emergency dispatch or a guarantee of physical safety.

## How we built it

I built StillHere as a solo hacker, using Codex as a coding collaborator and as the runtime for the personal-agent demonstration.

The frontend uses **React and TypeScript** for journey creation, guardian applications, conversation, human relays, consent, contribution profiles, and receipt links.

The backend runs on **Cloudflare Workers and Durable Objects**, with persistent journey state and server-side alarms. It checks participation deadlines, enforces access, records actions, and manages asynchronous blockchain publication independently of an open browser tab.

The personal-agent integration has a scoped HTTP interface, a local **MCP bridge**, a guarding Skill, and a bounded Codex watch runner. The runner retrieves approved context, requests a structured assessment, submits it for validation, and stops when its authorization or execution limit ends. StillHere does not receive the volunteer's Codex login credentials. The hosted OpenAI API adapter remains disabled.

The harness checks source references, current consent, journey state, and duplicate submissions. It restricts agent actions and records what the server actually executed. An agent cannot sign transactions, award contributions, approve a replacement guardian, or contact arbitrary people.

For the community ledger, I used **Rust Solana programs and TypeScript clients**. Records are explicitly labeled platform attestations: the application observes an authorized action, and its issuer publishes a minimal record. A separate wallet-signed commitment flow is also available.

The interface distinguishes pending publication from confirmed receipts. Human participation and automated service remain separate throughout the application and ledger.

## Challenges we ran into

The hardest challenge was making a handoff truthful.

A connected process is not necessarily an agent that is responding. A heartbeat is not a completed assessment. A request for a replacement guardian does not mean another person has accepted.

I built separate states for these situations. Agent assistance becomes active only after a validated response. A missed deadline exposes unavailability, and human return invalidates the agent's authority, including work prepared before that return.

Another challenge was designing recognition that supports a volunteer community. Care should remain free, and gratitude should remain voluntary. Human contribution is recorded under bounded rules; extra automated activity cannot manufacture human credit. Public records describe participation without claiming to certify someone's character.

Blockchain also required careful boundaries. Private journey data stays off chain, while minimal contribution and appreciation records can be independently inspected. Publication retries must preserve event order without issuing duplicate recognition.

Finally, testing on another person's computer revealed a practical gap: the agent client still requires the project checkout and dependencies. Making a working integration easy for other people to install is an important next step.

## Accomplishments that we're proud of

I am proud that the deployed product connects the community, personal agent, and blockchain into a working journey.

I verified a complete sequence: create a journey, approve a human guardian, record a check-in, obtain consent for a named agent, process a concern with real Codex inference, return control to the human, revoke the agent's access, report arrival, and send a free banner.

Independent chain verification confirmed all nine records from one complete test journey, including agent start, human return, the guardian's contribution, and appreciation. Agent service received no human contribution points.

The app is now publicly accessible, and a friend and I have also tried the human journey together. These are bounded demonstrations and tests; sustained unattended operation remains future validation work.

Most of all, I am proud that receiving companionship requires no payment, staking, wallet, or promised reward. Someone can volunteer simply because they want to be there.

## What we learned

I learned that continuity depends on both technology and consent. A handoff needs an available next participant, clear permission, relevant context, and an honest account of anything still unresolved.

I also learned that personal agents can contribute beyond their owner's immediate productivity. With carefully limited tools, someone can choose to let their agent support another person. The useful capability comes from the surrounding harness as much as the model: permissions, evidence, deadlines, validation, and return of control.

For blockchain, I found a concrete use in recording contributions and appreciation without making financial participation a condition of joining the community. Those records make published activity inspectable, while trust still requires human judgment.

And I learned that a successful local demo is only one stage of building a product. Installation, account recovery, compatibility, and clear failure messages determine whether someone else can use what I built.

## What's next for StillHere

My first priority is making personal-agent participation easier. I want to package the current client as an independent tool with guided setup, environment checks, and a clear list of supported runtimes. Later, remote MCP and browser-based authorization could reduce manual configuration further.

I also want to develop the community: better guardian discovery, availability across time zones, stronger identity and abuse controls, and more accessible account recovery. The long-term vision includes people working from home or freelancing who choose to accompany someone elsewhere in the world.

Further work includes longer-running reliability tests, broader agent compatibility, translation, and consent-based integrations with real communication providers. Each addition must preserve visible availability and the separation between human contribution and automated assistance.

StillHere's purpose will remain the same: make it easier for people to give one another their attention, and help that care continue through an authorized handoff.

When someone is far from home and wonders whether anybody is still there, I want this community to give them a reason to feel less alone.

**StillHere. Be there for someone.**
