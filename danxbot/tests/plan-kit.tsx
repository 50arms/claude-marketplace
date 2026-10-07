// Shared stand-ins for the `claude plugin test danxbot` suites: a fake danx-dashboard MCP server
// (danxbot_api + plan_connect), a fake Claude_Browser, and recorders for the engine calls the
// plugin makes beneath it (toast, status, session.append, ui.open, command.register).
import { expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NOTE_MARKER, SERVER, toolName } from '../hooks/plan/config'
import { CURSOR_PREFIX as RELAY_CURSOR_PREFIX, RELAY_MARKER } from '../hooks/relay/config'

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
// DX-4234: the registry's effective text the fixture answers for an event (a distinct text per event, so a wrong event shows)
export const EVENT_TEXT = (event: string) => `The ${event} text.`
// DX-4234: where the fixture's machine keeps the MCP server's connection record of a session (what makes a session locally known as plan-connected)
export const HOME_DIR = '/home/u'
export const RECORD_PATH = (sessionId: string) => `${HOME_DIR}/.config/danxbot/plan-sessions/${sessionId}.json`
export const DASHBOARD_URL = 'http://localhost:5555'
// `dashboardUrl: NO_DASHBOARD_URL` leaves the field out of the answer (a JSON null is sent as one)
export const NO_DASHBOARD_URL = Symbol('no dashboard_url')
// DX-4612: the `naming` block of a plan_connect answer. NAMING_NEEDED is the real block (DX-4608, src/issues/plan-session-naming.ts
// buildNeededNaming for PLAN-23, a live name Amara, recent names Amara and Kenji, suggested name Aarav), copied verbatim.
// `naming: NO_NAMING` leaves the field out of the answer.
export const NO_NAMING = Symbol('no naming')
export const NAMING_OK = { status: 'ok' }
export const NAMING_NEEDED = {
  status: 'needed',
  format: '{Name}: PLAN-NNN {short title}',
  planRef: 'PLAN-23',
  shortTitle: 'Danxbot plugin on native Claude Code',
  instruction: 'Name this session\'s thread "{Name}: PLAN-NNN {short title}" so the operator can tell the agents on their plans apart. {Name} is one short given name (letters, apostrophes and hyphens, 30 characters at most). Pick a given name that no live session holds; "Aarav" is free. Names in use right now: Amara. The rest is fixed: this plan is PLAN-23 and its short title is "Danxbot plugin on native Claude Code", so the thread is e.g. "Aarav: PLAN-23 Danxbot plugin on native Claude Code". Rename the thread: in Claude Desktop call the set_session_title tool with that title; in a terminal Claude Code session run /rename with it. Then call plan_connect({plan_id: 23, title}) again with the same title.',
  liveNames: ['Amara'],
  recentNames: ['Amara', 'Kenji'],
  suggestedName: 'Aarav',
  suggestedTitle: 'Aarav: PLAN-23 Danxbot plugin on native Claude Code',
}
export const NAVIGATE_REFUSED = `navigation to ${DASHBOARD_URL} was denied or failed`
export const PREVIEW_START_OK = '{\n  "serverId": "preview-local_55730ba1-986f-4b18-8e6a-1118327bf3e0",\n  "tabId": "seed",\n  "reused": true,\n  "type": "browser",\n  "navOk": true\n}\nBrowser pane opened. Use serverId "preview-local_55730ba1-986f-4b18-8e6a-1118327bf3e0" with read_page / computer / navigate.'

// DX-4423 / DX-4418: what the danx-dashboard MCP (0.1.225, session-access.ts and key-revoked-halt.ts) answers every tool but
// plan_connect while the session holds no key: an error result. SIGN_IN_HALT is a session that never signed in, KEY_LAPSED_HALT
// what the first call after a lapsed key's 401 answers (it ends in the sign-in sentence), and KEY_REVOKED_HALT the one stop halt
// for a key a PERSON revoked, which EVERY tool answers, plan_connect included, with no access request. These are the server's
// words, for the agent: the plugin must never show them to the person.
export const SIGN_IN_HALT = "Not signed in to the danxbot dashboard. Call `plan_connect` (with `title`: your session's own title) to request access; the user approves it in their browser, then this tool works."
export const KEY_LAPSED_HALT = `The dashboard no longer accepts this session's key (it lapsed after a day unused), so this session is signed out. ${SIGN_IN_HALT}`
export const REVOKER = 'dana'
export const REVOKED_AT = '2026-10-04T07:00:00.000Z'
export const KEY_REVOKED_HALT = `STOP ALL WORK NOW. ${REVOKER} revoked your access to the danxbot dashboard at ${REVOKED_AT}.\n\nCommit your work in progress now (commit what you have; do not run agent-finalize.sh and do not merge). Then end this session: tell the person what you committed and stop.\n\nDo not call plan_connect or any other danxbot dashboard tool again, do not request access again and do not look for another route.`
export const APPROVAL_URL = 'http://localhost:5555/connect/abc123'
export const CONFIRM_CODE = 'WXYZ2345'
// the approval request plan_connect answers while signed out, and what its next calls answer meanwhile (instruction text as the server words it)
export const APPROVAL_REQUIRED = { state: 'approval_required', approvalUrl: APPROVAL_URL, confirmCode: CONFIRM_CODE, expiresAt: '2026-10-03T08:10:00.000Z', instruction: 'Show the user the confirm code and open the approval URL in their browser; they check the code matches and approve. Then call `plan_connect` again: it waits up to about 45 seconds for the approval.' }
export const APPROVAL_PENDING = { ...APPROVAL_REQUIRED, state: 'approval_pending', instruction: 'Still waiting for the user to approve. Remind them of the confirm code and the URL, then call `plan_connect` again.' }

