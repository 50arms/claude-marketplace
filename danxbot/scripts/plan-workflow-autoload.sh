#!/usr/bin/env bash
# Injects the danxbot:plan-workflow skill body, read fresh off disk, at SessionStart
# (matcher "startup|resume|compact", PLN-11 R-12) for a plan-connected session, so a
# resumed or compacted session works from the current skill rather than a stale or
# truncated memory of it. Not connected (lib/plan-connection.mjs): silent — mantra.sh
# owns the one pre-connection nudge (R-10).
set -euo pipefail

EVENT="${1:-SessionStart}"
SKILL_FILE="${CLAUDE_PLUGIN_ROOT}/skills/plan-workflow/SKILL.md"
CONNECTION_LIB="${CLAUDE_PLUGIN_ROOT}/scripts/lib/plan-connection.mjs"

if [ "$EVENT" != "SessionStart" ]; then
  exit 0
fi

PAYLOAD="$(cat)"

CONNECTED="0"
if [ -f "$CONNECTION_LIB" ]; then
  CONNECTED="$(printf '%s' "$PAYLOAD" | node "$CONNECTION_LIB" 2>/dev/null || true)"
fi

if [ "$CONNECTED" != "1" ]; then
  # Not connected: stay completely silent. `mantra.sh` (same cadence
  # decision, DX-3052 problem 1602) owns the one nudge the plugin shows
  # before a plan is connected — this hook adding its own text here would
  # duplicate it.
  exit 0
fi

if [ ! -f "$SKILL_FILE" ]; then
  # Fail loud rather than silently skipping the load — a missing file here means
  # the plugin install is broken, which is itself worth surfacing.
  printf '%s\n' "⚠ danxbot:plan-workflow AUTO-LOAD FAILED: expected skill file not found at $SKILL_FILE. The plugin install may be corrupt — call Skill(danxbot:plan-workflow) manually and report this if it also fails."
  exit 0
fi

# Strip the YAML frontmatter (everything between the first two '---' lines): the
# frontmatter's `description` is for the skill picker, not useful as injected
# context, and printing it verbatim would look like a broken skill invocation.
BODY="$(awk '/^---$/{n++; next} n>=2' "$SKILL_FILE")"

printf '%s\n' "danxbot:plan-workflow AUTO-LOAD ATTEMPTED (full text below, read fresh from disk this SessionStart — this SHOULD satisfy the Skill(danxbot:plan-workflow) load requirement for this turn). If the block below is short (~2KB) rather than the full skill body, the harness truncated this SessionStart output and only a preview reached you — call Skill(danxbot:plan-workflow) explicitly to get the complete text before relying on it. This is re-attempted on every session start, resume and compaction."
printf '\n'
printf '%s\n' "$BODY"
