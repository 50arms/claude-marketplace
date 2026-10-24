import "./run-tests-with-npm-test.generated"
// The session title's ONE mark (sessionTitle): red once the session lost its plan or card connection, else the hand while the band shows a
// Needs You count (the same count, hidden on a failed load), else green while connected, else none (a session that never connected).
import { describe, expect } from 'claude-code/testing'

import { EMPTY } from '../hooks/plan/config'
import { RELAY_OFF } from '../hooks/relay/config'
import { BUILDING_TITLE_MARK, CONNECTED_TITLE_MARK, DISCONNECTED_TITLE_MARK, NEEDS_YOU_TITLE_MARK, PAUSED_TITLE_MARK, sessionTitle, titleConnection, unmarkedTitle } from '../hooks/plan/words'
import { test, CLOCK_START, answerReportEvents, dashboard, forceRefresh, startSession } from './plan-kit'

const TITLE = 'Danxbot I: PLAN-18 Card plugins'
const AGENT = { id: 1, name: 'Danxbot I', avatar_url: null }
const PLAN = { id: 18, ref: 'PLAN-18', name: 'Card plugins', dashboardUrl: 'https://app.example' }
const OFF = RELAY_OFF as any
const on = (needsYou: number | null) => ({ ...EMPTY, phase: 'ready', needsYou, agent: AGENT, connected: PLAN }) as any
const UP = CONNECTED_TITLE_MARK
const DOWN = DISCONNECTED_TITLE_MARK
const HAND = NEEDS_YOU_TITLE_MARK
const PAUSE = PAUSED_TITLE_MARK
const BUILD = BUILDING_TITLE_MARK
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const PAUSE_PATH = '/api/plan-sessions/me/pause'
const LOADS_AT_START = 1
const paused = (needsYou: number | null) => ({ ...on(needsYou), pausedUntil: CLOCK_START + 3_600_000 }) as any
const agentPause = (until: number) => ({ limit: 'agent', state: 'agent_waiting', reason: 'waiting for a build', ends_when: null, since: '2026-10-03T07:00:00.000Z', until: new Date(until).toISOString(), held: 0 })

describe('the hand', () => {
  test('marks the title while the plan has cards that need a person, and only then', async () => {
    expect(sessionTitle(TITLE, on(2), OFF, false)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, on(0), OFF, false)).toBe(`${UP}${TITLE}`)
    // an unknown count is no count: the band draws no badge
    expect(sessionTitle(TITLE, on(null), OFF, false)).toBe(`${UP}${TITLE}`)
  })

  test('a lost connection outranks the hand: the title carries the red mark alone', async () => {
    expect(sessionTitle(TITLE, { ...on(2), agentBlock: 'agent_not_held' }, OFF, false)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, on(2), { phase: 'stopped', planId: 18, detail: 'gone' }, false)).toBe(`${DOWN}${TITLE}`)
  })

  test('a failed or refused load draws no badge, so the title carries no hand', async () => {
    expect(sessionTitle(TITLE, { ...on(3), phase: 'error' }, OFF, false)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, { ...on(3), phase: 'blocked' }, OFF, false)).toBe(`${DOWN}${TITLE}`)
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
    expect(sessionTitle(TITLE, { ...EMPTY, phase: 'signed-out' } as any, OFF, false)).toBe(TITLE)
  })

  test('a loading view knows nothing yet, so the title is left exactly as it is', async () => {
    expect(sessionTitle(`${DOWN}${TITLE}`, EMPTY as any, OFF, false)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, EMPTY as any, OFF, false)).toBe(TITLE)
  })
})

