// DX-3900 / DX-5093: the plan-tab keepalive. The desktop app disconnects a session's preview 1800 s after its last turn ended; a plan-connected DESKTOP
// session idle for KEEPALIVE_IDLE_MS is looked at by the module itself: it asks the Browser pane's server which tabs the pane holds and opens the plan
// page again when its tab is missing, with no model turn (no prompt is ever submitted). The next look is an idle period on, the cadence the keepalive always had. A failed
// attempt is retried every KEEPALIVE_RETRY_MS inside the margin that is left, until KEEPALIVE_GIVE_UP_MS after the turn ended (an attempt that starts late,
// after the computer slept through its time, has the same margin from when it starts: KEEPALIVE_RETRY_WINDOW_MS).
import { describe, expect } from 'claude-code/testing'

import { KEEPALIVE_GIVE_UP_MS, KEEPALIVE_IDLE_MS, KEEPALIVE_RETRY_MS, KEEPALIVE_RETRY_WINDOW_MS, KEEPALIVE_WAKE_CHECK_MS } from '../hooks/relay/keepalive'
import { appendTrace, dataDirOf, TRACE_MAX_LINES, traceLine } from '../hooks/relay/trace'
import { createdTab, failureOf, holdsPlanTab, isBrowserKeepaliveTool, paneState } from '../hooks/relay/browser'
import { PAUSE_PATH } from '../hooks/reports/pause'
import { test, CLOCK_START, DASHBOARD_URL, HOME_DIR, answerPlanConnect, dashboard, forceRefresh, leaveSession, startSession, viewSession } from './plan-kit'

const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const START = { turnId: 't1' } as any
const MINUTE = 60_000
const HOURS = 60 * MINUTE
const written = (d: any, key: string): unknown[] => d.stateWrites.filter((w: any) => w.plugin === 'danxbot' && w.key === key).map((w: any) => w.value)
const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any

// no model turn: EVERY prompt the plugin submitted, marked as a plan event or not (the kit's `delivered` holds only the marked ones)
const sent = (d: any): string[] => d.relay.submitted
// every call the module made to the Browser pane's server, in order
const calls = (d: any): string[] => d.world.browser.calls
const looks = (d: any): number => calls(d).filter(c => c === 'tabs_context').length
const opens = (d: any): string[] => calls(d).filter(c => c.startsWith('navigate'))
const pageOf = (planId: number) => `${DASHBOARD_URL}/plans/${planId}`
const failures = (d: any): string[] => d.toasts.filter((t: string) => t.startsWith('Plan tab keepalive'))
// a pane the app closed: the plan page is opened again by `navigate` alone
const closePane = (d: any) => {
  d.world.browser.open = false
  d.world.browser.tabs = []
}

