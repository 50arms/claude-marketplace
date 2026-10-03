#!/usr/bin/env bash
#
# Publish one or more plugins by bumping their .claude-plugin/plugin.json
# version, committing the bump, and pushing.
#
# WHY THIS EXISTS
# ---------------
# The marketplace loader auto-updates plugins only when the advertised
# `version` field changes. Source-tree edits to skills/rules do NOT
# trigger refresh on consumers — every consumer holds whatever version
# was cached at first install. Without a version bump on every meaningful
# edit, every fix you push silently never reaches dispatched workers /
# host sessions / other developers.
#
# This script makes the bump mandatory + automatic. Mirrors the bump-commit-
# push pattern used by the operator's npm-published packages; no npm publish
# here (plugins distribute via GitHub), so the "publish" action is `git push`
# after the bump commit.
#
# USAGE
# -----
#   ./scripts/publish.sh <patch|minor|major> [plugin ...]
#
# With no plugin args: auto-detects every plugin whose tree has staged
# OR unstaged OR untracked changes since HEAD, bumps each, commits each
# in a separate commit, then pushes once at the end.
#
# With one or more plugin args: bumps ONLY those plugins (skips
# auto-detect, useful when you have changes in plugin A but only want to
# release plugin B's prior committed work).
#
# EXAMPLES
#   ./scripts/publish.sh patch
#   ./scripts/publish.sh minor danxbot
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

err() { echo -e "${RED}$*${NC}" >&2; }
info() { echo -e "${YELLOW}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }

# --- Args ---------------------------------------------------------------

if [ $# -lt 1 ]; then
  err "Usage: $0 <patch|minor|major> [plugin ...]"
  exit 1
fi

BUMP_TYPE="$1"
shift
case "$BUMP_TYPE" in
  patch|minor|major) ;;
  *) err "First arg must be patch|minor|major (got: ${BUMP_TYPE})"; exit 1 ;;
esac

REQUESTED_PLUGINS=("$@")

# --- Locate repo root ---------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f .claude-plugin/marketplace.json ]; then
  err "Not in the claude-plugins repo root (no .claude-plugin/marketplace.json at ${REPO_ROOT})."
  exit 1
fi

# --- Discover all plugin directories from marketplace.json --------------
#
# Marketplace.json is the single source of truth for which dirs are
# plugins. Walk it rather than guessing by directory layout so a future
# plugin nested under a subdir still works without code change.