describe('marks never stack', () => {
  test('a title keeps exactly one mark, whatever marks, forms, order or count it held', async () => {
    expect(sessionTitle(`${HAND}${TITLE}`, on(1), OFF, false)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`✋ ${TITLE}`, on(1), OFF, false)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`✋️ 🔴 ✋ 🟢 ${TITLE}`, on(1), OFF, false)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`${HAND}${TITLE}`, { ...on(0), phase: 'error' }, OFF, false)).toBe(`${DOWN}${TITLE}`)
  })

  test('a mark later in the title is the title, never a mark', async () => {
    expect(sessionTitle(`Say ✋ 🟢 ${TITLE}`, on(0), OFF, false)).toBe(`${UP}Say ✋ 🟢 ${TITLE}`)
  })

  test('an empty title stays empty', async () => {
    expect(sessionTitle('', on(4), OFF, false)).toBe('')
    expect(sessionTitle(`${HAND}`, on(4), OFF, false)).toBe('')
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

describe('the pause mark', () => {
  test('the one mark runs red, hand, paused, green, none', async () => {
    expect(sessionTitle(TITLE, paused(0), OFF, false)).toBe(`${PAUSE}${TITLE}`)
    expect(sessionTitle(TITLE, paused(null), OFF, false)).toBe(`${PAUSE}${TITLE}`)
    expect(sessionTitle(TITLE, paused(2), OFF, false)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, { ...paused(2), agentBlock: 'agent_not_held' }, OFF, false)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, { ...paused(0), phase: 'error' }, OFF, false)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, on(0), OFF, false)).toBe(`${UP}${TITLE}`)
    expect(sessionTitle(TITLE, { ...EMPTY, phase: 'signed-out', pausedUntil: CLOCK_START } as any, OFF, false)).toBe(TITLE)
  })

  test('unmarkedTitle strips the pause mark with or without the selector, in any order with the others', async () => {
    expect(unmarkedTitle(`${PAUSE}${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`⏸ ${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`⏸️ 🔴 ✋ ⏸ 🟢 ${TITLE}`)).toBe(TITLE)
    expect(sessionTitle(`${HAND}${PAUSE}${TITLE}`, paused(0), OFF, false)).toBe(`${PAUSE}${TITLE}`)
  })

  test('a pause mark later in the title is the title', async () => {
    expect(sessionTitle(`Say ⏸ ${TITLE}`, on(0), OFF, false)).toBe(`${UP}Say ⏸ ${TITLE}`)
  })

  test('a load shows the mark for an unexpired agent pause; an expired one and a usage-limit pause show none', async ($, on) => {
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    d.world.pause = agentPause(CLOCK_START + 3_600_000)
    await startSession($, d, 'desktop')
    expect(d.world.appSession.title).toBe(`${PAUSE}Tendai: PLAN-23 Agent mode`)
    d.world.pause = agentPause(CLOCK_START - 1000)
    await forceRefresh($, d)
    expect(d.world.appSession.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    d.world.pause = { ...agentPause(CLOCK_START + 3_600_000), limit: 'usage' }
    await forceRefresh($, d)
    expect(d.world.appSession.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
  })

  test('a pause read that fails or answers no pause field shows no mark and leaves the load ready, with no toast', async ($, on) => {
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    d.world.pause = agentPause(CLOCK_START + 3_600_000)
    await startSession($, d, 'desktop')
    expect(d.world.appSession.title).toBe(`${PAUSE}Tendai: PLAN-23 Agent mode`)
    for (const answer of [{ status: 500, body: { error: 'pause boom' } }, { status: 200, body: {} }]) {
      d.world.reportReplies[`GET ${PAUSE_PATH}`] = answer
      await forceRefresh($, d)
      expect(d.world.appSession.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    }
    expect(d.toasts.filter(t => /Plan load failed/.test(t))).toEqual([])
  })

  test("the load's pause read never ends the pause: every one is marked background, and the pause stands across loads", async ($, on) => {
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    d.world.pause = agentPause(CLOCK_START + 3_600_000)
    await startSession($, d, 'desktop')
    await forceRefresh($, d)
    await forceRefresh($, d)
    expect(d.loadPauseReads).toHaveLength(LOADS_AT_START)
    expect(d.reports.filter((r: any) => r.path === PAUSE_PATH)).toHaveLength(2)
    expect(d.unmarked).toEqual([])
  })

  test("the agent's own pause and resume re-read the plan at once, and the load after the pause ended drops the mark", async ($, on) => {
    const API = 'mcp__plugin_danxbot_danx-dashboard__danxbot_api'
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    on('tool.call', { tool: API }, () => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: {} }), isError: false }) as any)
    await startSession($, d, 'desktop')
    expect(d.world.appSession.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    d.world.pause = agentPause(CLOCK_START + 3_600_000)
    await $.tool.call({ tool: API, method: 'PUT', path: PAUSE_PATH, body: { reason: 'waiting for a build' } })
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${PAUSE}Tendai: PLAN-23 Agent mode`)
    d.world.pause = null
    await $.tool.call({ tool: API, method: 'DELETE', path: PAUSE_PATH })
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
  })
})

describe('the building mark', () => {
  test('the one mark runs red, hand, building, paused, green, none', async () => {
    expect(sessionTitle(TITLE, on(0), OFF, true)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(TITLE, on(null), OFF, true)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(TITLE, paused(0), OFF, true)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(TITLE, paused(0), OFF, false)).toBe(`${PAUSE}${TITLE}`)
    expect(sessionTitle(TITLE, on(2), OFF, true)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, { ...on(0), agentBlock: 'agent_not_held' }, OFF, true)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, { ...on(0), phase: 'error' }, OFF, true)).toBe(`${DOWN}${TITLE}`)
    // a session that never connected carries no mark, sub-agents or not
    expect(sessionTitle(TITLE, { ...EMPTY, phase: 'signed-out' } as any, OFF, true)).toBe(TITLE)
  })

  test('unmarkedTitle strips the building mark with or without the selector, in any run with the others', async () => {
    expect(unmarkedTitle(`${BUILD}${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`🔨️ ${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`🔨 ✋ ⏸️ 🔨 🔴 🟢 ${TITLE}`)).toBe(TITLE)
    expect(sessionTitle(`${HAND}${BUILD}${TITLE}`, on(0), OFF, true)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(`Say 🔨 ${TITLE}`, on(0), OFF, false)).toBe(`${UP}Say 🔨 ${TITLE}`)
  })

  test('a sub-agent start shows the mark at once, its stop drops it, two overlapping agents keep it until both stop', async ($, on) => {
    answerReportEvents(on)
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await startSession($, d, 'desktop')
    const app = d.world.appSession
    expect(app.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    // the title is read once per sync, so the reads count the syncs: one at each crossing of 0 / 1, none between
    const syncs = async (event: Promise<unknown>) => {
      const before = app.reads
      await event
      await d.clock.settle()
      return app.reads - before
    }
    expect(await syncs($.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' }))).toBe(1)
    expect(app.title).toBe(`${BUILD}Tendai: PLAN-23 Agent mode`)
    expect(await syncs($.classic.SubagentStart({ agent_id: 'b2', agent_type: 'Explore' }))).toBe(0)
    expect(await syncs($.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore' }))).toBe(0)
    expect(app.title).toBe(`${BUILD}Tendai: PLAN-23 Agent mode`)
    expect(await syncs($.classic.SubagentStop({ agent_id: 'b2', agent_type: 'Explore' }))).toBe(1)
    expect(app.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    // one set to build, one to drop: nothing in between wrote the title
    expect(app.set).toEqual([`${UP}Tendai: PLAN-23 Agent mode`, `${BUILD}Tendai: PLAN-23 Agent mode`, `${UP}Tendai: PLAN-23 Agent mode`])
  })

  test("a failed sub-agent raises no stop, but its turn's end drops the mark; a resumed one counts again", async ($, on) => {
    answerReportEvents(on)
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await startSession($, d, 'desktop')
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${BUILD}Tendai: PLAN-23 Agent mode`)
    await $.turn.complete({ ...TURN, reason: 'error', agentId: 'a1' })
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${BUILD}Tendai: PLAN-23 Agent mode`)
  })

  test('a start with no readable id counts nothing, and a stop of an agent never started changes nothing', async ($, on) => {
    answerReportEvents(on)
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await startSession($, d, 'desktop')
    const before = d.world.appSession.set.length
    await $.classic.SubagentStart({ agent_type: 'Explore' } as any)
    await $.classic.SubagentStop({ agent_id: 'never', agent_type: 'Explore' })
    await d.clock.settle()
    expect(d.world.appSession.set).toHaveLength(before)
  })

  test('the same agent started twice and stopped once is no longer running: the mark drops', async ($, on) => {
    answerReportEvents(on)
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await startSession($, d, 'desktop')
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
  })

  test("a title event keeps the mark while a sub-agent runs, and a new conversation's title carries none of the old one's sub-agents", async ($, on) => {
    answerReportEvents(on)
    on('classic.SessionStart', () => ({}) as any)
    on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await startSession($, d, 'desktop')
    const titleOf = async () => ((await $.classic.SessionStart({ source: 'startup', session_title: 'Tendai: PLAN-23 Agent mode' } as any)) as any).sessionTitle
    expect(await titleOf()).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    expect(await titleOf()).toBe(`${BUILD}Tendai: PLAN-23 Agent mode`)
    await $.session.end({ reason: 'clear', sessionId: 'sess-own' } as any)
    await d.clock.settle()
    expect(await titleOf()).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
  })
})
