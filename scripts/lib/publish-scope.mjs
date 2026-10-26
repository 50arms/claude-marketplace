// CP-16: which tests a publish runs. A publish runs the affected tests for what changed since the last publish, never the
// whole suite by default. CLI (used by scripts/publish.sh): `node scripts/lib/publish-scope.mjs <repoRoot> <plugin ...>` prints
//   all                 the change is broad: run the whole suite
//   none                no test is affected: run no suite
//   files <a> <b> ...   run exactly these test files
// then, on stderr, the reason.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** More changed code files than this is a broad change. */
export const MAX_NARROW_CODE_FILES = 5;
/** The most `git` output read at once: a checkout lists far fewer paths than this. */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const TEST_DIRS = ["danxbot/tests", "scripts/tests"];
const TEST_FILE = /\.test\.(mjs|tsx)$/;
const PROSE = /\.(md|txt)$/;
/** Files every suite leans on: a change to one is broad, whatever its size. */
const SHARED = [
  /^package(-lock)?\.json$/, // the dependencies every test loads
  /^Dockerfile\.test$/, // the container every test runs in
  /^scripts\/(test-|lib\/(container-run-args|ustar))/, // the runner that builds and starts that container
  /\/hooks\/hooks\.json$/, // which hook modules load at all
  /\/hooks\/register\.tsx$/, // every hook is registered here, and every hook test starts a session through it
  /\/tests\/(plan-kit|designated-test-container|fixtures\/)/, // the helpers and data the hook tests share
];

/** A line that loads a file: an import, a require, or a file read / path build. A fixture string that merely spells a path does not. */
const LOADS_A_FILE = /^\s*import\b|\bfrom\s+['"]|\brequire\(|\b(readFileSync|readFile|readdirSync|existsSync|join|resolve)\(|\bnew URL\(/;
/** A test that lists directories walks them: every file under a directory it names is one it reads. */
const WALKS_A_DIRECTORY = /\breaddir(Sync)?\(/;
/** A quoted path-looking string. */
const QUOTED_PATH = /(["'`])([\w./-]+)\1/g;

/** Whether the test text loads the file: a line that imports or reads a file spells one of the wanted needles. */
function references(text, wanted) {
  return text.split("\n").some((line) => LOADS_A_FILE.test(line) && wanted.some((n) => (typeof n === "string" ? line.includes(n) : n.test(line))));
}

const escapeRegExp = (s) => s.replace(/\W/g, "\\$&");

/** What names `file` in a test: its path from the plugin folder, or for a SKILL.md its folder as one quoted path segment. */
function needles(file) {
  // a test spells a path from its own folder (`../hooks/context/stamp`), so the plugin folder is dropped
  const out = [file.replace(/\.(tsx?|mjs|js)$/, "").replace(/^[^/]+\//, "")];
  if (path.basename(file) === "SKILL.md") out.push(new RegExp(`['"\`/]${escapeRegExp(path.basename(path.dirname(file)))}['"\`/]`));
  return out;
}

/**
 * @param {string[]} changed repo-relative paths changed since the last publish
 * @param {{ tests: Map<string,string>, walks?: Map<string,string[]> }} repo every test file path -> its text; and, for a test that
 *   walks directories, the repo directories it names (every file under one counts as read by that test)
 * @returns {{ kind: 'all'|'none'|'files', files?: string[], reason: string }}
 */
export function publishScope(changed, repo) {
  const touched = changed.filter((f) => !f.startsWith(".claude-plugin/") && !/\/\.claude-plugin\/plugin\.json$/.test(f));
  const shared = touched.find((f) => SHARED.some((re) => re.test(f)));
  if (shared) return { kind: "all", reason: `${shared} is shared by every suite` };
  const code = touched.filter((f) => !PROSE.test(f));
  if (code.length > MAX_NARROW_CODE_FILES) return { kind: "all", reason: `${code.length} code files changed (a narrow change is at most ${MAX_NARROW_CODE_FILES})` };
  const run = new Set();
  for (const f of touched) {
    if (TEST_FILE.test(f)) {
      if (repo.tests.has(f)) run.add(f);
      continue;
    }
    const wanted = needles(f);
    const named = [...repo.tests.keys()].filter((t) => references(repo.tests.get(t), wanted) || (repo.walks?.get(t) ?? []).some((d) => f.startsWith(`${d}/`)));
    // a code file no test names is still loaded by something (a hook module's registration, a script): only the whole suite vouches for it
    if (named.length === 0 && !PROSE.test(f)) return { kind: "all", reason: `${f} is code no test names` };
    for (const t of named) run.add(t);
  }
  const files = [...run].sort();
  if (files.length === 0) return { kind: "none", reason: `no test names ${touched.length} changed file(s)` };
  return { kind: "files", files, reason: `${touched.length} changed file(s) are named by ${files.length} test file(s)` };
}

/** The repo directories (two levels or deeper, so never a whole plugin) a walking test names, from its quoted paths read from the test's or the plugin's folder. */
export function walkedDirectories(root, testPath, text) {
  const testDir = path.posix.dirname(testPath);
  const dirs = new Set();
  for (const [, , literal] of text.matchAll(QUOTED_PATH)) {
    for (const base of [testDir, path.posix.dirname(testDir)]) {
      const target = path.posix.normalize(path.posix.join(base, literal)).replace(/\/+$/, "");
      let stat = null;
      try {
        stat = fs.statSync(path.join(root, target));
      } catch {
        // the quoted string is no path of this repo
      }
      // a quoted file (`hooks/hooks.json`) names its folder; a plugin folder or the repo root is too coarse to count
      const dir = stat === null ? null : stat.isDirectory() ? target : path.posix.dirname(target);
      if (dir !== null && dir.split("/").length >= 2 && !dir.startsWith("..")) dirs.add(dir);
    }
  }
  return [...dirs];
}

/** Every test file under the repo's test folders (path -> text) and the directories each walking test names. */
export function readRepo(root) {
  const tests = new Map();
  for (const dir of TEST_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) if (TEST_FILE.test(name)) tests.set(`${dir}/${name}`, fs.readFileSync(path.join(abs, name), "utf8"));
  }
  const walks = new Map();
  for (const [file, text] of tests) if (WALKS_A_DIRECTORY.test(text)) walks.set(file, walkedDirectories(root, file, text));
  return { tests, walks };
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: GIT_OUTPUT_MAX_BYTES });
}

/** The last publish of a plugin is its newest bump commit, `<plugin> v<x.y.z>`; null when it has none. */
function lastPublish(root, plugin) {
  const sha = git(root, "log", "-1", "--format=%H", "-E", `--grep=^${plugin} v[0-9]+\.[0-9]+\.[0-9]+$`).trim();
  return sha === "" ? null : sha;
}

function main() {
  const root = path.resolve(process.argv[2] ?? ".");
  const plugins = process.argv.slice(3);
  const changed = new Set();
  for (const plugin of plugins) {
    const base = lastPublish(root, plugin);
    if (base === null) {
      console.error(`all: ${plugin} has no earlier publish to compare with`);
      console.log("all");
      return;
    }
    for (const f of git(root, "diff", "--name-only", base).split("\n")) if (f) changed.add(f);
  }
  for (const f of git(root, "ls-files", "--others", "--exclude-standard").split("\n")) if (f) changed.add(f);
  const scope = publishScope([...changed], readRepo(root));
  console.error(`${scope.kind}: ${scope.reason}`);
  console.log(scope.kind === "files" ? `files ${scope.files.join(" ")}` : scope.kind);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
