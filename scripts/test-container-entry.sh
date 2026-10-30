#!/usr/bin/env bash
# DX-5648 - runs INSIDE the test container scripts/test-in-container.mjs creates, after it copied the source in. Never run it anywhere
# else. The arguments are test files: none runs the whole suite (the node suites, then the plugin's function-hook tests); named
# .mjs files run under `node --test`, named .tsx files under `claude plugin test`.
set -euo pipefail
cd /app

# Named files are validated first, before anything is written or deleted.
mjs=()
tsx=()
for file in "$@"; do
  case "$file" in
    *.test.mjs) mjs+=("$file") ;;
    *.test.tsx) tsx+=("$file") ;;
    *) echo "test-container-entry: $file is not a test file (*.test.mjs or *.test.tsx)" >&2; exit 2 ;;
  esac
  # A named file that matches nothing must stop the run: deleting every other .tsx test for it would end green with nothing run.
  [ -f "$file" ] || { echo "test-container-entry: $file does not exist in the test copy" >&2; exit 2; }
done

# The .tsx tests cannot check where they run (the plugin test runner gives a test no process and no filesystem), so each imports
# <plugin>/tests/run-tests-with-npm-test.generated.ts first, a module that exists ONLY here: written below, after the root-owned marker
# is checked, for every plugin whose hooks.json declares modules (the set publish.sh validates). It is gitignored, so the tar copy a host
# streams in never carries it, and a .tsx test run on a host fails to resolve that import before any test runs.
MARKER=/etc/claude-plugins/test-environment
if [ "$(uname -s)" != "Linux" ] || [ "$(stat -c %u "$MARKER" 2>/dev/null || echo none)" != "0" ]; then
  echo "test-container-entry: this is not the designated test container (no root-owned $MARKER)" >&2
  exit 2
fi
mapfile -t plugins < <(node scripts/lib/plugins-with-modules.mjs .)
for plugin in "${plugins[@]}"; do
  mkdir -p "$plugin/tests"
  printf '%s\n%s\n' "// DX-5648: written by scripts/test-container-entry.sh inside the designated test container only; gitignored." \
    "export const inDesignatedTestContainer = true" > "$plugin/tests/run-tests-with-npm-test.generated.ts"
done

# The delivery and publish suites clone this checkout, so it needs a repository whose HEAD is exactly the copied tree.
git init -q -b main
git add -A
git -c user.name=claude-plugins-test -c user.email=test@localhost -c commit.gpgsign=false commit -q --no-verify -m "DX-5648 test snapshot of the copied checkout"

whole=0
if [ $# -eq 0 ]; then
  whole=1
  mjs=("scripts/tests/*.test.mjs")
  for plugin in "${plugins[@]}"; do mjs+=("$plugin/tests/*.test.mjs"); done
fi

status=0
if [ ${#mjs[@]} -gt 0 ]; then
  node --test "${mjs[@]}" || status=$?
fi
if [ "$whole" -eq 1 ]; then
  for plugin in "${plugins[@]}"; do claude plugin test "$plugin" || status=$?; done
elif [ ${#tsx[@]} -gt 0 ]; then
  # `claude plugin test <dir>` runs every *.test.tsx under the plugin and takes no file filter, so the named files are the only ones left
  # in this container's disposable copy.
  while IFS= read -r existing; do
    keep=0
    for named in "${tsx[@]}"; do [ "$existing" = "$named" ] && keep=1; done
    [ "$keep" -eq 1 ] || rm "$existing"
  done < <(find "${plugins[@]}" -name '*.test.tsx')
  for plugin in "${plugins[@]}"; do claude plugin test "$plugin" || status=$?; done
fi
exit "$status"
