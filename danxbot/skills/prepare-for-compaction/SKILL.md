---
name: prepare-for-compaction
description: 'The checklist to run right before a compaction or handoff. Load when the user asks to prepare for compaction, context is low with work unfinished, or you are handing off or stopping with sub-agents running or a dirty tree.'
---

# Prepare for Compaction

The mantra's zero-context rule, run as a checklist. Sub-agents keep running through a
compaction, and only a `[50 ARMS]` request warns before one, so run this deliberately.

1. **Capture the tree now.** `git status` and `git diff --stat`: every modified and
   untracked path, captured, never reconstructed from memory.
2. **Attribute each changed file to its card**, including files another card owns;
   otherwise "commit everything dirty" merges unrelated, unreviewed work into one commit.
3. **Another agent's uncommitted work:** commit it as WIP, never discard it, and record
   the SHA on its card.
4. **Live requirements onto the card.** Anything the user said only in chat or a
   screenshot goes on the card, in their priority order, marked done (and how you know),
   partly done (finished / started / untouched) or not started.
5. **Re-verify before saying ready.** Re-run `git status`, re-read every card you wrote,
   re-check which sub-agents are still running.
6. **Say what compaction affects**, in the handoff: context is replaced by a summary; the
   tree, commits, pushes and running sub-agents carry on unchanged.
7. **Say ready, only when 50 Arms asked.** A `[50 ARMS]` notice asking you to prepare is
   answered by `danxbot_api` `POST /api/plan-sessions/me/compaction-ready` with `{}`, after
   step 5. Until you do, nothing compacts. `409 compaction_not_requested` means you were not
   asked: keep working. Your own `/compact`, or one the person types, needs no ready.
