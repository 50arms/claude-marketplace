import "./run-tests-with-npm-test.generated"
// The session title's ONE mark (sessionTitle): red once the session lost its plan or card connection, else the hand while the band shows a
// Needs You count (the same count, hidden on a failed load), else green while connected, else none (a session that never connected).
import { describe, expect } from 'claude-code/testing'

import { EMPTY } from '../hooks/plan/config'
import { RELAY_OFF } from '../hooks/relay/config'
import { CONNECTED_TITLE_MARK, DISCONNECTED_TITLE_MARK, NEEDS_YOU_TITLE_MARK, sessionTitle, titleConnection } from '../hooks/plan/words'
import { test, dashboard, forceRefresh, startSession } from './plan-kit'

const TITLE = 'Danxbot I: PLAN-18 Card plugins'
const AGENT = { id: 1, name: 'Danxbot I', avatar_url: null }
const PLAN = { id: 18, ref: 'PLAN-18', name: 'Card plugins', dashboardUrl: 'https://app.example' }
const OFF = RELAY_OFF as any
const on = (needsYou: number | null) => ({ ...EMPTY, phase: 'ready', needsYou, agent: AGENT, connected: PLAN }) as any
const UP = CONNECTED_TITLE_MARK
const DOWN = DISCONNECTED_TITLE_MARK
const HAND = NEEDS_YOU_TITLE_MARK

describe('the hand', () => {
  test('marks the title while the plan has cards that need a person, and only then', async () => {
    expect(sessionTitle(TITLE, on(2), OFF)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, on(0), OFF)).toBe(`${UP}${TITLE}`)
    // an unknown count is no count: the band draws no badge
    expect(sessionTitle(TITLE, on(null), OFF)).toBe(`${UP}${TITLE}`)
  })

  test('a lost connection outranks the hand: the title carries the red mark alone', async () => {
    expect(sessionTitle(TITLE, { ...on(2), agentBlock: 'agent_not_held' }, OFF)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, on(2), { phase: 'stopped', planId: 18, detail: 'gone' })).toBe(`${DOWN}${TITLE}`)
  })

  test('a failed or refused load draws no badge, so the title carries no hand', async () => {
    expect(sessionTitle(TITLE, { ...on(3), phase: 'error' }, OFF)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, { ...on(3), phase: 'blocked' }, OFF)).toBe(`${DOWN}${TITLE}`)
  })
})

describe('the connection mark', () => {
  test('green while the session holds a plan or a card with its team agent', async () => {
    expect(titleConnection(on(0), OFF)).toBe('up')
    expect(titleConnection({ ...on(0), connected: null, card: { id: 'DX-1', title: 'A card' } }, OFF)).toBe('up')
  })

  test('red once a session that was connected lost it: a failed load, a revoked or lapsed key, no team agent, a stopped relay', async () => {
    expect(titleConnection({ ...on(0), phase: 'error' }, OFF)).toBe('down')
    expect(titleConnection({ ...EMPTY, phase: 'key-revoked', revokedBy: 'Dan' } as any, OFF)).toBe('down')
    expect(titleConnection({ ...EMPTY, phase: 'signed-out', resumePlan: 18 } as any, OFF)).toBe('down')
    expect(titleConnection({ ...on(0), agentBlock: 'agent_not_held' }, OFF)).toBe('down')
    expect(titleConnection({ ...on(0), agent: null }, OFF)).toBe('down')
    expect(titleConnection(on(0), { phase: 'stopped', planId: 18, detail: 'gone' })).toBe('down')
  })

  test("a relay that only retries, or one left over from another plan, is not a lost connection", async () => {
    expect(titleConnection(on(0), { phase: 'retrying', planId: 18, detail: 'blip' })).toBe('up')
    expect(titleConnection(on(0), { phase: 'stopped', planId: 7, detail: 'old plan' })).toBe('up')
  })

  test('no mark on a session that never connected, or one signed in on nothing', async () => {
    expect(titleConnection({ ...EMPTY, phase: 'signed-out' } as any, OFF)).toBeNull()
    expect(titleConnection({ ...EMPTY, phase: 'error', error: 'server not connected' } as any, OFF)).toBeNull()
    expect(titleConnection({ ...EMPTY, phase: 'ready', agent: AGENT } as any, OFF)).toBeNull()
    expect(sessionTitle(TITLE, { ...EMPTY, phase: 'signed-out' } as any, OFF)).toBe(TITLE)
  })

  test('a loading view knows nothing yet, so the title is left exactly as it is', async () => {
    expect(sessionTitle(`${DOWN}${TITLE}`, EMPTY as any, OFF)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, EMPTY as any, OFF)).toBe(TITLE)
  })
})

describe('marks never stack', () => {
  test('a title keeps exactly one mark, whatever marks, forms, order or count it held', async () => {
    expect(sessionTitle(`${HAND}${TITLE}`, on(1), OFF)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`✋ ${TITLE}`, on(1), OFF)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`✋️ 🔴 ✋ 🟢 ${TITLE}`, on(1), OFF)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`${HAND}${TITLE}`, { ...on(0), phase: 'error' }, OFF)).toBe(`${DOWN}${TITLE}`)
  })

  test('a mark later in the title is the title, never a mark', async () => {
    expect(sessionTitle(`Say ✋ 🟢 ${TITLE}`, on(0), OFF)).toBe(`${UP}Say ✋ 🟢 ${TITLE}`)
  })

  test('an empty title stays empty', async () => {
    expect(sessionTitle('', on(4), OFF)).toBe('')
    expect(sessionTitle(`${HAND}`, on(4), OFF)).toBe('')
  })
})

describe('the desktop app title follows the view', () => {
  test('a load with cards that need a person shows the hand; a load with none shows green; a right title is left alone', async ($, on) => {
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    const app = d.world.appSession
    await startSession($, d, 'desktop')
    expect(app.title).toBe(`${HAND}Tendai: PLAN-23 Agent mode`)
    expect(app.set).toEqual([`${HAND}Tendai: PLAN-23 Agent mode`])
    await forceRefresh($, d)
    expect(app.set).toHaveLength(1)
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await forceRefresh($, d)
    expect(app.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    expect(app.set).toHaveLength(2)
  })

  test('a failed load turns the mark red in place of the hand; the next good load brings the hand back', async ($, on) => {
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    await startSession($, d, 'desktop')
    d.failList()
    await forceRefresh($, d)
    expect(d.world.appSession.title).toBe(`${DOWN}Tendai: PLAN-23 Agent mode`)
    d.failList(false)
    await forceRefresh($, d)
    expect(d.world.appSession.title).toBe(`${HAND}Tendai: PLAN-23 Agent mode`)
  })

  test("the session's own card write re-reads the plan at once: no plan event echoes it, and no turn end is waited for", async ($, on) => {
    const API = 'mcp__plugin_danxbot_danx-dashboard__danxbot_api'
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    on('tool.call', { tool: API }, () => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: {} }), isError: false }) as any)
    await startSession($, d, 'desktop')
    expect(d.world.appSession.title).toBe(`${HAND}Tendai: PLAN-23 Agent mode`)
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await $.tool.call({ tool: API, method: 'GET', path: '/api/issues/DX-1/problems' })
    await d.clock.settle()
    // a read changes nothing, so it reloads nothing
    expect(d.world.appSession.title).toBe(`${HAND}Tendai: PLAN-23 Agent mode`)
    await $.tool.call({ tool: API, method: 'DELETE', path: '/api/issues/DX-1/problems/7' })
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
  })

  test('a terminal session has no app title to set', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    expect(d.world.appSession.set).toEqual([])
  })
})
