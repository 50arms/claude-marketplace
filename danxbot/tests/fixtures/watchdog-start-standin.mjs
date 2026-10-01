// Stands in for `plan-event-bridge.mjs start` when the watchdog runs it as a subprocess (DX-3997):
// parses the same CLI flags and hook payload through the bridge's own functions and runs the
// REAL `start()` (lock, instance mint, marker writes) — only the final "spawn a brand-new OS
// process" step is a stub that appends to STANDIN_SPAWN_LOG, so a test can count bridges started
// without leaving real detached processes behind.
import fs from "node:fs";
import { start, parseStartFlags, resolveStartRequest, intentFromHookEvent } from "../../scripts/plan-event-bridge.mjs";
import { parseHookPayload, readStdinText } from "../../scripts/lib/hook-input.mjs";

const flags = parseStartFlags(process.argv.slice(3));
const payload = parseHookPayload(await readStdinText());
const request = resolveStartRequest({
  hook: { sessionId: payload.sessionId, intent: intentFromHookEvent(payload.hookEventName), transcriptPath: payload.transcriptPath },
  flags,
});
const { gated: _gated, ...startArgs } = request;
const result = await start({
  ...startArgs,
  env: process.env,
  stderr: (message) => process.stderr.write(message),
  waitVerdict: async () => null,
  spawnRun: () => {
    fs.appendFileSync(process.env.STANDIN_SPAWN_LOG, `${JSON.stringify({ intent: request.intent })}\n`);
    return { pid: 999_001 };
  },
});
process.exit(result.exitCode ?? 0);
