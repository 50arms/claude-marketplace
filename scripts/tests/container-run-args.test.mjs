import "../../danxbot/tests/designated-test-container.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { containerRunArgs } from "../lib/container-run-args.mjs";

const RUNNER = fileURLToPath(new URL("../test-in-container.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// CP-2: the daemon, not the runner's exit handler, removes the container.
test("docker run carries --rm directly after `run`, before the image", () => {
  const args = containerRunArgs("n", "img", ["a.test.mjs"]);
  assert.equal(args[0], "run");
  assert.equal(args[1], "--rm");
  assert.ok(args.indexOf("--rm") < args.indexOf("img"));
});

// The bootstrap in a temp dir: bad stdin must fail the unpack and never reach the entry script.
test("the bootstrap with a bad archive on stdin fails and never runs the entry script", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cp2-bootstrap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  const marker = join(dir, "entry-ran");
  writeFileSync(join(dir, "scripts", "test-container-entry.sh"), `#!/bin/bash\ntouch ${JSON.stringify(marker)}\n`);
  const args = containerRunArgs("n", "img", ["a.test.mjs"]);
  const r = spawnSync("bash", ["-c", ...args.slice(args.indexOf("-c") + 1)], { cwd: dir, input: "this is not a tar archive\n".repeat(100), encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(marker), false);
});

// The runner against a stub `docker` on PATH: `build` succeeds, `run` records its argv and stdin and either exits with STUB_EXIT or
// waits for a signal, `rm` records the container it was asked to remove.
function stubbedRunner(t, env) {
  const dir = mkdtempSync(join(tmpdir(), "cp2-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = (name) => join(dir, name);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
case "$1" in
  build) exit 0 ;;
  run) printf '%s\n' "$@" > ${log("run.argv")}
       cat > ${log("run.stdin")}
       if [ -n "$STUB_HANG" ]; then touch ${log("started")}; exec sleep 60; fi
       exit "\${STUB_EXIT:-0}" ;;
  rm) printf '%s\n' "$@" >> ${log("rm.argv")} ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const child = spawn(process.execPath, [RUNNER, "scripts/tests/ustar.test.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    stdio: "ignore",
  });
  const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, done, log, read: (name) => (existsSync(log(name)) ? readFileSync(log(name), "utf8").split("\n").filter(Boolean) : []) };
}

test("the runner passes the run argv and the archive on stdin, and propagates the container's exit code", async (t) => {
  const s = stubbedRunner(t, { STUB_EXIT: "7" });
  const { code } = await s.done;
  assert.equal(code, 7);
  const argv = s.read("run.argv");
  assert.equal(argv[0], "run");
  assert.equal(argv[1], "--rm");
  assert.equal(argv.at(-1), "scripts/tests/ustar.test.mjs");
  assert.ok(statSync(s.log("run.stdin")).size > 0, "the archive arrived on stdin");
  // the exit handler's best-effort removal, harmless after --rm
  assert.deepEqual(s.read("rm.argv").slice(0, 2), ["rm", "-f"]);
  assert.equal(s.read("rm.argv")[2], argv[argv.indexOf("--name") + 1]);
});

test("SIGTERM to the runner removes the container by name and exits 143", async (t) => {
  const s = stubbedRunner(t, { STUB_HANG: "1" });
  const deadline = Date.now() + 30000;
  while (!existsSync(s.log("started")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(s.log("started")), "the stub run started");
  s.child.kill("SIGTERM");
  const { code } = await s.done;
  assert.equal(code, 143);
  const name = s.read("run.argv")[s.read("run.argv").indexOf("--name") + 1];
  assert.deepEqual(s.read("rm.argv"), ["rm", "-f", name]);
});
