---
name: issue-card-workflow
description: 'The one "work a card" workflow: claim, load context, TDD build, tick AC/checklists, run quality gates, complete. Used by both a dispatched danxbot worker and an operator-session sub-agent. Also covers card mechanics — transitions, problems (question vs action), comments, dependencies. LOAD BEFORE proposing card TYPE or slicing work into cards (epic/feature/story) — that decision, and the full creation/taxonomy/DB-schema/MCP-tool reference, live in references/card-creation-and-reference.md; load it too before any issue_create.'
---

# Issue Card Workflow

One card, claim to merge — same flow for a dispatched worker or an operator-session
sub-agent given a card by id. **Dashboard Postgres is the sole source of truth** —
`mcp__danx-dashboard__issue_*` (`mcp__danx_dashboard__issue_*` for an operator; resolve
your real prefix once, never assume) is the entire surface for card state; never touch
it via file operations.

Creating a card (type/effort/slicing/gates/triage) is separate —
`references/card-creation-and-reference.md`; load before any `issue_create`.

## Context: what differs between the two callers

| | Dispatched worker | Operator-session sub-agent |
|---|---|---|
| Worktree | prepared by danxbot | creates its own isolated worktree (the Agent tool's `isolation: "worktree"`, or the repo's own worktree command); never works in the shared checkout |
| Claim | danxbot claims | `issue_transition({action:'pickup', manual:true, assigned_agent})` with its own identity |
| Quality gates | danxbot runs gate dispatches | runs the gate reviewer sub-agents itself and records `issue_quality_gate_verdict` |
| Merge | per your profile instruction | commits, pushes to main, removes its worktree, proves nothing unpushed |
| End | per your profile instruction | `issue_transition({action:'complete'})` + `issue_retro`, then reports to the orchestrator |

Dispatched-only mechanics (`danxbot_complete`, halt, `agent-finalize.sh`, pre-synced
worktree, DB resets) live only in danxbot's `work` profile — this plugin reaches
operator sessions too.

## The flow

1. `issue_get({id, fields:["description","ac","comments","dependencies"]})`. Read the
   parent if `parent_id` is set; on a plan, read its architecture and note overlapping
   siblings.
2. **Claim it** before any work — see "Claiming" below.
3. Build with TDD — sub-agents for complex work, inline for simple; always the correct,
   ideal build.
4. Tick every AC/checklist item (`issue_checklist`), pass all tests, browser-test
   user-facing changes.
5. Run the quality gates through their reviewer sub-agents (architecture-reviewer /
   code-reviewer / test-reviewer, or your profile's equivalent); record
   `issue_quality_gate_verdict({id, gate, status, message: "<real finding, >=20 chars>"})`
   per gate. A gate that doesn't apply is removed (`issue_quality_gate({action:'remove'})`),
   never rubber-stamped.
6. `issue_transition({action:'complete', summary})` then `issue_retro` (both required,
   retro last — it 409s until terminal); finish per your profile instruction.

**Never wait on a human you don't have to.** Reversible → decide, do the work, note it
in a comment. Genuinely needs one → open a problem (below), never `AskUserQuestion` or
a plan-mode pause.

### Question versus action — decide before you file (DX-3313)

Before filing, apply the test: **could I do this myself if I tried harder,
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

No separate "requires human" flag — a card needs one exactly when
`open_problem_count > 0`. Escalation IS opening the problem. Removing a card's last
open problem always closes that need.

## Claiming a card (pickup)

A `ToDo` card is an open dispatch request — working it unclaimed races a second worker
onto it.

1. `issue_transition({id, action:'pickup', manual:true, assigned_agent:'<your identity>'})`.
   `manual:true` is mandatory — it marks the card operator-owned so nothing
   auto-transitions it. Read `assigned_agent` back: anything but you (incl. `null`)
   means the claim failed — re-issue, stop after two failures.
2. A manual hold clears only via an explicit transition from your session
   (`complete`/`cancel`/`block`/`rollback_pickup`).
3. A sub-agent under your control is still your card: pickup first, keep it
   `In Progress` throughout, drive the terminal transition yourself.

## Mechanics

- **AC/checklists** — `issue_get` returns each item's `check_item_id` under
  `checklists[].items[]`; flip via `issue_checklist({action:'update_item',
  checklist_id, item_id, status:'passing'})`. `complete` refuses (409
  `unresolved_items`) on any `incomplete` item — a hard gate.
- **Comments** — `issue_comment({id, action:'add', text})`, markdown `##` headers,
  narrative only; durable decisions go on a card, never a comment alone.
- **Dependencies** — `issue_dependency({id, action:'add', kind:'depends_on'|'conflict_on',
  target_id})` for a card already known, never a discovery scan.
- **Problems** — `issue_problem({id, action:'add', statement, type?, summary?,
  solutions?})` is the only way to escalate; see "Question versus action" above.
- **Retro** — `issue_retro({good, bad, correctable_danxbot_problem,
  correctable_danxbot_problem_description, action_item_ids[], commits[], tests[]})`.
  `tests[]` (empty OK, omitting fails) and the `correctable_danxbot_problem` pair are
  required every call, answered honestly — `true` starts an automated repair.
- Never write `status:` literals; `issue_transition` derives and stamps it.
- **MCP disconnected ≠ board unreachable.** It drops often (`CONNECTION_CLOSED`); the
  dashboard's plain HTTP API (`src/issues/routes.ts` + `src/issues/write/*.ts`) does
  everything the MCP tools do — use it (bearer token from the per-target token file)
  rather than calling the board unreachable on an MCP error alone.
- **Issue-ref comments** — `// CARD-ID: <reason>` on any non-obvious decision the AC
  forced; grep anchored refs
  (`grep -rnE '(//|#|--|<!--|/\*|\*)[[:space:]]*[A-Z]+-[0-9]+' <files>`) and load each
  referenced card before editing code that carries one.

## General rules

- One card at a time as a dispatched worker — no orchestrator, no sub-agents. An
  operator-session sub-agent orchestrates its own per its own session's rules.
- `type:` ∈ `Epic`|`Feature`|`Story`|`Bug`|`Chore`; slicing/effort/gate/triage →
  `references/card-creation-and-reference.md`.
- AC lives in `ac[]`, never inline. Phases/sub-cards are their own cards in
  `children[]`, via `issue_edit({parent_id})`.
- Never manually append `## Retro` — use `issue_retro`. Never escape markdown.
- Durable work-records live on a card, never a repo `.md` or TaskCreate/TaskList.
- Work owned by another plan or agent session: hand it over as a card (full context and
  instructions, right plan, readied, `depends_on` from yours) and wait. Never monitor or
  investigate another session's cards unless the operator explicitly asks.
See `references/lifecycle-states.md` (state machine, triage, gates),
`references/phases-epics.md` (`children[]` mechanics), and
`references/card-creation-and-reference.md` (taxonomy, DB schema, MCP reference).
