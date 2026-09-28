---
name: prepare-for-compaction
description: 'Operationalizes plan-workflow''s zero-context rule into a mechanical checklist for the moment BEFORE a compaction. Load when: the operator asks to prepare for/wrap up before compaction; context is visibly running low and work is unfinished; handing off a session; about to stop with sub-agents still dispatched or a dirty tree. Does not cover ongoing plan hygiene (danxbot:plan-workflow) or git safety (danxbot:issue-workflow).'
---

# Prepare for Compaction

`danxbot:plan-workflow`'s zero-context rule states the principle: session wiped, would a new
agent miss anything? Write it first. This skill is the procedure for actually doing that.

## What compaction does — and does not do

| Does | Does not |
|---|---|
| Wipes the model's context, replaced by a summary | Stop running sub-agents (below) |
| Truncates skill bodies into fragments (`compaction-skill-reload.sh` forces a re-`Skill()` call) | Touch the working tree or staged/unstaged/untracked state |
| Re-injects the mantra on `SessionStart` (matcher `startup\|resume\|compact`) | Undo any commit, push, dispatch, or API call already made |
| Re-fires `SessionStart` `matcher:"compact"` — the only hook point whose stdout still reaches the model after a compaction | Preserve YOUR reasoning about *why* something is in flight — only what got written down survives |

**Sub-agents keep running through a compaction** — a background `Agent()` spawn is a real process
the harness tracks independently of your context (see `danxbot:plan-workflow`'s Sub-agents section).
Know which of your dispatches are still alive before writing the handoff; don't assume either state.

**Nothing injects "compaction is imminent" ahead of time.** `PreCompact`/`PostCompact` hook stdout
never reaches the model — only the `SessionStart`/`compact` matcher does. Invoke this skill
deliberately: operator asks, or your own judgment that context is low with unfinished work.

## The procedure

Run these in order.

### 1. Capture the tree NOW, don't remember it

`git status` + `git diff --stat`, every modified/untracked path, before writing anything — don't
reconstruct from memory. The tree changes while you write, so capture, write, re-verify (step 8).

### 2. Attribute interleaved work per card, not per tree

A shared tree with 2+ agents active produces one `git status` covering multiple cards' work — list
every changed file and its owning card, including files owned by a DIFFERENT card than the one
you're handing off, or the natural next move (commit everything dirty) merges unrelated,
unreviewed changesets into one commit.

### 3. Resolve a stopped agent's uncommitted work by COMMITTING it — never discarding it

`git checkout --`/`restore`/`reset --hard`/`clean` on someone else's uncommitted work is forbidden
outright (`danxbot:issue-workflow`) — compaction pressure is not an exception.

The sanctioned pattern: (1) commit as an explicit WIP —
`wip(<CARD-ID>): <what, incomplete> — DO NOT SHIP AS-IS`, body states what it is, why it's real,
what's missing; (2) revert it FORWARD in the very next commit (never `git reset`), body explains
what's still broken and why the failure predates the WIP; (3) save a patch of the WIP diff to the
repo's scratch convention (e.g. `.junk/<plan>/<card>-wip-<desc>.patch`) so it can be reapplied
without archaeology; (4) record all three references on the card — WIP SHA, revert SHA, patch
path, what's left to finish.

### 4. Sweep stale "In Progress" claims

A card claimed by a session about to compact away (or already gone) and not actually being worked
hides from anyone scanning for work and lies about the in-flight count. Fix:
`issue_transition({action:"rollback_pickup", keep_assignment:true})` — returns the card to ToDo
without erasing who was holding it.

### 5. Every outstanding requirement lands on the card — especially ones given live

A requirement the operator stated out loud, in chat or a screenshot, and nowhere else, is one
compaction away from gone — these are highest-risk since there's no fallback source, unlike code
which survives in the tree regardless. Write each onto the card's description or as a comment, in
the operator's priority order, distinguishing: **Done** (and how you know); **partially done**
(what's finished, started-but-unverified, untouched); **never started**.

### 6. Route every durable fact by its actual durability

`danxbot:plan-workflow` already owns the routing table and API shapes (comments take `text` not
`body`, records take `{kind, body, context}` not `statement`) — before compaction, make sure
everything that needs a home (goal/rule/caveat record, plan note, card comment, Task-card+problem)
actually has one.

### 7. Two dashboard-API gotchas (HTTP fallback only)

Only relevant when calling a dashboard route directly (MCP down, or no MCP tool) with a scoped
token minted by the dashboard MCP's token tool — both silent:
`GET /api/issues/<id>` omits `description`/`comments`/checklist unless `?fields=description`
(`?include=`/`?full=1` return something smaller, not equivalent); `GET /api/plans/<id>?fields=cards`
returns `cards: []` even for a plan with cards attached — they live at `/api/plans/<id>/cards`.
Both look like facts about the board, not the query — hit either → note it on the plan as a
caveat record too.

### 8. Re-verify immediately before declaring ready

Everything from step 1 can be stale by step 6. Before saying "ready for compaction": re-run
`git status`, re-read back every card you wrote to, confirm the sub-agent liveness claim above is
still true. Anything written a minute earlier may already be false — close the loop.

### 9. Say plainly what compaction does and does not affect

One or two sentences in the handoff itself: context is being cleared and replaced with a summary;
the working tree, any commits/pushes, and any dispatched sub-agents are untouched and continue
exactly as they were.

## Non-goals

Plan record/note/card mechanics, hash-guarded writes, "keep 3 in flight", live-event handling —
all `danxbot:plan-workflow`. Git safety (destructive ops, branch discipline) — `danxbot:issue-workflow`.
This skill is only the ordered checklist for the one moment right before a
compaction.
