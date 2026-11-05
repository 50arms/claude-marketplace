// DX-4321 — a fake npm registry for the plugin's tests: a `node:http` server (own process, see
// fake-registry-server.mjs) answering `/@thehammer%2Fdanx-dashboard-mcp/latest` with a version
// the test can change, a 500, a malformed body, or no answer at all, and counting requests.
//
//   const registry = await startFakeRegistry({ version: "0.1.50" });
//   env[REGISTRY_BASE_URL_ENV] = registry.url;
//   registry.setVersion("0.1.51");   registry.setMode("status-500");   registry.requests();
//   await registry.stop();
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The env var the module reads the registry's base URL from: the test seam. */
export const REGISTRY_BASE_URL_ENV = "DASHBOARD_MCP_REGISTRY_BASE_URL";
/** The env var bounding the registry request, so a hang test does not wait the production bound out. */
export const REGISTRY_TIMEOUT_ENV = "DASHBOARD_MCP_REGISTRY_TIMEOUT_MS";

export async function startFakeRegistry({ version = "0.1.50", mode = "ok", body = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-registry-"));
  const controlFile = path.join(dir, "control.json");
  const requestLog = path.join(dir, "requests.log");
  writeFileSync(requestLog, "");
  const state = { mode, version, body };
  const flush = () => writeFileSync(controlFile, JSON.stringify(state));
  flush();
  const child = spawn(process.execPath, [path.join(here, "fake-registry-server.mjs"), controlFile, requestLog], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const port = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    child.once("exit", (code) => reject(new Error(`fake registry exited ${code} before listening`)));
  });
  child.stdout.destroy(); // nothing more to read; keeps the test runner's event loop free to exit
  return {
    url: `http://127.0.0.1:${port}`,
    setVersion(next) {
      state.version = next;
      state.mode = "ok";
      flush();
    },
    setMode(next, nextBody = "") {
      state.mode = next;
      state.body = nextBody;
      flush();
    },
    /** The request paths received so far, in order. */
    requests: () => readFileSync(requestLog, "utf8").split("\n").filter(Boolean),
    async stop() {
      child.kill();
      await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
