import "./designated-test-container.mjs";
// CP-57 (DEC-435): the test-run recorder. The pure decision (report in, `test_run` metadata out) and the wrapper run against a real temp git repo.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecord, parseJsonReport, parseJunitReport, RECORD_MARKER } from "../scripts/lib/test-run.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const clean = { head: SHA, tree: TREE, dirty: false };
const vitestReport = (over = {}) =>
  JSON.stringify({
    numTotalTests: 5, numPassedTests: 4, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0,
    testResults: [{ name: "/r/a.test.ts", status: "passed" }, { name: "/r/b.test.ts", status: "passed" }],
    ...over,
  });
const decide = (over = {}) => decideRecord({ exitCode: 0, parsed: parseJsonReport(vitestReport()), before: clean, after: clean, command: "make test", machine: "m", ...over });

test("a passing vitest report becomes the exact test_run metadata, with the file list only because it matches the file count", () => {
  const d = decide();
  assert.deepEqual(d.metadata, {
    kind: "test_run", commit_sha: SHA, tree_id: TREE, command: "make test", machine: "m",
    tests: { passed: 4, failed: 0, skipped: 1, total: 5 },
    test_files: { passed: 2, failed: 0, skipped: 0, total: 2 },
    files: ["/r/a.test.ts", "/r/b.test.ts"],
  });
});

test("files is null when the list is not exactly the counted files, or longer than 100", () => {
  const mismatch = parseJsonReport(vitestReport({ testResults: [{ name: "/r/a.test.ts", status: "passed" }, { name: "", status: "passed" }] }));
  assert.equal(decide({ parsed: mismatch }).metadata.files, null);
  const many = Array.from({ length: 101 }, (_, i) => ({ name: `/r/${i}.test.ts`, status: "passed" }));
  assert.equal(decide({ parsed: parseJsonReport(vitestReport({ testResults: many })) }).metadata.files, null);
});

test("JUnit gives tests only: test_files and files are null (the keys stay)", () => {
  const parsed = parseJunitReport('<testsuites tests="10" failures="0" errors="0" skipped="2"><testsuite tests="10"/></testsuites>');
  assert.deepEqual(decide({ parsed }).metadata, {
    kind: "test_run", commit_sha: SHA, tree_id: TREE, command: "make test", machine: "m",
    tests: { passed: 8, failed: 0, skipped: 2, total: 10 }, test_files: null, files: null,
  });
  assert.equal(parseJunitReport('<testsuite tests="3" failures="1"><testsuite tests="3" failures="1"/></testsuite>').tests.total, 3);
  assert.equal(parseJunitReport("<nothing/>"), null);
});

test("nothing is recorded for a failure, a missing report, a dirty tree, a moved HEAD or an empty run", () => {
  assert.match(decide({ exitCode: 1 }).reason, /exited 1/);
  assert.match(decide({ parsed: null }).reason, /no per-test counts/);
  assert.match(decide({ parsed: parseJsonReport(vitestReport({ numFailedTests: 1 })) }).reason, /failure/);
  assert.match(decide({ parsed: parseJsonReport(vitestReport({ numTotalTests: 0, numPassedTests: 0, numPendingTests: 0 })) }).reason, /no tests ran/);
  assert.match(decide({ before: { ...clean, dirty: true } }).reason, /not clean when/);
  assert.match(decide({ after: { ...clean, dirty: true } }).reason, /not clean after/);
  assert.match(decide({ after: { ...clean, head: "c".repeat(40) } }).reason, /HEAD moved/);
  assert.match(decide({ after: { ...clean, tree: "c".repeat(40) } }).reason, /HEAD moved/);
  assert.equal(parseJsonReport("not json"), null);
});

// ---- the wrapper, against a real repo
const SCRIPT = new URL("../scripts/record-test-run.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rtr-"));
  const g = (...a) => spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "card/XX-1");
  writeFileSync(path.join(dir, "a.txt"), "a");
  g("add", "."); g("commit", "-qm", "init");
  return { dir, g };
}
const run = (dir, args) => spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
const reportDir = () => mkdtempSync(path.join(os.tmpdir(), "rtr-report-"));
// a "test command" that writes the report the wrapper names, as a runner would
const writer = (body) => `node -e "require('fs').writeFileSync(process.env.DANXBOT_TEST_REPORT, process.argv[1])" '${body.replaceAll("'", "")}'`;

test("a passing run on a clean card branch prints the marker and writes the record file the hook posts", () => {
  const { dir } = repo();
  const report = path.join(reportDir(), "r.json");
  const r = run(dir, ["--report", report, "--", writer(vitestReport())]);
  assert.equal(r.status, 0, r.stderr);
  const file = new RegExp(`^${RECORD_MARKER} (.+)$`, "m").exec(r.stdout)?.[1];
  assert.ok(file, r.stdout);
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(record.card, "XX-1");
  assert.equal(record.metadata.kind, "test_run");
  assert.equal(record.metadata.tests.passed, 4);
});

test("a failing command keeps its exit code and records nothing", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", path.join(reportDir(), "r.json"), "--", "node -e 'process.exit(3)'"]);
  assert.equal(r.status, 3);
  assert.doesNotMatch(r.stdout, new RegExp(RECORD_MARKER));
});

test("a dirty tree, a report inside the repo and a runner with no report record nothing but still run the command", () => {
  const { dir } = repo();
  const ok = writer(vitestReport());
  assert.doesNotMatch(run(dir, ["--report", path.join(reportDir(), "r.json"), "--", "node -e 0"]).stdout, new RegExp(RECORD_MARKER));
  mkdirSync(path.join(dir, "x")); writeFileSync(path.join(dir, "x", "new.txt"), "n");
  const dirty = run(dir, ["--report", path.join(reportDir(), "r.json"), "--", ok]);
  assert.equal(dirty.status, 0);
  assert.match(dirty.stderr, /not clean/);
  assert.doesNotMatch(dirty.stdout, new RegExp(RECORD_MARKER));
  const { dir: dir2 } = repo();
  assert.match(run(dir2, ["--report", path.join(dir2, "r.json"), "--", ok]).stderr, /inside the repo/);
});

test("a commit made while the command runs records nothing", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", path.join(reportDir(), "r.json"), "--", `${writer(vitestReport())} && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m moved`]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /HEAD moved/);
  assert.doesNotMatch(r.stdout, new RegExp(RECORD_MARKER));
});

test("usage errors exit 2", () => {
  assert.equal(run(os.tmpdir(), ["--report", "x"]).status, 2);
});
