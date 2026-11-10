import "./run-tests-with-npm-test.generated"
// The session title's ONE mark (sessionTitle): red once the session lost its plan or card connection, else the hand while the band shows a
// Needs You count (the same count, hidden on a failed load; the waiting mark instead while nothing of the session runs), else green while
// connected, else none (a session that never connected).
import { describe, expect } from 'claude-code/testing'

import { EMPTY } from '../hooks/plan/config'
import { RELAY_OFF } from '../hooks/relay/config'
import { BUILDING_TITLE_MARK, CONNECTED_TITLE_MARK, DISCONNECTED_TITLE_MARK, HOURGLASS_TITLE_MARK, NEEDS_YOU_TITLE_MARK, PAUSED_TITLE_MARK, WAITING_TITLE_MARK, sessionTitle, titleConnection, unmarkedTitle } from '../hooks/plan/words'
import { test, CLOCK_START, answerReportEvents, dashboard, forceRefresh, startSession } from './plan-kit'

const TITLE = '50 Arms I: PLAN-18 Card plugins'
const AGENT = { id: 1, name: '50 Arms I', avatar_url: null }
const PLAN = { id: 18, ref: 'PLAN-18', name: 'Card plugins', dashboardUrl: 'https://app.example' }
const OFF = RELAY_OFF as any
const on = (needsYou: number | null) => ({ ...EMPTY, phase: 'ready', needsYou, agent: AGENT, connected: PLAN }) as any
const UP = CONNECTED_TITLE_MARK
const DOWN = DISCONNECTED_TITLE_MARK
const HAND = NEEDS_YOU_TITLE_MARK
const PAUSE = PAUSED_TITLE_MARK
const BUILD = BUILDING_TITLE_MARK
const WAIT = WAITING_TITLE_MARK
// what the session is doing (TitleActivity): its turn running with no sub-agent, with one, or nothing running at all
// `slotRefused`: the session's last sub-agent spawn was refused by usage pacing and no spawn since was admitted (the hourglass)
const WORKING = { subAgents: false, turnRunning: true, slotRefused: false }
const SUBAGENT = { subAgents: true, turnRunning: true, slotRefused: false }
const IDLE_NOW = { subAgents: false, turnRunning: false, slotRefused: false }
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const PAUSE_PATH = '/api/plan-sessions/me/pause'
const LOADS_AT_START = 1
const paused = (needsYou: number | null) => ({ ...on(needsYou), pausedUntil: CLOCK_START + 3_600_000 }) as any
const agentPause = (until: number) => ({ limit: 'agent', state: 'agent_waiting', reason: 'waiting for a build', ends_when: null, since: '2026-10-03T07:00:00.000Z', until: new Date(until).toISOString(), held: 0 })

const BARE = 'PLAN-18 Card plugins'

describe('the agent name in the title', () => {
  test('goes once the session holds no team agent, whatever the reason, and the connection mark and the rest stay', async () => {
    const none = [
      { ...on(0), phase: 'key-revoked', revokedBy: 'Dan' },
      { ...on(0), phase: 'signed-out' },
      { ...on(0), agentBlock: 'agent_not_held' },
      { ...on(0), agentBlock: 'agent_needed' },
      { ...on(0), agentBlock: 'agent_limit_reached' },
    ]
    for (const v of none) {
      const out = sessionTitle(TITLE, v as any, OFF, WORKING)
      expect(out.endsWith(BARE)).toBe(true)
      expect(out).not.toContain('50 Arms I')
    }
    expect(sessionTitle(`${DOWN}${TITLE}`, { ...on(0), agentBlock: 'agent_not_held' } as any, OFF, WORKING)).toBe(`${DOWN}${BARE}`)
  })

  test('stays while the agent is held, and a title with no agent prefix is left alone', async () => {
    expect(sessionTitle(TITLE, on(0), OFF, WORKING)).toBe(`${UP}${TITLE}`)
    expect(sessionTitle(BARE, { ...on(0), agentBlock: 'agent_not_held' } as any, OFF, WORKING)).toBe(`${DOWN}${BARE}`)
    expect(sessionTitle('Fix: the login page', { ...on(0), agentBlock: 'agent_not_held' } as any, OFF, WORKING)).toBe(`${DOWN}Fix: the login page`)
  })
})

