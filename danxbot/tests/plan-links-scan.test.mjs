// DX-4630: the plugin opens no page itself and draws no `Link` element. A `Link` opens the external browser, a Markdown link the app's
// in-app browser (proven live), and the `Claude_Browser` tool flow it replaced cost 6.3 s a press. The source holds neither.
// DX-5093: the one exception is the plan-tab keepalive's own look at the pane (hooks/relay/browser.ts), run by a timer and never by a press.
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

const KEEPALIVE_BROWSER = path.join(hooks, "relay", "browser.ts");

test("no hooks source calls the Claude_Browser tools but the keepalive's pane look, and no press handler reaches it", () => {
  const found = sources(hooks).filter((p) => /Claude_Browser/.test(readFileSync(p, "utf8")));
  assert.deepEqual(found, [KEEPALIVE_BROWSER]);
  // the pane look is made by the keepalive (a timer, or the turn start's re-check), never from the band or the pane
  const users = sources(hooks).filter((p) => /from '\.(\/relay)?\/browser'/.test(readFileSync(p, "utf8"))).map((p) => path.relative(hooks, p).replaceAll("\\", "/"));
  assert.deepEqual(users, ["register.tsx", "relay/refusal.ts"]);
  assert.deepEqual(sources(path.join(hooks, "plan")).filter((p) => /browserCall|BROWSER_SERVER/.test(readFileSync(p, "utf8"))), []);
});

test("no hooks source draws a Link element or reads one from the element table", () => {
  const found = sources(hooks).filter((p) => /<(\w+\.)?Link\b|\.Link\b|\bLink\s*[,}]|type:\s*['"]Link['"]/.test(readFileSync(p, "utf8")));
  assert.deepEqual(found, []);
});

test("no hooks source gives a Markdown a link handler: a plain click would go to the plugin and the app would open nothing", () => {
  const found = sources(hooks).filter((p) => /onLinkPress|pressableLinks/.test(readFileSync(p, "utf8")));
  assert.deepEqual(found, []);
});
