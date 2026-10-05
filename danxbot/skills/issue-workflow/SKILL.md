---
name: issue-workflow
description: 'The one workflow for working a card, and every dev rule that applies while doing it: claim, context, the ideal build (TDD, no legacy, fail loud, reuse), debugging, git and shell hygiene, gates, complete. Load before working a card, and before choosing a card type or slicing work (then also references/card-creation-and-reference.md).'
---

# Issue Workflow

Dashboard Postgres is the only source of card truth; `danxbot_api` is the whole surface
(routes: `danxbot_api_list`; contracts: `danxbot_api_spec`) — never file operations.
Creating or slicing a card: load `references/card-creation-and-reference.md` first.

## Two callers

| | Dispatched worker | Operator-session sub-agent |
|---|---|---|
| Worktree | prepared by danxbot | its own isolated worktree (Agent `isolation: "worktree"` or the repo's worktree command), never the shared checkout |
| Claim | already claimed before you start — never send `pickup` | `pickup` with `manual:true` (below) |
| Gates | the profile instruction carries them | PRE gates: in your own context; POST gates: run by the operator session ("Gates" below) |
| Merge + end | the `work` profile instruction | push the card branch, report its tip SHA, stop; when told to land: push to main, `complete` + retro, report |

Dispatched-only mechanics (`danxbot_complete`, halt, `agent-finalize.sh`, the pre-synced
worktree, DB resets) live only in danxbot's `work` profile.

## Flow

1. Read the card with its description, AC, comments and dependencies; read the parent if
   set; on a plan, read its architecture and note overlapping siblings.
   Any investigation that takes more than a few commands (understanding unread code,
   reproducing a bug, debugging a failing test, proving an idea works) goes to a foreground
   sub-agent (`Explore` to read, a worker tier to run things) that returns only the
   conclusion with file:line evidence; keep a single lookup inline and read directly only
   the lines you are about to edit. Everything you read stays in your context and is paid
   again on every later turn, so the larger your context and the more turns remain, the
   sooner delegating is cheaper than its ~60k-token start.
2. Operator-session sub-agent: claim it before any work (below). Dispatched worker: skip
   this step, the card is already yours.
3. Pass its PRE gates ("Gates" below), then build test-first, to the rules under
   "Building" below.
4. Tick every AC/checklist item, pass every test, browser-test user-facing changes.
5. Pass its POST gates ("Gates" below).
6. Merge first: a dispatched worker runs its profile's end order, `agent-finalize.sh`
   first; an operator-session sub-agent, once told to land, commits and pushes to main.
   Only then transition `complete` with a summary and write the retro (last — it 409s
   until terminal), citing the sha now on `origin/main`. A phase card leaves `Notes from
   Phase N` on the next phase card.

## Gates

A quality gate is a step a card must pass: PRE gates (`plan-*`) run before the build, POST
gates (`code-*`) on the finished diff. The card's `quality_gates` lists the ones it
carries, and each board keeps its own text for what a gate does.

An operator-session sub-agent runs its PRE gates itself, in its own context, then builds,
pushes its card branch, reports the tip SHA and stops. It never spawns gate agents: a
background agent's notice reaches only the top-level session. The operator session runs
each POST gate not yet `pass` through one gate worker per gate (`danxbot:worker-opus-high`
for an architecture gate, `danxbot:worker-sonnet-high` for the rest), relays the findings
and says when to land. Whoever runs a gate:

1. Fetch the board's gate text through `danxbot_api`:
   `GET /api/quality-gates/<gate>/instruction?board=<the board the card lives on, as repo:slug>`.
2. Do what that text says for the card, including any card writes it asks for (checklists,
   dependency edges), and nothing else.
3. Record the verdict through `danxbot_api`: `PATCH /api/issues/<id>/quality-gates/<gate>`
   with `{status: "pass"|"fail", message: "<the real finding>"}`.

Fix a `fail`, then run the gate again (the operator session re-runs a POST gate). A gate
that doesn't apply to the card is removed (`POST` the same card route with
`{action: "remove"}`) with a card comment saying why —
never passed to get it out of the way.

## Needing a human

Genuinely need a human → open a problem on the card: an `action` when only a person can do
it (access, credentials, hardware, authority), else a `question`. Never `AskUserQuestion` or
a plan-mode pause. A card needs a human exactly while it has an open problem; removing its
last open problem closes that need.

A call refused 403 for a missing permission → `request_permission` with a reason (show the person its code) and keep working; blocked without it, open an action problem.

## Claiming (operator-session sub-agents only)

