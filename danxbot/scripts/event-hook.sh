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
# `danx-dashboard-mcp event-text` subcommand (run with `node` from the
# plugin-data install, DX-3811), then prints exactly that text.
#
# Which version of that package runs (DX-4321): the npm registry's `latest`, refreshed here at
# every SessionStart (`lib/dashboard-mcp-package.mjs --refresh`, before the install check) and
# read from the plugin's record, with no registry request, at SubagentStart. A refresh that fails
# prints ONE extra line naming the reason and the version still in use, and the recorded version
# keeps running; with no recorded version nothing runs and the failure line says so.
#
# Fetch failure: prints ONE line saying the event text could not be loaded,
# naming the reason, and telling the agent to tell the operator — never
# silent, and there is NO offline `mantra.md` fallback read any more (DX-3421
# AC: "No mantra.md offline fallback: delete the fallback reading. The
# registry seed is the only source."). `danxbot/mantra.md` still exists —
# it is the git source `resolveReminderSeedItems` derives the
# `mantra` registry row's default from at dashboard-seed time —
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
PACKAGE_LIB="${CLAUDE_PLUGIN_ROOT}/scripts/lib/dashboard-mcp-package.mjs"

# The fetch budget (DX-3811): covers the fetch only; the env override is a test seam.
EVENT_TEXT_FETCH_TIMEOUT_SECS="${EVENT_TEXT_FETCH_TIMEOUT_SECS:-8}"

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

# Reads one string field from the hook payload ($1 = field name; "" when absent).
payload_field() {
  printf '%s' "$PAYLOAD" | FIELD="$1" node -e '
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(data)[process.env.FIELD];
        process.stdout.write(typeof value === "string" ? value : "");
      } catch {
        process.stdout.write("");
      }
    });
  ' 2>/dev/null || true
}

# DX-4321: the SessionStart refresh of the recorded danx-dashboard-mcp version, run once, just
# before the first install check. REFRESH_NOTICE is the one line a failed refresh prints (the
# recorded version keeps running); REFRESH_FATAL is the reason when there is no recorded version
# to run, which makes every install check below fail with it. A SubagentStart reads the record
# and never calls this.
REFRESH_NOTICE=""
REFRESH_FATAL=""
# The exit code `dashboard-mcp-package.mjs --refresh` uses for "the refresh failed, the recorded version
# keeps running": EXIT_REFRESH_FAILED_KEPT in that module. Any other non-zero exit means nothing can run.
REFRESH_FAILED_KEPT_EXIT=3
refresh_mcp_version() {
  [ "$EVENT" = "SessionStart" ] || return 0
  local refresh_err refresh_rc="0"
  refresh_err="$(mktemp)"
  node "$PACKAGE_LIB" --refresh >/dev/null 2>"$refresh_err" || refresh_rc="$?"
  case "$refresh_rc" in
    0) ;;
    "$REFRESH_FAILED_KEPT_EXIT") REFRESH_NOTICE="$(cat "$refresh_err" 2>/dev/null || true)" ;;
    *)
      REFRESH_FATAL="$(cat "$refresh_err" 2>/dev/null || true)"
      if [ -z "$REFRESH_FATAL" ]; then REFRESH_FATAL="exit_${refresh_rc}: the version refresh exited without a message"; fi
      ;;
  esac
  rm -f "$refresh_err"
}

# The refresh's one line, ahead of whatever else this event prints.
emit_refresh_notice() {
  if [ -n "$REFRESH_NOTICE" ]; then emit "⚠ ${REFRESH_NOTICE}."; fi
  return 0
}

# DX-3928: the restart notice for a NOT-connected session (see the call site).
restart_notice() {
  case "$(payload_field source)" in
    startup|resume) ;;
    *) return 0 ;;
  esac
  local session_id project_dir notice_err notice_out notice_rc="0" mcp_bin
  session_id="$(payload_field session_id)"
  session_id="${session_id:-${CLAUDE_CODE_SESSION_ID:-}}"
  project_dir="$(payload_field cwd)"
  notice_err="$(mktemp)"
  notice_out=""
  refresh_mcp_version
  if [ -n "$REFRESH_FATAL" ]; then
    printf '%s' "$REFRESH_FATAL" >"$notice_err"
    notice_rc="1"
  elif mcp_bin="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-dashboard-mcp.sh" 2>"$notice_err")"; then
    local cwd_args=()
    if [ -n "$project_dir" ]; then cwd_args=(--cwd "$project_dir"); fi
    if command -v timeout >/dev/null 2>&1; then
      notice_out="$(CLAUDE_CODE_SESSION_ID="$session_id" timeout "${EVENT_TEXT_FETCH_TIMEOUT_SECS}s" node "$mcp_bin" restart-notice ${cwd_args[@]+"${cwd_args[@]}"} 2>"$notice_err")" || notice_rc="$?"
    else
      notice_out="$(CLAUDE_CODE_SESSION_ID="$session_id" node "$mcp_bin" restart-notice ${cwd_args[@]+"${cwd_args[@]}"} 2>"$notice_err")" || notice_rc="$?"
    fi
  else
    notice_rc="1"
  fi
  local reason
  reason="$(cat "$notice_err" 2>/dev/null || true)"
  rm -f "$notice_err"
  if [ "$notice_rc" != "0" ]; then
    if [ -z "$reason" ]; then
      if [ "$notice_rc" = "124" ]; then reason="timeout: no response within ${EVENT_TEXT_FETCH_TIMEOUT_SECS}s"; else reason="exit_${notice_rc}: the lookup exited without a message"; fi
    fi
    emit_refresh_notice
    emit "⚠ Could not load the restart notice (${reason}). Tell the operator if this session should be plan-connected."
    return 0
  fi
  if [ -n "$notice_out" ]; then
    emit_refresh_notice
    emit "$notice_out"
  fi
  return 0
}

