import "../../50arms/tests/designated-test-container.mjs";
// CP-16: which tests a publish runs (scripts/lib/publish-scope.mjs), as a pure function of the changed paths and the tests' text.
// The fixtures spell their paths from parts (`spell`), so no line of this file reads as a load of a real plugin file: this file would
// otherwise count as a dependent of every file it mentions.
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { publishScope, readRepo, walkedDirectories, MAX_NARROW_CODE_FILES } from "../lib/publish-scope.mjs";

const spell = (...parts) => parts.join("/");
const THIS_TEST = "scripts/tests/publish-scope.test.mjs";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const repo = {
  tests: new Map([
    ["50arms/tests/context-stamp.test.tsx", `import { stamp } from '../${spell("hooks", "context", "stamp")}'`],
    ["50arms/tests/issue-workflow-gates.test.mjs", `readFileSync(join(skills, '${["issue", "workflow"].join("-")}', 'SKILL.md'))`],
    ["scripts/tests/publish.test.mjs", "scripts/publish"],
  ]),
};

test("a prose file no test names runs no test", () => {
  assert.equal(publishScope(["50arms/skills/other/SKILL.md"], repo).kind, "none");
});

test("a code file no test names is a broad change, never none", () => {
  for (const f of ["50arms/hooks/plan/band.tsx", "50arms/hooks/relay/cursor.ts", "50arms/scripts/lib/page-programs.mjs"]) assert.equal(publishScope([f], repo).kind, "all", f);
});

test("a skill edit runs the tests that read that skill", () => {
  const scope = publishScope(["50arms/skills/issue-workflow/SKILL.md"], repo);
  assert.equal(scope.kind, "files");
  assert.deepEqual(scope.files, ["50arms/tests/issue-workflow-gates.test.mjs"]);
});

test("a skill folder is matched as a whole quoted path segment, never as a substring of another word", () => {
  const tests = new Map([
    ["50arms/tests/a.test.mjs", "readFileSync(join(skills, 'restart-notes', 'SKILL.md'))"],
    ["50arms/tests/b.test.mjs", "readFileSync(join(skills, 'start', 'SKILL.md'))"],
  ]);
  assert.deepEqual(publishScope(["50arms/skills/start/SKILL.md"], { tests }).files, ["50arms/tests/b.test.mjs"]);
});

test("a code file runs the tests that import it", () => {
  assert.deepEqual(publishScope(["50arms/hooks/context/stamp.ts"], repo).files, ["50arms/tests/context-stamp.test.tsx"]);
});

test("a test that walks a directory reads every file under it", () => {
  const walking = { tests: new Map([["50arms/tests/scan.test.mjs", "readdirSync(dir)"]]), walks: new Map([["50arms/tests/scan.test.mjs", ["50arms/hooks"]]]) };
  assert.deepEqual(publishScope(["50arms/hooks/deep/er/file.ts"], walking).files, ["50arms/tests/scan.test.mjs"]);
  assert.equal(publishScope(["50arms/other/file.ts"], walking).kind, "all");
});

test("a deleted test file is a broad change, never none", () => {
  assert.equal(publishScope(["50arms/tests/gone.test.mjs"], repo).kind, "all");
});

test("a changed test file runs itself; the version bump's own files count for nothing", () => {
  assert.deepEqual(publishScope(["50arms/tests/context-stamp.test.tsx", "50arms/.claude-plugin/plugin.json"], repo).files, ["50arms/tests/context-stamp.test.tsx"]);
});

test("a file every suite leans on is a broad change", () => {
  for (const f of ["package.json", "Dockerfile.test", "50arms/hooks/register.tsx", "50arms/hooks/hooks.json", "50arms/tests/plan-kit.tsx"]) assert.equal(publishScope([f], repo).kind, "all", f);
});

test("more code files than a narrow change allows is a broad change", () => {
  const many = Array.from({ length: MAX_NARROW_CODE_FILES + 1 }, (_, i) => `50arms/hooks/x${i}.ts`);
  const named = { tests: new Map([["50arms/tests/x.test.mjs", many.map((f) => `import "../${f.replace(/^50arms\//, "").replace(/\.ts$/, "")}"`).join("\n")]]) };
  assert.equal(publishScope(many, named).kind, "all");
  assert.equal(publishScope(many.slice(1), named).kind, "files");
});

test("prose files do not count toward the narrow-change limit", () => {
  const prose = Array.from({ length: MAX_NARROW_CODE_FILES + 3 }, (_, i) => `50arms/skills/s${i}/SKILL.md`);
  assert.equal(publishScope([...prose, "50arms/hooks/context/stamp.ts"], repo).kind, "files");
});

test("a plugin with no earlier publish gets the whole suite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-scope-"));
  try {
    const identity = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: dir, env: identity });
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "publish-scope.mjs");
    const r = spawnSync("node", [script, dir, "50arms"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "all");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a string that only spells a path does not name it; an import does", () => {
  const spelled = { tests: new Map([["50arms/tests/a.test.mjs", `assert.equal(f, "${spell("50arms", "hooks", "y.ts")}") // ${spell("hooks", "y")}`]]) };
  assert.equal(publishScope(["50arms/hooks/y.ts"], spelled).kind, "all");
  const imported = { tests: new Map([["50arms/tests/a.test.mjs", `import { y } from '../${spell("hooks", "y")}'`]]) };
  assert.equal(publishScope(["50arms/hooks/y.ts"], imported).kind, "files");
});

test("a quoted path that is only a plugin folder (a trailing slash) names no directory to walk", () => {
  for (const literal of ["../", "../../", "50arms/", ".."]) assert.deepEqual(walkedDirectories(REPO_ROOT, "50arms/tests/x.test.mjs", `"${literal}"`), [], literal);
  assert.deepEqual(walkedDirectories(REPO_ROOT, "50arms/tests/x.test.mjs", '"../hooks/"'), ["50arms/hooks"]);
});

// the real test folders
const real = readRepo(REPO_ROOT);

test("on the real tests, a fixture-only spelling of a hook file does not make this test its dependent", () => {
  assert.ok(real.tests.size > 10, "the real test folders were read");
  const scope = publishScope(["50arms/hooks/plan/band.tsx"], real);
  assert.ok(!(scope.files ?? []).includes(THIS_TEST), `${THIS_TEST} only spells paths in fixtures`);
});

test("on the real tests, a hooks source file runs the scans that walk the hooks folder", () => {
  const scope = publishScope(["50arms/hooks/context/disk.ts"], real);
  assert.equal(scope.kind, "files");
  for (const scan of ["plan-links-scan", "plan-relay-scan", "store-door-scan", "plugin-modules"]) assert.ok(scope.files.includes(`50arms/tests/${scan}.test.mjs`), scan);
});

test("on the real tests, an agent profile file runs the test that reads the agents folder", () => {
  const agent = fs.readdirSync(path.join(REPO_ROOT, "50arms", "agents")).find((n) => n.startsWith("worker-") && n.endsWith(".md"));
  const scope = publishScope([`50arms/agents/${agent}`], real);
  assert.equal(scope.kind, "files");
  assert.ok(scope.files.includes("50arms/tests/worker-agents-profile-brief.test.mjs"));
});