describe('the Browser pane answers, as the module reads them', () => {
  const answer = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError })

  test('tabs_context: closed, open with the origins of its tabs, or unreadable', () => {
    expect(paneState(answer({ browserOpen: false, tabs: [] }))).toEqual({ kind: 'closed' })
    expect(paneState(answer({ browserOpen: true, tabs: [{ tabId: 'seed', origin: 'https://danxbot.sageus.ai', isActive: true }] }))).toEqual({ kind: 'open', origins: ['https://danxbot.sageus.ai'] })
    expect(paneState({ content: [{ type: 'text', text: '{"browserOpen":true,"tabs":[]}' }, { type: 'text', text: 'The Browser pane is currently hidden.' }], isError: false })).toEqual({ kind: 'open', origins: [] })
    expect(paneState(answer({ tabs: [] })).kind).toBe('unreadable')
    expect(paneState(answer({ browserOpen: true })).kind).toBe('unreadable')
    expect(paneState({ content: [{ type: 'text', text: 'not json' }], isError: false }).kind).toBe('unreadable')
    expect(paneState(answer('x', true))).toEqual({ kind: 'unreadable', why: 'tabs_context failed: "x"' })
  })

  // the two answers a live trace recorded, verbatim: one text block, the pretty-printed object, a newline, a sentence
  const CLOSED_VERBATIM = '{\n  "browserOpen": false,\n  "tabs": []\n}\nThe Browser pane isn\'t open yet, so there are no tabs. Call preview_start or navigate with {"url": "https://…"} to open it.'
  const HIDDEN_VERBATIM = '{\n  "browserOpen": true,\n  "tabs": [\n    {\n      "tabId": "seed",\n      "origin": "https://danxbot.sageus.ai",\n      "isActive": true\n    }\n  ]\n}\nThe Browser pane is currently hidden.'

  test('tabs_context as the live pane answers it: the object, then a sentence in the same block', () => {
    expect(paneState({ content: [{ type: 'text', text: CLOSED_VERBATIM }], isError: false })).toEqual({ kind: 'closed' })
    expect(paneState({ content: [{ type: 'text', text: HIDDEN_VERBATIM }], isError: false })).toEqual({ kind: 'open', origins: ['https://danxbot.sageus.ai'] })
    // braces inside a string or in the sentence do not end or extend the object
    expect(paneState({ content: [{ type: 'text', text: '{"browserOpen":true,"tabs":[{"tabId":"a}","origin":"https://x.test","isActive":true}]}\nUse {"url": 1}' }], isError: false })).toEqual({ kind: 'open', origins: ['https://x.test'] })
    expect(paneState({ content: [{ type: 'text', text: '{"browserOpen":true,"tabs":[' }], isError: false }).kind).toBe('unreadable')
  })

  test('the plan page is held by a tab on its site', () => {
    expect(holdsPlanTab({ kind: 'open', origins: ['http://localhost:5555'] }, 'http://localhost:5555/plans/23')).toBe(true)
    expect(holdsPlanTab({ kind: 'open', origins: ['https://example.com'] }, 'http://localhost:5555/plans/23')).toBe(false)
    expect(holdsPlanTab({ kind: 'open', origins: [] }, 'http://localhost:5555/plans/23')).toBe(false)
  })

  test('tabs_create names the new tab; an answer without one names none', () => {
    expect(createdTab(answer({ serverId: 's', tabId: 'tab-1', reused: false, type: 'browser' }))).toEqual({ kind: 'created', tabId: 'tab-1' })
    expect(createdTab(answer({ serverId: 's' })).kind).toBe('refused')
    expect(createdTab(answer({ tabId: 'tab-1' }, true)).kind).toBe('refused')
  })

  test('a reused tab is refused: it may be one the person holds', () => {
    expect(createdTab(answer({ serverId: 's', tabId: 'tab-1', reused: true, type: 'browser' })).kind).toBe('refused')
  })

  test('a failed answer is a sentence naming the tool; a good one is none', () => {
    expect(failureOf('navigate', { content: [{ type: 'text', text: 'site not allowed' }], isError: true })).toBe('navigate failed: site not allowed')
    expect(failureOf('navigate', { content: [{ type: 'text', text: 'ok' }], isError: false })).toBe(null)
  })

  test('the three pane tools the keepalive calls are the only ones the plugin grants itself', () => {
    expect(['tabs_context', 'tabs_create', 'navigate'].every(tool => isBrowserKeepaliveTool(`mcp__Claude_Browser__${tool}`))).toBe(true)
    expect(isBrowserKeepaliveTool('mcp__Claude_Browser__computer')).toBe(false)
    expect(isBrowserKeepaliveTool('mcp__Claude_Browser__javascript_tool')).toBe(false)
    expect(isBrowserKeepaliveTool('mcp__other__navigate')).toBe(false)
  })
})

describe('the no-prompt guard of these tests', () => {
  test('sees a prompt that carries no plan-event marker', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await $.prompt.submit({ text: 'Plan tab keepalive. check the tab' } as any)
    expect(sent(d)).toEqual(['Plan tab keepalive. check the tab'])
    expect(d.relay.delivered).toEqual([])
  })
})

// DX-5093: the trace lines the keepalive wrote for the session, parsed (a kit session is a folder-loaded plugin: its data directory is the home's `danxbot-inline`)
const traces = (d: any): any[] =>
  (d.world.files[`${HOME_DIR}/.claude/plugins/data/danxbot-inline/keepalive-trace/${d.world.sessionId}.log`] ?? '')
    .split('\n')
    .filter((l: string) => l !== '')
    .map((l: string) => JSON.parse(l))
