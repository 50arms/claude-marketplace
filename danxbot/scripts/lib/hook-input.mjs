/**
 * A hook's raw stdin text, shared by the hook scripts that read the payload themselves.
 * A hand run (a TTY, or nothing arriving) carries no payload.
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
