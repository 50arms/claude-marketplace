import "../../danxbot/tests/designated-test-container.mjs";
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
import { publishScope, readRepo, MAX_NARROW_CODE_FILES } from "../lib/publish-scope.mjs";

const spell = (...parts) => parts.join("/");
const THIS_TEST = "scripts/tests/publish-scope.test.mjs";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const repo = {
  tests: new Map([
    ["danxbot/tests/context-stamp.test.tsx", `import { stamp } from '../${spell("hooks", "context", "stamp")}'`],
    ["danxbot/tests/issue-workflow-gates.test.mjs", `readFileSync(join(skills, '${["issue", "workflow"].join("-")}', 'SKILL.md'))`],
    ["scripts/tests/publish.test.mjs", "scripts/publish"],
  ]),
};

test("a prose file no test names runs no test", () => {
  assert.equal(publishScope(["danxbot/skills/other/SKILL.md"], repo).kind, "none");
});

test("a code file no test names is a broad change, never none", () => {
  for (const f of ["danxbot/hooks/plan/band.tsx", "danxbot/hooks/relay/cursor.ts", "danxbot/scripts/lib/page-programs.mjs"]) assert.equal(publishScope([f], repo).kind, "all", f);
});

test("a skill edit runs the tests that read that skill", () => {
  const scope = publishScope(["danxbot/skills/issue-workflow/SKILL.md"], repo);
  assert.equal(scope.kind, "files");
  assert.deepEqual(scope.files, ["danxbot/tests/issue-workflow-gates.test.mjs"]);
});

test("a skill folder is matched as a whole quoted path segment, never as a substring of another word", () => {
  const tests = new Map([
    ["danxbot/tests/a.test.mjs", "readFileSync(join(skills, 'restart-notes', 'SKILL.md'))"],
    ["danxbot/tests/b.test.mjs", "readFileSync(join(skills, 'start', 'SKILL.md'))"],
  ]);
  assert.deepEqual(publishScope(["danxbot/skills/start/SKILL.md"], { tests }).files, ["danxbot/tests/b.test.mjs"]);
});

test("a code file runs the tests that import it", () => {
  assert.deepEqual(publishScope(["danxbot/hooks/context/stamp.ts"], repo).files, ["danxbot/tests/context-stamp.test.tsx"]);
});

test("a test that walks a directory reads every file under it", () => {
  const walking = { tests: new Map([["danxbot/tests/scan.test.mjs", "readdirSync(dir)"]]), walks: new Map([["danxbot/tests/scan.test.mjs", ["danxbot/hooks"]]]) };
  assert.deepEqual(publishScope(["danxbot/hooks/deep/er/file.ts"], walking).files, ["danxbot/tests/scan.test.mjs"]);
  assert.equal(publishScope(["danxbot/other/file.ts"], walking).kind, "all");
});

test("a changed test file runs itself; the version bump's own files count for nothing", () => {
  assert.deepEqual(publishScope(["danxbot/tests/context-stamp.test.tsx", "danxbot/.claude-plugin/plugin.json"], repo).files, ["danxbot/tests/context-stamp.test.tsx"]);
});

test("a file every suite leans on is a broad change", () => {
  for (const f of ["package.json", "Dockerfile.test", "danxbot/hooks/register.tsx", "danxbot/hooks/hooks.json", "danxbot/tests/plan-kit.tsx"]) assert.equal(publishScope([f], repo).kind, "all", f);
});

test("more code files than a narrow change allows is a broad change", () => {
  const many = Array.from({ length: MAX_NARROW_CODE_FILES + 1 }, (_, i) => `danxbot/hooks/x${i}.ts`);
  const named = { tests: new Map([["danxbot/tests/x.test.mjs", many.map((f) => `import "../${f.replace(/^danxbot\//, "").replace(/\.ts$/, "")}"`).join("\n")]]) };
  assert.equal(publishScope(many, named).kind, "all");
  assert.equal(publishScope(many.slice(1), named).kind, "files");
});

test("prose files do not count toward the narrow-change limit", () => {
  const prose = Array.from({ length: MAX_NARROW_CODE_FILES + 3 }, (_, i) => `danxbot/skills/s${i}/SKILL.md`);
  assert.equal(publishScope([...prose, "danxbot/hooks/context/stamp.ts"], repo).kind, "files");
});

test("a plugin with no earlier publish gets the whole suite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-scope-"));
  try {
    const identity = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: dir, env: identity });
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "publish-scope.mjs");
    const r = spawnSync("node", [script, dir, "danxbot"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "all");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a string that only spells a path does not name it; an import does", () => {
  const spelled = { tests: new Map([["danxbot/tests/a.test.mjs", `assert.equal(f, "${spell("danxbot", "hooks", "y.ts")}") // ${spell("hooks", "y")}`]]) };
  assert.equal(publishScope(["danxbot/hooks/y.ts"], spelled).kind, "all");
  const imported = { tests: new Map([["danxbot/tests/a.test.mjs", `import { y } from '../${spell("hooks", "y")}'`]]) };
  assert.equal(publishScope(["danxbot/hooks/y.ts"], imported).kind, "files");
});

// the real test folders
const real = readRepo(REPO_ROOT);

test("on the real tests, a fixture-only spelling of a hook file does not make this test its dependent", () => {
  assert.ok(real.tests.size > 10, "the real test folders were read");
  const scope = publishScope(["danxbot/hooks/plan/band.tsx"], real);
  assert.ok(!(scope.files ?? []).includes(THIS_TEST), `${THIS_TEST} only spells paths in fixtures`);
});

test("on the real tests, a hooks source file runs the scans that walk the hooks folder", () => {
  const scope = publishScope(["danxbot/hooks/context/disk.ts"], real);
  assert.equal(scope.kind, "files");
  for (const scan of ["plan-links-scan", "plan-relay-scan", "store-door-scan", "plugin-modules"]) assert.ok(scope.files.includes(`danxbot/tests/${scan}.test.mjs`), scan);
});

test("on the real tests, an agent profile file runs the test that reads the agents folder", () => {
  const agent = fs.readdirSync(path.join(REPO_ROOT, "danxbot", "agents")).find((n) => n.startsWith("worker-") && n.endsWith(".md"));
  const scope = publishScope([`danxbot/agents/${agent}`], real);
  assert.equal(scope.kind, "files");
  assert.ok(scope.files.includes("danxbot/tests/worker-agents-profile-brief.test.mjs"));
});
