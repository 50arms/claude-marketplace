# newms-plugins

Personal Claude Code plugin set: one plugin, `danxbot` — the plan and issue workflows,
every dev rule used while working a card, and the hooks that serve them.

## Install

```bash
claude plugin marketplace add github:newms87/claude-plugins
claude plugin install danxbot@newms-plugins
```

## The dashboard MCP server

The plugin ships the `danx-dashboard` MCP server (`danxbot/scripts/dashboard-mcp-server.mjs`, declared in `plugin.json` `mcpServers`), pointed at the hosted dashboard by default. A repo needs no `.mcp.json`. No board is set: name it per call (the `board` argument) or let `plan_connect` connect the session. Claude Code lists the plugin's tools as `mcp__plugin_danxbot_danx-dashboard__*`.

To use another dashboard, set `DANXBOT_DASHBOARD_URL` (your shell, or the `env` block of a repo's committed `.claude/settings.json` for a per-repo or per-company default). It beats the plugin's `dashboard_url` option (default `https://danxbot.sageus.ai`, asked when the plugin is enabled and kept in your user settings: Claude Code does not read plugin options from a project's settings).

A repo that has its own `.mcp.json` entry named `danx-dashboard` (danxbot, gpt-manager) wins: the plugin's copy then answers the MCP handshake as an empty server, so the session lists exactly one set of dashboard tools, the repo's, as `mcp__danx-dashboard__*`.

## Editing a plugin — MANDATORY version bump

**Every edit to `<plugin>/skills/**/SKILL.md`, `<plugin>/skills/**/*` resources, or any plugin asset MUST bump `<plugin>/.claude-plugin/plugin.json` `version` in the SAME commit.** autoUpdate keys its on-disk cache by version directory (`~/.claude/plugins/cache/newms-plugins/<plugin>/<version>/`); if version stays static, every consumer (host sessions, container workers, dispatched agents) keeps reading the stale cached copy forever — the push went through, the live world did not move. Patch-bump (`0.3.0` → `0.3.1`) is the right size for skill text edits; minor for new skills; major for breaking schema changes. No exemption for "small" edits — small edits are exactly when this gets skipped. Commit message names the bump (`<plugin>: <change> (0.3.0 → 0.3.1)`).

## Design notes

- **No `rules/` directory.** Plugins don't ship prose rule files — rule content lives inside `skills/<name>/SKILL.md` body, with the skill description handling auto-invocation via Claude's skill matcher.
