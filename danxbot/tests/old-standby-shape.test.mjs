// DX-4610: the premise of the hooks' "restart this session" detection. A session started by plugin 0.12.57 or older in a repo with its own
// `.mcp.json` runs the plugin's server as an empty standby (tests/fixtures/old-standby-server.mjs, verbatim from history). Claude Code
// then lists NO tool for it, so a call the newer hooks make fails with the very same "no connected MCP tool" rejection a server that
// has not connected yet gives: the rejection cannot tell the two apart, and the session's tool list is the signal the hooks read
// (tests/plan-stale-server.test.tsx). This test pins what that signal rests on.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STANDBY = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "old-standby-server.mjs");

// Sends each request on the server's stdin and returns the replies by id.
async function ask(requests) {
  const child = spawn(process.execPath, [STANDBY], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  let buffer = "";
  const done = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        replies.set(msg.id, msg);
        if (replies.size === requests.filter((r) => r.id !== undefined).length) resolve();
      }
    });
  });
  for (const r of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
  await done;
  child.kill();
  return replies;
}

describe("the old standby server", () => {
  test("answers the handshake as an empty server and refuses tools/list and tools/call with method-not-found", async () => {
    const replies = await ask([
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "danxbot_api", arguments: { method: "GET", path: "/api/plans" } } },
    ]);
    assert.deepEqual(replies.get(1).result.capabilities, {});
    assert.equal(replies.get(1).result.serverInfo.name, "danx-dashboard-standby");
    assert.equal(replies.get(2).error.code, -32601);
    assert.equal(replies.get(3).error.code, -32601);
    assert.equal(replies.get(3).result, undefined, "a tool call never succeeds: nothing in the reply names a tool or an error result the hooks could read");
  });
});
