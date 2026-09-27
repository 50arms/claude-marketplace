---
name: danx-ideate
description: Launch the ideator agent to explore the repo, build knowledge, and generate feature cards.
---

# Danx Ideate

Launch the ideator agent to brainstorm features and generate draft cards. Use `mode: "bypassPermissions"`.

## Scope

Current repo only — `/danx-ideate` takes no arguments.

## /loop and ScheduleWakeup — narrow contract

Ideation is a single-shot dispatch (explore → score → draft → complete) —
you have no legitimate use for `/loop` or `ScheduleWakeup` in this skill. You
run as `claude -p` with stdin ignored, so a scheduled wakeup can never fire;
arming one and ending your turn silently abandons the ideation run.

## Steps

1. Launch the ideator subagent via `Task` with `mode: "bypassPermissions"`.
2. The ideator:
   - Reads `docs/features.md` (its persistent feature notes).
   - Explores the codebase.
   - Updates the Feature Inventory with current status of features.
   - ICE-scores every non-Complete feature.
   - Brainstorms + prioritizes new feature ideas.
   - Checks for duplicates via `issue_list({filter: {type: 'Feature'}})` (search by title / keywords).
   - Generates 3-5 prioritized feature drafts.
   - For each draft, calls `issue_create({type: 'Feature'|'Bug', title: "...", description: "...", ac: [...], triage_enabled: true})` with the draft content.
     - `triage_enabled: true` is explicit and intentional — ideator drafts exist to be evaluated by the automatic triage pipeline; the server default is `false` (see `issue-card-workflow`'s "Auto-Triage Opt-In").
     - Do NOT set `id` (server assigns the next `<PREFIX>-N`).
     - Do NOT set `parent_id`, `children`, `dispatch`, `status`, `triage`, `comments`, `retro` — server sets defaults.
   - Captures the returned `id` from each successful creation.
   - Saves discoveries back to `docs/features.md`.

3. Report what the ideator produced:
   - Features discovered or recategorized.
   - ICE scores and top priorities.
   - Cards created (with titles + assigned `id`s).
   - Knowledge docs updated (if any).

4. **Signal completion (MANDATORY):** `danxbot_complete({status: "complete", summary: "..."})`. Worker finalizes the dispatch row + SIGTERMs the Claude process. Never exit without it.

## Validation

If `issue_create` returns `{ok: false, body: {error}}`, the request failed schema validation. Read `body.error`, fix the draft fields, and retry. Do NOT delete the draft idea — the data structure (not a file) is the durable record until an `id` is assigned.
