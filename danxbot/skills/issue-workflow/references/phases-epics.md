# Phases vs Epics

**One concept: `children[]`** (ISS-81). On `type: Epic` cards, `children[]` is ordered list of phase cards (UI label "Phases"). On non-epic, `children[]` is sub-cards (UI label "Children"). **Phases MUST be cards** — no in-card phase checklist.

Slice-counting, the combine-vs-split gates, and the childless-container ban all live in SKILL.md's Card Taxonomy section (canonical) — this file does not restate them.

## Container Mechanics (Epic OR Feature) — sequential-phase `waiting_on` chains

Identical for both container types. Beyond the ordinary `issue_create`/`phase_children[]` mechanics (SKILL.md's MCP Tools Reference + DEPENDENCY-WIRING gate): a sequential-phase `waiting_on` chain may land AT creation — `waiting_on` is status-independent, so a phase can carry derived `Review` + `waiting_on: {by: [<prior-phase>]}` together. The creating agent stamps the `by[]` chain in the same pass it creates the phase cards; no second-pass edit. The picker holds each phase off dispatch until BOTH triage approves (stamps `ready_at` → `ToDo`) AND every `by[]` blocker is terminal. Capture this NOW, while the planning agent has full context — not later.

## Where Phase Cards Go

Same derived status as parent epic at creation. Epic derives Review → phase cards derive Review. Epic derives In Progress → phase cards inherit via own triggers. Phase cards move with epic through lifecycle.

## After Completing Each Phase Card

Same two-step termination sequence as any other card (per your profile instruction for a dispatched worker), then `issue_retro` — `issue_retro` REFUSES 409 until the card is terminal, so it comes after the transition, never before. Do NOT edit the epic — the poller propagates the parent's triggers from children's derived statuses automatically. Next phase card's notes go in `comments[]` per the rule below; once all phases derive Done, the server stamps the epic's `completed_at` automatically.

## CRITICAL: Update Next Phase Card Before Ending Session

Append "Notes from Phase N" entry to next phase card's `comments[]` + save. Capture: discovered constraints, timing gotchas, reusable helpers + paths, cost/budget observations, dependencies between phases, corrections to description. Assume next agent reads ONLY `description` + `comments[]` — not epic handoff, not conversation history, not git log.

## Completion contract — `completed` means EVERYTHING on the card is done

Two hard preconditions, both required, before `issue_transition({action:'complete'})`:

1. **Every `ac[i].checked` is `true`** with direct evidence. Unchecked AC = unfinished work; no "rest minor" or "remainder lands in follow-up".
2. **Every child in `children[]`** (when non-empty) is terminal (`Done` / `Cancelled`). A phase parent whose children are still ToDo/In Progress/Blocked/Waiting On is NOT complete — rollup via `deriveStatus`, never a direct write.

**Completing a container (`type: Epic` OR `type: Feature`) directly is FORBIDDEN.** A container's terminal state derives from child rollup only, never a direct write — neither type is ever dispatched or completed directly (CLAUDE.md Core Principle 2). The write-side guard refuses the `completed_at`/`cancelled_at` stamp on a container card; the dispatch row finalizes but the card stamp is suppressed. Defense-in-depth for the rule above, not a substitute for it.
