// DX-4336 (PLAN-29 R-1, CAV-4, CAV-6, R-9): the session reports its account's 5-hour and weekly windows to danxbot: on session.measure, on a
// clock tick (an idle session's figure freezes, so a tick re-sends it), and with the time the figure was MEASURED (the last API response:
// session.measure, a main-thread turn, a sub-agent finishing), which the tick never advances. Only a plan-connected session reports; a
// failure is toasted once per distinct text; the cadence is danxbot's.
import { describe, expect, test } from 'claude-code/testing'

import { USAGE_PATH, USAGE_TICK_MS } from '../hooks/plan/config'
import { usageBody } from '../hooks/plan/usage'
import { CLOCK_START, dashboard, startSession } from './plan-kit'

const FIVE = '2026-10-03T11:10:00.000Z'
const WEEK = '2026-10-09T09:00:00.000Z'
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 22, resetsAt: FIVE },
  { kind: 'seven_day', percentUsed: 61, resetsAt: WEEK },
]
const reports = (d: any) => d.api.filter((a: any) => a.method === 'PUT' && a.path === USAGE_PATH)
const usageToasts = (d: any) => d.toasts.filter((t: string) => t.startsWith('Usage not reported'))
const iso = (ms: number) => new Date(ms).toISOString()
const MEASURE = { context: {}, rateLimits: WINDOWS, changed: ['rateLimits'] } as any
const ANSWER = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any

// a session whose first response has been seen (session.measure), reporting since
async function measuredSession($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
  const d = dashboard(on, options)
  d.world.rateLimits = WINDOWS
  on('session.measure', () => ({ changed: ['rateLimits'] }) as any)
  on('session.end', () => ({ sessionId: 's1' }) as any)
  on('turn.complete', () => ({ text: 'done' }) as any)
  on('classic.SubagentStop', () => ({}) as any)
  await startSession($, d, 'desktop')
  await $.session.measure(MEASURE)
  await d.clock.settle()
  return d
}

describe('usageBody (the report as danxbot takes it)', () => {
  const NOW = CLOCK_START
  const MEASURED = CLOCK_START - 90_000

  test('carries each window with its reset time, when it was sent and when the figure was measured', () => {
    expect(usageBody(WINDOWS, NOW, MEASURED, 0, undefined)).toEqual({
      reportedAt: iso(NOW),
      measuredAt: iso(MEASURED),
      runningAgents: 1,
      fiveHour: { percentUsed: 22, resetsAt: FIVE },
      sevenDay: { percentUsed: 61, resetsAt: WEEK },
    })
  })

  test('reports nothing until a response has been seen: a figure with no age cannot be ranked', () => {
    expect(usageBody(WINDOWS, NOW, null, 0, undefined)).toBeNull()
  })

  test('counts the main thread and every live sub-agent as the agents running', () => {
    expect(usageBody(WINDOWS, NOW, MEASURED, 0, undefined)?.runningAgents).toBe(1)
    expect(usageBody(WINDOWS, NOW, MEASURED, 3, undefined)?.runningAgents).toBe(4)
  })

  test('never claims a measurement after the send', () => {
    expect(usageBody(WINDOWS, NOW, NOW + 5_000, 0, undefined)?.measuredAt).toBe(iso(NOW))
  })

  test('normalizes a reset time the harness wrote with an offset to UTC', () => {
    expect(usageBody([{ kind: 'five_hour', percentUsed: 5, resetsAt: '2026-10-03T13:10:00+02:00' }], NOW, MEASURED, 0, undefined)?.fiveHour?.resetsAt).toBe(FIVE)
  })

  test('adds the account uuid only when the host set one', () => {
    expect(usageBody(WINDOWS, NOW, MEASURED, 0, 'ab12-cd34')?.accountUuid).toBe('ab12-cd34')
    expect(usageBody(WINDOWS, NOW, MEASURED, 0, '')).not.toHaveProperty('accountUuid')
    expect(usageBody(WINDOWS, NOW, MEASURED, 0, undefined)).not.toHaveProperty('accountUuid')
  })

  test('leaves out a window with no reset time, a spend limit and an unreadable time; reports nothing when none is left', () => {
    expect(usageBody([{ kind: 'five_hour', percentUsed: 5 }, WINDOWS[1]!], NOW, MEASURED, 0, undefined)).not.toHaveProperty('fiveHour')
    expect(usageBody([{ kind: 'spend_limit', percentUsed: 120, resetsAt: FIVE }], NOW, MEASURED, 0, undefined)).toBeNull()
    expect(usageBody([{ kind: 'five_hour', percentUsed: 5, resetsAt: 'tomorrow' }], NOW, MEASURED, 0, undefined)).toBeNull()
    expect(usageBody([], NOW, MEASURED, 0, undefined)).toBeNull()
  })
})

