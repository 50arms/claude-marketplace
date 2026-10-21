import "../../danxbot/tests/designated-test-container.mjs";
// DX-5648: the repo's tests run only in the designated test container. This pins the guard's decision, that every node test file carries the
// guard, and that the image writes the marker the guard reads and the entry runs the suites the package script names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_CONTAINER_COMMAND, TEST_ENVIRONMENT_MARKER, designatedTestContainerRefusal, readTestHost } from "../../danxbot/tests/designated-test-container.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("DX-5648: a root-owned marker on Linux admits the host", () => {
  assert.equal(designatedTestContainerRefusal({ platform: "linux", markerOwnerUid: 0 }), null);
});

for (const [name, host] of [
  ["Windows, no marker", { platform: "win32", markerOwnerUid: null }],
  ["Linux without the marker (a bare WSL shell)", { platform: "linux", markerOwnerUid: null }],
  ["Linux with a marker a non-root user created", { platform: "linux", markerOwnerUid: 1000 }],
  ["macOS, no marker", { platform: "darwin", markerOwnerUid: null }],
]) {
  test(`DX-5648: ${name} is refused, naming the command`, () => {
    const refusal = designatedTestContainerRefusal(host);
    assert.ok(refusal, "no refusal");
    assert.ok(refusal.includes(TEST_CONTAINER_COMMAND), refusal);
  });
}

test("DX-5648: a test file run outside the container refuses before any test runs", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "guard-"));
  try {
    const file = path.join(dir, "probe.test.mjs");
    const guard = path.join(REPO_ROOT, "danxbot", "tests", "designated-test-container.mjs");
    // The marker path is a module constant, so a host without the marker is simulated by importing the guard through a stub that reads a path that is not there.
    const stub = path.join(dir, "guard-no-marker.mjs");
    fs.writeFileSync(
      stub,
      fs.readFileSync(guard, "utf8").replace(JSON.stringify(TEST_ENVIRONMENT_MARKER), JSON.stringify(path.join(dir, "no-such-marker"))),
    );
    fs.writeFileSync(file, `import ${JSON.stringify(stub)};\nimport { test } from "node:test";\ntest("ran", () => {});\n`);
    // NODE_TEST_CONTEXT would make the child report through this runner instead of exiting non-zero by itself.
    const { NODE_TEST_CONTEXT: _runner, ...env } = process.env;
    const r = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env });
    assert.notEqual(r.status, 0, "the file ran");
    assert.match(`${r.stdout}\n${r.stderr}`, /run only inside the designated Linux test container/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /# pass 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The plugins whose tests the entry script runs: those whose hooks.json declares modules (the same set scripts/test-container-entry.sh
 * loops over). Each one's tests live in <plugin>/tests, which must exist.
 */
function testPluginDirs() {
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  return marketplace.plugins
    .map((p) => p.source.replace(/^\.\//, ""))
    .filter((dir) => {
      const hooks = path.join(REPO_ROOT, dir, "hooks", "hooks.json");
      if (!fs.existsSync(hooks)) return false;
      const modules = JSON.parse(fs.readFileSync(hooks, "utf8")).modules;
      return Array.isArray(modules) && modules.length > 0;
    });
}

/** Every test file of the repo, both kinds: the node suites (*.test.mjs) and the plugin's function-hook tests (*.test.tsx). A missing directory throws. */
function testFiles(pattern) {
  const out = [];
  for (const dir of [...testPluginDirs().map((d) => `${d}/tests`), "scripts/tests"]) {
    for (const f of fs.readdirSync(path.join(REPO_ROOT, dir))) if (pattern.test(f)) out.push(`${dir}/${f}`);
  }
  return out;
}

test("DX-5648: the scanned plugin set is not empty", () => {
  assert.ok(testPluginDirs().length > 0, "no plugin declares hook modules");
});

test("DX-5648: every node test file imports the guard first", () => {
  const files = testFiles(/\.test\.mjs$/);
  assert.ok(files.length > 20, `only ${files.length} test files found`);
  const unguarded = files.filter((rel) => {
    const first = read(rel).split("\n")[0];
    return first !== 'import "./designated-test-container.mjs";' && first !== 'import "../../danxbot/tests/designated-test-container.mjs";';
  });
  assert.deepEqual(unguarded, [], "node test files whose first line is not the guard import");
});

// A .tsx test cannot check where it runs, so its guard is an import that only resolves in the container: the gitignored module the entry
// script writes after it checks the root-owned marker.
test("DX-5648: every plugin function-hook test imports the container-only module first, and it is never committed", () => {
  const files = testFiles(/\.test\.tsx$/);
  assert.ok(files.length > 20, `only ${files.length} test files found`);
  const unguarded = files.filter((rel) => read(rel).split("\n")[0] !== 'import "./run-tests-with-npm-test.generated"');
  assert.deepEqual(unguarded, [], "plugin test files whose first line is not the generated-module import");
  assert.match(read(".gitignore"), /^\*\.generated\.ts$/m, "the generated module must be gitignored so a host's copy never carries it");
  assert.match(read("scripts/test-container-entry.sh"), /run-tests-with-npm-test\.generated\.ts/);
});

test("DX-5648: readTestHost reads a missing marker as not-the-container but rethrows any other failure", () => {
  assert.equal(readTestHost(path.join(REPO_ROOT, "no-such-marker")).markerOwnerUid, null);
  // A marker path beneath a regular file fails with ENOTDIR: that must stop the run, not look like a missing marker.
  assert.throws(() => readTestHost(path.join(REPO_ROOT, "package.json", "marker")), { code: "ENOTDIR" });
});

test("DX-5648: the image writes the marker the guard reads, root-owned, and installs the pinned claude CLI", () => {
  const dockerfile = read("Dockerfile.test");
  assert.ok(dockerfile.includes(TEST_ENVIRONMENT_MARKER), "Dockerfile.test does not write the marker path");
  const markerLine = dockerfile.split("\n").findIndex((l) => l.includes(`> ${TEST_ENVIRONMENT_MARKER}`));
  const userLine = dockerfile.split("\n").findIndex((l) => /^USER node$/.test(l));
  assert.ok(markerLine >= 0 && userLine > markerLine, "the marker must be written before the image drops to the node user");
  assert.match(dockerfile, /npm install -g .*@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}/);
  assert.match(read(".claude-code-version"), /^\d+\.\d+\.\d+\n$/);
});

test("DX-5648: npm test is the container command, and the entry runs both suites", () => {
  assert.equal(JSON.parse(read("package.json")).scripts.test, "node scripts/test-in-container.mjs");
  const entry = read("scripts/test-container-entry.sh");
  assert.match(entry, /node --test "\$\{mjs\[@\]\}"/);
  assert.match(entry, /claude plugin test "\$plugin"/);
});
