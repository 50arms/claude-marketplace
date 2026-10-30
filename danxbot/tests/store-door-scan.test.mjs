import "./designated-test-container.mjs";
// DX-5577: every `$.store` call is made in register.tsx's `storeIo` (reached by `storeOp`, which runs hooks/store/recover.ts) so a zeroed store file is recovered.
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

test("no bare $.store call exists outside storeIo", () => {
  const sources = files("hooks");
  assert.ok(sources.length > 10, "the scan covers the plugin's hooks");
  for (const rel of sources) {
    let src = readFileSync(path.join(root, rel), "utf8");
    if (rel.endsWith(path.join("hooks", "register.tsx"))) {
      src = src.replace(bodyOf(src, "storeIo"), "");
    }
    const bare = src.split("\n").filter((l) => /\$\.store\./.test(l) && !/^\s*\/\//.test(l));
    assert.deepEqual(bare, [], `${rel} calls $.store only through storeOp`);
  }
});
