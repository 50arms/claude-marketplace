#!/usr/bin/env bash
# ideal-solution-mindset mandate — ships with the `dev` plugin.
# Fires on SessionStart only (hooks.json). Surfaces the four core dev
# principles + self-trigger gates for the high-value dev skills so the
# agent loads the full skill body at the right moment.
# Argv: $1 = "SessionStart" (any other value → no-op silent exit).

set -euo pipefail

EVENT="${1:-SessionStart}"

if [ "$EVENT" != "SessionStart" ]; then
    exit 0
fi

read -r -d '' MANDATE <<'EOF' || true
DEV MANDATE — four core principles default for every plan, investigation, fix, refactor. Full body: dev:ideal-solution-mindset.
  #1 IDEAL CORRECT SOLUTION — cost/effort/tokens never trade against correctness.
  #2 NO LEGACY / NO FALLBACKS / NO DEAD CODE — hard cuts; obsolete code deleted same commit; no shims, TODOs, deprecated wrappers.
  #3 REDUCE COMPLEXITY — simplest shape that is still correct; new abstraction must name the invariant it enforces.
  #4 DRY + SOLID, REUSE BEFORE BUILD — search the codebase first; extend / move / use existing capability before adding new.

SELF-TRIGGER GATES — invoke the skill via Skill tool BEFORE the offending action:
  • dev:code-quality — every code edit/refactor/solution proposal, AND any KEEP-vs-DELETE verdict on existing code (dead-code audit, deciding a comment/test/guard stays or goes) — CP2 decides retention, not your judgement.
  • dev:debugging — any bug, failing test, error, investigation, or factual assertion about system behavior, OR drafting a bug report (Phase 12 Affects/Env/Scenario/Expected/Actual format required). Read-only by default; fix mode only on an explicit instruction to fix (a dispatched card counts as that instruction).
  • dev:git-discipline — ANY AND ALL git ops REQUIRE this skill loaded at least once THIS SESSION before the op. Not loaded yet → load NOW, then act. "Just a quick git command" is the exact documented failure — load anyway.
EOF

printf '%s\n' "$MANDATE"