const looksTraced = (d: any): any[] => traces(d).filter(t => t.event === 'look')

describe('the keepalive trace', () => {
  test('the data directory: a cached plugin has its marketplace-named one, a folder-loaded plugin the inline one, none without a home', () => {
    expect(dataDirOf('C:\\Users\\u\\.claude\\plugins\\cache\\50arms\\danxbot\\0.15.19', 'danxbot', null)).toBe('C:/Users/u/.claude/plugins/data/danxbot-50arms')
    expect(dataDirOf('/work/claude-plugins/danxbot', 'danxbot', '/home/u')).toBe('/home/u/.claude/plugins/data/danxbot-inline')
    expect(dataDirOf('/work/claude-plugins/danxbot', 'danxbot', null)).toBe(null)
  })

  test('the file keeps the newest lines only', () => {
    let text = ''
    for (let i = 0; i < TRACE_MAX_LINES + 5; i++) text = appendTrace(text, traceLine(i, 's', { event: 'look', note: String(i) }))
    const lines = text.split('\n').filter(l => l !== '')
    expect(lines.length).toBe(TRACE_MAX_LINES)
    expect(JSON.parse(lines.at(-1)!).note).toBe(String(TRACE_MAX_LINES + 4))
    expect(JSON.parse(lines[0]).note).toBe('5')
  })

  test('a period begins with a line naming when its look is due', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    const period = traces(d).find(t => t.event === 'period')
    expect(period.session).toBe(d.world.sessionId)
    expect(period.plan).toBe(23)
    expect(period.note).toBe(`next look due ${new Date(CLOCK_START + KEEPALIVE_IDLE_MS).toISOString()}`)
  })

  test('a look that holds the tab traces the tabs it found and the pane\'s own words', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    const [look] = looksTraced(d)
    expect(look).toMatchObject({ session: d.world.sessionId, plan: 23, trigger: 'idle period', tabs: [new URL(DASHBOARD_URL).origin], action: 'none', outcome: 'checked' })
    expect(look.note).toContain('tabs_context: ')
    expect(look.error).toBeUndefined()
  })

  test('a look that opens a closed pane traces the navigate and what the pane answered', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    closePane(d)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    const [look] = looksTraced(d)
    expect(look).toMatchObject({ tabs: [], action: 'navigate', outcome: 'checked' })
    expect(look.note).toContain('navigate: ')
  })

  test('a failed look traces the error; a session with no pane server and a terminal session trace their outcome', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.world.browser.errors.tabs_context = 'pane unavailable'
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looksTraced(d)[0]).toMatchObject({ outcome: 'failed', error: expect.stringContaining('pane unavailable') })
    d.world.browser.errors = {}
    d.world.browser.present = false
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(looksTraced(d).at(-1)).toMatchObject({ outcome: 'no-browser' })
  })

  test('a trace that cannot be written is toasted once and does not stop the looks', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.world.fsError = 'EACCES'
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(2)
    expect(d.toasts.filter((t: string) => t.startsWith('danxbot: the keepalive trace could not be written')).length).toBe(1)
  })
})

