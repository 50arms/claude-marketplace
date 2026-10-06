---
name: plan-workflow
description: 'THE planning workflow when a human is in the loop beyond a quick cleanup: multi-step plan or build, a question that affects a plan, monitoring, resuming or handing off work, a pasted plan link. Load before connecting to, creating or writing a plan.'
---

# Plan Workflow

The plan in the dashboard DB is the record; chat is not. The mantra's rules apply
throughout; this skill is the plan mechanics.

## Start (every new, resumed or compacted session)

1. Plan link in the prompt → that plan. Else list plans; your session's plan right → step 3.
   Else find it in the list; none → create one.
2. Your session title is `{Name}: {plan id} {short title}` (`{Name}` your own short given name).
   `plan_connect({plan_id})` answers `naming` with the exact title and a free name: rename the
   thread to it (desktop `set_session_title`; terminal: ask the person to `/rename`), then
   `plan_connect({plan_id, title})` again — the server refuses a wrong format or a name another live session holds.
3. A session holds no dashboard key until its user approves it. `plan_connect` answering
   `approval_required` (or `approval_pending`) is not a failure: show the user the confirm code
   and the approval URL, open that URL in the in-app browser yourself when you have one (the
   plugin tries too, but the host can refuse it a browser call), and once they approve call
   `plan_connect` again. Every other dashboard tool answers "not signed in" until then.
4. Orient from the connect briefing, else read the plan's records, architecture and cards,
   plus one batch read of its In-Progress/open-problem cards and the newest handoff comment.
5. Follow `plan_connect`'s browser instruction as written.

## Where things go

Goal record = outcome measured against; rule record = constraint; caveat record = lasting
trade-off; architecture section (one per concern) = design; card (on the board it changes) =
actionable work; AC item = a step finishing an existing card; card comment = progress,
evidence, status, local state; problem on the card it concerns = user question; steps a
person must perform (a live check, a manual task) = an `action` problem whose solution steps
are the procedure, each with a short title and a description saying where (exact link), what
to do and what to look for, never an AC checklist; plan
note = real milestone; remove a wrong-plan card from the plan; rename a stale plan.

## The user

They read cards, not chat. A chat reply is at most 3 lines, no headings, tables, lists or
fences: an answer to their question, a one-line start of a deploy, dispatch or publish, a
real failure or correction, or card ids. Findings, options and status go on the card;
already there → give the id. Every card id in chat is a markdown link to that card
(`[<card id>](<dashboard>/plans/<plan id>/cards/<card id>)`), never a plan or board page.

A question is not a stop or a command. "Why X?" gets an answer: running work keeps running
and nothing new starts. Stop, redirect or act only on an explicit verb.

## Scope

Before adding a card to the plan, name the `G-n` it advances — can't → not this plan. A bug
found while working goes to the plan whose goal it serves, or none. Enabling work joins only while it
blocks a goal today. Drift audit at start, after each card lands and in every status report:
idle goal cards while side work got effort → stop the side work; a goalless cluster → split
the plan. Review rounds repeat until a clean pass or only minor findings; the round count is
never a question for the user. A finding that is new scope rather than a defect in the
change → split it into its own card. Report goal by goal. Said "stop if X" → stop when X.

**Your lane only.** Never monitor, investigate or unstick another plan's cards or another
session unless the user asks. Their work goes to them as a card on the right plan
(create it with `plan: null`, then `POST /api/plans/:id/cards`), readied, `depends_on` from
your waiting card. Then wait.

## Before a plan is ready

One sentence goal in the system's nouns → the one ideal shape → reuse audit (cite paths) →
what it makes obsolete (delete in scope) → simplest correct shape? → anything merely
unfinished being removed? → did "faster to ship" shape it? Any step changes the plan →
restart. Ready when a pass changes nothing.

## Connection

One writer: the main session. Sub-agent briefs say "no plan writes; return findings to me"
(they may read the plan).

## Live events

Your plan's events arrive unprompted, tagged `[danxbot plan event]`, from this plugin and
your own dashboard — never poll, loop or Monitor for them. Each is the user's or the
dashboard's input for the card it names.

- `has not made an MCP call …` → every card it names is workable by its recorded state. Work
  it, or record why you can't: a problem, `depends_on`/`conflict_on`, a block with the real
  reason, or `rollback_pickup`. Never just ignore it.
- `answered "…"` → read the card's problems, act on the live decision, record the outcome.
  Retracted or changed → it overrides; already acted → keep, redo or undo.
- `commented on problem` → a follow-up, not an answer: reply with a comment on that problem.
- `opened a problem` → needs a human. Batches can arrive 10 min late — read the card; `…` →
  read it for the full text.
- `bridge down:` → do the fix it names (usually `plan_connect` again).

## Records

