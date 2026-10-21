// DX-5577: a plugin store file left all NUL bytes by a cut-off write makes every `$.store` call reject with `<plugin>@<marketplace>: store file <path> is malformed (...)`.
// The plugin keeps a base64 copy of the file beside it, writes an empty valid store, tells the person once, and carries on; any other store error is still thrown.
//
// The plugin test runner hands the plugin a fake's refusal as `<plugin>: $.store.<op>: <reason>`; the real program throws the bare message (measured on claude.exe 2.1.304, probe
// plugin with a NUL-filled store file). A fake store therefore cannot deliver the real message through `$`, so the recovery (hooks/store/recover.ts) is driven here through its
// `StoreIo` with the host's message exactly as the host throws it, and the runner-level cases below pin that the wrapped form and every other error are NOT recovered.
import { describe, expect, test as unit } from 'claude-code/testing'

import { malformedBackupPath, malformedStorePath, storeBytesParse } from '../hooks/store/malformed'
import { storeDoor, type StoreCall, type StoreIo } from '../hooks/store/recover'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const STORE = String.raw`C:\Users\newms\.claude\plugins\store\gateprobe5577_inline-33d281cadcc3.json`
// the message the host throws for a NUL-filled store, as measured: no prefix
const HOST = (path: string) => `gateprobe5577@inline: store file ${path} is malformed (JSON Parse error: Unrecognized token '\u0000')`
const ZEROED = '\u0000'.repeat(40)
const NOW = Date.parse('2026-10-20T21:07:05.123Z')

// A store file the host reads like the real one: sound only while it holds a JSON object; otherwise every call throws the host's message.
function fakeHost(initial: string | null, hooks: { failFirstRun?: boolean; rewriteBeforeRead?: string; holdProbe?: Promise<void> } = {}) {
  const files = new Map<string, string>()
  if (initial !== null) files.set(STORE, initial)
  const toasts: string[] = []
  const writes: string[] = []
  let failFirstRun = hooks.failFirstRun === true
  const sound = () => {
    try {
      const v = JSON.parse(files.get(STORE) ?? '')
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    } catch {
      return false
    }
  }
  const data = new Map<string, unknown>()
  const io: StoreIo = {
    run: async (call: StoreCall) => {
      if (failFirstRun) {
        failFirstRun = false
        throw new Error(HOST(STORE))
      }
      if (!sound()) throw new Error(HOST(STORE))
      if (call.op === 'set') return void data.set(call.key, call.value)
      if (call.op === 'get') return data.get(call.key)
      if (call.op === 'delete') return void data.delete(call.key)
      return [...data.keys()]
    },
    probe: async () => {
      await hooks.holdProbe
      if (!sound()) throw new Error(HOST(STORE))
    },
    readBase64: async path => {
      if (hooks.rewriteBeforeRead !== undefined) files.set(STORE, hooks.rewriteBeforeRead)
      const bytes = files.get(path)
      if (bytes === undefined) throw new Error(`ENOENT: no such file ${path}`)
      return btoa(bytes)
    },
    write: async (path, text) => void (writes.push(path), files.set(path, text)),
    now: async () => NOW,
    toast: text => void toasts.push(text),
  }
  const backups = () => [...files.keys()].filter(f => f.startsWith(`${STORE}.malformed-`))
  return { io, files, toasts, writes, backups, data }
}

describe('the host error that names a malformed store file', () => {
  unit('the real message, as the host throws it, gives the path', () => {
    expect(malformedStorePath(new Error(HOST(STORE)))).toBe(STORE)
    expect(malformedStorePath(new Error('danxbot@50arms: store file /home/u/.claude/plugins/store/danxbot_50arms-x.json is malformed (the JSON is not an object)'))).toBe('/home/u/.claude/plugins/store/danxbot_50arms-x.json')
  })

  unit('no other message is taken: not the runner-wrapped form, not one that quotes it, not another store error', () => {
    expect(malformedStorePath(new Error(`danxbot: $.store.set: ${HOST(STORE)}`))).toBeNull()
    expect(malformedStorePath(new Error(`the relay hit an error: ${HOST(STORE)}`))).toBeNull()
    expect(malformedStorePath(new Error('gateprobe5577@inline: store file is locked'))).toBeNull()
    expect(malformedStorePath(new Error('over 4 MiB'))).toBeNull()
    expect(malformedStorePath(undefined)).toBeNull()
  })

  unit('the backup name carries the ISO time with its colons made safe for Windows', () => {
    expect(malformedBackupPath(STORE, NOW)).toBe(`${STORE}.malformed-2026-10-20T21-07-05.123Z.bak`)
  })
})

describe('the bytes of a store file that parse', () => {
  unit('only a JSON object is a sound store, as the host reads it', () => {
    expect(storeBytesParse(btoa('{"theirs":1}'))).toBe(true)
    expect(storeBytesParse(btoa('{}'))).toBe(true)
  })

  unit('anything else is malformed: an array, null, a number, a string, NUL bytes, nothing', () => {
    for (const bytes of ['[]', '[1]', 'null', '1', '"x"', ZEROED, '']) expect(storeBytesParse(btoa(bytes))).toBe(false)
  })
})

