# Claude Plugins Workflow

A dispatched agent on this board has a worktree that **is** the
claude-plugins repo — full edit / commit / push rights. This file is the
agent's complete guide to shipping a plugin change. It does NOT depend on
the operator's `~/.claude/CLAUDE.md` (dispatched workers never load that).

## The ship flow — edit → bump → finalize

For every code dispatch, in order:

1. **Edit** the plugin source: `<plugin>/skills/<skill>/SKILL.md`,
   `<plugin>/rules/*.md`, `<plugin>/agents/*.md`, etc.

2. **Bump the version** of every plugin you edited:

   ```bash
   ./scripts/publish.sh patch <plugin>      # e.g. ./scripts/publish.sh patch danxbot
   ```

   `publish.sh` rewrites `<plugin>/.claude-plugin/plugin.json`'s `version`
   field (mechanical semver — `patch` | `minor` | `major`) and commits the
   bump together with your source edits. **Inside an agent worktree it does
   NOT push** (it detects `DANX_AGENT_WORKTREE` and skips the push) — the
   finalize step below owns the push to `main`.

3. **Finalize** — the unconditional last action before `danxbot_complete`:

   ```bash
   bash "$DANX_SCRIPTS_DIR/agent-finalize.sh" <AGENT> <CARD-ID> "<title>" "<bullet>" ...
   ```

   This squashes your branch (source edits + version bump) into one commit
   on top of `origin/main` and pushes `HEAD:main`. `PUSHED <sha>` on stdout
   is the proof it landed; capture the sha into `retro.commits[]`.

## CRITICAL: version-bump-or-it's-a-no-op

The marketplace loader compares the `version` field in
`.claude-plugin/plugin.json`, NOT commit shas. A push that does not bump the
version ships **NOTHING** — every consumer keeps its cached version. The
edit looks shipped on GitHub but reaches no one.

**Mechanical pre-`danxbot_complete` check:** did `./scripts/publish.sh
<bump> <plugin>` run for every plugin you edited, and did `agent-finalize.sh`
print `PUSHED <sha>`? If either is missing, the change is unshipped —
period. No "I'll bump later", no "the consumer will pick it up anyway".

## Why publish.sh + finalize, not publish.sh alone

`publish.sh`'s own push is `git push origin HEAD:main`: it ships the branch as-is,
with no squash and no rebase-race loop, so a dispatched agent's bump commit would land
on `main` outside the finalize flow. That is why `publish.sh` skips its push inside a
worktree (`DANX_AGENT_WORKTREE`) and `agent-finalize.sh` (squash, then `HEAD:main` with a
rebase-race loop) does the real ship. Run both, in order.

## No tests / no build

This repo ships markdown. There is no test suite, lint, or build to run —
the version bump + push IS the gate. Do not invent a `npm test` step.
