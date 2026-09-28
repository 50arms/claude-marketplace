# Lifecycle States & Transitions

## Status Derivation Rules

Statuses are computed from lifecycle triggers via `deriveStatus()` in `src/issues/derive/status.ts` (CLAUDE.md Core Principle 2 is the canonical statement; this table mirrors it). Six rules, five timestamps:

| Rule | Condition | Derived status |
|---|---|---|
| 1 | `cancelled_at !== null` | `Cancelled` |
| 2 | `completed_at !== null` | `Done` |
| 3 | `started_at !== null` (and no terminal trigger above) | `In Progress` |
| 4 | `ready_at !== null` | `ToDo` |
| 5 | `archived_at !== null` | `Backlog` |
| 6 | (fallthrough, all five null) | raw `status` field (`Review` on creation) |

Precedence: 1 > 2 > 3 > 4 > 5 > 6, first match wins. **`started_at` is decoupled from `dispatch_id`** (DX-1565) — pickup stamps `started_at` directly, not a side effect of a `dispatch` row existing. **`Blocked` is NOT one of these six rules and is NOT a derived status.** `blocked.at` is a dispatch GATE (blocks `pickup`, checked at `src/issues/derive/dispatchable.ts`) — it leaves whichever of the six rules above already applies untouched; a blocked card can display as ToDo, Review, or In Progress underneath the gate. **Agents NEVER write `status:` directly** — timestamp triggers + gate fields drive state.

## "In Progress" has more than one cause — verify before declaring health, never trust the count

An aggregate count of "N cards In Progress," or a dashboard "Agents Broken" banner, is a symptom pointer — not proof of health OR proof of a specific cause. Before declaring the system healthy, or diagnosing what's wrong, resolve EVERY `In Progress` card to one of:

1. **Container rollup** — an Epic/Feature parent derives `In Progress` because a child does (see Container Status below). No action; the container's own `started_at` stays null, only the derivation cascades.
2. **Legitimate manual/operator pickup** — `dispatch_kind === 'manual'`. Owned by whoever picked it up; not the poller's concern, no self-heal applies.
3. **Genuinely stranded** — `started_at` is set but the underlying dispatch process is dead (worker restart, crash, or a failed dispatch that never reached its own terminal trigger). This is the only case that needs recovery.

**Mechanical check before saying "N In Progress is healthy" or before diagnosing why:** for EACH In Progress card, read `started_at` / `dispatch_id` / `dispatch_kind`, AND cross-reference the real dispatch-tracking table's running/queued rows against the worker's actual concurrent-dispatch capacity. A count of In Progress cards that exceeds worker slots, or that doesn't reconcile 1:1 against live dispatch rows, means some fraction is stranded — the aggregate number alone cannot tell you which fraction. Same discipline applies to an agent-profile "broken" flag / banner: clearing it is a fresh start, not a diagnosis — check the profile's strike history (which card, which failure reason) before assuming the same failure won't immediately re-trip it.

## Status on Creation — ALWAYS start in Review

**Every newly created card MUST start with `status: "Review"`** — without exception. Review is the holding pen for un-audited cards. The per-card triage agent is the only mover from `Review` → `ToDo` (stamps `ready_at`).

This applies to:
- Human-typed cards via dashboard Create-Card button.
- Agent-created via `issue_create` — the server always starts a card in Review; there is NO `status` parameter to pass (`issue_create` rejects unknown keys).
- Cards in epic + phase fan-out (epic AND every phase start `Review`).
- Action-item cards spawned mid-retro.

**Why:** Card in `ToDo` is dispatchable next tick. If description half-written, AC vague, scope overlaps other in-flight work, poller wastes dispatch flailing. `Review` forces triage agent to read cold + decide: Approve (→ `ToDo` via `ready_at`), Cancel (→ `Cancelled` via `cancelled_at`), Defer (→ `Backlog` via `archived_at` + `ready_at: null`, and escalates), or Keep (escalates to the operator via an open problem, stays derived-Review — DX-2782/DX-2830, no TTL to refresh any more).

