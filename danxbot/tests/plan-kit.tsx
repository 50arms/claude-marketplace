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
// DX-4317: the dashboard origin the fixture answers (`dashboard_url`): deliberately not the production
// one, so a link built on a constant instead of the answer fails every test that checks a href.
export const DASHBOARD_URL = 'http://localhost:5555'
// `dashboardUrl: NO_DASHBOARD_URL` leaves the field out of the answer (a JSON null is sent as one)
export const NO_DASHBOARD_URL = Symbol('no dashboard_url')
export const NAVIGATE_REFUSED = `navigation to ${DASHBOARD_URL} was denied or failed`
export const PREVIEW_START_OK = '{\n  "serverId": "preview-local_55730ba1-986f-4b18-8e6a-1118327bf3e0",\n  "tabId": "seed",\n  "reused": true,\n  "type": "browser",\n  "navOk": true\n}\nBrowser pane opened. Use serverId "preview-local_55730ba1-986f-4b18-8e6a-1118327bf3e0" with read_page / computer / navigate.'

// DX-4423: what the danx-dashboard MCP (0.1.224, session-access.ts) answers every tool but plan_connect while the session holds
// no key: an error result. REVOKED_HALT is what the first call after a 401 on the session's key answers; both end in the
// sign-in sentence. These are the server's words, for the agent: the plugin must never show them to the person.
export const SIGN_IN_HALT = "Not signed in to the danxbot dashboard. Call `plan_connect` (with `title`: your session's own title) to request access; the user approves it in their browser, then this tool works."
export const REVOKED_HALT = `The dashboard no longer accepts this session's key (it was revoked, or it lapsed after a day unused), so this session is signed out. ${SIGN_IN_HALT}`
export const APPROVAL_URL = 'http://localhost:5555/connect/abc123'
export const CONFIRM_CODE = 'WXYZ2345'
// the approval request plan_connect answers while signed out, and what its next calls answer meanwhile (instruction text as the server words it)
export const APPROVAL_REQUIRED = { state: 'approval_required', approvalUrl: APPROVAL_URL, confirmCode: CONFIRM_CODE, expiresAt: '2026-10-03T08:10:00.000Z', instruction: 'Show the user the confirm code and open the approval URL in their browser; they check the code matches and approve. Then call `plan_connect` again: it waits up to about 45 seconds for the approval.' }
export const APPROVAL_PENDING = { ...APPROVAL_REQUIRED, state: 'approval_pending', instruction: 'Still waiting for the user to approve. Remind them of the confirm code and the URL, then call `plan_connect` again.' }

// the connected plan's counts: 4 / (3 + 5 + 1 + 3 + 4) = 25%; Cancelled (2) is not counted
export const DEFAULT_BREAKDOWN = { 'In Progress': 3, ToDo: 5, Backlog: 1, Review: 3, Done: 4, Cancelled: 2 }
const SESSION_ID = '41365fb5-6b43-443b-a01b-81245574f648'
const reply = (body: unknown, status = 200) => text({ ok: status < 400, status, body })