describe('the hand', () => {
  test('marks the title while the plan has cards that need a person, and only then', async () => {
    expect(sessionTitle(TITLE, on(2), OFF, WORKING)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, on(0), OFF, WORKING)).toBe(`${UP}${TITLE}`)
    // an unknown count is no count: the band draws no badge
    expect(sessionTitle(TITLE, on(null), OFF, WORKING)).toBe(`${UP}${TITLE}`)
  })

  test('a lost connection outranks the hand: the title carries the red mark alone', async () => {
    expect(sessionTitle(TITLE, { ...on(2), agentBlock: 'agent_not_held' }, OFF, WORKING)).toBe(`${DOWN}${BARE}`)
    expect(sessionTitle(TITLE, on(2), { phase: 'stopped', planId: 18, detail: 'gone' }, WORKING)).toBe(`${DOWN}${TITLE}`)
  })

  test('a failed or refused load draws no badge, so the title carries no hand', async () => {
    expect(sessionTitle(TITLE, { ...on(3), phase: 'error' }, OFF, WORKING)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, { ...on(3), phase: 'blocked' }, OFF, WORKING)).toBe(`${DOWN}${TITLE}`)
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
    expect(sessionTitle(TITLE, { ...EMPTY, phase: 'signed-out' } as any, OFF, WORKING)).toBe(BARE)
  })

  test('a loading view knows nothing yet, so the title is left exactly as it is', async () => {
    expect(sessionTitle(`${DOWN}${TITLE}`, EMPTY as any, OFF, WORKING)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, EMPTY as any, OFF, WORKING)).toBe(TITLE)
  })
})

describe('marks never stack', () => {
  test('a title keeps exactly one mark, whatever marks, forms, order or count it held', async () => {
    expect(sessionTitle(`${HAND}${TITLE}`, on(1), OFF, WORKING)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`✋ ${TITLE}`, on(1), OFF, WORKING)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`✋️ 🔴 ✋ 🟢 ${TITLE}`, on(1), OFF, WORKING)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`${HAND}${TITLE}`, { ...on(0), phase: 'error' }, OFF, WORKING)).toBe(`${DOWN}${TITLE}`)
  })

  test('a mark later in the title is the title, never a mark', async () => {
    expect(sessionTitle(`Say ✋ 🟢 ${TITLE}`, on(0), OFF, WORKING)).toBe(`${UP}Say ✋ 🟢 ${TITLE}`)
  })

  test('an empty title stays empty', async () => {
    expect(sessionTitle('', on(4), OFF, WORKING)).toBe('')
    expect(sessionTitle(`${HAND}`, on(4), OFF, WORKING)).toBe('')
  })
})

const CONNECT = 'mcp__plugin_50arms_platform__session_connect'
const API = 'mcp__plugin_50arms_platform__50arms_api'
const SET_TITLE = 'mcp__ccd_session_mgmt__set_session_title'
const KOFI_TITLE = "Kofi: DX-7050 A person's follow-up comments stack"
const OLD_TITLE = 'Overly loose comment search highlight'
const NEEDED = { status: 'needed', title: 'Dunnock: DX-7061 Overly loose comment search highlight' }
const connectCalls = (d: any) => d.calls.filter((c: any) => c.server === 'plugin:50arms:platform' && c.tool === 'session_connect')
const cardConnect = (naming: unknown) => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: { session: { cardId: 'DX-7061' }, naming } }), isError: false }) as any
const pickupAnswer = (naming: unknown) => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: { connectedByPickup: true, naming } }), isError: false }) as any
const PICKUP = { tool: API, method: 'POST', path: '/api/issues/DX-7061/transition', body: { action: 'pickup', manual: true } } as any
const NOT_RENAME = 'do not rename the thread'

// the desktop session of agent `name`, every card settled so the connection mark is green
// (`mocks` registers the tool mocks, which must come before the session first uses $)
async function desktop($: any, on: any, name: string, appTitle: string, mocks: (d: any) => void = () => {}, options?: any) {
  answerReportEvents(on)
  const d = dashboard(on, options)
  d.world.agent = { id: 9, name, avatar_url: null }
  for (const c of d.world.cards) for (const p of c.problems) p.open = false
  d.world.appSession.title = appTitle
  mocks(d)
  await startSession($, d, 'desktop')
  return d
}

