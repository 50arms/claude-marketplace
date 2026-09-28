# newms-plugins

Personal Claude Code plugin set: one plugin, `danxbot` — the plan and issue workflows,
every dev rule used while working a card, and the hooks that serve them.

## Install

```bash
# Add this marketplace from GitHub — machine-independent, use this by default
claude plugin marketplace add github:newms87/claude-plugins

# Or point at your own local checkout of this repo. There is NO canonical
# location for it — pass the path to wherever YOU cloned it; do not copy a
# path out of any doc.
# claude plugin marketplace add /path/to/your/claude-plugins

claude plugin install danxbot@newms-plugins
```

Or declare in a project's `.claude/settings.json`:

```json
{
  "plugins": ["danxbot@newms-plugins"]
}
```

## Editing a plugin — MANDATORY version bump

**Every edit to `<plugin>/skills/**/SKILL.md`, `<plugin>/skills/**/*` resources, or any plugin asset MUST bump `<plugin>/.claude-plugin/plugin.json` `version` in the SAME commit.** autoUpdate keys its on-disk cache by version directory (`~/.claude/plugins/cache/newms-plugins/<plugin>/<version>/`); if version stays static, every consumer (host sessions, container workers, dispatched agents) keeps reading the stale cached copy forever — the push went through, the live world did not move. Patch-bump (`0.3.0` → `0.3.1`) is the right size for skill text edits; minor for new skills; major for breaking schema changes. No exemption for "small" edits — small edits are exactly when this gets skipped. Commit message names the bump (`<plugin>: <change> (0.3.0 → 0.3.1)`).

## Design notes

- **No `rules/` directory.** Plugins don't ship prose rule files — rule content lives inside `skills/<name>/SKILL.md` body, with the skill description handling auto-invocation via Claude's skill matcher.
