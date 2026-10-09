# Creating and sizing a card

Load before creating a card, or before choosing a card's type, slices or effort.

## A decomposition drafted before this loaded is void

Picked a type, slice list or effort before reading this? Discard it and re-derive from the
gates below — they are the input to the decision, never a stamp on a draft. Before creating any
Feature/Epic, print the Slice Plan (below) in your message; no plan, no create.

## Types

| Type | Is |
|---|---|
| Story | One vertical slice that ships as one green functional commit — the atomic unit, as small as still testable |
| Bug / Chore | A defect fix / work with no direct user value (deps, docs, tooling, a decision); sized like a Story |
| Feature | A few Stories delivering one stakeholder-facing capability |
| Epic | Many Stories, or several Features |
| Task | A planning record (question, decision, note) — never dispatched |

Feature and Epic are containers: context and goal only, status rolled up from children,
never worked. Work written into a container's own body or AC is a defect.

## The slice gate

Scope is counted in vertical slices, never time, files or LOC. For each candidate slice write
"Story N: <verb> X → a human can now see/do Y → one green commit", then check it: if only
this card lands and no sibling ever does, is the running system observably better? No →
the pieces interlock and are ONE Story, however large. One slice →
Story; a few → Feature; many or several Features → Epic. Importance, risk or "feels big" are
not slices. Never slice by layer (schema, client, routes) or by call site; each slice carries
its own thin schema and plumbing.

**Combine by default.** Split only when the whole is too large for one green commit, or the
parts differ in nature (another subsystem, separately reusable). Same for phases: every
phase costs a full dispatch.

**A Story body with 2+ top-level `Layer`/`Part` headings, or an appendix as large as its
requirements,** is showing its slices — flag it with the headings found and re-file it as a
Feature.

**Other repos' work doesn't count.** A card lives on one board; another repo's slice is its
own card on its own board.

**Never a childless container.** A Feature/Epic without children can't be readied or picked
up, so create its children the same turn (Epic → `phase_children[]`; Feature → child cards
with `parent_id`). Can't → it's a Story. Parent→child: Epic → Feature/Story/Bug/Chore/Task;
Feature → Story/Bug/Chore/Task; leaves have none.

## Effort

`effort_level` picks the model that implements the card. Set it by the hardest SINGLE step's
reasoning once the card's plan is written, never by file count, breadth, size or importance:
a step the plan spells out is mechanical however often it repeats, and breadth multiplies the
cost of a bigger model, so a wide mechanical change goes LOWER, not higher.

- `max` (Opus): the work IS thinking: planning, architecture, skill or prose rewrites.
  Reviewing them is `very_high`.
- `high`: one step needs judgment the plan could not settle (an algorithm, a concurrency or
  state invariant, debugging an unknown cause).
- `medium`: routine code with clear AC and prior art to copy.
- `low` and below: every step is spelled out (rename, swap a call, copy a pattern), even
  across thousands of files.

Example: swapping a formatter call for a new component at 40 call sites in 25 files, where
the component's behaviour is specified, is `medium`: only the component needs thought. A code
card that seems to need `max` is under-planned: plan more instead of raising the effort.

## Ordering

The moment you know B needs A first — at creation or later — add a `depends_on`
dependency from B to A. `phase_children[]`
wires no order, and leaving B in Review is not a hold. A card known to need work is readied
right after filing; Review is triage-only.

## Quality gates

A card carries its board's default gates for its type; `quality_gates` adds more, each with a
`note` saying why, at creation or later. Add when the card…

| Gate | Phase | …when the card |
|---|---|---|
| `plan-dependency` | PRE | likely overlaps in-flight work on the same surface |
| `plan-architecture` | PRE | is non-trivial design: new module boundaries, core invariants |
| `plan-tdd` | PRE | has behaviour to pin test-first |
| `code-architecture` / `code-quality` / `code-test-quality` | POST | needs that review of the finished diff before completion |

## Triage opt-in

Pass `triage_enabled` on every card and every phase child. `true` only when it is fine for
danxbot to ready and build this card with no further involvement from you: an approve verdict
is silent, while keep or defer reaches the session as a problem event.
