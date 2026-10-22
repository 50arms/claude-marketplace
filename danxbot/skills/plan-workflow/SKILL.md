---
name: plan-workflow
description: 'THE planning workflow when a human is in the loop beyond a quick cleanup: multi-step plan or build, a question that affects a plan, monitoring, resuming or handing off work, a pasted plan link. "Make a plan" means a 50 Arms plan, never a task list, plan mode or a question in chat. Load before connecting to, creating or writing a plan.'
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
   and the approval URL, and once they approve call `plan_connect` again. The plugin shows the
   link and code at once and opens nothing: the person clicks the link, so never open the URL
   yourself (two tabs). The same holds for `request_permission`. Every other dashboard tool
   answers "not signed in" until then.
4. Orient from the connect briefing, else read the plan's records, architecture and cards,
   plus one batch read of its In-Progress/open-problem cards and the newest handoff agent note
   (`agent_notes` on the card read).
5. Follow `plan_connect`'s browser instruction as written.

## Where things go

Goal record = outcome measured against; rule record = constraint; caveat record = lasting
trade-off; architecture section (one per concern) = design; card (on the board it changes) =
actionable work; AC item = a step finishing an existing card; agent note on the card
(`POST /api/issues/:id/notes`) = your working log: progress, evidence, status, local state,
handoffs, blockers; card comment = talking with a person (a reply to what they wrote or
asked); problem on the card it concerns = user question; steps a person must perform (a
live check, a manual task) = an `action` problem whose solution steps are the procedure,
each with a short title and a description saying where (exact link), what to do and what to
look for, never an AC checklist; plan note = real milestone; remove a wrong-plan card from
the plan; rename a stale plan.

## The user

They read cards, not chat. A chat reply is at most 3 lines, no headings, tables, lists or
fences: an answer to their question, a one-line start of a deploy, dispatch or publish, a
real failure or correction, card ids, or a 50 Arms feedback offer or its `FB-` ref (see
"Feedback to 50 Arms"). Findings, options and status go on the card;
already there → give the id. A decision a card's open problem holds is never asked again in
chat or in the app's end-of-turn next-step or question box: the turn's wrap-up only names the
card id, and the problem itself stands alone, with plain background and a concrete example a
newcomer to the subject can follow. Every card id in chat is a markdown link to that card
(`[<card id>](<dashboard>/plans/<plan id>/cards/<card id>)`), never a plan or board page.

A question is not a stop or a command. "Why X?" gets an answer: running work keeps running
and nothing new starts. Stop, redirect or act only on an explicit verb.

## Feedback to 50 Arms

The person hits a bug in 50 Arms itself (not their own code), asks for a 50 Arms feature
that does not exist, wants a UI change, cannot work out how to do something in it, or is
plainly frustrated with it → offer to send it to the 50 Arms team. Never for a passing
nuance, a question 50 Arms already answers, or your own mistake.

1. `GET /api/feedback/mine` (`q` matches a substring of the title or message: try a keyword
   or two, or read the list): already sent → skip it.
2. Draft: `type` (`bug`, `idea`, `ui_change`, `confusing`, `praise`, `other`), `mood` 1 (very
   unhappy) to 5 (very happy) only when they showed one, and a `body` that stands alone: what
   they tried, what happened, what they want. A screenshot → `attach_file` with
   `target: "inline_image"` and only `path`; put the `markdown` it returns in the body.
3. Ask.
   - They voiced it in the thread → offer there, within the 3-line reply: the type and a short
     gist of the draft (keep the full `body` for the send). Yes → `consent: {via: "thread",
     quote}` holding their words; no → drop it.
   - Otherwise → `POST /api/feedback/consent-problems` `{issue_id, type, mood?, body}` on the
     plan card it concerns (none fits → skip it); the server writes the problem and answers
     `{problem_id, send_solution_id}`. Never write a consent problem yourself. Their answer
     arrives as an `answered` event: the send solution → `consent: {via: "problem", issue_id,
     problem_id, solution_id}`; anything else → drop it.
4. `POST /api/feedback` `{type, mood?, body, issue_id?, consent}`, with exactly the drafted
   `type`, `mood` and `body`; `issue_id` is the card the feedback is about. One consent sends
   one item.
