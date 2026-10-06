# claude-plugins

Source of truth for the `newms-plugins` marketplace. Its plugins reach every Claude Code session on this machine and danxbot's container workers (through danxbot's catalog).

## The mantra is the one home for every rule it states (PLN-11 R-22)

`danxbot/mantra.md` is the mantra's single hand-maintained text: danxbot seeds the reminder
registry row `mantra` from it, and every agent receives that row's effective text (or the
board's override of it, DX-4144), never a copy:

- the main session: `danxbot/scripts/event-hook.sh` at `SessionStart` (matcher
  `startup|resume|compact`), ONLY once a plan is connected — DX-3421 (PLN-11 R-12/R-22): an
  unconnected session gets no danxbot text at all, at session start, resume or compaction,
  not even a one-line nudge; the trigger to connect a plan is `danxbot:plan-workflow`'s own
  skill description, not a hook line. Connected, the same script asks danxbot for the
  EFFECTIVE text of one of four events (`session_start` | `session_resume` |
  `after_compaction` | `sub_agent_start`, `GET /api/reminders/event/:event`) — the mantra
  (plan override, else the session's board override, else the row) followed by that event's
  own short lines, never a hand-typed duplicate of the mantra body;
- every sub-agent, any type or plugin, of a plan-CONNECTED session (DX-3384 final sweep
  widened this from `danxbot:worker-*` only; DX-3421 added the "connected" gate — a sub-agent
  of an unconnected session gets nothing either): the same script at `SubagentStart`
  (additionalContext, matcher `.*`), event `sub_agent_start`;
- every dispatched worker: its profile's `{{reminder:mantra}}`, resolved by danxbot per
  dispatch against the card's board (DX-4144: one mantra; the dispatch fork is gone).

`mantra.md` is the git source `resolveReminderSeedItems` derives the `mantra`
registry row's default from at dashboard-seed time — it is NOT a runtime fallback any more
(DX-3421: a registry fetch failure prints one line naming the failure and telling the agent
to tell the operator; the hook never re-reads this file). **Nothing else restates a mantra
rule** — no `SKILL.md`, agent body, hook text, `CLAUDE.md`, rule file or profile. A skill may
point at the mantra or add procedure the mantra doesn't state. To change a rule, edit
`mantra.md` and publish; phrase each rule so it holds for every one of those readers. No
prose states how many sub-agents to run (R-23).

## Hook scripts must never depend on `jq` — it is not installed

Verified 2026-09-05 with a live probe hook: hooks execute under **Git Bash** (`MINGW64_NT`, bash
5.3.15) and `jq` is **absent** from the hook runtime PATH and from PowerShell's PATH. Every
mandate script that piped its text through `jq -n ... additionalContext` therefore emitted
nothing and injected nothing — installed, silent, useless — for as long as it existed. All of
them were converted to plain stdout on 2026-09-05.

- **To INJECT context:** `printf '%s\n' "$MANDATE"` and `exit 0`. Claude Code adds plain-text
  stdout to the model's context for `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`
  and `PostModelSwitch` — no JSON envelope needed.
- **To PARSE the stdin payload:** use `node` (it ships with Claude Code), copying the proven
  idiom already in `danxbot/scripts/inject-time.sh`. Never `jq`.

A hook that fails this way is worse than no hook, because it is trusted: the same absence once
made a deny guard fail OPEN for its entire life, letting through every command it existed to block.

## Every danxbot hook runs through the integrity launcher (DX-3997)

A machine crash once left six cached plugin files the same size but all NUL bytes; every hook then failed silently, including the plan event bridge, and the operator's answer to a card went unseen for hours. So every command in `danxbot/hooks/hooks.json` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" [--via stdout|rewake] <script> [args]`:

- `danxbot/integrity-manifest.json` holds the sha256 of every shipped file (tests excluded). `scripts/publish.sh` rewrites it twice, before its injection-budget check and again after the version bump; never hand-edit it, and a new hook script must be added to `hooks.json` through the launcher (a test enforces this).
- Before the hook's script starts the launcher hashes every manifest file. A damaged one is reported, never repaired in place (DX-4565: danxbot installs from npm, and the marketplace clone of an npm-sourced marketplace holds only `marketplace.json`, so there is no second copy): on stdout for `--via stdout` hooks (SessionStart / UserPromptSubmit, the only events whose plain stdout reaches the model), as exit 2 plus stderr for `--via rewake` hooks, otherwise on stderr. At most one warning per problem per 10 minutes. The warning names the repair, a reinstall (`claude plugin uninstall danxbot@50arms --keep-data`, then `claude plugin install danxbot@50arms`), and `launch.test.mjs` pins that text to `hooks.json`'s fallback lines and `bridge-watchdog.mjs`.
- The launcher imports only node builtins. A zeroed `launch.mjs` cannot repair itself; the two `--via stdout` hooks print a fallback line when it fails to run.
- The bridge restart check lives in `scripts/bridge-watchdog.mjs`, not in `plan-event-bridge.mjs`, so a damaged bridge file can still be detected and reported.
- `.gitattributes` marks `danxbot/**` as `-text` so no checkout rewrites line endings under the hashes.

## danxbot also ships a native hooks module (DX-4232)

`danxbot/hooks/hooks.json` has `"modules": ["./register.tsx"]` beside its command hooks. The module (the plan band and the Plan pane, `/danx-plan`) is native function hooks, not a command, so it does NOT run through the integrity launcher; the launcher and `integrity-manifest.json` still cover its files (they are hashed like any shipped file).

- Code: `danxbot/hooks/register.tsx` holds everything that takes `$` (the engine follows `$` only into a function in the same file, and `$.state` atoms must be declared in the file that reads them); `danxbot/hooks/plan/*` is pure drawing, shaping and constants. The `$.state` contract is `danxbot/types/index.d.ts`, named by `plugin.json`'s `"types"`.
- Tests: `danxbot/tests/plan-*.test.tsx` run under `claude plugin test danxbot` (each over `['terminal','desktop']`), with the stand-in dashboard in `danxbot/tests/plan-kit.tsx`. `claude plugin validate danxbot` is the loud check: in the desktop app a module that fails to load says nothing.
- `scripts/publish.sh` runs both for any target plugin whose `hooks.json` declares `modules`, before it rewrites or bumps anything, and refuses the publish if either fails. **It needs the `claude` CLI: it is not on PATH in this machine's Git Bash, so set `CLAUDE_BIN` to the executable** (for example the desktop app's `claude-code/<version>/<hash>/claude.exe`) or the publish is refused naming it. `danxbot/tests/plugin-modules.test.mjs` needs it too.

