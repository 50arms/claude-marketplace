// danxbot/scripts/lib/plan-connection.mjs — DX-3275.
// Shared "is this session connected to a plan" detection: a local file stat
// against ~/.config/danxbot/plan-sessions/<session>.json, the same record
// packages/danx-dashboard-mcp's session-connection.ts writes on a
// successful plan_connect. Run with `npm test` (node --test, no dependencies).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isValidSessionId, sessionConnectionPath, isPlanConnected } from "../scripts/lib/plan-connection.mjs";


let home;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "plan-connection-test-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function connect(sessionId) {
  const dir = path.join(home, ".config", "danxbot", "plan-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ schemaVersion: 1 }));
}

describe("isValidSessionId", () => {
  test("accepts a real session id shape", () => {
    assert.equal(isValidSessionId("eae1b219-a47a-471b-9081-563a31c5476f"), true);
  });
  test("rejects path traversal / non-string / missing", () => {
    assert.equal(isValidSessionId("../../etc/passwd"), false);
    assert.equal(isValidSessionId(""), false);
    assert.equal(isValidSessionId(undefined), false);
    assert.equal(isValidSessionId(42), false);
  });
});

describe("sessionConnectionPath", () => {
  test("matches session-connection.ts's layout (~/.config/danxbot/plan-sessions/<id>.json)", () => {
    assert.equal(
      sessionConnectionPath("abc", "/home/x"),
      path.join("/home/x", ".config", "danxbot", "plan-sessions", "abc.json"),
    );
  });
});

describe("isPlanConnected (function)", () => {
  test("false when no record exists", () => {
    assert.equal(isPlanConnected("no-record", home), false);
  });

  test("true once the connect record is written", () => {
    connect("has-record");
    assert.equal(isPlanConnected("has-record", home), true);
  });

  test("false for an invalid session id, even if a same-shaped file exists", () => {
    assert.equal(isPlanConnected("../../etc/passwd", home), false);
    assert.equal(isPlanConnected(null, home), false);
    assert.equal(isPlanConnected(undefined, home), false);
  });
});
