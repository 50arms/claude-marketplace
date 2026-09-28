---
name: issue-blocker
description: 'The whole blocked-card lifecycle: the false-blocker audit before you touch blocked/problem/waiting_on, which mechanism to use, and how to write the report that unblocks it. Covers block vs problem vs dependency, forbidden destructive git ops, and the operator playbook for a stuck card.'
audience: worker
---

# Issue Blocker — the whole blocked-card lifecycle

`blocked: {at, reason}` is a dispatch GATE, not a status column and not an escalation
(DX-2735/DX-2830). `deriveStatus` rule 3 projects it to `Blocked` on every read; there
is no direct `status: "Blocked"` write. It stops auto-dispatch, nothing more — it does
NOT put the card in front of a human: that happens exactly when there's an **open
problem** (`open_problem_count > 0`, computed automatically, no separate flag). The
agent doing the work can often resolve the blocker itself — do that rather than escalate.

Most "blockers" are rationalizations of avoidable work. **Part A**: the audit you run
BEFORE stamping `blocked` or opening a problem, so you don't file a false one. **Part
B**: what to do on a card someone else already marked `Blocked` (or `waiting_on`),
including the report that hands it to the operator.

## Part A — Is this a real blocker?

### The 8-item pre-block checklist

Create a TodoWrite todo per item; mark `in_progress` while auditing, `completed` only
after writing the verification answer in your reasoning. Any item ending `failed` →
abandon the Blocked/problem move and follow its recovery path. One false Blocked move
costs more than running this checklist.