## The danxbot plugin carries no `@thehammer/danx-dashboard-mcp` version (DX-4321)

The version is the npm registry's `latest`: the four session-start entry points (`ensure-dashboard-mcp.sh --prewarm`, `event-hook.sh SessionStart`, `background-work-report.mjs session-start`, `plan-event-bridge.mjs start`) resolve it through `danxbot/scripts/lib/dashboard-mcp-package.mjs` and record it in `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/current`, every other hook reads that record with no network request, and a refresh that fails keeps the recorded version and says so in one line (with no record nothing runs and the line says so), so a danxbot publish reaches the next session start with no plugin release and never a version literal here (a test scans for one).

## danxbot ships as the npm package `@50arms/claude-plugin` (DX-4565)

`danxbot/package.json` makes the plugin folder an npm package; the `50arms` marketplace (repo `50arms/claude-marketplace`, its source kept here in `50arms-marketplace/`) lists `danxbot` with an npm source, so a consumer installs with `claude plugin marketplace add 50arms/claude-marketplace` then `claude plugin install danxbot@50arms`. Claude Code takes the installed version from `plugin.json`, npm from `package.json`: they must stay equal (`scripts/audit-package.mjs` checks it).

- Release with `NPM_TOKEN=... ./scripts/publish-npm.sh <patch|minor|major> [--dry-run]` (set `CLAUDE_BIN` as below). It runs the same checks as `publish.sh` plus `scripts/audit-package.mjs` (the tarball equals the integrity manifest's files and both versions agree; the general-audience scan `check-general-audience.mjs` runs first, as in `publish.sh`, and is the only list of banned names), bumps both versions, commits, `npm publish`es, pushes, and verifies this machine runs the new version.
- Never run `npm publish` by hand; a tarball built outside the script has no audit and a stale manifest.
- To change what ships, edit `package.json` `files` and regenerate the manifest; the audit fails a file the tarball ships that the manifest does not list, and the reverse.
- The marketplace repo holds only the catalog. To seed it once the GitHub repo exists: `cp -r 50arms-marketplace /tmp/50arms-marketplace && cd /tmp/50arms-marketplace && git init -b main && git add -A && git commit -m "danxbot marketplace" && git remote add origin <ssh-url-of-50arms/claude-marketplace> && git push -u origin main`. The folder is the whole repo, verbatim; keep `50arms-marketplace/` here as the source and re-copy when the catalog changes (a plugin release needs no catalog change).

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
