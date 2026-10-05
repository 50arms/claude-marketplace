// DX-4336 (PLAN-29 R-1, CAV-4, CAV-6, R-9): the session reports its account's 5-hour and weekly windows on the heartbeat: at session start
// once the plan is read, on session.measure, and on a clock tick (an idle session's figure freezes, so a tick re-sends it); only a
// plan-connected session reports; a failure is toasted once per distinct text.
import { describe, expect, test } from 'claude-code/testing'

import { USAGE_TICK_MS } from '../hooks/plan/config'
import { usageBody } from '../hooks/plan/usage'
import { CLOCK_START, dashboard, startSession } from './plan-kit'

const HEARTBEAT = '/api/plan-sessions/me/heartbeat'
const FIVE = '2026-10-03T11:10:00.000Z'
const WEEK = '2026-10-09T09:00:00.000Z'
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 22, resetsAt: FIVE },
  { kind: 'seven_day', percentUsed: 61, resetsAt: WEEK },
]
const reports = (d: any) => d.api.filter((a: any) => a.method === 'POST' && a.path === HEARTBEAT)
const usageToasts = (d: any) => d.toasts.filter((t: string) => t.startsWith('Usage not reported'))
const iso = (ms: number) => new Date(ms).toISOString()

describe('usageBody (the report as the heartbeat takes it)', () => {
  test('carries each window with its reset time, and the reading time', () => {
    expect(usageBody(WINDOWS, CLOCK_START, undefined)).toEqual({
      reportedAt: iso(CLOCK_START),
      fiveHour: { percentUsed: 22, resetsAt: FIVE },
      sevenDay: { percentUsed: 61, resetsAt: WEEK },
    })
  })

  test('normalizes a reset time the harness wrote with an offset to UTC', () => {
    expect(usageBody([{ kind: 'five_hour', percentUsed: 5, resetsAt: '2026-10-03T13:10:00+02:00' }], CLOCK_START, undefined)?.fiveHour?.resetsAt).toBe(FIVE)
  })

  test('adds the account uuid only when the host set one', () => {
    expect(usageBody(WINDOWS, CLOCK_START, 'ab12-cd34')?.accountUuid).toBe('ab12-cd34')
    expect(usageBody(WINDOWS, CLOCK_START, '')).not.toHaveProperty('accountUuid')
    expect(usageBody(WINDOWS, CLOCK_START, undefined)).not.toHaveProperty('accountUuid')
  })

  test('leaves out a window with no reset time, a spend limit and an unreadable time; reports nothing when none is left', () => {
    expect(usageBody([{ kind: 'five_hour', percentUsed: 5 }, WINDOWS[1]!], CLOCK_START, undefined)).not.toHaveProperty('fiveHour')
    expect(usageBody([{ kind: 'spend_limit', percentUsed: 120, resetsAt: FIVE }], CLOCK_START, undefined)).toBeNull()
    expect(usageBody([{ kind: 'five_hour', percentUsed: 5, resetsAt: 'tomorrow' }], CLOCK_START, undefined)).toBeNull()
    expect(usageBody([], CLOCK_START, undefined)).toBeNull()
  })
})

