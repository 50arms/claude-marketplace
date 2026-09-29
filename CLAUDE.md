# claude-plugins

Source of truth for the `newms-plugins` marketplace. Its plugins reach every Claude Code session on this machine and danxbot's container workers (through danxbot's catalog).

## The mantra is the one home for every rule it states (PLN-11 R-22)

`danxbot/mantra.md` is the mantra's single hand-maintained text: danxbot seeds the reminder
registry row `mantra.session_start` from it, and every agent receives that row's effective
text, never a copy:

- the main session: `danxbot/scripts/mantra.sh` at `SessionStart` (matcher
  `startup|resume|compact`) once a plan is connected, and `plan_connect`'s response;
- every `danxbot:worker-*` sub-agent: the same script at `SubagentStart` (additionalContext);
- every dispatched worker: its profile's `{{reminder:mantra.session_start}}`, resolved by
  danxbot per dispatch.

The file is the fallback when the registry can't be reached. **Nothing else restates a
mantra rule** — no `SKILL.md`, agent body, hook text, `CLAUDE.md`, rule file or profile. A
skill may point at the mantra or add procedure the mantra doesn't state. To change a rule,
edit `mantra.md` and publish; phrase each rule so it holds for every one of those readers.
No prose states how many sub-agents to run (R-23).

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

## Publishing is TWO steps, and the second one is not optional

A plugin edit is not shipped until BOTH happen:

1. **Bump + push** — `./scripts/publish.sh <patch|minor|major> <plugin>`. The marketplace loader compares `version` fields, not commit shas; a plain `git push` of plugin source ships nothing to any consumer.
2. **Update this machine's installed records** — `update-claude-plugins` (symlink to `scripts/update-plugins.sh`).

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
