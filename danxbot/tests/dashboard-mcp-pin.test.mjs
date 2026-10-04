// DX-3673 / DX-4321 — the registry's CURRENT `@thehammer/danx-dashboard-mcp` version
// (`latest`, the one the plugin records and runs at every session start,
// danxbot/scripts/lib/dashboard-mcp-package.mjs) must actually support every
// subcommand this plugin's scripts invoke on it: `bridge` (plan-event-bridge.mjs),
// `background-work` (background-work-report.mjs), `activity` (activity-report.mjs, DX-3284) and `event-text` (event-hook.sh).
// The plugin has no version to fall behind any more (DX-4321), so the failure this guards is the
// other direction: a danxbot publish that REMOVES a subcommand the plugin still calls now
// reaches every session start at once, and this test is where the plugin's own next test run
// catches it. (The original DX-3673 failure: the plugin shipped pinned to 0.1.146, which predates
// `event-text` entirely, so every SubagentStart hook failed with "unknown subcommand
// \"event-text\"".)
//
// This test asks the REAL registry for `latest` and the REAL package (a real `npx`,
// deliberately) which subcommands it accepts, by invoking an unknown one and parsing the
// published `dist/index.js`'s own refusal message — `[danx-dashboard-mcp] unknown subcommand
// "<x>" (the only ones are "a", "b", ...)` — then asserts every subcommand this
// plugin's own source still invokes is in that list.
//
// Unlike every other test in this directory (background-work-report.test.mjs,
// plan-event-bridge.test.mjs, event-hook.test.mjs, which use a fake registry), this one
// intentionally does NOT mock the registry or spawn: a mock can never catch a real drift
// between the plugin and what the registry actually publishes, which is the one thing this
// guard exists to catch. Network + registry-cache dependent by design; slower than this
// directory's other tests (~seconds, real `npx`) for the same reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLatestVersion, specOf } from "../scripts/lib/dashboard-mcp-package.mjs";
import { BRIDGE_SUBCOMMAND } from "../scripts/plan-event-bridge.mjs";
import { reportCommand } from "../scripts/background-work-report.mjs";
import { ACTIVITY_SUBCOMMAND } from "../scripts/activity-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const EVENT_HOOK_SH = path.join(here, "..", "scripts", "event-hook.sh");
const ENSURE_SH = path.join(here, "..", "scripts", "ensure-dashboard-mcp.sh");
const NPX_TIMEOUT_MS = 30_000;
// DX-3928: event-hook.sh's not-connected SessionStart branch runs `restart-notice` (0.1.204+).
const RESTART_NOTICE_SUBCOMMAND = "restart-notice";

/** The registry's current spec, `<name>@<latest>`, read from the public registry (an empty env: no test seam). */
async function currentSpec() {
  return specOf(await resolveLatestVersion({ env: {} }));
}

/** The literal subcommand token event-hook.sh passes to the installed package: `node "$MCP_BIN" <token> "$DANX_EVENT"` (DX-3811 — run from the plugin-data install, no longer via npx). */
function eventTextSubcommandFromSource() {
  const src = readFileSync(EVENT_HOOK_SH, "utf8");
  const m = src.match(/node "\$MCP_BIN" (\S+) "\$DANX_EVENT"/);
  assert.ok(m, "event-hook.sh no longer calls the installed package the expected way — update this test's extraction regex");
  return m[1];
}

/** The literal subcommand token background-work-report.mjs's reportCommand places second. */
function backgroundWorkSubcommandFromSource() {
  const { args } = reportCommand({ countOrClear: "0", spec: "<spec>", platform: "linux" });
  // args = ["-y", "<spec>", "<subcommand>", "0"]
  return args[2];
}

/** DX-4508: the literal subcommand the plan pane's hooks module spawns for its live sub-agent numbers (hooks/plan/config.ts `LIVE_SUBCOMMAND`; a .ts file, so read as text). */
function liveSubcommandFromSource() {
  const src = readFileSync(path.join(here, "..", "hooks", "plan", "config.ts"), "utf8");
  const m = src.match(/export const LIVE_SUBCOMMAND = '([^']+)'/);
  assert.ok(m, "hooks/plan/config.ts no longer declares LIVE_SUBCOMMAND the expected way: update this test's extraction regex");
  return m[1];
}

test(
  "the registry's current danx-dashboard-mcp version supports every subcommand this plugin invokes",
  { timeout: NPX_TIMEOUT_MS + 10_000 },
  async () => {
    const spec = await currentSpec();
    const required = [BRIDGE_SUBCOMMAND, backgroundWorkSubcommandFromSource(), ACTIVITY_SUBCOMMAND, eventTextSubcommandFromSource(), RESTART_NOTICE_SUBCOMMAND, liveSubcommandFromSource()];

    // An unknown subcommand makes the real published `dist/index.js` refuse with its
    // own "the only ones are ..." message, which names every subcommand the current
    // version actually ships (its `main()` entrypoint's "unknown subcommand" branch).
    const probe = spawnSync("npx", ["-y", spec, "__dx-3673-guard-probe__"], {
      encoding: "utf8",
      timeout: NPX_TIMEOUT_MS,
      shell: process.platform === "win32", // npx is a .cmd shim on Windows
    });

    assert.equal(
      probe.status,
      2,
      `expected ${spec}'s own "unknown subcommand" refusal (exit 2); ` +
        `got status=${probe.status} stderr=${probe.stderr} stdout=${probe.stdout}`
    );

    const listed = [...probe.stderr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(listed.length > 0, `could not parse the supported-subcommand list out of: ${probe.stderr}`);

    for (const subcommand of required) {
      assert.ok(
        listed.includes(subcommand),
        `${spec}, the registry's current version, does not support "${subcommand}", which this plugin's scripts ` +
          `still invoke — a published danx-dashboard-mcp release removed it, and every session start now runs that ` +
          `release. Restore it in the package or stop invoking it here. Published subcommands: [${listed.join(", ")}]`
      );
    }
  }
);

// DX-3811 — ensure-dashboard-mcp.sh installs the recorded version and event-hook.sh runs its
// `dist/index.js` with `node`. That path is spelled out in the script, so a release that moved the
// package's `bin` would make every install end in "install_incomplete". Ask the registry what the
// current version's `bin` really is.
test(
  "the entry point ensure-dashboard-mcp.sh runs is the registry's current package's published bin",
  { timeout: NPX_TIMEOUT_MS + 10_000 },
  async () => {
    const spec = await currentSpec();
    const m = readFileSync(ENSURE_SH, "utf8").match(/^BIN_REL="node_modules\/\$\{PKG_NAME\}\/(\S+)"$/m);
    assert.ok(m, "ensure-dashboard-mcp.sh no longer spells BIN_REL the expected way — update this test's extraction regex");
    const view = spawnSync("npm", ["view", spec, "bin", "--json"], {
      encoding: "utf8",
      timeout: NPX_TIMEOUT_MS,
      shell: process.platform === "win32", // npm is a .cmd shim on Windows
    });
    assert.equal(view.status, 0, `npm view failed: ${view.stderr}`);
    const bins = Object.values(JSON.parse(view.stdout));
    assert.ok(
      bins.includes(m[1]),
      `${spec} publishes bin ${JSON.stringify(bins)}, but ensure-dashboard-mcp.sh runs ${m[1]}`
    );
  }
);
