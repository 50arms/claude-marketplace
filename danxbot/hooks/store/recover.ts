// a plugin's store file (one JSON file per plugin, written by the host) can be left all NUL bytes by a write cut off before its data reached disk. Every `$.store`
// call then rejects and the store API cannot repair it. This is the recovery, with every engine call behind `StoreIo` (register.tsx's `storeIo` is the only wiring to
// `$`), so the tests can hand it the host's error exactly as the host throws it: the plugin test runner prefixes every refusal a fake hands to the plugin, so a fake
// store cannot produce the real, unprefixed message through `$`.
import { EMPTY_STORE, malformedBackupPath, malformedStorePath, storeBytesParse } from './malformed'

export type StoreCall = { op: 'get' | 'delete'; key: string } | { op: 'set'; key: string; value: unknown } | { op: 'keys' }

export interface StoreIo {
  run(call: StoreCall): Promise<any>
  // any store read, to look at the store once more
  probe(): Promise<void>
  readBase64(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  now(): Promise<number>
  toast(text: string): void
}

// One recovery at a time: calls that failed together wait for the first one's, and a later one finds the store sound again (the probe) and resets nothing.
let recovery: Promise<void> | null = null

export function recoverMalformedStore(io: StoreIo, path: string): Promise<void> {
  recovery ??= (async () => {
    try {
      try {
        await io.probe()
        return
      } catch (err: any) {
        if (malformedStorePath(err) === null) throw err
      }
      const base64 = await io.readBase64(path)
      // every Claude process shares this file; if another one already reset it, the bytes now hold a JSON object and nothing is wiped (the caller just retries)
      if (storeBytesParse(base64)) return
      const backup = malformedBackupPath(path, await io.now())
      await io.write(backup, base64)
      await io.write(path, EMPTY_STORE)
      io.toast(`The plugin's saved state file was damaged (it held no valid JSON), so it was reset to empty and the plugin carries on. The damaged file is kept, base64-encoded, as ${backup}.`)
    } finally {
      recovery = null
    }
  })()
  return recovery
}

// Runs the call; if the host says the store file is malformed, recovers it and runs the call once more. Any other error, and a failed recovery, is thrown to the caller.
export async function storeDoor(io: StoreIo, call: StoreCall): Promise<any> {
  try {
    return await io.run(call)
  } catch (err: any) {
    const path = malformedStorePath(err)
    if (path === null) throw err
    await recoverMalformedStore(io, path)
    return io.run(call)
  }
}
