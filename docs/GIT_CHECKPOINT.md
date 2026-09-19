# Community ledger checkpoint before live AI

Recorded September 20, 2026. Local checkpoint tag: `checkpoint-before-live-ai`.

This checkpoint contains the frontend, Cloudflare Worker, Solana programs and clients, dependency lockfiles, tests, deployment evidence, and the proposed [AI design](AI_DESIGN.md). The community ledger is deployed on Devnet; the frontend release is version 6. AI remains an offline mock. See [validation evidence](deployment/community.ledger.validation.json) for the exact deployed versions and completed checks.

## Repository layout

The project root is the complete application repository. Frontend source files under `web/` are ordinary tracked files, not a submodule or a Git pointer. A clone of this root repository includes their content.

The existing `web/.git` repository is retained locally for the Sites publishing workflow. Its frontend checkpoint is `949b0876b578a8a63f598bf847d1d4ac0c579412`. Run full-project checkpoint commands from the project root; frontend publication continues to use the dedicated repository inside `web/`. Source changes under `web/` are visible in both repositories and must be committed appropriately for each workflow. A fresh clone of the root repository does not recreate that separate Sites repository metadata or its credentials.

## Inspect or review the checkpoint

From the project root:

```sh
git status
git show --stat checkpoint-before-live-ai
git log --oneline --decorate
```

To review the saved version in a separate directory without switching the active working copy:

```sh
git worktree add ../safety-guard-checkpoint-review checkpoint-before-live-ai
```

## Excluded local material

Actual environment variables, API credentials, wallet/deployment keys, local runtime data, dependency installations, and generated builds are excluded. Example configuration files, public program addresses, and public transaction receipts are included. Restore sensitive configuration separately; a code checkout is not a database backup or a deployed-service rollback.

This is a local source checkpoint. Creating it does not itself publish the repository or change the existing website audience.
