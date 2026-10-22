// a plugin's store file (one JSON file per plugin, written by the host) can be left all NUL bytes by a write cut off before its data reached disk.
// Every `$.store` call then rejects with a HooksError naming the file, and the store API has no way to repair it. These are the pure parts of the recovery
// (the `$` calls are in register.tsx `storeIo`, the flow is recover.ts): spotting that one error, and naming the backup.

// The host's wording (measured, claude.exe 2.1.304, a store file of NUL bytes): `<plugin>@<marketplace>: store file <absolute path> is malformed (<parse error>)`, with nothing before it.
// The plugin test runner prefixes a fake's refusal with `<plugin>: $.store.<op>: `, which the real program never does, so the match is anchored to the real start of the message and
// that wrapped form is NOT taken (nor is a message that merely quotes the error). Only this error is recovered; null for any other.
export function malformedStorePath(err: unknown): string | null {
  const message = String((err as { message?: unknown } | null | undefined)?.message ?? err)
  const found = /^[^\s:]+@[^\s:]+: store file (.+?) is malformed/.exec(message)
  return found === null ? null : found[1]
}

// True when the file's bytes (base64) parse as a JSON object, which is what the host reads a sound store as (it calls `[]`, a number or `null` malformed too: "the JSON is not an object"):
// another process has already rewritten the store, so it must not be reset.
export function storeBytesParse(base64: string): boolean {
  try {
    const parsed: unknown = JSON.parse(atob(base64))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

// `<store file>.malformed-<ISO time>.bak` beside the bad file. The ISO time's colons become dashes, which Windows file names cannot hold.
export function malformedBackupPath(storePath: string, nowMs: number): string {
  return `${storePath}.malformed-${new Date(nowMs).toISOString().replaceAll(':', '-')}.bak`
}

// What the store holds after a reset: a valid, empty state, which is what a fresh install starts from.
export const EMPTY_STORE = '{}'