**Promotion to ToDo is a SEPARATE, EXPLICIT call — never an implicit side effect of creation.** `issue_create` has no `status` param; every card lands in Review first, full stop. Promotion via:
- Triage agent ICE-scores Approve → stamps `ready_at = <now ISO>` (rule 4 → `ToDo`) — normal path.
- Human operator promotes via dashboard (PATCH writes `ready_at`).
- **The creating agent itself, same turn, when it already knows the card needs to happen now** (CLAUDE.md: "if you know the card needs to happen, transition it to `ready` immediately after filing"): (a) finished description + `ac[]`, (b) verified zero-context-test pass, (c) confirmed genuinely dispatchable right now. This is the explicit two-step create-then-`ready` call, not a shortcut — default to leaving it for the triage agent only when one of (a)–(c) isn't yet true.

**Interaction with `waiting_on`.** `waiting_on` is status-independent — card may carry dep-chain record at any status (Review, ToDo, In Progress, Blocked). Validator does NOT couple them. Sequential phase chains may stamp `waiting_on.by[]` at creation alongside `status: Review` — chain rides through Review → ToDo cleanly; no second-pass edit needed.

**Interaction with container status derivation (Epic OR Feature).** Poller propagates the parent container's triggers from children's derived-status union. When all children derive `Review`, the container also derives `Review` (rule 6 fallthrough). When the creating agent stamps `ready_at` on some children, the parent container gets its own `ready_at` stamped by poller (rule 4 → parent `ToDo`). Agent does NOT manually stamp a container's triggers — derivation owns them.

## Triage Lifecycle

The triage block on each card is owned by the **per-card triage agent** dispatched by poller. There is no `triage.expires_at`/TTL column any more (dropped, DX-2820) — the automatic trigger, `getTriageEligibleCardId` (`src/dashboard/dispatcher-deps.ts`, DX-1886), picks ONE eligible `Review` card per board per tick (not blocked, no open problem, no active dispatch, `triage_enabled: true`, sorted by `priority` DESC / `COALESCE(triage_ice_total, 0)` DESC / numeric id ASC) and dispatches a `triage`-profile agent with task body `Triage card <PREFIX>-N`. One card per dispatch — bulk-orchestrator retired.

**Auto-triage is EXPLICIT opt-in per card (`triage_enabled`, default `false`).** The automatic dispatcher's eligibility query only ever selects cards with `triage_enabled: true` — a card created without an explicit `triage_enabled: true` sits in Review untouched by automatic triage forever. Every `issue_create` passes the flag explicitly — see the "Auto-Triage Opt-In" section in SKILL.md. Operator-directed triage (a manual `triage`-profile dispatch, `POST /api/triage`, direct `issue_triage`) is NOT gated by this flag.

**Automatic-trigger eligibility vs manual triage paths, by status.** `reassess_hint` and `triage_expires_at` are both dropped columns (`src/issues/view-types.ts:23,148`; DX-2820) — nothing stamps or reads either any more. There is no per-status TTL/cadence left; `triage_ice_total` survives only as a sort tie-break (below), never a schedule.

