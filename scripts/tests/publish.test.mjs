// scripts/publish.sh integrity-manifest handling - DX-4244: a publish over an edited
// hashed file must not print the integrity launcher's INTEGRITY FAILURE (whose printed
// fix is a `git checkout` of the very edit being published), and must leave a committed
// manifest that matches the published tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, env: { ...process.env, ...GIT_IDENTITY }, encoding: "utf8" });
}

/** A throwaway clone carrying this tree's publish.sh, with `skills/issue-workflow/SKILL.md` edited. */
function editedClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-test-"));
  git(REPO_ROOT, "clone", "-q", "--no-hardlinks", REPO_ROOT, dir);
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "publish.sh"), path.join(dir, "scripts", "publish.sh"));
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "check-general-audience.mjs"), path.join(dir, "scripts", "check-general-audience.mjs"));
  git(dir, "commit", "-q", "--allow-empty", "-am", "carry publish.sh");
  fs.appendFileSync(path.join(dir, "danxbot", "skills", "issue-workflow", "SKILL.md"), "\n<!-- publish test edit -->\n");
  return dir;
}

/**
 * DX-4232: a stand-in `claude` CLI on PATH. publish.sh runs `claude plugin validate <plugin>` and
 * `claude plugin test <plugin>` for a plugin that declares hooks modules; this one appends its
 * arguments to `calls.log` and exits 1 for the subcommand named in STANDIN_FAIL, else 0.
 */
function standInClaude() {
  // outside the clone: a file inside it would count as a change outside the target plugin
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "standin-claude-"));
  fs.writeFileSync(
    path.join(bin, "claude"),
    '#!/usr/bin/env bash\necho "$*" >> "$(dirname "$0")/calls.log"\n[ "$2" = "$STANDIN_FAIL" ] && exit 1\nexit 0\n',
    { mode: 0o755 },
  );
  const log = path.join(bin, "calls.log");
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

/** publish.sh patch danxbot; DANX_AGENT_WORKTREE commits the bump but skips the push and this machine's plugin delivery. */
function publish(dir, { fail = "", claudeBin } = {}) {
  const standIn = standInClaude();
  // the caller's own CLAUDE_BIN (set to run validate for real) must not replace the stand-in
  const { CLAUDE_BIN: _callers, ...inherited } = process.env;
  const r = spawnSync("bash", [path.join(dir, "scripts", "publish.sh"), "patch", "danxbot"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...inherited,
      ...GIT_IDENTITY,
      DANX_AGENT_WORKTREE: dir,
      NODE_PATH: path.join(REPO_ROOT, "node_modules"),
      PATH: `${standIn.bin}${path.delimiter}${process.env.PATH}`,
      STANDIN_FAIL: fail,
      ...(claudeBin ? { CLAUDE_BIN: claudeBin } : {}),
    },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, claudeCalls: standIn.calls() };
}

