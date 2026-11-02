import "./run-tests-with-npm-test.generated"
// DX-4234: the model's time stamp, on each prompt and after a tool call once a stretch has passed since the last (PBLM-1915: both, as the bash hook did; CP-52: not every call). The text is pure
// (hooks/context/stamp.ts, exact here with an explicit UTC offset); the hooks are checked as the engine runs them, on both surfaces.
import { describe, expect } from 'claude-code/testing'

import { TOOL_STAMP_EVERY_MS, stamp, stampDecision, stampForgotten, toolStampDue } from '../hooks/context/stamp'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

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

describe('toolStampDue (CP-52)', () => {
  test('a never-stamped agent is due, one stamped less than the stretch ago is not, one stamped the stretch ago is', () => {
    expect(toolStampDue(undefined, T0)).toBe(true)
    expect(toolStampDue(T0, T0)).toBe(false)
    expect(toolStampDue(T0, T0 + TOOL_STAMP_EVERY_MS - 1)).toBe(false)
    expect(toolStampDue(T0, T0 + TOOL_STAMP_EVERY_MS)).toBe(true)
  })

  test('a clock that went back is due', () => {
    expect(toolStampDue(T0, T0 - 1)).toBe(true)
  })
})

describe('stampDecision (per agent)', () => {
  const MAIN = 'main'
  test('the first stamp of an agent carries the full date and +0, and is remembered for that agent only', () => {
    const d = stampDecision({}, MAIN, T0, MINUS_SIX, 'tool')
    expect(d.line).toBe('09/28/2026 01:12:03 -06:00 +0')
    expect(d.told).toEqual({ [MAIN]: { at: T0, day: '20260928' } })
  })

  test('a tool call within the stretch is not stamped and changes nothing', () => {
    const told = { [MAIN]: { at: T0, day: '20260928' } }
    const d = stampDecision(told, MAIN, T0 + TOOL_STAMP_EVERY_MS - 1, MINUS_SIX, 'tool')
    expect(d.line).toBeNull()
    expect(d.told).toBe(told)
  })

  test("a tool call after the stretch is stamped, and +Δ is that agent's own gap, not the gap to another agent's stamp", () => {
    const told = { [MAIN]: { at: T0, day: '20260928' }, a1: { at: T0 + 57_000, day: '20260928' } }
    const d = stampDecision(told, MAIN, T0 + TOOL_STAMP_EVERY_MS, MINUS_SIX, 'tool')
    expect(d.line).toBe('01:13:03 -06:00 +1m')
    expect(d.told).toEqual({ ...told, [MAIN]: { at: T0 + TOOL_STAMP_EVERY_MS, day: '20260928' } })
  })

  test('a prompt is stamped however recent the last stamp', () => {
    const told = { [MAIN]: { at: T0, day: '20260928' } }
    expect(stampDecision(told, MAIN, T0 + 2_000, MINUS_SIX, 'prompt').line).toBe('01:12:05 -06:00 +2s')
  })

  test('a clock that went back is stamped', () => {
    const told = { [MAIN]: { at: T0, day: '20260928' } }
    expect(stampDecision(told, MAIN, T0 - 5_000, MINUS_SIX, 'tool').line).toBe('01:11:58 -06:00 +0s')
  })

  test('a forgotten agent has no entry, and the others keep theirs', () => {
    const told = { [MAIN]: { at: T0, day: '20260928' }, a1: { at: T0, day: '20260928' } }
    expect(stampForgotten(told, 'a1')).toEqual({ [MAIN]: told[MAIN] })
    expect(stampForgotten(told, 'a2')).toEqual(told)
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

    test('tool.call: a call within the stretch since the last stamp carries none, the first after it carries one counted from the last stamp sent', async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      await startSession($, d, surface)
      expect((await $.tool.call({ tool: 'Bash', command: 'a' } as any)).context).toHaveLength(1)
      await d.clock.advance(TOOL_STAMP_EVERY_MS - 1_000)
      const quiet = await $.tool.call({ tool: 'Bash', command: 'b' } as any)
      expect(quiet.text).toBe('done')
      expect(quiet.context).toHaveLength(0)
      await d.clock.advance(1_000)
      const due = await $.tool.call({ tool: 'Bash', command: 'c' } as any)
      expect(due.context).toHaveLength(1)
      expect(due.context![0]).toMatch(TIME_ONLY)
      expect(due.context![0].endsWith(' +1m')).toBe(true)
    })

    test('tool.call: each agent has its own stretch, so a sub-agent is stamped on its first call and the main thread is not stamped again for it', async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      await startSession($, d, surface)
      expect((await $.tool.call({ tool: 'Bash', command: 'a' } as any)).context).toHaveLength(1)
      const sub = await $.tool.call({ tool: 'Bash', command: 'b', agentId: 'a1' } as any)
      expect(sub.context).toHaveLength(1)
      expect(sub.context![0]).toMatch(FULL)
      expect((await $.tool.call({ tool: 'Bash', command: 'c', agentId: 'a1' } as any)).context).toHaveLength(0)
      expect((await $.tool.call({ tool: 'Bash', command: 'd' } as any)).context).toHaveLength(0)
    })

    test("tool.call: +Δ is the agent's own gap, so a stamp after a minute of silence never reads the few seconds since another agent's", async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      await startSession($, d, surface)
      await $.tool.call({ tool: 'Bash', command: 'a' } as any)
      await d.clock.advance(TOOL_STAMP_EVERY_MS - 3_000)
      await $.tool.call({ tool: 'Bash', command: 'b', agentId: 'a1' } as any)
      await d.clock.advance(3_000)
      const main = await $.tool.call({ tool: 'Bash', command: 'c' } as any)
      expect(main.context).toHaveLength(1)
      expect(main.context![0]).toMatch(TIME_ONLY)
      expect(main.context![0].endsWith(' +1m')).toBe(true)
    })

    test('tool.call: a prompt is stamped every time and restarts the main thread\'s stretch', async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      await startSession($, d, surface)
      await $.tool.call({ tool: 'Bash', command: 'a' } as any)
      await d.clock.advance(TOOL_STAMP_EVERY_MS - 1_000)
      expect((await $.prompt.submit({ text: 'again' })).context).toHaveLength(1)
      await d.clock.advance(TOOL_STAMP_EVERY_MS - 1_000)
      expect((await $.tool.call({ tool: 'Bash', command: 'b' } as any)).context).toHaveLength(0)
    })

    test('tool.call: a stopped sub-agent forgets its stretch, and a session start gives every agent a stamp on its next call', async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      await startSession($, d, surface)
      await $.tool.call({ tool: 'Bash', command: 'a', agentId: 'a1' } as any)
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      const again = await $.tool.call({ tool: 'Bash', command: 'b', agentId: 'a1' } as any)
      expect(again.context).toHaveLength(1)
      expect(again.context![0]).toMatch(FULL)
      await $.tool.call({ tool: 'Bash', command: 'c' } as any)
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: 's2', transcript_path: '/work/main.jsonl' })
      const sub = await $.tool.call({ tool: 'Bash', command: 'd', agentId: 'a1' } as any)
      expect(sub.context).toHaveLength(1)
      expect(sub.context![0]).toMatch(FULL)
      const main = await $.tool.call({ tool: 'Bash', command: 'e' } as any)
      expect(main.context).toHaveLength(1)
      expect(main.context![0]).toMatch(FULL)
    })

    test('tool.call: an errored result carries it too (every stamped call), a denied call does not', async ($, on) => {
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
      await d.clock.advance(TOOL_STAMP_EVERY_MS + 12_000)
      const tool = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      expect(tool.context![0]).toMatch(TIME_ONLY)
      expect(tool.context![0].endsWith(' +1m 12s')).toBe(true)
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

// DX-4736: a fresh desktop session's real event order (DX-3900 comment 12522, transcripts of five v0.13.20 sessions): classic.SessionStart, then
// session.start (surface null on desktop, the app attaches after), then the first prompt, which the app runs the hook for twice at once. The
// start text is slow (dashboard reads), so the call WITHOUT it used to stamp first and take the date: the one the model read, the one holding
// the start, read `+0s` with no date.
const SESSION_START = { cwd: '/work', isInteractive: false } as const

for (const surface of SURFACES) {
  describe(`the first stamp of a fresh session on ${surface}`, () => {
    test('is on the prompt the model reads (the one holding the start text), with the full date and +0', async ($, on) => {
      const d = dashboard(on, { connected: true })
      on('classic.SessionStart', () => ({}) as any)
      await $.classic.SessionStart({ source: 'startup', cwd: '/work', session_id: 's1', transcript_path: '/work/main.jsonl' })
      await $.session.start({ ...SESSION_START, surface: surface === 'desktop' ? null : surface } as any)
      await d.clock.settle()
      const [first, second] = await Promise.all([$.prompt.submit({ text: 'hello' }), $.prompt.submit({ text: 'hello' })])
      expect(first.context).toHaveLength(2)
      expect(first.context![0]).toMatch(FULL)
      expect(second.context).toHaveLength(1)
      expect(second.context![0]).toMatch(TIME_ONLY)
    })

    test('two tool results landing together stamp in the order the start was taken: the one with the start carries the date', async ($, on) => {
      const d = dashboard(on, { connected: true })
      on('classic.SessionStart', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      await $.classic.SessionStart({ source: 'startup', cwd: '/work', session_id: 's1', transcript_path: '/work/main.jsonl' })
      await $.session.start({ ...SESSION_START, surface: surface === 'desktop' ? null : surface } as any)
      await d.clock.settle()
      const [first, second] = await Promise.all([$.tool.call({ tool: 'Bash', command: 'a' } as any), $.tool.call({ tool: 'Bash', command: 'b' } as any)])
      expect(first.context).toHaveLength(2)
      expect(first.context![0]).toMatch(FULL)
      expect(second.context).toHaveLength(0)
    })
  })
}
