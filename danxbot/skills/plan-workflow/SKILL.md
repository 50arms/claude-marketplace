---
name: plan-workflow
description: 'THE planning workflow when a human is in the loop beyond a quick cleanup: multi-step plan or build, a question that affects a plan, monitoring, resuming or handing off work, a pasted plan link. "Make a plan" means a 50 Arms plan, never a task list, plan mode or a question in chat. Load before connecting to, creating or writing a plan.'
---

# Plan Workflow

The plan in the dashboard DB is the record; chat is not. The mantra's rules apply
throughout; this skill is the plan mechanics.

## Start (every new, resumed or compacted session)

1. Sign in: `plan_connect`, with the plan's `plan_id` when you know it (a plan link in the
   prompt, or your session's plan in `GET /api/plans`), else with no `plan_id`. A session holds
   no dashboard key until its user approves it: `approval_required` (or `approval_pending`) is
   not a failure. Show the user the confirm code and the approval URL, and once they approve
   call `plan_connect` again. The plugin shows the link and code at once and opens nothing: the
   person clicks the link, so never open the URL yourself (two tabs). The same holds for
   `request_permission`. Every other dashboard tool answers "not signed in" until then.
2. Take your identity from the reply: signing in makes you one of the team's agents, and the
   reply's `agent` and `agentInstruction` say which. Use that agent's name and personality for
   the whole session and sign every note, comment and message with its name; never choose a
   name yourself. When no agent can be signed in as:
   - `agent_needed` → propose one at once, without asking in chat: `danxbot_api`
     `POST /api/team/agent-proposals` with `{name, bio}` (a first name not taken in the team, a
     short bio of the personality you want) answers `{public_id, url, expires_at}`. With an
     avatar image you made (png, jpeg, webp or svg, under 1 MB), `POST
     /api/team/agent-proposals/<public_id>/avatar` with `body_file` set to its absolute path.
     Give the person the `url`: they review the proposal and press Create, which signs you in
     as the new agent and connects you to the plan or card you asked for; you are woken with an
     event saying so. Taking them needs no `plan_connect`; a naming or role step the event carries
     makes its own call. Not woken → call `plan_connect` again: it answers the agent and plan you
     hold.
   - `agent_limit_reached` → tell the person the limit the reply names (`held` of `limit`, and
     who can raise it, `raised_by`), or that ending another session frees its agent; call
     `plan_connect` again once they say one is free.
   Until an agent is held, every other dashboard call answers that same state: do no other
   dashboard work. You hold the agent only while this session is connected: a revoked key, a
   session that stopped responding for a minute (a crash) or a pause past the hold timeout frees
   it at once, and signing in again takes the next free agent, never necessarily the same one.
3. What you work on: a plan → `plan_connect({plan_id})`; none in the list fits → create one.
   One card on no plan (a one-off, a quick fix, an epic that is not a plan) →
   `card_connect({card_id})` instead; a card on a plan is refused `card_on_plan` (connect to
   that plan). A session holds a plan or a card, never both: connecting to one lets go of the
   other. Neither → stay signed in, on no plan.
4. Your session title follows what you hold, `{Name}` being your agent's name: on a plan
   `{Name}: PLAN-NNN {short title}`, on a card `{Name}: {CARD-ID} {card title}`, on neither
   `{Name}`. The sign-in reply on no plan gives that title in `title` with `titleInstruction`; a
   plan connect's `naming` block (status `needed`) gives the exact title. Rename the thread to it
   (desktop `set_session_title`; terminal: ask the person to `/rename`); after a plan connect
   asked for it, connect again with that `title`.
5. Orient from the connect briefing, else read the plan's records, architecture and cards,
   plus one batch read of its In-Progress/open-problem cards and the newest handoff agent note
   (`agent_notes` on the card read).
6. Follow `plan_connect`'s browser instruction as written.

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

Acknowledge each flagged event right after reading it, before acting: a line starting
`[ack-required event N]` gives the exact `danxbot_api POST /api/plan-sessions/me/events/N/ack`
call (no body). One you already acted on is only acknowledged, never acted on twice.

From the dashboard:

- `has not made an MCP call …` → the dashboard's idle nudge: every card it names is workable by
  its recorded state. Work it, or record why you can't: a problem, `depends_on`/`conflict_on`, a
  block with the real reason, or `rollback_pickup`. Never just ignore it. It is not sent while
  you are paused (see "Pausing"); it is held and arrives in the message that ends the pause.
- `answered "…"` → an operator's answer: read the card's problems, act on the live decision,
  record the outcome. Retracted or changed → it overrides; already acted → keep, redo or undo.
  Recording the outcome means, in that same turn, editing every plan record, architecture
  section and card it changes. A problem stays on the card as the record of what was asked and
  decided: delete one only when it has become irrelevant (a change of direction made the question
  pointless), with a note saying why; never because it was answered or because another answer
  settled it. A problem a person commented on or answered is never deleted: the dashboard refuses
  the delete. When such a question no longer applies, add a solution saying so and why, mark it
  recommended, and ask the person to accept it. A new build card alone records nothing.
