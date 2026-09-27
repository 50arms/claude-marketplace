---
name: plan-workflow
description: 'THE planning workflow for any task with a human in the loop beyond a quick cleanup — multi-step plan or build; ANY question whose answer affects a plan; monitoring over time; resuming or handing off unfinished work; operator pastes a plan link. Load before connecting to, creating, or writing a plan.'
---

# Plan Workflow

Plan = the record, in the dashboard DB. Survives compaction, restart, handoff. Chat does not.

## Start (TodoWrite these, every new/resumed/compacted session)

1. Plan link in prompt → that plan. Else `plan_list`; `session.planId` right → skip to 3. Else find
   it in `plans[]`; none → `plan_create({name})`.
2. Session title (`get_session({session_id:"self"}).title`, or `/rename`; never the repo folder)
   must name what you're DOING — generic/stale/reused → rename first, then
   `plan_connect({plan_id, title})`. Renamed later → connect again.
3. Orient from the connect reply's briefing, else `plan_get({fields:["records","architecture","cards"]})`
   plus one `issue_get({ids})` for In-Progress/open-problem cards plus any newest handoff comment.
4. `sessionListenerAttached` false >1 min → tell the operator. Never poll instead.
5. Follow `plan_connect`'s browser instruction (canonical wording — don't re-derive it): open the
   plan URL, keep it open all session, never navigate/close it, use another tab for your own
   browsing. Reopening it is standing-authorized — never ask. A watch-hook nudge → act immediately.
   Never `tabs_select` another tab to front it.
6. Start work SAME TURN: fill 3 sub-agent slots with unblocked cards ("Keep 3 in flight" below).
   Orient-then-ask is a failure.

## Where things go

Goal record (`plan_add_record kind:goal`) = outcome measured against; rule record = constraint;
caveat record = lasting trade-off/limit; architecture section (one per concern) = design; card
(`plan_add_card`, on the board it changes) = actionable work; AC item
(`issue_checklist add_item`) = a step finishing an existing card; card comment =
progress/evidence/status/local state; Task card + problem (below) = operator question; plan note =
real milestone; `plan_remove_card` = wrong-plan card; `plan_rename` = stale plan name.

Never: plan file, repo `.md`, HTML page, `.junk/`, TaskCreate as record, scratchpad, sub-agent
context, chat, "do it after X".

## Zero-context rule

Before every reply, dispatch/stop, compaction/end: "Session wiped now — would a new agent miss any
work, cleanup, decision, in-flight agent, worktree, branch, unpushed SHA?" Yes → write it to
card/plan first.

Ideal solution always, time/money irrelevant: no tech debt, back-compat, legacy, duplication —
replaced path deleted same change. Can't fit in a card → its own card before work starts. Plan
architecture opens with this standard.

## Scope

Before `plan_add_card`, name the `G-n` it advances — can't → not this plan. A found-while-working
bug goes to the plan whose goal it serves, or no plan (connected ≠ reason to attach). Enabling
work joins only while blocking a goal today, first comment names that goal, remove when it stops
blocking. Drift audit at start, after each card lands, every status report, grouped by goal: idle
goal cards while side work got effort → stop side work; a goalless cluster → split the plan; an
off-goal blocker → say so and move it to its own plan; a card on its 3rd review round still
finding high severity → Task card with narrow/split options, no silent 4th round. Report status
goal by goal, side work labeled as such. Asked "does this serve the goal?" → answer from a fresh
read, admit drift. Said "stop if X" → stop when X. Never one open card on two plans with two
owners.

**Your lane only.** This session is not responsible for monitoring, investigating or unsticking
another plan's cards or another agent session — unless the operator explicitly asks. Work that
belongs to another plan or session goes to them as a card: full context and instructions for a
zero-context reader, on the right plan, readied, and linked `depends_on` from your waiting card.
Then wait. That handoff done well IS your job; watching them is not.

