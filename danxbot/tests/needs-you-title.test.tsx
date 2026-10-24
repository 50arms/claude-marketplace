import "./run-tests-with-npm-test.generated"
// The session title leads with a hand exactly while the band shows a Needs You count (needsYouTitle): the same count, hidden on a failed load.
import { describe, expect } from 'claude-code/testing'

import { EMPTY } from '../hooks/plan/config'
import { NEEDS_YOU_TITLE_MARK, needsYouTitle } from '../hooks/plan/words'
import { test, dashboard, forceRefresh, startSession } from './plan-kit'

const TITLE = 'Danxbot I: PLAN-18 Card plugins'
const ready = (needsYou: number | null) => ({ ...EMPTY, phase: 'ready', needsYou }) as any

describe('needsYouTitle', () => {
  test('marks the title while the plan has cards that need a person, and only then', async () => {
    expect(needsYouTitle(TITLE, ready(2))).toBe(`${NEEDS_YOU_TITLE_MARK}${TITLE}`)
    expect(needsYouTitle(TITLE, ready(0))).toBe(TITLE)
    // an unknown count is no count: the band draws no badge
    expect(needsYouTitle(TITLE, ready(null))).toBe(TITLE)
  })

  test('a failed or refused load draws no badge, so the title carries no mark', async () => {
    expect(needsYouTitle(TITLE, { ...ready(3), phase: 'error' })).toBe(TITLE)
    expect(needsYouTitle(TITLE, { ...ready(3), phase: 'blocked' })).toBe(TITLE)
  })

  test('a title already marked keeps one mark, whatever form or how many it held', async () => {
    expect(needsYouTitle(`${NEEDS_YOU_TITLE_MARK}${TITLE}`, ready(1))).toBe(`${NEEDS_YOU_TITLE_MARK}${TITLE}`)
    expect(needsYouTitle(`✋ ${TITLE}`, ready(1))).toBe(`${NEEDS_YOU_TITLE_MARK}${TITLE}`)
    expect(needsYouTitle(`✋️ ✋ ${TITLE}`, ready(1))).toBe(`${NEEDS_YOU_TITLE_MARK}${TITLE}`)
    expect(needsYouTitle(`✋️ ✋ ${TITLE}`, ready(0))).toBe(TITLE)
  })

  test('a hand later in the title is the title, never the mark', async () => {
    expect(needsYouTitle(`Say ✋ ${TITLE}`, ready(0))).toBe(`Say ✋ ${TITLE}`)
  })

  test('an empty title stays empty', async () => {
    expect(needsYouTitle('', ready(4))).toBe('')
    expect(needsYouTitle(`${NEEDS_YOU_TITLE_MARK}`, ready(4))).toBe('')
  })
})

describe('the desktop app title follows the count', () => {
  test('a load with cards that need a person marks the app title; a load with none unmarks it; a right title is left alone', async ($, on) => {
    const d = dashboard(on)
    const app = d.world.appSession
    await startSession($, d, 'desktop')
    expect(app.title).toBe(`${NEEDS_YOU_TITLE_MARK}Tendai: PLAN-23 Agent mode`)
    expect(app.set).toEqual([`${NEEDS_YOU_TITLE_MARK}Tendai: PLAN-23 Agent mode`])
    await forceRefresh($, d)
    expect(app.set).toHaveLength(1)
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await forceRefresh($, d)
    expect(app.title).toBe('Tendai: PLAN-23 Agent mode')
    expect(app.set).toHaveLength(2)
  })

  test("the session's own card write re-reads the plan at once: no plan event echoes it, and no turn end is waited for", async ($, on) => {
    const API = 'mcp__plugin_danxbot_danx-dashboard__danxbot_api'
    const d = dashboard(on)
    on('tool.call', { tool: API }, () => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: {} }), isError: false }) as any)
    await startSession($, d, 'desktop')
    expect(d.world.appSession.title).toBe(`${NEEDS_YOU_TITLE_MARK}Tendai: PLAN-23 Agent mode`)
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await $.tool.call({ tool: API, method: 'GET', path: '/api/issues/DX-1/problems' })
    await d.clock.settle()
    // a read changes nothing, so it reloads nothing
    expect(d.world.appSession.title).toBe(`${NEEDS_YOU_TITLE_MARK}Tendai: PLAN-23 Agent mode`)
    await $.tool.call({ tool: API, method: 'DELETE', path: '/api/issues/DX-1/problems/7' })
    await d.clock.settle()
    expect(d.world.appSession.title).toBe('Tendai: PLAN-23 Agent mode')
  })

  test('a terminal session has no app title to set', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    expect(d.world.appSession.set).toEqual([])
  })
})
