---
name: debugging
description: 'Investigation + bug-fix discipline: hypothesis → evidence → findings, read-only by default until an explicit instruction to fix (a dispatched card counts as that instruction). Read-only mode reports and stops; fix mode continues through TDD to a verified fix, with the Phase-12 bug-report format for user-facing bugs. Load before investigating a bug or asserting how something behaves.'
---

# Debugging Skill

Bugs = skipped steps. The checklist IS the work. **No minimum size** — a typo causing a 500 gets the same checklist as a stack trace with no repro.

**Triggers:** test fails, command errors, unexpected value, user reports broken, stack trace, timing/latency claim, causality claim ("failed because Y"), any factual claim about runtime behavior without direct evidence, hedging in a draft ("probably," "typically," "should be").

**Direct-quote exemption:** "What params does func X take?" = file read + quote. Any claim beyond direct quotation needs this skill.

## Mode switch — read-only by default

**Default mode is READ-ONLY.** Before investigating, say so plainly: state that you will change nothing and only report — no `Edit`, `Write`, `git checkout`, kill, restart, deploy, or MCP write tool during this pass.

**Switch to fix mode only on an explicit instruction to fix.** The user says "fix it" or names an action verb, or — for a dispatched worker with no operator to ask — the dispatched card itself IS that instruction: being handed the card to work counts as authorization to fix. Forbidden: treating a bare question, an observation, or "yes that's a bug" as fix authorization in an operator session.

Once in fix mode, the same evidence discipline continues straight through implementation — you do not stop and re-report before fixing.

## Mandatory setup — create the todo list first

Before reading code, running commands, or proposing anything, call `TodoWrite` with one todo per phase below. Mark `in_progress` when started, `completed` only when its acceptance criterion is met. A phase that doesn't apply is `completed` with a one-line reason ("N/A — no stored data involved") — never skipped silently.

## Phases 1–5 — Reproduce → Prove (both modes)

1. **State the question / reproduce.** One sentence, specific scope, not "investigate the worker." User-reported → ask for URL/request-id/steps, don't guess. STOP if you can't reproduce.
2. **Hypothesis, before tools.** "I expect X because Y; right → evidence Z; wrong → evidence W."
3. **List evidence sources**, cheapest/most-direct first: file paths, process state, logs, DB rows, HTTP probes, config, `git log`/`blame`. No fanout before the cheapest source.
   - **Definition-before-history gate.** "What does X do now" → read its CURRENT definition first; only then `git log`/`blame` for "how did it change." Already have a verdict and reaching for history to confirm it → STOP, re-read the current definition.
4. **Gather evidence.** Capture verbatim: file contents (line numbers), command output (exit code per `base:shell-discipline`), HTTP/DB shape. Read-only pass = zero edits, only read tools/read-only Bash/WebFetch — no authorization needed even against prod (`ps`, `curl`, `docker logs`, `psql SELECT`); only a WRITE against prod crosses the line.
5. **Verify against hypothesis.** Confirms → continue. Contradicts → revise and say so. Ambiguous → name the disambiguating evidence and get it. Never silently retcon a wrong guess.
   - **Identify the producer:** what wrote the bad value — (1) currently buggy, (2) was buggy now fixed, (3) expectation wrong, (4) external source. Answer all four before editing.
   - **Source-of-truth gate.** Confirm your evidence comes from the EXACT field the consuming code reads, not a sibling surface that merely looks authoritative — a `status='running'` row ≠ a live process, check the pid.
   - **Green-parts, broken-whole.** A green adjacent probe is evidence about a component, not the failing path — reproduce the symptom end-to-end and observe the exact artifact the consumer sees, not a chain of green neighbors.

## Read-only mode ends here — report and STOP

Report per `base:convey`, ≤20 lines, zero codebase context assumed: (1) headline ≤12 words; (2) problem, 1-2 sentences, user-visible terms; (3) steps to reproduce, numbered, observable from outside the code; (4) expected / (5) actual, one sentence each, never combined ("X failed because Y"); (6) root cause, plain English first, symbols only in parens; (7) evidence — `file:line`/command/row refs; (8) hypothesis delta, only if the guess changed; (9) fix options, plain English, numbered, no code/diffs/paths in the option text.

