// Session lifecycle and re-entry: what session.end does by reason, the retry while the MCP server
// connects, the plan-list cap, and one write per answer however many presses land together.
import { describe, expect, test } from 'claude-code/testing'

import { LOCK_STALE_MS, NO_MCP_RETRY_MS } from '../hooks/plan/config'
import { dashboard, expectRowCarries, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const loadsOf = (d: any) => d.api.filter((a: any) => a.path === '/api/plans').length

describe('session.end by reason', () => {
  for (const reason of ['prompt_input_exit', 'logout', 'other']) {
    test(`${reason} ends the process: the refresh timer is cancelled`, async ($, on) => {
      const d = dashboard(on)
      on('session.end', () => ({ sessionId: 's1' }) as any)
      await startSession($, d, 'desktop')
      await $.session.end({ reason } as any)
      const before = loadsOf(d)
      await d.clock.advance(180_000)
      expect(loadsOf(d)).toBe(before)
    })
  }

  for (const reason of ['clear', 'resume', 'some_future_reason']) {
    test(`${reason} leaves the process running: the timer keeps refreshing`, async ($, on) => {
      const d = dashboard(on)
      on('session.end', () => ({ sessionId: 's1' }) as any)
      await startSession($, d, 'desktop')
      await $.session.end({ reason } as any)
      await d.clock.settle()
      const before = loadsOf(d)
      d.world.cards[1]!.problems.push({ id: 22, type: 'question', statement: 'New?', open: true, solutions: [] })
      await d.clock.advance(60_000)
      expect(loadsOf(d)).toBe(before + 1)
      const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
      expect(await text(band)).toContain('4 open problems')
    })
  }

  for (const reason of ['clear', 'resume']) {
  test(`a ${reason} drops what was open or half-typed and refreshes at once`, async ($, on) => {
    const d = dashboard(on)
    on('session.end', () => ({ sessionId: 's1' }) as any)
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'open-11' })
    await pane.press({ key: 'note-112' })
    await pane.press({ key: 'talk-11' })
    expect(await pane.find({ key: 'note-in-112' })).toBeDefined()
    const before = loadsOf(d)
    await $.session.end({ reason } as any)
    await d.clock.settle()
    expect(loadsOf(d)).toBe(before + 1)
    expect(await pane.find({ key: 'use-112' })).toBeUndefined()
    expect(await pane.find({ key: 'note-in-112' })).toBeUndefined()
    expect(await pane.find({ key: 'comment-11' })).toBeUndefined()
  })
  }
})

