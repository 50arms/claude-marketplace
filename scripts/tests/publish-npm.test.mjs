// scripts/publish-npm.sh - DX-4565: one version in plugin.json and package.json, a manifest that
// matches the bumped tree, and a package audit that refuses before anything is bumped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, env: { ...process.env, ...GIT_IDENTITY }, encoding: "utf8" });
const readJson = (dir, ...p) => JSON.parse(fs.readFileSync(path.join(dir, ...p), "utf8"));

/** A throwaway clone carrying this tree's publish-npm.sh and audit-package.mjs, with a shipped skill edited. */
function editedClone({ extra = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-npm-test-"));
  git(REPO_ROOT, "clone", "-q", "--no-hardlinks", REPO_ROOT, dir);
  for (const f of ["scripts/publish-npm.sh", "scripts/audit-package.mjs"]) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(dir, f));
  git(dir, "commit", "-q", "--allow-empty", "-am", "carry the publish scripts");
  fs.appendFileSync(path.join(dir, "danxbot", "skills", "issue-workflow", "SKILL.md"), `\n<!-- test edit ${extra} -->\n`);
  return dir;
}

/** A stand-in `claude` on PATH (validate and test are the CLI's own checks, covered elsewhere). */
function standInClaude() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "standin-claude-"));
  fs.writeFileSync(path.join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return bin;
}

function publishNpm(dir) {
  const bin = standInClaude();
  const { CLAUDE_BIN: _callers, ...inherited } = process.env;
  const r = spawnSync("bash", [path.join(dir, "scripts", "publish-npm.sh"), "patch"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...inherited, ...GIT_IDENTITY, DANX_AGENT_WORKTREE: dir, NODE_PATH: path.join(REPO_ROOT, "node_modules"), PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test("a release bumps plugin.json and package.json to the same next version and commits a matching manifest", () => {
  const dir = editedClone();
  try {
    const before = readJson(dir, "danxbot", ".claude-plugin", "plugin.json").version;
    const [maj, min, pat] = before.split(".").map(Number);
    const r = publishNpm(dir);
    assert.equal(r.status, 0, r.out);
    const next = `${maj}.${min}.${pat + 1}`;
    assert.equal(readJson(dir, "danxbot", ".claude-plugin", "plugin.json").version, next);
    assert.equal(readJson(dir, "danxbot", "package.json").version, next);
    assert.equal(git(dir, "log", "-1", "--format=%s").trim(), `danxbot v${next}`);
    execFileSync("node", [path.join(dir, "scripts", "write-integrity-manifest.mjs"), "danxbot"], { cwd: dir });
    assert.equal(git(dir, "status", "--porcelain", "--", "danxbot").trim(), "", "regenerating the manifest changed the committed tree");
    assert.match(r.out, /NOT publishing or pushing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an author-specific name in shipped text is refused by the general-audience scan before anything is bumped", () => {
  const dir = editedClone({ extra: "newms-plugins" });
  try {
    const before = readJson(dir, "danxbot", ".claude-plugin", "plugin.json").version;
    const r = publishNpm(dir);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /General-audience scan failed/);
    assert.equal(readJson(dir, "danxbot", ".claude-plugin", "plugin.json").version, before);
    assert.equal(readJson(dir, "danxbot", "package.json").version, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
