import "./designated-test-container.mjs";
// CP-57 (DEC-435): the test-run recorder. The pure decision (report in, `test_run` metadata out) and the wrapper run against a real temp git repo.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  const parsed = parseJunitReport('<testsuites tests="10" failures="0" errors="0" skipped="2"></testsuites>');
  assert.deepEqual(decide({ parsed }).metadata, {
    kind: "test_run", commit_sha: SHA, tree_id: TREE, command: "make test", machine: "m",
    tests: { passed: 8, failed: 0, skipped: 2, total: 10 }, test_files: null, files: null,
  });
});

test("JUnit without root totals sums the top-level suites once, not their nested suites", () => {
  assert.equal(parseJunitReport('<testsuite tests="3" failures="1"><testsuite tests="3" failures="1"/></testsuite>').tests.total, 3);
});

test("JUnit counts failures and errors together as failed", () => {
  assert.equal(parseJunitReport('<testsuites tests="4" failures="1" errors="1" skipped="0"></testsuites>').tests.failed, 2);
});

test("a document with no suite gives no counts", () => {
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
const SCRIPT = fileURLToPath(new URL("../scripts/record-test-run.mjs", import.meta.url));
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
const reportIn = () => path.join(reportDir(), "r.json");
const MARK = new RegExp(RECORD_MARKER);
// a "test command" (argv) that writes the given text to the report file the wrapper names, as a runner would
const writer = (body, extra = "") => ["node", "-e", `require('fs').writeFileSync(process.env.DANXBOT_TEST_REPORT, process.argv[1]);${extra}`, body];
const recordOf = (r) => JSON.parse(readFileSync(new RegExp(`^${RECORD_MARKER} (.+)$`, "m").exec(r.stdout)[1], "utf8"));

test("a passing run on a clean card branch prints the marker and writes the record file the hook posts", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", reportIn(), "--", ...writer(vitestReport())]);
  assert.equal(r.status, 0, r.stderr);
  const record = recordOf(r);
  assert.equal(record.card, "XX-1");
  assert.equal(record.metadata.kind, "test_run");
  assert.equal(record.metadata.tests.passed, 4);
});

test("--card names the card when the branch does not", () => {
  const { dir, g } = repo();
  g("checkout", "-q", "-b", "work");
  assert.equal(recordOf(run(dir, ["--report", reportIn(), "--card", "YY-2", "--", ...writer(vitestReport())])).card, "YY-2");
});

test("a quoted argument stays one argument and the recorded command writes it back quoted", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", reportIn(), "--", ...writer(vitestReport(), "console.log('ARGS=' + process.argv.length);"), "two words"]);
  assert.match(r.stdout, /ARGS=3/);
  assert.match(recordOf(r).metadata.command, /'two words'$/);
});

test("a failing command keeps its exit code and records nothing", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", reportIn(), "--", "node", "-e", "process.exit(3)"]);
  assert.equal(r.status, 3);
  assert.doesNotMatch(r.stdout, MARK);
});

test("a runner that writes no report records nothing but still runs", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", reportIn(), "--", "node", "-e", "console.log('ran')"]);
  assert.match(r.stdout, /ran/);
  assert.doesNotMatch(r.stdout, MARK);
  assert.match(r.stderr, /no per-test counts/);
});

test("a report left over from an earlier run is not read", () => {
  const { dir } = repo();
  const report = reportIn();
  writeFileSync(report, vitestReport());
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(report, old, old);
  const r = run(dir, ["--report", report, "--", "node", "-e", "0"]);
  assert.doesNotMatch(r.stdout, MARK);
  assert.match(r.stderr, /no per-test counts/);
});

test("a dirty tree records nothing but still runs the command", () => {
  const { dir } = repo();
  writeFileSync(path.join(dir, "new.txt"), "n");
  const r = run(dir, ["--report", reportIn(), "--", ...writer(vitestReport())]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /not clean/);
  assert.doesNotMatch(r.stdout, MARK);
});

test("a report inside the repo records nothing, since it would dirty the tree", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", path.join(dir, "r.json"), "--", ...writer(vitestReport())]);
  assert.match(r.stderr, /inside the repo/);
  assert.doesNotMatch(r.stdout, MARK);
});

test("no card (not a card branch, no --card) records nothing but still runs", () => {
  const { dir, g } = repo();
  g("checkout", "-q", "-b", "work");
  const r = run(dir, ["--report", reportIn(), "--", ...writer(vitestReport())]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no card/);
  assert.doesNotMatch(r.stdout, MARK);
});

test("a commit made while the command runs records nothing", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", reportIn(), "--", ...writer(vitestReport(), "require('child_process').execFileSync('git',['-c','user.email=t@t','-c','user.name=t','commit','-q','--allow-empty','-m','moved']);")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /HEAD moved/);
  assert.doesNotMatch(r.stdout, MARK);
});

test("usage errors exit 2", () => {
  assert.equal(run(os.tmpdir(), ["--report", "x"]).status, 2);
});
