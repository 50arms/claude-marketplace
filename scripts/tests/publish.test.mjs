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
  git(dir, "commit", "-q", "--allow-empty", "-am", "carry publish.sh");
  fs.appendFileSync(path.join(dir, "danxbot", "skills", "issue-workflow", "SKILL.md"), "\n<!-- DX-4244 test edit -->\n");
  return dir;
}

/** publish.sh patch danxbot; DANX_AGENT_WORKTREE commits the bump but skips the push and this machine's plugin delivery. */
function publish(dir) {
  const r = spawnSync("bash", [path.join(dir, "scripts", "publish.sh"), "patch", "danxbot"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...GIT_IDENTITY, DANX_AGENT_WORKTREE: dir, NODE_PATH: path.join(REPO_ROOT, "node_modules") },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
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