A dispatched worker never claims: danxbot picked the card up before spawning it
(`In Progress`, `dispatch_id` set), so a `pickup` from it is refused 409
`dispatch_id (already dispatched)`.

A `ToDo` card is an open dispatch request — working it unclaimed races a worker onto it.
Transition `pickup` with `manual:true`, which stops anything auto-transitioning it. The
server stamps your session id (`$CLAUDE_CODE_SESSION_ID`) as `assigned_agent` and ignores
any name you send. Read `assigned_agent` back — anything but your session id (incl.
`null`) is a failed claim: retry once, then stop. The hold clears only by an
explicit transition from your session (`complete`/`cancel`/`block`/`rollback_pickup`). A
sub-agent you run is still your card: pickup first, drive the terminal transition yourself.

## When to block

Block only when truly stuck on something specific to THIS card — you've read the code,
tried the obvious fix, and genuinely cannot proceed. Not just uncertain. `blocked` is a
dispatch HOLD, not a status: a card in any status can be blocked, it never moves where the
card sits, and automation may unblock it without a human. Ending a dispatch `failed` does
not block — if the cause is card-specific (e.g. a branch that can't be reconciled), block
first, then end `failed`.

- Waiting on another card to finish first → a `depends_on` dependency, not `block`.
- Two cards that can't run together → a `conflict_on` dependency.
- A human is 100% required (a decision, or an action only a person can take) → open a
  problem with solutions — that holds the card for human review before it can be
  dispatched or completed. `block` alone does not.
- Otherwise, transition `block` with a reason.

## Mechanics

- **AC/checklists** — each item's id is under the card's `checklists[].items[]`; set it
  `passing` on its checklist item.
- **Comments** — narrative only; a durable decision goes on a card, never a comment alone.
- **Dependencies** — only for a card already known, never a discovery scan.
- Never write a `status:` literal; transitions derive it.
- **MCP down** → curl the same route with the credential the dashboard MCP's config names,
  plus `x-danx-session-id`.
- **Issue-ref comments** — `// CARD-ID: <reason>` on any non-obvious decision a card forced.
  Before editing a file, grep its anchored refs
  (`grep -rnE '(//|#|--|<!--|/\*|\*)[[:space:]]*[A-Z]+-[0-9]+' <files>`) and load each card.
- AC lives in `ac[]`; sub-cards are their own cards via `parent_id`; never hand-append
  `## Retro`; never escape markdown.

## Building

**Ideal correct solution.** The architecturally correct, runtime-best answer is the only
answer. Preferring A only because it is faster to write → choose B. Real trade-offs are only
ones the running system feels (latency, memory, freshness, determinism, security, a
capability gap); dev effort, another module or repo, new tests are just the cost. Pay it.

**No legacy, no fallbacks, no dead code.** One correct way per concept. Touch an area →
bring it to the new shape in the same change; out-of-scope callers fail loudly. Forbidden:
old+new format handling, `if (legacyShape)` branches, a new required field made optional
with a default (backfill instead), shims, deprecated re-exports, commented-out code,
`TODO: remove`. Deleting a feature erases every trace — a comment or test recording its
absence is dead weight too (a standing rule against a generic anti-pattern is not). Before
saving: anything my change made obsolete still here? Delete it and update every caller.
A module losing a symbol usually needs migrating, not deleting — delete only when the
capability itself is obsolete.

**Fix forward.** Something you built doesn't work perfectly → fix it, never withdraw it.
Removal is on the table only when it can harm a person or destroy data today in something
shipped and depended on — or when told to revert, it is wrong and unwanted, starting over
is genuinely faster, or it should be forgotten. Unfinished, partly working, cause not yet
understood, or a coming handoff are none of these.

**Fail loudly.** A critical failure aborts at the point of failure. Forbidden: try-A-then-B
chains, a default returned on error, `x ?? "unknown"` on a required discriminator,
swallow-and-log, `bestEffort`/`safe` wrappers on a critical path. Not fallbacks: input
validation, optional-arg defaults, a bounded timeout, a bounded retry as insurance.

**Reduce complexity.** Simplest shape that is still correct. No layer "in case", no knob
with one correct value, no helper without a caller, no delegate-only wrapper. A new layer
must name the invariant it enforces.

**Reuse before you build.** Search for the capability under other names, partial coverage
(extend it) and the wrong location (move it) before writing anything new; name what you
searched. "Can't reuse it because <constraint>" is a guess until you cite the `file:line`
that enforces it.

**Existing code.** Comments are authoritative on WHY but were true only when written: confirm
the producer or mechanism they name still exists, follow a cited docblock to code. A comment
or rule you find false is corrected in the same change. Before choosing where state lives (DB
row, file, env), trace the seed and load path to what is authoritative at runtime. Recurring
jobs are incremental (delta + high-water mark): the 10th run costs what the 1st does. All
code is your code — never "pre-existing, not mine".

**Show the work.** Browser-visible work: attach a screenshot with `attach_file` and `primary: true`
at the first working state, then `replaces: <attachment_id from that reply>` at each milestone and
at completion, never a growing list. Frame the component you are working on with enough around
it to place it (scroll it into view, size the viewport to it), not the whole app. A browser-pane
capture is for your own viewing (an 800px-wide JPEG); attach a full-resolution PNG instead,
made by the plugin's own tool from any repo (it drives the machine's Chrome or Edge, so a
containerised dispatch with no browser cannot run it):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/capture-screenshot.mjs" <url> <out.png> [--login <dev-login-url>]
[--wait-for <selector>]` (defaults `--width 1440 --height 900 --dpr 2`; phone `--width 390 --height 844
--dpr 3`). Pass `--wait-for` whenever the app has a readiness signal; it exits non-zero on a bad
response, a sign-in form, or a page that never becomes ready.

## Debugging

1. State the question in one sentence and reproduce it; can't reproduce → stop.
2. Hypothesis before tools: "I expect X because Y; wrong → evidence W."
3. "What does X do now" → read its current definition before `git log`/`blame`.
4. Capture evidence verbatim (file:line, exit codes, rows). Read-only probes need no
   authorization, even against production; only a write crosses the line.
5. Name the producer of the bad value: currently buggy, was buggy, wrong expectation, or
   external. A green neighbour is not the failing path — observe the exact artifact the
   consumer sees. Two plausible producers → back each fix out alone and re-run; green after
   fixing one proves nothing about the other.
6. Fix the mechanism, not the symptom (mechanism > architectural > observability co-shipped
   > defense). Retry as the primary fix is forbidden.
7. Before the first edit, quote the `file:line` that enforces the rule your fix must satisfy.
   Can't cite it → keep reading; doubly so when validation is expensive.

A claim over N items needs N items read. Answer the question asked, then stop.

Every user-facing bug report, one block per bug:
`## #N — <name>` then **Affects**, **Env**, **Scenario** (exact steps), **Expected**,
**Actual** (exact symptom) — never Expected and Actual in one sentence.

