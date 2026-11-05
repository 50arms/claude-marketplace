#!/usr/bin/env bash
#
# Bring every installed Claude Code plugin on this machine up to the version
# its marketplace currently advertises.
#
# WHY THIS EXISTS
# ---------------
# Claude Code's built-in plugin auto-update is disabled in this environment:
# the desktop app launches its CLI with DISABLE_AUTOUPDATER=1, which the docs
# state disables automatic updates "for both Claude Code and all plugins".
# `autoUpdate: true` on the marketplace entry never gets a chance to run.
#
# The visible symptom is nasty precisely because nothing errors: plugin
# versions are recorded PER PROJECT in ~/.claude/plugins/installed_plugins.json,
# so one project silently keeps loading months-old skills, rules and hooks
# while another project on the same machine runs current ones. Sessions look
# healthy the whole time. This machine sat on base v0.3.15 (June 9) in one
# project and v0.3.27 in another before anyone noticed.
#
# See also: https://github.com/anthropics/claude-code/issues/52218 — even with
# auto-update working, Claude Code may promote a plugin's runtime version
# without rewriting installed_plugins.json, leaving plugin-bundled HOOKS
# pinned to the stale installPath. Driving `claude plugin update` directly, as
# this script does, rewrites the record and so is immune to that bug.
#
# WHAT IT DOES
# ------------
#   1. Fast-forwards every marketplace clone under ~/.claude/plugins/marketplaces/
#      (Claude Code's own background refresh does not reliably git-pull these).
#   2. Runs `claude plugin update <plugin> --scope <scope>` once per installed
#      row, from that row's project directory, so project-scoped installs
#      resolve to the right project.
#
# Version comparison is deliberately NOT reimplemented here — the CLI already
# owns that logic and skips a plugin that is current. Running it per row is
# idempotent.
#
# Updates apply to the NEXT session; a running session keeps the versions it
# loaded at launch. That is Claude Code's own model, not a limitation of this
# script.
#
# USAGE
# -----
#   ./scripts/update-plugins.sh [--dry-run] [--quiet]
#
#   --dry-run          Report what would be updated; run no update, pull no clone.
#   --quiet            Suppress per-row progress; print only summary and errors.
#   --throttle <secs>  Exit 0 immediately if a run finished less than <secs>
#                      ago. For the SessionStart hook, so opening ten sessions
#                      an hour does not mean ten full update sweeps.
#
# Concurrent runs are serialized by a lock: a second invocation while one is
# running exits 0 without doing anything, rather than racing the first one's
# rewrite of installed_plugins.json.
#
# Exit status is 0 only when every row updated or was already current. A row
# that fails — including a plugin its marketplace no longer lists — exits 1
# and names the row, rather than being swallowed as "nothing to do".
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGINS_DIR="$CLAUDE_DIR/plugins"
INSTALLED_FILE="$PLUGINS_DIR/installed_plugins.json"
MARKETPLACES_DIR="$PLUGINS_DIR/marketplaces"
LOG_FILE="$PLUGINS_DIR/.plugin-update.log"
STAMP_FILE="$PLUGINS_DIR/.plugin-update.stamp"
LOCK_FILE="$PLUGINS_DIR/.plugin-update.lock"

DRY_RUN=0
QUIET=0
THROTTLE=0

# Kept for the lock re-exec below, which needs the original argv after the
# parse loop below has shifted it away.
ORIG_ARGS=("$@")

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY_RUN=1 ;;
    --quiet)    QUIET=1 ;;
    --throttle) shift; THROTTLE="${1:-0}" ;;
    -h|--help)  sed -n '2,60p' "$0"; exit 0 ;;
    *) echo -e "${RED}Unknown option: ${1}${NC}" >&2; exit 1 ;;
  esac
  shift
done

if ! [[ "$THROTTLE" =~ ^[0-9]+$ ]]; then
  echo -e "${RED}--throttle takes a number of seconds (got: ${THROTTLE})${NC}" >&2
  exit 1
fi

err()  { echo -e "${RED}$*${NC}" >&2; }
ok()   { echo -e "${GREEN}$*${NC}"; }
info() { [ "$QUIET" -eq 1 ] || echo -e "${YELLOW}$*${NC}"; }
dim()  { [ "$QUIET" -eq 1 ] || echo -e "${DIM}$*${NC}"; }

log() { printf '%s\n' "$*" >> "$LOG_FILE"; }