// the model's own set_session_title
const renameCall = (title: string) => ({ tool: SET_TITLE, session_id: 'self', title }) as any

describe('a rename racing a title-mark sync (CP-93)', () => {
  test("a rename landing before the sync's re-read keeps the new title: the sync marks the new base", async ($, on) => {
    const d = await desktop($, on, 'Kofi', 'Kofi')
    const app = d.world.appSession
    expect(app.title).toBe(`${UP}Kofi`)
    app.afterRead.push(() => {
      app.title = KOFI_TITLE
    })
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    expect(app.title).toBe(`${BUILD}${KOFI_TITLE}`)
    await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    expect(app.title).toBe(`${UP}${KOFI_TITLE}`)
  })

  test("the model's own rename landing after the sync's re-read, before its write, is kept: the call waits for the write, then the sync marks it", async ($, on) => {
    // the plugin's titles written when the model's rename reaches the app: the call must not run while the sync sits between its re-read and its write
    let writtenWhenRenamed = -1
    const d = await desktop($, on, 'Kofi', 'Kofi', d => {
      on('tool.call', { tool: SET_TITLE }, () => {
        writtenWhenRenamed = d.world.appSession.set.length
        d.world.appSession.title = KOFI_TITLE
        return { result: {}, text: 'Renamed.', isError: false } as any
      })
    })
    const app = d.world.appSession
    const writtenBefore = app.set.length
    app.setDelayMs = 10
    let renamed: Promise<unknown> = Promise.resolve()
    // reads: the sync's first, then its re-read; the model's call is made right after the re-read answered
    app.afterRead.push(
      () => {},
      () => {
        renamed = $.tool.call(renameCall(KOFI_TITLE))
      },
    )
    const started = $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.advance(30)
    await started
    await renamed
    app.setDelayMs = 0
    await d.clock.advance(30)
    await d.clock.settle()
    expect(writtenWhenRenamed).toBe(writtenBefore + 1)
    expect(app.title).toBe(`${BUILD}${KOFI_TITLE}`)
  })

  test("the plugin's naming rename landing between a sync's read and its write is kept too: two writers never straddle each other", async ($, on) => {
    const d = await desktop($, on, 'Dunnock', OLD_TITLE, () => on('tool.call', { tool: CONNECT }, () => cardConnect(NEEDED)))
    const app = d.world.appSession
    let connected: Promise<unknown> = Promise.resolve()
    app.afterRead.push(
      () => {},
      () => {
        connected = $.tool.call({ tool: CONNECT, target: 'DX-7061' } as any)
      },
    )
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await connected
    await d.clock.settle()
    expect(app.title).toBe(`${BUILD}${NEEDED.title}`)
  })

  test('the title a later sign-in sends to session_connect is the latest one, never the name from before the rename', async ($, on) => {
    const d = await desktop($, on, 'Kofi', 'Kofi', () => on('classic.SessionStart', () => ({}) as any), { signedOut: 'signed-out' })
    d.world.appSession.title = KOFI_TITLE
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    // an older title arrives with a new conversation's start event: the app's title, kept by the sync, is the later one
    await $.classic.SessionStart({ source: 'startup', session_title: 'Kofi' } as any)
    await d.clock.settle()
    d.world.signIn.answer = { text: JSON.stringify({ state: 'denied' }) }
    const band = await $.ui.mount({ plugin: '50arms', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
    await band.press({ key: 'sign-in' })
    await d.clock.settle()
    const sent = d.world.signIn.calls.map((c: any) => c.title)
    expect(sent.length).toBeGreaterThan(0)
    // a signed-out session holds no team agent, so the agent name is dropped from the title it sends (sessionTitle); the rename itself is kept
    for (const t of sent) expect(t).toBe(KOFI_TITLE.replace('Kofi: ', ''))
  })
})

describe('a connect answer whose naming is needed (CP-93)', () => {
  test('on a desktop session the plugin sets the exact marked title, connects again with that title, and tells the model not to rename', async ($, on) => {
    const d = await desktop($, on, 'Dunnock', OLD_TITLE, () => on('tool.call', { tool: CONNECT }, () => cardConnect(NEEDED)))
    const ran: any = await $.tool.call({ tool: CONNECT, target: 'DX-7061' } as any)
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${UP}${NEEDED.title}`)
    expect(connectCalls(d).filter((c: any) => c.args.title !== undefined).map((c: any) => c.args)).toEqual([{ target: 'DX-7061', title: NEEDED.title }])
    expect(JSON.stringify(ran)).toContain(NOT_RENAME)
  })

  test('a pickup that connects the session names the thread the same way, with the same note', async ($, on) => {
    const d = await desktop($, on, 'Dunnock', OLD_TITLE, () => on('tool.call', { tool: API }, () => pickupAnswer(NEEDED)))
    const ran: any = await $.tool.call(PICKUP)
    await d.clock.settle()
    expect(d.world.appSession.title).toBe(`${UP}${NEEDED.title}`)
    expect(connectCalls(d).filter((c: any) => c.args.title !== undefined).map((c: any) => c.args)).toEqual([{ target: 'DX-7061', title: NEEDED.title }])
    expect(JSON.stringify(ran)).toContain(NOT_RENAME)
  })

  test('a pickup that did not connect the session, or whose naming is not needed, names nothing', async ($, on) => {
    let body: any = { connectedByPickup: false, naming: NEEDED }
    const d = await desktop($, on, 'Dunnock', OLD_TITLE, () => on('tool.call', { tool: API }, () => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body }), isError: false }) as any))
    const app = d.world.appSession
    const before = app.set.length
    await $.tool.call(PICKUP)
    body = { connectedByPickup: true, naming: { status: 'ok', title: NEEDED.title } }
    await $.tool.call(PICKUP)
    await d.clock.settle()
    expect(app.set.length).toBe(before)
    expect(connectCalls(d).filter((c: any) => c.args.title !== undefined)).toEqual([])
  })

  test('a terminal session has no title tool: nothing is set, no second connect is made, the model gets no note', async ($, on) => {
    const d = dashboard(on)
    d.world.appSession.title = OLD_TITLE
    on('tool.call', { tool: CONNECT }, () => cardConnect(NEEDED))
    await startSession($, d, 'terminal')
    const before = connectCalls(d).length
    const ran: any = await $.tool.call({ tool: CONNECT, target: 'DX-7061' } as any)
    await d.clock.settle()
    expect(d.world.appSession.set).toEqual([])
    expect(connectCalls(d).length).toBe(before)
    expect(JSON.stringify(ran)).not.toContain(NOT_RENAME)
  })

  test('a naming that is not needed changes nothing', async ($, on) => {
    const d = await desktop($, on, 'Dunnock', OLD_TITLE, () => on('tool.call', { tool: CONNECT }, () => cardConnect({ status: 'ok', title: NEEDED.title })))
    const before = d.world.appSession.set.length
    await $.tool.call({ tool: CONNECT, target: 'DX-7061' } as any)
    await d.clock.settle()
    expect(d.world.appSession.set.length).toBe(before)
    expect(connectCalls(d).filter((c: any) => c.args.title !== undefined)).toEqual([])
  })

  test("a failing rename is toasted, not thrown out of the model's connect, and the note is not sent", async ($, on) => {
    const d = await desktop($, on, 'Dunnock', OLD_TITLE, () => on('tool.call', { tool: CONNECT }, () => cardConnect(NEEDED)))
    d.world.appSession.failSet = 'the desktop refused'
    const ran: any = await $.tool.call({ tool: CONNECT, target: 'DX-7061' } as any)
    await d.clock.settle()
    expect(d.toasts.some((t: string) => t.includes('Setting the thread title failed'))).toBe(true)
    expect(JSON.stringify(ran)).not.toContain(NOT_RENAME)
  })
})

describe('the desktop app title follows the view', () => {
  test('a load with cards that need a person shows the waiting mark (no turn runs here); a load with none shows green; a right title is left alone', async ($, on) => {
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    const app = d.world.appSession
    await startSession($, d, 'desktop')
    expect(app.title).toBe(`${WAIT}Tendai: PLAN-23 Agent mode`)
    expect(app.set).toEqual([`${WAIT}Tendai: PLAN-23 Agent mode`])
    await forceRefresh($, d)
    expect(app.set).toHaveLength(1)
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await forceRefresh($, d)
    expect(app.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    expect(app.set).toHaveLength(2)
  })

  test('a failed load turns the mark red in place of the Needs You mark; the next good load brings it back', async ($, on) => {
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    await startSession($, d, 'desktop')
    d.failList()
    await forceRefresh($, d)
    expect(d.world.appSession.title).toBe(`${DOWN}Tendai: PLAN-23 Agent mode`)
    d.failList(false)
    await forceRefresh($, d)
    expect(d.world.appSession.title).toBe(`${WAIT}Tendai: PLAN-23 Agent mode`)
  })

  test("the session's own card write re-reads the plan at once: no plan event echoes it, and no turn end is waited for", async ($, on) => {
    const API = 'mcp__plugin_50arms_platform__50arms_api'
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    on('tool.call', { tool: API }, () => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: {} }), isError: false }) as any)
    await startSession($, d, 'desktop')
    expect(d.world.appSession.title).toBe(`${WAIT}Tendai: PLAN-23 Agent mode`)
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await $.tool.call({ tool: API, method: 'GET', path: '/api/issues/DX-1/problems' })
    await d.clock.settle()
    // a read changes nothing, so it reloads nothing
    expect(d.world.appSession.title).toBe(`${WAIT}Tendai: PLAN-23 Agent mode`)
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
    expect(sessionTitle(TITLE, paused(0), OFF, WORKING)).toBe(`${PAUSE}${TITLE}`)
    expect(sessionTitle(TITLE, paused(null), OFF, WORKING)).toBe(`${PAUSE}${TITLE}`)
    expect(sessionTitle(TITLE, paused(2), OFF, WORKING)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, { ...paused(2), agentBlock: 'agent_not_held' }, OFF, WORKING)).toBe(`${DOWN}${BARE}`)
    expect(sessionTitle(TITLE, { ...paused(0), phase: 'error' }, OFF, WORKING)).toBe(`${DOWN}${TITLE}`)
    expect(sessionTitle(TITLE, on(0), OFF, WORKING)).toBe(`${UP}${TITLE}`)
    expect(sessionTitle(TITLE, { ...EMPTY, phase: 'signed-out', pausedUntil: CLOCK_START } as any, OFF, WORKING)).toBe(BARE)
  })

  test('unmarkedTitle strips the pause mark with or without the selector, in any order with the others', async () => {
    expect(unmarkedTitle(`${PAUSE}${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`⏸ ${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`⏸️ 🔴 ✋ ⏸ 🟢 ${TITLE}`)).toBe(TITLE)
    expect(sessionTitle(`${HAND}${PAUSE}${TITLE}`, paused(0), OFF, WORKING)).toBe(`${PAUSE}${TITLE}`)
  })

  test('a pause mark later in the title is the title', async () => {
    expect(sessionTitle(`Say ⏸ ${TITLE}`, on(0), OFF, WORKING)).toBe(`${UP}Say ⏸ ${TITLE}`)
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
    const API = 'mcp__plugin_50arms_platform__50arms_api'
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
    expect(sessionTitle(TITLE, on(0), OFF, SUBAGENT)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(TITLE, on(null), OFF, SUBAGENT)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(TITLE, paused(0), OFF, SUBAGENT)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(TITLE, paused(0), OFF, WORKING)).toBe(`${PAUSE}${TITLE}`)
    expect(sessionTitle(TITLE, on(2), OFF, SUBAGENT)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, { ...on(0), agentBlock: 'agent_not_held' }, OFF, SUBAGENT)).toBe(`${DOWN}${BARE}`)
    expect(sessionTitle(TITLE, { ...on(0), phase: 'error' }, OFF, SUBAGENT)).toBe(`${DOWN}${TITLE}`)
    // a session that never connected carries no mark, sub-agents or not
    expect(sessionTitle(TITLE, { ...EMPTY, phase: 'signed-out' } as any, OFF, SUBAGENT)).toBe(BARE)
  })

  test('unmarkedTitle strips the building mark with or without the selector, in any run with the others', async () => {
    expect(unmarkedTitle(`${BUILD}${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`🔨️ ${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`🔨 ✋ ⏸️ 🔨 🔴 🟢 ${TITLE}`)).toBe(TITLE)
    expect(sessionTitle(`${HAND}${BUILD}${TITLE}`, on(0), OFF, SUBAGENT)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(`Say 🔨 ${TITLE}`, on(0), OFF, WORKING)).toBe(`${UP}Say 🔨 ${TITLE}`)
  })

  test('a sub-agent start shows the mark at once, its stop drops it, two overlapping agents keep it until both stop', async ($, on) => {
    answerReportEvents(on)
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await startSession($, d, 'desktop')
    const app = d.world.appSession
    expect(app.title).toBe(`${UP}Tendai: PLAN-23 Agent mode`)
    // the title is written at each crossing of 0 / 1 sub-agents, never between
    const writes = async (event: Promise<unknown>) => {
      const before = app.set.length
      await event
      await d.clock.settle()
      return app.set.length - before
    }
    expect(await writes($.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' }))).toBe(1)
    expect(app.title).toBe(`${BUILD}Tendai: PLAN-23 Agent mode`)
    expect(await writes($.classic.SubagentStart({ agent_id: 'b2', agent_type: 'Explore' }))).toBe(0)
    expect(await writes($.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore' }))).toBe(0)
    expect(app.title).toBe(`${BUILD}Tendai: PLAN-23 Agent mode`)
    expect(await writes($.classic.SubagentStop({ agent_id: 'b2', agent_type: 'Explore' }))).toBe(1)
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

describe('the waiting mark', () => {
  test('shows instead of the hand only while nothing of the session runs: no turn, no sub-agent', async () => {
    expect(sessionTitle(TITLE, on(2), OFF, IDLE_NOW)).toBe(`${WAIT}${TITLE}`)
    expect(sessionTitle(TITLE, paused(2), OFF, IDLE_NOW)).toBe(`${WAIT}${TITLE}`)
    expect(sessionTitle(TITLE, on(2), OFF, WORKING)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, on(2), OFF, { subAgents: true, turnRunning: false, slotRefused: false })).toBe(`${HAND}${TITLE}`)
    // with nothing waiting on a person, an idle session keeps its other marks
    expect(sessionTitle(TITLE, on(0), OFF, IDLE_NOW)).toBe(`${UP}${TITLE}`)
    expect(sessionTitle(TITLE, paused(0), OFF, IDLE_NOW)).toBe(`${PAUSE}${TITLE}`)
    // red still outranks it, and a failed load hides Needs You
    expect(sessionTitle(TITLE, { ...on(2), agentBlock: 'agent_not_held' }, OFF, IDLE_NOW)).toBe(`${DOWN}${BARE}`)
    expect(sessionTitle(TITLE, { ...on(2), phase: 'error' }, OFF, IDLE_NOW)).toBe(`${DOWN}${TITLE}`)
  })

  test('unmarkedTitle strips the waiting mark with or without the selector, in any run with the others', async () => {
    expect(unmarkedTitle(`${WAIT}${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`⚠ ${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`⚠️ ✋ 🔨 ⚠ 🟢 ${TITLE}`)).toBe(TITLE)
    expect(sessionTitle(`${WAIT}${TITLE}`, on(1), OFF, WORKING)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(`Say ⚠️ ${TITLE}`, on(0), OFF, WORKING)).toBe(`${UP}Say ⚠️ ${TITLE}`)
  })

  test("the main loop's turn start brings the hand back and its end the waiting mark, syncing only while Needs You is shown", async ($, on) => {
    answerReportEvents(on)
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    await startSession($, d, 'desktop')
    const app = d.world.appSession
    // the default world has a card waiting on a person and no turn has started: the session waits on them
    expect(app.title.startsWith(WAIT)).toBe(true)
    const writes = async (event: Promise<unknown>) => {
      const before = app.set.length
      await event
      await d.clock.settle()
      return app.set.length - before
    }
    expect(await writes($.turn.start({ turnId: 't1' } as any))).toBe(1)
    expect(app.title.startsWith(HAND)).toBe(true)
    await $.turn.complete(TURN)
    await d.clock.settle()
    expect(app.title.startsWith(WAIT)).toBe(true)
    // a sub-agent left running after the turn keeps the hand: the session is still at work
    await $.turn.start({ turnId: 't2' } as any)
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await d.clock.settle()
    expect(app.title.startsWith(HAND)).toBe(true)
    await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore' })
    await d.clock.settle()
    expect(app.title.startsWith(WAIT)).toBe(true)
    // with nothing waiting on a person a turn start writes no title
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await forceRefresh($, d)
    expect(await writes($.turn.start({ turnId: 't3' } as any))).toBe(0)
  })
})

describe('the hourglass mark', () => {
  const HOURGLASS = HOURGLASS_TITLE_MARK
  // the session's last sub-agent spawn was refused by usage pacing: the title's slot-refused state (pacing-line)
  const REFUSED = { subAgents: false, turnRunning: true, slotRefused: true }
  const REFUSED_IDLE = { subAgents: false, turnRunning: false, slotRefused: true }
  const REFUSED_SUBAGENT = { subAgents: true, turnRunning: true, slotRefused: true }
  // a pause the dashboard says waits on usage pacing (`waits_on`, read with the pause)
  const pacingPaused = (needsYou: number | null) => ({ ...paused(needsYou), pausedWaitsOn: 'pacing' }) as any

  test('a connected session whose spawn was refused shows the hourglass in place of green', async () => {
    expect(sessionTitle(TITLE, on(0), OFF, REFUSED)).toBe(`${HOURGLASS}${TITLE}`)
    expect(sessionTitle(TITLE, on(0), OFF, REFUSED_IDLE)).toBe(`${HOURGLASS}${TITLE}`)
  })

  test('a pause that waits on pacing shows the hourglass in place of the pause mark; another pause keeps the pause mark', async () => {
    expect(sessionTitle(TITLE, pacingPaused(0), OFF, WORKING)).toBe(`${HOURGLASS}${TITLE}`)
    expect(sessionTitle(TITLE, { ...paused(0), pausedWaitsOn: 'person' }, OFF, WORKING)).toBe(`${PAUSE}${TITLE}`)
    expect(sessionTitle(TITLE, { ...paused(0), pausedWaitsOn: null }, OFF, WORKING)).toBe(`${PAUSE}${TITLE}`)
  })

  test('the hammer, the hand, the waiting mark and red keep their place ahead of the hourglass', async () => {
    expect(sessionTitle(TITLE, on(0), OFF, REFUSED_SUBAGENT)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(TITLE, pacingPaused(0), OFF, REFUSED_SUBAGENT)).toBe(`${BUILD}${TITLE}`)
    expect(sessionTitle(TITLE, on(2), OFF, REFUSED)).toBe(`${HAND}${TITLE}`)
    expect(sessionTitle(TITLE, on(2), OFF, REFUSED_IDLE)).toBe(`${WAIT}${TITLE}`)
    expect(sessionTitle(TITLE, { ...on(0), agentBlock: 'agent_not_held' }, OFF, REFUSED)).toBe(`${DOWN}${BARE}`)
  })

  test('a session that never connected carries no hourglass, refused or not', async () => {
    expect(sessionTitle(TITLE, { ...EMPTY, phase: 'signed-out' } as any, OFF, REFUSED)).toBe(BARE)
  })

  test('unmarkedTitle strips the hourglass with or without the selector, in any run with the others', async () => {
    expect(unmarkedTitle(`${HOURGLASS}${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`⏳ ${TITLE}`)).toBe(TITLE)
    expect(unmarkedTitle(`⏳️ 🔨 ⏳ 🟢 ${TITLE}`)).toBe(TITLE)
    expect(sessionTitle(`${HOURGLASS}${TITLE}`, on(0), OFF, WORKING)).toBe(`${UP}${TITLE}`)
    expect(sessionTitle(`Say ⏳ ${TITLE}`, on(0), OFF, WORKING)).toBe(`${UP}Say ⏳ ${TITLE}`)
  })

  test('a load of a session paused on pacing shows the hourglass from the pause read', async ($, on) => {
    const d = dashboard(on)
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    d.world.pause = { ...agentPause(CLOCK_START + 3_600_000), waits_on: 'pacing' }
    await startSession($, d, 'desktop')
    expect(d.world.appSession.title).toBe(`${HOURGLASS}Tendai: PLAN-23 Agent mode`)
    d.world.pause = { ...agentPause(CLOCK_START + 3_600_000), waits_on: 'person' }
    await forceRefresh($, d)
    expect(d.world.appSession.title).toBe(`${PAUSE}Tendai: PLAN-23 Agent mode`)
  })
})