- `commented on problem` → a follow-up: reply with a comment on that problem. A comment that
  decides the question (for example "do it this other way") is not yet an answer: only a
  person's accepted solution answers. Edit the problem's solutions to state what they said (change
  one, or add one), mark that solution recommended, then tell them to accept it. Never delete the
  problem. If they tell you to accept it for them, call `request_permission` for `cards.answer`
  with that reason and answer the problem with that solution only once it is granted; never ask
  them to click it when they have already told you to do it. A design problem is the person's
  alone and no permission lets you answer it.
  One that asks, thinks aloud or says it is unsure decides nothing, however concrete its idea:
  answer what it asks in full (the exact calculation, a worked example) and leave the problem
  open. An option you write from it names every point you added and is never marked
  recommended until they confirm it.
- `opened a problem` → needs a human. Batches can arrive 10 min late — read the card; `…` →
  read it for the full text. A card's design problem (the one listing its designs to choose
  from) is the person's alone: nothing to do but tell them it waits in Needs You.
- `APPROVED revision N of design M` (then `answered` on the design problem) → a person chose
  that design, which passes the card's design gate: the card builds from the design it holds
  now. Nothing to record.
- `requested changes on revision …`, a `REJECTED revision …` that closed the card's last live
  design, or a comment starting `**Asked for another design:**` → the designer owes a turn: run
  the designer again ("Sub-agents"), unless one you started is still on it.
- `retracted the answer to` the design problem → the choice was withdrawn and the gate waits on
  the person again: build nothing from that design.
- `[plan events] digest — N agent/machine events since the last update:` → one record of agent
  and machine activity held up to 10 min, its events listed under it: read it, act only where it
  names a card of yours.
- a usage-pacing or auto-resume message from danxbot → carry on, or stop and wait, as "Usage pacing" says.
- `[50 ARMS] Compaction recommendation:` → advice, not an order. Never compact while a person is in an active conversation with you: a message of theirs reached this session in the last 30 minutes, or you owe them an answer. Then give the recommendation no answer (it comes again later) and never call compaction-ready; say ready only while you work on your own. Otherwise judge from what is left and what
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

Changed fact → edit; no longer true → delete. Changing, dropping or replacing a decision a person stated always needs that person (mantra item 3); a record or section stating a person's decision changes only on their answer.

Record as you go, never in one batch at the end. Assume this session can end at any moment (a
crash, a revoked key, a compaction) and may never sign back in: only the plan, its cards and
origin survive it. So at every checkpoint (a gate result, a push or landing, a decision, an
operator answer, a change in what the requirements mean), write it to the card or plan record in
that same turn. A local file (`.junk/`, a scratchpad, a notes file) is never a record, nor a
fallback for one.

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

1. Record why on the card first (a problem, an agent note, `depends_on`, or the real block), and
   any state not yet recorded: a pause often ends in a disconnect after which you cannot write.
   The pause is only the signal, never the record. Waiting on a person is always an open problem
   on a card of this plan, worded for the step left now (no note or comment reaches Needs You).
   That includes a check that needs an ordinary act of theirs (a design change request, a
   review): an `action` problem asks for it now; never wait for it to happen on its own.
