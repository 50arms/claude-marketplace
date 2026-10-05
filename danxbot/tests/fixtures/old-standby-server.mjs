#!/usr/bin/env node
// DX-4610: the plugin's MCP server as plugin 0.12.57 and older started it when the session's repo declared its own `danx-dashboard`
// entry in `.mcp.json`: an EMPTY MCP server, kept verbatim from danxbot/scripts/dashboard-mcp-server.mjs at claude-plugins commit
// 1c63277 (`standbyReply` and `runStandby`). A session started in that mode keeps the process after a hot reload to a newer plugin,
// so the newer hooks meet exactly this server. Its identity: `initialize` answers `capabilities: {}` and the name
// `danx-dashboard-standby`; any other request, `tools/list` and `tools/call` included, is a JSON-RPC "method not found" (-32601),
// so Claude Code lists no tool for it.
import { createInterface } from "node:readline";

const SERVER_NAME = "danx-dashboard";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const STANDBY_VERSION = "0.0.0";
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;

export function standbyReply(message) {
  if (message.id === undefined) return null;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        serverInfo: { name: `${SERVER_NAME}-standby`, version: STANDBY_VERSION },
        instructions: "This repo's own .mcp.json provides the danx-dashboard server; this plugin copy is idle.",
      },
    };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  return { jsonrpc: "2.0", id: message.id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${message.method}` } };
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  let reply;
  try {
    reply = standbyReply(JSON.parse(line));
  } catch {
    reply = { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error: not a JSON-RPC message" } };
  }
  if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
});