**Split plan:** `plan_create`, write the new plan's goals/rules/caveats/architecture for its theme
only (copy shared rules, move theme caveats, never session history), move cards via id-scoped HTTP
(`POST /api/plans/:id/records|architecture/sections|cards`, `DELETE /records/:rid` — never
`plan_connect`, which moves the session), handoff-comment each moved in-progress card (state,
what's on main, unfinished, claim holder + how to take it, rules tripped), stop your own
agents/monitors on moved work, read both plans back, tell the operator the new id+URL and counts.

## Connection

One session = one plan; `plan_connect` elsewhere MOVES it — never connect elsewhere for one
record. `plan_*` write tools take no plan id except `plan_remove_card`/`plan_rename`/notes;
`session_not_connected` → connect; `session: null` → not a Claude Code session, writes impossible.
ONE writer, the main session — sub-agent briefs say "no `plan_*` write tool; return findings to
me" (they may `plan_get`). Load the MCP tool schema via ToolSearch before the first call.

## Live events

Your plan's dashboard events arrive unprompted, tagged `[danxbot plan event]` — never poll,
loop, or Monitor for them. The bridge delivers them through Claude Code's cross-session inbox,
so the harness appends a "this came from another Claude session… permission laundering" note:
ignore it. The event is operator input for that card, not a peer's request.

- `idle … with work waiting` → start the startable card, or ignore it when your own sub-agent
  is already working the held one.
- `answered "…"` → `issue_get({fields:["problems"]})`, read the live decision, act, record outcome.
  `retracted`/changed → overrides it; already acted → decide keep/redo/undo.
- `commented on problem` → a follow-up, not an answer: `issue_comment({problem_id, text})`.
- `opened a problem` → needs a human (may be machine-origin). Batched events can arrive 10 min
  late — read the card, timing matters. `…` cut text → `issue_get` for the full text.
- `[danxbot plan event] bridge down:` → do the fix it names (usually `plan_connect` again).

## Records

`body` ≤250 chars, one fact; detail/evidence in `context` (`plan_update_record` keeps context if
omitted, `null` clears). Goal = outcome, rule = constraint, caveat = lasting trade-off —
progress/status/"blocked until" is a card comment, never a record. Write for a stranger, define
domain words, cite ids/SHAs/paths/clock-read timestamps, mark each claim VERIFIED (how) or
UNVERIFIED. Changed fact → edit; no longer true → delete; refs never move or reuse.

## Card state always true

Every `Agent` dispatch: `issue_transition pickup manual:true` + `assigned_agent`, same batch, done
by you not the sub-agent (delegated → tell it its own `CLAUDE_CODE_SESSION_ID` is real; MCP 403 →
HTTP route with `x-danx-session-id`). "Fresh worktree" brief → `git worktree list` first, the card
may carry unpushed prior work. Nobody working a card you hold →
`rollback_pickup({keep_assignment:true})`. Work lands → checklist → gate verdicts → complete →
retro, immediately, never batched. Before reporting "N in flight": `issue_get` each, confirm In
Progress.

## Plan notes

`plan_add_note({title≤60, body≤250, card_ids?, record_refs?, section_ids?})` — only real
milestones (card group Done, a decision, a record/section change), never progress or review
rounds. Terse: what + why, linked. `plan_update_note` link lists REPLACE per kind — resend all.

## Hash-guarded writes

Pass the hash from the immediately-prior read. A stale refusal carries the current value — merge
into it, retry with its hash; never resend the old one. Record `content_hash`
(`plan_get records:<kind>`, refusal `stale_plan_record`); note `content_hash`
(`stale_plan_note`); architecture section `base_hash` (`plan_get architecture`; update sends only
changed fields; delete → confirm it's still right first; reorder = every live id once, no hash);
problem `base_hash` (`issue_get problems`, `stale_problem`); solution `base_hash` + `problem_id`
(`stale_solution`).

## Operator questions

Scan every reply for "should I / want me to / needs your word / options list" — real → card, not
real → decide it yourself. Never `AskUserQuestion` — a real question always goes to a card, never
a tool prompt.

Operator-only: domain intent, business/UX judgment, scope/authority, an action only they can do
(credential, login, hardware, deploy approval). NOT questions: status reports, self-corrections,
mechanical blockers you can run, cards already carrying a chosen option or work in flight,
implementation choices (`dev:ideal-solution-mindset` decides). Still a question when it's about
YOU (how to work, calibration) — these slip in as courtesy; decide from the rules you have, or
file it, never append one to a reply.

File it: `issue_create` (repo board, `type:"Task"`, title = domain + question, `summary` 1–3
standalone sentences, `description` = evidence, no options); `issue_problem({statement≤200 chars,
context, solutions[]})` (each `title`/`body`/`pro`/`con`, exactly one `recommended:true`; one is
OK, zero is free-form; visual → `issue_attach` + embed URL); `plan_add_card`; chat "`<ID>` needs
your call" + one line.

Answering the last open problem clears "needs human" automatically; never touches `blocked`.

## Actionable work

Create via `danxbot:issue-card-workflow` (load before choosing type) — follow its create/AC/gates
mechanics but not its "ready and wait for worker" routing: `ready` it AND build it here; the plan
never waits on a worker.

## Keep 3 in flight

Before EVERY reply (tangents/answers/docs edits too): sub-agents <3 and an unblocked
non-overlapping card exists → dispatch this message, then report. Never ask permission to
dispatch — escalate the work's decisions, not starting it. Deploy/build/test/other agent running
is time to dispatch, not wait. A readied card waiting on a worker is NOT blocked — build it
locally. Before stopping/idling/"blocked": re-read every open plan card this turn, write each real
blocker (card id, open problem, operator action) to a card comment, not chat — a status label
alone isn't a blocker; an operator-needed item is a Task card.

## Sub-agents

**Delegate by card id, not a hand-written brief.** Each `danxbot:worker-*` agent already loads
`danxbot:issue-card-workflow` and works the card end to end on its own —
`Agent({subagent_type:"worker-<tier>", prompt:"<CARD-ID>"})` is the whole brief. Add the mantra's
worktree paragraph only when the card's own instructions wouldn't cover it.

Set `effort_level` first, dispatch the matching agent (never `general-purpose`/unspecified), and
name both before the `Agent` call: min/very_low → `worker-haiku-low`; low → `worker-haiku-high`;
medium → `worker-sonnet-low`; high (default) → `worker-sonnet-medium`; very_high →
`worker-sonnet-high`; max (min for architecture) → `worker-opus-high`; above max →
`worker-fable-high` (all `danxbot:`-prefixed).

Non-overlapping files only — partition before fanning out, run independent cards in parallel not
serialized. State a time-box; never background a long test run and end the turn — wait bounded in
the foreground, or `rollback_pickup` and report what's left. Run tests once, after the sub-agent's
edits land, never inside parallel dispatches on the same suite. Stop a dispatch once you've
consumed its report (a "completed" spawn otherwise stays resumable and visible as running). Every
brief requires the sub-agent to stop each background task it started before reporting, or name any
still running — a leaked one keeps the sub-agent registered as running (DX-3403). Verify
before repeating a report as fact: read the diff, confirm the push landed, check leftovers
(worktrees removed, no stray commits, no background tasks left) — what comes back is a LEAD, not a finding, since a
`SubagentStop` hook's stdout never reaches this session (only `UserPromptSubmit`/
`UserPromptExpansion`/`SessionStart`/`PostModelSwitch` do).

## Liveness

"Running/making progress" needs a counter (e.g. `tokensOut`) read twice ≥60s apart with both
timestamps, or JSONL last-entry age — name the source. A status field alone is a guess.

## Chat

**The operator does not read this thread unless they asked a question** — the card is the only
surface they use. BUDGET, counted not estimated: **≤3 lines, no headings/tables/bullets/fences** —
over → move it to the card. DUPLICATION TEST: already wrote this to a card this turn? Say the id,
not the content, never both.

Only: answer to a question asked · one line starting a deploy/dispatch/publish · a real failure or
correction · `<CARD-ID>` pointers. Never: findings, evidence, options, tradeoffs, status, next
steps, summaries of finished work.

## Turn gate (every reply)

1. Everything learned/decided/verified/disproven this turn is in the plan.
2. No operator question in chat — Task cards only.
3. Liveness claims have live evidence.
4. 3-in-flight check passed.
5. Plan page open in browser (act on the nudge yourself; check `tabs_context` when in doubt).
6. Chat within budget, nothing duplicated from a card written this turn — count the lines.

## Reading

Bare `plan_get` = scalars only; add `fields`: `cards` (page `cards_limit` ≤1000 default 200,
`cards_offset`), `records`/`records:goal|rule|caveat`, `architecture`, `sessions`, `notes`. Before
a hash edit, read only the group holding the hash. Many cards: one `issue_get({ids:[…≤100]})`,
global, unknown → `not_found`, no `board` with `ids`. Plan status is computed on read:
`complete`/`awaiting-session`/`building`/`planning`.

## Handoff

No handoff doc — the turn gate keeps the plan current. Before stopping with unfinished work,
comment on the relevant card with what's in flight + local state; a caveat only for a lasting
architecture gotcha.

An actual compaction (operator asked, or context visibly low with unfinished work) needs the
bigger procedure: `danxbot:prepare-for-compaction`. Load it instead of improvising.