# --- Preconditions ------------------------------------------------------
#
# Fail loud on a missing prerequisite. A silent no-op here would recreate the
# exact class of failure this script exists to end: everything looks fine,
# nothing is actually updated.
#
# DX-3057 — a session spawned by the Claude Code desktop app (the normal way
# this script gets run, via `scripts/publish.sh` from inside a session) does
# NOT put `claude` on PATH for its Bash/PowerShell tool shells. Confirmed on
# this machine: `command -v claude` and `where claude` both fail, `claude
# --version` is "command not found" — in a shell that has
# CLAUDE_CODE_EXECPATH=C:\...\claude-code\2.1.280\claude.exe set and working.
# That env var is exactly what the app itself used to launch this session's
# claude process, so it is the correct binary to drive `plugin update` with.
# Every consumer machine that is NOT inside a desktop-app session (a bare
# terminal with the CLI installed the traditional way, CI, etc.) has no such
# var and falls back to the PATH lookup exactly as before.
if [ -n "${CLAUDE_CODE_EXECPATH:-}" ] && [ -x "${CLAUDE_CODE_EXECPATH}" ]; then
  CLAUDE_BIN="${CLAUDE_CODE_EXECPATH}"
elif command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="claude"
else
  err "No usable 'claude' CLI found — not on PATH, and \$CLAUDE_CODE_EXECPATH is unset or not executable."
  err "  \$CLAUDE_CODE_EXECPATH=${CLAUDE_CODE_EXECPATH:-<unset>}"
  exit 1
fi

if [ ! -f "$INSTALLED_FILE" ]; then
  err "No installed-plugins record at ${INSTALLED_FILE}."
  exit 1
fi

# --- Throttle + lock ----------------------------------------------------
#
# Both guards exist for the SessionStart hook, where many sessions can start
# close together. Throttle skips redundant sweeps; the lock keeps two sweeps
# from rewriting installed_plugins.json at the same time. Neither applies to
# a dry run, which writes nothing.

