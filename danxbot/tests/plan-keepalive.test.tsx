// DX-3900: the plan-tab keepalive. The desktop app disconnects a session's preview 1800 s after its last turn ended; a plan-connected DESKTOP
// session idle for KEEPALIVE_IDLE_MS is sent one prompt (the registry's `tab_keepalive` wording plus the plan page) whose turn restarts that
// timer. A failed attempt is retried every KEEPALIVE_RETRY_MS inside the margin that is left, until KEEPALIVE_GIVE_UP_MS after the turn ended.
import { describe, expect, test } from 'claude-code/testing'

import { KEEPALIVE_GIVE_UP_MS, KEEPALIVE_IDLE_MS, KEEPALIVE_RETRY_MS, keepalivePrompt } from '../hooks/relay/keepalive'
import { CLOCK_START, DASHBOARD_URL, EVENT_TEXT, answerPlanConnect, dashboard, forceRefresh, leaveSession, startSession, viewSession } from './plan-kit'

const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const START = { turnId: 't1' } as any
const MINUTE = 60_000
const written = (d: any, key: string): unknown[] => d.stateWrites.filter((w: any) => w.plugin === 'danxbot' && w.key === key).map((w: any) => w.value)
const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any

const sent = (d: any): string[] => d.relay.delivered.map((x: any) => x.text)
const promptFor = (planId: number) => keepalivePrompt(EVENT_TEXT('tab_keepalive'), `${DASHBOARD_URL}/plans/${planId}`)
const PROMPT = promptFor(23)
const failures = (d: any): string[] => d.toasts.filter((t: string) => t.startsWith('Plan tab keepalive'))
const reads = (d: any): number => d.contextReads.filter((path: string) => path === '/api/reminders/event/tab_keepalive').length

test('the prompt is the marker, the registry wording and the plan page, in one line', () => {
  expect(keepalivePrompt('Check the tab.', 'http://x/plans/23')).toBe('[danxbot plan event] Check the tab. Plan page: http://x/plans/23')
})

describe('the keepalive on the desktop', () => {
  test('an idle plan-connected session gets one keepalive prompt after the idle time', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a turn in flight sends nothing, however long it runs', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await $.turn.start(START)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
  })

  test('the end of a turn restarts the idle time from that end', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await $.turn.start(START)
    await d.clock.advance(20 * MINUTE)
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  test("a sub-agent's turn end is not the session going idle: it does not move the timer", async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await d.clock.advance(20 * MINUTE)
    await $.turn.complete({ ...TURN, agentId: 'a1' })
    await d.clock.advance(5 * MINUTE)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a turn that begins while the wording is being read cancels the attempt: nothing is sent or scheduled for the period that is over', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.world.contextDelayMs = MINUTE
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    await $.turn.start(START)
    await d.clock.advance(2 * MINUTE)
    expect(sent(d)).toEqual([])
    expect(failures(d)).toEqual([])
  })

  test('the end of the process ends it', async ($, on) => {
    const d = dashboard(on)
    on('session.end', () => ({ sessionId: 's1' }) as any)
    await startSession($, d, 'desktop')
    await $.session.end({ reason: 'logout' } as any)
    expect(written(d, 'idleSince').at(-1)).toBe(null)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
  })

  test('disconnecting from the plan ends it, and a turn end after that does not start it again', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'disconnect' })
    await d.clock.settle()
    expect(written(d, 'idleSince').at(-1)).toBe(null)
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
    expect(failures(d)).toEqual([])
  })

  test('a session on no plan gets none, a turn end included', async ($, on) => {
    const d = dashboard(on, { connected: false })
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
  })

  test("a move to another plan restarts the idle time and names the new plan's page", async ($, on) => {
    const d = dashboard(on)
    answerPlanConnect(on, d)
    await startSession($, d, 'desktop')
    await d.clock.advance(20 * MINUTE)
    await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 24 } as any)
    await d.clock.settle()
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([promptFor(24)])
  })
})

describe('a failed attempt on the desktop', () => {
  test('is toasted and tried again a minute later, inside the margin, not a full idle period later', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
    expect(failures(d)).toHaveLength(1)
    expect(failures(d)[0]).toContain('trying again')
    d.world.eventText.tab_keepalive = EVENT_TEXT('tab_keepalive')
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a prompt the session did not take is the same: toasted, tried again a minute later', async ($, on) => {
    const d = dashboard(on)
    d.relay.dropPrompts('busy')
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(failures(d).some(t => t.includes('the prompt was not taken'))).toBe(true)
    d.relay.acceptPrompts()
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a plan page that is not loaded at that moment is the same: tried again a minute later, with the page once it is', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.failList()
    await forceRefresh($, d)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
    expect(failures(d).some(t => t.includes('not loaded'))).toBe(true)
    d.failList(false)
    await forceRefresh($, d)
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('gives up, loudly, once the app has had its 30 minutes: no attempt after the give-up time', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS)
    const told = failures(d)
    expect(told.at(-1)).toContain('gave up')
    // attempts at 25, 26, 27, 28 and 29 minutes: the one at the bound is the last
    expect(reads(d)).toBe(5)
    expect(told).toHaveLength(5)
    d.world.eventText.tab_keepalive = EVENT_TEXT('tab_keepalive')
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(sent(d)).toEqual([])
    expect(failures(d)).toEqual(told)
  })

  // DX-4806: a give-up ends that period, not the keepalive: the next idle period is started with no turn end in between
  test('after giving up, the next idle period is armed by itself and its attempt goes through', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS)
    expect(failures(d).at(-1)).toContain('gave up')
    d.world.eventText.tab_keepalive = EVENT_TEXT('tab_keepalive')
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('the next period after a give-up has its own 29-minute window: its failures are retried every minute again, then it gives up again', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS)
    expect(reads(d)).toBe(5)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(reads(d)).toBe(6)
    await d.clock.advance(4 * MINUTE)
    // attempts at 54, 55, 56, 57 and 58 minutes: the second period began at 29 and ends at 29 + 29
    expect(reads(d)).toBe(10)
    expect(failures(d)).toHaveLength(10)
    expect(failures(d).at(-1)).toContain('gave up')
    await d.clock.advance(KEEPALIVE_RETRY_MS - 1)
    expect(reads(d)).toBe(10)
  })

  test('a period that starts after a not-desktop look has its own 29-minute window, not the earlier one', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(reads(d)).toBe(0)
    await viewSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS + 4 * MINUTE)
    // the desktop is hosting from minute 25; its period began at 25, so attempts at 50, 51, 52, 53 and 54
    expect(reads(d)).toBe(5)
    expect(failures(d).at(-1)).toContain('gave up')
  })
})