Changed fact → edit; no longer true → delete.

## Card state always true

Delegated pickup → tell the sub-agent its own `CLAUDE_CODE_SESSION_ID` is real (`danxbot_api`
forwards it; a curl fallback sends it as `x-danx-session-id`). A "fresh worktree" brief →
`git worktree list` first; the card may carry unpushed prior work. Nobody working a card you
hold → `rollback_pickup` with `keep_assignment:true`. Before reporting a card in flight,
re-read it and confirm In Progress.

## Notes

A note edit replaces its link list per kind — resend them all.

## Actionable work

Create via `danxbot:issue-workflow` (load before choosing a type) — but `ready` the card AND
build it here; the plan never waits on a worker. An archived (Backlog) card was parked on
purpose: read why in its comments before reopening it; a park the user made is theirs
to lift. A design talked through with the user is decided the moment their answers leave
no open question: write it into the plan, slice, ready and build in that same turn, never a
card held in Review for a "go" (a point still open is a problem on that card).

## Closing a plan

Every plan card Done or Cancelled → verify each goal, rule and caveat end to end against the
running system and the shipped code (the mantra's evidence rule):

- Holds → `PUT /api/plans/mine/records/:recordId/agent-verification` `{verdict, note,
  content_hash}`: `implemented` (as designed) or `accepted` (a deviation we live with), the
  note citing the evidence. Fails → a card on the plan, not a verification.
- Then `PUT /api/plans/mine/agent-verification` `{note}`: what you checked. A 409
  `plan_agent_verification_blocked` lists the open cards and unverified records — work
  them, never around them. A record edit or reopened card clears a verification: redo it.
- Then tell the user in ONE chat line that the plan is ready for their sign-off (its page
  shows it pending). No card, no problem. Never tick or clear their sign-off: the server
  refuses it.
- A plan is done only with both sign-offs; never report it done on card count alone.

## Stopping

Before stopping or saying "blocked", re-read every open plan card and write each real
blocker (card id, open problem, user action) to a card comment.

## Sub-agents

Delegate by card id: `Agent({subagent_type:"danxbot:worker-<tier>", prompt:"<CARD-ID>"})` is
the whole brief — each tier loads `danxbot:issue-workflow` itself. Add the worktree rule
below only when the card wouldn't cover it. Set `effort_level` first, by the kind of work
(issue-workflow's creation guide, § Effort), then pick the tier whose description names it;
never `general-purpose`. A card that carries gates never goes to a `worker-haiku-*` tier.
A builder runs its PRE gates itself and never spawns gate agents; once it reports its pushed
tip SHA, you run its POST gates as gate workers and say when to land.

Partition files before fanning out. State a time-box; never background a long test run and
end the turn — wait bounded, or `rollback_pickup` and report. Run tests once, after the edits
land. Every brief makes the sub-agent stop each background task it started before reporting,
or name it. Stop a dispatch once its report is consumed. A report is a lead, not a finding:
read the diff, confirm the push, check for leftover worktrees, commits or background tasks.

Never end a turn while unblocked work could be dispatched (a running build, test or deploy
is time to dispatch; a readied card waiting on a worker is not blocked), nor while work runs
with no wake-up armed. Checks and reviews that de-risk waiting work (verification,
cross-repo checks, a whole-change review) are dispatchable too.

Worktrees you create go under the repo's git-ignored `.claude/worktrees/<name>`, never a
sibling checkout. Remove each once `git status --porcelain` and `git cherry origin/main
<branch>` are empty, delete its branch, and name what you removed.

## Usage pacing

A pacing message (`Usage pacing for your Claude account changed: …`) or a spawn refused with
`Usage pacing: …` states the level, the agent budget of the whole account and the reset
time; trust those numbers, never your own estimate. Never retry a refused spawn.

- **On pace**: carry on. A spawn is still refused while the account's budget is full, and
  may be moved to haiku when the budget is nearly full.
- **Over pace**: every new sub-agent is refused, so nothing new starts until the level drops.
  Let running agents finish; do only cheap work yourself (verify landed commits, card writes),
  and record anything else on its card as paused.
- **Critical**: every running agent makes a work-in-progress commit, pushes its branch, writes
  on its card where it is, and stops; do the same for your own state, note on each card what is
  paused, and go idle. A later message back to on pace means: read those cards and resume
  what was paused.

## Liveness

"Running" needs a counter (e.g. `tokensOut`) read twice ≥60s apart with both timestamps, or
the JSONL last-entry age — name the source.

## Handoff

Before an actual compaction, load `danxbot:prepare-for-compaction`.

Retiring this session (a handoff, not a compaction): as your last plan action, after the handoff
comment, call `plan_connect({plan_id, disconnect: true})` (`plan_id` = the plan you are on). Moving to
another plan needs no leave.
