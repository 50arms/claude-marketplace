// DX-4538: a dependency-free Chrome DevTools Protocol client over the machine's own Chrome or Edge.
// The plugin ships no node_modules, so Playwright is not resolvable from it; Node 22's built-in
// WebSocket plus an installed Chromium-family browser is all a capture needs.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** Interval of every wait in this tool: the one `poll` loop. */
export const POLL_MS = 100;
export const PROFILE_PREFIX = "danx-capture-";
/** Windows holds a profile's files briefly after the browser exits. */
const RM_RETRY = { maxRetries: 10, retryDelay: 200 };
const STDERR_TAIL_CHARS = 2000;
const EXIT_WAIT_MS = 5000;
const MIN_NODE_MAJOR = 22;
/** Shell convention: 128 + the signal number. */
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The single wait loop: resolves with the first truthy probe, throws once `timeoutMs` has passed. */
export async function poll(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

/** Node's global WebSocket arrived in 22; older Nodes would fail mid-run with a confusing ReferenceError. */
export function requireNode(version = process.versions.node) {
  if (Number(version.split(".")[0]) < MIN_NODE_MAJOR) {
    throw new Error(`capture-screenshot needs Node ${MIN_NODE_MAJOR} or newer (this is ${version}): its WebSocket is built in`);
  }
}

const WIN_APPS = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe"];
const MAC_APPS = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Chromium.app/Contents/MacOS/Chromium"];
const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];

function candidates({ env, platform, home }) {
  if (platform === "win32") {
    return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .filter(Boolean)
      .flatMap((root) => WIN_APPS.map((app) => path.win32.join(root, app)));
  }
  if (platform === "darwin") {
    return ["/Applications", path.join(home, "Applications")].flatMap((root) => MAC_APPS.map((app) => path.join(root, app)));
  }
  const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), "/opt/google/chrome", "/snap/bin"];
  return dirs.flatMap((dir) => LINUX_NAMES.map((name) => path.join(dir, name)));
}

/**
 * CHROME_PATH wins; otherwise the first installed Chrome/Edge for this platform. Throws when there is none.
 * From WSL a Windows browser under /mnt/c is deliberately not used: it would need a Windows-side profile
 * directory and a DevTools port WSL cannot reliably reach, so WSL needs a browser installed inside it.
 */
export function findBrowser({ env = process.env, exists = existsSync, platform = process.platform, home = homedir() } = {}) {
  if (env.CHROME_PATH) {
    if (!exists(env.CHROME_PATH)) throw new Error(`CHROME_PATH points at ${env.CHROME_PATH}, which does not exist`);
    return env.CHROME_PATH;
  }
  const found = candidates({ env, platform, home }).find((p) => exists(p));
  if (found) return found;
  const wsl = env.WSL_DISTRO_NAME ? " (inside WSL a Windows browser cannot be driven: install Chromium in WSL)" : "";
  throw new Error(`no Chrome or Edge found: install one or set CHROME_PATH to a Chromium-family executable${wsl}`);
}

class Session {
  #ws;
  #next = 1;
  #pending = new Map();
  #listeners = new Set();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.#pending.get(msg.id);
        if (!p) return console.warn(`capture-screenshot: ignoring a reply to unknown request ${msg.id}`);
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const l of this.#listeners) l(msg.method, msg.params);
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this.#pending.values()) p.reject(new Error("the browser closed the connection"));
      this.#pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribes to protocol events; returns the unsubscribe function. */
  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.#ws.close();
  }
}

/**
 * Launches a headless browser on a throwaway profile; returns a page session and a close().
 * Whatever fails, and on SIGINT/SIGTERM, the browser is killed and the profile removed.
 */
export async function launchPage(executable, timeoutMs) {
  let profile = null;
  let child = null;
  let session = null;
  let exited = false;
  let stderrTail = "";

  const close = async () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    session?.close();
    if (child && !exited) {
      child.kill();
      try {
        await poll("the browser to exit", EXIT_WAIT_MS, () => exited);
      } catch {
        child.kill("SIGKILL");
      }
    }
    if (profile) {
      // A profile that will not delete must not mask a capture already written (or the real launch error).
      try {
        rmSync(profile, { recursive: true, force: true, ...RM_RETRY });
      } catch (e) {
        console.warn(`capture-screenshot: could not remove ${profile}: ${e.message}`);
      }
    }
  };
  // The kill itself makes an in-flight wait fail; the signal's exit code outranks that error (see the script's catch).
  const onSignal = (code) => () => {
    process.exitCode = code;
    void close().finally(() => process.exit(code));
  };
  const onSigint = onSignal(EXIT_SIGINT);
  const onSigterm = onSignal(EXIT_SIGTERM);
  // Windows delivers no SIGTERM to a handler (and SIGINT only from a console), so there this path is best effort.
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    profile = mkdtempSync(path.join(tmpdir(), PROFILE_PREFIX));
    child = spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let spawnError = null;
    child.stderr.on("data", (d) => (stderrTail = (stderrTail + d).slice(-STDERR_TAIL_CHARS)));
    child.once("exit", () => (exited = true));
    // A spawn failure (ENOENT, EACCES) emits `error` and never `exit`.
    child.once("error", (e) => {
      exited = true;
      spawnError = e;
    });
    const port = await poll("the browser's DevTools port", timeoutMs, () => {
      if (spawnError) throw new Error(`could not start ${executable}: ${spawnError.message}`);
      if (exited) throw new Error(`${executable} exited ${child.exitCode} before it was ready`);
      const file = path.join(profile, "DevToolsActivePort");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n")[0] : null;
    });
    const wsUrl = await poll("a page target", timeoutMs, async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("could not open the DevTools socket")), { once: true });
    });
    session = new Session(ws);
    return { session, close };
  } catch (e) {
    await close();
    throw stderrTail.trim() ? new Error(`${e.message}\nbrowser stderr (tail):\n${stderrTail.trim()}`) : e;
  }
}
