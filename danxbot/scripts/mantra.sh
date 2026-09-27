#!/usr/bin/env bash
# The mantra — ships with the `danxbot` plugin. DX-3347, gated DX-3275,
# text sourced from the reminder registry as of DX-3366.
#
# DX-3387: mantra.md is the single hand-maintained source of the mantra
# text — danxbot's own seed.yaml derives its default from this exact file
# via the synced plugin marketplace cache at boot; do not hand-copy this
# text anywhere else.
#
# Fires on SessionStart, matcher "startup|resume|compact" ONLY (DX-3052
# problem 1602, plan PLN-11 rule R-12: the mantra is injected at session
# start, resume and compaction — never on every message, never on `clear`
# or `fork`).
#
# DX-3275 / PLN-11 R-10: the danxbot plugin stays quiet until a session is
# actually connected to a danxbot plan. This hook now checks the SAME
# connection record `plan-workflow-autoload.sh` and `plan-connect-mantra.mjs`
# check (`scripts/lib/plan-connection.mjs` — a local file stat against
# `~/.config/danxbot/plan-sessions/<session>.json`, never a network call):
#   - NOT connected -> print only the short plan-workflow nudge (~0.5 KB),
#     at this hook's own cadence (the DX-3052 problem 1602 decision above).
#     UNCHANGED by DX-3366 — this branch never reaches the network.
#   - connected -> fetch the EFFECTIVE mantra text (override ?? default) from
#     the connected dashboard's reminder registry (row `mantra.session_start`)
#     via the published `@thehammer/danx-dashboard-mcp` package's `mantra`
#     subcommand, so an operator can edit the mantra from the dashboard
#     without a plugin publish. Any failure to reach it (npx missing, no
#     connection record readable by the subcommand, network error, timeout,
#     404 row-missing, malformed response) falls back to printing the
#     git-committed `danxbot/mantra.md` verbatim, PLUS one short notice line
#     that the registry could not be reached — so a stale committed file is
#     never mistaken for live registry text (AC 35447: fail loud, never
#     silently). `mantra.md` itself is unchanged — it is the offline
#     fallback copy, not the source of truth.
#
# THIS IS THE ONLY HOOK THAT PRINTS MANTRA, CONTRACT OR CRAFT TEXT. That
# text used to be three separate hooks (base's operating-contract.sh +
# craft-mandate.sh, danxbot's zero-context-mandate.sh), each re-injecting
# its own full copy on every SessionStart source AND a pointer on every
# single UserPromptSubmit — DX-3278 measured that combination at 3.7 KB on
# every message, craft-mandate's full-text UserPromptSubmit branch alone
# being 55% of it. All three are deleted; their content lives in
# `mantra.md` (or its live registry override) now, printed once here (once
# connected).
#
# Plain stdout, no `jq`: SessionStart's stdout is added to the model's
# context as plain text on exit 0 (confirmed against
# https://code.claude.com/docs/en/hooks, "the exceptions are
# UserPromptSubmit, UserPromptExpansion, SessionStart, and PostModelSwitch").
#
# Argv: $1 = "SessionStart" (any other value is a no-op — this hook is never
# wired to fire on anything else). Stdin: the hook's JSON payload, read once
# for `session_id` (node, not jq — see base/scripts/inject-time.sh for why).
# The same payload is reused below (DX-3366) to resolve the session id the
# `mantra` subcommand needs — stdin is a pipe, so it is read exactly once
# into $PAYLOAD and threaded from there, never re-read.

set -euo pipefail

EVENT="${1:-SessionStart}"
MANTRA_FILE="${CLAUDE_PLUGIN_ROOT}/mantra.md"
CONNECTION_LIB="${CLAUDE_PLUGIN_ROOT}/scripts/lib/plan-connection.mjs"

# DX-3366: pinned exact version, matching the convention `plan-event-bridge.mjs`
# already uses for its own npx-resolved subcommand (`DASHBOARD_MCP_PACKAGE`) —
# `npx` never re-checks the registry once a version is cached, so an
# unpinned `@latest`/bare spec would silently keep serving whatever this
# machine cached first.
MANTRA_MCP_PACKAGE="@thehammer/danx-dashboard-mcp@0.1.138"
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