describe('a desktop-hosted session, whatever is attached at that moment', () => {
  test('fires although no client is attached (the app detaches about 5 s after the start)', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    expect(d.roster).toEqual([])
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('fires after the person viewed it and left again', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await viewSession($, d, 'desktop')
    await leaveSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a session that attached the desktop but whose start did not list it is hosted from the attach', async ($, on) => {
    const d = dashboard(on)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
    await viewSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
  })
})

// DX-4806: the app reloads a plugin mid-session (installed_plugins.json changed -> `reload_plugins`, main.log), paced to the moment the session is hidden, so
// the fresh load's session.start finds the desktop detached (surfaces() is []). The module's own variables start over; the host's $.state stays.
describe('a reload of the module in a session the desktop hosts (DX-4806)', () => {
  test('the session start of the fresh load, with the desktop detached, does not forget that the desktop hosts the session', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    expect(d.roster).toEqual([])
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a turn that ends with no turn.start seen (a background-task notification turn) still starts the idle time', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await d.clock.advance(10 * MINUTE)
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('the desktop flag is $.state, raised by a desktop session', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    expect(written(d, 'desktopHosted')).toContain(true)
  })

  test('the desktop flag stays down for a terminal session', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    expect(written(d, 'desktopHosted')).not.toContain(true)
  })

  test('a fresh load 20 minutes into an idle period resumes it: the attempt comes at the 25th minute, not 25 minutes after the load', async ($, on) => {
    const d = dashboard(on)
    d.seedState('idleSince', CLOCK_START - 20 * MINUTE)
    await startSession($, d, 'desktop')
    await d.clock.advance(5 * MINUTE - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a fresh load after the 25th idle minute attempts at once', async ($, on) => {
    const d = dashboard(on)
    d.seedState('idleSince', CLOCK_START - 27 * MINUTE)
    await startSession($, d, 'desktop')
    await d.clock.advance(0)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a turn end records the period start', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await d.clock.advance(3 * MINUTE)
    await $.turn.complete(TURN)
    expect(written(d, 'idleSince').at(-1)).toBe(CLOCK_START + 3 * MINUTE)
  })

  test('a turn start clears the period start: a running turn is no idle period', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await $.turn.start(START)
    expect(written(d, 'idleSince').at(-1)).toBe(null)
  })

  test('a fresh load that finds a turn running sends nothing mid-turn, whatever period start was left; the turn end starts the idle time', async ($, on) => {
    const d = dashboard(on)
    d.seedState('turn', { isRunning: true, pending: [] })
    d.seedState('idleSince', CLOCK_START - 27 * MINUTE)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await d.clock.advance(2 * KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a session no desktop ever hosted stays unarmed through a session start', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
  })
})

describe('the bound and the cancels, on the desktop', () => {
  test('the give-up time is absolute: read latency does not push the last attempt past 29 minutes', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    d.world.contextDelayMs = 20_000
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS + 2 * MINUTE)
    // each attempt takes 20 s and the next starts a minute after it ended: 25:00, 26:20, 27:40 and 29:00, the one at the bound
    expect(reads(d)).toBe(4)
    expect(failures(d)).toHaveLength(4)
    expect(failures(d).at(-1)).toContain('gave up')
  })

  test('a failed attempt that was cancelled while it ran toasts nothing and does not displace the timer the new period set', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    d.world.contextDelayMs = 30_000
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    // the attempt is waiting on the registry; a turn runs and ends meanwhile, which starts a new idle period
    await $.turn.start(START)
    await $.turn.complete(TURN)
    d.world.contextDelayMs = 0
    await d.clock.advance(2 * MINUTE)
    expect(failures(d)).toEqual([])
    expect(reads(d)).toBe(1)
    d.world.eventText.tab_keepalive = EVENT_TEXT('tab_keepalive')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
  })
})

describe('the keepalive on the terminal', () => {
  test('never arms: a terminal session has no plan tab, at start or after a turn', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'terminal')
    await $.turn.complete(TURN)
    await d.clock.advance(2 * KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
  })

  test('is looked at again an idle period on: a desktop that attaches later hosts the session from then, though it detaches again', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
    await viewSession($, d, 'desktop')
    await leaveSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
  })
})