## Git

- Commit each verified, coherent unit without asking, then push. Diverged → `git pull
  --rebase`; resolve conflicts by reading both sides and keeping both intents
  (`-Xours`/`-Xtheirs` and whole-file overwrites are forbidden); re-run tests. Push fails
  (auth, headless credential prompt, no upstream) → report and stop. Never force-push without
  explicit authorization.
- Never discard uncommitted work you didn't write — no `reset --hard`, `checkout`/`restore`
  of a path, `stash`, `clean -f`, or overwriting a file from HEAD or a copy. Work that must
  go is committed as-is first, then removed in a second commit citing the first. A
  "modified by user or linter" notice is someone's live work — remove only your own hunks.
  Deleted a file and need it back → stop and ask.
- Shared index: commit straight from the tree, `git commit -m "<msg>" -- <paths>`, so
  nobody's staged work lands in your commit or yours in theirs. Commit your own work
  without asking; ask only about foreign changes you can't separate from yours by path.
- Before cherry-pick/apply/rebase/merge: `git log --oneline <source>..HEAD`. A stale source
  that then changes files → diff each against HEAD and ask; never "fix" by reverting. A
  sub-agent worktree forks at its start — rebase it before integrating.
- `git fetch` before asserting anything about a remote branch.

## Shell

- After a long command the next step is `RC=$?` or `&&`/`||` — a trailing
  `tail`/`grep`/`echo` hides the real exit code.
- Never leave stdin open for a prompt (`ssh`, `psql`, `sudo`, `npm login`, `-i`): close it
  (`< /dev/null`) or use the non-interactive form (`sudo -n`, `ssh -o BatchMode=yes`). No
  output for ~2 minutes in the background means hung.
- Poll an LLM, dispatch or orchestrator no faster than every 60–120s.
- A literal `\n` in an MCP string is two characters — use a real line break.
- Never read or edit `dist/`/build output; `node_modules/` is read-only.
- Browser checks: the in-app browser tool only, never a headed browser on the desktop. Open
  your own tab and pass its `tabId` on every call (none acts on the tab the user has
  fronted); close the tabs you opened.
- Signal only a PID you spawned and captured at spawn — never `pkill -f`, `killall` or a
  pattern lookup. A dev server someone may be using is not yours to restart without asking.