Forbidden: hedging, a unilateral fix as the first option, "do nothing," "investigate further" as filler, unverified suspect lists.

**Then stop.** No "while we're here." Wait for the user to pick — or, for a dispatched worker, proceed straight into fix mode, since the dispatch already is the fix instruction.

## Fix mode — Phases 6–11

**6. Solution quality**, decided before writing code: (1) mechanism not symptom, (2) textbook for the platform, (3) fixes the class not the instance. Tier 1 (mechanism/textbook) > Tier 2 (architectural) > Tier 3 (observability, co-ships with T1) > Tier 4 (defense, under T1 only). Forbidden: symptom-only patch, retry as the primary fix, a local patch without naming other call sites, "later" with no artifact.

**7. Write the failing test** — TDD non-negotiable; it describes the bug, not the fix.

**8. Implement.** Fix the producer (case 1/4), plan a data fix (case 2), fix the expectation (case 3). Minimal — no fallback/consumer-tolerant patch (`??`, `try/catch`) papering over the bug (`dev:ideal-solution-mindset` #2/#2c).

**Mechanism-read gate (mandatory before the first edit/commit).** Quote, from the source that ENFORCES the behavior (`file:line`) — never an error string or "the other case does X" — the rule the fix must satisfy. Can't cite it → you don't understand the fix yet, keep reading. Doubly mandatory when validation is expensive (a multi-minute run, an LLM pipeline, a deploy) — one shot, so certainty comes from the contract, never "commit a guess and see."

**9. Verify.** Failing test passes, related tests pass, original trigger gone, evidence captured.

**10. Backfill / migrate** stored-data errors: idempotent + incremental (delta + high-water mark, never truncate-reload) — cost identical on the 10th run.

**11. Close the loop.** Update the card/notes; file an Action Item if a rule/doc gap enabled the bug; propose a rule update if the class repeats.

## Phase 12 — Bug explanation format (mandatory for every user-facing bug report)

Trigger: the response tells the user about one or more bugs/failures/regressions — just diagnosed, "explain X," a test-run summary, or a list of what's broken. Every distinct bug gets its own block, no narrative substitution:

```
## #N — <one-line bug name>
- **Affects:** who/what is impacted (component, command, code path, user role)
- **Env:** environment/runtime/config/state required to hit it (host vs docker, flags, version, prerequisite data)
- **Scenario:** the exact step sequence that triggers it — concrete, not abstract
- **Expected:** what the system was designed/documented to do at that step
- **Actual:** what it actually does, including the specific symptom (error message, exit code, wrong value, missing record)
```

A side effect uses the same shape under `Side-effect — <name>`. A summary table may serve as a TOC at the top but never replaces the per-bug blocks. Forbidden: narrative bug reports, mixing Expected/Actual in one sentence, skipping Env as "obvious," combining N bugs into one block.

## Anti-patterns

| Anti-pattern | Why it fails |
|---|---|
| Detective-carpenter (bump the timeout, never learn what it masked) | Symptom patch hides the real defect |
| Hedging (zero numbers) | Not falsifiable |
| Scope drift ("why did one dispatch fail" → audit the whole week) | Answer the original question, then stop |
| Suspect lists on vibes | One verified candidate, or name the next probe |
| One-to-all extrapolation (1 instance → "all N are X") | A claim quantified over N items requires N items read |
| Symptom-suppressing accessor (`?? []`, `try/catch`, return null) | Hides the bug from every other reader (`dev:ideal-solution-mindset` #2c) |
| "Obvious" one-line fix, no reproduction | A small guess is still a guess |
| Read-code-then-conclude, nothing run | Code says what could happen; only runtime says what did |
| Adjacent-artifact substitution (verify A, assert unrelated B) | The key is not the value |
| Stop at first grep hit, no producer trace | Multiple producers may exist |
| Restart-to-fix without reading the error | Restarts hide the error the log already had |
| "Pre-existing, not mine" | You own the entire codebase, always |
