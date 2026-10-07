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

## Every danxbot hook runs through the integrity launcher (DX-3997)

A machine crash once left six cached plugin files the same size but all NUL bytes; every hook then failed silently, including the plan hooks, and the operator's answer to a card went unseen for hours. So every command in `danxbot/hooks/hooks.json` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" [--via stdout|rewake] <script> [args]`:

- `danxbot/integrity-manifest.json` holds the sha256 of every shipped file (tests excluded). `scripts/publish.sh` rewrites it twice, before its injection-budget check and again after the version bump; never hand-edit it, and a new hook script must be added to `hooks.json` through the launcher (a test enforces this).
- Before the hook's script starts the launcher hashes every manifest file. A damaged one is restored from the marketplace clone (`~/.claude/plugins/marketplaces/<marketplace>/<plugin>`) only if the clone's copy matches the manifest hash. Whatever cannot be restored is reported: on stdout for `--via stdout` hooks, as exit 2 plus stderr for `--via rewake` hooks, otherwise on stderr. At most one warning per problem per 10 minutes.
- The launcher imports only node builtins. A zeroed `launch.mjs` cannot repair itself.
- `.gitattributes` marks `danxbot/**` as `-text` so no checkout rewrites line endings under the hashes.

## danxbot also ships a native hooks module (DX-4232)

`danxbot/hooks/hooks.json` has `"modules": ["./register.tsx"]` beside its command hooks. The module (the plan band and the Plan pane, `/danx-plan`) is native function hooks, not a command, so it does NOT run through the integrity launcher; the launcher and `integrity-manifest.json` still cover its files (they are hashed like any shipped file).

- Code: `danxbot/hooks/register.tsx` holds everything that takes `$` (the engine follows `$` only into a function in the same file, and `$.state` atoms must be declared in the file that reads them); `danxbot/hooks/plan/*` is pure drawing, shaping and constants. The `$.state` contract is `danxbot/types/index.d.ts`, named by `plugin.json`'s `"types"`.
- The plan event relay (the loop on the server's `plan_events_wait`) starts from a plan id, never only from a successful full plan load (DX-4233): `startRelay` is the one start, fed by the view, by a `plan_connect` answer's `body.session.plan_id`, and by `watchRelay`, a light read of `GET /api/plans?limit=1` that `session.start` repeats while the read fails (`RELAY_START_RETRY_MS`) and that a turn's end and a sub-agent's start or stop run when no loop does. "Server not connected yet" and "no session is bound" are retried on the backoff and never halt the plan; only an answer that names the tool as unknown does (old server), and a "not connected" answer counts as that only after `OLD_SERVER_AFTER_FAILURES` failed waits in a row over `OLD_SERVER_AFTER_MS`, each with `$.tool.list` showing the plugin server's other tools without `plan_events_wait`, and a fresh plan read saying the session is still signed in and on its plan (the tool list is dynamic: it changes at sign-in, a grant and a key loss). At most one `watchRelay` read is out at a time. Every plan load answers within `LOAD_DEADLINE_MS` or is shown as an error; its refresh keeps the lock for up to `LOAD_ORPHAN_WAIT_MS` more (applying a late answer) so at most one load runs, and a lock held past `LOCK_STALE_MS` (their sum plus `LOCK_TAIL_MS`) is taken over. The pane says `events: relay not running` when the plan is connected and no loop runs.
- Tests: `danxbot/tests/plan-*.test.tsx` run under `claude plugin test danxbot` (each over `['terminal','desktop']`), with the stand-in dashboard in `danxbot/tests/plan-kit.tsx`. `claude plugin validate danxbot` is the loud check: in the desktop app a module that fails to load says nothing.
- `scripts/publish.sh` runs both for any target plugin whose `hooks.json` declares `modules`, before it rewrites or bumps anything, and refuses the publish if either fails. **It needs the `claude` CLI: it is not on PATH in this machine's Git Bash, so set `CLAUDE_BIN` to the executable** (for example the desktop app's `claude-code/<version>/<hash>/claude.exe`) or the publish is refused naming it. `danxbot/tests/plugin-modules.test.mjs` needs it too.

## The danxbot plugin carries no `@thehammer/danx-dashboard-mcp` version (DX-4321)

The version is the npm registry's `latest`: the two session-start entry points (`ensure-dashboard-mcp.sh --prewarm`, `background-work-report.mjs session-start`) resolve it through `danxbot/scripts/lib/dashboard-mcp-package.mjs` and record it in `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/current`, every other hook reads that record with no network request, and a refresh that fails keeps the recorded version and says so in one line (with no record nothing runs and the line says so), so a danxbot publish reaches the next session start with no plugin release and never a version literal here (a test scans for one).

## Publishing is TWO steps, and the second one is not optional

A plugin edit is not shipped until BOTH happen:

1. **Bump + push** — `./scripts/publish.sh <patch|minor|major> <plugin>`. The marketplace loader compares `version` fields, not commit shas; a plain `git push` of plugin source ships nothing to any consumer.
2. **Update this machine's installed records** — `update-claude-plugins` (symlink to `scripts/update-plugins.sh`).

Before any bump, `publish.sh` runs its pre-flights: the frontmatter lint, the hooks-module `claude plugin validate` and `test`, the integrity-manifest rewrite, the injection budget, and the general-audience scan (`scripts/check-general-audience.mjs`), which refuses the publish when a shipped skill, agent, hook, script string or the mantra names the author's own setup (a personal account or alias, the author's domain, a card or plan id, a repo path). It reads the files the manifest hashes, comments in code excluded, and throws on a file type it does not know, so teach it a new type before shipping one.

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
