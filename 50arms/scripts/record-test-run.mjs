#!/usr/bin/env node
// CP-57 (DEC-435) - the danxbot plugin's test-run recorder, for any repo. A builder runs the repo's designated test command THROUGH it:
//
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/record-test-run.mjs" --report <file outside the repo> [--format vitest-json|junit] [--card <ID>] -- <test command...>
//
// The command runs exactly as typed (output and exit code untouched). It must write the runner's own report to `$DANXBOT_TEST_REPORT`
// (the wrapper sets it to the --report path), e.g. vitest `--reporter=default --reporter=json --outputFile.json="$DANXBOT_TEST_REPORT"`.
// After an exit-0 run on a clean tree whose HEAD and tree did not move, it writes a record file and prints `DANXBOT_TEST_RUN_RECORD <file>`;
// the plugin's tool hook (hooks/register.tsx) posts it as DX-6681's `test_run` agent note with the session's own key. This script holds no
// credential. It never changes the run's exit code: whatever it declines to record it says on stderr.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decideRecord, parseReport, RECORD_MARKER } from "./lib/test-run.mjs";

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** `{head, tree, dirty, branch, root}` of the checkout at `cwd`, or null when it is no git work tree. */
export function gitState(cwd) {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const tree = git(cwd, ["rev-parse", "HEAD^{tree}"]);
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (head === null || tree === null || status === null || root === null) return null;
  return { head, tree, dirty: status !== "", branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), root };
}

export function parseArgs(argv) {
  const split = argv.indexOf("--");
  if (split === -1 || split === argv.length - 1) throw new Error("usage: record-test-run.mjs --report <file> [--format vitest-json|junit] [--card <ID>] -- <test command...>");
  const opts = { format: "vitest-json" };
  const own = argv.slice(0, split);
  for (let i = 0; i < own.length; i += 2) {
    const key = own[i];
    if (!["--report", "--format", "--card"].includes(key) || own[i + 1] === undefined) throw new Error(`unknown or incomplete option ${key}`);
    opts[key.slice(2)] = own[i + 1];
  }
  if (!opts.report) throw new Error("--report <file> is required: the runner's own report is the only source of counts");
  return { ...opts, command: argv.slice(split + 1) };
}

const say = (message) => process.stderr.write(`[record-test-run] ${message}\n`);

const insideRepo = (root, file) => {
  const rel = path.relative(path.resolve(root), file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Why this run cannot be recorded before it starts, or null. */
export function startRefusal(before, card, report) {
  if (before === null) return "this is not a git checkout";
  if (!card) return "no card: pass --card or run on a card/<ID> branch";
  if (insideRepo(before.root, report)) return "--report is inside the repo, where it would dirty the tree";
  if (before.dirty) return "the working tree is not clean (commit first, then run the tests)";
  return null;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    say(err.message);
    return 2;
  }
  const cwd = process.cwd();
  const report = path.resolve(args.report);
  const before = gitState(cwd);
  const card = args.card ?? /^card\/([A-Za-z0-9]+-\d+)$/.exec(before?.branch ?? "")?.[1];
  const skip = startRefusal(before, card, report);
  mkdirSync(path.dirname(report), { recursive: true });
  const startedAt = Date.now();
  const command = args.command.join(" ");
  const exitCode = await new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit", windowsHide: true, env: { ...process.env, DANXBOT_TEST_REPORT: report } });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  if (skip !== null) {
    say(`not recorded: ${skip}`);
    return exitCode;
  }
  let parsed = null;
  try {
    if (statSync(report).mtimeMs >= startedAt - 1000) parsed = parseReport(args.format, readFileSync(report, "utf8"));
  } catch {
    parsed = null;
  }
  const after = gitState(cwd) ?? { ...before, dirty: true };
  const decision = decideRecord({ exitCode, parsed, before, after, command, machine: os.hostname() });
  if (decision.reason !== undefined) {
    say(`not recorded: ${decision.reason}`);
    return exitCode;
  }
  const dir = path.join(os.tmpdir(), "danxbot-test-runs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${card}-${decision.metadata.commit_sha}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ card, text: decision.text, metadata: decision.metadata }), "utf8");
  process.stdout.write(`${RECORD_MARKER} ${file}\n`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code));
}