describe('the recovery of a zeroed store file', () => {
  unit('keeps the bytes as base64, resets to an empty valid store, tells the person once, and the call runs again', async () => {
    const h = fakeHost(ZEROED)
    await storeDoor(h.io, { op: 'set', key: 'k', value: 1 })
    expect(h.backups()).toHaveLength(1)
    expect(h.files.get(h.backups()[0])).toBe(btoa(ZEROED))
    expect(h.files.get(STORE)).toBe('{}')
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).toContain('gateprobe5577_inline-33d281cadcc3.json.malformed-2026-10-20T21-07-05.123Z.bak')
    expect(await storeDoor(h.io, { op: 'get', key: 'k' })).toBe(1)
  })

  unit('a store file that holds an array is as malformed as the host says: it is backed up and reset', async () => {
    const h = fakeHost('[]')
    await storeDoor(h.io, { op: 'keys' })
    expect(h.backups()).toHaveLength(1)
    expect(h.files.get(STORE)).toBe('{}')
  })

  unit('a store that is sound again by the time the recovery looks is not reset: the file is left as it is', async () => {
    const h = fakeHost('{"theirs":1}', { failFirstRun: true })
    await storeDoor(h.io, { op: 'set', key: 'k', value: 1 })
    expect(h.writes).toEqual([])
    expect(h.files.get(STORE)).toBe('{"theirs":1}')
    expect(h.toasts).toEqual([])
    expect(await storeDoor(h.io, { op: 'get', key: 'k' })).toBe(1)
  })

  unit('bytes that hold a JSON object when read are another process having reset the file: nothing is backed up or wiped', async () => {
    const h = fakeHost(ZEROED, { rewriteBeforeRead: '{"theirs":1}' })
    await storeDoor(h.io, { op: 'set', key: 'k', value: 1 })
    expect(h.writes).toEqual([])
    expect(h.files.get(STORE)).toBe('{"theirs":1}')
    expect(h.toasts).toEqual([])
  })

  unit('calls that fail together share ONE recovery: one backup, one reset, one toast', async () => {
    let release!: () => void
    const h = fakeHost(ZEROED, { holdProbe: new Promise<void>(resolve => (release = resolve)) })
    const calls = Promise.all([storeDoor(h.io, { op: 'set', key: 'a', value: 1 }), storeDoor(h.io, { op: 'set', key: 'b', value: 2 }), storeDoor(h.io, { op: 'keys' })])
    await Promise.resolve()
    release()
    await calls
    expect(h.backups()).toHaveLength(1)
    expect(h.writes).toHaveLength(2)
    expect(h.toasts).toHaveLength(1)
    expect(h.data.get('a')).toBe(1)
    expect(h.data.get('b')).toBe(2)
  })

  unit('a recovery that cannot keep the copy fails loudly and resets nothing; the next call can recover once the file is readable', async () => {
    const h = fakeHost(null)
    await expect(storeDoor(h.io, { op: 'set', key: 'k', value: 1 })).rejects.toThrow('ENOENT')
    expect(h.writes).toEqual([])
    expect(h.toasts).toEqual([])
    h.files.set(STORE, ZEROED)
    await storeDoor(h.io, { op: 'set', key: 'k', value: 1 })
    expect(h.backups()).toHaveLength(1)
  })

  unit('any other store error is thrown as it is, with nothing backed up or reset', async () => {
    const h = fakeHost(ZEROED)
    const io: StoreIo = { ...h.io, run: async () => Promise.reject(new Error('gateprobe5577@inline: store is over 4 MiB')) }
    await expect(storeDoor(io, { op: 'keys' })).rejects.toThrow('over 4 MiB')
    expect(h.writes).toEqual([])
    expect(h.toasts).toEqual([])
  })

  unit('the runner-wrapped form of the message is not the host error: it is thrown, nothing is reset', async () => {
    const h = fakeHost(ZEROED)
    const io: StoreIo = { ...h.io, run: async () => Promise.reject(new Error(`danxbot: $.store.set: ${HOST(STORE)}`)) }
    await expect(storeDoor(io, { op: 'keys' })).rejects.toThrow('is malformed')
    expect(h.writes).toEqual([])
    expect(h.toasts).toEqual([])
  })
})

for (const surface of SURFACES) {
  describe(`a refused store on ${surface}, through the plugin's own hooks`, () => {
    test('any other store error fails loudly to the person, and no file is touched', async ($, on) => {
      const d = dashboard(on)
      d.world.files['/Users/u/store.json'] = 'kept'
      d.relay.breakStore('danxbot@50arms: store is over 4 MiB')
      await startSession($, d, surface)
      const failed = d.toasts.filter(t => t.startsWith('Plan load failed:'))
      expect(failed).toHaveLength(1)
      expect(failed[0]).toContain('store is over 4 MiB')
      expect(d.world.files['/Users/u/store.json']).toBe('kept')
      expect(d.toasts.filter(t => t.includes('was damaged'))).toHaveLength(0)
    })

    test('the message as the runner wraps it is not recovered (the real one has no prefix), so nothing is read, backed up or reset', async ($, on) => {
      const d = dashboard(on)
      const before = { ...d.world.files }
      d.relay.breakStore(HOST(STORE))
      await startSession($, d, surface)
      expect(d.toasts.filter(t => t.startsWith('Plan load failed:'))).toHaveLength(1)
      expect(d.toasts.filter(t => t.includes('was damaged'))).toHaveLength(0)
      expect(d.world.files).toEqual(before)
    })
  })
}