2. Call `danxbot_api` `PUT /api/plan-sessions/me/pause` with `{reason, waits_on, ends_when?,
   expires_in_minutes?}`. `reason` is shown to the operator beside your session; `ends_when` says
   what would end the wait. `waits_on` is required, the cause you pick: `person` for an open
   problem, an approval or any answer only a person gives; `dependency` for another card, a build,
   a deploy or any other work you wait on; `other` when none fits. Never pause for usage pacing:
   when pacing stops you, you only stop (see "Usage pacing"). The pause lasts at most `expires_in_minutes` (default 120, at most
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
`pacing` (on pace, with no count cap or a budget above the sub-agents running; the message is delivered
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
on Team > Agents) disconnects your session: its key is revoked, its team agent goes back to the pool and
it leaves every session list. A session holds an agent exactly while it is connected, and nothing
remembers the agent you had. On waking, your next dashboard call is refused as a revoked key: sign in
again (approval as for any new key), then `plan_connect`, which takes the next free agent or answers
`agent_limit_reached`. The pause-ended notice then says `Your agent <name> went back to the pool: this session was
disconnected after <N> minutes paused. Sign in again with plan_connect.` Until you hold an
agent again work calls are refused with `agent_not_held` or `agent_needed`.

## Stopping

Before stopping or saying "blocked", re-read every open plan card and write each real
blocker (card id, open problem, user action) to an agent note on that card. A blocker only a
person can clear is an open problem there too (see "Pausing").

## Sub-agents

Delegate by agent profile and card: the brief's first line is `<profile> <CARD-ID>`, and
the sub-agent's first call fetches that profile's instruction for the card, which is its whole
task, so the brief repeats nothing the profile or the card says. Build a card with
`Agent({subagent_type:"danxbot:worker-<tier>", prompt:"work <CARD-ID>"})`. Add the worktree rule
below only when the card wouldn't cover it. Set `effort_level` first, by its hardest single step, never
its breadth (issue-workflow's creation guide, § Effort), then pick the tier whose description names it;
never `general-purpose`. A card that carries gates never goes to a `worker-haiku-*` tier.
A builder runs its PRE gates itself and never spawns gate agents; once it reports its pushed
tip SHA, you run its POST gates as gate workers, each briefed `gate-reviewer <CARD-ID> <gate>` at
the tier issue-workflow "Gates" names; once they pass, land it and complete the card. A card carrying
`plan-design` goes to no builder until a person chooses a design. Once the PRE gates before it
have passed and it carries no design yet, start its designer, unless one you started is still on
it: `gate-designer <CARD-ID>`, at the tier the gate's `effort_level` on the card names (unset:
`danxbot:worker-sonnet-high`). Run it again only for a design event above that owes it a turn.

Partition files before fanning out. Never background a long test run and
end the turn — wait bounded, or `rollback_pickup` and report. Run tests once, after the edits
land. Every brief makes the sub-agent stop each background task it started before reporting,
or name it. Stop a dispatch once its report is consumed. A report is a lead, not a finding:
read the diff, confirm the push, check for leftover worktrees, commits or background tasks.

A working sub-agent is replaced only by agreement, never by your decision alone. When its context is large, ask it (SendMessage) whether it should hand off. It answers one of three: no; later (ask again once its context has grown by the board's compaction step); or ready, after it has written a handoff agent note on its card and pushed its work. Only on ready, end it and start a fresh sub-agent from the original brief plus that note, in the foreground (a background relaunch ends your turn). Never put a context, token or time cap in a brief, and never stop a sub-agent for its size or because it is taking long; stop or redirect one only on evidence that it is doing the wrong thing (its pushes, notes or report show it off the card or looping), and say what the evidence is.

Never end a turn while unblocked work could be dispatched (a running build, test or deploy
is time to dispatch; a readied card waiting on a worker is not blocked), nor while work runs
with no wake-up armed. The one exception is a pacing stop: then you only stop ("Usage pacing"). Checks and reviews that de-risk waiting work (verification,
cross-repo checks, a whole-change review) are dispatchable too.

Worktrees you create go under the repo's git-ignored `.claude/worktrees/<name>`, never a
sibling checkout. Remove each once `git status --porcelain` and `git cherry origin/main
<branch>` are empty, delete its branch, and name what you removed.

## Usage pacing

A pacing message (`Usage pacing for your Claude account changed: …`) or a spawn refused with
`Usage pacing: …` states the level, the sub-agent budget of the whole account and the reset
time; trust those numbers, never your own estimate. Never retry a refused spawn.

The budget is a strict cap on sub-agents: exactly that many sub-agents run on the account at
once, never one more. Main threads (every session's own thread and each running worker
dispatch's agent) are counted and shown apart, but pacing never holds one back and the budget
never counts one. The sub-agent count is danxbot's own and is live, one for the whole account
(every session's sub-agents and the sub-agents of running worker dispatches). Each sub-agent
spawn takes its slot from danxbot before it starts, so there is nothing for you to count or reserve. A spawn whose slot
cannot be taken (danxbot could not be reached or did not answer) is refused too, in the same
`Usage pacing:` words, naming the failure.

**When pacing stops you, just stop.** A refused sub-agent spawn, or a pacing message saying the account is
over pace, critical, or at its sub-agent budget: end your turn and wait until you are told to continue. Do
nothing else. Record nothing (no agent note, no block, no problem, no pause call, no
work-in-progress commit), tell no one, and never do the work yourself instead. The pacer already
knows; danxbot wakes you with the message that lets you continue, and you then carry on where you
were. A pacing text that asks for more than this is outdated: follow this section.

- **On pace**: carry on. A spawn may be moved to haiku when the budget is nearly full.
- **Over pace, or the budget full**: stop as above. Agents already running are left to finish.
- **Critical**: stop as above (pacing itself never refuses or pauses your main thread; only sub-agent spawns are refused), and tell
  each running sub-agent to stop where it is and report back; once told to continue, continue each with `SendMessage`.

## Liveness

"Running" needs a counter (e.g. `tokensOut`) read twice ≥60s apart with both timestamps, or
the JSONL last-entry age — name the source.

## Handoff

Before an actual compaction, load `danxbot:prepare-for-compaction`.

Retiring this session (a handoff, not a compaction): as your last plan action, after the handoff
agent note, call `plan_connect({plan_id, disconnect: true})` (`plan_id` = the plan you are on). Moving to
another plan needs no leave.
