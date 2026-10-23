// Shared stand-ins for the `claude plugin test danxbot` suites: a fake danx-dashboard MCP server
// (danxbot_api + plan_connect), and recorders for the engine calls the
// plugin makes beneath it (toast, status, session.append, command.register).
import { expect, mock, test as baseTest } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SERVER, toolName } from '../hooks/plan/config'
import { CURSOR_PREFIX as RELAY_CURSOR_PREFIX, RELAY_MARKER } from '../hooks/relay/config'

// DX-4883: the runner's default is 5000 ms of REAL time per test, and a case that drives the mocked clock pays real time to settle every timer
// it fires (about 1 s to start a session plus about 55 ms per mocked minute: the plugin's pacing and usage tickers run each minute). A
// 25-minute keepalive case takes 2-3.5 s on a quiet machine and crossed 5 s under load, refusing a publish. Every case built on this kit gets
// this bounded ceiling instead; it is a ceiling on machine load, not an assertion about speed (R-48), and a real hang still fails.
export const KIT_TEST_TIMEOUT_MS = 60_000
export const test = (name: string, body: (...args: any[]) => unknown): void => baseTest(name, { timeoutMs: KIT_TEST_TIMEOUT_MS } as any, body as any)

export const SURFACES = ['terminal', 'desktop'] as const

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })
// DX-4317: the dashboard origin the fixture answers (`dashboard_url`): deliberately not the production
// one, so a link built on a constant instead of the answer fails every test that checks a href.
// DX-4234: the registry's effective text the fixture answers for an event (a distinct text per event, so a wrong event shows)
export const EVENT_TEXT = (event: string) => `The ${event} text.`
// DX-4993: a connected session's compaction is followed by the resume briefing in the same entry: here for the fixture's plan (PLAN-23 Danxbot plugin), DX-9 in
// flight, no running sub-agent and a clean checkout of main. `TOLD(event)` is everything a session start of that event adds beside the time stamp.
// the procedure is pinned literally (not imported): a reworded production text must fail the tests that compare against it
export const DEFAULT_BRIEFING = "[50 ARMS] Your conversation was just compacted. Resume now, without asking the person, in this order: (1) re-invoke every skill you had loaded, because the compaction truncated their bodies; (2) read the newest handoff agent note on your plan's in-flight cards; (3) re-read each In Progress card you hold; (4) check your running sub-agents (listed below when they could be read) and wait for their notifications, never starting a duplicate; (5) continue the step that was in progress. Your plan is PLAN-23 Danxbot plugin. Cards in flight on your plan: DX-9 In flight card. Read each card before you act on it. Sub-agents running: none. Work not pushed, in the session's own checkout (branch main): no uncommitted changes, nothing unpushed."
export const TOLD = (event: string) => (event === 'after_compaction' ? `${EVENT_TEXT(event)}
${DEFAULT_BRIEFING}` : EVENT_TEXT(event))
// DX-4234: where the fixture's machine keeps the MCP server's connection record of a session (what makes a session locally known as plan-connected)
export const HOME_DIR = '/home/u'
export const RECORD_PATH = (sessionId: string) => `${HOME_DIR}/.config/danxbot/plan-sessions/${sessionId}.json`
export const DASHBOARD_URL = 'http://localhost:5555'
// `dashboardUrl: NO_DASHBOARD_URL` leaves the field out of the answer (a JSON null is sent as one)
export const NO_DASHBOARD_URL = Symbol('no dashboard_url')
// DX-4423 / DX-4418: what the danx-dashboard MCP (0.1.225, session-access.ts and key-revoked-halt.ts) answers every tool but
// plan_connect while the session holds no key: an error result. SIGN_IN_HALT is a session that never signed in, KEY_LAPSED_HALT
// what the first call after a lapsed key's 401 answers (it ends in the sign-in sentence), and KEY_REVOKED_HALT the one stop halt
// for a key a PERSON revoked, which EVERY tool answers, plan_connect included, with no access request. These are the server's
// words, for the agent: the plugin must never show them to the person.
// DX-4805: what the engine says when auto mode's classifier gave no verdict on a hook-initiated `$.mcp.call` (the incident's text)
export const CLASSIFIER_REFUSAL = 'The server-side auto mode classifier gave no verdict for mcp__plugin_danxbot_danx-dashboard__plan_events_wait'
export const SIGN_IN_HALT = "Not signed in to the danxbot dashboard. Call `plan_connect` (with `title`: your session's own title) to request access; the user approves it in their browser, then this tool works."
export const KEY_LAPSED_HALT = `The dashboard no longer accepts this session's key (it lapsed after a day unused), so this session is signed out. ${SIGN_IN_HALT}`
export const REVOKER = 'dana'
export const REVOKED_AT = '2026-10-04T07:00:00.000Z'
export const KEY_REVOKED_HALT = `STOP ALL WORK NOW. ${REVOKER} revoked your access to the danxbot dashboard at ${REVOKED_AT}.\n\nCommit your work in progress now (commit what you have; do not run agent-finalize.sh and do not merge). Then end this session: tell the person what you committed and stop.\n\nDo not call plan_connect or any other danxbot dashboard tool again, do not request access again and do not look for another route.`
// DX-5549: the MCP agent gate's answer to a dashboard call while the session holds no team agent: the sign-in's own block, as JSON
export const AGENT_GATE_HALT = (state: 'agent_needed' | 'agent_limit_reached') =>
  state === 'agent_needed'
    ? { state, instruction: 'You have no team agent to sign in as: none is free for this person. Propose one yourself.' }
    : { state, cap: 'member', limit: 1, held: 1, raised_by: 'a team owner or admin', instruction: 'No team agent is free. Tell the person.' }
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
// session on DX-4443). The fixture's limit is lower than the real one so a fixture card can pass it.
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

