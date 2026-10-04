/**
 * A hook's stdin JSON, read once and parsed — shared by `plan-event-bridge.mjs`
 * and `bridge-watchdog.mjs` (DX-3997: the watchdog must not import the bridge,
 * so neither can own this). A hand run (a TTY, or no usable JSON) carries no
 * payload and falls back to `CLAUDE_CODE_SESSION_ID`.
 */

/** The raw stdin text; empty on a TTY, on a read error, or when nothing arrives within `timeoutMs`. */
export async function readStdinText({ stdin = process.stdin, timeoutMs = 500 } = {}) {
  if (stdin.isTTY) return "";
  const chunks = [];
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    stdin.on("data", (c) => chunks.push(c));
    stdin.on("end", done);
    stdin.on("error", done);
  });
  stdin.pause();
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * DX-4391: a PostToolUse hook's `tool_response` as the text the tool answered: a string as is, else the
 * `text` blocks of its `content` (or of the array itself) joined. "" when it carries none.
 */
export function toolResponseText(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  const blocks = Array.isArray(toolResponse) ? toolResponse : Array.isArray(toolResponse?.content) ? toolResponse.content : [];
  return blocks.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

/** `session_id`, `hook_event_name`, `transcript_path` and (PostToolUse) the tool's answer text out of the hook JSON; anything unusable is null / "" / the env fallback. */
export function parseHookPayload(text, env = process.env) {
  const fallback = { sessionId: env.CLAUDE_CODE_SESSION_ID ?? null, hookEventName: null, transcriptPath: null, toolResultText: "" };
  try {
    const parsed = JSON.parse(text);
    return {
      sessionId: typeof parsed.session_id === "string" && parsed.session_id !== "" ? parsed.session_id : fallback.sessionId,
      hookEventName: typeof parsed.hook_event_name === "string" ? parsed.hook_event_name : null,
      transcriptPath: typeof parsed.transcript_path === "string" && parsed.transcript_path !== "" ? parsed.transcript_path : null,
      toolResultText: toolResponseText(parsed.tool_response),
    };
  } catch {
    return fallback;
  }
}