describe('the report', () => {
  test('is sent when a window moves (session.measure), with the windows the harness has and the time of that response', async ($, on) => {
    const d = await measuredSession($, on)
    expect(reports(d)).toHaveLength(1)
    expect(reports(d)[0].body).toEqual({
      reportedAt: iso(CLOCK_START),
      measuredAt: iso(CLOCK_START),
      runningAgents: 1,
      fiveHour: { percentUsed: 22, resetsAt: FIVE },
      sevenDay: { percentUsed: 61, resetsAt: WEEK },
    })
    expect(usageToasts(d)).toEqual([])
  })

  test('is not sent before the session has seen a response, however many ticks pass', async ($, on) => {
    const d = dashboard(on)
    d.world.rateLimits = WINDOWS
    await startSession($, d, 'desktop')
    await d.clock.advance(USAGE_TICK_MS * 3)
    expect(reports(d)).toEqual([])
  })

  test('carries the account uuid a desktop-hosted session has', async ($, on) => {
    const d = await measuredSession($, on, { accountUuid: 'ab12-cd34' })
    expect(reports(d)[0].body.accountUuid).toBe('ab12-cd34')
  })

  test('is not sent when the harness has no windows (off a subscription)', async ($, on) => {
    const d = dashboard(on)
    on('session.measure', () => ({ changed: ['context'] }) as any)
    await startSession($, d, 'desktop')
    await $.session.measure({ context: {}, rateLimits: [], changed: ['context'] } as any)
    await d.clock.advance(USAGE_TICK_MS * 3)
    expect(reports(d)).toEqual([])
  })

  test('is not sent for a session on no plan, at a measure or on a tick (CAV-4)', async ($, on) => {
    const d = await measuredSession($, on, { connected: false })
    await d.clock.advance(USAGE_TICK_MS * 2)
    expect(reports(d)).toEqual([])
    expect(usageToasts(d)).toEqual([])
  })

  test('is re-sent on every tick with a new reportedAt, and the tick never advances measuredAt (an idle session freezes, CAV-6)', async ($, on) => {
    const d = await measuredSession($, on)
    await d.clock.advance(USAGE_TICK_MS)
    await d.clock.advance(USAGE_TICK_MS)
    const sent = reports(d).map((r: any) => r.body)
    expect(sent).toHaveLength(3)
    expect(sent.map((b: any) => b.reportedAt)).toEqual([iso(CLOCK_START), iso(CLOCK_START + USAGE_TICK_MS), iso(CLOCK_START + 2 * USAGE_TICK_MS)])
    expect(sent.map((b: any) => b.measuredAt)).toEqual([iso(CLOCK_START), iso(CLOCK_START), iso(CLOCK_START)])
    // the tick reads `$.session.usage()` at the tick: a moved reset time with the same percent is what it carries
    d.world.rateLimits = [{ kind: 'five_hour', percentUsed: 22, resetsAt: '2026-10-03T11:20:00.000Z' }, WINDOWS[1]!]
    await d.clock.advance(USAGE_TICK_MS)
    expect(reports(d).at(-1).body.fiveHour.resetsAt).toBe('2026-10-03T11:20:00.000Z')
  })

  test('measuredAt advances on every session.measure, which fires after each main-thread turn', async ($, on) => {
    const d = await measuredSession($, on)
    await d.clock.advance(USAGE_TICK_MS * 2)
    await $.session.measure(MEASURE)
    await d.clock.advance(USAGE_TICK_MS)
    expect(reports(d).at(-1).body.measuredAt).toBe(iso(CLOCK_START + USAGE_TICK_MS * 2))
  })

  test('measuredAt does not advance on a turn that is not a measurement: turn.complete alone leaves it where session.measure put it', async ($, on) => {
    const d = await measuredSession($, on)
    await d.clock.advance(USAGE_TICK_MS)
    await $.turn.complete(ANSWER)
    await d.clock.advance(USAGE_TICK_MS)
    expect(reports(d).at(-1).body.measuredAt).toBe(iso(CLOCK_START))
  })

  test("measuredAt advances when a sub-agent finishes: its burn moved the parent's figure (R-9)", async ($, on) => {
    const d = await measuredSession($, on)
    await d.clock.advance(USAGE_TICK_MS)
    await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '' })
    await d.clock.advance(USAGE_TICK_MS)
    expect(reports(d).at(-1).body.measuredAt).toBe(iso(CLOCK_START + USAGE_TICK_MS))
  })

  test('stops with the process: session.end for an exit cancels the timer', async ($, on) => {
    const d = await measuredSession($, on)
    await $.session.end({ reason: 'prompt_input_exit' } as any)
    const before = reports(d).length
    await d.clock.advance(USAGE_TICK_MS * 3)
    expect(reports(d)).toHaveLength(before)
  })
})

