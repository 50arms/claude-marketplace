import "./designated-test-container.mjs";
// CP-57 (DEC-435): the test-run recorder. The pure decision (report in, `test_run` metadata out) and the wrapper run against a real temp git repo.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { postRecord, withPipefail } from "../scripts/record-test-run.mjs";
import { shellWord } from "../scripts/lib/shell-quote.mjs";
import { withRecorderVar } from "../scripts/lib/recorder-var.mjs";
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

test("nothing is recorded for a failing exit", () => assert.match(decide({ exitCode: 1 }).reason, /exited 1/));
test("nothing is recorded when the runner gave no report", () => assert.match(decide({ parsed: null }).reason, /no per-test counts/));
test("nothing is recorded when the report shows a failure", () => assert.match(decide({ parsed: parseJsonReport(vitestReport({ numFailedTests: 1 })) }).reason, /failure/));
test("nothing is recorded for a run with no tests", () => assert.match(decide({ parsed: parseJsonReport(vitestReport({ numTotalTests: 0, numPassedTests: 0, numPendingTests: 0 })) }).reason, /no tests ran/));
test("nothing is recorded when the tree was dirty at the start", () => assert.match(decide({ before: { ...clean, dirty: true } }).reason, /not clean when/));
test("nothing is recorded when the tree is dirty at the end", () => assert.match(decide({ after: { ...clean, dirty: true } }).reason, /not clean after/));
test("nothing is recorded when HEAD moved", () => assert.match(decide({ after: { ...clean, head: "c".repeat(40) } }).reason, /HEAD moved/));
test("nothing is recorded when the tree id moved", () => assert.match(decide({ after: { ...clean, tree: "c".repeat(40) } }).reason, /HEAD moved/));
test("text that is not JSON is no report", () => assert.equal(parseJsonReport("not json"), null));

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
  assert.match(r.stderr, /older than this run/);
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


test("a word with an apostrophe is written so a shell reads it back unchanged", () => {
  for (const word of ["it's", "'", "a'b'c", "two words", "plain"]) {
    const r = spawnSync("sh", ["-c", `printf %s ${shellWord(word)}`], { encoding: "utf8" });
    assert.equal(r.stdout, word);
  }
  assert.equal(shellWord("it's"), "'it'\\''s'");
});