describe('the report on the heartbeat', () => {
  test('is sent once the plan is read at session start, with the windows and the clock', async ($, on) => {
    const d = dashboard(on)
    d.world.rateLimits = WINDOWS
    await startSession($, d, 'desktop')
    expect(reports(d)).toHaveLength(1)
    expect(reports(d)[0].body).toEqual({
      usage: { reportedAt: iso(CLOCK_START), fiveHour: { percentUsed: 22, resetsAt: FIVE }, sevenDay: { percentUsed: 61, resetsAt: WEEK } },
    })
    expect(usageToasts(d)).toEqual([])
  })

  test('carries the account uuid a desktop-hosted session has', async ($, on) => {
    const d = dashboard(on, { accountUuid: 'ab12-cd34' })
    d.world.rateLimits = WINDOWS
    await startSession($, d, 'desktop')
    expect(reports(d)[0].body.usage.accountUuid).toBe('ab12-cd34')
  })

  test('is not sent when the harness has no windows (off a subscription, or before the first response)', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(USAGE_TICK_MS * 3)
    expect(reports(d)).toEqual([])
  })

  test('is not sent for a session on no plan, at start or on a tick (CAV-4)', async ($, on) => {
    const d = dashboard(on, { connected: false })
    d.world.rateLimits = WINDOWS
    await startSession($, d, 'desktop')
    await d.clock.advance(USAGE_TICK_MS * 2)
    expect(reports(d)).toEqual([])
    expect(usageToasts(d)).toEqual([])
  })

  test('is re-sent on every tick with a new reportedAt even when nothing moved (an idle session freezes, CAV-6)', async ($, on) => {
    const d = dashboard(on)
    d.world.rateLimits = WINDOWS
    await startSession($, d, 'desktop')
    await d.clock.advance(USAGE_TICK_MS)
    await d.clock.advance(USAGE_TICK_MS)
    const sent = reports(d).map((r: any) => r.body.usage)
    expect(sent.length).toBeGreaterThanOrEqual(3)
    expect(sent.at(-1).reportedAt).toBe(iso(CLOCK_START + 2 * USAGE_TICK_MS))
    // the tick reads `$.session.usage()` at the tick: a moved reset time with the same percent is what it carries
    d.world.rateLimits = [{ kind: 'five_hour', percentUsed: 22, resetsAt: '2026-10-03T11:20:00.000Z' }, WINDOWS[1]!]
    await d.clock.advance(USAGE_TICK_MS)
    expect(reports(d).at(-1).body.usage.fiveHour.resetsAt).toBe('2026-10-03T11:20:00.000Z')
  })

  test('is sent when a window moves (session.measure), from the windows the event carries', async ($, on) => {
    const d = dashboard(on)
    on('session.measure', () => ({ changed: ['rateLimits'] }) as any)
    await startSession($, d, 'desktop')
    expect(reports(d)).toEqual([])
    await $.session.measure({ context: {}, rateLimits: [{ kind: 'seven_day', percentUsed: 62, resetsAt: WEEK }], changed: ['rateLimits'] } as any)
    await d.clock.settle()
    expect(reports(d)).toHaveLength(1)
    expect(reports(d)[0].body.usage).toEqual({ reportedAt: iso(CLOCK_START), sevenDay: { percentUsed: 62, resetsAt: WEEK } })
  })

  test('stops with the process: session.end for an exit cancels the timer', async ($, on) => {
    const d = dashboard(on)
    d.world.rateLimits = WINDOWS
    on('session.end', () => ({ sessionId: 's1' }) as any)
    await startSession($, d, 'desktop')
    await $.session.end({ reason: 'prompt_input_exit' } as any)
    const before = reports(d).length
    await d.clock.advance(USAGE_TICK_MS * 3)
    expect(reports(d)).toHaveLength(before)
  })
})

describe('a report that fails', () => {
  test('is toasted once, however many ticks repeat it', async ($, on) => {
    const d = dashboard(on, { usageReply: 'boom' })
    d.world.rateLimits = WINDOWS
    await startSession($, d, 'desktop')
    await d.clock.advance(USAGE_TICK_MS * 3)
    expect(usageToasts(d)).toHaveLength(1)
    expect(usageToasts(d)[0]).toContain('heartbeat boom')
  })

  test("names the dashboard's refusal of a session with no plan", async ($, on) => {
    const d = dashboard(on, { usageReply: 'notConnected' })
    d.world.rateLimits = WINDOWS
    await startSession($, d, 'desktop')
    expect(usageToasts(d)).toHaveLength(1)
    expect(usageToasts(d)[0]).toContain('409')
    expect(usageToasts(d)[0]).toContain('not connected to a plan')
  })

  test('a session.usage that rejects is a toast, never a skipped hook', async ($, on) => {
    const d = dashboard(on, { usageReadFails: 'session.usage is not available on this host' })
    await startSession($, d, 'desktop')
    await d.clock.advance(USAGE_TICK_MS)
    expect(usageToasts(d)).toHaveLength(1)
    expect(usageToasts(d)[0]).toContain('not available on this host')
  })
})
