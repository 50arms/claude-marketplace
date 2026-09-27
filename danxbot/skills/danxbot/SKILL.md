---
name: danxbot
description: 'Networking model, runtime envs, deployment vs local, issue-tracker poller boundary, MCP server consumers of danxbot dispatches.'
---

# Danxbot — How It Works

Danxbot is an autonomous orchestrator. Source repo: `<DANXBOT_REPO>` (sibling of every connected repo on the operator's dev box). It spawns Claude Code CLI subprocesses to do work in a connected repo (the operator's app/library codebases — examples: `gpt-manager`, `platform`), polls issue trackers, exposes an HTTP dispatch API.

This plugin is the single source of truth for every danxbot discipline rule + skill — operator's main session and dispatched workers all read the same body via `danxbot@newms-plugins` (`autoUpdate: true` propagates every edit).

Reading this skill avoids three recurring mistakes:

1. Confusing **repo location** (where source lives) with **runtime location** (where it executes).
2. Treating backend-tracker calls as part of the agent path.
3. Pretending the deployed worker on Machine B and the Laravel app on Machine A share a filesystem.

## TodoWrite Checklist (mandatory on first invoke)

When this skill is invoked, write these as TodoWrite items and tick them off as you read:

1. Confirm whether the work is **local** (this dev box) or **deployed** (production AWS target).
2. Identify which **runtime** owns the action — main session, dispatched agent, or worker.
3. If touching a backend tracker → confirm you are NOT in agent path.
4. If touching MCP servers consumed by dispatched profiles → confirm publish step required.

## Two-Machine Networking Model

| Machine | What runs there |
|---|---|
| **A — Laravel host (e.g. `gpt-manager`)** | The connected app's HTTP server. NO direct filesystem or PID access to the agent host. Sends dispatch requests; receives event/heartbeat callbacks. |
| **B — Danxbot worker host** | The full danxbot worker container, the Claude Code CLI process, the per-dispatch MCP servers (stdio children of the agent), `/tmp/schemas/{id}/`, `/proc`, the connected repo's git checkout, Docker, browser. **Fully equipped local env for itself.** |

Boundary = HTTP only (`POST /api/launch`, plus event callbacks from worker → Laravel). Local-machine artifacts (FS, PIDs, signals, processes) live entirely on Machine B. Do NOT design schemes that require the Laravel host to touch agent-host artifacts directly.

The local dev case collapses A and B onto the same host — but treat them as separate. The boundary is the HTTP call, not the kernel.

## Repo Location ≠ Runtime Location

