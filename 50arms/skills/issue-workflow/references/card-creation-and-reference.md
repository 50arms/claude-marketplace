# Creating and sizing a card

Load before creating a card, or before choosing a card's type or build grade.

## Type rules

Before creating a card, read its type's rules from `50arms_api` `GET /api/card-types`: each type's
`when_to_use` says when to create a card of that type and when to create none, and its `facts` say
what it may hold. Quote the part of those rules you rely on as the create's `justification`
(`quote`, `reasoning`), with your reasoning, on the card and on every `phase_children[]` item.

**What goes where.** A card's description is the background of the ask; what it must do goes in its
AC and decision records, which the card page lists under the description (the skill's "Mechanics",
Decisions).

A docs change is made by the agent itself, never recorded as a proposal. Edit the docs pages on your own `docs-change/<name>` branch, cut from the target branch (never from the card branch) and holding only docs pages, then submit it through `50arms_api` `POST /api/issues/<card id>/docs-submissions` `{repo, branch, summary}`. The card gets a docs-review problem that a person approves.

## Build grade

A card's build grade (its `effort_level` field) is the agent grade that implements the card. A grade is
only a name: which model and effort it means is what the board's agent grades in the dashboard say when you
read them, and no text fixes it. Set it by how complex the hardest SINGLE step is once the card's plan is written, never by
file count, breadth, size or importance: a step the plan spells out is mechanical however often it repeats, and
breadth multiplies the cost of a bigger model, so a wide mechanical change goes LOWER, not higher.

- `max`: the work IS thinking: planning, architecture, skill or prose rewrites.
  Reviewing them is `very_high`.
- `high`: one step needs judgment the plan could not settle (an algorithm, a concurrency or
  state invariant, debugging an unknown cause).
- `medium`: routine code with clear AC and prior art to copy.
- `low` and below: every step is spelled out (rename, swap a call, copy a pattern), even
  across thousands of files.

Example: swapping a formatter call for a new component at 40 call sites in 25 files, where
the component's behaviour is specified, is `medium`: only the component needs thought. A code
card that seems to need `max` is under-planned. Broad work gets its own planning step first: a `max` card writes
the plan onto the build cards (the pieces, and for each its files, edits and signatures). Each build card's build
grade is then set by how complex its hardest step is, never by how much work it is: a clearly defined edit is
`min` to `low` however many files it touches; a step that still needs analysis and judgment while the
work is done is `medium` and up. A build card that still looks complex means the plan has not broken
the problem into the right pieces: plan more.

## Ordering

The moment you know B needs A first — at creation or later — add a `depends_on`
dependency from B to A. `phase_children[]`
wires no order, and leaving B in Review is not a hold. Every card you file is readied right
after filing, including a card for an idea a person only floated ("we may consider X"): its
order comes from `depends_on`, never from Review, and whether to build it is never a question.
Review is triage-only.

## Quality gates

A card carries its board's default gates for its type; `quality_gates` adds more, each with a
`note` saying why, at creation or later. Each gate's own guidance
(`quality_gate.<gate>.when_to_add`, listed in the reply to a card create) says when to add it;
add only what the card's risk needs. `plan-design` builds the card's designs with the repo's own
mini app, and only a person choosing one passes it. A repo whose designs are off refuses the
gate: raise that as an `action` problem for a person to turn designs on, never drop the UI work.

## Triage opt-in

Pass `triage_enabled` on every card and every phase child. `true` only when it is fine for
50 Arms to ready and build this card with no further involvement from you: an approve verdict
is silent, while keep or defer reaches the session as a problem event.