mapfile -t ALL_PLUGINS < <(
  node -e '
    const m = require("./.claude-plugin/marketplace.json");
    for (const p of m.plugins) {
      // source like "./danxbot" -> "danxbot"
      const dir = p.source.replace(/^\.\//, "");
      console.log(dir);
    }
  '
)

if [ ${#ALL_PLUGINS[@]} -eq 0 ]; then
  err "marketplace.json declares no plugins."
  exit 1
fi

# --- Resolve target plugin set -----------------------------------------

declare -a TARGETS=()

if [ ${#REQUESTED_PLUGINS[@]} -gt 0 ]; then
  # Explicit list — validate each exists in marketplace.
  for p in "${REQUESTED_PLUGINS[@]}"; do
    found=0
    for known in "${ALL_PLUGINS[@]}"; do
      if [ "$p" = "$known" ]; then
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      err "Unknown plugin: ${p}. Known: ${ALL_PLUGINS[*]}"
      exit 1
    fi
    TARGETS+=("$p")
  done
else
  # Auto-detect: any plugin whose subtree has changes vs HEAD (staged,
  # unstaged, OR untracked). We use porcelain output rather than `git
  # diff` so untracked new skill files count too — they're the whole
  # point of bumping the version.
  mapfile -t CHANGED_PATHS < <(git status --porcelain | awk '{ print $2 }')
  if [ ${#CHANGED_PATHS[@]} -eq 0 ]; then
    err "No changes detected. Pass plugin names explicitly to force a bump anyway."
    exit 1
  fi
  for plugin in "${ALL_PLUGINS[@]}"; do
    for path in "${CHANGED_PATHS[@]}"; do
      # Match plugin dir prefix. Trailing slash is required so plugin
      # "dev" doesn't false-match "developer/...". Marketplace plugin
      # names don't currently overlap but the discipline is cheap.
      if [[ "$path" == "${plugin}/"* ]]; then
        TARGETS+=("$plugin")
        break
      fi
    done
  done
  if [ ${#TARGETS[@]} -eq 0 ]; then
    err "Changes detected but none under a known plugin dir. Pass plugin names explicitly."
    exit 1
  fi
fi

info "Plugins to bump (${BUMP_TYPE}): ${TARGETS[*]}"

# --- Pre-flight: HEAD must fast-forward origin/main (DX-4288) ------------
#
# The push below is `git push origin HEAD:main`, so a release can run from any
# checkout (the operator's `main`, or an agent's worktree branch with no upstream),
# with no git config from the caller. That only ships anything if HEAD already
# contains everything on origin/main; a HEAD that does not would either be rejected
# at the push, after the bump commits exist, or (a branch that diverged) publish a
# version built from a stale tree. Refuse here, before any bump, pushing nothing.
# Skipped under DANX_AGENT_WORKTREE: that run never pushes (agent-finalize.sh does).
if [ -z "${DANX_AGENT_WORKTREE:-}" ]; then
  if ! git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main'; then
    err "Could not fetch origin/main - cannot prove HEAD fast-forwards it. Nothing was bumped or pushed."
    exit 1
  fi
  if ! git merge-base --is-ancestor origin/main HEAD; then
    err "HEAD ($(git rev-parse --short HEAD)) is not a fast-forward of origin/main ($(git rev-parse --short origin/main))."
    err "Rebase this branch onto origin/main, then re-run publish. Nothing was bumped or pushed."
    exit 1
  fi
fi

# --- Pre-flight: frontmatter lint ---------------------------------------
#
# DX-2986 — a SKILL.md whose frontmatter isn't valid YAML (or is missing
# name/description, or blows the Claude Code listing's description +
# when_to_use limit) silently drops out of every session's skill list
# with no error anywhere. One shared lint (scripts/lint-frontmatter.js,
# real YAML parser) runs against the WHOLE repo before any bump — never
# per-plugin, so a broken file in a plugin nobody is currently touching
# still blocks the publish that would otherwise ship it unnoticed.

info "Linting skill/agent frontmatter..."
if ! node "${REPO_ROOT}/scripts/lint-frontmatter.js" "${REPO_ROOT}"; then
  err "Frontmatter lint failed (above). Fix the file(s) named, then re-run publish."
  exit 1
fi

# --- Pre-flight: plugin hooks modules (DX-4232) ---------------------------
#
# A plugin whose hooks.json declares "modules" ships native function hooks. The engine loads a
# module whole or not at all, and in the desktop app a module that fails to load says nothing
# visible, so a broken one would reach every session silently. `claude plugin validate` (reads
# the module's source the way the engine will) and `claude plugin test` (runs its *.test.ts[x]
# against the engine) both run BEFORE anything is rewritten or bumped; either failing refuses the
# publish with the tree untouched. CLAUDE_BIN names the CLI when `claude` is not on PATH.

plugin_has_modules() {
  node -e '
    const fs = require("fs");
    const f = process.argv[1] + "/hooks/hooks.json";
    if (!fs.existsSync(f)) process.exit(1);
    const m = JSON.parse(fs.readFileSync(f, "utf8")).modules;
    process.exit(Array.isArray(m) && m.length > 0 ? 0 : 1);
  ' "$1"
}

CLAUDE_CMD="${CLAUDE_BIN:-claude}"
for plugin in "${TARGETS[@]}"; do
  if plugin_has_modules "$plugin"; then
    if ! command -v "$CLAUDE_CMD" >/dev/null 2>&1; then
      err "${plugin} declares hooks modules, so publishing needs the claude CLI to validate and test them, and '${CLAUDE_CMD}' is not on PATH."
      err "Set CLAUDE_BIN to the claude executable, then re-run. Nothing was bumped or pushed."
      exit 1
    fi
    info "Validating ${plugin}'s hooks modules..."
    if ! "$CLAUDE_CMD" plugin validate "$plugin"; then
      err "claude plugin validate ${plugin} failed (above). Fix it, then re-run publish. Nothing was bumped or pushed."
      exit 1
    fi
    info "Testing ${plugin}'s hooks modules..."
    if ! "$CLAUDE_CMD" plugin test "$plugin"; then
      err "claude plugin test ${plugin} failed (above). Fix it, then re-run publish. Nothing was bumped or pushed."
      exit 1
    fi
  fi
done

# --- Integrity manifests -------------------------------------------------
#
# DX-3997 / DX-4244 - a plugin that ships its own integrity launcher
# (scripts/launch.mjs) has a hash manifest its hooks verify before running. The
# manifest is rewritten at two points: BEFORE the injection-budget check below
# (check-injection-budget.mjs runs every marketplace plugin's hooks for real, so a
# stale manifest made each hook print a false "INTEGRITY FAILURE ... git checkout
# -- <plugin>", a fix that would destroy the very edit being published), and AFTER
# the version bump (the bumped plugin.json is itself a hashed file).

write_integrity_manifest_if_shipped() {
  local plugin="$1"
  if [ -f "${plugin}/scripts/launch.mjs" ]; then
    node "${REPO_ROOT}/scripts/write-integrity-manifest.mjs" "$plugin"
  fi
}

for plugin in "${ALL_PLUGINS[@]}"; do
  write_integrity_manifest_if_shipped "$plugin"
done

# --- Pre-flight: injection budget ---------------------------------------
#
# DX-3053 — same shape as the frontmatter lint above: one shared check
# (scripts/check-injection-budget.mjs, real hook execution via
# scripts/measure-injection.mjs) run against the WHOLE repo before any
# bump, so a publish that pushes the per-turn or session-start injection
# total over the DX-3347-derived ceiling is refused before it ships.

info "Checking injection budget..."
if ! node "${REPO_ROOT}/scripts/check-injection-budget.mjs"; then
  err "Injection budget check failed (above). Trim the offending hook(s), then re-run publish."
  exit 1
fi

# --- Pre-flight: working tree must NOT have unrelated changes ----------
#
# We want a clean commit per plugin. If the operator has uncommitted
# changes in plugin A AND plugin B but only asked for A, B's changes
# would land in A's bump commit. Detect + warn.

if [ ${#REQUESTED_PLUGINS[@]} -gt 0 ]; then
  mapfile -t ALL_CHANGED < <(git status --porcelain | awk '{ print $2 }')
  for path in "${ALL_CHANGED[@]}"; do
    matched=0
    for t in "${TARGETS[@]}"; do
      if [[ "$path" == "${t}/"* ]] || [[ "$path" == ".claude-plugin/"* ]]; then
        matched=1
        break
      fi
    done
    if [ "$matched" -eq 0 ]; then
      err "Working tree has changes outside target plugins (${path}). Commit / stash them first or pass the additional plugin name."
      exit 1
    fi
  done
fi

# --- Bump + commit each plugin ----------------------------------------

declare -a BUMPED=()
declare -A BUMPED_VERSION=()

bump_version() {
  local current="$1"
  local kind="$2"
  node -e "
    const [maj, min, pat] = process.argv[1].split('.').map(Number);
    const kind = process.argv[2];
    let v;
    if (kind === 'patch') v = [maj, min, pat + 1];
    else if (kind === 'minor') v = [maj, min + 1, 0];
    else if (kind === 'major') v = [maj + 1, 0, 0];
    else { console.error('bad kind'); process.exit(1); }
    console.log(v.join('.'));
  " "$current" "$kind"
}

for plugin in "${TARGETS[@]}"; do
  manifest="${plugin}/.claude-plugin/plugin.json"
  if [ ! -f "$manifest" ]; then
    err "Missing manifest: ${manifest}"
    exit 1
  fi
  current=$(node -p "require('./${manifest}').version")
  if [ -z "$current" ]; then
    err "No version field in ${manifest}"
    exit 1
  fi
  next=$(bump_version "$current" "$BUMP_TYPE")
  info "  ${plugin}: ${current} -> ${next}"

  # Rewrite the file via node so other fields + formatting are stable.
  node -e "
    const fs = require('fs');
    const path = process.argv[1];
    const ver = process.argv[2];
    const j = JSON.parse(fs.readFileSync(path, 'utf8'));
    j.version = ver;
    fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
  " "$manifest" "$next"

  # DX-3997 - rewritten here, after the bump (the bumped plugin.json is one of the hashed
  # files) and before the commit, so the manifest in every published version matches that
  # version's tree byte for byte.
  write_integrity_manifest_if_shipped "$plugin"

  # Stage + commit JUST the plugin's tree + manifest. Other plugins'
  # untouched manifests stay out of this commit.
  git add "$manifest" "$plugin/"
  git commit -m "${plugin} v${next}"
  BUMPED+=("${plugin} v${next}")
  BUMPED_VERSION["$plugin"]="$next"
done

# Push — UNLESS we are running inside a danxbot agent worktree.
#
# A dispatched danxbot agent works on branch `<agent>` in a worktree, not
# `main`. A push of the branch name from there lands the bump commit on
# `origin/<agent>` — never `origin/main` — so it ships NOTHING to
# consumers (the marketplace version-compares `main`). When DANX_AGENT_WORKTREE
# is set we therefore leave the bump committed on the agent branch and let
# `.danxbot/scripts/agent-finalize.sh` do the real push (`HEAD:main`, with a
# rebase-race loop). Operator/main-session runs (no DANX_AGENT_WORKTREE) push
# normally, with the explicit `HEAD:main` push below (DX-4288).
if [ -n "${DANX_AGENT_WORKTREE:-}" ]; then
  info "DANX_AGENT_WORKTREE set — bump committed on this branch; NOT pushing."
  info "Run .danxbot/scripts/agent-finalize.sh to squash + push HEAD:main."
else
  # DX-4288: explicit `origin HEAD:main`, never a bare `git push` - a fresh worktree
  # branch has no upstream, and one with the wrong upstream/push.default would push a
  # stray branch instead of main. The pre-flight above proved HEAD fast-forwards main.
  info "Pushing HEAD to origin/main..."
  git push origin HEAD:main

  # Refresh THIS machine's local marketplace clone so the just-pushed
  # version is loadable in the current session.
  #
  # CC HARNESS BUG (verified 2026-06-22): `/reload-plugins` + `autoUpdate:
  # true` READ the local marketplace clone but NEVER `git pull` it. If the
  # clone sits behind origin, `/reload-plugins` rebuilds the cache from the
  # OLD commit and the version we just published never loads — the publish
  # looks shipped, ships nowhere into the session. We pull the clone here so
  # the operator's `/reload-plugins` immediately picks up the new version.
  # (Consumer-only machines that did NOT run this script still must pull
  # their own clone before `/reload-plugins` — same bug, different host.)
  MARKETPLACE_NAME="$(node -p "require('./.claude-plugin/marketplace.json').name" 2>/dev/null || true)"
  CLONE_DIR="${HOME}/.claude/plugins/marketplaces/${MARKETPLACE_NAME}"
  if [ -n "$MARKETPLACE_NAME" ] && [ -d "${CLONE_DIR}/.git" ]; then
    info "Refreshing local marketplace clone (${CLONE_DIR}) — works around the /reload-plugins no-pull bug..."
    if git -C "$CLONE_DIR" pull --ff-only >/dev/null 2>&1; then
      ok "Marketplace clone current — run /reload-plugins to load the new version."
    else
      err "WARN: could not ff-pull ${CLONE_DIR}. Pull it by hand, THEN /reload-plugins:"
      err "  git -C ${CLONE_DIR} pull --ff-only && # then /reload-plugins"
    fi
  else
    info "No local marketplace clone at ${CLONE_DIR} — skipping refresh (nothing cached on this machine)."
  fi
fi

# Move THIS machine's installed-plugin records onto the versions just
# published. Without this the bump reaches GitHub and every local project
# keeps loading whatever version it cached earlier — the failure this repo
# hit for two months. See scripts/update-plugins.sh for why it can't be left
# to Claude Code's own auto-update here.
#
# DX-3057 — a failure here used to be a soft "WARN ... the publish itself
# succeeded", which is exactly backwards: "succeeded" from a consumer's
# point of view means the published version is actually running, not that
# `git push` returned 0. Both this delivery step AND its own outcome are
# now checked, and either one failing exits this script non-zero with a
# message that says plainly the change is NOT live on this machine yet.
if [ -z "${DANX_AGENT_WORKTREE:-}" ] && [ -x "${REPO_ROOT}/scripts/update-plugins.sh" ]; then
  info "Updating this machine's installed plugin records..."
  if ! "${REPO_ROOT}/scripts/update-plugins.sh"; then
    err "Plugin delivery FAILED (above) — the bump was pushed to origin/main, but this"
    err "machine is NOT running it yet. Fix the failure above, then re-run:"
    err "  ${REPO_ROOT}/scripts/update-plugins.sh"
    exit 1
  fi

  # Post-delivery check (AC3): prove delivery instead of assuming it. For
  # each plugin just bumped, compare the version this publish JUST pushed
  # against what THIS machine actually has.
  #
  # DX-3057: Check EVERY live install-scope row (user-scope + all project-scope
  # rows whose projectPath exists on disk), not just user-scope. A row whose
  # projectPath no longer exists on disk is skipped with an informational message.
  # All other rows must have the version we just published. Errors are reported
  # loud, not swallowed into "?" placeholders.
  #
  # DX-3057: this used to shell out through `while ... done < <(node -e '...')`
  # — a process substitution, whose exit status bash silently discards. A
  # node-side process.exit(1) (unreadable file, no rows, no cache) printed to
  # stderr but never flipped DELIVERY_FAILED, so publish.sh reported SUCCESS
  # even when this machine wasn't running the published version. The checker
  # is now one script (scripts/verify-delivery.mjs) called directly, and its
  # exit status is tested with `if ! ... ; then` — nothing hides it.
  info "Verifying delivered versions..."
  DELIVERY_FAILED=0
  for plugin in "${TARGETS[@]}"; do
    expected="${BUMPED_VERSION[$plugin]}"
    if ! node "${REPO_ROOT}/scripts/verify-delivery.mjs" \
      "${HOME}/.claude/plugins/installed_plugins.json" \
      "${HOME}/.claude/plugins/cache/${MARKETPLACE_NAME}" \
      "${MARKETPLACE_NAME}" "$plugin" "$expected"; then
      DELIVERY_FAILED=1
    fi
  done
  
  if [ "$DELIVERY_FAILED" -eq 1 ]; then
    err "Plugin delivery verification FAILED — the bump was pushed to origin/main, but at"
    err "least one plugin above is NOT running the published version on this machine, in"
    err "some scope (see the row-level MISMATCH above for exactly which scope/project)."
    err "Re-run '${REPO_ROOT}/scripts/update-plugins.sh' — it handles every scope (user AND"
    err "project) — then re-run publish.sh (or just this machine's delivery) to confirm."
    exit 1
  fi
fi

ok "Done:"
for line in "${BUMPED[@]}"; do
  echo "  - $line"
done
