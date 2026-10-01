// Shared state-record builders for the plan event bridge's tests (the bridge's own and the
// watchdog's): a `.started.json`, a `.stopped.json`, and the fixed clock they are judged against.
import { HEARTBEAT_STALE_MS } from "../../scripts/lib/bridge-state.mjs";

export const SESSION = "11111111-2222-4333-8444-555555555555";

export const started = (over = {}) => ({
  lastStartedInstance: "instance-a",
  startInputs: { sessionId: SESSION, intent: "resume", transcriptPath: null },
  restartGeneration: 0,
  consumedStopInstance: null,
  startedAt: "2026-09-21T00:00:00.000Z",
  ...over,
});
export const stopped = (reason, over = {}) => ({
  schemaVersion: 1,
  reason,
  detail: "d",
  fix: "",
  paths: [],
  instanceId: "instance-a",
  writingInstanceId: "instance-a",
  degraded: false,
  recordedAt: "2026-09-21T00:00:30.000Z",
  ...over,
});
export const NOW = Date.parse("2026-09-21T00:05:00.000Z");
export const freshPid = { pid: 1, sessionId: SESSION, heartbeatAt: new Date(NOW).toISOString(), instanceId: "instance-a", startedAt: "2026-09-21T00:00:00.000Z" };
export const stalePid = { pid: 1, sessionId: SESSION, heartbeatAt: new Date(NOW - HEARTBEAT_STALE_MS - 5_000).toISOString(), instanceId: "instance-a", startedAt: "2026-09-21T00:00:00.000Z" };
export const connectedTrue = { connected: true, instanceId: "instance-a", at: new Date(NOW).toISOString() };
export const connectedFalse = { connected: false, instanceId: "instance-a", at: new Date(NOW).toISOString() };
