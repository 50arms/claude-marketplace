// Shared stand-ins for the `claude plugin test danxbot` suites: a fake danx-dashboard MCP server
// (danxbot_api + plan_connect), a fake Claude_Browser, and recorders for the engine calls the
// plugin makes beneath it (toast, status, session.append, ui.open, command.register).
import { expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NOTE_MARKER } from '../hooks/plan/config'

export const SURFACES = ['terminal', 'desktop'] as const

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })
// tabs_create as the desktop app words it (captured 2026-10-03): with the pane open, a JSON object
// then prose; with it closed, prose only
export const TABS_CREATE_OPEN = '{\n  "serverId": "preview-local_55730ba1-986f-4b18-8e6a-1118327bf3e0",\n  "tabId": "tab-1",\n  "reused": false,\n  "type": "browser"\n}\nOpened tab tab-1 in the background — the user\'s current tab stays in front. Use `navigate` with tabId "tab-1" to load a URL; front it with `tabs_select` when the user should look.'
export const TABS_CREATE_CLOSED = 'No tab was created. The Browser pane isn\'t open yet, so there are no tabs. Call preview_start or navigate with {"url": "https://…"} to open it.'

// captured from the desktop app (2026-10-03): the two closed answers of tabs_context, the refusal of
// a navigate with no tabId on a closed pane, and preview_start, the call that opens the pane
export const TABS_CONTEXT_CLOSED = '{\n  "browserOpen": false,\n  "tabs": []\n}\nThe Browser pane isn\'t open yet, so there are no tabs. Call preview_start or navigate with {"url": "https://…"} to open it.'
export const TABS_CONTEXT_CLOSED_LATER = '{\n  "browserOpen": false,\n  "tabs": []\n}\nThe Browser pane is not open.'
export const NAVIGATE_REFUSED = 'navigation to https://danxbot.sageus.ai was denied or failed'
export const PREVIEW_START_OK = '{\n  "serverId": "preview-local_55730ba1-986f-4b18-8e6a-1118327bf3e0",\n  "tabId": "seed",\n  "reused": true,\n  "type": "browser",\n  "navOk": true\n}\nBrowser pane opened. Use serverId "preview-local_55730ba1-986f-4b18-8e6a-1118327bf3e0" with read_page / computer / navigate.'

const reply = (body: unknown, status = 200) => text({ ok: status < 400, status, body })

type Sol = { id: number; title: string; recommended: boolean; body?: string; pro?: string; con?: string; steps?: any[] }
type Prob = { id: number; type: 'question' | 'action'; statement: string; open: boolean; solutions: Sol[]; summary?: string; context?: string }
type Card = { id: string; title: string; priority: number; problems: Prob[]; comments: any[] }

export type Dashboard = ReturnType<typeof dashboard>