if [ "$DRY_RUN" -eq 0 ]; then
  if [ "$THROTTLE" -gt 0 ] && [ -f "$STAMP_FILE" ]; then
    last="$(cat "$STAMP_FILE" 2>/dev/null || echo 0)"
    if [[ "$last" =~ ^[0-9]+$ ]] && [ $(( $(date +%s) - last )) -lt "$THROTTLE" ]; then
      # Log the skip, not just the sweep. Without this line a throttled run
      # leaves no trace at all, so "the hook never fired" and "the hook fired
      # and correctly skipped" are indistinguishable — which is exactly the
      # question the log has to be able to answer.
      log "=== $(date -Is) update-plugins.sh SKIPPED (throttle ${THROTTLE}s, last ran $(( ($(date +%s) - last) / 60 ))m ago) ==="
      dim "Last update ran $(( ($(date +%s) - last) / 60 ))m ago (throttle ${THROTTLE}s) — skipping."
      exit 0
    fi
  fi

  # Re-run under an exclusive lock. Non-blocking: a concurrent run means the
  # work is already happening, so this invocation has nothing useful to add.
  # -E 75 gives lock contention its own exit code, so it can't be confused
  # with this script's own exit 1 (a row that failed to update).
  if [ -z "${PLUGIN_UPDATE_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
    export PLUGIN_UPDATE_LOCKED=1
    set +e
    flock --nonblock -E 75 "$LOCK_FILE" "$0" "${ORIG_ARGS[@]}"
    rc=$?
    set -e
    if [ "$rc" -eq 75 ]; then
      log "=== $(date -Is) update-plugins.sh SKIPPED (lock held by another run) ==="
      dim "Another plugin update is already running — skipping."
      exit 0
    fi
    exit "$rc"
  fi
fi

log "=== $(date -Is) update-plugins.sh (dry-run=${DRY_RUN}) ==="

# --- Step 1: fast-forward the marketplace clones ------------------------
#
# `claude plugin update` compares against the local clone, so a stale clone
# makes every plugin look current. Claude Code's background refresh does not
# reliably fetch these clones, so pull them here first.

if [ -d "$MARKETPLACES_DIR" ]; then
  for clone in "$MARKETPLACES_DIR"/*/; do
    [ -d "${clone}.git" ] || continue
    name="$(basename "$clone")"
    if [ "$DRY_RUN" -eq 1 ]; then
      dim "  would pull marketplace: ${name}"
      continue
    fi
    if git -C "$clone" pull --ff-only >/dev/null 2>&1; then
      dim "  pulled marketplace: ${name}"
      log "  pulled: ${name}"
    else
      # Not fatal: a clone may be detached, offline, or seed-managed and
      # read-only. The plugin updates below still run against whatever the
      # clone currently holds — but say so rather than pass silently.
      info "  WARN: could not fast-forward marketplace clone '${name}'"
      log "  pull-failed: ${name}"
    fi
  done
fi

# --- Step 2: update every installed row ---------------------------------
#
# Rows are (plugin, scope, projectPath). Project- and local-scope rows are
# updated from inside their project directory, which is how the CLI resolves
# WHICH project's record to rewrite.

# The row extraction needs a JSON parser, and WHICH ONE is a host question.
# Probe by RUNNING each candidate, never by `command -v`: on Windows, `python3`
# resolves to a Microsoft Store alias that exists on PATH and then refuses to
# run, so a presence check reports an interpreter that cannot parse anything.
# Node is tried first — it is the runtime this ecosystem already assumes.
#
# Neither available is a HARD failure that names the real cause. The previous
# version simply got no rows out of the process substitution and reported
# "No plugin rows found — nothing to update", which reads as "your records are
# empty" on a machine holding fifteen of them: the publish looks finished while
# every project stays pinned to the old version. That is the exact failure this
# script exists to prevent.

read -r -d '' EXTRACT_JS <<'EXTRACT_JS_EOF' || true
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const seen = new Set();
for (const [name, entries] of Object.entries(data.plugins || {})) {
  for (const entry of entries || []) {
    // "-" marks "no project path" (user scope). An empty field cannot be used:
    // tab is IFS-whitespace, so bash's `read` collapses a run of tabs and would
    // shift every later field left by one.
    const row = [name, entry.scope || "user", entry.projectPath || "-", entry.version || "?"];
    const key = row.join(String.fromCharCode(0));
    if (seen.has(key)) continue;
    seen.add(key);
    process.stdout.write(row.join(String.fromCharCode(9)) + String.fromCharCode(10));
  }
}
EXTRACT_JS_EOF

read -r -d '' EXTRACT_PY <<'EXTRACT_PY_EOF' || true
import json, sys

with open(sys.argv[1]) as fh:
    data = json.load(fh)

seen = set()
for name, entries in data.get("plugins", {}).items():
    for entry in entries:
        row = (name, entry.get("scope", "user"), entry.get("projectPath") or "-", entry.get("version", "?"))
        if row in seen:
            continue
        seen.add(row)
        print(chr(9).join(row))
EXTRACT_PY_EOF

if node -e '' >/dev/null 2>&1; then
  mapfile -t ROWS < <(node -e "$EXTRACT_JS" "$INSTALLED_FILE")
elif python3 -c '' >/dev/null 2>&1; then
  mapfile -t ROWS < <(python3 -c "$EXTRACT_PY" "$INSTALLED_FILE")
else
  err "Neither 'node' nor 'python3' can run here — cannot read ${INSTALLED_FILE}."
  err "Install either one, or update the records by hand:"
  err "  claude plugin update <plugin>@<marketplace> --scope user"
  exit 1
fi

if [ ${#ROWS[@]} -eq 0 ]; then
  err "No plugin rows found in ${INSTALLED_FILE} — nothing to update."
  exit 1
fi

declare -a UPDATED=()
declare -a CURRENT=()
declare -a FAILED=()
declare -a SKIPPED=()
declare -a DEAD_PROJECTS=()

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r plugin scope project version <<<"$row"

  target_dir="$HOME"
  where="${scope}"
  if [ "$project" != "-" ]; then
    if [ ! -d "$project" ]; then
      # The project directory is gone; its record can never resolve again.
      # DX-3228 — this used to be a permanent, silent-forever SKIP: the row
      # stayed in installed_plugins.json and printed the same warning on
      # every future run (observed: 5 rows for one deleted ad-hoc worktree,
      # naming all 5 plugins, on every publish for a day). Ad-hoc worktrees
      # under `.claude/worktrees/<n>` are created and removed constantly
      # (see 50 Arms' `.claude/rules/adhoc-worktree-cleanup.md`), and every
      # one that ever received a plugin install leaves a row exactly like
      # this behind — so the warning was guaranteed to recur forever, not a
      # one-off. The removal side (whichever tool deleted the worktree) has
      # no reason to know Claude Code plugin registrations exist at all, and
      # coordinating every worktree-owning repo's cleanup tool with this
      # machine-global file would multiply the fix by however many repos
      # create worktrees. This script already discovers every dead row on
      # every run, machine-wide, regardless of which repo or tool created
      # it — so it is pruned here (Step 3 below) instead of warned about
      # indefinitely. Recorded so the pass that finds it can still say so.
      SKIPPED+=("${plugin} [${scope}] — project path missing, pruning: ${project}")
      DEAD_PROJECTS+=("${project}")
      continue
    fi
    target_dir="$project"
    # Two projects can hold rows for the same plugin at the same scope, so the
    # project name has to be in every line that names a row.
    where="${scope} @ $(basename "$project")"
  fi
  label="${plugin} [${where}] ${version}"

  if [ "$DRY_RUN" -eq 1 ]; then
    dim "  would update: ${label}"
    continue
  fi

  info "  checking ${label}"
  if output="$(cd "$target_dir" && "$CLAUDE_BIN" plugin update "$plugin" --scope "$scope" 2>&1)"; then
    log "  ok: ${label} :: ${output//$'\n'/ }"
    if grep -qiE 'updated from' <<<"$output"; then
      UPDATED+=("${plugin} [${where}] $(grep -oiE 'from [^ ]+ to [^ ]+' <<<"$output" | head -1)")
    else
      CURRENT+=("${plugin} [${where}]")
    fi
  else
    log "  FAILED: ${label} :: ${output//$'\n'/ }"
    FAILED+=("${plugin} [${where}] — ${output//$'\n'/ }")
  fi
done

# --- Step 3: prune dead project-scope rows -------------------------------
#
# DX-3228 — a row whose projectPath no longer exists (SKIPPED above) can
# never resolve again, ever, so leaving it in installed_plugins.json just
# means the same SKIPPED warning fires on every future run forever. Prune
# it instead. Runs after the update loop, not interleaved with it, so a
# single rewrite of installed_plugins.json covers every dead row found this
# pass rather than racing N separate read-modify-writes.
#
# Re-derives "dead" from a fresh fs check inside the node/python step below
# (never from the bash DEAD_PROJECTS array's string contents) — the array
# above exists only to decide WHETHER to bother invoking this step at all,
# not as the source of truth for WHICH rows to drop, since that keeps this
# step correct even if it is ever called on a stale/edited copy of the
# file. Dry runs prune nothing, matching every other write in this script.
if [ "$DRY_RUN" -eq 0 ] && [ ${#DEAD_PROJECTS[@]} -gt 0 ]; then
  read -r -d '' PRUNE_JS <<'PRUNE_JS_EOF' || true
const fs = require("fs");
const file = process.argv[1];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
let pruned = 0;
for (const entries of Object.values(data.plugins || {})) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const p = entries[i].projectPath;
    if (p && !fs.existsSync(p)) {
      entries.splice(i, 1);
      pruned++;
    }
  }
}
if (pruned > 0) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
process.stdout.write(String(pruned));
PRUNE_JS_EOF

  read -r -d '' PRUNE_PY <<'PRUNE_PY_EOF' || true
import json, os, sys

file = sys.argv[1]
with open(file) as fh:
    data = json.load(fh)

pruned = 0
for entries in data.get("plugins", {}).values():
    kept = []
    for entry in entries:
        p = entry.get("projectPath")
        if p and not os.path.exists(p):
            pruned += 1
            continue
        kept.append(entry)
    entries[:] = kept

if pruned > 0:
    with open(file, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")

sys.stdout.write(str(pruned))
PRUNE_PY_EOF

  if node -e '' >/dev/null 2>&1; then
    pruned_count="$(node -e "$PRUNE_JS" "$INSTALLED_FILE")"
  elif python3 -c '' >/dev/null 2>&1; then
    pruned_count="$(python3 -c "$PRUNE_PY" "$INSTALLED_FILE")"
  else
    pruned_count=""
  fi

  if [[ "$pruned_count" =~ ^[0-9]+$ ]] && [ "$pruned_count" -gt 0 ]; then
    log "  pruned ${pruned_count} dead row(s) from ${INSTALLED_FILE}"
    ok "Pruned ${pruned_count} dead row(s) (project path no longer exists) from installed_plugins.json."
  elif [ -z "$pruned_count" ]; then
    # Same "neither interpreter available" case as row extraction above —
    # not fatal here (the update sweep itself already succeeded), but the
    # dead rows survive to warn again next run rather than being silently
    # assumed gone.
    info "  WARN: could not prune dead rows — neither 'node' nor 'python3' available."
  fi
fi

# --- Summary ------------------------------------------------------------

# Stamp on any completed sweep, including one with failed rows — otherwise a
# permanently-broken row (a plugin its marketplace dropped) would defeat the
# throttle and re-sweep on every single session start.
[ "$DRY_RUN" -eq 1 ] || date +%s > "$STAMP_FILE"

for line in "${SKIPPED[@]}"; do info "SKIPPED: ${line}"; done

if [ "$DRY_RUN" -eq 1 ]; then
  ok "Dry run complete — $(( ${#ROWS[@]} - ${#SKIPPED[@]} )) of ${#ROWS[@]} installed rows would be checked."
  exit 0
fi

if [ ${#UPDATED[@]} -gt 0 ]; then
  ok "Updated ${#UPDATED[@]}:"
  for line in "${UPDATED[@]}"; do echo "  - $line"; done
  ok "Restart Claude Code (or /reload-plugins) to load the new versions."
else
  [ "$QUIET" -eq 1 ] || ok "All ${#CURRENT[@]} plugins already current."
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  err "Failed ${#FAILED[@]}:"
  for line in "${FAILED[@]}"; do err "  - $line"; done
  err "A row that no longer exists in its marketplace stays failed until it is uninstalled."
  exit 1
fi

exit 0