describe('the keepalive on the desktop', () => {
  test('an idle plan-connected session has its pane looked at once after the idle time, and no prompt is submitted', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(calls(d)).toEqual(['tabs_context'])
    expect(sent(d)).toEqual([])
  })

  test('a pane that holds the plan tab is left as it is, and looked at again an idle period on, never sooner', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(looks(d)).toBe(1)
    await d.clock.advance(1)
    expect(looks(d)).toBe(2)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(3)
    expect(opens(d)).toEqual([])
    expect(sent(d)).toEqual([])
    expect(failures(d)).toEqual([])
  })

  test('a closed pane is opened at the plan page by navigate, and is held from then', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    closePane(d)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual(['tabs_context', `navigate ${pageOf(23)} -`])
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual(['tabs_context', `navigate ${pageOf(23)} -`, 'tabs_context'])
    expect(sent(d)).toEqual([])
  })

  test('an open pane without a tab on the plan page gets a tab of its own, so the page a person reads is never navigated away', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.world.browser.tabs = ['https://example.com']
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual(['tabs_context', 'tabs_create', `navigate ${pageOf(23)} tab-1`])
    expect(failures(d)).toEqual([])
  })

  test('the keepalive is no cost to a paused session: the pause is not read and the pane is looked at', async ($, on) => {
    const d = dashboard(on)
    d.world.pause = { limit: 'agent', state: 'agent_waiting', reason: 'waiting for a build', ends_when: null, since: '2026-10-13T20:00:00.000Z', until: new Date(CLOCK_START + 3 * HOURS).toISOString(), held: 0 }
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
    expect(d.reports.filter((r: any) => r.path === PAUSE_PATH)).toEqual([])
  })

  test('a turn in flight looks at nothing, however long it runs', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await $.turn.start(START)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
  })

  test('the end of a turn restarts the idle time from that end', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await $.turn.start(START)
    await d.clock.advance(20 * MINUTE)
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(looks(d)).toBe(1)
  })

  test("a sub-agent's turn end is not the session going idle: it does not move the timer", async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await d.clock.advance(20 * MINUTE)
    await $.turn.complete({ ...TURN, agentId: 'a1' })
    await d.clock.advance(5 * MINUTE)
    expect(looks(d)).toBe(1)
  })

  test('a turn that begins while the pane is being read cancels the attempt: nothing is opened or scheduled for the period that is over', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    closePane(d)
    d.world.browser.delayMs = MINUTE
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    await $.turn.start(START)
    await d.clock.advance(2 * MINUTE)
    expect(opens(d)).toEqual([])
    expect(failures(d)).toEqual([])
  })

  test('the end of the process ends it', async ($, on) => {
    const d = dashboard(on)
    on('session.end', () => ({ sessionId: 's1' }) as any)
    await startSession($, d, 'desktop')
    await $.session.end({ reason: 'logout' } as any)
    expect(written(d, 'idleSince').at(-1)).toBe(null)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
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
    expect(calls(d)).toEqual([])
    expect(failures(d)).toEqual([])
  })

  test('a session on no plan gets none, a turn end included', async ($, on) => {
    const d = dashboard(on, { connected: false })
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
  })

  test("a move to another plan restarts the idle time and opens the new plan's page", async ($, on) => {
    const d = dashboard(on)
    answerPlanConnect(on, d)
    await startSession($, d, 'desktop')
    await d.clock.advance(20 * MINUTE)
    await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 24 } as any)
    await d.clock.settle()
    closePane(d)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(calls(d)).toEqual(['tabs_context', `navigate ${pageOf(24)} -`])
  })
})

describe('a session whose desktop has no Browser pane server', () => {
  const missing = (d: any): string[] => d.toasts.filter((t: string) => t.includes('Browser pane is not reachable'))

  test('is toasted exactly once, however many idle periods pass, and no prompt stands in for the pane', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.present = false
    await startSession($, d, 'desktop')
    expect(missing(d)).toEqual([])
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(missing(d)).toHaveLength(1)
    expect(missing(d)[0]).toContain('30 idle minutes')
    await d.clock.advance(3 * KEEPALIVE_IDLE_MS)
    expect(missing(d)).toHaveLength(1)
    expect(failures(d)).toEqual([])
    expect(sent(d)).toEqual([])
  })

  test('is looked at again an idle period on, and the pane is used once it appears', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.present = false
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    d.world.browser.present = true
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
    expect(missing(d)).toHaveLength(1)
  })

  test('the toast is remembered in $.state, so a reload of the module does not say it again', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.present = false
    d.seedState('browserMissingTold', true)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(missing(d)).toEqual([])
    expect(written(d, 'browserMissingTold')).not.toContain(false)
  })

  test('the first toast is written to $.state', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.present = false
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(written(d, 'browserMissingTold')).toEqual([true])
  })

  test('a terminal session, which has no plan tab, is never told', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.present = false
    await startSession($, d, 'terminal')
    await d.clock.advance(2 * KEEPALIVE_IDLE_MS)
    expect(missing(d)).toEqual([])
  })

  test('a session on no plan is never told', async ($, on) => {
    const d = dashboard(on, { connected: false })
    d.world.browser.present = false
    await startSession($, d, 'desktop')
    await d.clock.advance(2 * KEEPALIVE_IDLE_MS)
    expect(missing(d)).toEqual([])
  })
})

