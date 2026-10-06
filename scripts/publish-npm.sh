#!/usr/bin/env bash
#
# Publish the danxbot plugin to npm as `@50arms/claude-plugin` (DX-4565).
#
# The plugin is installed from the `50arms` marketplace (repo 50arms/claude-marketplace, whose
# marketplace.json lists it with an npm source), so a release is: bump the version, publish the
# package, push the source. Claude Code takes the installed version from plugin.json, and npm from
# package.json: this script bumps both to the same number and refuses to publish if they differ.
#
# USAGE
#   ./scripts/publish-npm.sh <patch|minor|major> [--dry-run]
#
#   --dry-run   run every check and `npm publish --dry-run`; commit, publish and push nothing.
#               (The integrity manifest is still rewritten in the tree, as in publish.sh.)
#
# NPM_TOKEN must be in the process environment (a `.env` file is not read). Under
# DANX_AGENT_WORKTREE the bump is committed and nothing is published or pushed, exactly like
# scripts/publish.sh, so the one test can run the real script in a throwaway clone.
#
# Modeled on scripts/publish.sh, whose git-marketplace release this replaces for danxbot.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
err() { echo -e "${RED}$*${NC}" >&2; }
info() { echo -e "${YELLOW}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }

PLUGIN="danxbot"
BUMP_TYPE="${1:-}"
DRY_RUN=0
case "$BUMP_TYPE" in patch|minor|major) ;; *) err "Usage: $0 <patch|minor|major> [--dry-run]"; exit 1 ;; esac
shift
for arg in "$@"; do
  case "$arg" in --dry-run) DRY_RUN=1 ;; *) err "Unknown argument: $arg"; exit 1 ;; esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
[ -f "${PLUGIN}/package.json" ] || { err "No ${PLUGIN}/package.json at ${REPO_ROOT}."; exit 1; }
AGENT_RUN="${DANX_AGENT_WORKTREE:-}"

# --- Pre-flight: HEAD must fast-forward origin/main (as publish.sh, DX-4288) -----------
if [ -z "$AGENT_RUN" ]; then
  git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' \
    || { err "Could not fetch origin/main - cannot prove HEAD fast-forwards it. Nothing was bumped or published."; exit 1; }
  if ! git merge-base --is-ancestor origin/main HEAD; then
    err "HEAD ($(git rev-parse --short HEAD)) is not a fast-forward of origin/main ($(git rev-parse --short origin/main)). Rebase, then re-run. Nothing was bumped or published."
    exit 1
  fi
fi

# --- Pre-flight: nothing changed outside the plugin ------------------------------------
while read -r changed; do
  [ -z "$changed" ] && continue
  if [[ "$changed" != "${PLUGIN}/"* ]]; then
    err "Working tree has changes outside ${PLUGIN}/ (${changed}). Commit them first."
    exit 1
  fi
done < <(git status --porcelain | awk '{ print $2 }')

# --- Pre-flight: npm credential (never read from a file, never put on a command line) ---
NPMRC=""
if [ -z "$AGENT_RUN" ]; then
  [ -n "${NPM_TOKEN:-}" ] || { err "NPM_TOKEN is not in the environment. Export it, then re-run. Nothing was bumped or published."; exit 1; }
  NPMRC="$(mktemp)"
  trap 'rm -f "$NPMRC"' EXIT
  # npm expands ${NPM_TOKEN} itself when it reads this file, so the token is never written out.
  printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' > "$NPMRC"
  npm whoami --userconfig "$NPMRC" >/dev/null \
    || { err "npm whoami failed with NPM_TOKEN: the token is invalid or lacks publish rights."; exit 1; }
fi

# --- Pre-flight: frontmatter, hooks modules, integrity manifest, injection budget -------
info "Linting skill/agent frontmatter..."
node "${REPO_ROOT}/scripts/lint-frontmatter.js" "${REPO_ROOT}" || { err "Frontmatter lint failed."; exit 1; }

CLAUDE_CMD="${CLAUDE_BIN:-claude}"
command -v "$CLAUDE_CMD" >/dev/null 2>&1 \
  || { err "Publishing needs the claude CLI to validate and test ${PLUGIN}'s hooks modules, and '${CLAUDE_CMD}' is not on PATH. Set CLAUDE_BIN."; exit 1; }
