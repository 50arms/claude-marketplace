# claude-plugins

Source of truth for the `50arms` marketplace (`50arms/claude-marketplace`, install `danxbot@50arms`). Its plugins reach every Claude Code session on this machine and danxbot's container workers (through danxbot's catalog).

## The mantra is the one home for every rule it states (PLN-11 R-22)

`danxbot/mantra.md` is the mantra's single hand-maintained text: danxbot seeds the reminder
registry row `mantra` from it, and every agent receives that row's effective text (or the
board's override of it, DX-4144), never a copy:

- the main session: the module's `classic.SessionStart` hook (`danxbot/hooks/register.tsx`, source
  `startup|resume|compact`), ONLY once a plan is connected — DX-3421 (PLN-11 R-12/R-22): an
  unconnected session gets no danxbot text at all, at session start, resume or compaction,
  not even a one-line nudge; the trigger to connect a plan is `danxbot:plan-workflow`'s own
  skill description, not a hook line. Connected, the hook asks danxbot (`danxbot_api` on the session's own server) for the
  EFFECTIVE text of one of four events (`session_start` | `session_resume` |
  `after_compaction` | `sub_agent_start`, `GET /api/reminders/event/:event`) — the mantra
  (plan override, else the session's board override, else the row) followed by that event's
  own short lines, never a hand-typed duplicate of the mantra body;
- every sub-agent, any type or plugin, of a plan-CONNECTED session (DX-3384 final sweep
  widened this from `danxbot:worker-*` only; DX-3421 added the "connected" gate — a sub-agent
  of an unconnected session gets nothing either): the module's `classic.SubagentStart` hook
  (additionalContext), event `sub_agent_start`;
- every dispatched worker: its profile's `{{reminder:mantra}}`, resolved by danxbot per
  dispatch against the card's board (DX-4144: one mantra; the dispatch fork is gone).

`mantra.md` is the git source `resolveReminderSeedItems` derives the `mantra`
registry row's default from at dashboard-seed time — it is NOT a runtime fallback any more
(DX-3421: a registry fetch failure is one line naming the failure and telling the agent
to tell the operator; the hook never re-reads this file). **Nothing else restates a mantra
rule** — no `SKILL.md`, agent body, hook text, `CLAUDE.md`, rule file or profile. A skill may
point at the mantra or add procedure the mantra doesn't state. To change a rule, edit
`mantra.md` and publish; phrase each rule so it holds for every one of those readers. No
prose states how many sub-agents to run (R-23).

## The time stamp, the event text and the restart notice are function hooks (DX-4234)

`danxbot/hooks/register.tsx` hands the model three things, each a hook of the module and none a script. The pure parts are `danxbot/hooks/context/*`; every `$` call stays in `register.tsx`.

- **Time stamp** (`context/stamp.ts`): `prompt.submit` and `tool.call` (every call that is not denied) add `MM/DD/YYYY HH:MM:SS ±HH:MM +Δ` to `context`; the date only on the first stamp or a new local day. The last stamp is `$.state` `lastStamp`. Operator decision PBLM-1915: both on every prompt and after every tool call.
- **Event text** (`context/events.ts`): a session start (`startup`, `resume`, `compact`) and `classic.SubagentStart` add the registry's `GET /api/reminders/event/:event` text, only when `GET /api/plans` says the session is on a plan. A failed fetch is ONE warning line naming the event and the reason; a signed-out or revoked session and a plugin server that never connects are quiet. A session start first polls `$.tool.list()` for the plugin's own `danxbot_api` (up to `STALE_GRACE_MS`; the old standby server never waits), then ONE deadline (`CONTEXT_DEADLINE_MS`, 8 s) covers all the reads of the start or of a sub-agent start together and answers a timeout line when it passes.
- **When a session start is told**: the engine has not bound the session when `classic.SessionStart` runs (desktop/headless startup, resume, fork), so `$.mcp.call` and `$.tool.list` throw there. That hook only records `{sessionId, source, transcriptPath, predecessorId}` in `$.state` `pendingStart`; the next `prompt.submit` or main-loop `tool.call` result (never a sub-agent's) takes it once and adds the event text and restart notice to `context`. `classic.SubagentStart` runs bound and adds its text to `additionalContext`.
- **Restart notice**: a session that is not on a plan (or has no key yet), on `startup`, `resume` or `clear`, calls the danx-dashboard server's `restart_notice` tool (it works before sign-in and runs its own 8 s deadline) and says its `{notice}`. Arguments by source (`restartAsk`): `startup` none (the server scans the project); `resume`, which a desktop fork reports too, `transcript_path` (the server finds the ancestor in the transcript's copied prefix); `clear` `predecessor_id`, the session id the `session.end` hook saw end (`$.state` `endedSession`), and only when that session held a connection record (it was on a plan; any other `/clear` is quiet and asks nothing). A resume missing its transcript path is a warning line, never a project scan. `{notice: null}` is quiet; a `{stopped: {reason, detail, fix}}` answer, an error result, a rejected call or a malformed answer is ONE warning line, never quiet. The server finds the earlier session; the plugin reads no connection record.
- Every dashboard call goes through the session's own server (`$.mcp.call`), never a spawn of the `danx-dashboard-mcp` CLI. `scripts/measure-injection.mjs` measures the stamp by running its pure `stamp`; the event text is the registry's and has no offline text to count.

## The reports are function hooks (DX-4235)

`danxbot/hooks/register.tsx` also keeps the dashboard told what a plan-connected session is doing, so the dashboard can show the session's running work and nudge an idle one. Each report is a hook of the module and none a script. The pure parts are `danxbot/hooks/reports/*`; every `$` call stays in `register.tsx`. Every report goes through the session's own server (`$.mcp.call` of the plugin's `danxbot_api` tool). A report the dashboard does not take is a toast, never swallowed. What each report needs of the plan state the module holds (`$.state` `reports` remembers what was opened):

- Opening something (a sub-agent's row, a shell's row, a liveness re-post) needs the session known to be on a plan.
- Closing what was opened (a sub-agent's finish, a shell's end) is owed because its start was posted, so it goes out even while a plan refresh has failed and the view holds no plan for a moment. It is dropped only once the dashboard says the session is on no plan (or a person revoked its key): the dashboard takes no report from such a session.
- The count is kept true the same way: sent while the session is on a plan, and while the plan state is unknown if a count is on record.
- The ready-cards check runs unless the session is known to be on no plan; its own read asks the dashboard which plan the session is on.

The reports themselves:

- **Activity** (`POST /api/plan-sessions/me/activity`): a sub-agent's start at `classic.SubagentStart`; its end at `turn.complete` with an `agentId` (a clean end or a failed one); a background shell's start at `tool.call` when the call's result names a `backgroundTaskId`; that shell's end at the first `classic.Stop` or `classic.SubagentStop` whose `background_tasks` no longer lists it as running. A running sub-agent's own tool calls re-post it as alive, at most once per 60 s.
- **Background-work count** (`PUT /api/plan-sessions/me/background-work`): the running `shell`, `subagent` and `workflow` entries of `background_tasks`, sent at `classic.Stop` and `classic.SubagentStop` (a sub-agent's stop does not count that sub-agent itself) and again on the sub-agent liveness re-post. The count is cleared at the first bound event after a session start and at a main-session `classic.StopFailure`.
- **Ready-cards check** (DX-4534): at a `classic.Stop` of the plan-connected main session that is not already a stop-hook continuation (`stop_hook_active`), it reads `GET /api/plans/mine`, then `GET /api/issues` for each board of the plan. When ready, unclaimed cards wait, it returns `{block: <reason>}`: up to 5 of them by name and one line saying what to do. A read that fails lets the stop happen; a signed-out session says nothing; any other failure is one toast.

## danxbot's hooks are one native module (DX-4232)

`danxbot/hooks/hooks.json` is `{"modules": ["./register.tsx"], "description": ...}` and has no `hooks` key: every hook the plugin has is a native function hook of that module (the plan band and the Plan pane, `/danx-plan`, the relay, the stamp and event text, the reports). The engine loads a module whole or not at all, and `claude plugin validate` names a module that would fail to load, so no hook runs half-broken beside the others and a publish refuses a module that does not validate (below). `danxbot/scripts/` holds only the MCP server launcher (`dashboard-mcp-server.mjs` and `lib/dashboard-mcp-package.mjs`), the Plan pane's live sub-agent reader (`subagents-live.mjs`) and the screenshot tool (`capture-screenshot.mjs` and its `lib/` helpers); `danxbot/tests/plugin-modules.test.mjs` pins both.

- Code: `danxbot/hooks/register.tsx` holds everything that takes `$` (the engine follows `$` only into a function in the same file, and `$.state` atoms must be declared in the file that reads them); `danxbot/hooks/plan/*` is pure drawing, shaping and constants. The `$.state` contract is `danxbot/types/index.d.ts`, named by `plugin.json`'s `"types"`.
- Every control in the band and the Plan pane that opens a page (the plan, the open-problem count, a problem, a card, the sign-in and permission approval pages) is a link inside a `Markdown` element (`hooks/plan/links.tsx`, `mdLink`), never a `Link` element and never a `Claude_Browser` tool call (DX-4630). A `Link` opens the external browser; a Markdown link with no `onLinkPress` takes the path a conversation link takes, in the app's in-app browser at once (proven live, desktop, CLI 2.1.286). The plugin opens no page itself and keeps no browser tab. A sign-in or permission request is drawn as its link and confirm code the moment it exists.
- The plan event relay (the loop on the server's `plan_events_wait`) starts from a plan id, never only from a successful full plan load (DX-4233): `startRelay` is the one start, fed by the view, by a `plan_connect` answer's `body.session.plan_id`, and by `watchRelay`, a light read of `GET /api/plans?limit=1` that `session.start` repeats while the read fails (`RELAY_START_RETRY_MS`) and that a turn's end and a sub-agent's start or stop run when no loop does. At most one `watchRelay` read is out at a time; a failure of the watch is toasted once. The pane says `events: relay not running` when the plan is connected and no loop runs.
- The relay's failures are retries, not halts (DX-4233): "server not connected yet" and "no session is bound" retry on the backoff; only an answer that names the tool as unknown ends the plan's relay (old server). A "not connected" answer counts as that only after `OLD_SERVER_AFTER_FAILURES` failed waits in a row over `OLD_SERVER_AFTER_MS` (the 4th failure), each with `$.tool.list` showing the plugin server's other tools without `plan_events_wait`, and a fresh plan read saying the session is signed in and still on this run's plan (the tool list is dynamic: it changes at sign-in, a grant and a key loss). A session found signed out or on another plan then ends the run as the signed-out answer does.
- Every plan load answers within `LOAD_DEADLINE_MS` or is shown as an error (DX-4233); its refresh keeps the lock for up to `LOAD_ORPHAN_WAIT_MS` more (applying a late answer) so at most one load runs, and a lock held past `LOCK_STALE_MS` (their sum plus `LOCK_TAIL_MS`) is taken over.
- Tests: `danxbot/tests/plan-*.test.tsx` run under `claude plugin test danxbot` (each over `['terminal','desktop']`), with the stand-in dashboard in `danxbot/tests/plan-kit.tsx`. `claude plugin validate danxbot` is the loud check: in the desktop app a module that fails to load says nothing.
- `scripts/publish.sh` runs both for any target plugin whose `hooks.json` declares `modules`, before it bumps anything, and refuses the publish if either fails. **It needs the `claude` CLI: it is not on PATH in this machine's Git Bash, so set `CLAUDE_BIN` to the executable** (for example the desktop app's `claude-code/<version>/<hash>/claude.exe`) or the publish is refused naming it. `danxbot/tests/plugin-modules.test.mjs` needs it too.

## The danxbot plugin carries no `@thehammer/danx-dashboard-mcp` version (DX-4321)

The version is the npm registry's `latest`, recorded in `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/current`. The MCP server launcher (`danxbot/scripts/dashboard-mcp-server.mjs`, through `danxbot/scripts/lib/dashboard-mcp-package.mjs`) is the one thing that refreshes and installs it:

- It starts the recorded version at once. A version not yet installed is installed first, in the launcher's own process with node (no bash, no shell), into `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/<version>/`. Only when nothing is recorded yet does it ask the registry before starting.
- While the server runs, it refreshes the record from the registry's `latest` and installs a newer version in the background, without restarting the running server. A danxbot publish therefore runs from the next session start, with no plugin release.
- A refresh that fails is one line on stderr and keeps the recorded version.
- The Plan pane's live reader (`subagents-live.mjs`) runs the recorded, installed version and never asks the registry.

No plugin file carries a version literal of the package (a test scans for one).

## Publishing is TWO steps, and the second one is not optional

A plugin edit is not shipped until BOTH happen:

1. **Bump + push** — `./scripts/publish.sh <patch|minor|major> <plugin>`. The marketplace loader compares `version` fields, not commit shas; a plain `git push` of plugin source ships nothing to any consumer.
2. **Update this machine's installed records** — `update-claude-plugins` (symlink to `scripts/update-plugins.sh`).

Before any bump, `publish.sh` runs its pre-flights, in this order: the frontmatter lint, the general-audience scan, the hooks-module `claude plugin validate` and `test`, and the injection budget. Any one failing refuses the publish with nothing bumped or pushed. The general-audience scan (`scripts/check-general-audience.mjs`) refuses the publish when a shipped skill, agent, hook, script string or the mantra names the author's own setup (a personal account or alias, the author's domain, a card or plan id, a repo path). It reads every shipped file, as its `listPluginFiles` lists them (what `git add <plugin>/` would commit, minus `tests/` and `node_modules/`), with comments in code excluded, and throws on a file type it does not know, so teach it a new type before shipping one.

Step 2 exists because **installed plugin versions are recorded PER PROJECT** in `~/.claude/plugins/installed_plugins.json`. Pushing a new version makes it *available*; nothing moves a project's record onto it. Claude Code's own auto-update cannot do it here: the desktop app launches its CLI with `DISABLE_AUTOUPDATER=1`, which the docs state disables automatic updates "for both Claude Code and all plugins".

The failure is silent and uneven, which is why it went unnoticed for two months: the `danxbot` project sat on `base` v0.3.15 (June 9) and `danxbot` v0.3.65 while the `platform` project on the same machine ran v0.3.27 and v0.3.113. Every session looked healthy while loading two-month-old skills, rules, and hooks.

## MANDATORY — run `update-claude-plugins` after ANY plugin push

`publish.sh` already calls it automatically after a successful push, so the normal flow needs no extra command. **Run it by hand whenever a plugin's content reached `origin/main` by any other route:**

- a plain `git push` of plugin source (no bump — fix that first, then update)
- a push from another machine, a dispatched worker, or the GitHub web UI
- a `git pull` that brought someone else's plugin bump into this machine's clone
- any time you are unsure whether this machine's records match `origin/main`

It updates **every plugin in every project on this machine** in one command — there is no per-repo invocation. It is idempotent and skips rows that are already current, so running it when nothing changed costs a few seconds and prints "already current". Running it unnecessarily is free; skipping it leaves projects silently stale.

```bash
update-claude-plugins            # sweep every project on this machine
update-claude-plugins --dry-run  # show what would be checked, change nothing
```

Updates apply to the NEXT session — a running session keeps the versions it loaded at launch. That is Claude Code's own model, not a limitation of the script.

A `SessionStart` hook in `~/.claude/settings.json` also runs it asynchronously with a 6h throttle. Treat that as a backstop, not the mechanism: as of 2026-08-13 the hook is wired but has NOT been observed firing.

## Mechanical pre-action check

Before declaring any plugin work done, answer both:

1. Did `./scripts/publish.sh <bump> <plugin>` run and push? No → the edit is unshipped.
2. Did `update-claude-plugins` run after that push (or did `publish.sh` run it for you)? No → this machine is still loading the old version.

"I'll update later" / "the consumer will pick it up" / "it's only a small edit" are the rationalizations both checks exist to block.

Both yes → done. **NEVER test, verify, or file AC or problems about the published version reaching or loading in a new session** (operator, 2026-09-27) — that is the Claude Code harness's job, it works, and it is not ours.