// the connected plan's counts: 4 / (3 + 5 + 1 + 3 + 4) = 25%; Cancelled (2) is not counted
export const DEFAULT_BREAKDOWN = { 'In Progress': 3, ToDo: 5, Backlog: 1, Review: 3, Done: 4, Cancelled: 2 }
const SESSION_ID = '41365fb5-6b43-443b-a01b-81245574f648'
const reply = (body: unknown, status = 200) => text({ ok: status < 400, status, body })

// DX-4458: the host refuses a tool result past its size limit, with a notice written for the model (captured 2026-10-04 from the
// plan pane on DX-4443). The fixture's limit is lower than the real one so a fixture card can pass it.
export const HOST_LIMIT_CHARS = 60_000
export const HOST_OVERSIZE = (chars: number) => `Error: result (${chars.toLocaleString('en-US')} characters across 2,050 lines) exceeds maximum allowed tokens. Output has been saved to C:\tool-results\mcp-danx-dashboard-danxbot_api-1.txt
Format: JSON
Use offset and limit parameters to read specific portions of the file.`
function hostLimited(result: { content: { text: string }[]; isError: boolean }) {
  const chars = result.content[0].text.includes('"oversize":true') ? HOST_LIMIT_CHARS + 1 : result.content[0].text.length
  return chars > HOST_LIMIT_CHARS ? { content: [{ type: 'text', text: HOST_OVERSIZE(chars) }], isError: true } : result
}

// DX-3: 49 open questions on one card.
export function bigCard(): Card {
  return {
    id: 'DX-3',
    title: 'Big card',
    priority: 1,
    problems: Array.from({ length: 49 }, (_, i) => ({
      id: 300 + i,
      type: 'question' as const,
      statement: `Question ${i}?`,
      open: true,
    })),
  }
}

// The seven states the server answers for `sessionListenerAttached.state` (danxbot src/issues/plan-session-listeners.ts
// ListenerHealthState). The fixture's next step for a state other than `healthy` is `NEXT_STEP(state)`.
export const LISTENER_STATES = ['unattached', 'stopped', 'reconnecting', 'credential_mismatch', 'plan_has_no_cards', 'inventory_unavailable', 'healthy'] as const
// The next step never contains the state's name, so a test that finds the state name cannot be satisfied by it.
export const NEXT_STEP = (state: string) => `Run plan_connect again (step ${[...state].reduce((n, c) => n + c.charCodeAt(0), 0)}).`

// DX-4499: the plan's live sessions as GET /api/plan-sessions answers them (newest activity first), and one sub-agent row as
// GET /api/plan-sessions/:sessionId/subagents answers it (danxbot's plan_session_subagent resource: snake_case, epoch ms). The
// defaults are a running sub-agent that started 4 minutes before the fake clock's start (2026-10-03T08:00:00Z).
export const CLOCK_START = Date.parse('2026-10-03T08:00:00.000Z')
export const OWN_SESSION = { session_id: 'sess-own', title: 'PLAN-23: danxbot plugin' }
export const OTHER_SESSION = { session_id: 'sess-other', title: 'PLAN-23: review pass' }
export function rawSubagent(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `agent-${id}`,
    session_id: OWN_SESSION.session_id,
    parent_id: null,
    description: `Build ${id}`,
    agent_type: 'danxbot:worker-sonnet-high',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    state: 'running',
    end_status: null,
    started_at: CLOCK_START - 252_000,
    last_activity_at: CLOCK_START - 5_000,
    finished_at: null,
    runtime_ms: null,
    visible_until: null,
    tokens_in: 20,
    tokens_out: 40,
    cache_read: 12_000,
    cache_write: 300,
    tokens_total: 12_360,
    cost_usd: 0.4216,
    tool_call_count: 7,
    current_activity: 'Bash: Run the affected tests',
    card: { id: 'DX-9', title: 'In flight card', via: 'brief' },
    ...over,
  }
}
// an ended row: it finished `agoMs` before the fake clock's start and stays listed until ten minutes after that
export function endedSubagent(id: string, state: 'done' | 'failed' | 'stopped', agoMs: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const finished = CLOCK_START - agoMs
  return rawSubagent(id, { state, end_status: state === 'done' ? 'completed' : state, finished_at: finished, runtime_ms: 90_000, started_at: finished - 90_000, visible_until: finished + 600_000, ...over })
}

type Prob = { id: number; type: 'question' | 'action'; statement: string; open: boolean }
type Card = { id: string; title: string; priority: number; problems: Prob[] }

// DX-4448: the plan's every card id (all statuses, two boards): the fixture's own cards plus DX-30 (ToDo), DX-31 (Done) and SG-7 (gpt-manager)
const PLAN_CARD_IDS = ['DX-1', 'DX-2', 'DX-9', 'DX-30', 'DX-31', 'SG-7']

export type Dashboard = ReturnType<typeof dashboard>

