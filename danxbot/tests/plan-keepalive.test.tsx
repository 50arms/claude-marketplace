// DX-3900: the plan-tab keepalive. The desktop app disconnects a session's preview 1800 s after its last turn ended; a plan-connected DESKTOP
// session idle for KEEPALIVE_IDLE_MS is sent one prompt (the registry's `tab_keepalive` wording plus the plan page) whose turn restarts that
// timer. A failed attempt is retried every KEEPALIVE_RETRY_MS inside the margin that is left, until KEEPALIVE_GIVE_UP_MS after the turn ended (an
// attempt that starts late, after the computer slept through its time, has the same margin from when it starts: KEEPALIVE_RETRY_WINDOW_MS).
import { describe, expect } from 'claude-code/testing'

import { KEEPALIVE_GIVE_UP_MS, KEEPALIVE_IDLE_MS, KEEPALIVE_RETRY_MS, KEEPALIVE_RETRY_WINDOW_MS, KEEPALIVE_WAKE_CHECK_MS, keepalivePrompt } from '../hooks/relay/keepalive'
import { OLDER_DASHBOARD_LINE, PAUSE_PATH } from '../hooks/reports/pause'
import { test, CLOCK_START, DASHBOARD_URL, EVENT_TEXT, answerPlanConnect, dashboard, forceRefresh, leaveSession, startSession, viewSession } from './plan-kit'

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

