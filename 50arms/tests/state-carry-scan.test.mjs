import "./designated-test-container.mjs";
// claude.exe 2.1.317 empties a plugin's whole $.state when a /clear opens the next conversation, so register.tsx carries every value across it in one step: `carryAcrossConversation`
// reads each atom and `restoreCarried` writes each one back. The engine's scan only lists a module's values from literal calls, so both name every atom one by one; this scan holds the two
// lists to the atoms the hooks declare, so an atom added later is carried too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(dir) {
  const out = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...files(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

/** The text of `function <name>` up to the next top-level `}` line. */
function bodyOf(src, name) {
  const from = src.indexOf(`function ${name}(`);
  assert.ok(from > -1, `${name} is found`);
  const to = src.indexOf("\n}\n", from);
  return src.slice(from, to);
}

const sorted = (list) => [...list].sort();

test("every atom the hooks declare is read by carryAcrossConversation and written back by restoreCarried, and nothing else is", () => {
  const sources = files("hooks");
  assert.ok(sources.length > 10, "the scan covers the plugin's hooks");
  const declared = [];
  for (const rel of sources) {
    const src = readFileSync(path.join(root, rel), "utf8");
    const names = [...src.matchAll(/^const (\w+) = atom\(/gm)].map((m) => m[1]);
    if (!rel.endsWith(path.join("hooks", "register.tsx"))) assert.deepEqual(names, [], `${rel} declares no atom: every one is in register.tsx, beside the carry`);
    declared.push(...names);
  }
  assert.ok(declared.length > 30, "the scan finds register.tsx's atoms");
  const src = readFileSync(path.join(root, "hooks", "register.tsx"), "utf8");
  const read = [...bodyOf(src, "carryAcrossConversation").matchAll(/^\s+(\w+): read\(\$, (\w+)\),$/gm)];
  for (const [, key, atom] of read) assert.equal(key, atom, `the carried value of ${atom} is kept under its own name`);
  const written = [...bodyOf(src, "restoreCarried").matchAll(/^\s+update\(\$, (\w+), \(\) => carried\.(\w+)\),$/gm)];
  for (const [, atom, key] of written) assert.equal(key, atom, `${atom} is written back from its own carried value`);
  assert.deepEqual(sorted(read.map((m) => m[2])), sorted(declared), "carryAcrossConversation reads every atom once");
  assert.deepEqual(sorted(written.map((m) => m[1])), sorted(declared), "restoreCarried writes every atom back once");
});
