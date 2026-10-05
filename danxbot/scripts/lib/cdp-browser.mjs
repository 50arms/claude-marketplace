// DX-4538: a dependency-free Chrome DevTools Protocol client over the machine's own Chrome or Edge.
// The plugin ships no node_modules, so Playwright is not resolvable from it; Node 22's built-in
// WebSocket plus an installed Chromium-family browser is all a capture needs.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WIN = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"]]
  .filter(Boolean)
  .flatMap((root) => [
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const LINUX = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].flatMap((n) =>
  ["/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/google/chrome"].map((d) => path.join(d, n)),
);

/** CHROME_PATH wins; otherwise the first installed Chrome/Edge. Throws when there is none. */
export function findBrowser(env = process.env, exists = existsSync) {
  if (env.CHROME_PATH) {
    if (!exists(env.CHROME_PATH)) throw new Error(`CHROME_PATH points at ${env.CHROME_PATH}, which does not exist`);
    return env.CHROME_PATH;
  }
  const found = [...WIN, ...MAC, ...LINUX].find((p) => exists(p));
  if (!found) {
    throw new Error("no Chrome or Edge found: install one or set CHROME_PATH to a Chromium-family executable");
  }
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(100);
  }
}

class Session {
  #ws;
  #next = 1;
  #pending = new Map();
  #listeners = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.#pending.get(msg.id);
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

  on(listener) {
    this.#listeners.push(listener);
  }

  close() {
    this.#ws.close();
  }
}

/** Launches a headless browser on a throwaway profile; returns a page session and a close(). */
export async function launchPage(executable, timeoutMs) {
  const profile = mkdtempSync(path.join(tmpdir(), "danx-capture-"));
  const child = spawn(
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
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.once("error", () => {});
  let session;
  const close = async () => {
    session?.close();
    child.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    const port = await waitFor("the browser's DevTools port", timeoutMs, async () => {
      if (child.exitCode !== null) throw new Error(`${executable} exited ${child.exitCode} before it was ready`);
      const file = path.join(profile, "DevToolsActivePort");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n")[0] : null;
    });
    const wsUrl = await waitFor("a page target", timeoutMs, async () => {
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
    throw e;
  }
}
