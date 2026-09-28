# Creating and sizing a card

Load before any `issue_create`, or before choosing a card's type, slices or effort.

## A decomposition drafted before this loaded is void

Picked a type, slice list or effort before reading this? Discard it and re-derive from the
gates below — they are the input to the decision, never a stamp on a draft. Before any
Feature/Epic `issue_create`, print the Slice Plan (below) in your message; no plan, no create.

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
the pieces interlock and are ONE Story (carry the size in `effort_level`). One slice →
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
with `parent_id`). Can't → it's a Story. Parent→child: Epic → Feature/Story/Bug/Chore;
Feature → Story/Bug/Chore; leaves have none.

## Effort

`effort_level` is the reasoning depth the work needs, set by the kind of work, never its size
or importance. Planning, architecture, and skill or prose rewrites are `max` (Opus): small in
text, but they need the best thinking; reviewing them is `very_high`. Code on a planned card
is `high` or below, lower for full specs, prior art or mechanical work. A code card that seems
to need `max` is under-planned: plan more instead of raising the effort.

## Ordering

The moment you know B needs A first — at creation or later — add
`issue_dependency({id: B, action:'add', kind:'depends_on', target_id: A})`. `phase_children[]`
wires no order, and leaving B in Review is not a hold. A card known to need work is readied
right after filing; Review is triage-only.

## Quality gates

A card carries its board's default gates for its type; `quality_gates` adds more, each with a
`note` saying why. Add later with `issue_quality_gate`. Add when the card…

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
