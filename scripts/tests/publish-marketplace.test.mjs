// DX-4565: scripts/publish-marketplace.sh copies a pushed commit of the plugin source repo into the public
// marketplace repo. Every case runs against throwaway repos: a fixture source repo with its own origin, a
// bare marketplace remote, and a stand-in `claude` CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, env: { ...process.env, ...IDENTITY }, encoding: "utf8" });
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const manifest = (dir) => execFileSync("node", [path.join(dir, "scripts", "write-integrity-manifest.mjs"), "danxbot"], { cwd: dir });

/** A source repo (committed, pushed to its own origin), an empty bare marketplace remote and a stand-in claude. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-marketplace-"));
  const origin = path.join(root, "origin.git");
  const remote = path.join(root, "marketplace.git");
  const src = path.join(root, "src");
  const bin = path.join(root, "bin");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  fs.mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  git(src, "remote", "add", "origin", origin);
  for (const f of ["publish-marketplace.sh", "write-integrity-manifest.mjs"]) {
    fs.mkdirSync(path.join(src, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", f), path.join(src, "scripts", f));
  }
  fs.cpSync(path.join(REPO_ROOT, "50arms-marketplace"), path.join(src, "50arms-marketplace"), { recursive: true });
  write(src, "danxbot/.claude-plugin/plugin.json", JSON.stringify({ name: "danxbot", version: "1.0.0" }));
  write(src, "danxbot/skills/x/SKILL.md", "skill\n");
  write(src, "danxbot/scripts/launch.mjs", "// launcher\n");
  write(src, "danxbot/tests/t.test.mjs", "// test\n");
  manifest(src);
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "init");
  git(src, "push", "-q", "origin", "main");
  // Records its arguments; exits 1 when STANDIN_FAIL is set.
  write(bin, "claude", '#!/usr/bin/env bash\necho "$*" >> "$(dirname "$0")/calls.log"\n[ -z "$STANDIN_FAIL" ] || exit 1\n');
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  return { root, src, remote, bin, calls: () => (fs.existsSync(path.join(bin, "calls.log")) ? fs.readFileSync(path.join(bin, "calls.log"), "utf8") : "") };
}

function publish(fx, extraEnv = {}) {
  const r = spawnSync("bash", [path.join(fx.src, "scripts", "publish-marketplace.sh")], {
    cwd: fx.src,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY, MARKETPLACE_REMOTE: fx.remote, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, CLAUDE_BIN: "", STANDIN_FAIL: "", ...extraEnv },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const remoteFiles = (fx) => git(fx.remote, "ls-tree", "-r", "--name-only", "main").trim().split("\n");
const remoteHead = (fx) => git(fx.remote, "rev-parse", "main").trim();
const commitAndPush = (fx, msg) => {
  git(fx.src, "add", "-A");
  git(fx.src, "commit", "-q", "-m", msg);
  git(fx.src, "push", "-q", "origin", "main");
};

test("DX-4565: the first publish seeds an empty marketplace with the catalog and the plugin, tests excluded", () => {
  const fx = fixture();
  try {
    const r = publish(fx);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(remoteFiles(fx), [
      ".claude-plugin/marketplace.json",
      ".gitattributes",
      "README.md",
      "danxbot/.claude-plugin/plugin.json",
      "danxbot/integrity-manifest.json",
      "danxbot/scripts/launch.mjs",
      "danxbot/skills/x/SKILL.md",
    ]);
    const catalog = JSON.parse(git(fx.remote, "show", "main:.claude-plugin/marketplace.json"));
    assert.equal(catalog.name, "50arms");
    assert.equal(catalog.plugins[0].source, "./danxbot");
    assert.equal(git(fx.remote, "log", "-1", "--format=%s", "main").trim(), "danxbot v1.0.0");
    assert.match(fx.calls(), /^plugin validate .+/m);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("DX-4565: a second publish of an unchanged tree makes no commit", () => {
  const fx = fixture();
  try {
    assert.equal(publish(fx).status, 0);
    const head = remoteHead(fx);
    const r = publish(fx);
    assert.equal(r.status, 0, r.out);
    assert.equal(remoteHead(fx), head);
    assert.match(r.out, /already holds danxbot v1\.0\.0/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("DX-4565: a file deleted from the plugin is deleted from the marketplace", () => {
  const fx = fixture();
  try {
    assert.equal(publish(fx).status, 0);
    git(fx.src, "rm", "-q", "danxbot/skills/x/SKILL.md");
    manifest(fx.src);
    commitAndPush(fx, "drop skill");
    assert.equal(publish(fx).status, 0);
    assert.ok(!remoteFiles(fx).includes("danxbot/skills/x/SKILL.md"));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("DX-4565: a stale integrity manifest refuses the publish and leaves the marketplace untouched", () => {
  const fx = fixture();
  try {
    assert.equal(publish(fx).status, 0);
    const head = remoteHead(fx);
    write(fx.src, "danxbot/skills/x/SKILL.md", "edited without regenerating the manifest\n");
    commitAndPush(fx, "edit");
    const r = publish(fx);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /does not match integrity-manifest\.json: skills\/x\/SKILL\.md/);
    assert.equal(remoteHead(fx), head);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("DX-4565: a HEAD on no pushed branch is refused", () => {
  const fx = fixture();
  try {
    write(fx.src, "danxbot/skills/x/SKILL.md", "unpushed\n");
    manifest(fx.src);
    git(fx.src, "add", "-A");
    git(fx.src, "commit", "-q", "-m", "unpushed");
    const r = publish(fx);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /is on no pushed branch/);
    assert.equal(git(fx.remote, "branch", "--list").trim(), "");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("DX-4565: an uncommitted edit under the plugin is refused, not silently left out", () => {
  const fx = fixture();
  try {
    write(fx.src, "danxbot/skills/x/SKILL.md", "dirty\n");
    const r = publish(fx);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /uncommitted changes/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("DX-4565: a failing claude plugin validate refuses the publish", () => {
  const fx = fixture();
  try {
    const r = publish(fx, { STANDIN_FAIL: "1" });
    assert.notEqual(r.status, 0);
    assert.equal(git(fx.remote, "branch", "--list").trim(), "");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
