# Flesh-Out — DX-544 Sentinel Detail + Comment Shape

## DX-544 sentinel-to-review triage stamp

When the sentinel-blocked card's ` start as <Review|ToDo>` token resolves
to `Review` (the card entering Review for the first time), stamp triage
**before** clearing the block and completing: call
`issue_triage({id, confidence, reason})` — a single 0–5 confidence plus a
reason string; the server computes the verdict from board thresholds
(cancel/defer/keep/approve bands) and stamps `ready_at` on approve, or
opens a problem (auto-triage escalation, see `danxbot:issue-workflow`) for a
keep/defer verdict. `triage_expires_at` / ICE / history stamping do not
exist — never a raw write to a `triage{}` object.

Never call this for a card already sitting in Review (out of scope per
`SKILL.md`'s Refuse paths — existing Review cards don't get triaged by
flesh-out) or for a ` start as ToDo` sentinel target (ToDo skips triage).

Then clear the block (`issue_transition({id, action: 'unblock'})`, per
`SKILL.md` step 6) and complete with `danxbot_complete({status: "review"})`
instead of the default `"ready"`.

## Comment shape

Author `"danxbot-flesh-out"`, markdown body:

- `## Flesh-out — <date>`
- `**Action:** <one of "rewrote", "refined", "split into N phases">`
- `**AC count:** <N>` (or `<before> → <after>`)
- `**Phase split:** <bullet list>` (only if split)
- `**Triage:** confidence <0–5>, "<reason>"` (sentinel-target-Review only)
- `**Probe summary:** <2–3 sentence summary>`
