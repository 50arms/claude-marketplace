import "./run-tests-with-npm-test.generated"
// Session lifecycle and re-entry: what session.end does by reason, the retry while the MCP server
// connects, and what one load reports.
import { describe, expect } from 'claude-code/testing'

import { DISCONNECT_GLYPH, LOAD_DEADLINE_MS, LOAD_ORPHAN_WAIT_MS, LOCK_STALE_MS, SERVER, NOT_CONNECTED_RETRY_MS } from '../hooks/plan/config'
import { test, bandLabelOf, dashboard, expectRowCarries, problemBadgeOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
// DX-4415: the band has no Refresh button; `/danx-plan` forces a load (detached from the command, which returns at once)
const ask = async ($: any, d: any) => {
  await $.command.run({ command: 'danx-plan' })
  await d.clock.advance(1)
}
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
// DX-5232: the plan read is one path: a session start's probe (the relay's) and its load are both /api/plans reads; the probe is the first
const loadsOf = (d: any) => d.api.filter((a: any) => a.path === '/api/plans').length - 1

describe('session.end by reason', () => {
  // DX-4233: what the process's end does to the plan event relay is in plan-relay-lifecycle.test.tsx
  for (const reason of ['clear', 'resume']) {
  test(`a ${reason} refreshes at once: what the dashboard shows may have moved`, async ($, on) => {
    const d = dashboard(on)
    on('session.end', () => ({ sessionId: 's1' }) as any)
    await startSession($, d, 'desktop')
    const before = loadsOf(d)
    await $.session.end({ reason } as any)
    await d.clock.settle()
    expect(loadsOf(d)).toBe(before + 1)
  })
  }
})

describe('the MCP server connects after session start', () => {
  test('a failed first load is retried on a backoff and shows the plan once the server is there', async ($, on) => {
    const d = dashboard(on, { mcp: 'down' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await text(band)).toContain('Disconnected')
    d.setMcp('up')
    await d.clock.advance(2_000)
    expect(await bandLabelOf(band)).toBe('PLAN-23 · Danxbot plugin')
  })

  test('the retries are bounded: one more load per wait, then the view settles on the error', async ($, on) => {
    const d = dashboard(on, { mcp: 'down' })
    await startSession($, d, 'desktop')
    // each wait is advanced on its own, so no poll tick (the usage pacing's) can land inside the sequence
    for (const wait of NOT_CONNECTED_RETRY_MS) await d.clock.advance(wait)
    // DX-5232: the plan read is one path, so the relay's own probe retries are counted by apiCalls; the view's loads are counted apart (one gate claim each)
    expect(d.viewClaims()).toBe(1 + NOT_CONNECTED_RETRY_MS.length)
    await d.clock.advance(30_000)
    expect(d.viewClaims()).toBe(1 + NOT_CONNECTED_RETRY_MS.length)
    // the retries ran out: the reason is told once
    expect(d.toasts.filter(t => t.startsWith('Plan load failed: '))).toHaveLength(1)
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await text(band)).toContain('Disconnected')
  })

  test('a first load that fails with any other error (a refusal, a 500) is not retried at session start', async ($, on) => {
    const d = dashboard(on, { listFails: true })
    await startSession($, d, 'desktop')
    expect(d.viewClaims()).toBe(1)
    for (const wait of NOT_CONNECTED_RETRY_MS) await d.clock.advance(wait)
    expect(d.viewClaims()).toBe(1)
    expect(await text(await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND }))).toContain('Disconnected')
  })

  test('a server that is up needs no retry', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(30_000)
    expect(loadsOf(d)).toBe(1)
  })
})

