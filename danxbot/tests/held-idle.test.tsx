import "./run-tests-with-npm-test.generated"
// CP-34 / DEC-116: the held-idle Stop check, in the same Stop registration as the ready-cards check. A plan session's stop is blocked once while it
// holds a card nothing is working (GET /api/plans/<id>/connected-session/detail: `activity` null, and no work mark of the session's own on it);
// a failed or slow read never blocks.
import { describe, expect } from 'claude-code/testing'

import { WORK_MARK_TTL_MS, heldIdleOf, heldIdleReason, liveMarks, marksAfter } from '../hooks/reports/held-idle'
import { READY_CARDS_DEADLINE_MS, blockReason } from '../hooks/reports/ready-cards'
import { test, SURFACES, answerReportEvents, dashboard, startSession } from './plan-kit'

const BOARD = 'danxbot:danxbot-main'
const DETAIL = '/api/plans/23/connected-session/detail'
const API = 'mcp__plugin_danxbot_danx-dashboard__danxbot_api'
const held = (id: string, activity: string | null, title = `Card ${id}`) => ({ id, title, activity })
const MARK = { resource: { type: 'issue', id: 'DX-1' }, note: 'landing it' }

describe('held idle (pure)', () => {
  test("a held card with no activity and no mark is idle; a sub-agent or tool on it, or the session's own mark, makes it active", () => {
    const rows = [held('DX-1', null), held('DX-2', 'Agent: Build'), held('DX-3', 'Bash'), held('DX-4', null)]
    expect(heldIdleOf({ detail: { cards: rows } }, new Set())).toEqual({ ok: true, value: [{ id: 'DX-1', title: 'Card DX-1' }, { id: 'DX-4', title: 'Card DX-4' }] })
    expect(heldIdleOf({ detail: { cards: rows } }, new Set(['DX-1']))).toEqual({ ok: true, value: [{ id: 'DX-4', title: 'Card DX-4' }] })
  })

  test('a malformed answer is a bad_response, never a guess', () => {
    for (const body of [null, {}, { detail: {} }, { detail: { cards: [held('DX-1', 7 as any)] } }, { detail: { cards: [{ id: 'DX-1', activity: null }] } }]) {
      expect(heldIdleOf(body, new Set())).toMatchObject({ ok: false, reason: expect.stringMatching(/^bad_response/) })
    }
  })

  test('only a PUT of a mark on a card sets one, a DELETE clears it, and a mark lives 30 minutes', () => {
    const set = marksAfter({}, 'PUT', '/api/work-marks', MARK, 1000)
    expect(set).toEqual({ 'DX-1': 1000 })
    expect(marksAfter(set, 'GET', '/api/work-marks', MARK, 2000)).toEqual(set)
    expect(marksAfter(set, 'PUT', '/api/issues', MARK, 2000)).toEqual(set)
    expect(marksAfter(set, 'PUT', '/api/work-marks', { resource: { type: 'problem', id: '4' } }, 2000)).toEqual(set)
    expect(marksAfter(set, 'PUT', '/api/work-marks', {}, 2000)).toEqual(set)
    expect(marksAfter(set, 'DELETE', '/api/work-marks', MARK, 2000)).toEqual({})
    expect([...liveMarks(set, 1000 + WORK_MARK_TTL_MS - 1)]).toEqual(['DX-1'])
    expect([...liveMarks(set, 1000 + WORK_MARK_TTL_MS)]).toEqual([])
  })

  test('the reason names at most five cards, counts the rest and gives the release call', () => {
    const cards = Array.from({ length: 7 }, (_, i) => ({ id: `DX-${i + 1}`, title: `Card ${i + 1}` }))
    const reason = heldIdleReason(cards)
    expect(reason).toContain('You hold 7 cards nobody is working: DX-1 Card 1; DX-2 Card 2; DX-3 Card 3; DX-4 Card 4; DX-5 Card 5, and 2 more.')
    expect(reason).toContain('DELETE /api/issues/<id>/assigned-agent')
    expect(heldIdleReason([cards[0]])).toContain('You hold 1 card nobody is working: DX-1 Card 1.')
  })
})

