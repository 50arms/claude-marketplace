#!/usr/bin/env bash
# The mantra, for two events (PLN-11 R-12 / R-22):
#   SessionStart (matcher "startup|resume|compact") — the main session.
#   SubagentStart (matcher ".*") — every sub-agent, any type or plugin.
#     DX-3384 / DX-3478 problem 1769: every agent receives the mantra;
#     final sweep widened the matcher from worker-tier-only to all agents.
#
# Plan-connected (lib/plan-connection.mjs, a local stat of the payload's session
# id — for SubagentStart, the PARENT session's): the EFFECTIVE mantra (override ??
# default) of the reminder registry row `mantra.session_start`, fetched with the
# pinned danx-dashboard-mcp `mantra` subcommand, so a dashboard edit needs no
# plugin publish. The row's default is derived from `danxbot/mantra.md` at seed
# time; that file is the fallback, with a notice line, when the registry can't
# be reached.
# Not connected: SessionStart prints only the plan-workflow nudge (R-10);
# SubagentStart prints `mantra.md` itself — with no connection there is no
# registry to consult, and that file IS the registry row's default source.
#
# This is the only hook that prints mantra text; `plan_connect`'s response and
# danxbot's dispatch profiles resolve the same registry row. SessionStart stdout
# reaches the model as plain text; SubagentStart honours only
# `hookSpecificOutput.additionalContext` (code.claude.com/docs/en/hooks,
# "SubagentStart decision control"), so that event emits JSON, built with node,
# never jq. Stdin (the hook JSON) is read once into $PAYLOAD.

set -euo pipefail

EVENT="${1:-SessionStart}"
MANTRA_FILE="${CLAUDE_PLUGIN_ROOT}/mantra.md"
CONNECTION_LIB="${CLAUDE_PLUGIN_ROOT}/scripts/lib/plan-connection.mjs"

MANTRA_FETCH_TIMEOUT_SECS="8"

NUDGE="If this session will line up or run work, load \`danxbot:plan-workflow\` and connect a plan. Anything that sounds like work being lined up (multi-step work, \"let's plan...\", a list of things to do) and no plan is connected yet: ASK the operator whether to load plan-workflow and start planning — don't guess. Nothing else from the danxbot plugin (the mantra, plan mechanics, the event bridge) applies until a plan is connected."

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

# The committed mantra.md, or a fail-loud line when even that is missing: a
# corrupt plugin install is worth surfacing, never a silent skip.
mantra_file_text() {
  if [ ! -f "$MANTRA_FILE" ]; then
    printf '%s' "⚠ MANTRA LOAD FAILED: expected $MANTRA_FILE, not found. The plugin install may be corrupt."
    return
  fi
  cat "$MANTRA_FILE"
}

CONNECTED="0"
if [ -f "$CONNECTION_LIB" ]; then
  CONNECTED="$(printf '%s' "$PAYLOAD" | node "$CONNECTION_LIB" 2>/dev/null || true)"
fi

if [ "$CONNECTED" != "1" ]; then
  if [ "$EVENT" = "SubagentStart" ]; then
    emit "$(mantra_file_text)"
  else
    emit "$NUDGE"
  fi
  exit 0
fi

# DX-3366: the `mantra` subcommand reads CLAUDE_CODE_SESSION_ID from ITS OWN
# env (never stdin) to resolve `~/.config/danxbot/plan-sessions/<session>.json`
# via the same `resolveBridgeOptions()` the plugin's `bridge`/`plan-state`
# subcommands already use. Resolve the session id here from the SAME stdin
# payload already read into $PAYLOAD above, with the same precedence
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

# DX-3366: plain `npx` resolved off PATH — NOT `plan-event-bridge.mjs`'s
# `bridgeCommand()` win32 workaround (resolving `npx-cli.js` and invoking it
# via `node`). That workaround exists because Node's `child_process.spawn`
# cannot execute a Windows `.cmd` shim without `shell: true`. This script is
# bash, not Node: bash's own exec/PATH resolution already runs `node` (a
# native exe) directly for $CONNECTION_LIB above with no such boundary, and
# it resolves `npx` (a `.cmd` shim on Windows, a POSIX script elsewhere) the
# same way any other shell resolves a command on PATH — there is no
# non-shell child_process layer here for a shim to defeat. Kept genuinely
# simple rather than porting a workaround this hook does not need.
#
# `timeout` bounds the whole fetch so a hung/unreachable dashboard can never
# wedge SessionStart (a SessionStart hook that never returns blocks the
# session). Falls back to an unbounded call only when no `timeout` binary
# exists at all (stock macOS ships none) — better than refusing to even try
# the fetch on a host missing one optional coreutil.
MANTRA_MCP_PACKAGE="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/dashboard-mcp-package.mjs")"
FETCH_OK="0"
MANTRA_TEXT=""
if command -v timeout >/dev/null 2>&1; then
  MANTRA_TEXT="$(CLAUDE_CODE_SESSION_ID="$SESSION_ID" timeout "${MANTRA_FETCH_TIMEOUT_SECS}s" npx -y "$MANTRA_MCP_PACKAGE" mantra 2>/dev/null)" && FETCH_OK="1" || FETCH_OK="0"
else
  MANTRA_TEXT="$(CLAUDE_CODE_SESSION_ID="$SESSION_ID" npx -y "$MANTRA_MCP_PACKAGE" mantra 2>/dev/null)" && FETCH_OK="1" || FETCH_OK="0"
fi

# Success requires BOTH exit 0 AND non-empty stdout — an empty string on a
# reported-clean exit is treated as a failure too, never trusted as a
# silent "success" (AC 35447).
if [ "$FETCH_OK" = "1" ] && [ -n "$MANTRA_TEXT" ]; then
  emit "$MANTRA_TEXT"
  exit 0
fi

# The fallback carries a notice line so it is never mistaken for live registry text.
emit "⚠ Could not reach the reminder registry — printing the committed mantra.md fallback (may be stale).
$(mantra_file_text)"