describe('a failed attempt on the desktop', () => {
  test('a pane that cannot be read is toasted and tried again a minute later, inside the margin, not a full idle period later', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.errors.tabs_context = 'pane is starting'
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
    expect(failures(d)).toHaveLength(1)
    expect(failures(d)[0]).toContain('trying again')
    expect(failures(d)[0]).toContain('pane is starting')
    delete d.world.browser.errors.tabs_context
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(looks(d)).toBe(2)
    expect(failures(d)).toHaveLength(1)
  })

  test('a plan page that cannot be opened is the same, and says why', async ($, on) => {
    const d = dashboard(on)
    closePane(d)
    d.world.browser.errors.navigate = 'site not allowed'
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(failures(d)[0]).toContain('navigate failed: site not allowed')
    delete d.world.browser.errors.navigate
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(opens(d)).toEqual([`navigate ${pageOf(23)} -`, `navigate ${pageOf(23)} -`])
    expect(failures(d)).toHaveLength(1)
  })

  test('a tab that cannot be created is the same', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.tabs = ['https://example.com']
    d.world.browser.errors.tabs_create = 'no room'
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(failures(d)[0]).toContain('tabs_create failed: no room')
    expect(opens(d)).toEqual([])
  })

  test('a refused or timed-out call is the same, with the engine words', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.rejects = 'request timed out after 60000ms'
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(failures(d)[0]).toContain('request timed out after 60000ms')
  })

  test('a plan page that is not loaded at that moment is the same: tried again a minute later, with the page once it is', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    closePane(d)
    d.failList()
    await forceRefresh($, d)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
    expect(failures(d).some(t => t.includes('not loaded'))).toBe(true)
    d.failList(false)
    await forceRefresh($, d)
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(opens(d)).toEqual([`navigate ${pageOf(23)} -`])
  })

  test('gives up, loudly, once the app has had its 30 minutes: no attempt after the give-up time', async ($, on) => {
    const d = dashboard(on)
    closePane(d)
    d.world.browser.errors.navigate = 'down'
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS)
    const told = failures(d)
    expect(told.at(-1)).toContain('gave up')
    // attempts at 25, 26, 27, 28 and 29 minutes: the one at the bound is the last
    expect(opens(d)).toHaveLength(5)
    expect(told).toHaveLength(5)
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(opens(d)).toHaveLength(5)
    expect(failures(d)).toEqual(told)
  })

  // DX-4806: a give-up ends that period, not the keepalive: the next idle period is started with no turn end in between
  test('after giving up, the next idle period is armed by itself and its attempt goes through', async ($, on) => {
    const d = dashboard(on)
    closePane(d)
    d.world.browser.errors.navigate = 'down'
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS)
    expect(failures(d).at(-1)).toContain('gave up')
    delete d.world.browser.errors.navigate
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(opens(d)).toHaveLength(5)
    await d.clock.advance(1)
    expect(opens(d)).toHaveLength(6)
    expect(d.world.browser.open).toBe(true)
  })

  test('the next period after a give-up has its own 29-minute window: its failures are retried every minute again, then it gives up again', async ($, on) => {
    const d = dashboard(on)
    closePane(d)
    d.world.browser.errors.navigate = 'down'
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS)
    expect(opens(d)).toHaveLength(5)
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(opens(d)).toHaveLength(6)
    await d.clock.advance(4 * MINUTE)
    // attempts at 54, 55, 56, 57 and 58 minutes: the second period began at 29 and ends at 29 + 29
    expect(opens(d)).toHaveLength(10)
    expect(failures(d)).toHaveLength(10)
    expect(failures(d).at(-1)).toContain('gave up')
    await d.clock.advance(KEEPALIVE_RETRY_MS - 1)
    expect(opens(d)).toHaveLength(10)
  })

  test('a period that starts after a not-desktop look has its own 29-minute window, not the earlier one', async ($, on) => {
    const d = dashboard(on)
    closePane(d)
    d.world.browser.errors.navigate = 'down'
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
    await viewSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS + 4 * MINUTE)
    // the desktop is hosting from minute 25; its period began at 25, so attempts at 50, 51, 52, 53 and 54
    expect(opens(d)).toHaveLength(5)
    expect(failures(d).at(-1)).toContain('gave up')
  })

  test('a failure after a good look is retried within its own window, then the next look is an idle period on', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
    d.world.browser.errors.tabs_context = 'busy'
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(2)
    delete d.world.browser.errors.tabs_context
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(looks(d)).toBe(3)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(looks(d)).toBe(3)
    await d.clock.advance(1)
    expect(looks(d)).toBe(4)
  })

  test('a tab the pane hands back as reused is not navigated, and is toasted', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.tabs = ['https://example.com']
    d.world.browser.reuses = true
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(failures(d)[0]).toContain('already existed')
    expect(opens(d)).toEqual([])
  })
})