test("a command that cannot start is reported with the shell-wrapping hint, and the run fails", () => {
  const { dir } = repo();
  const r = run(dir, ["--report", reportIn(), "--", "no-such-command-xyz"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not start "no-such-command-xyz"/);
  assert.match(r.stderr, /bash -c '/);
  assert.match(r.stderr, /System32\\bash\.exe/);
});

test("a usage error exits 2 and carries the shell-wrapping hint", () => {
  const r = run(os.tmpdir(), ["--report", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bash -c '/);
});

test("a failed file with zero failed tests records nothing", () => {
  const parsed = parseJsonReport(vitestReport({ testResults: [{ name: "/r/a.test.ts", status: "failed" }, { name: "/r/b.test.ts", status: "passed" }] }));
  assert.match(decide({ parsed }).reason, /failure/);
});

test("nothing is recorded when the counts contradict each other", () => {
  const parsed = parseJsonReport(vitestReport({ numTotalTests: 3, numPassedTests: 3, numPendingTests: 2 }));
  assert.match(decide({ parsed }).reason, /contradict/);
});

test("nothing is recorded when HEAD is not a full sha", () => {
  assert.match(decide({ before: { ...clean, head: "abc" }, after: { ...clean, head: "abc" } }).reason, /full commit sha/);
});

test("postRecord says so when the request itself fails", async () => {
  const seen = [];
  const original = process.stderr.write;
  process.stderr.write = (m) => (seen.push(String(m)), true);
  try {
    assert.equal(await postRecord("http://127.0.0.1:1/x", "t", "{}"), false);
  } finally {
    process.stderr.write = original;
  }
  assert.match(seen.join(""), /not stored.*not kept/);
});

test("a refusal whose body is not JSON is still reported with its status", async () => {
  const server = http.createServer((_q, res) => (res.writeHead(502), res.end("<html>bad gateway</html>")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const seen = [];
  const original = process.stderr.write;
  process.stderr.write = (m) => (seen.push(String(m)), true);
  try {
    assert.equal(await postRecord(`http://127.0.0.1:${server.address().port}/x`, "t", "{}"), false);
  } finally {
    process.stderr.write = original;
    server.close();
  }
  assert.match(seen.join(""), /HTTP 502 \(the record is not kept\)/);
});

test("a failed dispatched post says the record is not kept", async () => {
  const { r } = await dispatched(400, { error: "no" });
  assert.match(r.stderr, /not kept/);
});

test("with the URL unset and a token set the marker path is kept and one line says why", async () => {
  const { dir } = repo();
  const r = await runAsync(dir, ["--report", reportIn(), "--", ...writer(vitestReport())], { DANX_AGENT_TOKEN: "tok", DANXBOT_TEST_RECORD_URL: undefined });
  assert.match(r.stdout, MARK);
  assert.match(r.stderr, /only DANX_AGENT_TOKEN is set/);
});

// ---- the dispatched-agent branch: the wrapper posts the record itself
async function stub(status, reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: data });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}/api/worker/test-run`, close: () => server.close() };
}
const runAsync = (dir, args, env) =>
  new Promise((resolve) => {
    const child = spawn("node", [SCRIPT, ...args], { cwd: dir, env: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined)) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
const dispatched = async (status, reply, command = writer(vitestReport())) => {
  const s = await stub(status, reply);
  const { dir } = repo();
  const r = await runAsync(dir, ["--report", reportIn(), "--", ...command], { DANX_AGENT_TOKEN: "tok", DANXBOT_TEST_RECORD_URL: s.url });
  s.close();
  return { r, seen: s.seen };
};

test("a dispatched agent's wrapper posts exactly the record with the bearer token and prints no marker", async () => {
  const { r, seen } = await dispatched(201, { note_id: 7 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, MARK);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/api/worker/test-run");
  assert.equal(seen[0].auth, "Bearer tok");
  assert.equal(seen[0].type, "application/json");
  const body = JSON.parse(seen[0].body);
  assert.deepEqual(Object.keys(body).sort(), ["card", "metadata", "text"]);
  assert.equal(body.card, "XX-1");
  assert.equal(body.metadata.kind, "test_run");
});

test("a refused post (400 with an error) is said on stderr and the run's exit code is unchanged", async () => {
  const { r } = await dispatched(400, { error: "bad metadata" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /HTTP 400 bad metadata/);
});

test("a 403 is said on stderr and the run's exit code is unchanged", async () => {
  const { r, seen } = await dispatched(403, { error: "forbidden" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /HTTP 403 forbidden/);
  assert.equal(seen.length, 1);
});

test("a failing test run posts nothing even in a dispatch", async () => {
  const { r, seen } = await dispatched(201, { note_id: 1 }, ["node", "-e", "process.exit(4)"]);
  assert.equal(r.status, 4);
  assert.equal(seen.length, 0);
});

test("with the token unset the marker path is kept, nothing is posted and one line says why", async () => {
  const s = await stub(201, { note_id: 1 });
  const { dir } = repo();
  const r = await runAsync(dir, ["--report", reportIn(), "--", ...writer(vitestReport())], { DANXBOT_TEST_RECORD_URL: s.url, DANX_AGENT_TOKEN: undefined });
  s.close();
  assert.match(r.stdout, MARK);
  assert.match(r.stderr, /only DANXBOT_TEST_RECORD_URL is set/);
  assert.equal(s.seen.length, 0);
});

test("the rewritten command, run through sh, reaches the script its argument names (path with an apostrophe and a space)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "it's rec "));
  try {
    const stubScript = path.join(dir, "stub.mjs");
    writeFileSync(stubScript, "console.log('stub ran with ' + process.argv.slice(2).join(','))\n");
    const run = (raw) => {
      const command = withRecorderVar(raw, stubScript, false);
      assert.match(command, /^export DANXBOT_TEST_RECORDER=/);
      return spawnSync("sh", ["-c", command], { encoding: "utf8" }).stdout.trim();
    };
    assert.equal(run('node "$DANXBOT_TEST_RECORDER" a b'), "stub ran with a,b");
    assert.equal(run('node "${DANXBOT_TEST_RECORDER:?DANXBOT_TEST_RECORDER is not set}" a b'), "stub ran with a,b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CP-57 defects found by the first live trial (DX-6681 note 42021)
const NODE_JUNIT = readFileSync(fileURLToPath(new URL("./fixtures/node-junit-report.xml", import.meta.url)), "utf8");

test("a real node junit report is counted by its test cases: nested suites, top-level cases, a failure and a skip", () => {
  // fixture source: tests/fixtures/node-junit-report.source.txt, run with `node --test --test-reporter=junit`; node's own totals: tests 6, pass 4, fail 1, skipped 1
  // the top-level suite there says tests="2": reading suite attributes (the old way) gave 2, not 6
  assert.deepEqual(parseJunitReport(NODE_JUNIT), { tests: { passed: 4, failed: 1, skipped: 1, total: 6 }, test_files: null, files: null });
});

test("a passing node junit report keeps its full count, not the first suite's", () => {
  const passing = NODE_JUNIT.replace(/<failure[\s\S]*?<\/failure>/, "").replace(' failure="x"', "");
  assert.deepEqual(parseJunitReport(passing).tests, { passed: 5, failed: 0, skipped: 1, total: 6 });
});

test("a junit error element counts as a failed test", () => {
  assert.equal(parseJunitReport('<testsuite><testcase name="a"><error message="boom"/></testcase><testcase name="b"/></testsuite>').tests.failed, 1);
});

const BASH = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).status === 0;
// the suite fails (exit 1) behind a `| tail` pipe; its report is a clean pass, so only the exit status can tell
const pipedFailure = (tail) => ["bash", "-c", `node -e "require('fs').writeFileSync(process.env.DANXBOT_TEST_REPORT, process.argv[1]); process.exit(1)" '${vitestReport()}' ${tail}`];

test("a suite that fails behind a `| tail` pipe in a bash -c wrapper is not recorded, and the command's exit status is the failure", { skip: !BASH }, () => {
  const { dir } = repo();
  const r = run(dir, ["--report", reportIn(), "--", ...pipedFailure("| tail -3")]);
  assert.equal(r.status, 1, "pipefail: the wrapper's status is the failing stage's, not tail's");
  assert.doesNotMatch(r.stdout, MARK);
  assert.match(r.stderr, /exited 1/);
});

test("a passing bash -c wrapper with a pipe still records a passing run", { skip: !BASH }, () => {
  const { dir } = repo();
  const r = run(dir, ["--report", reportIn(), "--", "bash", "-c", `node -e "require('fs').writeFileSync(process.env.DANXBOT_TEST_REPORT, process.argv[1])" '${vitestReport()}' | tail -3`]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, MARK);
});

test("withPipefail rewrites bash/zsh with -c or a short-flag group ending in c, and nothing else", () => {
  assert.deepEqual(withPipefail(["bash", "-c", "x"]), ["bash", "-o", "pipefail", "-c", "x"]);
  assert.deepEqual(withPipefail(["bash", "-lc", "x"]), ["bash", "-o", "pipefail", "-lc", "x"]);
  assert.deepEqual(withPipefail(["bash", "-ec", "x"]), ["bash", "-o", "pipefail", "-ec", "x"]);
  assert.deepEqual(withPipefail(["zsh", "-c", "x"]), ["zsh", "-o", "pipefail", "-c", "x"]);
  assert.deepEqual(withPipefail([["C:", "Program Files", "Git", "bin", "bash.exe"].join(String.fromCharCode(92)), "-c", "x"]).slice(1, 3), ["-o", "pipefail"]);
  for (const argv of [["sh", "-c", "x"], ["sh", "-lc", "x"], ["bash", "script.sh"], ["bash", "-x", "x"], ["bash"], ["node", "-e", "0"]]) assert.deepEqual(withPipefail(argv), argv);
});

test("a recorded bash -c command is the argv as given, without the pipefail option", { skip: !BASH }, () => {
  const { dir } = repo();
  assert.match(recordOf(run(dir, ["--report", reportIn(), "--", "bash", "-c", `node -e "require('fs').writeFileSync(process.env.DANXBOT_TEST_REPORT, process.argv[1])" '${vitestReport()}'`])).metadata.command, /^bash -c /);
});

test("a bash -lc wrapper gets pipefail too: a failing suite behind a pipe is not recorded", { skip: !BASH }, () => {
  const { dir } = repo();
  const [, , cmd] = pipedFailure("| tail -3");
  const r = run(dir, ["--report", reportIn(), "--", "bash", "-lc", cmd]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, MARK);
});

test("a suite-level error or failure beside passing cases counts as failed, never a pass", () => {
  const xml = '<testsuites><testsuite name="s" tests="2" failures="0" errors="1"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>';
  assert.deepEqual(parseJunitReport(xml).tests, { passed: 2, failed: 1, skipped: 0, total: 3 });
  assert.match(decide({ parsed: parseJunitReport(xml) }).reason, /failure/);
  assert.equal(parseJunitReport(xml.replace('failures="0" errors="1"', 'failures="9" errors="0"')).tests.failed, 9, "every declared failure counts");
});

// ---- fix pass 3: three more ways a failing run was stored as a pass
test("a suite-level error beside only skipped cases is still a failure", () => {
  const xml = '<testsuite tests="2" failures="0" errors="1" skipped="2"><testcase name="a"><skipped/></testcase><testcase name="b"><skipped/></testcase></testsuite>';
  const parsed = parseJunitReport(xml);
  assert.equal(parsed.tests.failed, 1);
  assert.equal(parsed.tests.total, parsed.tests.passed + parsed.tests.failed + parsed.tests.skipped);
  assert.match(decide({ parsed }).reason, /failure/);
});

test("a failures or errors attribute on the root testsuites element counts when no child suite shows it", () => {
  const xml = '<testsuites failures="0" errors="2"><testsuite tests="2"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>';
  const parsed = parseJunitReport(xml);
  assert.equal(parsed.tests.failed, 2);
  assert.equal(parsed.tests.total, parsed.tests.passed + parsed.tests.failed + parsed.tests.skipped);
  assert.match(decide({ parsed }).reason, /failure/);
});

test("a failure the cases and the suite both show is counted once", () => {
  const xml = '<testsuites failures="1"><testsuite tests="2" failures="1"><testcase name="a"><failure/></testcase><testcase name="b"/></testsuite></testsuites>';
  assert.deepEqual(parseJunitReport(xml).tests, { passed: 1, failed: 1, skipped: 0, total: 2 });
});

test("withPipefail finds -c wherever it sits among the leading options of bash and zsh, and leaves sh alone", () => {
  for (const argv of [["bash", "-l", "-c", "x"], ["bash", "-o", "errexit", "-c", "x"], ["bash", "-ce", "x"], ["zsh", "-i", "-lc", "x"], ["bash", "--norc", "-c", "x"]]) {
    assert.deepEqual(withPipefail(argv), [argv[0], "-o", "pipefail", ...argv.slice(1)], argv.join(" "));
  }
  for (const argv of [["sh", "-l", "-c", "x"], ["bash", "script.sh", "-c"], ["bash", "-o", "errexit", "x"], ["bash", "-x"]]) assert.deepEqual(withPipefail(argv), argv, argv.join(" "));
});

test("a failing suite behind a pipe under bash -l -c is not recorded", { skip: !BASH }, () => {
  const { dir } = repo();
  const [, , cmd] = pipedFailure("| tail -3");
  const r = run(dir, ["--report", reportIn(), "--", "bash", "-l", "-c", cmd]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, MARK);
});

// ---- fix pass 4: single-quoted attributes and long options with an argument
test("suite and root attributes in single quotes, or with a > inside a value, still count", () => {
  const cases = '<testcase name="a"/><testcase name="b"/>';
  for (const xml of [
    `<testsuite errors='1'>${cases}</testsuite>`,
    `<testsuite name="a > b" errors="1">${cases}</testsuite>`,
    `<testsuites failures='2'><testsuite>${cases}</testsuite></testsuites>`,
    `<testsuite name='x errors="0"' errors='1'>${cases}</testsuite>`,
  ]) {
    const parsed = parseJunitReport(xml);
    assert.ok(parsed.tests.failed >= 1, xml);
    assert.match(decide({ parsed }).reason, /failure/, xml);
  }
  assert.equal(parseJunitReport(`<testsuite tests='2' failures='1'>${cases}</testsuite>`).tests.failed, 1);
  assert.deepEqual(parseJunitReport("<testsuite tests='3' failures='0' errors='0' skipped='1'/>").tests, { passed: 2, failed: 0, skipped: 1, total: 3 });
});

test("withPipefail skips the argument of --rcfile and --init-file, and stops at --", () => {
  for (const argv of [["bash", "--rcfile", "f", "-c", "x"], ["bash", "--init-file", "f", "-c", "x"], ["bash", "--norc", "--rcfile", "f", "-lc", "x"]]) {
    assert.deepEqual(withPipefail(argv), [argv[0], "-o", "pipefail", ...argv.slice(1)], argv.join(" "));
  }
  for (const argv of [["bash", "--", "-c"], ["bash", "--", "-c", "x"], ["bash", "--rcfile", "-c", "x"]]) assert.deepEqual(withPipefail(argv), argv, argv.join(" "));
});
