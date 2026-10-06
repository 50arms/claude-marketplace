#!/usr/bin/env bash
#
# DX-4565 - deliver the danxbot plugin to the public 50 Arms marketplace.
#
# WHY A COPY, NOT A POINTER
# -------------------------
# `50arms/claude-marketplace` is what testers install from
# (`claude plugin marketplace add 50arms/claude-marketplace`, `claude plugin install danxbot@50arms`).
# Its catalog names the plugin by the relative path `./danxbot`, the one source form where Claude Code
# keeps the whole marketplace clone on disk, with the plugin's files inside it. danxbot's own boot reads
# the plugin from that clone (`~/.claude/plugins/marketplaces/50arms/danxbot`) and checks its git HEAD
# against `git ls-remote`; the integrity launcher restores a damaged cache file from the same clone. A
# pointer to this repo (a `github` or `git-subdir` source) would leave the clone holding only the catalog.
#
# This repo stays the ONE place the plugin is edited. This script turns a commit of it into the
# marketplace repo's next commit: the `danxbot/` tree (tests excluded, as in the integrity manifest) plus
# the catalog in `50arms-marketplace/`, byte for byte. Nothing in the marketplace repo is hand-edited.
#
# USAGE
#   scripts/publish-marketplace.sh
# ENV
#   MARKETPLACE_REMOTE  git remote of the marketplace repo (default: the 50arms repo over this machine's SSH alias)
#   CLAUDE_BIN          the claude executable when `claude` is not on PATH (runs `claude plugin validate`)
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
err() { echo -e "${RED}$*${NC}" >&2; }
info() { echo -e "${YELLOW}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }

PLUGIN="danxbot"
CATALOG_DIR="50arms-marketplace"
REMOTE="${MARKETPLACE_REMOTE:-git@github.com-newms87:50arms/claude-marketplace.git}"
CLAUDE_CMD="${CLAUDE_BIN:-claude}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The copy is made from a commit, so the commit must be one a reader of the marketplace repo can find:
# contained in a pushed branch. An unpushed HEAD would publish a tree nobody can reproduce.
git fetch --quiet origin
if [ -z "$(git branch -r --contains HEAD)" ]; then
  err "HEAD ($(git rev-parse --short HEAD)) is on no pushed branch. Push it, then re-run. Nothing was published."
  exit 1
fi
# `git archive` reads HEAD, so an uncommitted edit would be silently left out of the copy.
if [ -n "$(git status --porcelain -- "$PLUGIN" "$CATALOG_DIR")" ]; then
  err "${PLUGIN}/ or ${CATALOG_DIR}/ has uncommitted changes. Commit them, then re-run. Nothing was published."
  exit 1
fi
if ! command -v "$CLAUDE_CMD" >/dev/null 2>&1; then
  err "'${CLAUDE_CMD}' is not on PATH, and the copy is validated with 'claude plugin validate'. Set CLAUDE_BIN to the claude executable. Nothing was published."
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
MARKET="${WORK}/marketplace"

info "Cloning ${REMOTE}..."
git clone --quiet "$REMOTE" "$MARKET"
git -C "$MARKET" checkout --quiet -B main

# Replace everything but .git, so a file deleted here is deleted there.
find "$MARKET" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive --format=tar HEAD "$CATALOG_DIR" | tar -x -C "$MARKET" --strip-components=1
git archive --format=tar HEAD "$PLUGIN" ":(exclude)${PLUGIN}/tests" | tar -x -C "$MARKET"

# Paths handed to node come from git, which prints the form node itself reads (a Git Bash `/tmp/...` is not one on Windows).
NODE_ROOT="$(git rev-parse --show-toplevel)"
NODE_MARKET="$(git -C "$MARKET" rev-parse --show-toplevel)"
VERSION="$(node -p "require('${NODE_MARKET}/${PLUGIN}/.claude-plugin/plugin.json').version")"

# The copy must carry the plugin exactly as published here: every file the integrity manifest names has
# the manifest's hash. A stale manifest would make every tester's hooks report a corrupt install.
node --input-type=module - "$NODE_ROOT" "${NODE_MARKET}/${PLUGIN}" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repoRoot, pluginDir] = process.argv.slice(2);
const { sha256File } = await import(pathToFileURL(path.join(repoRoot, "scripts", "write-integrity-manifest.mjs")).href);
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "integrity-manifest.json"), "utf8"));
const bad = Object.entries(manifest.files).filter(([rel, hash]) => !fs.existsSync(path.join(pluginDir, rel)) || sha256File(path.join(pluginDir, rel)) !== hash);
if (bad.length > 0) {
  console.error(`The copy does not match integrity-manifest.json: ${bad.map(([rel]) => rel).join(", ")}. Run scripts/publish.sh (it rewrites the manifest), then re-run.`);
  process.exit(1);
}
NODE

info "Validating the marketplace copy..."
"$CLAUDE_CMD" plugin validate "$MARKET"

git -C "$MARKET" add -A
if git -C "$MARKET" diff --cached --quiet; then
  ok "Marketplace already holds ${PLUGIN} v${VERSION} from this tree: $(git -C "$MARKET" rev-parse HEAD 2>/dev/null || echo 'no commits')"
  exit 0
fi

SOURCE_SHA="$(git rev-parse HEAD)"
git -C "$MARKET" commit --quiet -m "${PLUGIN} v${VERSION}" -m "Copied from the plugin source repo at ${SOURCE_SHA}."
git -C "$MARKET" push --quiet origin HEAD:main
ok "Published ${PLUGIN} v${VERSION} to ${REMOTE}: $(git -C "$MARKET" rev-parse HEAD)"
