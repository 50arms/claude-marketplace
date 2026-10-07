// Session lifecycle and re-entry: what session.end does by reason, the retry while the MCP server
// connects, and the plan-list cap.
import { describe, expect, test } from 'claude-code/testing'

import { LOAD_DEADLINE_MS, LOAD_ORPHAN_WAIT_MS, LOCK_STALE_MS, PACING_POLL_MS, SERVER, NOT_CONNECTED_RETRY_MS } from '../hooks/plan/config'
import { dashboard, expectRowCarries, problemBadgeOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const loadsOf = (d: any) => d.api.filter((a: any) => a.path === '/api/plans').length

describe('session.end by reason', () => {
  // DX-4233: what the process's end does to the plan event relay is in plan-relay-lifecycle.test.tsx
  for (const reason of ['prompt_input_exit', 'logout', 'other']) {
    test(`${reason} ends the process: the pacing poll stops`, async ($, on) => {
      const d = dashboard(on)
      on('session.end', () => ({ sessionId: 's1' }) as any)
      await startSession($, d, 'desktop')
      await $.session.end({ reason } as any)
      await d.clock.settle()
      const reads = d.teamPacingReads.length
      await d.clock.advance(PACING_POLL_MS * 2 + 1)
      expect(d.teamPacingReads).toHaveLength(reads)
    })
  }

  // a reason not listed keeps the timers: stopping one in a live process is the harm, a timer left in a dying one is not
  for (const reason of ['clear', 'resume', 'some_future_reason']) {
    test(`${reason} leaves the process running: the pacing poll goes on`, async ($, on) => {
      const d = dashboard(on)
      on('session.end', () => ({ sessionId: 's1' }) as any)
      await startSession($, d, 'desktop')
      await $.session.end({ reason } as any)
      await d.clock.settle()
      const reads = d.teamPacingReads.length
      await d.clock.advance(PACING_POLL_MS + 1)
      expect(d.teamPacingReads.length).toBeGreaterThan(reads)
    })
  }

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
    expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
  })

  test('the retries are bounded: one more load per wait, then the view settles on the error', async ($, on) => {
    const d = dashboard(on, { mcp: 'down' })
    await startSession($, d, 'desktop')
    const apiCalls = () => d.calls.filter(c => c.tool === 'danxbot_api' && c.server === SERVER).length
    expect(apiCalls()).toBe(1)
    // each wait is advanced on its own, so no poll tick (the pacing panel's) can land inside the sequence
    for (const wait of NOT_CONNECTED_RETRY_MS) await d.clock.advance(wait)
    expect(apiCalls()).toBe(1 + NOT_CONNECTED_RETRY_MS.length)
    await d.clock.advance(30_000)
    expect(apiCalls()).toBe(1 + NOT_CONNECTED_RETRY_MS.length)
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await text(band)).toContain('Disconnected')
  })

  test('a first load that fails with any other error (a refusal, a 500) is not retried at session start', async ($, on) => {
    const d = dashboard(on, { listFails: true })
    await startSession($, d, 'desktop')
    expect(loadsOf(d)).toBe(1)
    for (const wait of NOT_CONNECTED_RETRY_MS) await d.clock.advance(wait)
    expect(loadsOf(d)).toBe(1)
  })

  test('a server that is up needs no retry', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(30_000)
    expect(loadsOf(d)).toBe(1)
  })
})

