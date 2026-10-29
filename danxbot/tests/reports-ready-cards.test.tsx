import "./run-tests-with-npm-test.generated"
// DX-4534 / DX-4235: the ready-cards Stop check, as a function hook. A plan-connected main session's stop is blocked once while its plan has
// ready cards nobody holds (GET /api/plans/mine, then GET /api/issues on each board the plan spans); with none, on a stop the hook already
// forced, for a sub-agent, or when the read fails, the stop goes on. Checked as the engine runs the hook, on both surfaces, plus the
// definition of "ready" (ported from danxbot's packages/danx-dashboard-mcp ready-cards tests).
import { describe, expect } from 'claude-code/testing'

import { OLDER_DASHBOARD_LINE, PAUSE_PATH, pauseOf } from '../hooks/reports/pause'
import { READY_CARDS_DEADLINE_MS, blockReason, isReadyCard, parseCardRow, planOf, readyCardsOf } from '../hooks/reports/ready-cards'
import type { CardRow } from '../hooks/reports/ready-cards'
import { test, CLOCK_START, SURFACES, answerReportEvents, dashboard, forceRefresh, startSession } from './plan-kit'

const BOARD = 'danxbot:danxbot-main'
const GPT_BOARD = 'gpt-manager:gpt-manager-main'
const INSTRUCTION = 'Dispatch each now, or record on the card why it cannot run (dependency, problem, block).'

function card(over: Partial<CardRow> = {}): CardRow {
  return { id: 'DX-1', type: 'Story', title: 'A card', assigned_agent: null, dispatch: null, blocked: null, open_problem_count: 0, waiting_on: false, conflict_on_active_count: 0, ...over }
}

describe('ready (pure)', () => {
  test('a free Story, Bug or Chore is ready', () => {
    for (const type of ['Story', 'Bug', 'Chore']) expect(isReadyCard(card({ type }))).toBe(true)
  })

  test('an Epic, Feature or Task never counts: it is never dispatched', () => {
    for (const type of ['Epic', 'Feature', 'Task']) expect(isReadyCard(card({ type }))).toBe(false)
  })

  test('each holder or obstacle disqualifies a card', () => {
    const cases: Partial<CardRow>[] = [
      { assigned_agent: 'some-session' },
      { dispatch: { started_at: 1 } },
      { blocked: { at: 1, reason: 'r', by: 'x' } },
      { open_problem_count: 1 },
      { waiting_on: true },
      { conflict_on_active_count: 1 },
    ]
    for (const over of cases) expect(isReadyCard(card(over))).toBe(false)
  })

  test('a row missing a judged field, or with one of the wrong type, is a bad_response, never counted on a guess', () => {
    const { dispatch, ...noDispatch } = card()
    expect(parseCardRow(noDispatch)).toBeNull()
    expect(parseCardRow(card({ open_problem_count: '0' as any }))).toBeNull()
    expect(parseCardRow(card({ waiting_on: 'false' as any }))).toBeNull()
    expect(parseCardRow(card({ conflict_on_active_count: '0' as any }))).toBeNull()
    expect(parseCardRow(card({ assigned_agent: 7 as any }))).toBeNull()
    expect(parseCardRow(card())).toEqual(card())
    expect(readyCardsOf({ issues: [card(), noDispatch], total: 2 })).toEqual({ ok: false, reason: 'bad_response: a card row lacks a field the check judges' })
  })

  test("the plan read needs a numeric id and a list of board ids", () => {
    expect(planOf({ id: 23, boards: ['danxbot:danxbot-main'] })).toEqual({ ok: true, value: { planId: 23, boards: ['danxbot:danxbot-main'] } })
    expect(planOf({ id: 23, boards: [7] }).ok).toBe(false)
    expect(planOf({ id: '23', boards: [] }).ok).toBe(false)
    expect(planOf({ id: 23 }).ok).toBe(false)
  })

  test('a truncated page fails loudly instead of missing cards', () => {
    expect(readyCardsOf({ issues: [card()], total: 2 })).toMatchObject({ ok: false, reason: expect.stringMatching(/^too_many_cards/) })
  })

  test('the reason names at most five cards, counts the rest and ends with the one instruction', () => {
    const cards = Array.from({ length: 7 }, (_, i) => ({ id: `DX-${i + 1}`, title: `Card ${i + 1}` }))
    expect(blockReason(cards)).toBe(`Your plan has 7 ready, unblocked cards nobody is working: DX-1 Card 1; DX-2 Card 2; DX-3 Card 3; DX-4 Card 4; DX-5 Card 5, and 2 more. ${INSTRUCTION}`)
    expect(blockReason([{ id: 'DX-9', title: '  Fix\n  the   thing ' }])).toBe(`Your plan has 1 ready, unblocked card nobody is working: DX-9 Fix the thing. ${INSTRUCTION}`)
    expect(blockReason([{ id: 'DX-9', title: `${'x'.repeat(85)}` }])).toBe(`Your plan has 1 ready, unblocked card nobody is working: DX-9 ${'x'.repeat(80)}…. ${INSTRUCTION}`)
  })
})