CONNECTED="0"
if [ -f "$CONNECTION_LIB" ]; then
  CONNECTED="$(printf '%s' "$PAYLOAD" | node "$CONNECTION_LIB" 2>/dev/null || true)"
fi

# Not connected: DEAD SILENT, for both events (DX-3421 — no nudge, no
# mantra.md, nothing). A sub-agent of an unconnected session inherits the
# same silence via the parent's own connection state.
if [ "$CONNECTED" != "1" ]; then
  # DX-3928: the ONE narrow exception to the silence above — a SessionStart
  # (startup|resume) whose project's previous session was plan-connected is told
  # which plan it was on and how many events are waiting. The wording is a registry
  # row; this script only runs the package's `restart-notice` subcommand:
  #   exit 0 + text  -> print it
  #   exit 0 + empty -> stay silent (a project with no earlier connected session —
  #                     PLN-11 R-10 / DX-3421 still hold for it)
  #   non-zero exit  -> one line naming why the notice could not be loaded
  if [ "$EVENT" = "SessionStart" ]; then
    restart_notice
  fi
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

# DX-3811: the fetch runs the recorded package version with plain `node` from a copy
# installed ONCE into the plugin data dir (ensure-dashboard-mcp.sh), never through
# `npx -y`. A cold or contended `npx` took 4-15 s here and was killed by the
# fetch timeout before it wrote a word, so about 1 in 9 sub-agents got the failure
# notice instead of the mantra. The install step runs OUTSIDE the fetch's budget
# (it is a file check once installed); the budget covers only the fetch itself.
#
# `timeout` bounds the fetch so a hung/unreachable dashboard can never wedge
# SessionStart. Falls back to an unbounded call only when no `timeout` binary
# exists at all (stock macOS ships none).
FETCH_OK="0"
FETCH_RC="0"
EVENT_TEXT=""
FETCH_ERR=""
# `mktemp` (not a hardcoded /tmp path) so this resolves correctly on every
# host this bash runs on, Windows/Git-Bash included. `&&`/`||` right after
# each assignment (not a bare `STATUS=$?` on the next line) is required under
# `set -e`: a failing command substitution NOT followed by `&&`/`||` aborts
# the script immediately, before the failure could ever be handled below —
# mirrors mantra.sh's original DX-3366 idiom.
ERR_FILE="$(mktemp)"
refresh_mcp_version
if [ -n "$REFRESH_FATAL" ]; then
  printf '%s' "$REFRESH_FATAL" >"$ERR_FILE"
  ENSURE_OK="0"
else
  MCP_BIN="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-dashboard-mcp.sh" 2>"$ERR_FILE")" && ENSURE_OK="1" || ENSURE_OK="0"
fi
if [ "$ENSURE_OK" = "1" ]; then
  if command -v timeout >/dev/null 2>&1; then
    EVENT_TEXT="$(CLAUDE_CODE_SESSION_ID="$SESSION_ID" timeout "${EVENT_TEXT_FETCH_TIMEOUT_SECS}s" node "$MCP_BIN" event-text "$DANX_EVENT" 2>"$ERR_FILE")" && FETCH_OK="1" || FETCH_RC="$?"
  else
    EVENT_TEXT="$(CLAUDE_CODE_SESSION_ID="$SESSION_ID" node "$MCP_BIN" event-text "$DANX_EVENT" 2>"$ERR_FILE")" && FETCH_OK="1" || FETCH_RC="$?"
  fi
fi
FETCH_ERR="$(cat "$ERR_FILE" 2>/dev/null || true)"
rm -f "$ERR_FILE"

# A failure always names its reason. `timeout` kills the process before it can
# write one (rc 124, empty stderr), so that case is named here — the old
# "(unknown error)" text hid exactly this timeout.
if [ -z "$FETCH_ERR" ]; then
  if [ "$FETCH_RC" = "124" ]; then
    FETCH_ERR="timeout: no response within ${EVENT_TEXT_FETCH_TIMEOUT_SECS}s"
  elif [ "$FETCH_RC" != "0" ]; then
    FETCH_ERR="exit_${FETCH_RC}: the fetch exited without a message"
  else
    FETCH_ERR="empty_response: the dashboard returned an empty text"
  fi
fi

# Success requires BOTH exit 0 AND non-empty stdout — an empty string on a
# reported-clean exit is treated as a failure too, never trusted as a
# silent "success" (mirrors mantra.sh's DX-3366 AC 35447).
if [ "$FETCH_OK" = "1" ] && [ -n "$EVENT_TEXT" ]; then
  emit_refresh_notice
  emit "$EVENT_TEXT"
  exit 0
fi

# Fetch failure: ALWAYS reported, never silent, and never a mantra.md reread
# (DX-3421 — no offline fallback any more). Tell the agent to tell the
# operator.
emit_refresh_notice
emit "⚠ Could not load the \"$DANX_EVENT\" event text from the danxbot reminder registry (${FETCH_ERR}). Tell the operator this event hook fetch failed."
