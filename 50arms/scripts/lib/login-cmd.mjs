// --login-cmd for scripts/capture-screenshot.mjs: the sign-in URL comes from a command the script runs itself.
// The URL is a secret (a single-use ticket): it is returned to the caller and never printed or put in a message.
import { spawnSync } from "node:child_process";

/** Bound on the command running; a command that has not answered by then failed. */
export const LOGIN_CMD_TIMEOUT_MS = 60_000;

/** The most of the command's stderr a failure message carries. */
const MAX_STDERR_CHARS = 1000;

const HTTP_URL = /^https?:\/\/\S+$/i;

/**
 * Runs `command` through a shell (no window ever) and returns its last stdout line, which must be an http(s) URL.
 * A non-zero exit, a timeout or a last line that is not a URL throws; the message names the command's stderr but never its stdout.
 */
export function runLoginCmd(command, { run = spawnSync, timeoutMs = LOGIN_CMD_TIMEOUT_MS } = {}) {
  const r = run(command, { shell: true, windowsHide: true, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  const stderr = String(r.stderr ?? "").trim().slice(0, MAX_STDERR_CHARS);
  const detail = stderr ? `\n${stderr}` : "";
  if (r.error) {
    const why = r.error.code === "ETIMEDOUT" ? `did not finish within ${timeoutMs} ms` : `could not run: ${r.error.message}`;
    throw new Error(`--login-cmd ${why}${detail}`);
  }
  if (r.status !== 0) throw new Error(`--login-cmd exited ${r.status ?? `on signal ${r.signal}`}${detail}`);
  const lines = String(r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last === undefined || !HTTP_URL.test(last)) {
    throw new Error(`--login-cmd printed no http(s) URL as its last stdout line${detail}`);
  }
  return last;
}
