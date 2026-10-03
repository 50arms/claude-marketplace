// scripts/publish.sh pre-flight — DX-4244: a publish over an edited hashed file
// must not print the integrity launcher's INTEGRITY FAILURE (whose printed fix
// is a `git checkout` of the very edit being published).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("DX-4244: publish over an edited skill file prints no INTEGRITY FAILURE", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-test-"));
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", REPO_ROOT, dir]);
    // The clone has HEAD's committed tree only; carry this tree's own publish.sh in.
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "publish.sh"), path.join(dir, "scripts", "publish.sh"));
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-am", "carry publish.sh"], { cwd: dir });
    const skill = path.join(dir, "danxbot", "skills", "issue-workflow", "SKILL.md");
    fs.appendFileSync(skill, "\n<!-- DX-4244 test edit -->\n");
    // DANX_AGENT_WORKTREE: commit the bump but skip the push and this machine's plugin delivery.
    const r = spawnSync("bash", [path.join(dir, "scripts", "publish.sh"), "patch", "danxbot"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, DANX_AGENT_WORKTREE: dir, NODE_PATH: path.join(REPO_ROOT, "node_modules"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.doesNotMatch(out, /INTEGRITY FAILURE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