// The fixture: two cards in priority order. DX-1 holds a question and an action; DX-2 holds one question.
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
    // answers KEY_LAPSED_HALT, a session that never signed in SIGN_IN_HALT; 'revoked' answers KEY_REVOKED_HALT to every tool and never asks) and plan_connect runs the request-and-approve dance
    // (world.signIn): approval_required, then approval_pending after `waitMs` on the fake clock, until a test sets `approved`
    // (then the key is stored: the tools work again and plan_connect connects to the plan it is given) or `answer`
    signedOut?: 'signed-out' | 'lapsed' | 'revoked'
    // plan_connect refuses (ok: false, 409 plan_archived) / throws
    connectFails?: boolean
    connectThrows?: boolean
    // DX-4612: the `naming` block a successful plan_connect answers: NAMING_OK (default), NAMING_NEEDED, any other value (a malformed
    // one, sent as is), or NO_NAMING for an answer without the field
    naming?: unknown
    // the dashboard has more needs-you cards than the one load reads
    cardsTotal?: number
    // ... and more plans than the plan list returns
    plansTotal?: number
    // the paged routes answer no `total` at all
    noTotal?: boolean
    // the first /api/plans call never settles until `release()`
    hangFirstLoad?: boolean
    // the plan list comes back empty although the dashboard has this many plans
    emptyPlanListOf?: number
    // the connected plan is not in the (capped) plan list
    planOutsideList?: boolean
    // DX-4448: GET /api/boards fails
    boardsFail?: boolean
    // ... answers boards the plugin cannot read: none at all, or a prefix that is not capital letters
    boardsShape?: 'none' | 'badPrefix' | 'noKey'
    // DX-4448: the plan's all-cards read fails / counts more cards than it returned
    planCardsFail?: boolean
    planCardsTotal?: number
    // ... answers no total, a row with no id, no list, or a plan card_count the cards do not add up to
    planCardsShape?: 'noTotal' | 'noId' | 'noList' | 'otherCount'
    // DX-4458: DX-3, a needs-you card with 49 open problems (DX-4443's shape)
    bigCard?: boolean
    // DX-4458: GET /api/issues/<id> answers 500 for this card
    cardFails?: string | string[]
    // DX-4458: ... and the host refuses that card's answer as too large
    cardOversize?: string
    // DX-4499: GET /api/plan-sessions fails (500) / answers something that is no list / a session with no title
    sessionsFail?: boolean
    sessionsShape?: 'noList' | 'noTitle'
    // ... GET /api/plan-sessions/<id>/subagents answers 500 for these session ids, or no list at all
    subagentsFail?: string | string[]
    subagentsNoList?: boolean
    // ... answers 404 for these session ids, or for every one (a dashboard that predates DX-4498 has no such route)
    subagentsNotFound?: string | string[] | true
    // DX-4336: the session's account uuid (CLAUDE_CODE_ACCOUNT_UUID, set only by a desktop-hosted session); none by default
    accountUuid?: string
    // ... what the usage route answers a report with: accepted (default), the dashboard's refusal of a session on no plan (409), a server
    // error (500) or an answer that names no usable cadence
    usageReply?: 'ok' | 'notConnected' | 'boom' | 'noCadence'
    // ... and the cadence it asks for (`report_every_ms`; default 60 s, danxbot's own)
    usageEveryMs?: number
    // ... or `$.session.usage()` rejecting with this reason (a host that has no usage reading)
    usageReadFails?: string
    // DX-4340: what GET /api/pacing/line answers (the session's pacing verdict and line): a body (any shape) or an error status; the dashboard's 404 (unrouted) by default
    pacingLine?: { body: unknown } | { status: number }
    // DX-4631: each pacing line read answers only after this long on the harness clock (a slow or hung dashboard); the read is counted when it starts
    pacingHoldMs?: number
    // DX-4339: what GET /api/team/pacing answers (the team's pacing settings): a body (any shape) or an error status; unreachable by default (the panel's silent, local state)
    teamPacing?: { body: unknown } | { status: number }
  } = {},
) {
  // the fake clock starts at 2026-10-03T08:00:00Z, so an `updatedAt` reads as a real age
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T08:00:00.000Z') })
  // DX-4586: a call that never settles (hangFirstLoad) waits on this, not on an hour of fake clock: advancing an hour fires every
  // timer in it (a poll a minute, a report a minute), real time that times a test out under machine load. `release()` lets it answer.
  const hung = (() => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } })()
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
    // the session id the engine answers: another one after a /clear or a resume
    sessionId: OWN_SESSION.session_id,
    listener: (options.listener === undefined ? 'healthy' : options.listener) as string | null,
    inProgress: [{ id: 'DX-9', title: 'In flight card', updatedAt: '2026-10-03T07:58:30.000Z' }] as { id: string; title: string; updatedAt: string }[],
    planId: options.connected === false ? (null as number | null) : 23,
    // DX-4234: the context reads never answer (a hung dashboard), or answer after this many ms of the fake clock
    contextHangs: false,
    contextDelayMs: 0,
    // DX-3421: GET /api/plans (the session-plan read) answers this status (a dashboard fault) instead of the session
    plansStatus: undefined as number | undefined,
    // DX-4234: whether the engine has bound the session. A desktop or headless startup, resume and fork run their SessionStart hook BEFORE it
    // binds (claude.exe: the session holder is empty until the session is built), where `$.mcp.call` and `$.tool.list` throw; `unbind()` /
    // `bind()` model that. Every kit session is bound unless a test unbinds it.
    bound: true,
    // DX-4234: the engine's file-exists check rejects with this text (a disk fault), when set
    fsError: undefined as string | undefined,
    // DX-4234: other sessions that hold a connection record on disk (a session a /clear ended that was on a plan)
    records: [] as string[],
    // DX-4234: whether this session has a connection record on disk (a connected session does; a signed-out or unconnected one does not)
    localRecord: options.connected !== false,
    // DX-4234: what GET /api/reminders/event/<event> answers: the default EVENT_TEXT(event), a text, or a status
    eventText: {} as Record<string, string | { status: number }>,
    // DX-4234: what the server's `restart_notice` tool answers (DX-4632): `{notice: null}` unless a test sets a JSON answer (`json`), a raw
    // result (`raw`), or a rejection (`deny`). `delayMs` / `hangs`: it answers late / never.
    restart: {} as { json?: unknown; raw?: unknown; deny?: string; delayMs?: number; hangs?: boolean },
    // DX-4499: the plan's live sessions, and each one's sub-agent rows (raw, as the route answers them)
    sessions: [OWN_SESSION] as { session_id: string; title: string }[],
    subagents: {} as Record<string, Record<string, unknown>[]>,
    // DX-4508: this session's sub-agents as `$.agent.list()` answers them (the engine's own list), none by default
    agents: [] as { id: string; type: string; description: string; status: string }[],
    titleSeen: undefined as string | undefined,
    // DX-4336: the rate-limit windows `$.session.usage()` answers (none by default: a session off a subscription, or before its first response)
    rateLimits: [] as { kind: string; percentUsed: number; resetsAt?: string }[],
    // DX-4423: null while the session holds a key
    signedOut: (options.signedOut ?? null) as 'signed-out' | 'lapsed' | 'revoked' | null,
    signIn: { requested: false, approved: false, waitMs: 45_000, expireAfterCalls: undefined as number | undefined, answer: undefined as { text: string; isError?: boolean; waits?: boolean } | undefined, calls: [] as any[] },
    // DX-4435: what the key's own claim route (POST /api/permission-requests/:publicId/claim) answers: a status, or 'notFound'
    permissionClaim: 'pending' as 'pending' | 'approved' | 'claimed' | 'denied' | 'expired' | 'notFound' | 'boom',
    // DX-4530: the subset the owner granted, which the claim answers once approved (and on every later, `claimed`, claim)
    permissionGranted: ['team.members.view'] as string[],
    cards: [
      {
        id: 'DX-1',
        title: 'First card',
        priority: 5,
        problems: [
          { id: 11, type: 'question', statement: 'Which route?', open: true },
          { id: 12, type: 'action', statement: 'Allow the site', open: true },
        ],
      },
      {
        id: 'DX-2',
        title: 'Second card',
        priority: 3,
        problems: [{ id: 21, type: 'question', statement: 'Second one?', open: true }],
      },
    ] as Card[],
  }
  if (options.bigCard) world.cards.push(bigCard())
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
    // DX-4499: the live sessions of the plan, newest activity first, and a session's sub-agents (danxbot DX-4498)
    if (method === 'GET' && path === '/api/plan-sessions') {
      if (options.sessionsFail) return reply({ error: 'sessions boom' }, 500)
      if (options.sessionsShape === 'noList') return reply({})
      const rows = world.sessions.map(x => ({ ...x, plan_id: world.planId, plan_name: 'Danxbot plugin', last_active_at: 1 }))
      return reply({ sessions: options.sessionsShape === 'noTitle' ? rows.map(({ title, ...r }) => r) : rows })
    }
    const subs = /^\/api\/plan-sessions\/([^/]+)\/subagents$/.exec(path)
    if (method === 'GET' && subs) {
      if ([options.subagentsFail ?? []].flat().includes(subs[1])) return reply({ error: 'subagents boom' }, 500)
      if (options.subagentsNotFound === true || [options.subagentsNotFound ?? []].flat().includes(subs[1])) return reply({ error: 'not found' }, 404)
      if (options.subagentsNoList) return reply({})
      return reply({ subagents: world.subagents[subs[1]] ?? [] })
    }
    // DX-4448: the boards (danxbot's own and gpt-manager's), whose `issue_prefix` the card links are built on
    if (method === 'GET' && path === '/api/boards') {
      if (options.boardsFail) return reply({ error: 'boards boom' }, 500)
      if (options.boardsShape === 'none') return reply({ boards: [] })
      if (options.boardsShape === 'noKey') return reply({})
      if (options.boardsShape === 'badPrefix') return reply({ boards: [{ id: 'x', issue_prefix: 'dx-1' }] })
      return reply({
        boards: [
          { id: 'danxbot:danxbot-main', issue_prefix: 'DX' },
          { id: 'gpt-manager:gpt-manager-main', issue_prefix: 'SG' },
        ],
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
        card_count: options.planCardsShape === 'otherCount' ? PLAN_CARD_IDS.length + 1 : PLAN_CARD_IDS.length,
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
    // DX-4448: the plan's every card in any status and on either board, unpaged (not board-scoped): DX-30 and DX-31 are in neither the
    // needs-you nor the in-progress bucket, SG-7 is on the gpt-manager board
    if (method === 'GET' && cards && query?.bucket === undefined) {
      if (options.planCardsFail) return reply({ error: 'plan cards boom' }, 500)
      if (options.planCardsShape === 'noList') return reply({ total: 0 })
      const rows = PLAN_CARD_IDS.map(id => (options.planCardsShape === 'noId' ? { title: id } : { id, boardId: id.startsWith('SG') ? 'gpt-manager:gpt-manager-main' : 'danxbot:danxbot-main' }))
      return reply({ cards: rows, ...(options.planCardsShape === 'noTotal' ? {} : { total: options.planCardsTotal ?? rows.length }) })
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
    if (method === 'GET' && issue && [options.cardFails ?? []].flat().includes(issue[1])) return reply({ error: 'boom' }, 500)
    if (method === 'GET' && issue && options.cardOversize === issue[1]) return text({ oversize: true })
    if (method === 'GET' && issue && world.inProgress.some(c => c.id === issue[1])) {
      const c = world.inProgress.find(x => x.id === issue[1])!
      // DX-4405: the compact row always; the claimant's name only when `fields` names it, as the real route answers
      return reply({ id: c.id, title: c.title, ...(query?.fields?.assigned_agent_name ? { assigned_agent_name: options.noAgent ? null : 'PLAN-23: danxbot plugin' } : {}) })
    }
    if (method === 'GET' && issue) {
      const c = world.cards.find(x => x.id === issue[1])
      if (!c) return reply({ error: 'nope' }, 404)
      // as the real route answers: scalars always, a relation only when `fields` names it
      return reply({ id: c.id, title: c.title, ...(query?.fields?.problems ? { problems: c.problems } : {}) })
    }
    // DX-4336: the usage route as it answers a report (danxbot handleUsage's view)
    if (method === 'PUT' && path === '/api/plan-sessions/me/usage') {
      if (options.usageReply === 'boom') return reply({ error: 'usage boom' }, 500)
      if (options.usageReply === 'notConnected') return reply({ error: 'session_not_connected', message: 'This session is not connected to a plan.' }, 409)
      if (options.usageReply === 'noCadence') return reply({ applied: true })
      return reply({ applied: true, report_every_ms: options.usageEveryMs ?? 60_000 })
    }
    if (method === 'POST' && /^\/api\/permission-requests\/[^/]+\/claim$/.test(path)) {
      if (world.permissionClaim === 'notFound') return reply({ error: 'Not found' }, 404)
      if (world.permissionClaim === 'boom') return reply({ error: 'boom' }, 500)
      const decided = world.permissionClaim === 'approved' || world.permissionClaim === 'claimed'
      return reply({ status: world.permissionClaim, granted: decided ? world.permissionGranted : null })
    }
    return reply({ error: `unrouted ${method} ${path}` }, 404)
  }

  // DX-4233: the danx-dashboard server's `plan_events_wait` as the contract words it (danxbot packages/danx-dashboard-mcp): answers
  // the records after the call's cursor, RETAINED (an answer is never a drain), or an empty list
  // when `timeout_ms` passes on the fake clock; or {stopped}. A test scripts one-off answers (`script`) and feeds events (`push`).
  const server = {
    calls: [] as { plan_id: number; cursor: string | null; timeout_ms: number; transcript_path?: string }[],
    buffer: [] as { cursor: string; text: string }[],
    plan: undefined as number | undefined,
    script: [] as (() => any)[],
    stopped: undefined as { reason: string; detail: string; fix: string } | undefined,
    wake: null as (() => void) | null,
    // a call that finds nothing waits until an event is pushed and never on the fake clock, so a test that moves the clock a long way
    // (a 30-minute cache, a sub-agent's life) does not also run a 20 s wait per step. A test of the wait itself sets how long it lasts
    // on the fake clock: the call's own `timeout_ms`, or this many ms.
    holdMs: undefined as number | 'timeout_ms' | undefined,
  }
  async function planEventsWait(args: any) {
    server.calls.push(args)
    const scripted = server.script.shift()
    if (scripted) return scripted()
    if (server.stopped) return { value: text({ stopped: server.stopped }) }
    // one plan: a call naming another plan than the last starts clean
    if (server.plan !== args.plan_id) server.buffer = []
    server.plan = args.plan_id
    // one cursor, opaque: what follows the record that carries it. Records are RETAINED (an answer is never a drain), so a cursor the
    // buffer does not hold (one the test seeded) leaves every record newer than it
    const ready = () => {
      if (args.cursor === null) return server.buffer
      const at = server.buffer.findIndex(r => r.cursor === args.cursor)
      return at === -1 ? server.buffer : server.buffer.slice(at + 1)
    }
    if (ready().length === 0) {
      const woken = new Promise<void>(resolve => (server.wake = resolve))
      await (server.holdMs === undefined ? woken : Promise.race([clock.sleep(server.holdMs === 'timeout_ms' ? args.timeout_ms : server.holdMs), woken]))
      server.wake = null
    }
    return { value: text({ events: ready() }) }
  }
  // what the plugin handed the session as a prompt (the relayed events only: a test's own prompts are not recorded). `claude plugin test`
  // has no seam that lets the plugin's own $.session.append succeed, or even see it (see toldModel below): the engine rejects it, so a
  // turn-in-flight delivery shows as a failed delivery, and what follows a successful append is covered where it is pure (relay/delivery.ts)
  // and on a live session.
  const delivered: { text: string }[] = []
  const deliveryFlags = {
    submitDrops: undefined as string | undefined,
    submitRejects: undefined as string | undefined,
    duringPrompt: undefined as undefined | (() => Promise<void>),
  }
  // the engine answers a turn's start with its id
  on('turn.start', () => ({ turnId: 't1' }) as any)
  on('prompt.submit', async (_$: any, e: any) => {
    await deliveryFlags.duringPrompt?.()
    if (deliveryFlags.submitRejects !== undefined) throw new Error(deliveryFlags.submitRejects)
    if (deliveryFlags.submitDrops !== undefined) return { drop: deliveryFlags.submitDrops } as any
    if (e.text.startsWith(RELAY_MARKER)) delivered.push({ text: e.text })
    // core answers the context it was given beside the text
    return { text: e.text, context: e.context } as any
  })

  // DX-4340: the pacing line is read by every session at start and by each spawn: kept out of `calls` and `api` so the suites that count a
  // load's reads stay about their own subject, and answered unknown (pacing off) unless a test gives `pacingLine`
  // DX-4234: the engine's own refusal of an engine call made before the session is bound (claude.exe 2.1.286, the `Yu()` guard), and the calls
  // that hit it: a test asserts a hook made none
  const unboundCalls: string[] = []
  const unboundCall = (call: string) => {
    unboundCalls.push(call)
    return { deny: `${call} is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on` } as any
  }
  const notConnected = () => options.mcp === 'down'
  const pacingReads: number[] = []
  // DX-4234: the paths of the context reads (see isContextRead), in order
  const contextReads: string[] = []
  // DX-4632: the arguments of each `restart_notice` call
  const restartCalls: unknown[] = []
  const isContextRead = (a: any) => a.method === 'GET' && (a.path.startsWith('/api/reminders/event/') || (a.path === '/api/plans' && a.query?.limit === 1))
  function contextAnswer(path: string) {
    if (path === '/api/plans' && world.plansStatus !== undefined) return reply({ error: 'plans boom' }, world.plansStatus)
    if (path === '/api/plans') return reply({ plans: [], total: 0, session: world.planId === null ? null : { plan_id: world.planId, plan_name: 'Danxbot plugin' } })
    const event = /^\/api\/reminders\/event\/(.+)$/.exec(path)
    if (event) {
      const given = world.eventText[event[1]]
      if (given === undefined) return reply({ event: event[1], effective_text: EVENT_TEXT(event[1]) })
      return typeof given === 'string' ? reply({ event: event[1], effective_text: given }) : reply({ error: 'event boom' }, given.status)
    }
  }
  // ... every attempt, including the ones the MCP being down refuses
  const pacingAttempts = { n: 0 }
  const teamPacingReads: number[] = []
  // DX-4578: the pacing reads are kept out of `calls` and `api`; the plugin's server is the one every call goes to
  const pacingPath = (e: any, path: string) => e.server === 'plugin:danxbot:danx-dashboard' && e.tool === 'danxbot_api' && e.args.path === path
  on('mcp.call', async (_$: any, e: any) => {
    if (!world.bound) return unboundCall('$.mcp.call')
    if (pacingPath(e, '/api/pacing/line')) {
      pacingAttempts.n++
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      pacingReads.push(pacingReads.length + 1)
      // the answer is fixed when the read starts: a dashboard change during the hold belongs to the next read
      const given = options.pacingLine ?? { body: { account: null, level: null, budget: null, resets_at: null, running_agents: null, line: null, reason: 'no_usage_account' } }
      if (options.pacingHoldMs !== undefined) await clock.sleep(options.pacingHoldMs)
      return { value: 'status' in given ? reply({ error: 'line boom' }, given.status) : reply(given.body) }
    }
    // DX-4339: the team's pacing settings are read at session start and by the poll: also kept out of `calls` and `api`; `teamPacingReads` counts them
    if (pacingPath(e, '/api/team/pacing')) {
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      // DX-4339: a session with no key (or a revoked one) is halted on EVERY danx-dashboard tool, this read included
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      teamPacingReads.push(teamPacingReads.length + 1)
      const given = options.teamPacing
      // no `teamPacing` given: a session whose pacing settings cannot be reached at all (the silent state), so no other suite draws a pacing error
      if (given === undefined) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      return { value: 'status' in given ? reply({ error: 'settings boom' }, given.status) : reply(given.body) }
    }
    // DX-4234 / DX-4632: the restart notice is the server's own tool, named without arguments; kept out of `calls` like the context reads
    if (e.server === SERVER && e.tool === 'restart_notice') {
      restartCalls.push(e.args)
      if (world.restart.hangs) await hung.promise
      if (world.restart.delayMs !== undefined) await clock.sleep(world.restart.delayMs)
      if (world.restart.deny !== undefined) return { deny: world.restart.deny }
      if (world.restart.raw !== undefined) return { value: world.restart.raw }
      return { value: text(world.restart.json ?? { notice: null }) }
    }
    // DX-4234: the reads the context hooks make (is the session on a plan, the registry's event text, an earlier session's restart notice) are
    // kept out of `calls` and `api` like the pacing reads, so the suites that count a load's reads stay about their own subject
    if (e.server === SERVER && e.tool === 'danxbot_api' && isContextRead(e.args)) {
      contextReads.push(e.args.path)
      if (world.contextHangs) await hung.promise
      if (world.contextDelayMs > 0) await clock.sleep(world.contextDelayMs)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      return { value: contextAnswer(e.args.path) }
    }
    calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.server === 'plugin:danxbot:danx-dashboard') {
      // a deny reaches the plugin as a rejection that carries the reason
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      const haltText = () => (world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT)
      // a revoked key stops EVERY tool, plan_connect included, and asks for nothing
      if (world.signedOut === 'revoked' || (world.signedOut !== null && e.tool !== 'plan_connect')) {
        return { value: { content: [{ type: 'text', text: haltText() }], isError: true } }
      }
      if (world.signedOut !== null && e.tool === 'plan_connect') {
        const dance = world.signIn
        dance.calls.push(e.args)
        // `waits`: the answer comes after the MCP's wait, as a still-pending request's does (a repeating caller must not spin)
        if (dance.answer?.waits) await clock.sleep(dance.waitMs)
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
      if (e.tool === 'plan_events_wait') return planEventsWait(e.args)
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
        const naming = options.naming === undefined ? NAMING_OK : options.naming
        return { value: text({ ok: true, status: 200, body: { session: { plan_id: e.args.plan_id }, ...(naming === NO_NAMING ? {} : { naming }) } }) }
      }
      api.push({ method: e.args.method, path: e.args.path, body: e.args.body, query: e.args.query })
      if (options.hangFirstLoad && e.args.path === '/api/plans' && api.filter(a => a.path === '/api/plans').length === 1) {
        return hung.promise.then(() => ({ value: route(e.args.method, e.args.path, e.args.body, e.args.query) }))
      }
      // DX-4635: every danxbot_api read answers after `apiHoldMs` on the harness clock (a slow dashboard), and the card reads in flight together are counted
      const isIssueRead = String(e.args.path).startsWith('/api/issues/')
      if (isIssueRead) {
        issueReads.active++
        issueReads.max = Math.max(issueReads.max, issueReads.active)
      }
      try {
        if (flags.apiHoldMs > 0) await clock.sleep(flags.apiHoldMs)
      } finally {
        if (isIssueRead) issueReads.active--
      }
      return { value: hostLimited(route(e.args.method, e.args.path, e.args.body, e.args.query)) }
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
  const flags = { viewWriteFails: false, refusedViewWrites: 0, apiHoldMs: 0 }
  const issueReads = { active: 0, max: 0 }
  // DX-4586: a sub-agent whose stored start time is made older by the given ms as it is written, so a test reaches the 3 h bound with no 3 h of clock
  const aged = new Map<string, number>()
  let seededUnseen: string[] | undefined
  let seededRelay: { phase: string; planId: number | null; detail: string | null } | undefined
  on('state.set', async (_$: any, e: any, next: any) => {
    // a write of the plugin's view that the host refuses: the one way a refresh can throw past its own catch
    if (flags.viewWriteFails && e.key === 'view') {
      flags.refusedViewWrites++
      return { deny: 'view write refused' } as any
    }
    // DX-4233: the next write of a turn in flight carries these rows as the ones its model requests have not read yet (a row the plugin
    // appends can never succeed under `claude plugin test`, so the state it would leave is seeded)
    // DX-4233: the next write of the relay's state is this one instead (a state left behind by a run on another plan)
    if (e.key === 'relay' && seededRelay !== undefined) {
      e = { ...e, value: seededRelay }
      seededRelay = undefined
    }
    if (e.key === 'turn' && e.value?.isInFlight === true && seededUnseen !== undefined) {
      e = { ...e, value: { ...e.value, unseen: seededUnseen } }
      seededUnseen = undefined
    }
    if (e.key === 'liveAgents' && Array.isArray(e.value)) e = { ...e, value: e.value.map((a: any) => (aged.has(a.id) ? { ...a, since: a.since - aged.get(a.id)! } : a)) }
    stateWrites.push({ plugin: e.plugin, key: e.key, value: e.value })
    return next(e)
  })
  // DX-4521: the plugin's $.store (what survives the session), one fresh map per fixture
  const stored = new Map<string, unknown>()
  let storeSetFails: string | undefined
  const storeSets: string[] = []
  on('store.get', (_$: any, e: any) => ({ value: stored.get(e.key) }) as any)
  on('store.set', (_$: any, e: any) => {
    if (storeSetFails !== undefined && String(e.key).startsWith(RELAY_CURSOR_PREFIX)) return { deny: storeSetFails } as any
    storeSets.push(String(e.key))
    return (stored.set(e.key, e.value), { value: undefined }) as any
  })
  // DX-4233: a test can hold `store.keys` (the relay's first await after its first word) until it releases it
  let storeKeysHold: Promise<void> | undefined
  on('store.keys', async () => {
    await storeKeysHold
    return { value: [...stored.keys()] } as any
  })
  on('store.delete', (_$: any, e: any) => (stored.delete(e.key), { value: undefined }) as any)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  // DX-4508: the engine's own answers the live sub-agent check reads: this session's id (the fixture's own plan session) and its
  // sub-agents (world.agents).
  const agentLists = { count: 0 }
  // the tools the session lists: the plugin's when its server is connected
  // DX-4234: how many times the session's tool list was read (a poll for the plugin's server that outlives its deadline keeps counting)
  const toolLists = { n: 0 }
  const toolListAnswer = () => ({ value: notConnected() ? [] : [{ name: 'mcp__plugin_danxbot_danx-dashboard__danxbot_api', description: '', mcp: true }] }) as any
  on('tool.list', () => (toolLists.n++, world.bound ? toolListAnswer() : unboundCall('$.tool.list')))
  // the engine's per-session path as the OS spells it (C:\home\u\... on Windows)
  on('fs.exists', (_$: any, e: any) => {
    if (world.fsError !== undefined) return { deny: world.fsError } as any
    const path = e.path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
    return { value: (world.localRecord && path === RECORD_PATH(world.sessionId)) || world.records.some(id => path === RECORD_PATH(id)) } as any
  })
  on('session.id', () => ({ value: world.sessionId }) as any)
  on('agent.list', () => {
    agentLists.count++
    return { value: world.agents } as any
  })
  // DX-4508: the live reader child (`$.process.spawn`): each start is recorded with its argv; a test queues what it prints
  // (`pieces`) and how it ends on its own (`end`), delivered a mocked-clock second apart (READER_PIECE_MS). `stopped` says the
  // plugin ended it (its stream returned, the call abandoned); a child that exited on its own is not stopped.
  const readers: FakeReader[] = []
  on('process.spawn', async function* (_$: any, e: any, next: any) {
    const child: FakeReader = { argv: [...e.argv], pieces: [], end: null, stopped: false }
    readers.push(child)
    let exited = false
    try {
      while (!next.signal.aborted) {
        while (child.pieces.length > 0) yield child.pieces.shift()!
        if (child.end !== null) {
          exited = true
          return { value: child.end }
        }
        await clock.sleep(READER_PIECE_MS)
      }
      return { value: { code: null, signal: 'SIGTERM' } }
    } finally {
      child.stopped = !exited
    }
  } as any)
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
  // DX-4448: what the engine draws for an assistant reply when no plugin rewrites it: the text as it is
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Box, Text } = $.ui.resolve(e)
    // the other props are shown too, so a test sees that a rewrite carried them on
    return (
      <Box flexDirection="column">
        <Text>{e.props.text}</Text>
        <Text key="meta">{`first=${e.props.isFirstOfReply} onScreen=${JSON.stringify(e.props.onScreen ?? null)}`}</Text>
      </Box>
    )
  })
  // DX-4336: what the harness knows of the account's windows
  on('session.usage', () => (options.usageReadFails === undefined ? { value: { startedAt: 0, context: {}, rateLimits: world.rateLimits } } : { deny: options.usageReadFails }) as any)
  mock.env(on, { HOME: HOME_DIR, ...(options.accountUuid === undefined ? {} : { CLAUDE_CODE_ACCOUNT_UUID: options.accountUuid }) })
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

  const relay = {
    server,
    delivered,
    // the plan_events_wait calls the plugin made
    calls: server.calls,
    // events appear on the dashboard: a held wait answers at once
    push: (...events: { cursor: string; text: string }[]) => {
      server.buffer.push(...events)
      server.wake?.()
    },
    // every key the plugin wrote to $.store, in order
    storeSets,
    // holds the plugin's next `store.keys` reads until the returned function is called
    holdStoreKeys: () => {
      let release!: () => void
      storeKeysHold = new Promise<void>(resolve => (release = resolve))
      return release
    },
    // the relay's cursor writes to $.store are refused with this reason (a failure that is none of the relay's own)
    failCursorWrites: (reason: string) => void (storeSetFails = reason),
    // runs inside the next prompt submit, before it answers: a plan move at the very moment an event is delivered
    duringPrompt: (fn: () => Promise<void>) => void (deliveryFlags.duringPrompt = fn),
    dropPrompts: (reason: string) => void (deliveryFlags.submitDrops = reason),
    rejectPrompts: (reason: string) => void (deliveryFlags.submitRejects = reason),
    acceptPrompts: () => {
      deliveryFlags.submitDrops = undefined
      deliveryFlags.submitRejects = undefined
    },
  }
  return { unbind: () => void (world.bound = false), bind: () => void (world.bound = true), unboundCalls, holdApi: (ms: number) => void (flags.apiHoldMs = ms), issueReads, stored, relay, seedUnseen: (rows: string[]) => void (seededUnseen = rows), seedRelay: (state: { phase: string; planId: number | null; detail: string | null }) => void (seededRelay = state), release: hung.release, ageLiveAgent: (id: string, ms: number) => void aged.set(id, ms), pacingReads, contextReads, restartCalls, toolLists, pacingAttempts, teamPacingReads, setPacingLine: (given: { body: unknown } | { status: number } | undefined) => void (options.pacingLine = given), failUsage: (reason: string | undefined) => void (options.usageReadFails = reason), setTeamPacing: (given: { body: unknown } | { status: number } | undefined) => void (options.teamPacing = given), agentLists, readers, toastTimeouts, serveSubagents: () => void (options.subagentsNotFound = undefined), setMcp: (mode: 'up' | 'down' | 'flaky' | 'stale') => void (options.mcp = mode), failInProgress: (on = true) => void (options.inProgressFails = on), failViewWrite: (on = true) => void (flags.viewWriteFails = on), setListener: (state: string | null) => void (world.listener = state), refusedViewWrites: () => flags.refusedViewWrites, stateWrites, tabs: () => options.tabs ?? [], setBrowser: (mode: 'ok' | 'denied') => void (options.browser = mode), failList: (on = true) => void (options.listFails = on), closeTabs: () => void (options.tabs = []), calls, api, toasts, statuses, opened, commands, world, clock, writes: () => api.filter(a => a.method !== 'GET') }
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

// DX-4508: one start of the live reader child, as the kit's process.spawn stand-in records it (see `readers` in dashboard()).
export const READER_PIECE_MS = 1_000
export type FakeReader = {
  argv: string[]
  pieces: { stream: 'stdout' | 'stderr'; text: string }[]
  end: { code: number | null; signal: string | null } | null
  stopped: boolean
}

// session.start as the engine raises it (the plugin loads the plan, registers its command and
// starts its pacing poll and the relay), then lets the load it kicked off finish.
export async function startSession($: any, d: Dashboard, surface: string) {
  await $.session.start({ cwd: '/work', surface, isInteractive: true })
  await d.clock.settle()
}

// DX-4234: a session start reaches the model on the FIRST PROMPT's context, beside its time stamp (SessionStart is recorded only: the engine
// has not bound the session then). `startLines` is what the start added: the prompt's context after the stamp, or undefined when it added nothing.
export async function firstPrompt($: any, source: string, input: Record<string, unknown> = {}): Promise<{ startLines: string[] | undefined; context: string[] }> {
  await $.classic.SessionStart({ source, cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl', ...input })
  const r = await $.prompt.submit({ text: 'hello' })
  const context: string[] = r.context ?? []
  return { startLines: context.length > 1 ? context.slice(1) : undefined, context }
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

// The model's plan_connect as the host runs it (the engine has no implementation of its own): the dashboard connects the plan the call names,
// and the call answers. Registered before the test first uses `$`, like every hook.
export function answerPlanConnect(on: On, d: { world: { planId: number | null } }) {
  on('tool.call', { tool: toolName('plan_connect') }, (_$: any, e: any) => {
    if (typeof e.plan_id === 'number') d.world.planId = e.plan_id
    // the real answer's envelope (the server's handleConnect): the plan the session is on now
    const text = JSON.stringify({ ok: true, status: 200, body: { session: { plan_id: d.world.planId } } })
    return { result: {}, text, isError: false } as any
  })
}

// DX-4233: there is no polling timer any more, so a refresh a test used to wait 60 s of the fake clock for is asked for here: the
// `/danx-plan` command forces one (it also opens the pane), and the load is let to finish.
export async function forceRefresh($: any, d: Dashboard) {
  await $.command.run({ command: 'danx-plan' })
  await d.clock.settle()
}