5. Tell them its `FB-` ref in one line.

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
your waiting card. Then wait. A new plan you write from the person's request is not yours
either: once it is written, it goes to a session of its own, and you go back to your own plan.

## Before a plan is ready

One sentence goal in the system's nouns → the one ideal shape → reuse audit (cite paths) →
what it makes obsolete (delete in scope) → simplest correct shape? → anything merely
unfinished being removed? → did "faster to ship" shape it? Any step changes the plan →
restart. Ready when a pass changes nothing.

## Connection

One writer: the main session. Sub-agent briefs say "no plan writes; return findings to me"
(they may read the plan).

## Live events

Your plan's events arrive unprompted, tagged `[danxbot plan event]` — never poll, loop or
Monitor for them. Every line is one of these kinds.

From the dashboard:

- `has not made an MCP call …` → the dashboard's idle nudge: every card it names is workable by
  its recorded state. Work it, or record why you can't: a problem, `depends_on`/`conflict_on`, a
  block with the real reason, or `rollback_pickup`. Never just ignore it. It is not sent while
  you are paused (see "Pausing"); it is held and arrives in the message that ends the pause.
- `answered "…"` → an operator's answer: read the card's problems, act on the live decision,
  record the outcome. Retracted or changed → it overrides; already acted → keep, redo or undo.
  Recording the outcome means, in that same turn, editing every plan record, architecture
  section and card it changes, and removing (with a note) each problem it settles or moots.
  A new build card alone records nothing.
- `commented on problem` → a follow-up: reply with a comment on that problem. A comment that
  decides the question (for example "do it this other way") is an answer: handle it as one.
  One that asks, thinks aloud or says it is unsure decides nothing, however concrete its idea:
  answer what it asks in full (the exact calculation, a worked example) and leave the problem
  open. An option you write from it names every point you added and is never marked
  recommended until they confirm it.
- `opened a problem` → needs a human. Batches can arrive 10 min late — read the card; `…` →
  read it for the full text.
- `[plan events] digest — N agent/machine events since the last update:` → one record of agent
  and machine activity held up to 10 min, its events listed under it: read it, act only where it
  names a card of yours.
- a usage-pacing or auto-resume message from danxbot → follow it as written.
- `[50 ARMS] Compaction recommendation:` → advice, not an order: judge from what is left and what
  you are doing now whether compacting is worth it. If yes, load `danxbot:prepare-for-compaction`,
  run it, then call `danxbot_api` `POST /api/plan-sessions/me/compaction-ready` with `{}`. If no,
  carry on and answer nothing; it comes again at the next +step of context. Nothing compacts until
  you call ready; then end your turn, and the plugin starts the compaction when the turn ends (the
  ready lasts about ten minutes). It happens once, pauses you for about two minutes, and is followed by
  a briefing of your plan, cards and unpushed work to resume from. Ready ends a pause you are in.
  `409 compaction_not_requested` → you were not asked (or already answered): keep working.
- `Your pause ended (…)` (and `Held while you were paused, continued: …` after it) → the
  dashboard's messages held during your pause, delivered once, oldest first, de-duplicated; see
  "Pausing".

From this session's event listener:

- `… listener has not reached the dashboard for N minutes (its heartbeats keep failing) …` → it
  keeps reconnecting on its own; nothing to do.
- `… listener has stopped … and does not reconnect by itself …` → the next `plan_events_wait`
  reply says why; follow it, and tell the person (a restart of the session brings it back).
- a notice that this session's key was revoked → stop dashboard work as it says and tell the
  person.

From the plugin's relay (delivery itself):

- Delivery: an event reaches you as your next prompt, after the turn you are in ends (or at once
  when you are idle). Only an urgent one, a critical usage-pacing stop, a revoked key or a compaction
  recommendation, is added to the running turn as a note, which you read with your next tool result.
- `(repeat of an urgent note already added to this conversation) …` → the turn ended before any
  tool result carried that note, so it comes once more as a prompt. You have seen it: act once,
  never twice.
- `events stopped:` → events are NOT reaching this session: do the fix it names (usually
  `plan_connect` again; for a server too old to mark events urgent, restart the session). Read
  the card by hand until it is done.
