#!/usr/bin/env bash
# DX-3811: install the recorded `@thehammer/danx-dashboard-mcp` version ONCE into the
# plugin's data dir and print the absolute path of its `dist/index.js`, so a hook
# runs it with plain `node` — never through a cold `npx -y`.
#
# WHY. A hook that ran the package through `npx -y <spec>` paid, measured 2026-10-01 on this
# machine, ~1.6 s with a warm cache and ~4 s cold before the package even started, where the
# same package run by `node` straight from an installed copy took 0.6 s end to end (60 ms node
# start, ~230 ms module load, ~300 ms HTTP). Under concurrent spawns the npx path ran past its
# timeout on about 1 in 9 sub-agents.
#
# WHICH VERSION (DX-4321). The one the plugin recorded at the latest session start
# (`${CLAUDE_PLUGIN_DATA}/dashboard-mcp/current`, written by `lib/dashboard-mcp-package.mjs`
# from the npm registry's `latest`). This script reads that record with no network; a call
# that finds none resolves it through the same module. Only `--prewarm` (below) refreshes it.
#
# WHERE. `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/<version>/node_modules/...` — one
# directory per version, so a version the registry moved to installs lazily into its own
# directory and the previous one is left untouched. A version directory other than the
# recorded one that is over an hour old is removed (the rule the staging cleanup below
# already uses), on a cold install and on `--prewarm`.
#
# WHEN. Wired async at SessionStart (hooks.json, `--prewarm`) so the refresh and the install are
# normally done before the first sub-agent spawns, and called by every script and the plugin's MCP
# server that runs the package, where it is a single file check once installed. A cold first call
# installs synchronously (bounded by INSTALL_TIMEOUT_SECS).
#
# CONCURRENT CALLERS. Several sub-agents can spawn at once. Each installs into its
# own staging directory and only a COMPLETE, verified install is renamed to the
# final path, so no caller ever sees a half-written install. The rename is
# `fs.renameSync`, which REFUSES a destination that already holds an install (unlike
# `mv`, which would nest the stage directory inside it), so the loser of a race
# discards its copy and uses the winner's. A staging directory orphaned by a killed
# install is removed once it is over an hour old (never a concurrent caller's).
#
# Prints the path to stdout (no newline) and exits 0; on failure prints ONE line
# naming the reason to stderr and exits 1.
#
# `--prewarm` (the SessionStart hook): refreshes the recorded version from the registry, then
# the same install and prune, but silent and always exit 0. Nothing reads a prewarm's
# result, and a failure is not lost — the next caller refreshes and runs this script again, and
# reports a failure with its reason.
# `--prune` (what `--prewarm` runs, no refresh): the normal call, and it also prunes.
set -euo pipefail

if [ "${1:-}" = "--prewarm" ]; then
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/dashboard-mcp-package.mjs" --refresh >/dev/null 2>&1 || true
  fi
  bash "$0" --prune >/dev/null 2>&1 || true
  exit 0
fi
PRUNE="0"
if [ "${1:-}" = "--prune" ]; then PRUNE="1"; fi

INSTALL_TIMEOUT_SECS="${DASHBOARD_MCP_INSTALL_TIMEOUT_SECS:-60}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

: "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT is not set}"
[ -n "${CLAUDE_PLUGIN_DATA:-}" ] || fail "CLAUDE_PLUGIN_DATA is not set — this script only runs from the danxbot plugin's hooks"

# The module prints `<name>@<version>` from the record, resolving one first when none exists,
# and on failure ONE line naming the reason (and that nothing can start).
SPEC_ERR="$(mktemp)"
SPEC="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/dashboard-mcp-package.mjs" 2>"$SPEC_ERR")" && SPEC_OK="1" || SPEC_OK="0"
SPEC_REASON="$(cat "$SPEC_ERR" 2>/dev/null || true)"
rm -f "$SPEC_ERR"
[ "$SPEC_OK" = "1" ] || fail "${SPEC_REASON:-could not read the recorded dashboard MCP version from scripts/lib/dashboard-mcp-package.mjs}"
PKG_NAME="${SPEC%@*}"
VERSION="${SPEC##*@}"
INSTALL_ROOT="${CLAUDE_PLUGIN_DATA}/dashboard-mcp"
FINAL="${INSTALL_ROOT}/${VERSION}"
BIN_REL="node_modules/${PKG_NAME}/dist/index.js"

# DX-4321: every version directory but the recorded one, once it is over an hour old.
prune_old_versions() {
  find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name '.*' ! -name "$VERSION" -mmin +60 -exec rm -rf {} + 2>/dev/null || true
}

if [ -f "${FINAL}/${BIN_REL}" ]; then
  if [ "$PRUNE" = "1" ]; then prune_old_versions; fi
  printf '%s' "${FINAL}/${BIN_REL}"
  exit 0
fi

mkdir -p "$INSTALL_ROOT"
find "$INSTALL_ROOT" -maxdepth 1 -name '.stage-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
prune_old_versions
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

# A concurrent caller may have finished first: the rename then fails, its install is
# just as good, and ours is discarded by the exit trap.
node -e 'try { require("fs").renameSync(process.argv[1], process.argv[2]); } catch {}' "$STAGE" "$FINAL"
[ -f "${FINAL}/${BIN_REL}" ] || fail "install_incomplete: could not move the verified install into ${FINAL}"

printf '%s' "${FINAL}/${BIN_REL}"