info "Validating and testing ${PLUGIN}..."
"$CLAUDE_CMD" plugin validate "$PLUGIN" || { err "claude plugin validate ${PLUGIN} failed."; exit 1; }
"$CLAUDE_CMD" plugin test "$PLUGIN" || { err "claude plugin test ${PLUGIN} failed."; exit 1; }

# DX-4551: the shared general-audience scan, before any bump, exactly as publish.sh runs it.
info "Scanning shipped text for author-specific names..."
node "${REPO_ROOT}/scripts/check-general-audience.mjs" "$PLUGIN" \
  || { err "General-audience scan failed (above). Reword the lines named, then re-run publish."; exit 1; }

node "${REPO_ROOT}/scripts/write-integrity-manifest.mjs" "$PLUGIN"
info "Checking injection budget..."
node "${REPO_ROOT}/scripts/check-injection-budget.mjs" || { err "Injection budget check failed."; exit 1; }
info "Auditing the package contents (tarball vs manifest, versions)..."
node "${REPO_ROOT}/scripts/audit-package.mjs" "$PLUGIN" || { err "Package audit failed (above). Nothing was bumped or published."; exit 1; }

if [ "$DRY_RUN" -eq 1 ]; then
  info "Dry run: npm publish --dry-run"
  (cd "$PLUGIN" && npm publish --dry-run --ignore-scripts)
  ok "Dry run clean: nothing committed, published or pushed."
  exit 0
fi

# --- Bump plugin.json and package.json to one version, rebuild the manifest, commit ----
CURRENT="$(node -p "require('./${PLUGIN}/.claude-plugin/plugin.json').version")"
NEXT="$(node -e '
  const [maj, min, pat] = process.argv[1].split(".").map(Number);
  const kind = process.argv[2];
  console.log((kind === "major" ? [maj + 1, 0, 0] : kind === "minor" ? [maj, min + 1, 0] : [maj, min, pat + 1]).join("."));
' "$CURRENT" "$BUMP_TYPE")"
info "  ${PLUGIN}: ${CURRENT} -> ${NEXT}"
for f in "${PLUGIN}/.claude-plugin/plugin.json" "${PLUGIN}/package.json"; do
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    j.version = process.argv[2];
    fs.writeFileSync(process.argv[1], JSON.stringify(j, null, 2) + "\n");
  ' "$f" "$NEXT"
done
node "${REPO_ROOT}/scripts/write-integrity-manifest.mjs" "$PLUGIN"
node "${REPO_ROOT}/scripts/audit-package.mjs" "$PLUGIN" || { err "Post-bump package audit failed. The bump is uncommitted in the tree."; exit 1; }
git add "${PLUGIN}/"
git commit -m "${PLUGIN} v${NEXT}"

if [ -n "$AGENT_RUN" ]; then
  info "DANX_AGENT_WORKTREE set - bump committed; NOT publishing or pushing."
  exit 0
fi

# Publish first: a failed publish leaves only a local commit, never a main that names a version npm lacks.
info "Publishing @50arms/claude-plugin@${NEXT} to npm..."
(cd "$PLUGIN" && npm publish --ignore-scripts --userconfig "$NPMRC")
info "Pushing HEAD to origin/main..."
git push origin HEAD:main

# --- Deliver to this machine and prove it ----------------------------------------------
info "Updating this machine's installed plugin records..."
"${REPO_ROOT}/scripts/update-plugins.sh" || { err "Delivery FAILED: published and pushed, but this machine is not running ${NEXT} yet. Re-run ${REPO_ROOT}/scripts/update-plugins.sh."; exit 1; }
node "${REPO_ROOT}/scripts/verify-delivery.mjs" \
  "${HOME}/.claude/plugins/installed_plugins.json" "${HOME}/.claude/plugins/cache/50arms" "50arms" "$PLUGIN" "$NEXT" \
  || { err "Delivery verification FAILED (above). The registry may not have propagated yet: re-run update-plugins.sh."; exit 1; }
ok "Done: ${PLUGIN} v${NEXT}"
