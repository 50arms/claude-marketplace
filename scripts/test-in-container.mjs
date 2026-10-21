/**
 * DX-5648 - the ONE way this repo's tests run: Linux, inside a container started from Dockerfile.test. `npm test` and
 * scripts/publish.sh both come through here; a test file run anywhere else refuses before any test runs
 * (danxbot/tests/designated-test-container.mjs).
 *
 *   npm test                                       the whole suite: the node suites, then `claude plugin test danxbot`
 *   npm test -- danxbot/tests/mantra.test.mjs      named files: .mjs files run under `node --test`, .tsx files under `claude plugin test`
 *
 * HOW THE SOURCE GETS IN. Nothing from this machine is mounted. The image holds the installed dependencies and the claude CLI; the
 * source is streamed in as a tar archive (`docker cp`) into a container created from it. The copy is exactly the files git sees here
 * (tracked, plus untracked files that are not ignored, as they are on disk now), each tracked file with the mode the git index records.
 * A container-side write can never reach a host node_modules, and a host node_modules (Windows-native binaries) never goes in. The
 * container also gets a git repository whose HEAD is the copied tree: the delivery and publish suites clone it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUstar } from "./lib/ustar.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "/app";
/** The most `git ls-files` output the collector accepts: a checkout lists far fewer paths than this. */
const GIT_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;
/** The `node` user of the official node image, which Dockerfile.test runs the suite as. */
const TEST_USER = { uid: 1000, gid: 1000 };
/** Git for Windows rewrites arguments that look like POSIX paths; every path handed to docker here is a container path. */
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };

/** Set once the container exists; the exit handler removes it on every path out, die() included. */
let createdContainer;
process.on("exit", () => {
  if (createdContainer) spawnSync("docker", ["rm", "-f", createdContainer], { stdio: "ignore", env: DOCKER_ENV });
});

const die = (message) => {
  console.error(`test-in-container: ${message}`);
  process.exit(2);
};

function docker(dockerArgs, options = {}) {
  const r = spawnSync("docker", dockerArgs, { encoding: "utf8", env: DOCKER_ENV, ...options });
  if (r.error) die(`could not run docker (${r.error.message}). Tests run only inside the test container, which needs Docker.`);
  return r;
}

function git(gitArgs) {
  const r = spawnSync("git", gitArgs, { cwd: ROOT, encoding: "buffer", maxBuffer: GIT_OUTPUT_MAX_BYTES });
  if (r.error || r.status !== 0) die(`git ${gitArgs.join(" ")} failed: ${r.error?.message ?? r.stderr.toString()}`);
  return r.stdout.toString("utf8");
}

/** The files git sees in this checkout, as path -> mode: tracked modes from the index, untracked as plain files. */
function gitVisibleFiles() {
  const files = new Map();
  for (const entry of git(["ls-files", "-s", "-z"]).split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t");
    const mode = meta.split(" ")[0];
    if (mode === "120000" || mode === "160000") die(`${path} is a ${mode === "120000" ? "symlink" : "submodule"}; the test copy carries regular files only`);
    files.set(path, mode === "100755" ? 0o755 : 0o644);
  }
  for (const path of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    if (!files.has(path)) files.set(path, 0o644);
  }
  return files;
}

function collectSource() {
  const entries = [];
  for (const [path, mode] of gitVisibleFiles()) {
    let stat;
    try {
      stat = statSync(join(ROOT, path));
    } catch (e) {
      if (e.code === "ENOENT") continue; // tracked but deleted in this working tree: the test copy is the tree as it is on disk
      throw e;
    }
    if (stat.isFile()) entries.push({ path, mode, content: readFileSync(join(ROOT, path)), mtime: stat.mtimeMs / 1000 });
  }
  return entries;
}

/**
 * Builds the test image (a no-op from cache when its inputs did not change) and returns its tag. The tag is a hash of everything the
 * image is built from, so two worktrees with different lockfiles or CLI pins never share, or overwrite, one tag between this build
 * and the `docker create`.
 */
function buildImage() {
  const claudeVersion = readFileSync(join(ROOT, ".claude-code-version"), "utf8").trim();
  const hash = createHash("sha256").update(`claude${claudeVersion}\0`);
  for (const file of ["Dockerfile.test", "package.json", "package-lock.json"]) hash.update(readFileSync(join(ROOT, file))).update("\0");
  const image = `claude-plugins-test:${hash.digest("hex").slice(0, 16)}`;
  console.error(`test-in-container: building the test image ${image} (cached when its inputs did not change)`);
  const r = docker(["build", "-q", "-f", "Dockerfile.test", "--build-arg", `CLAUDE_CODE_VERSION=${claudeVersion}`, "-t", image, "."], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.status !== 0) die("the test image failed to build (see the error above)");
  return image;
}

/**
 * The test files named on the command line, as repo-relative POSIX paths: backslashes become slashes and a leading `./` goes, so a path
 * pasted from Windows names the same file the container copy holds. An absolute path or one that climbs out of the repo names nothing there.
 */
function normalizeTestPaths(args) {
  return args.map((arg) => {
    const path = arg.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) die(`${arg} is not a path inside this repo; name test files relative to the repo root`);
    return path;
  });
}

function main() {
  const testFiles = normalizeTestPaths(process.argv.slice(2));
  const image = buildImage();
  // The archive is built BEFORE the container exists, so a failure collecting it has no container to leak.
  const archive = buildUstar(collectSource(), TEST_USER);
  const name = `claude-plugins-test-${process.pid}-${Date.now()}`;
  const created = docker(["create", "--name", name, "--label", "claude-plugins.test-container=1", image, "bash", "scripts/test-container-entry.sh", ...testFiles]);
  if (created.status !== 0) die(`docker create failed: ${created.stderr}`);
  createdContainer = name; // removed by the exit handler on every path from here
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  const copy = spawn("docker", ["cp", "-a", "-", `${name}:${APP}`], { env: DOCKER_ENV, stdio: ["pipe", "inherit", "inherit"] });
  copy.on("error", (e) => die(`docker cp failed: ${e.message}`));
  copy.stdin.on("error", () => {}); // a docker cp that exits early surfaces through its exit code below
  copy.stdin.end(archive);
  copy.on("exit", (code) => {
    if (code !== 0) die(`copying the source into the container failed (docker cp exit ${code})`);
    const run = spawn("docker", ["start", "-a", name], { env: DOCKER_ENV, stdio: "inherit" });
    run.on("error", (e) => die(`docker start failed: ${e.message}`));
    run.on("exit", (status) => process.exit(status ?? 1));
  });
}

main();
