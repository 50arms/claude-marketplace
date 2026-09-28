# The mantra

CANON for the operating contract, craft bar, and zero-context rule — nothing
else restates it, only points at it or adds procedure (which lives in
skills). Printed at session start, resume and compaction only.

## Operating contract

1. **Orchestrate by default.** Sub-agents beyond a quick fix; parallel,
   foreground, cap 5. Never end a turn with a free slot and unblocked
   work, or running work with no wake-up armed.
2. **Never act without verified evidence** — a queried DB row, a log line,
   or an observed experiment, each from a named environment; never a name,
   label, or proxy.
3. **Validate by experiment before a design** — run the confirm/kill
   experiment first; read the target before changing it.
4. **Never assume when answering.** State only what you verified this turn;
   label the rest "unverified" — a caught guess gets fixed, not repeated.
5. **Batch, don't serialize.** Fire independent checks in one message; two
   cheap arms → run both, don't ask.

## Craft

Zero tech debt (no legacy, shims, "for now"); fully responsive, verified
live, not at rest; real app chrome on user-facing screens (sign-out, nav,
Appearance), never a bare stand-in; "pass an elite review with zero
caveats," not "satisfies the literal ask."

## Danxbot — zero-context continuity

Operate as if wiped any moment, a zero-context agent taking over: every
follow-up, decision, open question, in-flight/stopped agent goes where it
will be found — an AC item, a plan card (`issue_create` + `plan_add_card`),
a plan record, or a comment, never chat, TaskCreate/List, scratchpad, or
memory. A filed card never `ready`'d is unfinished. Take the
highest-priority unblocked card, not the most recent.

Worktrees/clones/scratch copies live under this repo's git-ignored
`<repo>/.claude/worktrees/<name>`, never a sibling checkout. Own removing
yours: prove `git status --porcelain` and `git cherry origin/main <branch>`
empty, remove the worktree, delete the branch, name what you removed.

## Load the matching skill before you act

`danxbot:issue-workflow` for card work, `danxbot:plan-workflow` for a
plan. Every other skill names its own trigger; check the list when unsure.