describe('the pause (pure)', () => {
  const NOW = Date.parse('2026-10-13T21:00:00.000Z')
  const agent = (until: string) => ({ pause: { limit: 'agent', state: 'agent_waiting', reason: 'r', until } })

  test('only an unexpired agent pause is paused', () => {
    expect(pauseOf(agent('2026-10-13T22:00:00.000Z'), NOW)).toEqual({ kind: 'paused', reason: 'r', until: Date.parse('2026-10-13T22:00:00.000Z') })
    expect(pauseOf(agent('2026-10-13T21:00:00.000Z'), NOW)).toEqual({ kind: 'free' })
    expect(pauseOf({ pause: null }, NOW)).toEqual({ kind: 'free' })
    expect(pauseOf({ pause: { limit: 'weekly', until: '2026-10-14T00:00:00.000Z' } }, NOW)).toEqual({ kind: 'free' })
  })

  test('a malformed answer is a failure, never a guess', () => {
    for (const body of [{}, null, { pause: 'x' }, agent('not a date'), { pause: { limit: 'agent', until: '2026-10-13T22:00:00.000Z' } }]) {
      expect(pauseOf(body, NOW)).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/^bad_response/) })
    }
  })
})

for (const surface of SURFACES) {
  describe(`the ready-cards check on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      answerReportEvents(on)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      return d
    }
    const reads = (d: any) => d.reports.filter((r: any) => r.method === 'GET' && r.path !== PAUSE_PATH)
    const pauseReads = (d: any) => d.reports.filter((r: any) => r.path === PAUSE_PATH)
    const STOP = { stop_hook_active: false, background_tasks: [] } as any

    test('ready cards block the stop once, naming at most five and counting the rest', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = Array.from({ length: 6 }, (_, i) => card({ id: `DX-${i + 1}`, title: `Card ${i + 1}` }))
      d.world.readyRows[BOARD].push(card({ id: 'DX-50', assigned_agent: 'someone' }))
      const r = await $.classic.Stop(STOP)
      expect(r.block).toBe(blockReason(Array.from({ length: 6 }, (_, i) => ({ id: `DX-${i + 1}`, title: `Card ${i + 1}` }))))
      expect(r.block).toContain(', and 1 more.')
      // the issues read asks for the plan's ToDo cards with the judged fields, on its board (the stand-in answers only the fields named)
      expect(reads(d)[1]).toEqual({
        method: 'GET',
        path: '/api/issues',
        body: undefined,
        board: BOARD,
        query: {
          filter: { plan_id: 23, status_derived: 'ToDo' },
          fields: { dispatch: true, blocked: true, open_problem_count: true, waiting_on: true, conflict_on_active_count: true },
          limit: 1000,
          sort: 'priority',
        },
      })
    })

    test('no ready card: the stop goes on', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card({ blocked: { at: 1, reason: 'r', by: 'x' } })]
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      expect(reads(d).map((r: any) => r.path)).toEqual(['/api/plans/mine', '/api/issues', '/api/plans/23/connected-session/detail'])
    })

    test('a stop the hook already forced (stop_hook_active) reads nothing and goes on', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      expect((await $.classic.Stop({ ...STOP, stop_hook_active: true })).block).toBeUndefined()
      expect(reads(d)).toEqual([])
    })

    test("a sub-agent's stop never blocks", async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      expect((await $.classic.Stop({ ...STOP, agent_id: 'a1' })).block).toBeUndefined()
      expect((await $.classic.SubagentStop({ ...STOP, agent_id: 'a1', agent_transcript_path: '/x/agent-a1.jsonl', agent_type: 'Explore' })).block).toBeUndefined()
      expect(reads(d)).toEqual([])
    })

    test('a plan spanning two boards reads both, and a ready card on the second counts', async ($, on) => {
      const d = await started($, on)
      d.world.planBoards = [BOARD, GPT_BOARD]
      d.world.readyRows[GPT_BOARD] = [card({ id: 'SG-7', title: 'Second board' })]
      const r = await $.classic.Stop(STOP)
      expect(reads(d).filter((x: any) => x.path === '/api/issues').map((x: any) => x.board)).toEqual([BOARD, GPT_BOARD])
      expect(r.block).toContain('SG-7 Second board')
    })

    for (const signedOut of ['lapsed', 'revoked'] as const) {
      test(`a session whose key is ${signedOut} allows the stop and says nothing`, async ($, on) => {
        const d = await started($, on)
        // the key goes while the band's view still holds the plan: the check runs, and the refusal is quiet
        d.world.signedOut = signedOut
        d.world.readyRows[BOARD] = [card()]
        expect((await $.classic.Stop(STOP)).block).toBeUndefined()
        await d.clock.settle()
        // the pause is read first and refused the same way: nothing else is read
        expect(pauseReads(d)).toHaveLength(1)
        expect(reads(d)).toEqual([])
        expect(d.toasts.filter(t => t.startsWith('danxbot ready-cards'))).toEqual([])
      })
    }

    test('any other failed read allows the stop with one line naming why: a refused plan read, a bad card row, a board read that fails', async ($, on) => {
      const d = await started($, on)
      d.world.reportReplies['GET /api/plans/mine'] = { status: 500, body: { error: 'plans boom' } }
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      d.world.reportReplies['GET /api/plans/mine'] = {}
      d.world.readyRows[BOARD] = [{ id: 'DX-1', type: 'Story', title: 'no judged fields', assigned_agent: null }]
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      d.world.reportReplies['GET /api/issues'] = { deny: 'request timed out after 60000ms' }
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('danxbot ready-cards'))).toEqual([
        'danxbot ready-cards check skipped (the stop is allowed): 500: plans boom',
        'danxbot ready-cards check skipped (the stop is allowed): bad_response: a card row lacks a field the check judges',
        'danxbot ready-cards check skipped (the stop is allowed): mcp: danxbot: $.mcp.call: request timed out after 60000ms',
      ])
    })

    test('a dashboard that does not answer within the deadline allows the stop with one line', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      d.world.reportReplies['GET /api/plans/mine'] = { delayMs: READY_CARDS_DEADLINE_MS * 3 }
      const stopping = $.classic.Stop(STOP)
      await d.clock.advance(READY_CARDS_DEADLINE_MS)
      expect((await stopping).block).toBeUndefined()
      expect(d.toasts.filter(t => t.startsWith('danxbot ready-cards'))).toEqual(['danxbot ready-cards check skipped (the stop is allowed): timeout: no answer within 8 s'])
    })

    test('while a plan refresh has failed (the plan state unknown) the check still runs: the dashboard says which plan the session is on', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      d.failList()
      await forceRefresh($, d)
      expect((await $.classic.Stop(STOP)).block).toBe(blockReason([{ id: 'DX-1', title: 'A card' }]))
    })

    test('any other 409 on the plan read is a failure the person sees, not "no plan"', async ($, on) => {
      const d = await started($, on)
      d.world.reportReplies['GET /api/plans/mine'] = { status: 409, body: { error: 'session_is_worker' } }
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('danxbot ready-cards'))).toEqual(['danxbot ready-cards check skipped (the stop is allowed): 409: session_is_worker'])
    })

    test('a session the dashboard has on no plan (409 session_not_connected) allows the stop quietly', async ($, on) => {
      const d = await started($, on)
      d.world.reportReplies['GET /api/plans/mine'] = { status: 409, body: { error: 'session_not_connected' } }
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('danxbot ready-cards'))).toEqual([])
    })

    const AGENT_PAUSE = (until: string) => ({ limit: 'agent', state: 'agent_waiting', reason: 'waiting for a build', ends_when: null, since: '2026-10-13T20:00:00.000Z', until, held: 0 })
    const CARD_BLOCK = blockReason([{ id: 'DX-1', title: 'A card' }])

    test('a session in an unexpired agent pause is not reminded, and no card is read: only the pause read is made', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      d.world.pause = AGENT_PAUSE(new Date(CLOCK_START + 3_600_000).toISOString())
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      expect(pauseReads(d)).toHaveLength(1)
      expect(reads(d)).toEqual([])
    })

    test('an agent pause past its expiry, a usage pause and no pause all leave the reminder on', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      for (const pause of [null, AGENT_PAUSE(new Date(CLOCK_START - 60_000).toISOString()), { limit: 'five_hour', until: new Date(CLOCK_START + 3_600_000).toISOString() }]) {
        d.world.pause = pause
        expect((await $.classic.Stop(STOP)).block).toBe(CARD_BLOCK)
      }
    })

    test('a pause read that fails allows the stop with one line naming why, and reads no card', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      d.world.reportReplies[`GET ${PAUSE_PATH}`] = { status: 500, body: { error: 'pause boom' } }
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await d.clock.settle()
      expect(reads(d)).toEqual([])
      expect(d.toasts.filter(t => t.startsWith('danxbot ready-cards'))).toEqual(['danxbot ready-cards check skipped (the stop is allowed): 500: pause boom'])
    })

    test('a dashboard without the pause route behaves as not paused and says so once', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      d.world.reportReplies[`GET ${PAUSE_PATH}`] = { status: 404, body: { error: 'Not found' } }
      expect((await $.classic.Stop(STOP)).block).toBe(CARD_BLOCK)
      expect((await $.classic.Stop(STOP)).block).toBe(CARD_BLOCK)
      await d.clock.settle()
      expect(d.toasts.filter(t => t === OLDER_DASHBOARD_LINE)).toHaveLength(1)
    })

    test('a session the dashboard has never seen (404 has never registered) is not paused and is not told it has an older dashboard', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card()]
      d.world.reportReplies[`GET ${PAUSE_PATH}`] = { status: 404, body: { error: 'Session s1 has never registered', message_id: 'issuesDb.sessionNeverRegistered' } }
      expect((await $.classic.Stop(STOP)).block).toBe(CARD_BLOCK)
      await d.clock.settle()
      expect(d.toasts.filter(t => t === OLDER_DASHBOARD_LINE)).toEqual([])
    })

    test('a session not on a plan finds no plan to read cards of, and its stop is never blocked', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.readyRows[BOARD] = [card()]
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await d.clock.settle()
      // DX-5593: a signed-in session on no plan is reported on like any other, so the check runs: it asks for the pause and the plan, is told there is none,
      // and reads no card
      expect(d.reports.map(r => `${r.method} ${r.path}`)).toEqual(['GET /api/plan-sessions/me/pause', 'GET /api/plans/mine'])
    })
  })
}