// The seven states the server answers for `sessionListenerAttached.state` (danxbot src/issues/plan-session-listeners.ts
// ListenerHealthState). The fixture's next step for a state other than `healthy` is `NEXT_STEP(state)`.
export const LISTENER_STATES = ['unattached', 'stopped', 'reconnecting', 'credential_mismatch', 'plan_has_no_cards', 'inventory_unavailable', 'healthy'] as const
// The next step never contains the state's name, so a test that finds the state name cannot be satisfied by it.
export const NEXT_STEP = (state: string) => `Run plan_connect again (step ${[...state].reduce((n, c) => n + c.charCodeAt(0), 0)}).`

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
    // DX-4420: PLAN-23's name, to try a name longer than the band
    planName?: string
    // `dashboard_url` on GET /api/plans: the default DASHBOARD_URL, an override (any value, so a bad one can
    // be tried), or NO_DASHBOARD_URL for an answer without the field
    dashboardUrl?: unknown
    // 'down': the engine's own "no such server" rejection; 'flaky': any other rejection
    mcp?: 'up' | 'down' | 'flaky'
    browser?: 'ok' | 'denied'
    // the Browser pane is closed (tabs_context says browserOpen: false) until a navigate opens it
    browserClosed?: boolean
    // `sessionListenerAttached` on GET /api/plans: a state (any string, so an unknown one can be tried; default
    // healthy, nextStep null) or null (the session has no listener row). A session on no plan always gets null,
    // as readCallerSessionOverlay does.
    listener?: string | null
    // ... and its `attached` flag when it should NOT follow the state (default: attached only when healthy)
    attached?: boolean
    // ... or the raw `sessionListenerAttached` value as sent, whatever its shape (overrides the two above)
    rawListener?: unknown
    // the connected plan's status counts: the default, an override, or none at all
    breakdown?: Record<string, unknown>
    noBreakdown?: boolean
    // the in-progress bucket: how many cards it has, whether its call fails or answers no total, and whether the card has an agent
    inProgressTotal?: number
    inProgressFails?: boolean
    noInProgressTotal?: boolean
    noAgent?: boolean
    // plan_connect {disconnect: true}: the leave works (default), or the server refuses it a given way
    // ('rejected' is a THROWN call, the only error result; 'noLeftPlan' is a 200 without leftPlan)
    disconnect?: 'ok' | 'mismatch' | 'notConnected' | 'notFound' | 'rejected' | 'noLeftPlan'
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
    // DX-4423: the session holds no dashboard key: every danxbot_api call is the MCP's error result (the first call after a revoke
    // answers REVOKED_HALT, a session that never signed in SIGN_IN_HALT) and plan_connect runs the request-and-approve dance
    // (world.signIn): approval_required, then approval_pending after `waitMs` on the fake clock, until a test sets `approved`
    // (then the key is stored: the tools work again and plan_connect connects to the plan it is given) or `answer`
    signedOut?: 'signed-out' | 'revoked'
    // plan_connect refuses (ok: false, 409 plan_archived) / throws
    connectFails?: boolean
    connectThrows?: boolean
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
  // the fake clock starts at 2026-10-03T08:00:00Z, so an `updatedAt` reads as a real age
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T08:00:00.000Z') })
  let browserOpen = !options.browserClosed
  const calls: { server: string; tool: string; args: any }[] = []
  const api: { method: string; path: string; body?: any; query?: any }[] = []
  const toasts: string[] = []
  const toastTimeouts: number[] = []
  const statuses: (string | undefined)[] = []
  const opened: { id: string; title?: string; focus?: boolean }[] = []
  const stateWrites: { plugin: string; key: string; value: unknown }[] = []
  const commands: string[] = []
  const world = {
    listener: (options.listener === undefined ? 'healthy' : options.listener) as string | null,
    inProgress: [{ id: 'DX-9', title: 'In flight card', updatedAt: '2026-10-03T07:58:30.000Z' }] as { id: string; title: string; updatedAt: string }[],
    planId: options.connected === false ? (null as number | null) : 23,
    titleSeen: undefined as string | undefined,
    // DX-4423: null while the session holds a key
    signedOut: (options.signedOut ?? null) as 'signed-out' | 'revoked' | null,
    signIn: { requested: false, approved: false, waitMs: 45_000, expireAfterCalls: undefined as number | undefined, answer: undefined as { text: string; isError?: boolean } | undefined, calls: [] as any[] },
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
    { id: 23, ref: 'PLAN-23', name: options.planName ?? 'Danxbot plugin', status: 'building', archived_at: null, bucket_counts: { 'needs-you': 2 } },
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
        sessionListenerAttached:
          options.rawListener !== undefined
            ? options.rawListener
            : world.planId === null || world.listener === null
            ? null
            : { attached: options.attached ?? world.listener === 'healthy', state: world.listener, nextStep: world.listener === 'healthy' ? null : NEXT_STEP(world.listener) },
        ...(options.dashboardUrl === NO_DASHBOARD_URL ? {} : { dashboard_url: options.dashboardUrl === undefined ? DASHBOARD_URL : options.dashboardUrl }),
      })
    }
    const planOne = /^\/api\/plans\/(\d+)$/.exec(path)
    if (method === 'GET' && planOne) {
      const p = plans.find(x => x.id === Number(planOne[1]))
      if (!p) return reply({ error: 'nope' }, 404)
      return reply({
        id: p.id,
        ref: p.ref,
        name: p.name,
        status: p.status,
        ...(options.noBreakdown ? {} : { status_breakdown: options.breakdown ?? DEFAULT_BREAKDOWN }),
      })
    }
    const cards = /^\/api\/plans\/(\d+)\/cards$/.exec(path)
    if (method === 'GET' && cards && query?.bucket === 'in-progress') {
      if (options.inProgressFails) return reply({ error: 'in-progress boom' }, 500)
      return reply({
        cards: world.inProgress.map(c => ({ id: c.id, title: c.title, priority: 4, updatedAt: c.updatedAt, assignedAgent: 'raw-session-uuid' })),
        ...(options.noInProgressTotal ? {} : { total: options.inProgressTotal ?? world.inProgress.length }),
      })
    }
    if (method === 'GET' && cards) {
      return reply({
        cards: world.cards
          .filter(c => c.problems.some(p => p.open))
          .map(c => ({ id: c.id, priority: c.priority, title: c.title })),
        ...(options.noTotal ? {} : { total: options.cardsTotal ?? world.cards.filter(c => c.problems.some(p => p.open)).length }),
      })
    }
    const issue = /^\/api\/issues\/([A-Z]+-\d+)$/.exec(path)
    if (method === 'GET' && issue && world.inProgress.some(c => c.id === issue[1])) {
      const c = world.inProgress.find(x => x.id === issue[1])!
      return reply({ id: c.id, title: c.title, assigned_agent_name: options.noAgent ? null : 'PLAN-23: danxbot plugin' })
    }
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
      if (world.signedOut !== null && e.tool !== 'plan_connect') {
        return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? REVOKED_HALT : SIGN_IN_HALT }], isError: true } }
      }
      if (world.signedOut !== null && e.tool === 'plan_connect') {
        const dance = world.signIn
        dance.calls.push(e.args)
        if (dance.answer) return { value: { content: [{ type: 'text', text: dance.answer.text }], isError: dance.answer.isError ?? false } }
        // approved: the key is stored, and the call goes on to connect the plan it was given (or answers signed_in)
        const approvedAnswer = () => {
          world.signedOut = null
          if (e.args.plan_id === undefined) return { value: text({ state: 'signed_in', instruction: 'This session is signed in. Call `plan_connect` with `plan_id` to connect it to a plan.' }) }
          world.planId = e.args.plan_id
          world.titleSeen = e.args.title
          return { value: text({ ok: true, status: 200, body: { session: { plan_id: e.args.plan_id } } }) }
        }
        if (dance.approved) return approvedAnswer()
        if (!dance.requested) {
          dance.requested = true
          return { value: text(APPROVAL_REQUIRED) }
        }
        // the call waits for the approval (the MCP's ~45 s), and answers the moment it comes; one that outlives the request
        // (`expireAfterCalls` calls in) answers a NEW request, as session-access.ts does after an expiry
        await clock.sleep(dance.waitMs)
        if (dance.approved) return approvedAnswer()
        if (dance.expireAfterCalls !== undefined && dance.calls.length >= dance.expireAfterCalls) {
          return { value: text({ ...APPROVAL_REQUIRED, approvalUrl: `${APPROVAL_URL}-renewed`, confirmCode: 'NEWCODE9', note: 'The previous request expired before it was approved.' }) }
        }
        return { value: text(APPROVAL_PENDING) }
      }
      if (e.tool === 'plan_connect' && e.args.disconnect) {
        if (options.disconnect === 'rejected') return { deny: 'plan_connect is not available' }
        if (options.disconnectTakesMs) await clock.sleep(options.disconnectTakesMs)
        // the real envelope (packages/danx-dashboard-mcp jsonResult, the server's handleLeavePlan): pretty-printed
        // JSON text, and a refusal is `ok: false`, never an error result
        const envelope = (ok: boolean, status: number, body: unknown) => ({
          value: { content: [{ type: 'text', text: JSON.stringify({ ok, status, body }, null, 2) }], isError: false },
        })
        if (options.disconnect === 'mismatch') {
          world.planId = 24
          return envelope(false, 409, {
            error: 'plan_mismatch',
            session_id: SESSION_ID,
            expected_plan_id: e.args.plan_id,
            actual_plan: { id: 24, name: 'Agent mode' },
            message: `Session ${SESSION_ID} is on plan 24, not plan ${e.args.plan_id}; nothing was changed.`,
          })
        }
        if (options.disconnect === 'notConnected' || world.planId === null) {
          world.planId = null
          return envelope(false, 409, {
            error: 'session_not_connected',
            session_id: SESSION_ID,
            message: `Session ${SESSION_ID} is not connected to a plan, so there is nothing to leave.`,
          })
        }
        if (options.disconnect === 'notFound') return envelope(false, 404, { error: 'Not found' })
        const left = plans.find(p => p.id === world.planId)
        world.planId = null
        if (options.disconnect === 'noLeftPlan') return envelope(true, 200, { session: { session_id: SESSION_ID, plan_id: null } })
        return envelope(true, 200, {
          session: { session_id: SESSION_ID, plan_id: null },
          leftPlan: { id: left?.id, name: left?.name },
        })
      }
      if (e.tool === 'plan_connect') {
        // a THROWN call (argument validation, an outdated MCP): the one error-result path
        if (options.connectThrows) return { deny: 'plan_connect: the MCP server is outdated' }
        // refusals are `ok: false` envelopes (handleConnect / lockPlanForConnect / planArchivedError)
        if (options.connectFails) {
          return {
            value: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: false,
                      status: 409,
                      body: {
                        error: 'PLAN-24 is archived. Restore it before doing this: an archived plan connects no sessions and runs no lifecycle behaviour.',
                        code: 'plan_archived',
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: false,
            },
          }
        }
        world.planId = e.args.plan_id
        world.titleSeen = e.args.title
        return { value: text({ ok: true, status: 200, body: { session: { plan_id: e.args.plan_id } } }) }
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
          (tabId, i) => `    {\n      "tabId": "${tabId}",\n      "origin": "${DASHBOARD_URL}",\n      "isActive": ${i === 0}\n    }`,
        )
        return out(`{\n  "browserOpen": true,\n  "tabs": [\n${tabs.join(',\n')}\n  ]\n}\nThe Browser pane is currently displayed.`)
      }
      if (e.tool === 'tabs_create') {
        if (options.tabsCreate === 'closed') return out(TABS_CREATE_CLOSED)
        options.tabs = [...(options.tabs ?? []), 'tab-7']
        return out(TABS_CREATE_OPEN.replace('tab-1', 'tab-7'))
      }
      // captured from the desktop app (2026-10-04): "Fronted tab tab-2." and, for an id it does not hold, the error "Tab tab-99 not found."
      if (e.tool === 'tabs_select') {
        if (!(options.tabs ?? []).includes(e.args.tabId)) return out(`Tab ${e.args.tabId} not found.`, true)
        return out(`Fronted tab ${e.args.tabId}.`)
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
  const flags = { viewWriteFails: false, refusedViewWrites: 0 }
  on('state.set', async (_$: any, e: any, next: any) => {
    // a write of the plugin's view that the host refuses: the one way a refresh can throw past its own catch
    if (flags.viewWriteFails && e.key === 'view') {
      flags.refusedViewWrites++
      return { deny: 'view write refused' } as any
    }
    stateWrites.push({ plugin: e.plugin, key: e.key, value: e.value })
    return next(e)
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  // what the engine draws above the prompt when no plugin does: nothing
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  // what the engine draws in the footer when no plugin does: its mode labels
  on('ui.render', { component: 'SessionMode' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.modes.join(' & ')}</Text>
  })
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    if (e.timeoutMs !== undefined) toastTimeouts.push(e.timeoutMs)
    return { value: undefined }
  })
  on('ui.status', (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$: any, e: any) => {
    opened.push({ id: e.id, title: e.title, focus: e.focus })
    return { value: { isPlaced: true } }
  })
  on('command.register', (_$: any, e: any) => {
    commands.push(e.name)
    return { value: { isRegistered: true } } as any
  })

  return { toastTimeouts, setMcp: (mode: 'up' | 'down' | 'flaky') => void (options.mcp = mode), failInProgress: (on = true) => void (options.inProgressFails = on), failViewWrite: (on = true) => void (flags.viewWriteFails = on), setListener: (state: string | null) => void (world.listener = state), refusedViewWrites: () => flags.refusedViewWrites, stateWrites, tabs: () => options.tabs ?? [], failList: (on = true) => void (options.listFails = on), closeTabs: () => void (options.tabs = []), calls, api, toasts, statuses, opened, commands, world, clock, writes: () => api.filter(a => a.method !== 'GET') }
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