| Source path | Runtime location |
|---|---|
| `<owner-repo>/<package-source>/` (operator's local checkout of an MCP package) | npm-published name → spawned via `npx` on **Machine B** as stdio child of the dispatched agent. Source-repo path is just where the operator edits + publishes from; it does NOT execute on the connected app's Laravel host. |
| DB catalog `mcp-server` artifacts selected by the dispatch's **profile** | declares which packages the dispatched agent loads. The package itself runs as a stdio child of that agent on Machine B. |
| per-dispatch **clean-room cwd** (materialized from the profile's catalog) | the launch cwd; agent's `.claude/` (rules, skills, `mcp.template.json`) is written here per-dispatch, then `mcp.template.json` is resolved + merged into the per-dispatch `--mcp-config` file |

A file inside `gpt-manager/mcp-server/` does NOT execute on the gpt-manager Laravel host. It's published to npm and consumed by whatever process loads its MCP server — almost always the dispatched agent on Machine B.

## Runtime Envs

Three distinct runtime contexts. Don't confuse them.

| Runtime | Where | Tool surface |
|---|---|---|
| **Main session** | Your shell on the dev host | Normal Edit/Read/Write/Bash. NEVER call a backend-tracker MCP directly. |
| **Dispatched agent** | Inside a Claude Code CLI subprocess on Machine B (or local worker) launched from a per-dispatch **clean-room cwd** | The profile's catalog-materialized `.claude/` (`mcp.template.json` + `agents/*.md` + `rules/*.md`) defines the tool surface. Per-dispatch, isolated. |
| **Worker process** | `node` running the danxbot dist on Machine B; hosts the `/api/launch` HTTP server and receives per-board dispatch push signals from the dashboard's dispatcher loop | Reads the dashboard DB via its internal HTTP client for dispatch picker logic; spawns Claude CLI dispatches via `dispatch()`. |

The dispatched-agent runtime is what the dispatch API hands work to. The worker runtime hosts the dispatch API — never confuse "the worker" with "an agent."

## Local vs Deployed

| Verb | What it does |
|---|---|
| `make launch-worker [TARGET=<target>] [BOARDS=<comma-separated>]` (from danxbot repo) | Starts the ONE machine-level Docker worker container for this dev box (DX-1734 — a single worker dispatches agents across every board the active target declares). `BOARDS=` (plural) is an optional runtime filter; the old singular `BOARD=` and `REPO=<name>` are both retired (DX-1811 / DX-979) and fail loud. |
| `make deploy TARGET=<target> COMMIT=<sha>` (from danxbot repo) | The only deploy path (GitHub Actions was deleted, DX-3230) — always runs locally from a dedicated deploy directory, pinned to the named commit. Full contract: `.claude/rules/production-deploy.md`. |
| `make publish-<pkg>` (e.g. `make publish-danx-dashboard-mcp`) | Publishes an in-tree MCP package to npm. Required before a new dispatch can pick up a source change — `npx` caches by name and never re-checks the registry on its own. **You own these packages — publish freely without asking.** |

"Deploy the X danxbot" ALWAYS means `make deploy TARGET=<x> COMMIT=<sha>` from the danxbot repo. NEVER means `make launch-worker` (that's local). NEVER means deploying the connected repo's own app.

Production IS reachable from the dev shell — proxy / SSH / `docker exec` recipes → the danxbot repo's own `.claude/rules/production-deploy.md` (R-17, moved out of the plugins as repo-operation conduct). Don't claim "I can't reach production from here."

## Per-Repo Configuration

Each connected repo's `<repo>/.danxbot/` layout (`config/`, `.env`, `.env.<target>`, `settings.json`, the board-rooted worktree pool) is documented in `.claude/rules/docker-runtime.md` "Per-repo config layout" and `.claude/rules/settings-file.md` in the danxbot repo — read those instead of a restated table here, since the layout changes independently of this plugin skill.

**Agent lookup — mechanical pre-claim check.** The named-agent roster (`agent_profiles` Postgres table, DX-1225) is **install-global, not per-repo** — a profile is a board-agnostic role a board selects, not a file living under any one connected repo. Before claiming an agent name "does not exist" / "never landed" / "is missing", query the roster itself (dashboard Agents tab, or `mcp__danx-dashboard__` tooling that reads `agent_profiles`) rather than grepping any repo's `.danxbot/`. If nothing resolves, say the lookup could not run — do NOT report "the agent does not exist" off a partial check.

A per-agent **worktree**, by contrast, IS per-repo/per-board (`<repo>/.danxbot/boards/<slug>/worktrees/<agent>/`). Enumerate EVERY connected repo under the danxbot checkout's `repos/` dir to check those: `ls "$DANXBOT_REPO"/repos/*/.danxbot/boards/*/worktrees/`. `$DANXBOT_REPO` is a placeholder you resolve on the machine you are running on — there is no fixed location for it, and hardcoding one from a past session is how this check silently enumerates nothing. Resolve it: if cwd is inside the danxbot checkout, `git rev-parse --show-toplevel`; otherwise locate an existing checkout by remote rather than by assumed path (`find ~ -maxdepth 4 -type d -name .git | while read -r g; do d=$(dirname "$g"); git -C "$d" remote get-url origin 2>/dev/null | grep -q danxbot && echo "$d"; done`). Checking `git worktree list` from the danxbot source repo shows ONLY danxbot's own worktrees, not gpt-manager's or platform's — name which repo's worktrees you checked.

Per-target overlays are layered ONLY at deploy time (`make deploy TARGET=<x>`). Local dev never reads them.

## Issue Tracker — Dashboard DB Is Authoritative

The dashboard Postgres DB is the sole tracker:

```
Dispatched agent  ──MCP tools──>  Dashboard Postgres DB (canonical, sole source of truth)
                                       │
                                       │  dispatcher-loop.ts ticks each board every 60s,
                                       │  reads the dispatchable queue in-process
                                       ▼
                         assignWorkerSlot ──> pushDispatchSignal ──> worker ──> spawnAgent
```

- The dashboard Postgres DB is the authoritative source for all issue state, accessed by agents via `mcp__danx-dashboard__issue_*` MCP tools and by the worker via its internal HTTP client for dispatch picker logic.
- Agents NEVER refer to issues by tracker-native ids. Internal id `<PREFIX>-N` is the only stable handle.

> **Trello sync — auxiliary, dashboard-side, never an agent concern.** The dashboard (NOT the worker, NOT the agent) mirrors each board's issues ⇄ a Trello board in real time: outbound is event-driven — the dashboard subscribes to the `issue:updated` event bus and projects the changed card to Trello immediately; inbound arrives via a Trello webhook on the dashboard. A periodic per-board reconcile sweep is an idempotent belt-and-suspenders backstop, not the sync. Agents do nothing with Trello — no tool, no read, no write — and never need to think about it. (`src/trello/*` + `src/dashboard/server.ts`, DX-876 V1–V8.)

Schema authoritative source: `<DANXBOT_REPO>/src/issues/types.ts` (`IssueV2` + `KNOWN_SCHEMA_MAX`).

Universal workflow: invoke `danxbot:issue-card-workflow` skill.

## Dispatch Loop — Dashboard-Owned, Not a Per-Repo Poller

`src/poller/index.ts` is **retired** (commit `4669e288`) — `src/poller/` today holds only leaf helpers (config/constants/fs-probe/yaml parsing), no tick loop. Dispatch is driven centrally by `src/dashboard/dispatcher-loop.ts`: one tick per board every 60s (`POLLER_TICK_INTERVAL_MS`), which reads the dispatchable queue in-process, resolves free worker capacity via `assignWorkerSlot` (spreads across every alive worker serving that board), and pushes a thin signal (`pushDispatchSignal`) to the chosen worker's `callback_url` — the worker then pulls the full dispatch detail and spawns the Claude Code CLI.

The same per-board tick also picks the single eligible Review card for auto-triage, and spawns one fresh issue per `retro.action_item_ids[]` string on terminal save. Full triage-eligibility rules (which statuses are auto-triaged vs operator-directed only) → `danxbot:issue-card-workflow` skill, `references/lifecycle-states.md` § "Triage Lifecycle" — this file does not restate that table.

Agents write card state via `mcp__danx-dashboard__issue_*` tools only. Trello mirroring is the dashboard's job, not the dispatch loop's (see the Trello sync note above).

## Pre-dispatch worktree git (worker-owned, DX-1154 / DX-1156)

The work dispatch is **zero-prep** — the task body is `Work card <id>: <title>` alone (DX-1156 retired the `danx-prep` skill, `danxbot_prep_verdict`, the `prep` DispatchKind, and `agentDefaults.prepMode`; DX-3328 retired the `/danx-next <id>` task body in favor of this one). The worker brings the agent's worktree to `origin/main` deterministically BEFORE spawning (`src/dispatch/worktree-ff.ts`); a true conflict escalates to a `worktree-maintenance` dispatch instead. Conflict / dependency detection is the Dependency PRE quality gate (DX-1180). Full contract: `danxbot/.claude/rules/agent-dispatch.md` + CLAUDE.md Core Principle 4.

## External Dispatch API

```
curl -sS -X POST https://<your-danxbot-deployment>/api/launch \
  -H "Authorization: Bearer $DANXBOT_DISPATCH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"board": "<repo>:<slug>", "profile": "system-test", "task": "Reply OK and call danxbot_complete.", "api_token": "'"$DANXBOT_DISPATCH_TOKEN"'"}'
```

- `profile` is required (DX-1715 — the dispatch-identity selector; the retired `workspace` key is rejected 400). Must match a known dispatch profile.
- `board` is the `<repo>:<slug>` scope key (required); the retired top-level `repo` field is gone (DX-1182).
- `api_token` (Bearer) → `DANXBOT_DISPATCH_TOKEN`. Per-deployment, persisted to SSM at `/<ssm_prefix>/shared/DANXBOT_DISPATCH_TOKEN`.
- Worker rejects bodies that include the retired `allow_tools` / `agents` / `schema_*` fields — the profile's catalog defines the tool surface, not the caller.
- Full route table: `/api/launch`, `/api/resume`, `/api/status/:id`, `/api/cancel/:id`, `/api/stop/:id`. See `danxbot/.claude/rules/agent-dispatch.md#external-entry`.

Laravel apps (Machine A) call this endpoint to start an agent on Machine B. That HTTP call IS the boundary. Anything fancier (FS sharing, cross-host kills, `/proc` walks across the boundary) is wrong.

## MCP Server Ownership

Each MCP server consumed by a danxbot dispatch has an owner repo with a `make publish-<x>` target. Schema and other servers may be owned by other repos in the operator's tree. The dispatch profile's catalog `mcp-server` selections declare which packages it loads. For operator-owned packages, publish freely without re-asking permission — generic "ask before publishing" rules do NOT apply to MCP servers the operator owns.

## Common Failure Modes

| Symptom | Likely cause | Pointer |
|---|---|---|
| New MCP tool not available in dispatched agent | Forgot to publish after editing source | `make publish-<pkg>` (e.g. `make publish-danx-dashboard-mcp`), then re-dispatch |
| Dispatch fails with "Timed out after 2000ms waiting for PID file" | WSL → Windows interop stall on host-mode launcher | check the operator's WSL-interop runbook (host-mode only) |
| Editing `mcp-server/` doesn't change agent behavior | Source change ≠ runtime change. Must publish to npm + clear npx cache. | This skill — Repo Location ≠ Runtime Location |
| Confusion about whether Laravel can reach the agent's `/tmp/schemas/{id}/` | It cannot. Boundary is HTTP. Machine B owns local FS. | This skill — Two-Machine Networking Model |

## Cross-References

- `danxbot:issue-card-workflow` skill — universal issue card DB schema + MCP tools
- `danxbot:plan-workflow` skill — the planning workflow for human-driven work on the
  "Plan" feature (goals/rules/caveats/architecture/attached cards): connecting a session,
  hash-guarded writes, operator questions as Task cards with solutions, tables, routes,
  MCP tools, and the production Plans UI
- the danxbot repo's own `.claude/rules/production-deploy.md` — proxy / SSH / `docker exec` recipes for deployed targets, and who may launch/deploy (R-17)
- `danxbot:dispatch-deep` skill — resume protocol, staged_files, multi-block usage dedup, claude-auth diagnostic
- `danxbot:docker-deep` skill — root `.mcp.json` inject, `.env.<target>` overlays, Laravel `.env.{APP_ENV}` trap
- `danxbot:settings-deep` skill — per-repo `settings.json` schema + ownership matrix
- `<DANXBOT_REPO>/CLAUDE.md` — danxbot repo's own dev rules (read when editing danxbot itself)
- `<DANXBOT_REPO>/.claude/rules/agent-dispatch.md` — full dispatch contract
- `<DANXBOT_REPO>/.claude/rules/settings-file.md` — settings.json invariants pointer
