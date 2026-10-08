// DX-4534 / DX-4235: the ready-cards Stop check, as a function hook. A plan-connected main session's stop is blocked once while its plan has
// ready cards nobody holds (GET /api/plans/mine, then GET /api/issues on each board the plan spans); with none, on a stop the hook already
// forced, for a sub-agent, or when the read fails, the stop goes on. Checked as the engine runs the hook, on both surfaces, plus the
// definition of "ready" (ported from danxbot's packages/danx-dashboard-mcp ready-cards tests).
import { describe, expect, test } from 'claude-code/testing'

import { READY_CARDS_DEADLINE_MS, blockReason, isReadyCard, parseCardRow, readyCardsOf } from '../hooks/reports/ready-cards'
import type { CardRow } from '../hooks/reports/ready-cards'
import { SURFACES, answerReportEvents, dashboard, startSession } from './plan-kit'

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
    expect(readyCardsOf({ issues: [card(), noDispatch], total: 2 })).toEqual({ ok: false, reason: 'bad_response: a card row lacks a field the check judges' })
  })

  test('a truncated page fails loudly instead of missing cards', () => {
    expect(readyCardsOf({ issues: [card()], total: 2 })).toMatchObject({ ok: false, reason: expect.stringMatching(/^too_many_cards/) })
  })

  test('the reason names at most five cards, counts the rest and ends with the one instruction', () => {
    const cards = Array.from({ length: 7 }, (_, i) => ({ id: `DX-${i + 1}`, title: `Card ${i + 1}` }))
    expect(blockReason(cards)).toBe(`Your plan has 7 ready, unblocked cards nobody is working: DX-1 Card 1; DX-2 Card 2; DX-3 Card 3; DX-4 Card 4; DX-5 Card 5, and 2 more. ${INSTRUCTION}`)
    expect(blockReason([{ id: 'DX-9', title: `${'x'.repeat(85)}` }])).toBe(`Your plan has 1 ready, unblocked card nobody is working: DX-9 ${'x'.repeat(80)}…. ${INSTRUCTION}`)
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
    const reads = (d: any) => d.reports.filter((r: any) => r.method === 'GET')
    const STOP = { stop_hook_active: false, background_tasks: [] } as any

    test('ready cards block the stop once, naming at most five and counting the rest', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = Array.from({ length: 6 }, (_, i) => card({ id: `DX-${i + 1}`, title: `Card ${i + 1}` }))
      d.world.readyRows[BOARD].push(card({ id: 'DX-50', assigned_agent: 'someone' }))
      const r = await $.classic.Stop(STOP)
      expect(r.block).toBe(blockReason(Array.from({ length: 6 }, (_, i) => ({ id: `DX-${i + 1}`, title: `Card ${i + 1}` }))))
      expect(r.block).toContain(', and 1 more.')
      // the issues read asks for the plan's ToDo cards with the judged fields, on its board
      expect(reads(d)[1]).toMatchObject({ path: '/api/issues', board: BOARD, query: { filter: { plan_id: 23, status_derived: 'ToDo' }, limit: 1000, sort: 'priority' } })
    })

    test('no ready card: the stop goes on', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [card({ blocked: { at: 1, reason: 'r', by: 'x' } })]
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      expect(reads(d).map((r: any) => r.path)).toEqual(['/api/plans/mine', '/api/issues'])
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
        expect(reads(d).map((r: any) => r.path)).toEqual(['/api/plans/mine'])
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

    test('a session the dashboard has on no plan (409 session_not_connected) allows the stop quietly', async ($, on) => {
      const d = await started($, on)
      d.world.reportReplies['GET /api/plans/mine'] = { status: 409, body: { error: 'session_not_connected' } }
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('danxbot ready-cards'))).toEqual([])
    })

    test('a session not on a plan reads nothing and its stop is never blocked', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.readyRows[BOARD] = [card()]
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await d.clock.settle()
      expect(d.reports).toEqual([])
    })
  })
}
