#!/usr/bin/env bash
# DX-5648 - runs INSIDE the test container scripts/test-in-container.mjs creates, after it copied the source in. Never run it anywhere
# else. The arguments are test files: none runs the whole suite (the node suites, then the plugin's function-hook tests); named
# .mjs files run under `node --test`, named .tsx files under `claude plugin test`.
set -euo pipefail
cd /app

# The delivery and publish suites clone this checkout, so it needs a repository whose HEAD is exactly the copied tree.
git init -q -b main
git add -A
git -c user.name=claude-plugins-test -c user.email=test@localhost -c commit.gpgsign=false commit -q --no-verify -m "DX-5648 test snapshot of the copied checkout"

mjs=()
tsx=()
for file in "$@"; do
  case "$file" in
    *.mjs) mjs+=("$file") ;;
    *.tsx) tsx+=("$file") ;;
    *) echo "test-container-entry: $file is neither a .mjs nor a .tsx test file" >&2; exit 2 ;;
  esac
done

whole=0
if [ $# -eq 0 ]; then
  whole=1
  mjs=("danxbot/tests/*.test.mjs" "scripts/tests/*.test.mjs")
fi

status=0
if [ ${#mjs[@]} -gt 0 ]; then
  node --test "${mjs[@]}" || status=$?
fi
if [ "$whole" -eq 1 ]; then
  claude plugin test danxbot || status=$?
elif [ ${#tsx[@]} -gt 0 ]; then
  # `claude plugin test <dir>` runs every *.test.tsx under the plugin and takes no file filter, so the named files are the only ones left
  # in this container's disposable copy.
  while IFS= read -r existing; do
    keep=0
    for named in "${tsx[@]}"; do [ "$existing" = "$named" ] && keep=1; done
    [ "$keep" -eq 1 ] || rm "$existing"
  done < <(find danxbot/tests -name '*.test.tsx')
  claude plugin test danxbot || status=$?
fi
exit "$status"