describe('a desktop-hosted session, whatever is attached at that moment', () => {
  test('is looked at although no client is attached (the app detaches about 5 s after the start)', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    expect(d.roster).toEqual([])
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
  })

  test('is looked at after the person viewed it and left again', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await viewSession($, d, 'desktop')
    await leaveSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
  })

  test('a session that attached the desktop but whose start did not list it is hosted from the attach', async ($, on) => {
    const d = dashboard(on)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
    await viewSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
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
    expect(looks(d)).toBe(1)
  })

  test('a turn that ends with no turn.start seen (a background-task notification turn) still starts the idle time', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await d.clock.advance(10 * MINUTE)
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(looks(d)).toBe(1)
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

  test('a fresh load 20 minutes into an idle period resumes it: the look comes at the 25th minute, not 25 minutes after the load', async ($, on) => {
    const d = dashboard(on)
    d.seedState('idleSince', CLOCK_START - 20 * MINUTE)
    await startSession($, d, 'desktop')
    await d.clock.advance(5 * MINUTE - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(looks(d)).toBe(1)
  })

  test('a fresh load after the 25th idle minute looks at once', async ($, on) => {
    const d = dashboard(on)
    d.seedState('idleSince', CLOCK_START - 27 * MINUTE)
    await startSession($, d, 'desktop')
    await d.clock.advance(0)
    expect(looks(d)).toBe(1)
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

  test('a look starts the next idle period from itself', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
    expect(written(d, 'idleSince').at(-1)).toBe(CLOCK_START + KEEPALIVE_IDLE_MS)
  })

  test('a fresh load that finds a turn running looks at nothing mid-turn, whatever period start was left; the turn end starts the idle time', async ($, on) => {
    const d = dashboard(on)
    d.seedState('turn', { isRunning: true, pending: [] })
    d.seedState('idleSince', CLOCK_START - 27 * MINUTE)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    await d.clock.advance(2 * KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
    await $.turn.complete(TURN)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(looks(d)).toBe(1)
  })

  test('a session no desktop ever hosted stays unarmed through a session start', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
  })
})

describe('the bound and the cancels, on the desktop', () => {
  test('the give-up time is absolute: read latency does not push the last attempt past 29 minutes', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.errors.tabs_context = 'down'
    await startSession($, d, 'desktop')
    d.world.browser.delayMs = 20_000
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS + 2 * MINUTE)
    // each attempt takes 20 s and the next starts a minute after it ended: 25:00, 26:20, 27:40 and 29:00, the one at the bound
    expect(looks(d)).toBe(4)
    expect(failures(d)).toHaveLength(4)
    expect(failures(d).at(-1)).toContain('gave up')
  })

  test('a failed attempt that was cancelled while it ran toasts nothing and does not displace the timer the new period set', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    d.world.browser.errors.tabs_context = 'down'
    await startSession($, d, 'desktop')
    d.world.browser.delayMs = 30_000
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    // the attempt is waiting on the pane; a turn runs and ends meanwhile, which starts a new idle period
    await $.turn.start(START)
    await $.turn.complete(TURN)
    d.world.browser.delayMs = 0
    await d.clock.advance(2 * MINUTE)
    expect(failures(d)).toEqual([])
    expect(looks(d)).toBe(1)
    delete d.world.browser.errors.tabs_context
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(2)
    expect(failures(d)).toEqual([])
  })
})