| Derived status | Automatic poller trigger? | Triage decision (when triaged, automatically or via the `triage`-profile dispatch/`POST /api/triage`) | Trigger write |
|---|---|---|---|
| `Review` | **Yes** — `getTriageEligibleCardId` selects it the instant it is `triage_enabled: true`, not blocked, has no open problem, and carries no active dispatch (no TTL, no wait) | Score `confidence` 0-5 → server picks Cancel / Defer(Park) / Keep / Approve | Cancel: stamps `cancelled_at` (terminal). Defer: stamps `archived_at` + `ready_at: null`, plus opens a problem (see below). Keep: no column stamp, stays derived-Review, opens a problem (see below). Approve: stamps `ready_at`. **Keep and Defer no longer stamp `blocked_at` (DX-2782/DX-2830 retired that) — both instead open a problem stating `"Triage: <reason>"` with exactly three solutions (`Approve and ready` / `Defer` / `Cancel`, one `recommended: true` — `Approve and ready` for Keep, `Defer` for Defer). Opening the problem is what puts the card in the operator's Needs You view (`open_problem_count > 0`); answering it auto-applies the outcome via the normal `issue_transition` actions. A freeform answer just closes the problem with no side effect.** |
| `Blocked` | **No** — retired from this trigger's eligibility before it was restored; only reachable via operator-directed dispatch | Hard Gate audit → Demote OR Confirm | Demote: clear `blocked: null`. Confirm: leave `blocked` as-is (no re-audit timer to refresh — the next operator-directed dispatch re-runs the audit whenever one is requested). |
| `Waiting On` | **No** — same as `Blocked` | Re-check `waiting_on.by[]` — clear if every dep terminal | Clear: `waiting_on: null` (no trigger write; status-independent). |
| `ToDo` / `In Progress` | n/a | Not triaged | n/a |
| `Done` / `Cancelled` | n/a | Terminal — never re-triaged | n/a |

**Dispatch sort (work-ready ToDo AND triage-eligible Review use the same order):** `priority` DESC, `COALESCE(triage_ice_total, 0)` DESC, numeric id ASC (`pickDispatchableCardsInProcess` / `listIssuesFiltered` / `getTriageEligibleCardId`, `src/dashboard/dispatcher-deps.ts`). ICE = Impact × Confidence × Ease, each axis 1–5, total 1–125, stamped by triage. There is no "untriaged first" bucket — an untriaged card simply sorts by `COALESCE(triage_ice_total, 0)` = 0. Agents don't rank — write a good description; a Review card's eventual triage ICE score governs its later priority.

**`Action Items` is not a status.** Action-item cards carry `status: Review` so triage picks them up alongside the Review list; the DB record stores `status: Review`.

## Blocked vs Waiting On vs an Open Problem (needs a human)

