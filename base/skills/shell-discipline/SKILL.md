---
name: shell-discipline
description: Shell discipline — exit-code capture, blocking-stdin avoidance, run_in_background vs Monitor vs tail-grep polling, tool-choice (Read/Edit/Write over bash), and signal delivery (kill/pkill) for any process.
---

# Shell Discipline

## Exit-code capture

After a long-running command, the next step must be `RC=$?` or a `&&`/`||` branch —
nothing else. `echo`/`tail`/`grep`/`head`/`cat` overwrite `$?`, so a chain ending in one
of those silently reports success regardless of the real result.

## Never block on stdin

Before every Bash call: does the chain read stdin with nothing attached (bare
`cat`/`read`, `ssh`, `psql`, `npm login`, any `-i`/interactive flag)? These hang forever
and nothing after runs. Redirect closed (`< /dev/null`) or write files with `Write`. No
output past ~2 minutes in the background means hung, not "still working."

## Never run interactive-prompt commands in background shells

Commands that prompt interactively (`sudo`, `ssh` without `-o BatchMode=yes`, `git credential`, `npm login`, or anything asking for user input) hang forever in a non-TTY shell — the background task never exits and silently pins the session as busy. Use the non-interactive form (`sudo -n`, `ssh -o BatchMode=yes`, git stored credentials) or fail fast. (DX-3403: a 5-hour hung `sudo rm -rf` in a background shell delayed dispatch cleanup detection until timeout.)

## Capture full output up front if you'll need to search it later

Redirect to a file when you'll need to grep the full output afterward — `tail -N`/`head
-N` at capture time discards the rest, forcing a full rerun to search it.

## Polling — Monitor vs background vs tail

1. Tell me once when X finishes → `run_in_background: true` + an until-loop. Never Monitor.
2. Tell me on state changes → Monitor, diff prev/cur, emit only on change.
3. Tell me every line → Monitor + `tail -f | grep --line-buffered <pattern>`.
4. "I want progress" → narration, not signal; use option 1.

Interval floors: local check (file/port/lock) 1-5s; local process (docker ps, pgrep)
10-15s; local file 5-10s; backend job (artisan, queue, DB exec) 60s;
LLM/dispatch/orchestrator 60-120s; remote API 30-60s. Double the floor after a failure
under load this session.

Monitor's filter must catch forward progress, every actionable failure (error, failed,
killed, OOM, assert, panic), and process death — but emit only actionable lines.

## Tool choice

Prefer `Read`/`Edit`/`Write` over `cat`/`sed`/`awk`/`echo >`/heredocs, `Glob`/`Grep` over
`find`/`grep`. Read before editing; if `Edit` keeps failing, shrink `old_string` to 2-5
lines, then stop. Use `run_in_background: true`, not `&`/`nohup`/`setsid`/`disown`; never
double-background or roll your own logfile-and-tail.

Load an MCP tool's schema before calling it — interfaces vary even for the same concept.
Literal `\n` in an MCP string is two characters, not a newline — use a real line break.

Never read or edit `dist/` or other build output — stale, source is truth.
`node_modules/` may be read, never edited. Prefer a language-native refactor tool over
manual find-and-replace for a cross-file rename.

## Browser automation

Use the in-app browser tool for real-browser checks — never a headed browser on the
user's desktop. Verify only in the browser asked for. Close tabs you opened; leave others.

## Signal delivery (kill / pkill / SIGKILL / docker kill)

Every signal is a one-way production action on a shared workspace. Kill only when all
three hold: you spawned it this session, captured its PID at spawn time into a variable,
and that PID is still the target — never a `ps`/pattern lookup. State target PID, where
spawned, which variable holds it, what it should be running; unfillable → ask, don't
guess. Forbidden: `pkill -f`, `killall`, `kill $(pgrep ...)`, anything targeting by
name/pattern/inferred ownership.

A dev/preview server at a fixed address isn't scratch space just because you started it
— someone may be connected now, and a restart drops in-flight requests. Check for a live
connection first; if found, get confirmation rather than cycling silently; prefer
attaching over restarting.
