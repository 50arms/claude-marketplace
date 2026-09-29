#!/usr/bin/env bash
# The ONE event hook (DX-3421), for two Claude Code events:
#   SessionStart (matcher "startup|resume|compact") — the main session.
#   SubagentStart (matcher ".*") — every sub-agent, any type or plugin.
#
# Replaces THREE scripts: `mantra.sh`, `plan-workflow-autoload.sh` and
# `compaction-skill-reload.sh` (all deleted in the same change). Operator
# direction (DX-3420): "we might not be in danxbot mode and should NOT be
# receiving regular instructions from danxbot" when no plan is connected —
# so danxbot now decides, PER EVENT, what a plan-connected session is told,
# and a session that isn't connected hears nothing from this hook at all.
#
# Not connected to a plan (lib/plan-connection.mjs — for SubagentStart, the
# PARENT session's connection): SILENT. No nudge, no mantra, nothing (DX-3421
# comment 7748/7752 operator verdict). The trigger to connect a plan is
# `danxbot:plan-workflow`'s own skill description, not a hook line.
#
# Connected: resolves the danxbot EVENT name from this Claude event —
#   SessionStart, source=startup -> session_start
#   SessionStart, source=resume  -> session_resume
#   SessionStart, source=compact -> after_compaction
#   SubagentStart                -> sub_agent_start
# — and asks the dashboard for that event's EFFECTIVE text (the reminder
# registry's `event.<name>` row, `GET /api/reminders/event/<name>`) via the
# pinned `danx-dashboard-mcp event-text` subcommand, then prints exactly
# that text.
#
# Fetch failure: prints ONE line saying the event text could not be loaded,
# naming the reason, and telling the agent to tell the operator — never
# silent, and there is NO offline `mantra.md` fallback read any more (DX-3421
# AC: "No mantra.md offline fallback: delete the fallback reading. The
# registry seed is the only source."). `danxbot/mantra.md` still exists —
# it is the git source `resolveReminderSeedItems` derives the
# `mantra.session_start` registry row's default from at dashboard-seed time —
# this hook just never reads it itself any more.
#
# SessionStart stdout reaches the model as plain text; SubagentStart honours
# only `hookSpecificOutput.additionalContext`
# (code.claude.com/docs/en/hooks, "SubagentStart decision control"), so that
# event emits JSON, built with node, never jq. Stdin (the hook JSON) is read
# once into $PAYLOAD.
set -euo pipefail

EVENT="${1:-SessionStart}"
CONNECTION_LIB="${CLAUDE_PLUGIN_ROOT}/scripts/lib/plan-connection.mjs"

EVENT_TEXT_FETCH_TIMEOUT_SECS="8"

case "$EVENT" in
  SessionStart|SubagentStart) ;;
  *) exit 0 ;;
esac

PAYLOAD="$(cat)"

# One block of text for this event: plain stdout for SessionStart, the
# additionalContext JSON envelope for SubagentStart.
emit() {
  if [ "$EVENT" = "SubagentStart" ]; then
    printf '%s' "$1" | node -e '
      let text = "";
      process.stdin.on("data", (chunk) => { text += chunk; });
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: text } }));
      });
    '
  else
    printf '%s\n' "$1"
  fi
}

CONNECTED="0"
if [ -f "$CONNECTION_LIB" ]; then
  CONNECTED="$(printf '%s' "$PAYLOAD" | node "$CONNECTION_LIB" 2>/dev/null || true)"
fi

# Not connected: DEAD SILENT, for both events (DX-3421 — no nudge, no
# mantra.md, nothing). A sub-agent of an unconnected session inherits the
# same silence via the parent's own connection state.
if [ "$CONNECTED" != "1" ]; then
  exit 0
fi

# Which danxbot event to ask for. SubagentStart is always sub_agent_start;
# SessionStart reads the hook payload's `source` field
# (code.claude.com/docs/en/hooks: "startup"|"resume"|"clear"|"compact"|"fork")
# — the matcher above already restricts this hook to firing only on
# startup/resume/compact, so `clear`/`fork` never reach this branch, but an
# unrecognized value still fails safe to "print nothing" rather than
# guessing.
if [ "$EVENT" = "SubagentStart" ]; then
  DANX_EVENT="sub_agent_start"