// DX-4806: a resumed session the desktop spawned and nobody has viewed: no attach, a detached roster at session.start. The environment names its host.
describe('a session whose process the desktop spawned (CLAUDE_CODE_ENTRYPOINT, DX-4806)', () => {
  const resumed = async ($: any, d: any) => {
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
  }

  test('a resumed, never-attached session with entrypoint claude-desktop is sent the keepalive at 25 minutes', async ($, on) => {
    const d = dashboard(on, { entrypoint: 'claude-desktop' })
    await resumed($, d)
    expect(d.roster).toEqual([])
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  // DX-4806: only claude-desktop arms; any other entrypoint (a terminal, the SDK, an IDE) must not
  for (const entrypoint of ['cli', 'claude-vscode', 'sdk-ts']) {
    test(`entrypoint ${entrypoint} never arms`, async ($, on) => {
      const d = dashboard(on, { entrypoint })
      await resumed($, d)
      await d.clock.advance(2 * KEEPALIVE_IDLE_MS)
      expect(sent(d)).toEqual([])
      expect(written(d, 'desktopHosted')).not.toContain(true)
    })
  }
})

// DX-4952: the engine's `$.clock.after` is a relative setTimeout, so the time the machine sleeps does not count toward it, while `$.clock.now()` is the
// wall clock (Date.now) and does. `d.suspend(ms)` is that sleep: the wall clock moves, no timer does. The keepalive reads the wall clock every
// KEEPALIVE_WAKE_CHECK_MS, so a wake is noticed within that, not after the rest of the 25 minutes.
describe('a computer that sleeps during the idle period (DX-4952)', () => {
  const HOURS = 60 * MINUTE

  test('a sleep past the idle time: the prompt is sent within one wake check of the machine waking, not 25 minutes on', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(5 * MINUTE)
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('is sent once: no wake check and no period after the send sends it again, a whole idle time on', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  // the wall clock reads exactly the due time when a wake check runs: due, not one slice later
  test('a wake check that finds the wall clock exactly at the due time sends the prompt then', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    d.suspend(KEEPALIVE_IDLE_MS - 2 * KEEPALIVE_WAKE_CHECK_MS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a sleep that leaves part of the idle time: the prompt waits for exactly the rest on the wall clock', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(5 * MINUTE)
    d.suspend(10 * MINUTE)
    await d.clock.advance(10 * MINUTE - 1)
    expect(sent(d)).toEqual([])
    await d.clock.advance(1)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a turn that starts after a wake, before the wake check, has the session re-check the tab (the turn start would cancel the check)', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await $.turn.start(START)
    await d.clock.settle()
    expect(sent(d)).toEqual([PROMPT])
  })

  test("a turn that starts while the app's 30 minutes are not yet over sends nothing: its own start restarts the app's timer", async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.suspend(KEEPALIVE_GIVE_UP_MS - 1)
    await $.turn.start(START)
    await d.clock.settle()
    expect(sent(d)).toEqual([])
  })

  test('a turn that starts at the give-up time re-checks the tab', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.suspend(KEEPALIVE_GIVE_UP_MS)
    await $.turn.start(START)
    await d.clock.settle()
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a re-check whose wording cannot be read is toasted once and sends nothing', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await $.turn.start(START)
    await d.clock.settle()
    expect(sent(d)).toEqual([])
    expect(d.toasts.filter(t => t.startsWith('Plan tab re-check failed'))).toHaveLength(1)
  })

  test("the keepalive's own turn does not send another: its start finds the period already answered", async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    expect(sent(d)).toEqual([PROMPT])
    await $.turn.start(START)
    await d.clock.settle()
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a terminal session never arms, asleep or not, and a turn start after a wake sends nothing', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    await $.turn.start(START)
    await d.clock.settle()
    expect(sent(d)).toEqual([])
  })

  // DX-4952: the network is often down just after a wake. The retries run from when the overdue attempt starts, not from the period's start.
  test('an attempt that fails right after a wake is tried again every minute: two failures, then it goes through', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    expect(reads(d)).toBe(1)
    expect(failures(d).at(-1)).toContain('trying again')
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(reads(d)).toBe(2)
    expect(sent(d)).toEqual([])
    d.world.eventText.tab_keepalive = EVENT_TEXT('tab_keepalive')
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(sent(d)).toEqual([PROMPT])
    expect(failures(d).some(t => t.includes('gave up'))).toBe(false)
  })

  test('a wake that never reads the wording gives up, loudly, once its own window (to the give-up time past the due time) is over', async ($, on) => {
    const d = dashboard(on)
    d.world.eventText.tab_keepalive = { status: 500 }
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS - KEEPALIVE_IDLE_MS)
    // attempts at the wake and each minute of the window after it, the one at its end the last
    expect(reads(d)).toBe(5)
    expect(failures(d).at(-1)).toContain('gave up')
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(reads(d)).toBe(5)
  })

  // DX-4952: the engine may raise the prompt's turn.start before the submit resolves
  test("the keepalive's own turn, started before its submit settles, does not queue a second prompt", async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.relay.duringPrompt(async () => {
      await $.turn.start(START)
    })
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    await d.clock.settle()
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a prompt the session did not take leaves the period in place: a turn that starts then is still told to re-check', async ($, on) => {
    const d = dashboard(on)
    d.relay.dropPrompts('busy')
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    expect(failures(d).some(t => t.includes('the prompt was not taken'))).toBe(true)
    d.relay.acceptPrompts()
    await $.turn.start(START)
    await d.clock.settle()
    expect(sent(d)).toEqual([PROMPT])
  })

  // DX-4952: the turn's own end restarts the period, which must not drop a re-check that is still reading its wording
  test('a turn that ends while the re-check reads its wording still delivers the re-check', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    d.world.contextDelayMs = MINUTE
    await $.turn.start(START)
    await $.turn.complete(TURN)
    await d.clock.advance(MINUTE)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a re-check that is reading its wording when the plan is left sends nothing', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    d.suspend(3 * HOURS)
    d.world.contextDelayMs = MINUTE
    await $.turn.start(START)
    await pane.press({ key: 'disconnect' })
    await d.clock.advance(2 * MINUTE)
    expect(sent(d)).toEqual([])
  })

  // DX-4952: an attempt is late when the wake check finds the wall clock MORE than one wake check past its due time. A check slice that ends on
  // time is never more than a few ms late, so the bound is one slice.
  describe('the on-time / late boundary of an attempt', () => {
    const attemptsWhenWakeCheckIs = async ($: any, on: any, pastDueMs: number): Promise<number> => {
      const d = dashboard(on)
      d.world.eventText.tab_keepalive = { status: 500 }
      await startSession($, d, 'desktop')
      // the first wake check runs KEEPALIVE_WAKE_CHECK_MS in; the wall clock then reads the due time plus `pastDueMs`
      d.suspend(KEEPALIVE_IDLE_MS + pastDueMs - KEEPALIVE_WAKE_CHECK_MS)
      await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
      await d.clock.advance(KEEPALIVE_RETRY_WINDOW_MS + MINUTE)
      return reads(d)
    }

    test('exactly one wake check past the due time is on time: the retries end at the give-up time (4 attempts)', async ($, on) => {
      expect(await attemptsWhenWakeCheckIs($, on, KEEPALIVE_WAKE_CHECK_MS)).toBe(4)
    })

    test('one millisecond more is late: the retry window runs from when the attempt starts (5 attempts)', async ($, on) => {
      expect(await attemptsWhenWakeCheckIs($, on, KEEPALIVE_WAKE_CHECK_MS + 1)).toBe(5)
    })
  })

  // DX-4952: the points of fireKeepalive a cancel can land on
  describe('a cancel that lands inside an attempt', () => {
    const disconnect = async ($: any) => {
      const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
      return () => pane.press({ key: 'disconnect' })
    }

    test('after the attempt read the period but before it cleared it: a newer period that began meanwhile is not cleared, and nothing is sent', async ($, on) => {
      const d = dashboard(on, { stateSteps: true })
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, 'desktop')
      d.suspend(3 * HOURS)
      // the attempt's read of the period start is the next read of it; a turn ends there, which starts a newer period
      d.beforeNextRead('idleSince', () => $.turn.complete(TURN))
      await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
      await d.clock.settle()
      expect(sent(d)).toEqual([])
      const writes = written(d, 'idleSince') as (number | null)[]
      expect(writes.at(-1)).not.toBe(null)
      expect(writes.at(-1)).toBeGreaterThan(CLOCK_START)
    })

    test('after the period was cleared but before the prompt: the prompt is not sent', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, 'desktop')
      d.suspend(3 * HOURS)
      // the attempt's clear is the next write of the period; a turn ends just before it lands
      d.beforeNextWrite('idleSince', () => $.turn.complete(TURN))
      await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
      await d.clock.settle()
      expect(sent(d)).toEqual([])
    })

    test('a prompt rejected after the plan was left puts nothing back into the period', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, 'desktop')
      const leave = await disconnect($)
      d.relay.dropPrompts('busy')
      d.relay.duringPrompt(leave)
      d.suspend(3 * HOURS)
      await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
      await d.clock.settle()
      expect(written(d, 'idleSince').at(-1)).toBe(null)
    })

    test("a prompt rejected after a newer period was started keeps the newer period: only an empty one gets the old start back", async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, 'desktop')
      d.suspend(3 * HOURS)
      d.relay.dropPrompts('busy')
      // the re-check's submit: the turn that started it ends meanwhile, which starts a new period
      d.relay.duringPrompt(() => $.turn.complete(TURN))
      await $.turn.start(START)
      await d.clock.settle()
      const writes = written(d, 'idleSince') as (number | null)[]
      expect(writes.at(-1)).not.toBe(null)
      expect(writes.at(-1)).toBeGreaterThan(CLOCK_START)
      expect(writes.at(-1)).not.toBe(writes[0])
    })

    // the turn start cancels first: an attempt that is about to send, while the turn start still waits on its reads, sends nothing
    test('a turn start cancels the attempt before its own reads: the attempt in flight does not send while they wait', async ($, on) => {
      const d = dashboard(on, { stateSteps: true })
      await startSession($, d, 'desktop')
      d.world.contextDelayMs = MINUTE
      await d.clock.advance(KEEPALIVE_IDLE_MS)
      // the attempt is now reading its wording (one minute); the turn start's first read of the period waits two
      d.beforeNextRead('idleSince', () => d.clock.sleep(2 * MINUTE))
      const started = $.turn.start(START)
      await d.clock.advance(MINUTE + 1)
      expect(sent(d)).toEqual([])
      await d.clock.advance(2 * MINUTE)
      await started
      expect(sent(d)).toEqual([])
    })
  })
})

