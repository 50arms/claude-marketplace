import "./designated-test-container.mjs";
// DX-4233: the words that describe the relay. danxbot:plan-workflow "Live events" keeps the `[danxbot plan event]` tag and names the
// relay's own states; the cross-session inbox note and the `bridge down:` text are gone, and neither CLAUDE.md nor hooks.json names a
// bridge or a watchdog.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

/** The "Live events" section of the plan-workflow skill. */
function liveEvents() {
  const skill = read("../skills/plan-workflow/SKILL.md");
  const start = skill.indexOf("## Live events");
  assert.ok(start > -1, "the section exists");
  const end = skill.indexOf("\n## ", start + 1);
  return flat(skill.slice(start, end === -1 ? undefined : end));
}

test("Live events keeps the [danxbot plan event] tag and the never-poll rule", () => {
  const section = liveEvents();
  assert.match(section, /tagged `\[danxbot plan event\]`/);
  assert.match(section, /never poll, loop or Monitor for them/);
});

test("Live events drops the cross-session inbox note and the `bridge down:` text", () => {
  const section = liveEvents();
  assert.doesNotMatch(section, /cross-session|inbox|permission laundering|another Claude session/i);
  assert.doesNotMatch(section, /bridge/i);
});

test("Live events names what the relay says when it cannot deliver", () => {
  const section = liveEvents();
  assert.match(section, /`events stopped:` → events are NOT reaching this session/);
  assert.match(section, /`events delayed:` → the relay is retrying on its own/);
});

test("the relay's lines are the ones the skill names", () => {
  const text = read("../hooks/relay/text.ts");
  assert.match(text, /events \$\{state\}: events are NOT reaching this session/);
  assert.match(text, /eventsLine\('stopped', /);
  assert.match(text, /eventsLine\('delayed', /);
});

test("CLAUDE.md and hooks.json name no bridge or watchdog", () => {
  for (const rel of ["../../CLAUDE.md", "../hooks/hooks.json"]) {
    assert.doesNotMatch(read(rel), /bridge|watchdog/i, rel);
  }
  assert.match(read("../hooks/hooks.json"), /plan event relay/);
});

// The design gate's events (listen.ts formats them): a chosen design passes the gate; a change request, the last live design
// rejected or "Ask for another design" owes the designer a turn, run again as "Sub-agents" says (DX-4734 AC 50935: one place
// for how the designer is started; since DX-5899 the `gate-designer` profile its brief fetches says what it does);
// a withdrawn choice puts the gate back on the person.
test("Live events tells the session what each design event means and when the designer runs again", () => {
  const section = liveEvents();
  assert.match(section, /A card's design problem \(the one listing its designs to choose from\) is the person's alone/);
  assert.match(section, /`APPROVED revision N of design M` \(then `answered` on the design problem\) → a person chose that design, which passes the card's design gate/);
  assert.match(section, /`requested changes on revision …`, a `REJECTED revision …` that closed the card's last live design, or a comment starting `\*\*Asked for another design:\*\*` → the designer owes a turn/);
  assert.match(section, /→ the designer owes a turn: run the designer again \("Sub-agents"\), unless one you started is still on it\./);
  assert.match(section, /`retracted the answer to` the design problem → the choice was withdrawn and the gate waits on the person again/);
});