describe('what one load says about what it did not read', () => {
  test('more plans than the plan list returned: the picker says how many are in the browser', async ($, on) => {
    const d = dashboard(on, { connected: false, plansTotal: 40 })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    // 3 rows came back (one archived): 37 plans were not read
    expect(await text(pane)).toContain('+37 more plans in the browser')
  })

  test('an empty plan list that is capped says so instead of "No plans found."', async ($, on) => {
    const d = dashboard(on, { connected: false, emptyPlanListOf: 5 })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    expect(await text(pane)).toContain('No plans listed here. +5 more plans in the browser.')
    expect(await text(pane)).not.toContain('No plans found.')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a response with no total is an error, never a complete list (${surface})`, async ($, on) => {
      const d = dashboard(on, { noTotal: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(band)).toContain('Danxbot Plan: Disconnected')
      expect(await problemBadgeOf(band)).toBeUndefined()
      expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('red')
      const label = await band.find({ type: 'Text', text: /Danxbot Plan: Disconnected/ })
      expect(label?.props.color).toBe('red')
      expect(label?.props.dimColor).toBeFalsy()
      expect(await text(pane)).toContain('answered no total')
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
  test('a load that never settles: an error at the deadline, ONE load at a time until the orphan is given up, then the Refresh asked meanwhile loads', async ($, on) => {
    const d = dashboard(on, { hangFirstLoad: true })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    expect(loadsOf(d)).toBe(1)

    await d.clock.advance(LOAD_DEADLINE_MS / 2)
    await pane.press({ key: 'refresh' })
    expect(loadsOf(d)).toBe(1)

    // DX-4233: the deadline ends the load as an error shown now; the call that never settled still holds the lock, so a Refresh in this window
    // starts no second load beside it
    await d.clock.advance(LOAD_DEADLINE_MS / 2 + 1_000)
    expect(await text(pane)).toContain('did not load')
    await pane.press({ key: 'refresh' })
    expect(loadsOf(d)).toBe(1)

    // past the wait for it the lock is released and the Refresh asked behind it runs
    await d.clock.advance(LOAD_ORPHAN_WAIT_MS)
    expect(loadsOf(d)).toBe(2)
    expect(await text(pane)).toContain('Connected: PLAN-23')
    // the call that never settled answering at last changes nothing
    d.release()
    await d.clock.settle()
    expect(loadsOf(d)).toBe(2)
    expect(await text(pane)).toContain('Connected: PLAN-23')
  })

  test('a step after the load that never settles holds the lock until it is stale: a Refresh before that starts no load, past it the lock is taken over and loads', async ($, on) => {
    const d = dashboard(on)
    d.world.agentListHangs = true
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    expect(loadsOf(d)).toBe(1)
    await d.clock.advance(LOCK_STALE_MS - 1_000)
    await pane.press({ key: 'refresh' })
    expect(loadsOf(d)).toBe(1)
    await d.clock.advance(2_000)
    // the press that takes the lock over starts its load at once, but is not awaited: its live step queues behind the one that hung (the live
    // checks run one after another), so the press itself never returns
    void pane.press({ key: 'refresh' })
    await d.clock.advance(1)
    expect(loadsOf(d)).toBe(2)
  })

  test('a holder past the load deadline and the orphan wait but inside the tail is not taken over', async ($, on) => {
    const d = dashboard(on)
    d.world.agentListHangs = true
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await d.clock.advance(LOAD_DEADLINE_MS + LOAD_ORPHAN_WAIT_MS + 1_000)
    await pane.press({ key: 'refresh' })
    expect(loadsOf(d)).toBe(1)
  })

  test('a load past the deadline that answers within the wait is applied: no second load', async ($, on) => {
    const d = dashboard(on, { hangFirstLoad: true })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await d.clock.advance(LOAD_DEADLINE_MS + 1_000)
    expect(await text(pane)).toContain('did not load')
    d.release()
    await d.clock.settle()
    expect(loadsOf(d)).toBe(1)
    expect(await text(pane)).toContain('Connected: PLAN-23')
  })

  test('a busy key left by an earlier process is cleared at session.start', async ($, on) => {
    const d = dashboard(on, { browserClosed: true, navigateTakesMs: 5_000 })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    // an open that never finishes keeps its key claimed, as one cut off by a dying process would
    const opening = band.press({ key: 'open-tab' })
    await d.clock.settle()
    expect((await band.find({ key: 'open-tab' }))?.text).toBe('Opening…')
    // the new start frees the key
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    expect((await band.find({ key: 'open-tab' }))?.text).toBe('Browser tab')
    await d.clock.advance(5_000)
    await opening
  })
})