// The fixture: two cards in priority order. DX-1 holds a question (its recommended solution is
// listed LAST so the plugin's reordering shows) and an action; DX-2 holds one question.
export function dashboard(
  on: On,
  options: {
    connected?: boolean
    // 'down': the engine's own "no such server" rejection; 'flaky': any other rejection
    mcp?: 'up' | 'down' | 'flaky'
    browser?: 'ok' | 'denied'
    // the Browser pane is closed (tabs_context says browserOpen: false) until a navigate opens it
    browserClosed?: boolean
    // plan_connect {disconnect: true}: the leave works (default), or the server refuses it a given way
    disconnect?: 'ok' | 'mismatch' | 'notConnected' | 'notFound' | 'rejected'
    // the disconnect call takes this long on the fake clock
    disconnectTakesMs?: number
    // which closed text tabs_context carries (the app words it two ways)
    closedText?: 'not-yet-open' | 'not-open'
    // preview_start: opens the pane (default), loads nothing (navOk false), or is rejected outright
    previewStart?: 'ok' | 'navNotOk' | 'rejected'
    // tabs_context says the pane is open but tabs_create answers the pane-closed text
    tabsCreate?: 'ok' | 'closed'
    // navigate takes this long on the fake clock (a slow open)
    navigateTakesMs?: number
    // a tab entry without a string tabId in tabs_context
    badTabEntry?: boolean
    tabs?: string[]
    // what tabs_context answers: the list (default), an error result, or text that is no tab list
    tabsContext?: 'list' | 'error' | 'garbage'
    listFails?: boolean
    connectFails?: boolean
    // the dashboard has more needs-you cards than the one load reads
    cardsTotal?: number
    // ... and more plans than the plan list returns
    plansTotal?: number
    // the paged routes answer no `total` at all
    noTotal?: boolean
    // the first /api/plans call never settles (the fake clock must move an hour to release it)
    hangFirstLoad?: boolean
    // the first answer POST never settles (a write in flight when a process dies)
    hangFirstAnswer?: boolean
    // the issue route answers comments with no comments_page.total
    noCommentsTotal?: boolean
    // the plan list comes back empty although the dashboard has this many plans
    emptyPlanListOf?: number
    // the connected plan is not in the (capped) plan list
    planOutsideList?: boolean
    // comments the API did not return for a card (it pages them)
    commentsTotal?: number
  } = {},
) {
  const clock = mock.clock(on)
  let browserOpen = !options.browserClosed
  const calls: { server: string; tool: string; args: any }[] = []
  const api: { method: string; path: string; body?: any; query?: any }[] = []
  const toasts: string[] = []
  const toastTimeouts: number[] = []
  const statuses: (string | undefined)[] = []
  const opened: { id: string; title?: string }[] = []
  const stateWrites: { plugin: string; key: string; value: unknown }[] = []
  const commands: string[] = []
  const world = {
    planId: options.connected === false ? (null as number | null) : 23,
    titleSeen: undefined as string | undefined,
    cards: [
      {
        id: 'DX-1',
        title: 'First card',
        priority: 5,
        comments: [{ id: 1, problem_id: 11, author: 'dan', timestamp: '2026-10-03T08:00:00.000Z', text: 'a comment' }],
        problems: [
          {
            id: 11,
            type: 'question',
            statement: 'Which route?',
            open: true,
            summary: 'It matters',
            context: 'Some **details**',
            solutions: [
              { id: 111, title: 'Plain', recommended: false, steps: [{ id: 1111, label: '1', title: 'step', description: '', checked_at: null, steps: [] }] },
              { id: 112, title: 'Best', recommended: true, pro: 'fast', con: 'costly' },
            ],
          },
          {
            id: 12,
            type: 'action',
            statement: 'Allow the site',
            open: true,
            summary: 'Do it once',
            solutions: [{ id: 121, title: 'Allow it', recommended: true }],
          },
        ],
      },
      {
        id: 'DX-2',
        title: 'Second card',
        priority: 3,
        comments: [],
        problems: [
          { id: 21, type: 'question', statement: 'Second one?', open: true, solutions: [{ id: 211, title: 'Yes', recommended: false }] },
        ],
      },
    ] as Card[],
  }
  const plans = [
    { id: 23, ref: 'PLAN-23', name: 'Danxbot plugin', status: 'building', archived_at: null, bucket_counts: { 'needs-you': 2 } },
    { id: 24, ref: 'PLAN-24', name: 'Agent mode', status: 'building', archived_at: null, bucket_counts: { 'needs-you': 0 } },
    { id: 25, ref: 'PLAN-25', name: 'Archived', status: 'done', archived_at: 'x', bucket_counts: {} },
  ]

  function route(method: string, path: string, body: any, query: any) {
    if (method === 'GET' && path === '/api/plans') {
      if (options.listFails) return reply({ error: 'boom' }, 500)
      return reply({
        plans: options.emptyPlanListOf ? [] : options.planOutsideList ? plans.filter(p => p.id !== world.planId) : plans,
        ...(options.noTotal ? {} : { total: options.emptyPlanListOf ?? options.plansTotal ?? plans.length }),
        session:
          world.planId === null
            ? null
            : { plan_id: world.planId, plan_name: plans.find(p => p.id === world.planId)?.name ?? 'Far plan' },
        sessionListenerAttached: { state: 'healthy' },
      })
    }
    const cards = /^\/api\/plans\/(\d+)\/cards$/.exec(path)
    if (method === 'GET' && cards) {
      return reply({
        cards: world.cards
          .filter(c => c.problems.some(p => p.open))
          .map(c => ({ id: c.id, priority: c.priority, title: c.title })),
        ...(options.noTotal ? {} : { total: options.cardsTotal ?? world.cards.filter(c => c.problems.some(p => p.open)).length }),
      })
    }
    const issue = /^\/api\/issues\/([A-Z]+-\d+)$/.exec(path)
    if (method === 'GET' && issue) {
      const c = world.cards.find(x => x.id === issue[1])
      return c
        ? reply({
            id: c.id,
            title: c.title,
            problems: c.problems,
            comments: c.comments,
            ...(options.noCommentsTotal ? {} : { comments_page: { limit: 20, total: options.commentsTotal ?? c.comments.length } }),
          })
        : reply({ error: 'nope' }, 404)
    }
    const ans = /^\/api\/issues\/([A-Z]+-\d+)\/problems\/(\d+)\/answer$/.exec(path)
    if (method === 'POST' && ans) {
      const p = world.cards.find(x => x.id === ans[1])?.problems.find(x => x.id === Number(ans[2]))
      if (!p) return reply({ error: 'nope' }, 404)
      if (p.statement === 'FAIL') return reply({ message: 'refused' }, 409)
      p.open = false
      return reply({ ok: true })
    }
    if (/\/steps\/\d+\/check$/.test(path) && method === 'PATCH') return reply({ ok: true })
    if (/\/comments$/.test(path) && method === 'POST') return reply({ id: 99 })
    return reply({ error: `unrouted ${method} ${path}` }, 404)
  }

  on('mcp.call', async (_$: any, e: any) => {
    calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.server === 'danx-dashboard') {
      // a deny reaches the plugin as a rejection that carries the reason
      if (options.mcp === 'down') return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (e.tool === 'plan_connect' && e.args.disconnect) {
        if (options.disconnect === 'rejected') return { deny: 'plan_connect is not available' }
        if (options.disconnectTakesMs) await clock.sleep(options.disconnectTakesMs)
        const refuse = (status: number, body: unknown, isError = false) => ({
          value: { content: [{ type: 'text', text: JSON.stringify({ ok: false, status, body }) }], isError },
        })
        if (options.disconnect === 'mismatch') {
          world.planId = 24
          return refuse(409, { error: 'plan_mismatch', message: 'this session is on PLAN-24 "Agent mode", not PLAN-23', plan: { id: 24 } }, true)
        }
        if (options.disconnect === 'notConnected' || world.planId === null) {
          world.planId = null
          return refuse(409, { error: 'session_not_connected' })
        }
        if (options.disconnect === 'notFound') return refuse(404, { error: 'Not found' })
        if (e.args.plan_id !== world.planId) return refuse(409, { error: 'plan_mismatch' }, true)
        const left = plans.find(p => p.id === world.planId)
        world.planId = null
        return { value: text({ ok: true, status: 200, body: { session: { plan_id: null }, leftPlan: { id: left?.id, name: left?.name } } }) }
      }
      if (e.tool === 'plan_connect') {
        if (options.connectFails) return { value: { content: [{ type: 'text', text: 'no such plan' }], isError: true } }
        world.planId = e.args.plan_id
        world.titleSeen = e.args.title
        return { value: text({ session: { plan_id: e.args.plan_id } }) }
      }
      api.push({ method: e.args.method, path: e.args.path, body: e.args.body, query: e.args.query })
      if (options.hangFirstAnswer && e.args.method === 'POST' && /\/answer$/.test(e.args.path) && api.filter(a => a.method === 'POST').length === 1) {
        return clock.sleep(3_600_000).then(() => ({ value: route(e.args.method, e.args.path, e.args.body, e.args.query) }))
      }
      if (options.hangFirstLoad && e.args.path === '/api/plans' && api.filter(a => a.path === '/api/plans').length === 1) {
        return clock.sleep(3_600_000).then(() => ({ value: route(e.args.method, e.args.path, e.args.body, e.args.query) }))
      }
      return { value: route(e.args.method, e.args.path, e.args.body, e.args.query) }
    }
    if (e.server === 'Claude_Browser') {
      const out = (text: string, isError = false) => ({ value: { content: [{ type: 'text', text }], isError } })
      if (e.tool === 'tabs_context' && options.tabsContext === 'error') return out('browser is not available', true)
      if (e.tool === 'tabs_context' && options.tabsContext === 'garbage') return out('Tabs: one, two')
      // the real results: a JSON object followed by prose (captured from the desktop app)
      if (e.tool === 'tabs_context') {
        if (!browserOpen) {
          return out(options.closedText === 'not-open' ? TABS_CONTEXT_CLOSED_LATER : TABS_CONTEXT_CLOSED)
        }
        if (options.badTabEntry) return out('{"browserOpen": true, "tabs": [{"origin": "x"}]}\nThe Browser pane is currently displayed.')
        const tabs = (options.tabs ?? []).map(
          (tabId, i) => `    {\n      "tabId": "${tabId}",\n      "origin": "https://danxbot.sageus.ai",\n      "isActive": ${i === 0}\n    }`,
        )
        return out(`{\n  "browserOpen": true,\n  "tabs": [\n${tabs.join(',\n')}\n  ]\n}\nThe Browser pane is currently displayed.`)
      }
      if (e.tool === 'tabs_create') {
        if (options.tabsCreate === 'closed') return out(TABS_CREATE_CLOSED)
        options.tabs = [...(options.tabs ?? []), 'tab-7']
        return out(TABS_CREATE_OPEN.replace('tab-1', 'tab-7'))
      }
      if (e.tool === 'navigate' && options.browser === 'denied') return out('navigation to this site is not allowed', true)
      if (e.tool === 'navigate') {
        // a navigate with no tabId on a closed pane is refused (the app, 2026-10-03): only preview_start opens it
        if (!e.args.tabId && !browserOpen) return out(NAVIGATE_REFUSED, true)
        if (options.navigateTakesMs) await clock.sleep(options.navigateTakesMs)
        return out(`navigated to ${e.args.url}`)
      }
      if (e.tool === 'preview_start') {
        if (options.previewStart === 'rejected') return { deny: 'preview_start is not available to plugins' }
        if (options.browser === 'denied') return out('navigation to this site is not allowed', true)
        if (options.navigateTakesMs) await clock.sleep(options.navigateTakesMs)
        if (options.previewStart === 'navNotOk') return out(PREVIEW_START_OK.replace('"navOk": true', '"navOk": false'))
        browserOpen = true
        options.tabs = ['seed']
        return out(PREVIEW_START_OK)
      }
      return out('ok')
    }
    return { deny: `no stand-in for ${e.server}` }
  })
  // what the plugin keeps in $.state (a test has no `$.state` of its own to read back)
  on('state.set', (_$: any, e: any, next: any) => {
    stateWrites.push({ plugin: e.plugin, key: e.key, value: e.value })
    return next(e)
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    if (e.timeoutMs !== undefined) toastTimeouts.push(e.timeoutMs)
    return { value: undefined }
  })
  const flags = { statusThrows: false }
  on('ui.status', (_$: any, e: any) => {
    if (flags.statusThrows) throw new Error('status line unavailable')
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$: any, e: any) => {
    opened.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
  on('command.register', (_$: any, e: any) => {
    commands.push(e.name)
    return { value: { isRegistered: true } } as any
  })

  return { toastTimeouts, setMcp: (mode: 'up' | 'down' | 'flaky') => void (options.mcp = mode), failStatus: (on = true) => void (flags.statusThrows = on), stateWrites, tabs: () => options.tabs ?? [], failList: (on = true) => void (options.listFails = on), closeTabs: () => void (options.tabs = []), calls, api, toasts, statuses, opened, commands, world, clock, writes: () => api.filter(a => a.method !== 'GET') }
}

// `claude plugin test` (Claude Code 2.1.286) has no seam for a plugin's own $.session.append: the
// call rejects "no implementation for session.append" and no hook of the test or of another
// plugin sees it (tried: on('session.append') in the test, with and without a door matcher, an
// inline plugin at the prepend and append tiers, and a stub on the kit's $). The plugin's fallback
// toast therefore carries the row it could not append, after NOTE_MARKER, and toldModel() reads the
// rows back from there. plan-pane.test.tsx's canary fails the day the append works in the kit.
export const toldModel = (d: { toasts: string[] }): string[] =>
  d.toasts.filter(t => t.startsWith('Could not tell the model')).map(t => t.slice(t.indexOf(NOTE_MARKER) + NOTE_MARKER.length))

// The model must be able to act on a row: it carries every one of these fields, each as a whole
// token (DX-1 is not found inside DX-12).
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function expectRowCarries(row: string, fields: string[]) {
  for (const field of fields) {
    const token = new RegExp(`(?<![\\w-])${escapeRegExp(field)}(?![\\w-])`)
    expect(token.test(row), `the model row lacks "${field}": ${row}`).toBe(true)
  }
}

// session.start as the engine raises it (the plugin loads the plan, registers its command and
// starts its refresh timer), then lets the load it kicked off finish.
export async function startSession($: any, d: Dashboard, surface: string) {
  await $.session.start({ cwd: '/work', surface, isInteractive: true })
  await d.clock.settle()
}

export function expectText(found: { text: string } | undefined, pattern: string | RegExp) {
  expect(found).toBeDefined()
  expect(found!.text).toMatch(pattern)
}
