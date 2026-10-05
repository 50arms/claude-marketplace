# claude-plugins Agent Tool Recipe

This repo is the `newms-plugins` Claude Code plugin marketplace
(`github:newms87/claude-plugins`). It ships **markdown only** — skills,
rules, and agent definitions consumed via a marketplace loader. There is no
application code, no database, and no build/test/lint toolchain.

## Database reach

**None.** No compose file, no `DANX_DB_*` credentials, no persistence layer.
Do not look for one.

## Schema discovery

**N/A** — no models, no migrations. The repo's "schema" is its directory
layout instead:

```
<plugin>/                       # one dir per plugin: danxbot
  .claude-plugin/plugin.json    # name + version (the auto-update trigger)
  skills/<skill>/SKILL.md       # skill bodies
  rules/*.md                    # always-on rule files
  agents/*.md                   # subagent definitions
.claude-plugin/marketplace.json # declares every plugin dir (source of truth)
```

## Dev-up command

**None.** `.danxbot/config/config.yml` has `dev: ""` — there is no dev
server or long-running process for this repo.

## Repo-native tooling

- `test` / `lint` / `type_check` are all empty in `config.yml` — nothing to
  run. Do not invent an `npm test` step.
- `package.json` only exposes publish wrappers:
  - `npm run publish:patch|minor|major` → `./scripts/publish.sh <bump>`
- `./scripts/publish.sh <patch|minor|major> [plugin ...]` — bumps the
  `version` field in each edited plugin's `.claude-plugin/plugin.json`,
  commits the bump. Inside an agent worktree it detects
  `DANX_AGENT_WORKTREE` and **skips its push** (finalize owns the push).
- `bash "$DANX_SCRIPTS_DIR/agent-finalize.sh" <agent> <CARD-ID> "<title>" "<bullet>" ...`
  — the unconditional last step before the dispatch-complete call: squashes the
  branch onto `origin/main` and pushes. Prints `PUSHED <sha>` on success.

## The load-bearing rule

The marketplace loader diffs each plugin's `version` field, not commit
shas. **Any edit to a plugin's `skills/`, `rules/`, or `agents/` files must
be followed by a version bump via `publish.sh` for that plugin**, or the
change ships to zero consumers even though it's on GitHub. See
`.danxbot/config/workflow.md` for the full edit → bump → finalize sequence.