for (const surface of SURFACES) {
  describe(`the held-idle check on ${surface}`, () => {
    const STOP = { stop_hook_active: false, background_tasks: [] } as any
    async function started($: any, on: any) {
      answerReportEvents(on)
      const d = dashboard(on)
      on('tool.call', { tool: API }, () => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: {} }), isError: false }) as any)
      await startSession($, d, surface)
      return d
    }
    const skipped = (d: any) => d.toasts.filter((t: string) => t.startsWith('danxbot held-cards'))
    const reason = (id: string, title = `Card ${id}`) => heldIdleReason([{ id, title }])

    test("an idle held card blocks the stop, naming it and the release call; the detail is read from the plan's own path", async ($, on) => {
      const d = await started($, on)
      d.world.heldRows = [held('DX-1', null, 'Idle one'), held('DX-2', 'Agent: Build')]
      const blocked = (await $.classic.Stop(STOP)).block
      expect(blocked).toBe(reason('DX-1', 'Idle one'))
      expect(blocked).toContain('DX-1 Idle one')
      expect(blocked).toContain('assigned-agent')
      expect(d.reports.filter((x: any) => x.path === DETAIL)).toHaveLength(1)
    })

    test('nothing held idle: the stop goes on silently', async ($, on) => {
      const d = await started($, on)
      d.world.heldRows = [held('DX-2', 'Agent: Build')]
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      d.world.heldRows = []
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await d.clock.settle()
      expect(skipped(d)).toEqual([])
    })

    test('a stop the hook already forced reads no detail and goes on', async ($, on) => {
      const d = await started($, on)
      d.world.heldRows = [held('DX-1', null)]
      expect((await $.classic.Stop({ ...STOP, stop_hook_active: true })).block).toBeUndefined()
      expect(d.reports.filter((x: any) => x.path === DETAIL)).toEqual([])
    })

    test("the session's own work mark makes the card active until it is cleared", async ($, on) => {
      const d = await started($, on)
      d.world.heldRows = [held('DX-1', null)]
      await $.tool.call({ tool: API, method: 'PUT', path: '/api/work-marks', body: MARK })
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await $.tool.call({ tool: API, method: 'DELETE', path: '/api/work-marks', body: { resource: MARK.resource } })
      expect((await $.classic.Stop(STOP)).block).toBe(reason('DX-1'))
    })

    test('a mark past its 30 minutes no longer counts', async ($, on) => {
      const d = await started($, on)
      d.world.heldRows = [held('DX-1', null)]
      await $.tool.call({ tool: API, method: 'PUT', path: '/api/work-marks', body: MARK })
      await d.clock.advance(WORK_MARK_TTL_MS)
      expect((await $.classic.Stop(STOP)).block).toBe(reason('DX-1'))
    })

    test('a failed detail read allows the stop with one line and leaves the ready-cards check working', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [{ id: 'DX-9', type: 'Story', title: 'Ready', assigned_agent: null, dispatch: null, blocked: null, open_problem_count: 0, waiting_on: false, conflict_on_active_count: 0 }]
      d.world.reportReplies[`GET ${DETAIL}`] = { status: 404, body: { error: 'Not found' } }
      expect((await $.classic.Stop(STOP)).block).toBe(blockReason([{ id: 'DX-9', title: 'Ready' }]))
      await d.clock.settle()
      expect(skipped(d)).toEqual(['danxbot held-cards check skipped (the stop is allowed): 404: Not found'])
    })

    test('a dashboard that does not answer within the deadline never blocks the stop', async ($, on) => {
      const d = await started($, on)
      d.world.heldRows = [held('DX-1', null)]
      d.world.reportReplies[`GET ${DETAIL}`] = { delayMs: READY_CARDS_DEADLINE_MS * 3 }
      const stopping = $.classic.Stop(STOP)
      await d.clock.advance(READY_CARDS_DEADLINE_MS)
      expect((await stopping).block).toBeUndefined()
    })

    test('idle held cards and ready cards ride the one block', async ($, on) => {
      const d = await started($, on)
      d.world.heldRows = [held('DX-1', null)]
      d.world.readyRows[BOARD] = [{ id: 'DX-9', type: 'Story', title: 'Ready', assigned_agent: null, dispatch: null, blocked: null, open_problem_count: 0, waiting_on: false, conflict_on_active_count: 0 }]
      expect((await $.classic.Stop(STOP)).block).toBe(`${reason('DX-1')}\n\n${blockReason([{ id: 'DX-9', title: 'Ready' }])}`)
    })
  })
}
