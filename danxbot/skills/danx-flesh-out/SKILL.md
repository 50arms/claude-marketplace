---
name: danx-flesh-out
description: 'Per-card flesh-out agent: expands half-baked card to full spec, populates ac[], splits into phases when scope warrants. Read-only on repo.'
argument-hint: <PREFIX>-N card id
---

# Danx Flesh-Out

You flesh out **ONE** card: read card → probe repo → rewrite `description` → populate `ac[]` → optional epic split → optional triage stamp → save via MCP → `danxbot_complete({status: "ready"})`.

## Quick Reference

See references/overview.md for the DX-544 sentinel-to-review triage step and the exact comment-shape spec — everything else lives here.

**In-scope cards (per dashboard Create-Card flow):**
- `status_derived: Blocked` AND `blocked.reason` starts `"Awaiting flesh-out"` — flesh-out, parse ` start as <Review|ToDo>` token from sentinel, clear block via `issue_transition` on save.
- `status_derived: Review` AND short/thin `description` AND empty `ac[]` — flesh-out (do NOT stamp triage; existing Review).
- `status_derived: ToDo` AND short/thin `description` AND empty `ac[]` — flesh-out (do NOT stamp triage; ToDo skips triage).

**Refuse paths (defense-in-depth):**
- `status_derived: In Progress / Done / Cancelled` → card already launched, don't re-flesh mid-flight.
- `status_derived: Blocked` AND `blocked.reason` doesn't start `"Awaiting flesh-out"` → non-sentinel self-block, human action required.
- `waiting_on != null` OR `open_problem_count > 0` → parked cards out of scope.
- `children[]` non-empty → epic already split, refuse to orphan phases.

## Workflow

1. **Read** — call `mcp__danx-dashboard__issue_get({id})` to load the card from DB.
2. **Probe** (5–10 min, read-only) — `Read` / `Grep` / `Glob` / git bash only. No executions, no code edits, no MCP write calls.
3. **Rewrite** — `description` per zero-context-test (Goal / Context / Solution / Key Files). Exact file paths, gotchas, verify command.
4. **AC populate** — 3–8 verifiable items (imperative-verb prefix). Forbidden shapes: "Active sessions run /reload-plugins", "operator verifies in their environment", "manual UI smoke", "post-terminal-save auto-flip".
5. **Container split** (optional) — decide by slice count, and NEVER leave a Feature as the dispatchable work unit:
   - **One slice → keep it a Story** (carry size in `effort_level`); no split.
   - **A few slices → create a Feature CONTAINER with child Story cards** — `issue_create({type: 'Feature', ...})` for the container, THEN `issue_create({type: 'Story'|'Bug'|'Chore', parent_id: <feature-id>, ...})` for each dispatchable child slice (`phase_children[]` is Epic-ONLY — the server 400s it on a Feature, so wire Feature children via `parent_id`). Never a Feature that is itself worked. A Feature is a container: it groups child Stories, is never dispatched, status computed from children.
   - **Many slices / spans domains / >500 LOC → Epic** — `issue_create({type: 'Epic', phase_children: [...]})`.
   Then `issue_edit` to wire `parent_id` on any manual children, and set `waiting_on` chains via `issue_dependency`. **Forbidden end-state:** a fleshed-out Feature holding the work in its own body / `ac[]` with no child cards.

**Quality gates + known dependency edges:** for deciding which `required_gates` to flag on the card(s) and recording any already-known `depends_on` / `conflict_on` edges, consult `danxbot:issue-workflow` → `references/card-creation-and-reference.md` (single source of truth) — do NOT review or board-scan; just decide + flag. Every `issue_create` in the split also passes `triage_enabled` EXPLICITLY per card (server default `false` = never auto-triaged) — see its "Triage opt-in".
6. **Save changes** — call `issue_edit({id, description, ac})` to persist the prose changes. If sentinel-blocked, call `issue_transition({id, action: 'unblock'})` to clear the block; if the sentinel target is Review, stamp triage first — see references/overview.md.
7. **Append comment** — call `issue_comment({id, action: 'add', text: "## Flesh-out — <date>\n..."})` — see references/overview.md for the exact field shape.
8. **Complete** — `danxbot_complete({status: "ready"})` (default), or `"review"` for the sentinel-target-Review path.

**FORBIDDEN:** Never call `complete` with `status: "done"` or similar (DX-734 / DX-735 half-baked-done bug). Never `loop` or `ScheduleWakeup`. Never call `issue_edit` with `status` key.

## Boundaries

- One card only (plus phase children if split).
- Read-only probe (no code execution, no MCP reads beyond `issue_get`).
- No backend-tracker calls (the agent path uses `mcp__danx-dashboard__issue_*` only).
- No subagents.
- Do NOT implement the work — flesh-out is spec rewrite, not code change.
- Do NOT alter `parent_id`, `blocked` (except DX-544 clear via `issue_transition`), `waiting_on` (except chains on epic split), open problems (`issue_problem`), `retro`, `dispatch`.

**Verify after MCP calls.** If an MCP tool returns `{ok: false, body: {error}}`, read `body.error` and abort the flesh-out. Surface the error in the final summary.