describe('the keepalive on the terminal', () => {
  test('never arms: a terminal session has no plan tab, at start or after a turn', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'terminal')
    await $.turn.complete(TURN)
    await d.clock.advance(2 * KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
  })

  test('is looked at again an idle period on: a desktop that attaches later hosts the session from then, though it detaches again', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(calls(d)).toEqual([])
    await viewSession($, d, 'desktop')
    await leaveSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_IDLE_MS)
    expect(looks(d)).toBe(1)
  })
})

// DX-4806: a resumed session the desktop spawned and nobody has viewed: no attach, a detached roster at session.start. The environment names its host.
describe('a session whose process the desktop spawned (CLAUDE_CODE_ENTRYPOINT, DX-4806)', () => {
  const resumed = async ($: any, d: any) => {
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await d.clock.settle()
  }

  test('a resumed, never-attached session with entrypoint claude-desktop has its pane looked at at 25 minutes', async ($, on) => {
    const d = dashboard(on, { entrypoint: 'claude-desktop' })
    await resumed($, d)
    expect(d.roster).toEqual([])
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(looks(d)).toBe(1)
  })

  // DX-4806: only claude-desktop arms; any other entrypoint (a terminal, the SDK, an IDE) must not
  for (const entrypoint of ['cli', 'claude-vscode', 'sdk-ts']) {
    test(`entrypoint ${entrypoint} never arms`, async ($, on) => {
      const d = dashboard(on, { entrypoint })
      await resumed($, d)
      await d.clock.advance(2 * KEEPALIVE_IDLE_MS)
      expect(calls(d)).toEqual([])
      expect(written(d, 'desktopHosted')).not.toContain(true)
    })
  }
})