else
  SOURCE="$(printf '%s' "$PAYLOAD" | node -e '
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        process.stdout.write(typeof parsed.source === "string" ? parsed.source : "");
      } catch {
        process.stdout.write("");
      }
    });
  ' 2>/dev/null || true)"
  case "$SOURCE" in
    startup) DANX_EVENT="session_start" ;;
    resume)  DANX_EVENT="session_resume" ;;
    compact) DANX_EVENT="after_compaction" ;;
    *) exit 0 ;;
  esac
fi

# DX-3366/DX-3421: resolve the session id from the SAME stdin payload already
# read into $PAYLOAD above, with the same precedence
# `scripts/lib/plan-connection.mjs`'s own `main()` uses (payload.session_id,
# else the ambient $CLAUDE_CODE_SESSION_ID) — duplicated rather than
# imported, matching this plugin's existing convention of small per-file
# copies over cross-file imports (see plan-connection.mjs's own header on
# `isValidSessionId`).
SESSION_ID="$(printf '%s' "$PAYLOAD" | node -e '
  let data = "";
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => {
    let sessionId = "";
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed.session_id === "string" && parsed.session_id !== "") sessionId = parsed.session_id;
    } catch {}
    process.stdout.write(sessionId || process.env.CLAUDE_CODE_SESSION_ID || "");
  });
' 2>/dev/null || true)"

# Plain `npx` resolved off PATH — NOT `plan-event-bridge.mjs`'s
# `bridgeCommand()` win32 workaround (resolving `npx-cli.js` and invoking it
# via `node`). That workaround exists because Node's `child_process.spawn`
# cannot execute a Windows `.cmd` shim without `shell: true`. This script is
# bash, not Node: bash's own exec/PATH resolution already runs `node`
# directly for $CONNECTION_LIB above with no such boundary, and it resolves
# `npx` the same way any other shell resolves a command on PATH.
#
# `timeout` bounds the whole fetch so a hung/unreachable dashboard can never
# wedge SessionStart. Falls back to an unbounded call only when no `timeout`
# binary exists at all (stock macOS ships none).
EVENT_TEXT_MCP_PACKAGE="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/dashboard-mcp-package.mjs")"
FETCH_OK="0"
EVENT_TEXT=""
# `mktemp` (not a hardcoded /tmp path) so this resolves correctly on every
# host this bash runs on, Windows/Git-Bash included. `&&`/`||` right after
# the assignment (not a bare `STATUS=$?` on the next line) is required under
# `set -e`: a failing command substitution NOT followed by `&&`/`||` aborts
# the script immediately, before the failure could ever be handled below —
# mirrors mantra.sh's original DX-3366 idiom.
ERR_FILE="$(mktemp)"
if command -v timeout >/dev/null 2>&1; then
  EVENT_TEXT="$(CLAUDE_CODE_SESSION_ID="$SESSION_ID" timeout "${EVENT_TEXT_FETCH_TIMEOUT_SECS}s" npx -y "$EVENT_TEXT_MCP_PACKAGE" event-text "$DANX_EVENT" 2>"$ERR_FILE")" && FETCH_OK="1" || FETCH_OK="0"
else
  EVENT_TEXT="$(CLAUDE_CODE_SESSION_ID="$SESSION_ID" npx -y "$EVENT_TEXT_MCP_PACKAGE" event-text "$DANX_EVENT" 2>"$ERR_FILE")" && FETCH_OK="1" || FETCH_OK="0"
fi
FETCH_ERR="$(cat "$ERR_FILE" 2>/dev/null || true)"
rm -f "$ERR_FILE"

# Success requires BOTH exit 0 AND non-empty stdout — an empty string on a
# reported-clean exit is treated as a failure too, never trusted as a
# silent "success" (mirrors mantra.sh's DX-3366 AC 35447).
if [ "$FETCH_OK" = "1" ] && [ -n "$EVENT_TEXT" ]; then
  emit "$EVENT_TEXT"
  exit 0
fi

# Fetch failure: ALWAYS reported, never silent, and never a mantra.md reread
# (DX-3421 — no offline fallback any more). Tell the agent to tell the
# operator.
emit "⚠ Could not load the \"$DANX_EVENT\" event text from the danxbot reminder registry (${FETCH_ERR:-unknown error}). Tell the operator this event hook fetch failed."
