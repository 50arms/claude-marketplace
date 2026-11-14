import "./run-tests-with-npm-test.generated"
// CP-34 / DEC-116: the held-idle Stop check, in the same Stop registration as the ready-cards check. A plan session's stop is blocked once while it
// holds a card nothing is working (GET /api/plans/<id>/connected-session/detail: `activity` null, and no sub-agent of the session briefed on it, running or ended in the last few minutes);
// a failed or slow read never blocks.
import { describe, expect } from 'claude-code/testing'

import { BRIEF_PENDING_TTL_MS, NO_BRIEFS, NO_RECENT, RECENT_BRIEF_MS, briefClaimed, briefEnded, briefRecent, briefSpawned, briefedCards, cardIdsIn, heldIdleOf, heldIdleReason } from '../hooks/reports/held-idle'
import { READY_CARDS_DEADLINE_MS, blockReason } from '../hooks/reports/ready-cards'
import { test, SURFACES, answerReportEvents, dashboard, startSession } from './plan-kit'

const BOARD = 7
const DETAIL = '/api/plans/23/connected-session/detail'
const API = 'mcp__plugin_50arms_platform__50arms_api'
const held = (id: string, activity: string | null, title = `Card ${id}`) => ({ id, title, activity })

describe('held idle (pure)', () => {
  test("a held card with no activity and no sub-agent briefed on it is idle; a sub-agent or tool on it, or a card the session has worked, makes it active", () => {
    const rows = [held('DX-1', null), held('DX-2', 'Agent: Build'), held('DX-3', 'Bash'), held('DX-4', null)]
    expect(heldIdleOf({ detail: { cards: rows } }, new Set())).toEqual({ ok: true, value: [{ id: 'DX-1', title: 'Card DX-1' }, { id: 'DX-4', title: 'Card DX-4' }] })
    expect(heldIdleOf({ detail: { cards: rows } }, new Set(['DX-1']))).toEqual({ ok: true, value: [{ id: 'DX-4', title: 'Card DX-4' }] })
  })

  test('a malformed answer is a bad_response, never a guess', () => {
    for (const body of [null, {}, { detail: {} }, { detail: { cards: [held('DX-1', 7 as any)] } }, { detail: { cards: [{ id: 'DX-1', activity: null }] } }]) {
      expect(heldIdleOf(body, new Set())).toMatchObject({ ok: false, reason: expect.stringMatching(/^bad_response/) })
    }
  })

  test("a card a running sub-agent was briefed on is worked; an agent that ended, or a stale unclaimed brief, covers nothing (CP-49)", () => {
    expect(cardIdsIn('Build DX-1 and CP-49, then DX-1 again; not xDX-2y or 12')).toEqual(['DX-1', 'CP-49'])
    expect(cardIdsIn(undefined)).toEqual([])
    let b = briefSpawned(NO_BRIEFS, 'work DX-1', 0)
    b = briefSpawned(b, 'explore the repo', 1)
    b = briefClaimed(b, 'a1', 2)
    b = briefClaimed(b, 'a2', 3)
    expect([...briefedCards(b, ['a1'], NO_RECENT, 4)]).toEqual(['DX-1'])
    expect([...briefedCards(b, ['a2'], NO_RECENT, 4)]).toEqual([])
    expect([...briefedCards(b, [], NO_RECENT, 4)]).toEqual([])
    expect([...briefedCards(briefEnded(b, 'a1'), ['a1'], NO_RECENT, 4)]).toEqual([])
    const stale = briefClaimed(briefSpawned(NO_BRIEFS, 'work DX-1', 0), 'a1', BRIEF_PENDING_TTL_MS)
    expect([...briefedCards(stale, ['a1'], NO_RECENT, BRIEF_PENDING_TTL_MS)]).toEqual([])
  })

  test('the cards of a sub-agent that ended stay worked for five minutes, then fall away (DX-7388)', () => {
    const b = briefClaimed(briefSpawned(NO_BRIEFS, 'work DX-1', 0), 'a1', 1)
    const recent = briefRecent(NO_RECENT, b, 'a1', 1000)
    expect([...briefedCards(briefEnded(b, 'a1'), [], recent, 1000 + RECENT_BRIEF_MS - 1)]).toEqual(['DX-1'])
    expect([...briefedCards(briefEnded(b, 'a1'), [], recent, 1000 + RECENT_BRIEF_MS)]).toEqual([])
    expect(briefRecent(recent, b, 'a1', 1000 + RECENT_BRIEF_MS)).toEqual([{ ids: ['DX-1'], at: 1000 + RECENT_BRIEF_MS }])
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
    const skipped = (d: any) => d.toasts.filter((t: string) => t.startsWith('50 Arms held-cards'))
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

    test('a card a sub-agent was briefed on does not block the stop while it runs or for five minutes after; then it does (CP-49, DX-7388)', async ($, on) => {
      on('agent.spawn', () => ({ model: 'm', agentId: 'new' }) as any)
      const d = await started($, on)
      d.world.heldRows = [held('DX-1', null), held('DX-2', null)]
      await $.agent.spawn({ prompt: 'Build DX-1 on its branch', subagentType: 'general-purpose' })
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })
      expect((await $.classic.Stop(STOP)).block).toBe(reason('DX-2'))
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'general-purpose', background_tasks: [] })
      expect((await $.classic.Stop(STOP)).block).toBe(reason('DX-2'))
      await d.clock.advance(RECENT_BRIEF_MS)
      expect((await $.classic.Stop(STOP)).block).toBe(heldIdleReason([{ id: 'DX-1', title: 'Card DX-1' }, { id: 'DX-2', title: 'Card DX-2' }]))
    })

    test('the ready-cards report leaves out a card a running sub-agent was briefed on, and says nothing when none is left; once none runs it names it (CP-49)', async ($, on) => {
      on('agent.spawn', () => ({ model: 'm', agentId: 'new' }) as any)
      const d = await started($, on)
      const row = (id: string) => ({ id, type: 'Story', title: `Ready ${id}`, assigned_agent: null, dispatch: null, blocked: null, open_problem_count: 0, waiting_on: false, conflict_on_active_count: 0, review_runnable: false, next_pre_gate: null })
      d.world.readyRows[BOARD] = [row('DX-9'), row('DX-8')]
      await $.agent.spawn({ prompt: 'gate-reviewer DX-9 code-quality', subagentType: 'general-purpose' })
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })
      expect((await $.classic.Stop(STOP)).block).toBe(blockReason([{ id: 'DX-8', title: 'Ready DX-8' }]))
      d.world.readyRows[BOARD] = [row('DX-9')]
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'general-purpose', background_tasks: [] })
      await d.clock.advance(RECENT_BRIEF_MS)
      expect((await $.classic.Stop(STOP)).block).toBe(blockReason([{ id: 'DX-9', title: 'Ready DX-9' }]))
    })

    test('a failed detail read allows the stop with one line and leaves the ready-cards check working', async ($, on) => {
      const d = await started($, on)
      d.world.readyRows[BOARD] = [{ id: 'DX-9', type: 'Story', title: 'Ready', assigned_agent: null, dispatch: null, blocked: null, open_problem_count: 0, waiting_on: false, conflict_on_active_count: 0, review_runnable: false, next_pre_gate: null }]
      d.world.reportReplies[`GET ${DETAIL}`] = { status: 404, body: { error: 'Not found' } }
      expect((await $.classic.Stop(STOP)).block).toBe(blockReason([{ id: 'DX-9', title: 'Ready' }]))
      await d.clock.settle()
      expect(skipped(d)).toEqual(['50 Arms held-cards check skipped (the stop is allowed): 404: Not found'])
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
      d.world.readyRows[BOARD] = [{ id: 'DX-9', type: 'Story', title: 'Ready', assigned_agent: null, dispatch: null, blocked: null, open_problem_count: 0, waiting_on: false, conflict_on_active_count: 0, review_runnable: false, next_pre_gate: null }]
      expect((await $.classic.Stop(STOP)).block).toBe(`${reason('DX-1')}\n\n${blockReason([{ id: 'DX-9', title: 'Ready' }])}`)
    })
  })
}