test("DX-4244: publish over an edited skill file prints no INTEGRITY FAILURE", () => {
  const dir = editedClone();
  try {
    const r = publish(dir);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /INTEGRITY FAILURE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DX-4244: the manifest a publish commits matches the published tree (the post-bump rewrite still runs)", () => {
  const dir = editedClone();
  try {
    const r = publish(dir);
    assert.equal(r.status, 0, r.out);
    execFileSync("node", [path.join(dir, "scripts", "write-integrity-manifest.mjs"), "danxbot"], { cwd: dir });
    assert.equal(git(dir, "status", "--porcelain", "--", "danxbot").trim(), "", "regenerating the manifest changed the committed tree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DX-4244: a marketplace plugin with no scripts/launch.mjs gets no manifest written", () => {
  const dir = editedClone();
  try {
    fs.mkdirSync(path.join(dir, "plain", ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plain", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plain", version: "1.0.0", description: "no launcher" }) + "\n");
    const mpPath = path.join(dir, ".claude-plugin", "marketplace.json");
    const mp = JSON.parse(fs.readFileSync(mpPath, "utf8"));
    mp.plugins.push({ name: "plain", source: "./plain", description: "no launcher" });
    fs.writeFileSync(mpPath, JSON.stringify(mp, null, 2) + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add a plugin with no launcher");
    fs.appendFileSync(path.join(dir, "danxbot", "skills", "issue-workflow", "SKILL.md"), "\n<!-- second edit -->\n");
    const r = publish(dir);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(path.join(dir, "plain", "integrity-manifest.json")), false);
    assert.equal(fs.existsSync(path.join(dir, "danxbot", "integrity-manifest.json")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DX-4244: the pre-flight regenerates every marketplace plugin's manifest, so a stale untargeted one is refused loudly, not published over", () => {
  const dir = editedClone();
  try {
    // check-injection-budget.mjs runs EVERY marketplace plugin's hooks, so a stale manifest in a plugin that is
    // not a publish target would still print a false INTEGRITY FAILURE. The pre-flight rewrites it first, which
    // dirties a non-target plugin, and publish refuses on that instead of shipping over it.
    fs.mkdirSync(path.join(dir, "second", ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(dir, "second", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "second", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "second", version: "1.0.0", description: "has a launcher" }) + "\n");
    fs.writeFileSync(path.join(dir, "second", "scripts", "launch.mjs"), "// stub launcher\n");
    fs.writeFileSync(path.join(dir, "second", "integrity-manifest.json"), JSON.stringify({ schemaVersion: 1, files: {} }) + "\n");
    const mpPath = path.join(dir, ".claude-plugin", "marketplace.json");
    const mp = JSON.parse(fs.readFileSync(mpPath, "utf8"));
    mp.plugins.push({ name: "second", source: "./second", description: "has a launcher" });
    fs.writeFileSync(mpPath, JSON.stringify(mp, null, 2) + "\n");
    git(dir, "add", "second", ".claude-plugin");
    git(dir, "commit", "-q", "-m", "add a launcher plugin with a stale manifest");
    const r = publish(dir);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /changes outside target plugins \(second\/integrity-manifest\.json\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// DX-4288: the push. A bare origin plus a clone on a branch with NO upstream (what an agent's worktree
// is), run with no DANX_AGENT_WORKTREE and no git config, so the real push path executes.
function pushHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-push-"));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, "work");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  git(REPO_ROOT, "clone", "-q", "--bare", "--no-hardlinks", REPO_ROOT, origin);
  git(origin, "update-ref", "refs/heads/main", "HEAD");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const ref of git(origin, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(Boolean)) {
    if (ref !== "refs/heads/main") git(origin, "update-ref", "-d", ref);
  }
  git(root, "clone", "-q", origin, dir);
  git(dir, "checkout", "-q", "--no-track", "-b", "agent-branch", "origin/main");
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "publish.sh"), path.join(dir, "scripts", "publish.sh"));
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "check-general-audience.mjs"), path.join(dir, "scripts", "check-general-audience.mjs"));
  // The post-push steps rewrite THIS machine's installed-plugin records; the harness has no use for them.
  fs.rmSync(path.join(dir, "scripts", "update-plugins.sh"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "carry publish.sh");
  fs.appendFileSync(path.join(dir, "danxbot", "skills", "issue-workflow", "SKILL.md"), "\n<!-- publish test edit -->\n");
  return { root, origin, dir, home };
}

function publishPushing({ dir, home }, extraEnv = {}) {
  const standIn = standInClaude();
  const { CLAUDE_BIN: _callers, ...inherited } = process.env;
  const env = {
    ...inherited,
    ...GIT_IDENTITY,
    HOME: home,
    USERPROFILE: home,
    NODE_PATH: path.join(REPO_ROOT, "node_modules"),
    PATH: `${standIn.bin}${path.delimiter}${process.env.PATH}`,
  };
  delete env.DANX_AGENT_WORKTREE;
  Object.assign(env, extraEnv);
  const r = spawnSync("bash", [path.join(dir, "scripts", "publish.sh"), "patch", "danxbot"], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const pluginVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "danxbot", ".claude-plugin", "plugin.json"), "utf8")).version;
const originMain = (h) => git(h.origin, "rev-parse", "refs/heads/main").trim();
const originBranches = (h) => git(h.origin, "for-each-ref", "--format=%(refname)", "refs/heads").trim();

test("DX-4288: a branch with no upstream publishes the bump to origin/main, and pushes no branch of its own", () => {
  const h = pushHarness();
  try {
    const before = pluginVersion(h.dir);
    const r = publishPushing(h);
    assert.equal(r.status, 0, r.out);
    assert.equal(originMain(h), git(h.dir, "rev-parse", "HEAD").trim());
    assert.notEqual(pluginVersion(h.dir), before);
    assert.equal(originBranches(h), "refs/heads/main");
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("DX-4288: commits the branch is ahead of origin/main ride along with the bump", () => {
  const h = pushHarness();
  try {
    git(h.dir, "add", "-A");
    git(h.dir, "commit", "-q", "-m", "branch work ahead of main");
    const work = git(h.dir, "rev-parse", "HEAD").trim();
    const r = publishPushing(h);
    assert.equal(r.status, 0, r.out);
    git(h.origin, "merge-base", "--is-ancestor", work, "refs/heads/main");
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("DX-4288: on a branch named main, the publish still lands on origin/main", () => {
  const h = pushHarness();
  try {
    git(h.dir, "checkout", "-q", "-B", "main");
    git(h.dir, "branch", "-q", "--set-upstream-to=origin/main", "main");
    const r = publishPushing(h);
    assert.equal(r.status, 0, r.out);
    assert.equal(originMain(h), git(h.dir, "rev-parse", "HEAD").trim());
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

function advanceOrigin(h) {
  const other = path.join(h.root, "other");
  git(h.root, "clone", "-q", h.origin, other);
  fs.writeFileSync(path.join(other, "ADVANCED.txt"), "origin moved\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "origin/main moves on");
  git(other, "push", "-q", "origin", "HEAD:main");
}

test("DX-4288: a diverged HEAD is refused before any bump, and nothing is pushed", () => {
  const h = pushHarness();
  try {
    git(h.dir, "add", "-A");
    git(h.dir, "commit", "-q", "-m", "local work");
    advanceOrigin(h);
    const originBefore = originMain(h);
    const headBefore = git(h.dir, "rev-parse", "HEAD").trim();
    const versionBefore = pluginVersion(h.dir);
    const r = publishPushing(h);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /not a fast-forward of origin\/main/);
    assert.equal(originMain(h), originBefore);
    assert.equal(git(h.dir, "rev-parse", "HEAD").trim(), headBefore, "a commit was made despite the refusal");
    assert.equal(pluginVersion(h.dir), versionBefore);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("DX-4288: a HEAD strictly behind origin/main is refused and nothing is pushed or bumped", () => {
  const h = pushHarness();
  try {
    const base = originMain(h);
    advanceOrigin(h);
    git(h.dir, "fetch", "-q", "origin");
    git(h.dir, "checkout", "-q", "--no-track", "-B", "agent-branch", base);
    git(h.dir, "merge-base", "--is-ancestor", "HEAD", originMain(h));
    assert.notEqual(git(h.dir, "rev-parse", "HEAD").trim(), originMain(h));
    const originBefore = originMain(h);
    const headBefore = git(h.dir, "rev-parse", "HEAD").trim();
    const versionBefore = pluginVersion(h.dir);
    fs.appendFileSync(path.join(h.dir, "danxbot", "skills", "issue-workflow", "SKILL.md"), "\n<!-- DX-4288 behind edit -->\n");
    const r = publishPushing(h);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /not a fast-forward of origin\/main/);
    assert.equal(originMain(h), originBefore);
    assert.equal(git(h.dir, "rev-parse", "HEAD").trim(), headBefore);
    assert.equal(pluginVersion(h.dir), versionBefore);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("DX-4288: an unreachable origin fails loud before any bump", () => {
  const h = pushHarness();
  try {
    git(h.dir, "remote", "set-url", "origin", path.join(h.root, "does-not-exist.git"));
    const headBefore = git(h.dir, "rev-parse", "HEAD").trim();
    const r = publishPushing(h);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /Could not fetch origin\/main/);
    assert.equal(git(h.dir, "rev-parse", "HEAD").trim(), headBefore);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("DX-4288: under DANX_AGENT_WORKTREE the bump is committed and never pushed, even from a diverged HEAD", () => {
  const h = pushHarness();
  try {
    git(h.dir, "add", "-A");
    git(h.dir, "commit", "-q", "-m", "local work");
    advanceOrigin(h);
    const originBefore = originMain(h);
    const before = pluginVersion(h.dir);
    const r = publishPushing(h, { DANX_AGENT_WORKTREE: h.dir });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NOT pushing/);
    assert.notEqual(pluginVersion(h.dir), before);
    assert.equal(originMain(h), originBefore);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

// DX-4232: publish.sh validates and tests a plugin's hooks modules before it bumps anything.
function snapshot(dir) {
  return {
    head: git(dir, "rev-parse", "HEAD").trim(),
    pluginJson: fs.readFileSync(path.join(dir, "danxbot", ".claude-plugin", "plugin.json"), "utf8"),
    integrity: fs.readFileSync(path.join(dir, "danxbot", "integrity-manifest.json"), "utf8"),
  };
}

function assertUntouched(dir, before) {
  assert.deepEqual(snapshot(dir), before, "a commit was made, the version bumped or the integrity manifest rewritten");
}

test("DX-4232: validate and test both pass: they run in that order, before the bump, and the publish goes through", () => {
  const dir = editedClone();
  try {
    const before = snapshot(dir);
    const r = publish(dir);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.claudeCalls, ["plugin validate danxbot", "plugin test danxbot"]);
    assert.notEqual(git(dir, "rev-parse", "HEAD").trim(), before.head);
    assert.match(git(dir, "log", "-1", "--format=%s").trim(), /^danxbot v\d+\.\d+\.\d+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const failing of ["validate", "test"]) {
  test(`DX-4232: claude plugin ${failing} failing refuses the publish: no commit, no bump, no manifest rewrite`, () => {
    const dir = editedClone();
    try {
      const before = snapshot(dir);
      const r = publish(dir, { fail: failing });
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out, new RegExp(`claude plugin ${failing} danxbot failed`));
      assert.match(r.out, /Nothing was bumped or pushed/);
      assertUntouched(dir, before);
      // validate runs first: when it fails, test never runs
      assert.deepEqual(r.claudeCalls, failing === "validate" ? ["plugin validate danxbot"] : ["plugin validate danxbot", "plugin test danxbot"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("DX-4232: a missing claude CLI refuses the publish and names CLAUDE_BIN", () => {
  const dir = editedClone();
  try {
    const before = snapshot(dir);
    const r = publish(dir, { claudeBin: path.join(dir, "no-such-claude") });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /CLAUDE_BIN/);
    assertUntouched(dir, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DX-4232: the manifest a publish commits lists hooks/register.tsx and every hooks/ and types/ file, so launch.mjs reports none of them damaged", () => {
  const dir = editedClone();
  try {
    const r = publish(dir);
    assert.equal(r.status, 0, r.out);
    const listed = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "danxbot", "integrity-manifest.json"), "utf8")).files);
    assert.ok(listed.includes("hooks/register.tsx"));
    const onDisk = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, "danxbot", rel), { withFileTypes: true })) {
        const next = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(next);
        else onDisk.push(next);
      }
    };
    walk("hooks");
    walk("types");
    assert.ok(onDisk.length > 4, "the module's files are in the clone");
    for (const file of onDisk) assert.ok(listed.includes(file), `${file} is missing from the manifest`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
