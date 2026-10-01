// DX-3673 — the pinned `@thehammer/danx-dashboard-mcp` version
// (danxbot/scripts/lib/dashboard-mcp-package.mjs) must actually support every
// subcommand this plugin's scripts invoke on it: `bridge` (plan-event-bridge.mjs),
// `background-work` (background-work-report.mjs) and `event-text` (event-hook.sh).
// `npx -y` never re-checks the registry once a version is cached, so a stale pin
// fails silently at runtime, in production, the next time the npx cache is cold —
// never at review time (this is exactly how DX-3673 happened: the plugin shipped
// pinned to 0.1.146, which predates `event-text` entirely, so every SubagentStart
// hook failed with "unknown subcommand \"event-text\"").
//
// This test asks the REAL pinned package (a real `npx`, deliberately) which
// subcommands it accepts, by invoking an unknown one and parsing the published
// `dist/index.js`'s own refusal message — `[danx-dashboard-mcp] unknown subcommand
// "<x>" (the only ones are "a", "b", ...)` — then asserts every subcommand this
// plugin's own source still invokes is in that list.
//
// Unlike every other test in this directory (background-work-report.test.mjs,
// plan-event-bridge.test.mjs, event-hook.test.mjs), this one intentionally does
// NOT mock spawn: a mocked `npx` can never catch a real drift between the pin and
// what the registry actually publishes, which is the one thing this guard exists
// to catch. Network + registry-cache dependent by design; slower than this
// directory's other tests (~seconds, real `npx`) for the same reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_MCP_PACKAGE } from "../scripts/lib/dashboard-mcp-package.mjs";
import { BRIDGE_SUBCOMMAND } from "../scripts/plan-event-bridge.mjs";
import { reportCommand } from "../scripts/background-work-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const EVENT_HOOK_SH = path.join(here, "..", "scripts", "event-hook.sh");
const NPX_TIMEOUT_MS = 30_000;

/** The literal subcommand token event-hook.sh passes to the installed pin: `node "$MCP_BIN" <token> "$DANX_EVENT"` (DX-3811 — run from the plugin-data install, no longer via npx). */
function eventTextSubcommandFromSource() {
  const src = readFileSync(EVENT_HOOK_SH, "utf8");
  const m = src.match(/node "\$MCP_BIN" (\S+) "\$DANX_EVENT"/);
  assert.ok(m, "event-hook.sh no longer calls the installed package the expected way — update this test's extraction regex");
  return m[1];
}

/** The literal subcommand token background-work-report.mjs's reportCommand places second. */
function backgroundWorkSubcommandFromSource() {
  const { args } = reportCommand({ countOrClear: "0", platform: "linux" });
  // args = ["-y", DASHBOARD_MCP_PACKAGE, "<subcommand>", "0"]
  return args[2];
}

test(
  "the pinned danx-dashboard-mcp version supports every subcommand this plugin invokes",
  { timeout: NPX_TIMEOUT_MS + 10_000 },
  () => {
    const required = [BRIDGE_SUBCOMMAND, backgroundWorkSubcommandFromSource(), eventTextSubcommandFromSource()];

    // An unknown subcommand makes the real published `dist/index.js` refuse with its
    // own "the only ones are ..." message, which names every subcommand the pinned
    // version actually ships (its `main()` entrypoint's "unknown subcommand" branch).
    const probe = spawnSync("npx", ["-y", DASHBOARD_MCP_PACKAGE, "__dx-3673-guard-probe__"], {
      encoding: "utf8",
      timeout: NPX_TIMEOUT_MS,
      shell: process.platform === "win32", // npx is a .cmd shim on Windows
    });

    assert.equal(
      probe.status,
      2,
      `expected the pinned package's own "unknown subcommand" refusal (exit 2); ` +
        `got status=${probe.status} stderr=${probe.stderr} stdout=${probe.stdout}`
    );

    const listed = [...probe.stderr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(listed.length > 0, `could not parse the supported-subcommand list out of: ${probe.stderr}`);

    for (const subcommand of required) {
      assert.ok(
        listed.includes(subcommand),
        `pinned ${DASHBOARD_MCP_PACKAGE} does not support "${subcommand}", which this plugin's scripts still ` +
          `invoke — the pin (danxbot/scripts/lib/dashboard-mcp-package.mjs) has fallen behind a published ` +
          `danxbot release. Published subcommands: [${listed.join(", ")}]`
      );
    }
  }
);