// The footer is one plan button; every test mounts it here, so the site is one line.
export async function mountIndicator($: any, surface: string, modes: string[] = []) {
  return $.ui.mount({ plugin: 'danxbot', surface, component: 'SessionMode', props: { modes } } as any)
}

// The footer button's text (the one `SessionMode` button), and the band's progress indicator: an Svg whose alt
// carries `N% complete` on the desktop, the text glyph on the terminal (no Svg there).
// DX-4420: the desktop pads the footer label with non-breaking spaces (footer.tsx); the label is what is compared.
export const FOOTER_PAD = / /g
export const footerText = async (ui: any): Promise<string | undefined> => (await ui.find({ key: 'footer-plan' }))?.text?.replace(FOOTER_PAD, '')

export async function expectIndicator(band: any, surface: string, percent: number) {
  const GLYPHS: [number, string][] = [[0, '○'], [37, '◔'], [62, '◑'], [99, '◕'], [100, '●']]
  const glyph = GLYPHS.find(([max]) => percent <= max)![1]
  if (surface === 'desktop') {
    expect((await band.find({ type: 'Svg' }))?.props.alt).toBe(`${percent}% complete`)
  } else {
    expect(await band.find({ type: 'Svg' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: glyph })).toBeDefined()
  }
}

// DX-4420: the band's open-problem count: a Button on the desktop, a Link on the terminal; its text, or undefined
// when none is drawn. The one finder, so a test never depends on which of the two it is.
export async function problemBadgeOf(ui: any): Promise<string | undefined> {
  const all = [...(await ui.findAll({ type: 'Button' })), ...(await ui.findAll({ type: 'Link' }))]
  const el = all.find((e: any) => String(e.text ?? e.props?.label ?? '').includes('⚠'))
  return el && (el.text ?? el.props.label)
}
