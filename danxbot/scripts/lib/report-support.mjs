// Helpers shared by the report hooks (activity-report.mjs, background-work-report.mjs,
// ready-cards-stop.mjs): the child env for a danx-dashboard-mcp subcommand, an atomic file
// write, and pruning of stale state files.
import fs from "node:fs";
import path from "node:path";

export const STALE_STATE_MS = 7 * 24 * 60 * 60 * 1000;

// Every state-file suffix a report hook writes must be listed here so `pruneStale` reaches it.
export const STATE_SUFFIXES = [".last-failure.json", ".tmp"];

/**
 * The subcommand's environment: the dashboard credential and session id it needs to
 * mint, and NOT the messaging token or socket, which only the session itself uses.
 */
export function childEnv(env, sessionId) {
  const out = { ...env, CLAUDE_CODE_SESSION_ID: sessionId };
  delete out.CLAUDE_CODE_MESSAGING_TOKEN;
  delete out.CLAUDE_CODE_MESSAGING_SOCKET;
  return out;
}

/** Write-then-rename: a reader sees the old file or the new one, never a torn write. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Remove every state file in `dir` nothing has touched for STALE_STATE_MS. */
export function pruneStale(dir, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!STATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_STATE_MS) fs.rmSync(file, { force: true });
    } catch {
      // gone or unreadable: nothing to prune
    }
  }
}
