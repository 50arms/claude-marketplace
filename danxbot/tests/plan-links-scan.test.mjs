// DX-4630: the plugin opens no page itself and draws no `Link` element. A `Link` opens the external browser, a Markdown link the app's
// in-app browser (proven live), and the `Claude_Browser` tool flow it replaced cost 6.3 s a press. The source holds neither.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hooks = path.join(path.dirname(fileURLToPath(import.meta.url)), "../hooks");
const sources = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|mjs)$/.test(n) ? [p] : [];
  });

test("no hooks source calls the Claude_Browser tools", () => {
  const found = sources(hooks).filter((p) => /Claude_Browser/.test(readFileSync(p, "utf8")));
  assert.deepEqual(found, []);
});

test("no hooks source draws a Link element or reads one from the element table", () => {
  const found = sources(hooks).filter((p) => /<Link\b|\bLink\s*[,}]|type:\s*['"]Link['"]/.test(readFileSync(p, "utf8")));
  assert.deepEqual(found, []);
});