describe('what one load says about what it did not read', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a response with no total is an error, never a complete list (${surface})`, async ($, on) => {
      const d = dashboard(on, { noInProgressTotal: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(band)).toContain('50 Arms: Disconnected')
      expect(await problemBadgeOf(band)).toBeUndefined()
      expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('red')
      const label = await band.find({ type: 'Text', text: /50 Arms: Disconnected/ })
      expect(label?.props.color).toBe('red')
      expect(label?.props.dimColor).toBeFalsy()
    })
  }
})

describe('expectRowCarries', () => {
  test('matches whole tokens: DX-1 is not found in DX-12', () => {
    expectRowCarries('answered DX-1 PBLM-11', ['DX-1', 'PBLM-11'])
    expect(() => expectRowCarries('answered DX-12 PBLM-110', ['DX-1'])).toThrow()
    expect(() => expectRowCarries('answered DX-12 PBLM-110', ['PBLM-11'])).toThrow()
  })
})

describe('the refresh lock and the busy list at a stale or new start', () => {
  test('a load that never settles: an error at the deadline, ONE load at a time until the orphan is given up, then the refresh asked meanwhile loads', async ($, on) => {
    const d = dashboard(on, { hangFirstLoad: true })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(loadsOf(d)).toBe(1)

    await d.clock.advance(LOAD_DEADLINE_MS / 2)
    await ask($, d)
    expect(loadsOf(d)).toBe(1)

    // DX-4233: the deadline ends the load as an error shown now; the call that never settled still holds the lock, so a refresh in this window
    // starts no second load beside it
    await d.clock.advance(LOAD_DEADLINE_MS / 2 + 1_000)
    expect(await text(band)).toContain('50 Arms: Disconnected')
    await ask($, d)
    expect(loadsOf(d)).toBe(1)

    // past the wait for it the lock is released and the refresh asked behind it runs
    await d.clock.advance(LOAD_ORPHAN_WAIT_MS)
    expect(loadsOf(d)).toBe(2)
    expect(await bandLabelOf(band)).toBe('PLAN-23 · Danxbot plugin')
    // the call that never settled answering at last changes nothing
    d.release()
    await d.clock.settle()
    expect(loadsOf(d)).toBe(2)
    expect(await bandLabelOf(band)).toBe('PLAN-23 · Danxbot plugin')
  })

  // DX-4686: the live sub-agent check is no step of the refresh (a hung one cannot hold the lock), so the step after the load that is held here is
  // the settling of an open permission request, whose claim call is slow on the harness clock
  const PERMISSION_CALL = { tool: 'mcp__plugin_danxbot_danx-dashboard__request_permission', permissions: ['team.members.view'], reason: 'to read members' } as any
  // longer than any wait the two tests below make, so the claim is still out when they end, and ending it advances the clock only this far
  const HELD_MS = LOCK_STALE_MS + 5_000
  const withSlowClaim = async ($: any, on: any) => {
    const d = dashboard(on)
    on('tool.call', { tool: PERMISSION_CALL.tool }, () => ({ result: {}, text: JSON.stringify({ state: 'approval_required', approvalUrl: 'https://danxbot.example/connect/aaaa', confirmCode: 'CODE1', instruction: 'Show the code.' }), isError: false }) as any)
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    await $.tool.call(PERMISSION_CALL)
    d.world.permissionClaimDelayMs = HELD_MS
    const before = loadsOf(d)
    // the command starts a load and holds the lock in its permission step; the test ends it with `endHeld`, so no load is left running into the
    // next test's environment
    await ask($, d)
    expect(loadsOf(d)).toBe(before + 1)
    const endHeld = async () => {
      d.world.permissionClaimDelayMs = 0
      await d.clock.advance(HELD_MS)
      await d.clock.settle()
    }
    return { d, before, endHeld }
  }

  test('a step after the load that never settles holds the lock until it is stale: a refresh before that starts no load, past it the lock is taken over and loads', async ($, on) => {
    const { d, before, endHeld } = await withSlowClaim($, on)
    await d.clock.advance(LOCK_STALE_MS - 1_000)
    await ask($, d)
    expect(loadsOf(d)).toBe(before + 1)
    await d.clock.advance(2_000)
    d.world.permissionClaimDelayMs = 0
    await ask($, d)
    expect(loadsOf(d)).toBe(before + 2)
    await endHeld()
  })

  test('a holder past the load deadline and the orphan wait but inside the tail is not taken over', async ($, on) => {
    const { d, before, endHeld } = await withSlowClaim($, on)
    await d.clock.advance(LOAD_DEADLINE_MS + LOAD_ORPHAN_WAIT_MS + 1_000)
    await ask($, d)
    expect(loadsOf(d)).toBe(before + 1)
    await endHeld()
  })

  test('a load past the deadline that answers within the wait is applied: no second load', async ($, on) => {
    const d = dashboard(on, { hangFirstLoad: true })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await d.clock.advance(LOAD_DEADLINE_MS + 1_000)
    expect(await text(band)).toContain('50 Arms: Disconnected')
    d.release()
    await d.clock.settle()
    expect(loadsOf(d)).toBe(1)
    expect(await bandLabelOf(band)).toBe('PLAN-23 · Danxbot plugin')
  })

  test('a busy key left by an earlier process is cleared at session.start', async ($, on) => {
    const d = dashboard(on, { disconnectTakesMs: 60_000 })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    // a disconnect that never finishes keeps its key claimed, as one cut off by a dying process would
    const leaving = band.press({ key: 'disconnect' })
    await d.clock.advance(1_000)
    expect((await band.find({ key: 'disconnect' }))?.props.dimColor).toBe(true)
    expect((await band.find({ key: 'disconnect' }))?.text).toBe('Disconnecting…')
    // the new start frees the key
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
    expect((await band.find({ key: 'disconnect' }))?.props.dimColor).toBeFalsy()
    await d.clock.advance(60_000)
    await leaving
  })
})