1. **Can you resolve it yourself?** A real blocker survives only if a later agent
   resolves it (a card-specific tool failure) or only a human can (rotate a credential,
   push a secret to SSM, reach a repo you can't, make a goal-changing design call).
   PASS: name why it can't resolve here AND who does. FAIL: "operator must decide"
   between an obviously right/wrong option → decide and document; "operator must
   verify in the UI" → item 5's smoke substitute; "operator must restart/deploy/run X" →
   if you can run it, run it — open an action problem only if you genuinely cannot
   reach that infra.
2. **Uncommitted working-tree diff involved?** `git status -s`; list every `M`/`??`
   file you didn't write this dispatch. PASS: none in the blocker's path. FAIL: do NOT
   block — another agent's diff is interfering; don't touch it (forbidden ops below),
   note the conflict in `comments[]`, proceed with what you can verify — an
   interruption, not a blocker.
3. **Did you "verify the failure pre-existed" via stash/checkout/compare-to-parent?**
   PASS: never did this — the suite either passes for your changes (fix in-session) or
   it doesn't (item 2, or item 4) — the answer has zero value. FAIL: recover (`git
   stash pop` if stashed), document the violation in `retro.bad`, re-evaluate without
   pre-existence reasoning.
4. **Did you trace the actual code path by reading?** Failing test → code under test →
   name the file:line producing the wrong behavior. PASS: quote file:line + why — this
   is what lets you file a good Action Item if the cause is pre-existing. FAIL: read
   until you can name the line — without it you can't file an Action Item (speculation),
   block (unproven), or escalate (unproven).
5. **Is there a programmatic substitute for the AC's literal wording?** Cheapest first:
   *manual UI smoke* ("operator clicks X, sees Y") — mount the component with fixture
   data (`@testing-library/react`, `cd frontend && npx vitest run` — the Vue
   `dashboard/` app is frozen) and assert the DOM; reach for Playwright only when a
   component test can't. *Post-terminal-save / self-derived state* ("after Done, the
   parent auto-flips") — never verifiable from inside the triggering dispatch; find the
   deriving function (e.g. `deriveContainerStatus`), unit-test it directly, rewrite the
   AC to point there. *Pre-existing flaky test, unrelated, root-caused by reading, too
   involved for 30 min* — file an Action Item (`issue_create({type:"Bug", ...})`), push
   the id into `retro.action_item_ids[]`, check off your AC. PASS: no substitute exists
   — quote the AC + why each fails. FAIL: use the substitute, don't block.
6. **Could you fix the defect in 10–30 minutes?** Read the smallest fix that would pass
   the AC; estimate honestly. PASS: genuinely multi-phase/cross-cutting — quote the
   scope. FAIL: do it now — an Action Item isn't the answer when you could ship the fix
   this dispatch.
7. **Does the record name the resolving action with a verification command?** Write
   `blocked.reason` — or the problem `statement` + each solution's `body` — as if the
   resolver reads it in 30 seconds and executes it: the action, the exact command(s) to
   run and to verify. FAIL: too vague to be actionable — re-run items 1–6.
8. **Are you using Blocked to dodge a test failure/AC?** Actually unresolvable, or just
   avoiding the root cause? PASS: unresolvable, you can name resolver + command, item 7
   passed. FAIL: back to item 4 or 6.

### Forbidden destructive git ops

Against working-tree state you did not personally write this dispatch: `git stash`,
`git checkout --`/`git restore`, `git reset --hard`, `git clean`. Full ban →
`danxbot:issue-workflow`; listed here only because items 2–3 depend on it. Never use any of
these to "check" whether a failure pre-existed your changes (item 3).

### Field selection — `blocked` vs an open problem vs `waiting_on` vs `conflict_on[]`

Three orthogonal dispatch gates plus one computed. **All may coexist on one card by
design** — each models a different cause, each clears by a different actor/event, and
the picker AND-s them: dispatch only when every gate is clear. Picking the wrong field
is the violation, not setting more than one.

| symptom | correct mechanism | cleared by |
|---|---|---|
| Card must not auto-dispatch until resolved, and an agent can resolve it | `blocked: {at, reason}` — a gate, not a `deriveStatus` rule | Whoever resolves it, via `issue_transition({action:'unblock'})`. Answering a problem never clears it. |
| A human must *decide* something the agent cannot derive | Open a problem, `type:"question"` (default) | Operator answers, or removes the problem. |
| A human must *take external action* the agent has zero programmatic reach into | Open a problem, `type:"action"` — `summary` REQUIRED | Same as above. |
| Card waits for specific other card(s) to terminate | `waiting_on: {reason, by:[ISS-N,...], timestamp}` | Picker auto-dispatches once every id in `by[]` reaches Done/Cancelled. |
| File-overlap / in-flight race, detected by the Dependency PRE gate | `conflict_on: [{id, reason}, ...]` | Re-derived each dispatch from partner's current status. |
| Work belongs to a DIFFERENT repo danxbot runs as a board | **Delegate** — `issue_create({board:'<repo>:<slug>'})` + `depends_on` + a `## Delegated → <id>` comment | The `depends_on` gate holds + auto-clears. |

### Question versus action — decide before you file (DX-3313)

Before opening a problem, apply the test: **could I do this myself if I tried harder,
and is the only thing missing a decision?** Yes → `type: "question"`
(default). No — the blocker is access, credentials, hardware, a human's
authority, or a system genuinely out of reach → `type: "action"`.

| | Question | Action |
|---|---|---|
| `statement` | the question, one plain sentence | what is to be done — the deed itself, never phrased as a question |
| `summary` | optional, why it matters | **REQUIRED** — why it is needed, and why you cannot do it yourself (an action `add` with no summary is refused 400) |
| `solutions[]` | candidate answers, each with its own pro/con | the possible routes, each carrying its own steps |
| Ends when | a decision is recorded | the steps are actually done |

The why-I-cannot-do-this-myself sentence in `summary` is REQUIRED for an
action — it is the sentence that stops the operator reading your escalation
as laziness. Full parameter contract → `issue_problem`'s own `type` and
`summary` descriptions.

### Routing — pick the mechanism, not "the gate name I remember"

| You catch yourself thinking … | Right mechanism | NOT |
|---|---|---|
| "Operator must run a host command, genuinely can't be me" | `issue_problem` add, action + steps in a solution's `body` | `blocked` alone — nobody reaches the operator |
| "Need a design decision between A and B" | `issue_problem` add, solutions A/B, one `recommended` | `blocked` + the question in a comment — nobody sees it |
| "Something's broken, I/the next dispatch can fix it, but the card must not dispatch till then" | `blocked` (hold), `unblock` when resolved | An open problem — the operator isn't the resolver |
| "Phase 4 needs Phase 3's migration first" | `waiting_on: {by:["<phase-3>"]}` | `blocked` — parks it behind a gate nobody clears |
| "Sibling card editing the same file in-flight" | `conflict_on: [{id, reason}]` | `waiting_on` — that's declared-up-front, this is dispatch-time race detection |
| "Another agent's uncommitted diff broke my test" | Neither — note in `comments[]`, proceed with what you can verify | Any of the above |

`waiting_on` used for an operator-needed action silently dispatches once the named card
terminates, without the action ever happening — check the table, not memory.

### After all 8 items pass

**Hold — a later agent resolves it, no human needed:**
1. `issue_transition({id, action:'block', reason: <one sentence>})`.
2. `issue_comment` a `## Blocker self-audit` section quoting all 8 PASS results.
3. `danxbot_complete({status:"failed", summary:"..."})`.

**Escalate — a human must decide or act:**
1. `issue_problem({id, action:'add', statement, type?, summary?, solutions})` per
   "Question versus action" above. `solutions[]`: one per viable option (`title`,
   `body`, `pro`, `con`), exactly one `recommended`; numbered actions go in that
   solution's `body` — no separate `steps[]`. Zero solutions is valid for a pure
   free-form ask. Several independent questions = several problems.
2. `issue_comment` the same `## Blocker self-audit` section.
3. `danxbot_complete({status:"complete", summary:"..."})` — opening the problem IS the
   whole escalation.

Don't also block on the escalation path unless the card must stay held after the
operator answers — answering a problem never clears `blocked`. No 8 PASS results
quoted means neither move is earned.

## Part B — Encountering an already-blocked card

Auto-trigger whenever: about to read/work a card with `status: Blocked` or
`waiting_on != null`; about to start a card overlapping a `Blocked` one (same parent,
key files, domain — resolve the upstream block first, it may invalidate your work); or
the operator asks to unstick a card. Skip when the card is
`ToDo`/`InProgress`/`Done`/`Cancelled` with `waiting_on: null` and not `Blocked`.
`blocked` never reaches a human, and answering a problem never clears it — orthogonal,
see Part A's field table.

1. **Load the card**, `issue_get({id})`. Vague ask ("unstick the urgent one") →
   `issue_list({filter:{status_derived:['Blocked']}})`, pick by priority (Bug >
   Feature, production-impact > stretch goals, oldest first on ties).
2. **Find the blocker comment to relay.** Scan `comments[]` newest-first for the last
   "Blocked"/"Operator action" section — relay as the agent's claim, attributed, never
   asserted as your own finding. Absent → fall back to description + `blocked.reason` +
   open AC items.
3. **Misclassification audit, before writing anything.** Is every "operator must do"
   step actually agent-runnable? All local → **demote and do it yourself**, no
   playbook: `unblock`, comment naming the misclassification (local steps, what you
   ran, outcome), do the work, close per the normal workflow. Mixed → run the local
   steps first, write the playbook only for what remains. Human-only steps with no open
   problem mean the operator never saw them — say so in the report's Blocker line and
   open a problem, don't just narrate it.
4. **Extract four fields:** **Blocker** (1 sentence, attributed unless self-verified),
   **Done** (commits, ACs, tests), **Operator must do** (numbered, ≤2 lines each, exact
   commands), **Outcomes** (success and failure branch, always both). An irreversible
   step you hand the operator (deploy, destructive command, credential rotation) needs
   its premise verified, or say plainly you couldn't.
5. **Output — only if step 3 found genuine human-only blockers** (≤20 lines total):

   ```
   ## <ISS-N> — <one-line title> (≤12 words)

   **Goal.** <one sentence — what the operator needs to do, plain English>

   **Status.**
   | Shipped | Pending | Commits |
   |---|---|---|
   | <what's done> | <what's left> | <sha refs if any> |

   **Blocker.** <one sentence — exactly why the agent cannot self-progress>

   **What you do.**
   1. <step + exact command>

   **Outcomes.**
   - ✅ **<success branch>** → <what happens next>
   - ❌ **<failure branch>** → <what to capture / paste back>
   ```
6. **Stop.** Do not start fixing, edit the card, or change AC checks — the report ends
   the skill. The operator runs the steps and reports back; only then resume work.

**Anti-patterns:** re-investigating the bug from source or asserting a relayed comment
as fact; proposing a different fix instead of reporting on the chosen one; editing AC
during the report; a single-path "do this and you're done" instead of two outcome
branches; skipping the operator-action section because it seems obvious; stamping
`blocked.at` without `blocked.reason` (both move together — `deriveStatus` reads `.at`,
the operator reads `.reason`).

**Boundary with `danxbot:issue-workflow`:** that skill is the full lifecycle
(create/save/move/retro); Part B here is a read-only summary of one stuck card. They
compose — Part B produces the report; once the operator confirms an outcome, resume
via the normal card workflow to update AC and close.
