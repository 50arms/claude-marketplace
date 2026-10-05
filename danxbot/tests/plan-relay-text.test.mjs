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
  assert.match(text, /events stopped: /);
  assert.match(text, /events delayed: /);
});

test("CLAUDE.md and hooks.json name no bridge or watchdog", () => {
  for (const rel of ["../../CLAUDE.md", "../hooks/hooks.json"]) {
    assert.doesNotMatch(read(rel), /bridge|watchdog/i, rel);
  }
  assert.match(read("../hooks/hooks.json"), /plan event relay/);
});
