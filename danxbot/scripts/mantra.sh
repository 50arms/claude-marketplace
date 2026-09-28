#!/usr/bin/env bash
# The mantra — SessionStart, matcher "startup|resume|compact" only (PLN-11 R-12).
#
# Not plan-connected (lib/plan-connection.mjs, a local stat): print only the short
# plan-workflow nudge (R-10); nothing reaches the network.
# Connected: print the EFFECTIVE mantra (override ?? default) of the reminder
# registry row `mantra.session_start`, fetched with the pinned danx-dashboard-mcp
# `mantra` subcommand, so a dashboard edit needs no plugin publish. The row's
# default is derived from `danxbot/mantra.md` at seed time; that file is also the
# offline fallback printed here, with a notice line, when the registry can't be
# reached. `plan_connect`'s response carries the same registry text.
#
# This is the only hook that prints mantra text. Plain stdout: SessionStart stdout
# reaches the model on exit 0. Stdin (the hook JSON) is read once into $PAYLOAD.

set -euo pipefail

EVENT="${1:-SessionStart}"
MANTRA_FILE="${CLAUDE_PLUGIN_ROOT}/mantra.md"
CONNECTION_LIB="${CLAUDE_PLUGIN_ROOT}/scripts/lib/plan-connection.mjs"

MANTRA_FETCH_TIMEOUT_SECS="8"

NUDGE="If this session will line up or run work, load \`danxbot:plan-workflow\` and connect a plan. Anything that sounds like work being lined up (multi-step work, \"let's plan...\", a list of things to do) and no plan is connected yet: ASK the operator whether to load plan-workflow and start planning — don't guess. Nothing else from the danxbot plugin (the mantra, plan mechanics, the event bridge) applies until a plan is connected."

if [ "$EVENT" != "SessionStart" ]; then
  exit 0
fi

PAYLOAD="$(cat)"

CONNECTED="0"
if [ -f "$CONNECTION_LIB" ]; then
  CONNECTED="$(printf '%s' "$PAYLOAD" | node "$CONNECTION_LIB" 2>/dev/null || true)"
fi

if [ "$CONNECTED" != "1" ]; then
  printf '%s\n' "$NUDGE"
  exit 0
fi

# Prints the offline fallback: the git-committed mantra.md (or the
# fail-loud "install may be corrupt" line if even that is missing) plus one
# short notice line marking it as a fallback, so it is never mistaken for
# live registry text.
print_fallback() {
  if [ ! -f "$MANTRA_FILE" ]; then
    # Fail loud rather than silently skipping — a missing file here means the
    # plugin install is corrupt, which is itself worth surfacing.
    printf '%s\n' "⚠ MANTRA LOAD FAILED: expected $MANTRA_FILE, not found. The plugin install may be corrupt."
    return
  fi
  printf '%s\n' "⚠ Could not reach the reminder registry — printing the committed mantra.md fallback (may be stale)."
  cat "$MANTRA_FILE"
}

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
  printf '%s\n' "$MANTRA_TEXT"
  exit 0
fi

print_fallback