describe('the cadence is danxbot\'s', () => {
  test('a different report_every_ms in the answer replaces the plugin\'s first guess', async ($, on) => {
    const d = await measuredSession($, on, { usageEveryMs: 20_000 })
    expect(reports(d)).toHaveLength(1)
    await d.clock.advance(20_000)
    await d.clock.advance(20_000)
    expect(reports(d)).toHaveLength(3)
  })

  test('an answer with no usable cadence is a toast, and the first guess stands', async ($, on) => {
    const d = await measuredSession($, on, { usageReply: 'noCadence' })
    expect(usageToasts(d)).toHaveLength(1)
    expect(usageToasts(d)[0]).toContain('report_every_ms')
    await d.clock.advance(USAGE_TICK_MS)
    expect(reports(d)).toHaveLength(2)
  })
})

describe('a report that fails', () => {
  test('is toasted once, however many ticks repeat it', async ($, on) => {
    const d = await measuredSession($, on, { usageReply: 'boom' })
    await d.clock.advance(USAGE_TICK_MS * 3)
    expect(reports(d)).toHaveLength(4)
    expect(usageToasts(d)).toHaveLength(1)
    expect(usageToasts(d)[0]).toContain('usage boom')
  })

  test("names the dashboard's refusal of a session with no plan", async ($, on) => {
    const d = await measuredSession($, on, { usageReply: 'notConnected' })
    expect(usageToasts(d)).toHaveLength(1)
    expect(usageToasts(d)[0]).toContain('409')
    expect(usageToasts(d)[0]).toContain('not connected to a plan')
  })

  test('a failure is shown again after nothing was left to report in between', async ($, on) => {
    const d = await measuredSession($, on, { usageReply: 'boom' })
    expect(usageToasts(d)).toHaveLength(1)
    // the windows go away (nothing to report): the old failure is cleared, so the same failure is news again
    d.world.rateLimits = []
    await d.clock.advance(USAGE_TICK_MS)
    d.world.rateLimits = WINDOWS
    await d.clock.advance(USAGE_TICK_MS)
    expect(usageToasts(d)).toHaveLength(2)
  })

  test('a session.usage that rejects is a toast, never a skipped hook', async ($, on) => {
    const d = dashboard(on, { usageReadFails: 'session.usage is not available on this host' })
    await startSession($, d, 'desktop')
    await d.clock.advance(USAGE_TICK_MS * 2)
    expect(usageToasts(d)).toHaveLength(1)
    expect(usageToasts(d)[0]).toContain('not available on this host')
  })
})
