// DX-4234: the model's time stamp, on each prompt and after each tool call (PBLM-1915: both, as the bash hook did). The text is pure
// (hooks/context/stamp.ts, exact here with an explicit UTC offset); the hooks are checked as the engine runs them, on both surfaces.
import { describe, expect, test } from 'claude-code/testing'

import { stamp } from '../hooks/context/stamp'
import { SURFACES, dashboard, startSession } from './plan-kit'

// 2026-09-28 07:12:03 UTC is 01:12:03 at -06:00
const T0 = Date.UTC(2026, 8, 28, 7, 12, 3)
const MINUS_SIX = -360

describe('stamp (the line)', () => {
  test('the first stamp carries the full date and +0', () => {
    expect(stamp(T0, MINUS_SIX, null)).toEqual({ line: '09/28/2026 01:12:03 -06:00 +0', state: { at: T0, day: '20260928' } })
  })

  test('the same day carries the time only, with the seconds since the last stamp', () => {
    const first = stamp(T0, MINUS_SIX, null)
    expect(stamp(T0 + 5_000, MINUS_SIX, first.state).line).toBe('01:12:08 -06:00 +5s')
  })

  test('the time since the last stamp reads in seconds, minutes and hours', () => {
    const first = stamp(T0, MINUS_SIX, null)
    const rows: [number, string][] = [
      [0, '+0s'],
      [59_000, '+59s'],
      [60_000, '+1m'],
      [187_000, '+3m 7s'],
      [3_599_000, '+59m 59s'],
      [3_600_000, '+1h 0m'],
      [3_605_000, '+1h 0m 5s'],
      [7_384_000, '+2h 3m 4s'],
    ]
    for (const [ms, since] of rows) expect(stamp(T0 + ms, MINUS_SIX, first.state).line.endsWith(` ${since}`)).toBe(true)
  })

  test('a new local day brings the date back', () => {
    const late = stamp(Date.UTC(2026, 8, 29, 5, 59, 50), MINUS_SIX, null)
    expect(late.line).toBe('09/28/2026 23:59:50 -06:00 +0')
    expect(stamp(Date.UTC(2026, 8, 29, 6, 0, 10), MINUS_SIX, late.state).line).toBe('09/29/2026 00:00:10 -06:00 +20s')
  })

  test('the offset is written with its sign and minutes', () => {
    expect(stamp(T0, 330, null).line).toBe('09/28/2026 12:42:03 +05:30 +0')
    expect(stamp(T0, 0, null).line).toBe('09/28/2026 07:12:03 +00:00 +0')
  })

  test('a clock that went back reads +0s, never a negative', () => {
    const first = stamp(T0, MINUS_SIX, null)
    expect(stamp(T0 - 9_000, MINUS_SIX, first.state).line.endsWith(' +0s')).toBe(true)
  })
})

const FULL = /^\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d [+-]\d\d:\d\d \+0$/
const TIME_ONLY = /^\d\d:\d\d:\d\d [+-]\d\d:\d\d \+(\d+s|\d+m( \d+s)?|\d+h \d+m( \d+s)?)$/

for (const surface of SURFACES) {
  describe(`the time stamp hooks on ${surface}`, () => {
    test('prompt.submit: the first prompt carries the stamp with its date, the next the time only', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const first = await $.prompt.submit({ text: 'hello' })
      expect(first.text).toBe('hello')
      expect(first.context).toHaveLength(1)
      expect(first.context![0]).toMatch(FULL)
      await d.clock.advance(7_000)
      const second = await $.prompt.submit({ text: 'again' })
      expect(second.context).toHaveLength(1)
      expect(second.context![0]).toMatch(TIME_ONLY)
      expect(second.context![0].endsWith(' +7s')).toBe(true)
    })

    test('tool.call: a finished call carries the stamp after its result', async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('tool.call', () => ({ result: { ok: true }, text: 'done' }) as any)
      await startSession($, d, surface)
      const r = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
      expect(r.text).toBe('done')
      expect(r.context).toHaveLength(1)
      expect(r.context![0]).toMatch(FULL)
    })

    test('tool.call: an errored result carries it too (every tool call), a denied call does not', async ($, on) => {
      const d = dashboard(on, { connected: false })
      let answer: any = { result: undefined, isError: true, text: 'boom' }
      on('tool.call', () => answer)
      await startSession($, d, surface)
      const errored = await $.tool.call({ tool: 'Bash', command: 'false' } as any)
      expect(errored.isError).toBe(true)
      expect(errored.context).toHaveLength(1)
      answer = { deny: 'not allowed' }
      const denied = await $.tool.call({ tool: 'Bash', command: 'rm' } as any)
      expect(denied.context).toBeUndefined()
    })

    test('a prompt and a tool call share one clock: the delta counts from whichever came last', async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      await startSession($, d, surface)
      await $.prompt.submit({ text: 'go' })
      await d.clock.advance(12_000)
      const tool = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      expect(tool.context![0]).toMatch(TIME_ONLY)
      expect(tool.context![0].endsWith(' +12s')).toBe(true)
      await d.clock.advance(3_000)
      const next = await $.prompt.submit({ text: 'more' })
      expect(next.context![0].endsWith(' +3s')).toBe(true)
    })

    test('a task notification is stamped like a typed prompt', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const r = await $.prompt.submit({ text: 'task finished' } as any)
      expect(r.context).toHaveLength(1)
    })
  })
}
