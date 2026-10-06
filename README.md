# claude-plugins

Source repo of the `danxbot` Claude Code plugin — the plan and issue workflows,
every dev rule used while working a card, and the hooks that serve them. Testers install it from the
public 50 Arms marketplace (`50arms/claude-marketplace`), a generated copy of this repo's `danxbot/`
(`scripts/publish-marketplace.sh`); edit the plugin here, never there.

## Install

Needs `node` and `bash` on the PATH Claude Code itself starts with, not just on the PATH of a shell you open later (on Windows, Git Bash; on WSL, a login shell that has not loaded nvm has no `node`, and the server then fails to start with `ENOENT`).

In a Claude Code session:

```
/plugin marketplace add 50arms/claude-marketplace
/plugin install danxbot@50arms
```

Or from a shell:

```bash
claude plugin marketplace add 50arms/claude-marketplace
claude plugin install danxbot@50arms
```

After installing:

1. Restart Claude Code. The plugin's `danx-dashboard` server starts with the session; there is no `.mcp.json` to write.
2. Claude Code asks for the **Dashboard URL**. Leave it at its default, `https://danxbot.sageus.ai`, unless you run your own dashboard. If you installed from a shell, it prints `1 userConfig option not yet set`: that is this option, and it works unset because the default applies. It is kept in your user settings and editable in `/config`.
3. Ask Claude to connect a plan (or call `plan_connect`). The first call opens a sign-in approval; approve it on the dashboard and the session is signed in.

## The dashboard MCP server

The plugin ships the `danx-dashboard` MCP server (`danxbot/scripts/dashboard-mcp-server.mjs`, declared in `plugin.json` `mcpServers`). Claude Code names it `plugin:danxbot:danx-dashboard` and lists its tools as `mcp__plugin_danxbot_danx-dashboard__*`. No board is set: name it per call (the `board` argument) or let `plan_connect` connect the session.

To use another dashboard, set `DANXBOT_DASHBOARD_URL` (your shell, or the `env` block of a repo's committed `.claude/settings.json` for a per-repo or per-company default). It beats the `dashboard_url` option above. Claude Code reads plugin options from user and managed settings only, never from a project's, so the `env` block is the per-repo route.

This is the session's one dashboard server: a connected repo declares no `danx-dashboard` server of its own, and a repo's own `.mcp.json` entry would run beside it as a second set of tools under another name (`mcp__danx-dashboard__*`) that the plugin's band, hooks and listeners never use.

## Editing a plugin — MANDATORY version bump

**Every edit to `<plugin>/skills/**/SKILL.md`, `<plugin>/skills/**/*` resources, or any plugin asset MUST bump `<plugin>/.claude-plugin/plugin.json` `version` in the SAME commit.** autoUpdate keys its on-disk cache by version directory (`~/.claude/plugins/cache/50arms/<plugin>/<version>/`); if version stays static, every consumer (host sessions, container workers, dispatched agents) keeps reading the stale cached copy forever — the push went through, the live world did not move. Patch-bump (`0.3.0` → `0.3.1`) is the right size for skill text edits; minor for new skills; major for breaking schema changes. No exemption for "small" edits — small edits are exactly when this gets skipped. Commit message names the bump (`<plugin>: <change> (0.3.0 → 0.3.1)`).

## Design notes

- **No `rules/` directory.** Plugins don't ship prose rule files — rule content lives inside `skills/<name>/SKILL.md` body, with the skill description handling auto-invocation via Claude's skill matcher.