// DX-4997: a session in an agent pause is not prompted; the tab is checked once, by the turn that ends the pause.
describe('the keepalive while the session is in an agent pause', () => {
  const AGENT_PAUSE = () => ({ limit: 'agent', state: 'agent_waiting', reason: 'waiting for a build', ends_when: null, since: '2026-10-13T20:00:00.000Z', until: new Date(CLOCK_START + 3 * 3_600_000).toISOString(), held: 0 })
  const pauseReads = (d: any): number => d.reports.filter((r: any) => r.path === PAUSE_PATH).length

  test('sends no prompt for as long as the pause lasts, however many periods pass, and schedules nothing more', async ($, on) => {
    const d = dashboard(on)
    d.world.pause = AGENT_PAUSE()
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS * 4)
    expect(sent(d)).toEqual([])
    expect(pauseReads(d)).toBe(1)
    expect(failures(d)).toEqual([])
  })

  test('the turn that ends the pause has the session re-check its tab once; the keepalive is back after that turn', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    d.world.pause = AGENT_PAUSE()
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS * 2)
    expect(sent(d)).toEqual([])
    d.world.pause = null
    await $.turn.start(START)
    await d.clock.settle()
    expect(sent(d)).toEqual([PROMPT])
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT, PROMPT])
  })

  test('no pause: the prompt goes, after one pause read', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
    expect(pauseReads(d)).toBe(1)
  })

  test('a pause read that fails is toasted and retried like any failed attempt, sending nothing', async ($, on) => {
    const d = dashboard(on)
    d.world.reportReplies[`GET ${PAUSE_PATH}`] = { status: 500, body: { error: 'pause boom' } }
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([])
    expect(failures(d)).toEqual(['Plan tab keepalive failed, trying again: the pause was not read: 500: pause boom'])
    delete d.world.reportReplies[`GET ${PAUSE_PATH}`]
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(sent(d)).toEqual([PROMPT])
  })

  test('a dashboard without the pause route is not paused: the prompt goes, and the person is told once', async ($, on) => {
    const d = dashboard(on)
    d.world.reportReplies[`GET ${PAUSE_PATH}`] = { status: 404, body: { error: 'Not found' } }
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(sent(d)).toEqual([PROMPT])
    expect(d.toasts.filter((t: string) => t === OLDER_DASHBOARD_LINE)).toHaveLength(1)
  })
})