export const CLOCK_START = Date.parse('2026-10-03T08:00:00.000Z')
export const OWN_SESSION = { session_id: 'sess-own', title: 'PLAN-23: danxbot plugin' }
export const OTHER_SESSION = { session_id: 'sess-other', title: 'PLAN-23: review pass' }
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
    mcp?: 'up' | 'down' | 'flaky' | 'refused' | 'strictKeys'
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
    // plan_connect {disconnect: true}: the leave works (default), or the server refuses it a given way
    // ('rejected' is a THROWN call, the only error result; 'noLeftPlan' is a 200 without leftPlan)
    disconnect?: 'ok' | 'mismatch' | 'notConnected' | 'notFound' | 'rejected' | 'noLeftPlan'
    // the disconnect call takes this long on the fake clock
    disconnectTakesMs?: number
    listFails?: boolean
    // DX-4423: the session holds no dashboard key: every danxbot_api call is the MCP's error result (the first call after a revoke
    // answers KEY_LAPSED_HALT, a session that never signed in SIGN_IN_HALT; 'revoked' answers KEY_REVOKED_HALT to every tool and never asks) and plan_connect runs the request-and-approve dance
    // (world.signIn): approval_required, then approval_pending after `waitMs` on the fake clock, until a test sets `approved`
    // (then the key is stored: the tools work again and plan_connect connects to the plan it is given) or `answer`
    signedOut?: 'signed-out' | 'lapsed' | 'revoked'
    // plan_connect refuses (ok: false, 409 plan_archived) / throws
    connectFails?: boolean
    connectThrows?: boolean
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
    // DX-4336: the session's account uuid (CLAUDE_CODE_ACCOUNT_UUID, set only by a desktop-hosted session); none by default
    accountUuid?: string
    // DX-4806: the process's CLAUDE_CODE_ENTRYPOINT ('claude-desktop' for the desktop app, 'cli' for a terminal); none by default
    entrypoint?: string
    // DX-5217: CLAUDE_CODE_AUTO_COMPACT_WINDOW as the session's process starts with it (an older plugin version set it to the floor)
    autoCompactWindow?: string
    // DX-5231: a CLAUDE_AUTOCOMPACT_PCT_OVERRIDE an older plugin version left in the process
    autocompactPct?: string
    // DX-5365: what `$.session.version()` answers: the engine's `base` release (default 2.1.298, one under the floor that runs `session.compact` per agent), no `base` at all, or a call that throws
    engineVersion?: { base: string | undefined } | 'throws'
    // DX-5231: the reason the host refuses the plugin's own `/compact` run with (a handler that throws)
    compactRunFails?: string
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
    // DX-5593 (C1): what DELETE /api/pacing/agents/claim (the claim given back) answers instead of the real release: an error status, or any body (a 200)
    claimRelease?: { status: number } | { body: unknown }
    // DX-4952: the test puts steps before reads of $.state (`beforeNextRead`), which needs the `state.get` hook from the start
    stateSteps?: boolean
  } = {},
) {
  // DX-4952: the machine asleep. A suspend moves the wall clock (`clock.now`, Date.now) on while no timer runs, which is what a relative
  // setTimeout does across a sleep (the engine's `clock.after` is one): `d.suspend(ms)` moves only what `$.clock.now()` reads, no wait resolves.
  // A hook name registers once, so the kit's own `clock.now` answer is wrapped as mock.clock registers it.
  let asleepMs = 0
  const clockOn = ((event: string, ...rest: any[]) => {
    if (event !== 'clock.now') return (on as any)(event, ...rest)
    const answer = rest.pop()
    return (on as any)(event, ...rest, async (...args: any[]) => {
      const r = await answer(...args)
      return typeof r === 'number' ? r + asleepMs : { ...r, value: r.value + asleepMs }
    })
  }) as typeof on
  // the fake clock starts at 2026-10-03T08:00:00Z, so an `updatedAt` reads as a real age
  const clock = mock.clock(clockOn, { now: Date.parse('2026-10-03T08:00:00.000Z') })
  // DX-4586: a call that never settles (hangFirstLoad) waits on this, not on an hour of fake clock: advancing an hour fires every
  // timer in it (a poll a minute, a report a minute), real time that times a test out under machine load. `release()` lets it answer.
  const hung = (() => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } })()
  // DX-3900: the surfaces the session draws on, as `$.session.surfaces()` reads them: terminal first under the REPL, then each client in the
  // order it attached. startSession fills it the way the engine does (the desktop app joins AFTER session.start, by session.attach).
  const roster: string[] = []
  on('session.surfaces', () => ({ value: [...roster] }) as any)
  on('session.attach', (_$: any, e: any) => ({ clientId: e.clientId }) as any)
  on('session.detach', (_$: any, e: any) => ({ clientId: e.clientId }) as any)
  const calls: { server: string; tool: string; args: any }[] = []
  const api: { method: string; path: string; body?: any; query?: any }[] = []
  const toasts: string[] = []
  // DX-5365: how many times the plugin asked the engine for its version
  let versionReads = 0
  const toastTimeouts: number[] = []
  const statuses: (string | undefined)[] = []
  const stateWrites: { plugin: string; key: string; value: unknown }[] = []
  const commands: string[] = []
  // DX-5231: the arguments of each `/compact` the plugin ran itself
  const compactRuns: unknown[] = []
  const world = {
    // the session id the engine answers: another one after a /clear or a resume
    sessionId: OWN_SESSION.session_id,
    listener: (options.listener === undefined ? 'healthy' : options.listener) as string | null,
    inProgress: [{ id: 'DX-9', title: 'In flight card' }] as { id: string; title: string }[],
    planId: options.connected === false ? (null as number | null) : 23,
    // DX-5554: the team agent the session signs in as (GET /api/plans `session.agent`), and the stand-alone card it holds instead of a plan
    // (`session.card_id` / `card_title`); neither by default. A session with none of a plan, a card and an agent has no session row (`session: null`).
    agent: null as { id: number; name: string; avatar_url: string | null } | null,
    card: null as { id: string; title: string } | null,
    // DX-5554: what DELETE /api/plan-sessions/me/agent (the release at session exit) answers: `{released}` by default (true while an agent is held), an
    // error status, the engine's refusal (`deny`), or an answer that comes only after `delayMs` on the harness clock / never (`hangs`)
    release: {} as { status?: number; deny?: string; delayMs?: number; hangs?: boolean },
    // DX-5549 / DX-5554: the MCP's agent gate. After a plan_connect answered that no team agent is free, every danxbot_api call but the two
    // proposal routes answers that same block (AGENT_GATE_HALT) as an error result, until a plan_connect holds an agent
    agentGate: null as 'agent_needed' | 'agent_limit_reached' | 'agent_not_held' | null,
    // DX-4234: the context reads never answer (a hung dashboard), or answer after this many ms of the fake clock
    contextHangs: false,
    contextDelayMs: 0,
    // DX-3421: GET /api/plans (the session-plan read) answers this status (a dashboard fault) instead of the session
    plansStatus: undefined as number | undefined,
    // DX-4234: whether the engine has bound the session. A desktop or headless startup, resume and fork run their SessionStart hook BEFORE it
    // binds (claude.exe: the session holder is empty until the session is built), where `$.mcp.call` and `$.tool.list` throw; `unbind()` /
    // `bind()` model that. Every kit session is bound unless a test unbinds it.
    bound: true,
    plansBody: undefined as unknown,
    // DX-5093: the desktop's Browser pane server (`Claude_Browser`) as the plan-tab keepalive reaches it: whether the session has the server, whether the
    // pane is open, the origins of its tabs, the failures of each tool (the text of an `isError` answer), how long `tabs_context` takes, and the calls made
    // (`tabs_context`, `tabs_create`, `navigate <url> <tabId|->`). Default: the pane holds a tab on the dashboard's site, so a look changes nothing.
    browser: {
      present: true,
      open: true,
      tabs: [new URL(DASHBOARD_URL).origin] as string[],
      errors: {} as Partial<Record<'tabs_context' | 'tabs_create' | 'navigate', string>>,
      rejects: undefined as string | undefined,
      // `tabs_create` hands back a tab that already existed
      reuses: false,
      delayMs: 0,
      calls: [] as string[],
    },
    // DX-4233: the plugin server's tools the session lists (see toolListAnswer)
    tools: 'full' as 'full' | 'old' | 'none',
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
    // DX-4508: this session's sub-agents as `$.agent.list()` answers them (the engine's own list), none by default
    agents: [] as { id: string; type: string; description: string; status: string }[],
    titleSeen: undefined as string | undefined,
    // DX-4235: the boards GET /api/plans/mine names for the session's plan, each board's ToDo card rows as GET /api/issues answers them
    // (the ready-cards check), and a per-route override of a report or ready-cards answer (`<METHOD> <path>`): an error status (with
    // its body), the engine's refusal (`deny`), or an answer that comes only after `delayMs` on the harness clock
    planBoards: ['danxbot:danxbot-main'] as string[],
    readyRows: {} as Record<string, unknown[]>,
    // DX-4997: what GET /api/plan-sessions/me/pause answers as `pause` (null, an agent pause, a usage pause)
    pause: null as unknown,
    reportReplies: {} as Record<string, { status?: number; body?: unknown; deny?: string; delayMs?: number }>,
    // DX-4993: the context `$.session.usage()` answers (tokens now, the model's window): none by default, a session before its first response
    context: {} as { tokens?: number; window?: number },
    // DX-4993: files on the fixture's disk by path (the compaction control the relay writes), as `$.fs.exists` / `$.fs.read` see them
    files: {} as Record<string, string>,
    // DX-4993: what `git status --porcelain=v1 -b` prints in the session's directory (the resume briefing), or its exit code when it fails
    gitStatus: { exitCode: 0, stdout: '## main...origin/main\n' } as { exitCode: number; stdout: string },
    // DX-4336: the rate-limit windows `$.session.usage()` answers (none by default: a session off a subscription, or before its first response)
    rateLimits: [] as { kind: string; percentUsed: number; resetsAt?: string }[],
    // DX-4423: null while the session holds a key
    signedOut: (options.signedOut ?? null) as 'signed-out' | 'lapsed' | 'revoked' | null,
    signIn: { requested: false, approved: false, waitMs: 45_000, expireAfterCalls: undefined as number | undefined, answer: undefined as { text: string; isError?: boolean; waits?: boolean } | undefined, calls: [] as any[] },
    // DX-4435: what the key's own claim route (POST /api/permission-requests/:publicId/claim) answers: a status, or 'notFound'
    // DX-4686: the key's claim route answers only after this long on the harness clock (a step after the plan load that holds the refresh lock)
    permissionClaimDelayMs: 0,
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
  // DX-5232: every card of the plan (any status, either board): the fixture's own cards and the others
  const planCardIds = [...new Set([...PLAN_CARD_IDS, ...world.cards.map(c => c.id)])]
  const plans = [
    { id: 23, ref: 'PLAN-23', name: options.planName ?? 'Danxbot plugin', status: 'building', archived_at: null, bucket_counts: { 'needs-you': 2 } },
    { id: 24, ref: 'PLAN-24', name: 'Agent mode', status: 'building', archived_at: null, bucket_counts: { 'needs-you': 0 } },
    { id: 25, ref: 'PLAN-25', name: 'Archived', status: 'done', archived_at: 'x', bucket_counts: {} },
  ]

  function route(method: string, path: string, body: any, query: any) {
    if (method === 'GET' && path === '/api/plans') {
      // DX-4233: GET /api/plans answers this as its body, whatever its shape (a string makes the plugin's session read throw)
      if (world.plansBody !== undefined) return reply(world.plansBody)
      if (world.plansStatus !== undefined) return reply({ error: 'plans boom' }, world.plansStatus)
      if (options.listFails) return reply({ error: 'boom' }, 500)
      return reply({
        plans: options.emptyPlanListOf ? [] : options.planOutsideList ? plans.filter(p => p.id !== world.planId) : plans,
        ...(options.noTotal ? {} : { total: options.emptyPlanListOf ?? options.plansTotal ?? plans.length }),
        // DX-5551 / DX-5553: the session row as the plan_session resource projects it, for any registered session (on a plan, holding a card, or
        // on neither); null only for a session with no row
        session:
          world.planId === null && world.card === null && world.agent === null
            ? null
            : {
                plan_id: world.planId,
                plan_name: world.planId === null ? null : (plans.find(p => p.id === world.planId)?.name ?? 'Far plan'),
                card_id: world.card?.id ?? null,
                card_title: world.card?.title ?? null,
                agent: world.agent,
              },
        // DX-5553: a session holding a card is bound to work and keeps its health, as one on a plan does
        sessionListenerAttached:
          options.rawListener !== undefined
            ? options.rawListener
            : (world.planId === null && world.card === null) || world.listener === null
            ? null
            : { attached: options.attached ?? world.listener === 'healthy', state: world.listener, nextStep: world.listener === 'healthy' ? null : NEXT_STEP(world.listener) },
        ...(options.dashboardUrl === NO_DASHBOARD_URL ? {} : { dashboard_url: options.dashboardUrl === undefined ? DASHBOARD_URL : options.dashboardUrl }),
      })
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
        card_count: options.planCardsShape === 'otherCount' ? planCardIds.length + 1 : planCardIds.length,
        ...(options.noBreakdown ? {} : { status_breakdown: options.breakdown ?? DEFAULT_BREAKDOWN }),
      })
    }
    const cards = /^\/api\/plans\/(\d+)\/cards$/.exec(path)
    if (method === 'GET' && cards && query?.bucket === 'in-progress') {
      if (options.inProgressFails) return reply({ error: 'in-progress boom' }, 500)
      return reply({
        cards: world.inProgress.map(c => ({ id: c.id, title: c.title, priority: 4 })),
        ...(options.noInProgressTotal ? {} : { total: options.inProgressTotal ?? world.inProgress.length }),
      })
    }
    // DX-4448: the plan's every card in any status and on either board, unpaged (not board-scoped): DX-30 and DX-31 are in neither the
    // needs-you nor the in-progress bucket, SG-7 is on the gpt-manager board
    if (method === 'GET' && cards && query?.bucket === undefined) {
      if (options.planCardsFail) return reply({ error: 'plan cards boom' }, 500)
      if (options.planCardsShape === 'noList') return reply({ total: 0 })
      const rows = planCardIds.map(id => {
        const openProblemCount = world.cards.find(c => c.id === id)?.problems.filter(p => p.open).length ?? 0
        return options.planCardsShape === 'noId' ? { title: id, openProblemCount } : { id, openProblemCount, boardId: id.startsWith('SG') ? 'gpt-manager:gpt-manager-main' : 'danxbot:danxbot-main' }
      })
      return reply({ cards: rows, ...(options.planCardsShape === 'noTotal' ? {} : { total: options.planCardsTotal ?? rows.length }) })
    }
    const issue = /^\/api\/issues\/([A-Z]+-\d+)$/.exec(path)
    if (method === 'GET' && issue && [options.cardFails ?? []].flat().includes(issue[1])) return reply({ error: 'boom' }, 500)
    if (method === 'GET' && issue && options.cardOversize === issue[1]) return text({ oversize: true })
    if (method === 'GET' && issue) {
      const c = world.cards.find(x => x.id === issue[1])
      if (!c) return reply({ error: 'nope' }, 404)
      // as the real route answers: scalars always, a relation only when `fields` names it
      return reply({ id: c.id, title: c.title, ...(query?.fields?.problems ? { problems: c.problems } : {}), ...(query?.fields?.open_problem_count ? { open_problem_count: c.problems.filter(p => p.open).length } : {}) })
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
  // the records after the call's cursor (those at or below it are dropped; an answer itself is never a drain), or an empty list
  // when `timeout_ms` passes on the fake clock; or {stopped}. A test scripts one-off answers (`script`) and feeds events (`push`).
  const server = {
    calls: [] as { plan_id: number; cursor: string | null; timeout_ms: number; transcript_path?: string }[],
    buffer: [] as { cursor: string; text: string; urgent: boolean }[],
    plan: undefined as number | undefined,
    script: [] as (() => any)[],
    stopped: undefined as { reason: string; detail: string; fix: string } | undefined,
    wake: null as (() => void) | null,
    // a call that finds nothing waits until an event is pushed and never on the fake clock, so a test that moves the clock a long way
    // (a 30-minute cache, a sub-agent's life) does not also run a 20 s wait per step. A test of the wait itself sets how long it lasts
    // on the fake clock: the call's own `timeout_ms`, or this many ms.
    holdMs: undefined as number | 'timeout_ms' | undefined,
    // DX-5398: waits in flight now and the most there ever were together (the relay holds exactly one wait loop)
    inFlight: 0,
    maxInFlight: 0,
    dropped: 0,
  }
  async function planEventsWait(args: any) {
    server.inFlight++
    server.maxInFlight = Math.max(server.maxInFlight, server.inFlight)
    try {
      return await planEventsWaitOnce(args)
    } finally {
      server.inFlight--
    }
  }
  async function planEventsWaitOnce(args: any) {
    server.calls.push(args)
    const scripted = server.script.shift()
    if (scripted) return scripted()
    if (server.stopped) return { value: text({ stopped: server.stopped }) }
    // one plan: a call naming another plan than the last starts clean
    if (server.plan !== args.plan_id) server.buffer = []
    server.plan = args.plan_id
    // one cursor, opaque: what follows the record that carries it. An answer is never a drain (records stay until a LATER call presents their cursor), but
    // DX-5398: the real server DROPS every record at or below the cursor a call presents (the cursor acknowledges them), so a record the caller took and has
    // not delivered is gone from the server once the next poll presents its cursor; `dropped` counts them. A cursor the buffer does not hold (one the test
    // seeded) drops nothing and leaves every record
    if (args.cursor !== null) {
      const at = server.buffer.findIndex(r => r.cursor === args.cursor)
      if (at !== -1) {
        server.dropped += at + 1
        server.buffer = server.buffer.slice(at + 1)
      }
    }
    const ready = () => server.buffer
    if (ready().length === 0) {
      const woken = new Promise<void>(resolve => (server.wake = resolve))
      await (server.holdMs === undefined ? woken : Promise.race([clock.sleep(server.holdMs === 'timeout_ms' ? args.timeout_ms : server.holdMs), woken]))
      server.wake = null
    }
    return { value: text({ events: ready() }) }
  }
  // what the plugin handed the session as a prompt (the relayed events only: a test's own prompts are not recorded), and the rows it
  // appended to the conversation with $.session.append (DX-4793: since Claude Code 2.1.293 the kit lets the append through and calls the
  // test's session.append hook with the row; what the live engine then does with the row is proved on a live session)
  const delivered: { text: string }[] = []
  // DX-5093: every prompt the plugin submitted, marked or not (`delivered` holds only the plan-event ones)
  const submitted: string[] = []
  const told: string[] = []
  const deliveryFlags = {
    submitDrops: undefined as string | undefined,
    submitRejects: undefined as string | undefined,
    duringPrompt: undefined as undefined | (() => Promise<void>),
    appendRejects: undefined as string | undefined,
    // DX-5398: while set, a prompt submit settles only when this resolves (see relay.holdPrompts)
    promptGate: undefined as undefined | Promise<void>,
    promptsHeld: 0,
  }
  // DX-4793: the row a plugin appends is one user message of text blocks; a test sets appendRejects to make the engine refuse it
  on('session.append', (_$: any, e: any, next: any) => {
    if (deliveryFlags.appendRejects !== undefined) return { deny: deliveryFlags.appendRejects } as any
    told.push(e.message.content.map((block: any) => block.text).join(''))
    return next(e)
  })
  // the engine answers a turn's start with its id
  on('turn.start', () => ({ turnId: 't1' }) as any)
  on('prompt.submit', async (_$: any, e: any) => {
    await deliveryFlags.duringPrompt?.()
    // DX-5398: the engine (claude.exe 2.1.299) settles a plugin's `$.prompt.submit` only when the queued prompt ENTERS the session, which behind a
    // running turn is when the turn ends. The prompt is then recorded as submitted at that moment, not at the call.
    const gate = deliveryFlags.promptGate
    if (gate !== undefined) {
      deliveryFlags.promptsHeld++
      try {
        await gate
      } finally {
        deliveryFlags.promptsHeld--
      }
    }
    if (deliveryFlags.submitRejects !== undefined) throw new Error(deliveryFlags.submitRejects)
    if (deliveryFlags.submitDrops !== undefined) return { drop: deliveryFlags.submitDrops } as any
    submitted.push(e.text)
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
  // DX-5593: the spawn claim (POST /api/pacing/agents/claim) and its give-back (DELETE ...?claim_id=): every attempt, the ids danxbot allowed, the ids given back
  const claimAttempts = { n: 0 }
  const claimsAllowed: string[] = []
  const claimsReleased: string[] = []
  // DX-5593 (N2): the body of every claim POST, to see what reading it carried
  const claimBodies: any[] = []
  const heldClaims = new Set<string>()
  // DX-4234: the paths of the context reads (see isContextRead), in order
  const contextReads: string[] = []
  // DX-4632: the arguments of each `restart_notice` call
  const restartCalls: unknown[] = []
  // DX-5554: each release of the session's team agent (DELETE /api/plan-sessions/me/agent), kept out of `calls` and `api` like the context reads
  const releaseCalls: { method: string; path: string; background: unknown }[] = []
  // DX-4997 / DX-5033: the dashboard's rule for the agent pause. A `danxbot_api` call marked `background: true` (the plugin's own work) never ends it;
  // an unmarked one (the agent's own call) does, except the route that manages the pause itself.
  const serverPauseRule = (args: any) => {
    const managesPause = args.path === '/api/plan-sessions/me/pause'
    if (!managesPause && args.background !== true && (world.pause as { limit?: string } | null)?.limit === 'agent') world.pause = null
  }
  // DX-4997: every danxbot_api call the plugin made WITHOUT `background: true` (there must be none)
  const unmarked: string[] = []
  // DX-5062: the calls an MCP in `strictKeys` mode (one older than the DX-5033 release) refused for carrying `background`
  const backgroundRefusals: string[] = []
  // DX-4235: the fields every GET /api/issues row carries without being asked for (the issue resource's compact row)
  const ISSUE_ROW_FIELDS = ['id', 'type', 'title', 'status', 'parent_id', 'priority', 'created_at', 'updated_at', 'assigned_agent', 'content_hash']
  // DX-4235: the reports' calls and the ready-cards reads, in order, kept out of `calls` and `api` like the context reads (every suite that
  // counts a load's reads or a session's writes stays about its own subject)
  const reportCalls: { method: string; path: string; body?: any; query?: any; board?: string }[] = []
  // DX-4235: the report calls and the plugin server's tool calls in the order they were made (`report <METHOD> <path>`, `tool <name>`)
  const sequence: string[] = []
  const isReportCall = (a: any) =>
    (a.method === 'POST' && a.path === '/api/plan-sessions/me/activity') ||
    (a.method === 'GET' && (a.path === '/api/plans/mine' || a.path === '/api/issues' || a.path === '/api/plan-sessions/me/pause'))
  // ... answered as the real routes answer them (danxbot plan-sessions-routes, plans/mine, the issues list)
  function reportAnswer(a: any) {
    if (a.path === '/api/plan-sessions/me/activity') return reply({ runningActivities: 1 })
    if (a.path === '/api/plan-sessions/me/pause') return reply({ pause: world.pause })
    if (a.path === '/api/plans/mine') return world.planId === null ? reply({ error: 'session_not_connected' }, 409) : reply({ id: world.planId, boards: world.planBoards })
    // as the issues list answers: the always-returned row, plus only the fields the `fields` tree names
    const rows = (world.readyRows[a.board] ?? []).map((row: any) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => ISSUE_ROW_FIELDS.includes(key) || a.query?.fields?.[key] === true)),
    )
    return reply({ issues: rows, total: rows.length })
  }
  const isContextRead = (a: any) => a.method === 'GET' && a.path.startsWith('/api/reminders/event/')
  function contextAnswer(path: string) {
    const event = /^\/api\/reminders\/event\/(.+)$/.exec(path)
    if (event) {
      const given = world.eventText[event[1]]
      if (given === undefined) return reply({ event: event[1], effective_text: EVENT_TEXT(event[1]) })
      return typeof given === 'string' ? reply({ event: event[1], effective_text: given }) : reply({ error: 'event boom' }, given.status)
    }
  }
  // ... every attempt, including the ones the MCP being down refuses
  const pacingAttempts = { n: 0 }
  // DX-4578: the pacing reads are kept out of `calls` and `api`; the plugin's server is the one every call goes to
  const pacingPath = (e: any, path: string) => e.server === 'plugin:danxbot:danx-dashboard' && e.tool === 'danxbot_api' && e.args.path === path
  on('mcp.call', async (_$: any, e: any) => {
    if (!world.bound) return unboundCall('$.mcp.call')
    // DX-5093: the Browser pane's server, as the real one answers (tabs_context: `{browserOpen, tabs: [{tabId, origin, isActive}]}`; tabs_create: `{serverId,
    // tabId, reused, type}`)
    if (e.server === 'Claude_Browser') {
      const browser = world.browser
      if (!browser.present) return { deny: `$.mcp.call: no connected MCP tool "${e.tool}" on a server named "Claude_Browser"` }
      if (browser.rejects !== undefined) return { deny: browser.rejects }
      if (browser.delayMs > 0) await clock.sleep(browser.delayMs)
      const failed = browser.errors[e.tool as 'tabs_context']
      if (e.tool === 'tabs_context') {
        browser.calls.push('tabs_context')
        if (failed !== undefined) return { value: { content: [{ type: 'text', text: failed }], isError: true } }
        // DX-5093: the real answer is ONE text block: the pretty-printed object, a newline, then a sentence (read from a live trace)
        const body = { browserOpen: browser.open, tabs: browser.open ? browser.tabs.map((origin, i) => ({ tabId: `tab-${i}`, origin, isActive: i === 0 })) : [] }
        const sentence = browser.open ? 'The Browser pane is currently hidden.' : "The Browser pane isn't open yet, so there are no tabs. Call preview_start or navigate with {\"url\": \"https://…\"} to open it."
        return { value: { content: [{ type: 'text', text: `${JSON.stringify(body, null, 2)}\n${sentence}` }], isError: false } }
      }
      if (e.tool === 'tabs_create') {
        browser.calls.push('tabs_create')
        if (failed !== undefined) return { value: { content: [{ type: 'text', text: failed }], isError: true } }
        return { value: text({ serverId: 'preview-local_x', tabId: `tab-${browser.tabs.length}`, reused: browser.reuses, type: 'browser' }) }
      }
      if (e.tool === 'navigate') {
        browser.calls.push(`navigate ${e.args.url} ${e.args.tabId ?? '-'}`)
        if (failed !== undefined) return { value: { content: [{ type: 'text', text: failed }], isError: true } }
        browser.open = true
        browser.tabs.push(new URL(e.args.url).origin)
        return { value: { content: [{ type: 'text', text: `Navigated to ${e.args.url}` }], isError: false } }
      }
      return { deny: `unknown Browser tool ${e.tool}` }
    }
    // DX-4997 / DX-5033: the dashboard's rule for the agent pause, applied to every danxbot_api call the plugin makes
    if (e.server === SERVER && e.tool === 'danxbot_api') {
      if (options.mcp === 'strictKeys' && 'background' in e.args) {
        backgroundRefusals.push(`${e.args.method} ${e.args.path}`)
        return { deny: `MCP error -32602: Input validation error: Invalid arguments for tool danxbot_api: [ { "code": "unrecognized_keys", "keys": [ "background" ], "path": [], "message": "Unrecognized key(s) in object: 'background'" } ]` }
      }
      if (e.args.background !== true) unmarked.push(`${e.args.method} ${e.args.path}`)
      serverPauseRule(e.args)
    }
    if (pacingPath(e, '/api/pacing/line')) {
      pacingAttempts.n++
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      pacingReads.push(pacingReads.length + 1)
      // the answer is fixed when the read starts: a dashboard change during the hold belongs to the next read
      const given = options.pacingLine ?? { body: { account: null, level: null, budget: null, resets_at: null, running_agents: null, reserved_agents: null, line: null, reason: 'no_usage_account' } }
      if (options.pacingHoldMs !== undefined) await clock.sleep(options.pacingHoldMs)
      return { value: 'status' in given ? reply({ error: 'line boom' }, given.status) : reply(given.body) }
    }
    // DX-5549: the agent gate closes every danxbot_api call but the proposal routes (packages/danx-dashboard-mcp agent-gate.ts); each refused call is still
    // recorded where its suite counts it
    if (e.server === SERVER && e.tool === 'danxbot_api' && world.agentGate !== null && !(e.args.method === 'POST' && e.args.path.startsWith('/api/team/agent-proposals'))) {
      if (isContextRead(e.args)) contextReads.push(e.args.path)
      else if (e.args.method === 'DELETE' && e.args.path === '/api/plan-sessions/me/agent') releaseCalls.push({ method: e.args.method, path: e.args.path, background: e.args.background })
      else calls.push({ server: e.server, tool: e.tool, args: e.args })
      // the dashboard's own refusal for a session whose agent was released: a 403 envelope, not the MCP's error result
      if (world.agentGate === 'agent_not_held') return { value: reply({ error: 'agent_not_held', state: 'agent_not_held', instruction: 'You hold no team agent: call plan_connect to claim one.' }, 403) }
      return { value: { content: [{ type: 'text', text: JSON.stringify(AGENT_GATE_HALT(world.agentGate)) }], isError: true } }
    }
    // DX-5593: the spawn claim, decided like danxbot does under its lock: refuse when the level is not on pace or the live count (the line's
    // `running_agents` plus the claims held) has reached the budget; unknown (a `reason`, no level) claims nothing. The answer is the line plus {claimed, claim_id}.
    if (e.server === 'plugin:danxbot:danx-dashboard' && e.tool === 'danxbot_api' && typeof e.args.path === 'string' && e.args.path.startsWith('/api/pacing/agents/claim')) {
      if (e.args.method === 'POST') {
        claimAttempts.n++
        claimBodies.push(e.args.body)
      }
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      if (e.args.method === 'DELETE') {
        const id = new URL(e.args.path, 'http://dashboard.local').searchParams.get('claim_id') as string
        claimsReleased.push(id)
        if (options.claimRelease !== undefined) return { value: 'status' in options.claimRelease ? reply({ error: 'release boom' }, options.claimRelease.status) : reply(options.claimRelease.body) }
        return { value: reply({ released: heldClaims.delete(id) }) }
      }
      const given = options.pacingLine ?? { body: { account: null, level: null, budget: null, resets_at: null, running_agents: null, reserved_agents: null, line: null, reason: 'no_usage_account' } }
      if (options.pacingHoldMs !== undefined) await clock.sleep(options.pacingHoldMs)
      if ('status' in given) return { value: reply({ error: 'claim boom' }, given.status) }
      const line = given.body as any
      if (line === null || typeof line !== 'object') return { value: reply(line) }
      const known = line.level !== null && line.level !== undefined
      const live = known && Number.isInteger(line.running_agents) ? line.running_agents + heldClaims.size : line.running_agents
      // DX-5595: the slots held for woken sessions (`reserved_agents`) count as taken, as danxbot's claim counts them
      const room = known && line.level === 'on_pace' && (line.budget === null || live + (line.reserved_agents ?? 0) < line.budget)
      // DX-5595: the cause danxbot's `refusalOf` names, in its order: the level, the budget against the live count, then the budget against the count plus the held slots
      const refusal = !known ? null : line.level !== 'on_pace' ? 'level' : line.budget !== null && live >= line.budget ? 'budget' : 'reserved'
      if (!room) return { value: reply({ ...line, running_agents: live, claimed: false, claim_id: null, refusal }) }
      const id = `claim-${claimsAllowed.length + 1}`
      claimsAllowed.push(id)
      heldClaims.add(id)
      return { value: reply({ ...line, running_agents: live, claimed: true, claim_id: id, refusal: null }) }
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
    // DX-5554: the release of the session's team agent at session exit, answered as the real route answers (`{released}`)
    if (e.server === SERVER && e.tool === 'danxbot_api' && e.args.method === 'DELETE' && e.args.path === '/api/plan-sessions/me/agent') {
      releaseCalls.push({ method: e.args.method, path: e.args.path, background: e.args.background })
      if (world.release.hangs) await hung.promise
      if (world.release.delayMs !== undefined) await clock.sleep(world.release.delayMs)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (world.release.deny !== undefined) return { deny: world.release.deny }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      if (world.release.status !== undefined) return { value: reply({ error: 'release boom' }, world.release.status) }
      const released = world.agent !== null
      world.agent = null
      return { value: reply({ released }) }
    }
    // DX-4234: the reads the context hooks make (is the session on a plan, the registry's event text, an earlier session's restart notice) are
    // kept out of `calls` and `api` like the pacing reads, so the suites that count a load's reads stay about their own subject
    if (e.server === SERVER && e.tool === 'danxbot_api' && isContextRead(e.args)) {
      contextReads.push(e.args.path)
      if (world.contextHangs) await hung.promise
      if (world.contextDelayMs > 0) await clock.sleep(world.contextDelayMs)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      return { value: contextAnswer(e.args.path) }
    }
    if (e.server === SERVER && e.tool === 'danxbot_api' && isReportCall(e.args)) {
      reportCalls.push({ method: e.args.method, path: e.args.path, body: e.args.body, query: e.args.query, board: e.args.board })
      sequence.push(`report ${e.args.method} ${e.args.path}`)
      const over = world.reportReplies[`${e.args.method} ${e.args.path}`]
      if (over?.delayMs !== undefined) await clock.sleep(over.delayMs)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      if (over?.deny !== undefined) return { deny: over.deny }
      if (over?.status !== undefined) return { value: reply(over.body ?? { error: 'report boom' }, over.status) }
      return { value: reportAnswer(e.args) }
    }
    calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.tool !== 'danxbot_api') sequence.push(`tool ${e.tool}`)
    if (e.server === 'plugin:danxbot:danx-dashboard') {
      // a deny reaches the plugin as a rejection that carries the reason
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "danxbot_api" on a server named "plugin:danxbot:danx-dashboard"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      const haltText = () => (world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT)
      // DX-4233: a scripted wait answer is the engine's own (a refusal it makes before the server sees the call: not connected, not bound), so it
      // comes first, whatever the key's state
      if (e.tool === 'plan_events_wait' && server.script.length > 0) return planEventsWait(e.args)
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
          return { value: text({ ok: true, status: 200, body: { session: { planId: e.args.plan_id } } }) }
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
        if (options.disconnect === 'noLeftPlan') return envelope(true, 200, { session: { sessionId: SESSION_ID, planId: null } })
        return envelope(true, 200, {
          session: { sessionId: SESSION_ID, planId: null },
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
        return { value: text({ ok: true, status: 200, body: { session: { planId: e.args.plan_id } } }) }
      }
      api.push({ method: e.args.method, path: e.args.path, body: e.args.body, query: e.args.query })
      if (options.hangFirstLoad && e.args.path === '/api/plans' && api.filter(a => a.path === '/api/plans').length === 2) {
        return hung.promise.then(() => ({ value: route(e.args.method, e.args.path, e.args.body, e.args.query) }))
      }
      // DX-5232: the plan read is one path now (load and session probe alike), so a slow dashboard slows it as it slows a context read
      if (e.args.path === '/api/plans' && world.contextDelayMs > 0) await clock.sleep(world.contextDelayMs)
      if (world.permissionClaimDelayMs > 0 && /\/claim$/.test(String(e.args.path))) await clock.sleep(world.permissionClaimDelayMs)
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
    return { deny: `no stand-in for ${e.server}` }
  })
  // what the plugin keeps in $.state (a test has no `$.state` of its own to read back)
  const flags = { viewWriteFails: false, refusedViewWrites: 0, apiHoldMs: 0 }
  const issueReads = { active: 0, max: 0 }
  let seededPending: string[] | undefined
  let seededRelay: { phase: string; planId: number | null; detail: string | null } | undefined
  // DX-4952: a step of the test that runs exactly between two steps of the plugin, once, before the next host read / write of a $.state key
  // reaches the host: the way a test makes a turn start, a plan disconnect or a long wait land at one precise point of an async function
  const beforeStateRead = new Map<string, () => Promise<void>>()
  const beforeStateWrite = new Map<string, () => Promise<void>>()
  const takeStep = async (steps: Map<string, () => Promise<void>>, key: string) => {
    const step = steps.get(key)
    if (step === undefined) return
    steps.delete(key)
    await step()
  }
  on('state.set', async (_$: any, e: any, next: any) => {
    if (beforeStateWrite.size > 0) await takeStep(beforeStateWrite, e.key)
    // a write of the plugin's view that the host refuses: the one way a refresh can throw past its own catch
    if (flags.viewWriteFails && e.key === 'view') {
      flags.refusedViewWrites++
      return { deny: 'view write refused' } as any
    }
    // DX-4721: the next write of a running turn carries these urgent notes as appended and not yet read (a note the plugin appends can never
    // succeed under `claude plugin test`, so the state it would leave is seeded)
    if (e.key === 'turn' && e.value?.isRunning === true && seededPending !== undefined) {
      e = { ...e, value: { ...e.value, pending: seededPending } }
      seededPending = undefined
    }
    // DX-4233: the next write of the relay's state is this one instead (a state left behind by a run on another plan)
    if (e.key === 'relay' && seededRelay !== undefined) {
      e = { ...e, value: seededRelay }
      seededRelay = undefined
    }
    stateWrites.push({ plugin: e.plugin, key: e.key, value: e.value })
    return next(e)
  })
  // DX-4806: a value the host already holds when the module loads (what a reload of the module finds: $.state outlives it). It is read until the
  // plugin writes the key.
  const seededState = new Map<string, unknown>()
  // the one `state.get` hook: the seeds, and the steps a test puts before a read. It is added by the first seed or by the option `stateSteps`
  // (before the test's first call), so a test that needs neither has no extra hook on its reads: an extra hook is an extra turn of the event
  // loop on every read, enough to reorder the unawaited report writes of the reports suites.
  let stateGetHooked = false
  const hookStateGet = () => {
    if (stateGetHooked) return
    stateGetHooked = true
    on('state.get', async (_$: any, e: any, next: any) => {
      if (beforeStateRead.size > 0) await takeStep(beforeStateRead, e.key)
      const read = await next(e)
      return seededState.has(e.key) && !stateWrites.some(w => w.key === e.key) ? { ...read, value: { ...read.value, value: seededState.get(e.key) } } : read
    })
  }
  if (options.stateSteps === true) hookStateGet()
  const seedState = (key: string, value: unknown) => {
    hookStateGet()
    seededState.set(key, value)
  }
  // DX-4521: the plugin's $.store (what survives the session), one fresh map per fixture
  const stored = new Map<string, unknown>()
  let storeSetFails: string | undefined
  const storeSets: string[] = []
  // DX-5577: a broken store: every store call is refused with this reason. The runner hands the plugin a fake's refusal as `<plugin>: $.store.<op>: <reason>`, never the bare
  // message the real program throws, so this kit can only stand in for store errors the plugin must NOT recover; the recovery itself is tested through hooks/store/recover.ts
  let storeBroken: string | undefined
  const storeRefusal = () => (storeBroken === undefined ? undefined : ({ deny: storeBroken } as any))
  on('store.get', (_$: any, e: any) => storeRefusal() ?? ({ value: stored.get(e.key) }) as any)
  on('store.set', (_$: any, e: any) => {
    if (storeBroken !== undefined) return storeRefusal()
    if (storeSetFails !== undefined && String(e.key).startsWith(RELAY_CURSOR_PREFIX)) return { deny: storeSetFails } as any
    storeSets.push(String(e.key))
    return (stored.set(e.key, e.value), { value: undefined }) as any
  })
  // DX-4233: a test can hold `store.keys` (the relay's first await after its first word) until it releases it
  let storeKeysHold: Promise<void> | undefined
  on('store.keys', async () => {
    await storeKeysHold
    return storeRefusal() ?? ({ value: [...stored.keys()] }) as any
  })
  on('store.delete', (_$: any, e: any) => storeRefusal() ?? (stored.delete(e.key), { value: undefined }) as any)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  // the tools the session lists: the plugin's when its server is connected
  // DX-4234: how many times the session's tool list was read (a poll for the plugin's server that outlives its deadline keeps counting)
  const toolLists = { n: 0 }
  // DX-4233: which of the plugin server's tools the session lists: all of them (default), the ones an old pinned server has (no plan_events_wait),
  // or none (the server is not connected)
  const toolListAnswer = () => {
    const tool = (name: string) => ({ name: `mcp__plugin_danxbot_danx-dashboard__${name}`, description: '', mcp: true })
    if (notConnected() || world.tools === 'none') return { value: [] } as any
    return { value: world.tools === 'old' ? [tool('danxbot_api')] : [tool('danxbot_api'), tool('plan_events_wait')] } as any
  }
  on('tool.list', () => (toolLists.n++, world.bound ? toolListAnswer() : unboundCall('$.tool.list')))
  // the engine's per-session path as the OS spells it (C:\home\u\... on Windows)
  on('fs.exists', (_$: any, e: any) => {
    if (world.fsError !== undefined) return { deny: world.fsError } as any
    const path = e.path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
    return { value: (world.localRecord && path === RECORD_PATH(world.sessionId)) || world.records.some(id => path === RECORD_PATH(id)) || path in world.files } as any
  })
  // DX-4993: the compaction control file, the window the plugin arms, and the git status of the resume briefing
  on('fs.read', (_$: any, e: any) => {
    const path = e.path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
    return (path in world.files ? { value: world.files[path] } : { deny: `ENOENT: no such file ${path}` }) as any
  })
  // a file the plugin writes lands in `world.files`
  on('fs.write', (_$: any, e: any) => {
    world.files[e.path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')] = e.text
    return { value: undefined } as any
  })
  // DX-5217: the process environment is live: a set changes what the next get answers, as in the engine (an undefined value unsets)
  const liveEnv: Record<string, string> = {
    HOME: HOME_DIR,
    ...(options.entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: options.entrypoint }),
    ...(options.accountUuid === undefined ? {} : { CLAUDE_CODE_ACCOUNT_UUID: options.accountUuid }),
    ...(options.autoCompactWindow === undefined ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: options.autoCompactWindow }),
    ...(options.autocompactPct === undefined ? {} : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: options.autocompactPct }),
  }
  const envSets: { name: string; value: string | undefined }[] = []
  // DX-5222: whether the plugin had already written `leftoverArmingCleared` true when each set in `envSets` happened (the arming order)
  const envClearedAtSet: boolean[] = []
  on('env.set', (_$: any, e: any) => {
    envSets.push({ name: e.name, value: e.value })
    envClearedAtSet.push(stateWrites.some(w => w.key === 'leftoverArmingCleared' && w.value === true))
    if (e.value === undefined) delete liveEnv[e.name]
    else liveEnv[e.name] = e.value
    return { value: undefined } as any
  })
  on('env.get', (_$: any, e: any) => ({ value: liveEnv[e.name] }) as any)
  on('session.cwd', () => ({ value: '/work/repo' }) as any)
  on('process.run', (_$: any, e: any) => ({ value: { exitCode: world.gitStatus.exitCode, stdout: world.gitStatus.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  on('session.id', () => ({ value: world.sessionId }) as any)
  // DX-5222: every `$.session.send` the plugin makes (the recipient as the engine spells it, and the text), and how the host answers it: delivered, refused or a rejection
  const sends: { to: string; text: string }[] = []
  const sendMode = { current: 'delivered' as 'delivered' | 'refused' | 'throws' }
  // a test can hold the host's answer to a send (the plugin is then in the middle of it) until it releases it
  const sendHold: { gate?: Promise<void>; entered?: () => void } = {}
  // a recipient whose sends the host drops at once, whatever the others get (DX-5222)
  const sendFails = new Set<string>()
  on('session.send', async (_$: any, e: any) => {
    sends.push({ to: e.to, text: e.text })
    if ([...sendFails].some(id => String(e.to).includes(id))) throw new Error('the host dropped the send')
    sendHold.entered?.()
    await sendHold.gate
    if (sendMode.current === 'throws') throw new Error('the host dropped the send')
    return (sendMode.current === 'refused' ? { isDelivered: false, reason: 'nobody by that name' } : { isDelivered: true }) as any
  })
  on('agent.list', async () => {
    return { value: world.agents } as any
  })
  // every `$.process.spawn` the plugin makes, as its argv: the plugin spawns no child, and a test says so by reading this
  const spawns: string[][] = []
  on('process.spawn', async function* (_$: any, e: any) {
    spawns.push([...e.argv])
    return { value: { code: 0, signal: null } }
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
  // DX-5365: the engine's version, as the plugin reads it to know the host runs `session.compact` before any event
  on('session.version', () => {
    versionReads++
    const v = options.engineVersion ?? { base: '2.1.298' }
    if (v === 'throws') return { deny: 'no version reading' } as any
    return { value: { version: v.base ?? 'custom-build', ...(v.base === undefined ? {} : { base: v.base }) } } as any
  })
  // DX-4336: what the harness knows of the account's windows
  on('session.usage', () => (options.usageReadFails === undefined ? { value: { startedAt: 0, context: world.context, rateLimits: world.rateLimits } } : { deny: options.usageReadFails }) as any)
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    if (e.timeoutMs !== undefined) toastTimeouts.push(e.timeoutMs)
    return { value: undefined }
  })
  on('ui.status', (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.run', { command: 'compact' }, (_$: any, e: any) => {
    compactRuns.push(e.args ?? null)
    if (options.compactRunFails !== undefined) throw new Error(options.compactRunFails)
    return { value: undefined } as any
  })
  on('command.register', (_$: any, e: any) => {
    commands.push(e.name)
    return { value: { isRegistered: true } } as any
  })

  const relay = {
    server,
    delivered,
    submitted,
    // the plan_events_wait calls the plugin made
    calls: server.calls,
    // events appear on the dashboard: a held wait answers at once
    // (DX-4721: every record the server answers carries a boolean `urgent`; a test that does not say is a not-urgent record)
    push: (...events: { cursor: string; text: string; urgent?: boolean }[]) => {
      server.buffer.push(...events.map(e => ({ urgent: false, ...e })))
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
    // DX-5577: every store call is refused with `reason` (see storeBroken)
    breakStore: (reason: string) => void (storeBroken = reason),
    // runs inside the next prompt submit, before it answers: a plan move at the very moment an event is delivered
    duringPrompt: (fn: () => Promise<void>) => void (deliveryFlags.duringPrompt = fn),
    dropPrompts: (reason: string) => void (deliveryFlags.submitDrops = reason),
    rejectPrompts: (reason: string) => void (deliveryFlags.submitRejects = reason),
    // DX-4793: the rows the plugin appended with $.session.append (the kit's session.append hook records them); the engine refuses the next appends
    // with this reason (the plugin shows its "Could not tell the model" toast)
    told,
    rejectAppends: (reason: string) => void (deliveryFlags.appendRejects = reason),
    // DX-5398: every prompt submitted from now on is queued behind a running turn: its submit does not settle (and the prompt is not recorded in
    // `submitted` or `delivered`) until `release()`, which is the turn ending. `held()` counts the submits still queued.
    holdPrompts: () => {
      let open!: () => void
      deliveryFlags.promptGate = new Promise<void>(resolve => (open = resolve))
      return {
        release: () => {
          deliveryFlags.promptGate = undefined
          open()
        },
        held: () => deliveryFlags.promptsHeld,
      }
    },
    acceptPrompts: () => {
      deliveryFlags.submitDrops = undefined
      deliveryFlags.submitRejects = undefined
    },
  }
  return { envSets, envClearedAtSet, sends, failSendsTo: (id: string) => void sendFails.add(id), setSendMode: (mode: 'delivered' | 'refused' | 'throws') => void (sendMode.current = mode), holdSends: () => {
      let release!: () => void
      let entered!: () => void
      sendHold.gate = new Promise<void>(r => (release = r))
      const reached = new Promise<void>(r => (entered = r))
      sendHold.entered = entered
      return { reached, release: () => release() }
    }, suspend: (ms: number) => void (asleepMs += ms), beforeNextRead: (key: string, step: () => Promise<void>) => {
      if (!stateGetHooked) throw new Error('beforeNextRead needs dashboard(on, { stateSteps: true })')
      beforeStateRead.set(key, step)
    }, beforeNextWrite: (key: string, step: () => Promise<void>) => void beforeStateWrite.set(key, step), reports: reportCalls, unmarked, backgroundRefusals, agentCall: (method: string, path: string) => { serverPauseRule({ method, path }) }, sequence, unbind: () => void (world.bound = false), bind: () => void (world.bound = true), unboundCalls, holdApi: (ms: number) => void (flags.apiHoldMs = ms), issueReads, stored, relay, seedPending: (texts: string[]) => void (seededPending = texts), seedState, seedRelay: (state: { phase: string; planId: number | null; detail: string | null }) => void (seededRelay = state), release: hung.release, ageLiveAgent: (id: string, ms: number) => void aged.set(id, ms), pacingReads, claimAttempts, claimsAllowed, claimsReleased, claimBodies, heldClaims, contextReads, restartCalls, releaseCalls, toolLists, pacingAttempts, setPacingLine: (given: { body: unknown } | { status: number } | undefined) => void (options.pacingLine = given), setEnv: (name: string, value: string) => void (liveEnv[name] = value), env: (name: string) => liveEnv[name], failUsage: (reason: string | undefined) => void (options.usageReadFails = reason), spawns, toastTimeouts, setMcp: (mode: 'up' | 'down' | 'flaky' | 'refused' | 'stale' | 'strictKeys') => void (options.mcp = mode), failInProgress: (on = true) => void (options.inProgressFails = on), failViewWrite: (on = true) => void (flags.viewWriteFails = on), setListener: (state: string | null) => void (world.listener = state), refusedViewWrites: () => flags.refusedViewWrites, stateWrites, viewClaims: () => new Set(stateWrites.filter(w => w.key === 'gate' && (w.value as any)?.inFlight === true).map(w => (w.value as any).at)).size, failList: (on = true) => void (options.listFails = on), roster, calls, api, toasts, get versionReads() { return versionReads }, statuses, commands, compactRuns, world, clock, writes: () => api.filter(a => a.method !== 'GET') }
}

// DX-4880: the prompts the plugin submitted to the session through the plan event bridge (each carries the relay marker): what wakes an
// idle session, as opposed to `relay.told`, the rows only a later turn reads
export const woken = (d: { relay: { delivered: { text: string }[] } }): string[] => d.relay.delivered.map(x => x.text)

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
// starts its pacing poll and the relay), then lets the load it kicked off finish.
export async function startSession($: any, d: Dashboard, surface: string) {
  // DX-3900: the engine's order, as a live desktop session logged it. Under the REPL the terminal is the session's first surface. The desktop
  // app hosts a session headless: session.start has surface null (and isInteractive false) with surfaces() already ['desktop'], and the app
  // detaches about 5 s later (surfaces() is [] from then); it attaches again only while the person views the session (viewSession / leaveSession).
  if (surface === 'terminal') {
    d.roster.push('terminal')
    await $.session.start({ cwd: '/work', surface, isInteractive: true })
  } else {
    d.roster.push(surface)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await leaveSession($, d, surface)
  }
  await d.clock.settle()
}

export async function viewSession($: any, d: Dashboard, surface: string) {
  d.roster.push(surface)
  await $.session.attach({ surface, clientId: `${surface}-2`, viewport: { columns: 71, rows: 44, isFullscreen: true } })
}

export async function leaveSession($: any, d: Dashboard, surface: string) {
  d.roster.splice(d.roster.indexOf(surface), 1)
  await $.session.detach({ surface, clientId: `${surface}-2`, reason: 'detach' })
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
// DX-5605: on the desktop the indicator is a Markdown link (no chip), on the terminal a plain Button; both are keyed `footer-plan`.
const FOOTER_LINK = /^\[(.*)\]\((.*)\)$/
export const footerText = async (ui: any): Promise<string | undefined> => {
  const el = await ui.find({ key: 'footer-plan' })
  const raw = el?.text?.replace(FOOTER_PAD, '')
  return el?.type === 'Markdown' ? raw?.match(FOOTER_LINK)?.[1] : raw
}
export const pressFooter = async (ui: any) => {
  const el = await ui.find({ key: 'footer-plan' })
  if (el?.type !== 'Markdown') return ui.press({ key: 'footer-plan' })
  return ui.press({ key: 'footer-plan', link: { href: el.text.match(FOOTER_LINK)[2] } })
}

// DX-5605: the team agent the model's plan_connect answer carries (PLAN-51), and the band's label read back: the plan id is the link keyed
// `open-plan`, the name the Text after it.
export const AGENT_NAME = 'Katya'
export async function bandLabelOf(ui: any): Promise<string> {
  const ref = (await linksOf(ui)).find(l => l.key === 'open-plan')?.label ?? ''
  const name = ((await ui.find({ type: 'Text', text: / · / }))?.text as string | undefined) ?? ''
  return `${ref}${name}`
}

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

// DX-4630: every link the band draws is a Markdown link `[label](url)` (no `Link` element). The one finder: each Markdown
// element's link, as {key, label, href}, the label as written in the markdown (escapes included).
export async function linksOf(ui: any): Promise<{ key: string | undefined; label: string; href: string }[]> {
  return (await ui.findAll({ type: 'Markdown' })).map((m: any) => {
    const match = /^\[(.*)\]\((.*)\)$/s.exec(m.props.text)
    if (match === null) throw new Error(`a Markdown that is not one link: ${m.props.text}`)
    return { key: m.key as string | undefined, label: match[1]!, href: match[2]! }
  })
}

// the band's open-problem count: its text, or undefined when none is drawn
export async function problemBadgeOf(ui: any): Promise<string | undefined> {
  return (await linksOf(ui)).find(l => l.key === 'open-problems')?.label
}

// DX-4630: the plugin opens no page itself: every call the fake dashboard host saw for the in-app browser's server, which stays empty
export const browserCalls = (d: { calls: { server: string }[] }) => d.calls.filter(c => c.server === 'Claude_Browser')

// The model's plan_connect as the host runs it (the engine has no implementation of its own): the dashboard connects the plan the call names,
// and the call answers. Registered before the test first uses `$`, like every hook.
export function answerPlanConnect(on: On, d: { world: { planId: number | null } }) {
  on('tool.call', { tool: toolName('plan_connect') }, (_$: any, e: any) => {
    if (typeof e.plan_id === 'number') d.world.planId = e.plan_id
    // the real answer's envelope (the server's handleConnect): the plan the session is on now
    const text = JSON.stringify({ ok: true, status: 200, body: { session: { planId: d.world.planId } } })
    return { result: {}, text, isError: false } as any
  })
}

// DX-5605: the server holds a team agent for the session (GET /api/plans answers it as `session.agent`); the view is read again so the footer shows it.
export async function holdAgent($: any, d: Dashboard) {
  d.world.agent = { id: 7, name: AGENT_NAME, avatar_url: null }
  await forceRefresh($, d)
}

// DX-4233: there is no polling timer any more, so a refresh a test used to wait 60 s of the fake clock for is asked for here: the
// `/danx-plan` command forces one, and the load is let to finish.
export async function forceRefresh($: any, d: Dashboard) {
  await $.command.run({ command: 'danx-plan' })
  await d.clock.settle()
}

// DX-4235: what the reports sent, read off the kit's `reports` list: every activity row posted, in order
export const activityRows = (d: Dashboard): any[] => d.reports.filter(r => r.path === '/api/plan-sessions/me/activity').flatMap(r => r.body.activities)
// ... and the finished ones among them
export const finishes = (d: Dashboard): any[] => activityRows(d).filter(r => r.finishedAt !== null)

// DX-4235: the engine's own answers to the events the reports ride (nothing beneath the plugins answers a classic event or a turn's end
// in a test): registered before the test first uses `$`, like every hook.
export function answerReportEvents(on: On) {
  for (const event of ['classic.SubagentStart', 'classic.SubagentStop', 'classic.Stop'] as const) on(event, () => ({}) as any)
  on('turn.complete', () => ({ text: 'done' }) as any)
}

// A drawn tree (`ui.drawn()`): every element in document order, an element's direct element children, the text one element shows (its
// string children) and the texts of every Text beneath a node.
