#!/usr/bin/env bash
# DX-3811: install the pinned `@thehammer/danx-dashboard-mcp` ONCE into the
# plugin's data dir and print the absolute path of its `dist/index.js`, so a hook
# runs it with plain `node` — never through a cold `npx -y`.
#
# WHY. `event-hook.sh`'s SubagentStart fetch used to run
# `timeout 8s npx -y <pin> event-text sub_agent_start`. Measured 2026-10-01 on this
# machine, warm cache: npx alone costs ~1.6 s before the package even starts, a
# cold npx (no cache) ~4 s, and the same package run by `node` straight from an
# installed copy 0.6 s end to end (60 ms node start, ~230 ms module load, ~300 ms
# HTTP). Under concurrent spawns the npx path ran past 8 s on about 1 in 9
# sub-agents, `timeout` killed it before it wrote a word, and the agent got the
# "(unknown error)" notice INSTEAD of the mantra.
#
# WHERE. `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/<version>/node_modules/...` — one
# directory per pin, so bumping the pin in `lib/dashboard-mcp-package.mjs` installs
# the new version lazily and an older plugin version's sessions keep their own.
#
# WHEN. Wired async at SessionStart (hooks.json, `--prewarm`) so the install is normally done
# before the first sub-agent spawns, and called by `event-hook.sh` before every
# fetch, where it is a single file check once installed. A cold first call installs
# synchronously (bounded by INSTALL_TIMEOUT_SECS) — the fetch's own 8-second budget
# starts only after this returns.
#
# CONCURRENT CALLERS. Several sub-agents can spawn at once. Each installs into its
# own staging directory and only a COMPLETE, verified install is renamed to the
# final path, so no caller ever sees a half-written install, and the loser of a
# race simply discards its copy.
#
# Prints the path to stdout (no newline) and exits 0; on failure prints ONE line
# naming the reason to stderr and exits 1.
#
# `--prewarm` (the SessionStart hook): the same install, but silent and always exit 0.
# Nothing reads a prewarm's result, and a failure is not lost — event-hook.sh runs this
# script again before every fetch and reports that failure to the agent with its reason.
set -euo pipefail

if [ "${1:-}" = "--prewarm" ]; then
  bash "$0" >/dev/null 2>&1 || true
  exit 0
fi

INSTALL_TIMEOUT_SECS="${DASHBOARD_MCP_INSTALL_TIMEOUT_SECS:-60}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

: "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT is not set}"
[ -n "${CLAUDE_PLUGIN_DATA:-}" ] || fail "CLAUDE_PLUGIN_DATA is not set — this script only runs from the danxbot plugin's hooks"

SPEC="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/dashboard-mcp-package.mjs")" || fail "could not read the dashboard MCP pin from scripts/lib/dashboard-mcp-package.mjs"
PKG_NAME="${SPEC%@*}"
VERSION="${SPEC##*@}"
INSTALL_ROOT="${CLAUDE_PLUGIN_DATA}/dashboard-mcp"
FINAL="${INSTALL_ROOT}/${VERSION}"
BIN_REL="node_modules/${PKG_NAME}/dist/index.js"

if [ -f "${FINAL}/${BIN_REL}" ]; then
  printf '%s' "${FINAL}/${BIN_REL}"
  exit 0
fi

mkdir -p "$INSTALL_ROOT"
STAGE="$(mktemp -d "${INSTALL_ROOT}/.stage-XXXXXX")"
LOG="$(mktemp)"
trap 'rm -rf "$STAGE" "$LOG"' EXIT

# `timeout` bounds the install so an unreachable registry cannot wedge a sub-agent's
# start; with no `timeout` binary at all (stock macOS) it runs unbounded.
INSTALL_RC=0
if command -v timeout >/dev/null 2>&1; then
  timeout "${INSTALL_TIMEOUT_SECS}s" npm install --prefix "$STAGE" --no-audit --no-fund --no-save --loglevel=error "$SPEC" >"$LOG" 2>&1 || INSTALL_RC=$?
else
  npm install --prefix "$STAGE" --no-audit --no-fund --no-save --loglevel=error "$SPEC" >"$LOG" 2>&1 || INSTALL_RC=$?
fi

if [ "$INSTALL_RC" -eq 124 ]; then
  fail "timeout: installing ${SPEC} took longer than ${INSTALL_TIMEOUT_SECS}s"
elif [ "$INSTALL_RC" -ne 0 ]; then
  fail "install_failed: npm install ${SPEC} exited ${INSTALL_RC}: $(grep -v '^[[:space:]]*$' "$LOG" | tail -n 1)"
fi

[ -f "${STAGE}/${BIN_REL}" ] || fail "install_incomplete: npm install ${SPEC} succeeded but left no ${BIN_REL}"

# A concurrent caller may have finished first: its install is just as good, ours is discarded.
if [ ! -d "$FINAL" ]; then
  mv "$STAGE" "$FINAL" 2>/dev/null || true
fi
[ -f "${FINAL}/${BIN_REL}" ] || fail "install_incomplete: could not move the verified install into ${FINAL}"

printf '%s' "${FINAL}/${BIN_REL}"