Canonical field-selection table (which of `blocked` / an open problem / `waiting_on` / `conflict_on[]` applies, the coexistence example, and the escalate/don't-escalate routing) lives in `danxbot:issue-blocker` § "Field selection" — this file does not restate it. The one piece specific to THIS reference is the mid-dispatch escalation procedure:

### Termination contract for escalating mid-dispatch

Opening a problem IS the whole escalation — there is no separate "set requires_human" step (DX-2830 deleted `issue_requires_human` and the `requires_human_reason`/`requires_human_set_by`/`requires_human_set_at`/`issue_requires_human_steps` columns entirely; DX-2801's mid-dispatch pickup-state gate on this was cancelled into DX-2830, so `issue_problem add` works on any non-terminal card regardless of pickup state). When an agent escalates mid-dispatch:

1. `issue_problem({id, action: 'add', statement, solutions?})` — zero solutions is valid; the operator then answers free-form.
2. The dispatch still ends with `danxbot_complete({status: "complete", summary})` — same as any other finished turn. Do NOT flip `status` terminal and do NOT fill `retro` — the human is the next actor, the open problem is the only signal needed.
3. The poller skips the card every tick while `open_problem_count > 0` — pickup, auto-triage eligibility, and dispatch all exclude it unconditionally, no TTL.
4. Once the operator answers the card's last open problem (or an agent removes it), a fresh dispatch picks the card up and continues — read `issue_get({id, fields: {problems: {decisions: true}}})` for the operator's `decisions[]` first.

Humans can also open a problem via the dashboard directly when they want to park a card on something they'll do themselves — same shape, no agent action required.

## Reopen (Terminal → Dispatchable)

Reverse the terminal trigger. NEVER touch `status:`. NEVER touch `list_name`. Only timestamp triggers + gate fields drive state.

| Scenario | Trigger writes (atomic, same edit) |
|---|---|
| Reopen Done | `completed_at: null` + `ready_at: <now ISO>` |
| Reopen Cancelled | `cancelled_at: null` + `ready_at: <now ISO>` |
| Reopen back to Review | clear terminal trigger + leave `ready_at: null` (rule 6 falls through to raw `status: Review`) |

Forbidden in reopen edits (and every other): writing `status:` field directly via `issue_edit`. Use `issue_transition` to drive lifecycle. Status and display list are server-derived from trigger fields; agents touch only trigger timestamps. Use MCP tools only.

## Container Status is Computed, Not Edited

A **container type** (Epic OR Feature) has its status **derivation-owned by server** — computed from its children's derived statuses, NOT from its own lifecycle, **while it has children**. Feature, like Epic, is a CONTAINER: never dispatched to a worker, status computed from children, its own lifecycle columns (`ready_at` / `completed_at` / `cancelled_at` / `blocked`) stay null. Story / Bug / Chore are **leaves** — a leaf NEVER rolls up from `children[]` even if it somehow has any; its status derives from its own lifecycle. The DB engine computes container status from children's derived statuses — union of child states propagates correctly. Agents NEVER manually stamp a container's triggers; call `issue_transition` on child cards instead; server recomputes container status automatically.

**Two carve-outs to "computed from children" (CLAUDE.md CP1/CP2):** a **childless container** (DX-2177) honours its own `completed_at`/`cancelled_at` directly — nothing to roll up — so a childless Epic/Feature accepts a manual `complete`/`cancel` just like a leaf. A **`Task` child does NOT count toward rollup** (DX-2493) — a container whose only children are `Task`s behaves as childless for this purpose (`CONTAINER_STATUS_CHILD_TYPE_EXCLUSION_SQL_LIST`); only `Story`/`Bug`/`Chore`/nested `Epic`/`Feature` children hold a container open.

**Priority rules (first match wins) — same for Epic AND Feature:**

1. Any child derives `Blocked` → parent stamped `blocked: {at, reason}`.
2. Any child derives `In Progress` → parent derives `In Progress`.
3. Any child derives `ToDo` → parent stamped `ready_at`.
4. All non-cancelled children derive `Review` → parent derives `Review`.
5. All non-cancelled children derive `Done` → parent stamped `completed_at`.
6. All children derive `Cancelled` → parent stamped `cancelled_at`.

Cancelled children excluded from rules 4–5 — single non-cancelled child shifts answer. Rule 6 fires only EVERY child Cancelled. Mixed terminal states leave parent's current status untouched.

Parent rollup ignores an open problem on a child — checked only at dispatch, not propagated. Dashboard surfaces a child-count subscript on epic children when any phase has `open_problem_count > 0`.

**Implications for agents (container = Epic OR Feature):**
- When you finish a child card, use the two-step termination sequence (per your profile instruction for a dispatched worker) — `issue_transition` FIRST, THEN `danxbot_complete`. The poller propagates the parent container on the next tick. Do NOT touch the container — edit overwritten.
- When a child stamps `blocked.at`, the container's `blocked` synthesized by poller. Operator triages from container view.
- The container stays at whatever derivation produces. Stamping `completed_at` on an Epic OR Feature with one child `In Progress` is no-op, cleared next tick.
- Parents with `waiting_on != null` skipped by parent-status derivation — parent's own dep-chain note takes precedence. Set parent's `waiting_on` explicitly when needed.

**Forbidden end-states for any turn creating a container (Epic OR Feature):**
- Container written, `children: []`, no child cards created.
- Container written, work / split listed only in description prose, no child cards created.
- Container written, "phases TBD" / "left for triage" / "will split next session" anywhere.
- **Feature written with executable work in its own body / `ac[]` but NO child cards.** A Feature is a container — work lives ONLY in child Story/Bug/Chore cards; a Feature that describes its own work is INVALID.

If about to end turn in any — STOP, write the child cards first. CRITICAL: a container (Epic OR Feature) without child cards is INVALID + workflow violation.
