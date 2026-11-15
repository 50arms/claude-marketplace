import "./designated-test-container.mjs";
// The engine's own validator accepts the plugin, and no hook module or script imports a file that does not exist. The module's own behaviour is tested
// by `claude plugin test 50arms` (tests/*.test.tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under `dir`, as `/`-separated paths relative to it, sorted. */
function filesUnder(dir) {
  const walk = (rel) =>
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      const next = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? walk(next) : [next];
    });
  return walk("").sort();
}

// `claude` is not on PATH on every machine; CLAUDE_BIN names it (publish.sh reads the same variable).
// No CLI is a failure, never a skip: a validate nobody ran proves nothing.
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";

test("DX-4232: claude plugin validate 50 Arms exits 0", () => {
  const found = spawnSync(CLAUDE, ["--version"], { encoding: "utf8" });
  assert.equal(found.status, 0, `no claude CLI found as "${CLAUDE}": set CLAUDE_BIN to the claude executable (${found.error?.message ?? found.stderr})`);
  const r = spawnSync(CLAUDE, ["plugin", "validate", "50arms"], { cwd: path.dirname(PLUGIN), encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("DX-4233: no script or hook module imports a file that does not exist", () => {
  const files = ["scripts", "hooks"]
    .flatMap((dir) => filesUnder(path.join(PLUGIN, dir)).map((rel) => path.join(PLUGIN, dir, rel)))
    .filter((f) => /\.(mjs|js|ts|tsx)$/.test(f));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      const candidates = [target, ...[".mjs", ".js", ".ts", ".tsx", ".json"].map((x) => target + x), path.join(target, "index.ts"), path.join(target, "index.tsx"), path.join(target, "index.d.ts"), target + ".d.ts"];
      assert.ok(candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile()), `${path.relative(PLUGIN, file)} imports missing ${m[1]}`);
    }
  }
});
