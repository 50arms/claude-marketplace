#!/usr/bin/env node
// UserPromptSubmit hook — danxbot plugin. DX-2860.
//
// The operator often starts a session by pasting a danxbot plan link, e.g.
// `https://danxbot.sageus.ai/plans/2`. Nothing used to recognise that text, so
// the agent had to work out the connect steps itself — and on 2026-09-15 it
// took ~15 tool rounds to even discover that the title has to come from
// `get_session({session_id:"self"})` (see DX-2858's description for the
// incident this Feature exists to fix).
//
// This hook does exactly one thing: scan the operator's raw prompt TEXT for a
// danxbot plan URL and, if found, inject one short directive telling the
// agent to connect that plan under its own real session title and read
// whatever orientation the connect call hands back. It never calls the
// dashboard itself, never mints or handles any token/credential, and is
// completely silent when no plan URL is present — the connect work and every
// dashboard call still belongs to the agent (via danxbot:plan-workflow), not
// to this hook.
//
// Per CLAUDE.md "Hook scripts must never depend on `jq`": UserPromptSubmit's
// plain stdout is added to the model's context on exit 0 — no JSON envelope
// needed (unlike PostToolUse, see plan-note-reminder.mjs). This hook is a
// plain Node script (not embedded in a .sh wrapper) so its URL-matching logic
// is directly unit-testable, matching plan-note-reminder.mjs's convention.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Matches a danxbot plan URL anywhere in the prompt: a `http(s)://` link whose
// path contains `/plans/<digits>`. Requires the scheme so a coincidental path
// fragment (e.g. a local file path or a sentence like "see my plans/notes")
// is never mistaken for a pasted link. The id is captured; anything after it
// (`/`, `?`, `#`, more path segments) is ignored.
const PLAN_URL_PATTERN = /https?:\/\/\S*?\/plans\/(\d+)(?=[\s/?#]|$)/i;

/** The plan id from the first danxbot plan URL in `prompt`, or null if none is present. */
export function extractPlanId(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  const m = PLAN_URL_PATTERN.exec(prompt);
  return m ? m[1] : null;
}

/** The directive text injected when a plan URL is found. Exported so the test can assert its shape without re-deriving it. */
export function buildDirective(planId) {
  return (
    `Pasted danxbot plan link detected (plan id ${planId}). Connect this session now, per ` +
    `danxbot:plan-workflow: call get_session({session_id:"self"}) for this session's own title, ` +
    `then plan_connect({plan_id: ${planId}, title: <that title>}) — never the repo folder name. ` +
    `Read whatever the reply gives you to orient on the plan (a compact briefing when the dashboard ` +
    `returns one; otherwise plan_get({fields: {records: true, architecture_sections: true, cards: true}}) for the same ` +
    `information), and check the reply's event-listener/bridge health — if it reports anything other ` +
    `than healthy and attached, follow the fix it names; never poll for this or set up your own ` +
    `manual watch loop instead. This hook only detected the link; it made no dashboard call and ` +
    `holds no token.`
  );
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const planId = extractPlanId(input?.prompt);
  if (!planId) return;
  process.stdout.write(buildDirective(planId) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