- `events delayed:` naming the auto mode classifier → in auto permission mode the engine refused the
  plugin's own call; updating the plugin does not help. Run `/danxbot:start`: with the person's OK it adds
  the allow rule `mcp__plugin_danxbot_danx-dashboard__*` in one step. Or add that rule to `permissions.allow` in
  `~/.claude/settings.json` yourself (or allow it in `/permissions`). Either way the relay resumes on its own within a few
  minutes (restart the session only if it does not), and read the card by hand until then.
- `events delayed:` → the relay is retrying on its own; act only if it never clears.

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
purpose: read why in its comments and agent notes before reopening it; a park the user made is theirs
to lift. A design talked through with the user is decided the moment their answers leave
no open question: write it into the plan, slice, ready and build in that same turn, never a
card held in Review for a "go" (a point still open is a problem on that card).

## Closing a plan

A person's sign-off is the final one. The plan is complete once the person has signed off and
every plan card is Done or Cancelled. Your record verifications and your own sign-off are advice
to the person: the app warns them and asks them to confirm when they were not done.

Before the person signs off (the `plan_connect` briefing has no `signOffs.human`), every plan card
Done or Cancelled → verify each goal, rule and caveat end to end against the running system and
the shipped code (the mantra's evidence rule), so the person gets that advice before they sign:

- Holds → `PUT /api/plans/mine/records/:recordId/agent-verification` `{verdict, note,
  content_hash}`: `implemented` (as designed) or `accepted` (a deviation we live with), the
  note citing the evidence. Fails → a card on the plan, not a verification.
- Then `PUT /api/plans/mine/agent-verification` `{note}`: what you checked. A 409
  `plan_agent_verification_blocked` lists the open cards and unverified records — work
  them, never around them. A record edit or reopened card clears a verification: redo it.
- Then tell the user in ONE chat line that the plan is ready for their sign-off (its page
  shows it pending). No card, no problem. Never tick or clear their sign-off: the server
  refuses it.

When the person has already signed off (the `plan_connect` briefing shows `signOffs.human`), the
plan is complete: skip the record verifications and your own sign-off, say so in one line, and
never start them after the fact.

Never report a plan done on card count alone: it is complete only once the person has signed off
and every card is Done or Cancelled.

## Pausing

Every message from the dashboard starts a paid turn at your whole context size. When you have
nothing you can do (waiting on a person's answer, a long build, a dependency), do not answer
each reminder with "still waiting": pause. A session with nothing to do right now pauses; it
never stays active just to wait.

1. Record why on the card first (a problem, an agent note, `depends_on`, or the real block): the
   pause is only the signal, never the record. Waiting on a person is always an open problem
   on a card of this plan, worded for the step left now (no note or comment reaches Needs You).
2. Call `danxbot_api` `PUT /api/plan-sessions/me/pause` with `{reason, waits_on, ends_when?,
   expires_in_minutes?}`. `reason` is shown to the operator beside your session; `ends_when` says
   what would end the wait. `waits_on` is required, the cause you pick: `pacing` when usage pacing
   refused your account's agents (no slot to start one, the account over pace or at its agent
   budget), so you wait for pacing to free slots; `person` for an open problem, an approval or any
   answer only a person gives; `dependency` for another card, a build, a deploy or any other work
   you wait on; `other` when none fits. Pick the one you actually wait on, since only a `pacing`
   pause is woken when pacing frees slots (a pause on anything else holds that message with the
   rest, costing no turn). The pause lasts at most `expires_in_minutes` (default 120, at most
   720) and ends by itself then; call again to renew it. A usage-limit pause already in force
   refuses it (409): that one ends by itself when the limit resets. `reason` is at most 300
   characters. A dispatched worker cannot pause (409): only a registered non-worker session can.
3. Then go idle. A pause is not a `block` (nothing on a card changes), not a stop, and not a
   place to hide: never pause while an unclaimed ready card exists, and never as a way to leave
   work undone.

While paused, the dashboard holds its nudges, plan-event digests and agent or machine events for
you, and the plugin's own ready-cards reminder stays quiet. It ends when a person
writes to you or acts on a card of yours (that message arrives at once), a critical usage-pacing
stop, a usage-pacing change that lets your account start agents again while your pause waits on
`pacing` (on pace, with no count cap or a budget above the agents running; the message is delivered
at once, so a pause taken after a pacing refusal needs no manual wake; a pause on any other cause
holds that message), your own next dashboard call (the plugin's background reads do not count) other than the pause
calls themselves, your own `DELETE /api/plan-sessions/me/pause`, the expiry, or your session going
silent.

The `Your pause ended (<cause>). N messages were held …` line is everything held, in one message. A pause that runs out with nothing held still ends in one message (`Your pause ended (your stated wait ran out). Nothing is left to deliver.`): take that turn to re-check your cards, and pause again if there is still nothing to do.
It arrives like a card comment from 50 Arms, attached to the card of the person's event that ended
the pause, otherwise to the plan, otherwise to `SESSION`, but it is a notice (its text begins "This
is a notice, not a card comment"), not a card comment. Over 30
held events it lists them by card (one line per card with counts by kind) instead of one line each:
read those cards for the detail. A long release continues in further frames ("Held while you were
paused, continued"): read them all before acting. Act on it once, as on the
messages themselves (a held nudge still means the cards it names are workable now). A pause that
ended on your own call needs no reply. Read the plan before resuming, since the cause names what
changed.

A pause longer than your team's agent hold timeout (default 60 minutes; a team owner or admin sets it
on Team > Agents) gives your session's team agent back to the pool. The pause-ended notice then says
`Your agent <name> went back to the pool after <N> minutes paused. Call plan_connect to take an agent
again.` On waking, call `plan_connect` before any other dashboard work: it takes the same agent again
when it is free, otherwise the next free one, otherwise answers `agent_limit_reached`. Until then work
calls are refused with `agent_not_held` or `agent_needed`.

## Stopping

Before stopping or saying "blocked", re-read every open plan card and write each real
blocker (card id, open problem, user action) to an agent note on that card.

## Sub-agents

Delegate by card id: `Agent({subagent_type:"danxbot:worker-<tier>", prompt:"<CARD-ID>"})` is
the whole brief — each tier loads `danxbot:issue-workflow` itself. Add the worktree rule
below only when the card wouldn't cover it. Set `effort_level` first, by its hardest single step, never
its breadth (issue-workflow's creation guide, § Effort), then pick the tier whose description names it;
never `general-purpose`. A card that carries gates never goes to a `worker-haiku-*` tier.
A builder runs its PRE gates itself and never spawns gate agents; once it reports its pushed
tip SHA, you run its POST gates as gate workers and say when to land.

Partition files before fanning out. State a time-box; never background a long test run and
end the turn — wait bounded, or `rollback_pickup` and report. Run tests once, after the edits
land. Every brief makes the sub-agent stop each background task it started before reporting,
or name it. Stop a dispatch once its report is consumed. A report is a lead, not a finding:
read the diff, confirm the push, check for leftover worktrees, commits or background tasks.

Slice a long job into sub-agents that each end well under about 300k tokens of context. When a
sub-agent nears that, ask it to write a `HANDOFF` agent note on its card (last item done, next item, what the next agent
must know) and stop; relaunch a fresh one from the original brief plus that note, in the foreground: a
background relaunch ends your turn. A fresh agent carries far less context than a compacted one, but only what the note says
crosses, so use it when the job's state is on disk, not in half-finished reasoning, an open browser or an
unsaved edit.

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
  and record anything else as paused in an agent note on its card. (This is the account's usage pause, which
  danxbot manages; it is not the pause you make yourself, described under "Pausing".) When you have nothing left to do, pause
  with `waits_on` `pacing`, so the change that frees slots wakes you.
- **Critical**: every running agent makes a work-in-progress commit, pushes its branch, writes
  an agent note on its card saying where it is, and stops; do the same for your own state,
  write an agent note on each card saying what is paused, and go idle. A later message back to on pace means: read those cards and resume
  what was paused.

## Liveness

"Running" needs a counter (e.g. `tokensOut`) read twice ≥60s apart with both timestamps, or
the JSONL last-entry age — name the source.

## Handoff

Before an actual compaction, load `danxbot:prepare-for-compaction`.

Retiring this session (a handoff, not a compaction): as your last plan action, after the handoff
agent note, call `plan_connect({plan_id, disconnect: true})` (`plan_id` = the plan you are on). Moving to
another plan needs no leave.
