---
name: prepare-for-compaction
description: 'The checklist to run right before a compaction or handoff. Load when the user asks to prepare for compaction, context is low with work unfinished, or you are handing off or stopping with sub-agents running or a dirty tree.'
---

# Prepare for Compaction

The mantra's zero-context rule, run as a checklist. Sub-agents keep running through a
compaction. Load this once you have decided to compact: after a `[50 ARMS] Compaction
recommendation:` (advice, not an order), or on your own initiative or a handoff.

1. **Decide first.** Never compact while a conversation with a person is still open: something they said or asked still needs an answer or action that depends on this session's context. Time is only a hint (a message within the last few minutes usually means they are still talking); once the exchange is finished and its outcome is on the cards and plan, compacting is safe at once. Then give the recommendation no answer (it comes again later) and never call compaction-ready; say ready only while you work on your own. Is compacting worth it given what is left and what you are doing right
   now? Mid-way through a tight edit-test loop or about to finish: carry on, skip this
   checklist, answer nothing. A long stretch of work ahead: continue.

2. **Capture the tree now.** `git status` and `git diff --stat`: every modified and
   untracked path, captured, never reconstructed from memory.
3. **Attribute each changed file to its card**, including files another card owns;
   otherwise "commit everything dirty" merges unrelated, unreviewed work into one commit.
4. **Another agent's uncommitted work:** commit it as WIP, never discard it, and record
   the SHA in an agent note on its card.
5. **Live requirements onto the card.** Anything the user said only in chat or a
   screenshot goes on the card, in their priority order, marked done (and how you know),
   partly done (finished / started / untouched) or not started.
6. **Write the handoff as an agent note** on each card in flight
   (`POST /api/issues/:id/notes`): where it stands, the next step, its branch, worktree and
   unpushed SHA, and the sub-agents still running on it.
7. **Re-verify before saying ready.** Re-run `git status`, re-read every card you wrote,
   re-check which sub-agents are still running.
8. **Say what compaction affects**, in the handoff note: context is replaced by a summary; the
   tree, commits, pushes and running sub-agents carry on unchanged.
9. **Say ready, only after a recommendation.** A `[50 ARMS] Compaction recommendation:` you
   decided to act on is answered by `danxbot_api` `POST /api/plan-sessions/me/compaction-ready` with `{}`, after
   step 7. Until you do, nothing compacts. After ready, end your turn: the plugin starts the
   compaction when the turn ends (the ready lasts about ten minutes, so do not start long work
   first). `409 compaction_not_requested` means you were not asked: keep working. Your own
   `/compact`, or one the person types, needs no ready.
