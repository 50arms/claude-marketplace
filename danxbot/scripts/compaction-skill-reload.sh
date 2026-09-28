#!/usr/bin/env bash
# Post-compaction skill-reload gate (SessionStart, matcher "compact" only).
#
# Compaction truncates skill bodies in place, and an agent reading the fragment
# believes the skill is loaded and skips its gates. This forces a fresh Skill()
# call before the next mutating action.
#
# SessionStart[compact], not PostCompact: PostCompact output goes to the user
# only and never reaches the model.
set -euo pipefail

printf '%s\n' "Post-compaction: every skill body above is a truncated fragment, not a loaded skill. Before your next mutating action, re-invoke Skill(<name>) for each skill that action relies on — including ones you can still read."
