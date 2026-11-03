// The pure half of the test-run recorder: a runner's own report in, the dashboard's `test_run` agent-note metadata out.
// The dashboard refuses a malformed record but cannot tell a false one from a true one, so the rules it cannot check live here: counts come from the runner's report file,
// never from console text; a report with no per-test counts records nothing; a failure anywhere records nothing.

export const MAX_RECORDED_FILES = 100;
/** The marker line the wrapper prints; the plugin's tool hook posts the record file the line names. */
export const RECORD_MARKER = "DANXBOT_TEST_RUN_RECORD";

const FULL_SHA = /^[0-9a-f]{40}$/;
const counts = (passed, failed, skipped, total) => ({ passed, failed, skipped, total });
const whole = (v) => Number.isInteger(v) && v >= 0;

/** Counts from a vitest / jest JSON report (`--reporter=json`). Null when the text is not such a report. */
export function parseJsonReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(report?.testResults) || !["numTotalTests", "numPassedTests", "numFailedTests"].every((k) => whole(report[k]))) return null;
  const skipped = (whole(report.numPendingTests) ? report.numPendingTests : 0) + (whole(report.numTodoTests) ? report.numTodoTests : 0);
  const results = report.testResults;
  const fileFailed = results.filter((f) => f.status === "failed").length;
  const filePassed = results.filter((f) => f.status === "passed").length;
  return {
    tests: counts(report.numPassedTests, report.numFailedTests, skipped, report.numTotalTests),
    test_files: counts(filePassed, fileFailed, results.length - filePassed - fileFailed, results.length),
    files: results.map((f) => f.name).filter((name) => typeof name === "string" && name !== ""),
  };
}

// One start tag of an element, whichever quote its attribute values use (a value may hold a `>`), and a tag's attributes read the same way
const tagOf = (name) => new RegExp(`<${name}\\b(?:"[^"]*"|'[^']*'|[^>"'])*>`, "g");
const attr = (tag, name) => {
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (m[1] === name) return /^\d+$/.test(m[2] ?? m[3]) ? Number(m[2] ?? m[3]) : undefined;
  }
  return undefined;
};

/**
 * Counts from a JUnit XML report (node --test, PHPUnit, pytest, Maven and others). No per-file data is assumed: `test_files` and `files` are null.
 * The `testcase` elements are the tests: node's reporter nests `testsuite` elements, puts a suite's `tests` attribute on direct children only, and writes
 * top-level cases outside any suite, so no suite attribute (nor the root's, which node omits) is a total. A report with no `testcase` falls back to the
 * suites' own attributes (the top-level ones; a suite nested in another is already in its parent's counts).
 */
export function parseJunitReport(text) {
  const cases = [...text.matchAll(/<testcase\b(?:"[^"]*"|'[^']*'|[^>"'])*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
  if (cases.length > 0) {
    let failed = 0;
    let skipped = 0;
    for (const c of cases) {
      const body = c[1] ?? "";
      if (/<(?:failure|error)\b/.test(body)) failed += 1;
      else if (/<skipped\b/.test(body)) skipped += 1;
    }
    // failures/errors a suite (or the root) declares beyond what the cases show are still failures: each counts as an extra failed test, so no cap can hide one
    const declared = (re) => [...text.matchAll(re)].reduce((n, t) => n + (attr(t[0], "failures") ?? 0) + (attr(t[0], "errors") ?? 0), 0);
    const excess = Math.max(0, declared(tagOf("testsuite")), declared(tagOf("testsuites"))) - failed;
    if (excess > 0) failed += excess;
    const total = cases.length + Math.max(0, excess);
    return { tests: counts(total - failed - skipped, failed, skipped, total), test_files: null, files: null };
  }
  const root = tagOf("testsuites").exec(text);
  let tags;
  if (root !== null && attr(root[0], "tests") !== undefined) tags = [root[0]];
  else {
    tags = [];
    let end = -1;
    for (const s of text.matchAll(tagOf("testsuite"))) {
      if (s.index < end) continue;
      tags.push(s[0]);
      end = s[0].endsWith("/>") ? s.index + s[0].length : text.indexOf("</testsuite>", s.index);
      if (end === -1) end = text.length;
    }
  }
  if (tags.length === 0 || tags.some((t) => attr(t, "tests") === undefined)) return null;
  let total = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of tags) {
    total += attr(t, "tests");
    failed += (attr(t, "failures") ?? 0) + (attr(t, "errors") ?? 0);
    skipped += attr(t, "skipped") ?? 0;
  }
  return { tests: counts(total - failed - skipped, failed, skipped, total), test_files: null, files: null };
}

/** Parse a report by its format ("vitest-json" | "junit"); null when it gives no per-test counts. */
export function parseReport(format, text) {
  if (format === "vitest-json") return parseJsonReport(text);
  if (format === "junit") return parseJunitReport(text);
  throw new Error(`unknown report format ${JSON.stringify(format)}: use vitest-json or junit`);
}

/**
 * The note body for a finished run, or `{ reason }` when nothing may be recorded. `before` and `after` are `{ head, tree, dirty }` read around the run.
 * Records only an exit-0 run with no failure on a tree that was clean at the start, still clean at the end and on the same commit and tree.
 */
export function decideRecord({ exitCode, parsed, before, after, command, machine }) {
  if (exitCode !== 0) return { reason: `the command exited ${exitCode}` };
  if (parsed === null) return { reason: "the runner's report gives no per-test counts" };
  if (parsed.tests.failed !== 0 || (parsed.test_files !== null && parsed.test_files.failed !== 0)) return { reason: "the report shows a failure" };
  if (parsed.tests.total === 0) return { reason: "the report shows no tests ran" };
  if (parsed.tests.passed + parsed.tests.skipped > parsed.tests.total) return { reason: "the report's counts contradict each other" };
  if (before.dirty) return { reason: "the working tree was not clean when the run started" };
  if (after.dirty) return { reason: "the working tree is not clean after the run" };
  if (before.head !== after.head || before.tree !== after.tree) return { reason: "HEAD moved during the run" };
  if (![before.head, before.tree].every((sha) => FULL_SHA.test(sha))) return { reason: "HEAD is not a full commit sha" };
  // the file list only when it is exactly the files counted (the server refuses any other pairing)
  const listed = parsed.test_files !== null && parsed.files !== null && parsed.files.length === parsed.test_files.total && parsed.files.length <= MAX_RECORDED_FILES;
  const text = `Tests passed on commit ${before.head}: \`${command}\` ran ${parsed.tests.total} tests${parsed.test_files ? ` in ${parsed.test_files.total} files` : ""} on a clean tree (${parsed.tests.passed} passed, 0 failed, ${parsed.tests.skipped} skipped). A gate reviewer reads this instead of running the same tests again.`;
  return {
    text,
    metadata: {
      kind: "test_run",
      commit_sha: before.head,
      tree_id: before.tree,
      command,
      machine,
      tests: parsed.tests,
      test_files: parsed.test_files,
      files: listed ? parsed.files : null,
    },
  };
}
