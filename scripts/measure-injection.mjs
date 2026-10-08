#!/usr/bin/env node
//
// measure-injection.mjs — DX-3053.
//
// Prints what every marketplace plugin's hooks hand the model in a session, per plugin and per hook, with byte counts and
// totals per cadence class (per-turn, per-tool-call). scripts/check-injection-budget.mjs gates a publish on those totals.
//
// WHAT IS MEASURED (DX-4234, DX-4235). A plugin's hooks are one native hooks module (`hooks.json` `modules`); there are no
// command hooks to run (danxbot/tests/plugin-modules.test.mjs pins that shape for danxbot). The only
// standing text a module hands the model is the time stamp on each prompt (prompt.submit) and after each tool call
// (tool.call): the pure `stamp` of <plugin>/hooks/context/stamp.ts, the very text register.tsx hands the model. It is run
// here, at its widest (the first stamp, which carries the date). Everything else a module says is the dashboard's (the
// registry's event text, the restart notice, a ready-cards block), fetched only for a plan-connected session, with no
// offline text to count. A plugin with `modules` and no stamp.ts is an error row, never zero bytes.
//
// USAGE
//   node scripts/measure-injection.mjs [--json]
//
// Exits 1 when a row is an error (a stamp that cannot be measured), else 0.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_MODE = process.argv.includes("--json");

function loadMarketplacePlugins() {
  const mpPath = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");
  const mp = JSON.parse(fs.readFileSync(mpPath, "utf8"));
  return mp.plugins.map((p) => p.source.replace(/^\.\//, ""));
}

function loadHooksJson(pluginDir) {
  const hooksPath = path.join(REPO_ROOT, pluginDir, "hooks", "hooks.json");
  if (!fs.existsSync(hooksPath)) return null;
  return JSON.parse(fs.readFileSync(hooksPath, "utf8"));
}

// The stamp a module hands the model on a prompt and after a tool call, run through node's type stripping (stamp.ts is
// pure, so nothing else loads). Bytes include the line's newline.
const STAMP_SCRIPT = `const { stamp } = await import(process.env.STAMP_MODULE);
console.log(stamp(Date.UTC(2026, 8, 28, 7, 12, 3), -360, null).line);`;

function measureFunctionHooks(plugin, hooksJson) {
  if (!Array.isArray(hooksJson.modules)) return [];
  const module = path.join(plugin, "hooks", "context", "stamp.ts");
  const row = (event, kind, extra) => ({ plugin, event, command: module, kind, ...extra });
  const stampPath = path.join(REPO_ROOT, module);
  let bytes;
  try {
    bytes = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", STAMP_SCRIPT],
      { env: { ...process.env, STAMP_MODULE: pathToFileURL(stampPath).href }, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    ).length;
  } catch (err) {
    const error = fs.existsSync(stampPath) ? err.message.split("\n")[0] : `${module} is missing: the time stamp cannot be measured`;
    return [row("prompt.submit", "unconditional", { bytes: 0, error }), row("tool.call", "every-tool-call", { bytes: 0, error })];
  }
  return [row("prompt.submit", "unconditional", { bytes, error: null }), row("tool.call", "every-tool-call", { bytes, error: null })];
}

function measure() {
  const rows = []; // { plugin, event, command, kind, bytes, error }
  for (const plugin of loadMarketplacePlugins()) {
    const hooksJson = loadHooksJson(plugin);
    if (hooksJson) rows.push(...measureFunctionHooks(plugin, hooksJson));
  }
  return rows;
}

// Reported separately, never summed together (AC 32510): per-turn (prompt.submit) and per-tool-call (tool.call).
function summarize(rows) {
  const sum = (event) => rows.filter((r) => r.event === event).reduce((total, r) => total + r.bytes, 0);
  return { perTurnUnconditional: sum("prompt.submit"), perToolCall: sum("tool.call") };
}

function printHuman(rows, totals) {
  console.log("Injection measurement (each module's time stamp, at its widest)\n");
  for (const r of rows) {
    const tag = r.error ? ` [ERROR: ${r.error}]` : "";
    console.log(`  ${r.plugin.padEnd(20)} ${r.event.padEnd(14)} kind=${r.kind.padEnd(16)} bytes=${r.bytes}${tag}`);
  }
  console.log("\n=== Totals (never summed together: different cadences) ===");
  console.log(`  per-turn (prompt.submit):   ${totals.perTurnUnconditional} bytes`);
  console.log(`  per-tool-call (tool.call):  ${totals.perToolCall} bytes`);
}

const rows = measure();
const totals = summarize(rows);

if (JSON_MODE) {
  console.log(JSON.stringify({ rows, totals }, null, 2));
} else {
  printHuman(rows, totals);
}

process.exit(rows.some((r) => r.error) ? 1 : 0);