// DX-4952: the engine's `$.clock.after` is a relative setTimeout, so the time the machine sleeps does not count toward it, while `$.clock.now()` is the
// wall clock (Date.now) and does. `d.suspend(ms)` is that sleep: the wall clock moves, no timer does. The keepalive reads the wall clock every
// KEEPALIVE_WAKE_CHECK_MS, so a wake is noticed within that, not after the rest of the 25 minutes.
describe('a computer that sleeps during the idle period (DX-4952)', () => {
  test('a sleep past the idle time: the pane is looked at within one wake check of the machine waking, not 25 minutes on', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(5 * MINUTE)
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    expect(looks(d)).toBe(1)
  })

  test('is looked at once at the wake: no wake check after it looks again before an idle period is over', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    await d.clock.advance(KEEPALIVE_IDLE_MS - 1)
    expect(looks(d)).toBe(1)
  })

  // the wall clock reads exactly the due time when a wake check runs: due, not one slice later
  test('a wake check that finds the wall clock exactly at the due time looks then', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    d.suspend(KEEPALIVE_IDLE_MS - 2 * KEEPALIVE_WAKE_CHECK_MS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(looks(d)).toBe(1)
  })

  test('a sleep that leaves part of the idle time: the look waits for exactly the rest on the wall clock', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await d.clock.advance(5 * MINUTE)
    d.suspend(10 * MINUTE)
    await d.clock.advance(10 * MINUTE - 1)
    expect(calls(d)).toEqual([])
    await d.clock.advance(1)
    expect(looks(d)).toBe(1)
  })

  test('a turn that starts after a wake, before the wake check, has its pane looked at at once and a missing tab opened (the turn start would cancel the check)', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    closePane(d)
    d.suspend(3 * HOURS)
    await $.turn.start(START)
    await d.clock.settle()
    expect(calls(d)).toEqual(['tabs_context', `navigate ${pageOf(23)} -`])
    expect(sent(d)).toEqual([])
  })

  test("a turn that starts while the app's 30 minutes are not yet over looks at nothing: its own start restarts the app's timer", async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.suspend(KEEPALIVE_GIVE_UP_MS - 1)
    await $.turn.start(START)
    await d.clock.settle()
    expect(calls(d)).toEqual([])
  })

  test('a turn that starts at the give-up time looks at the pane', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    d.suspend(KEEPALIVE_GIVE_UP_MS)
    await $.turn.start(START)
    await d.clock.settle()
    expect(looks(d)).toBe(1)
  })

  test('a re-check whose pane cannot be read is toasted once', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.errors.tabs_context = 'down'
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await $.turn.start(START)
    await d.clock.settle()
    expect(d.toasts.filter(t => t.startsWith('Plan tab re-check failed'))).toHaveLength(1)
  })

  test('a terminal session never arms, asleep or not, and a turn start after a wake looks at nothing', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    await $.turn.start(START)
    await d.clock.settle()
    expect(calls(d)).toEqual([])
  })

  // DX-4952: the network is often down just after a wake. The retries run from when the overdue attempt starts, not from the period's start.
  test('an attempt that fails right after a wake is tried again every minute: two failures, then it goes through', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.errors.tabs_context = 'down'
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    expect(looks(d)).toBe(1)
    expect(failures(d).at(-1)).toContain('trying again')
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(looks(d)).toBe(2)
    delete d.world.browser.errors.tabs_context
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(looks(d)).toBe(3)
    expect(failures(d).some(t => t.includes('gave up'))).toBe(false)
  })

  test('a wake whose pane is never read gives up, loudly, once its own window (to the give-up time past the due time) is over', async ($, on) => {
    const d = dashboard(on)
    d.world.browser.errors.tabs_context = 'down'
    await startSession($, d, 'desktop')
    d.suspend(3 * HOURS)
    await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
    await d.clock.advance(KEEPALIVE_GIVE_UP_MS - KEEPALIVE_IDLE_MS)
    // attempts at the wake and each minute of the window after it, the one at its end the last
    expect(looks(d)).toBe(5)
    expect(failures(d).at(-1)).toContain('gave up')
    await d.clock.advance(KEEPALIVE_RETRY_MS)
    expect(looks(d)).toBe(5)
  })

  // DX-4952: the turn's own end restarts the period, which must not drop a re-check that is still reading the pane
  test('a turn that ends while the re-check reads the pane still opens the missing tab', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    closePane(d)
    d.suspend(3 * HOURS)
    d.world.browser.delayMs = MINUTE
    await $.turn.start(START)
    await $.turn.complete(TURN)
    // the look and the opening each take the pane's minute
    await d.clock.advance(2 * MINUTE)
    expect(opens(d)).toEqual([`navigate ${pageOf(23)} -`])
  })

  test('a re-check that is reading the pane when the plan is left opens nothing', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    closePane(d)
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    d.suspend(3 * HOURS)
    d.world.browser.delayMs = MINUTE
    await $.turn.start(START)
    await pane.press({ key: 'disconnect' })
    await d.clock.advance(2 * MINUTE)
    expect(opens(d)).toEqual([])
  })

  // DX-4952: an attempt is late when the wake check finds the wall clock MORE than one wake check past its due time. A check slice that ends on
  // time is never more than a few ms late, so the bound is one slice.
  describe('the on-time / late boundary of an attempt', () => {
    const attemptsWhenWakeCheckIs = async ($: any, on: any, pastDueMs: number): Promise<number> => {
      const d = dashboard(on)
      d.world.browser.errors.tabs_context = 'down'
      await startSession($, d, 'desktop')
      // the first wake check runs KEEPALIVE_WAKE_CHECK_MS in; the wall clock then reads the due time plus `pastDueMs`
      d.suspend(KEEPALIVE_IDLE_MS + pastDueMs - KEEPALIVE_WAKE_CHECK_MS)
      await d.clock.advance(KEEPALIVE_WAKE_CHECK_MS)
      await d.clock.advance(KEEPALIVE_RETRY_WINDOW_MS + MINUTE)
      return looks(d)
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
    test('a turn start cancels the attempt before its own reads: the attempt in flight opens nothing while they wait', async ($, on) => {
      const d = dashboard(on, { stateSteps: true })
      await startSession($, d, 'desktop')
      closePane(d)
      d.world.browser.delayMs = MINUTE
      await d.clock.advance(KEEPALIVE_IDLE_MS)
      // the attempt is now reading the pane (one minute); the turn start's first read of the period waits two
      d.beforeNextRead('idleSince', () => d.clock.sleep(2 * MINUTE))
      const started = $.turn.start(START)
      await d.clock.advance(MINUTE + 1)
      expect(opens(d)).toEqual([])
      await d.clock.advance(2 * MINUTE)
      await started
      expect(opens(d)).toEqual([])
    })
  })
})
