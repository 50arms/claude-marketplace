// The Bash hook's rewrite for a command that names $DANXBOT_TEST_RECORDER: pure, and shared by the hooks module and its tests.
import { shellWord } from "./shell-quote.mjs";

export const RECORDER_VAR = "DANXBOT_TEST_RECORDER";

const RECORDER_USE = /\$(?:\{DANXBOT_TEST_RECORDER\}|DANXBOT_TEST_RECORDER(?![A-Za-z0-9_]))/;

/** The recorder script's absolute path, from the URL of the hooks module (register.tsx), in the forward-slash form bash and node both read. */
export function recorderPath(moduleUrl) {
  const path = decodeURIComponent(new URL("../scripts/record-test-run.mjs", moduleUrl).pathname);
  return path.replace(/^\/([A-Za-z]:)/, "$1");
}

/**
 * The Bash command with the recorder variable exported first (a prefix assignment would not reach the arguments the shell expands), when it names the
 * variable and the session has not set it; every other command comes back unchanged.
 */
export function withRecorderVar(command, scriptPath, alreadySet) {
  if (typeof command !== "string" || alreadySet || !RECORDER_USE.test(command)) return command;
  return `export ${RECORDER_VAR}=${shellWord(scriptPath)}; ${command}`;
}