describe('the MCP server connects after session start', () => {
  test('a no-mcp first load is retried on a backoff and shows the plan once the server is there', async ($, on) => {
    const d = dashboard(on, { mcp: 'down' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await band.findAll({ type: 'Text' })).toHaveLength(0)
    d.setMcp('up')
    await d.clock.advance(2_000)
    expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
  })

  test('the retries are bounded: one more load per wait, then the view settles on no-mcp', async ($, on) => {
    const d = dashboard(on, { mcp: 'down' })
    await startSession($, d, 'desktop')
    const apiCalls = () => d.calls.filter(c => c.tool === 'danxbot_api').length
    expect(apiCalls()).toBe(1)
    // each wait is advanced on its own, so no 60 s timer tick can land inside the sequence
    for (const wait of NO_MCP_RETRY_MS) await d.clock.advance(wait)
    expect(apiCalls()).toBe(1 + NO_MCP_RETRY_MS.length)
    await d.clock.advance(30_000)
    expect(apiCalls()).toBe(1 + NO_MCP_RETRY_MS.length)
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect((await band.findAll({ type: 'Button' })).map((b: any) => b.key)).toEqual(['open-pane', 'band-close'])
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

  test('a card whose comments answer no total is an error, never a complete discussion', async ($, on) => {
    const d = dashboard(on, { noCommentsTotal: true })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    expect(await text(pane)).toContain('answered no comments_page.total')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a response with no total is an error, never a complete list (${surface})`, async ($, on) => {
      const d = dashboard(on, { noTotal: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(band)).toContain('Danxbot Plan: Disconnected')
      expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('red')
      const label = await band.find({ type: 'Text', text: /Danxbot Plan: Disconnected/ })
      expect(label?.props.color).toBe('red')
      expect(label?.props.dimColor).toBeFalsy()
      expect(await text(pane)).toContain('answered no total')
    })
  }
})

describe('one write per answer, however many presses land together', () => {
  const PATHS: { name: string; open: string; act: (pane: any) => Promise<unknown>[]; writes: number }[] = [
    { name: 'option', open: 'open-11', act: pane => [pane.press({ key: 'use-112' }), pane.press({ key: 'use-112' })], writes: 1 },
    { name: 'approve', open: 'open-12', act: pane => [pane.press({ key: 'use-121' }), pane.press({ key: 'use-121' })], writes: 1 },
    { name: 'typed', open: 'open-11', act: pane => [pane.input({ key: 'free-11', text: 'x' }), pane.input({ key: 'free-11', text: 'x' })], writes: 1 },
    { name: 'note', open: 'open-11', act: pane => [pane.input({ key: 'note-in-111', text: 'n' }), pane.input({ key: 'note-in-111', text: 'n' })], writes: 1 },
    { name: 'reject', open: 'open-12', act: pane => [pane.input({ key: 'rej-in-121', text: 'r' }), pane.input({ key: 'rej-in-121', text: 'r' })], writes: 1 },
  ]
  for (const path of PATHS) {
    test(`${path.name}: a double press makes one API call and one row for the model`, async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, 'desktop')
      const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
      await pane.press({ key: path.open })
      if (path.name === 'note') await pane.press({ key: 'note-111' })
      if (path.name === 'reject') await pane.press({ key: 'rej-121' })
      await Promise.allSettled(path.act(pane))
      await d.clock.settle()
      expect(d.writes().filter(w => w.path.endsWith('/answer'))).toHaveLength(path.writes)
      expect(d.toasts.filter(t => t.startsWith('Could not tell the model'))).toHaveLength(1)
    })
  }

  test('two different problems can be answered together', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'open-11' })
    await pane.press({ key: 'use-112' })
    await d.clock.settle()
    await pane.press({ key: 'open-21' })
    await pane.press({ key: 'use-211' })
    await d.clock.settle()
    expect(d.writes().map(w => w.path)).toEqual(['/api/issues/DX-1/problems/11/answer', '/api/issues/DX-2/problems/21/answer'])
  })
})

describe('expectRowCarries', () => {
  test('matches whole tokens: DX-1 is not found in DX-12', () => {
    expectRowCarries('answered DX-1 PBLM-11', ['DX-1', 'PBLM-11'])
    expect(() => expectRowCarries('answered DX-12 PBLM-110', ['DX-1'])).toThrow()
    expect(() => expectRowCarries('answered DX-12 PBLM-110', ['PBLM-11'])).toThrow()
  })
})

describe('the refresh lock and the busy list at a stale or new start', () => {
  test('a load that never settles: a Refresh inside the stale window does not double-load, past it the lock is taken over', async ($, on) => {
    const d = dashboard(on, { hangFirstLoad: true })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    expect(loadsOf(d)).toBe(1)

    await d.clock.advance(LOCK_STALE_MS / 2)
    await pane.press({ key: 'refresh' })
    expect(loadsOf(d)).toBe(1)

    // the 60 s timer ticks inside the window did not load either; past it, a press does
    await d.clock.advance(LOCK_STALE_MS / 2 - 1_000)
    await pane.press({ key: 'refresh' })
    expect(loadsOf(d)).toBe(1)
    await d.clock.advance(2_000)
    await pane.press({ key: 'refresh' })
    expect(loadsOf(d)).toBe(2)
    expect(await text(pane)).toContain('Connected: PLAN-23')
  })

  test('a busy key left by an earlier process is cleared at session.start', async ($, on) => {
    const d = dashboard(on, { hangFirstAnswer: true })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'open-11' })
    // a write in flight that never settles keeps its key claimed, as one cut off by a dying process would
    const hung = pane.press({ key: 'use-112' })
    await d.clock.settle()
    expect(d.writes()).toHaveLength(1)
    await pane.press({ key: 'use-112' })
    expect(d.writes()).toHaveLength(1)
    // the new start frees the key: the answer goes through
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await d.clock.settle()
    await pane.press({ key: 'use-112' })
    await d.clock.settle()
    expect(d.writes()).toHaveLength(2)
    await d.clock.advance(3_600_000)
    await hung
  })
})
