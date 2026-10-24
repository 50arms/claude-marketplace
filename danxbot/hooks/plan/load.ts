import type { CardLinks, ConnectedPlan, InProgressRow, ListenerStatus, PlanView, StatusBreakdown } from '../../types'
import { EMPTY, ERROR_BODY_MAX, IN_PROGRESS_LIMIT, NEEDS_YOU_BUCKET_ID, PLAN_BAND_FIELDS, PREFIX_PATTERN, SESSION_PLAN_PROBE, STATUS_KEYS } from './config'
import { agentBlockOf, isSignedOut, outcomeRevokedBy, type AgentBlock } from './mcp'
import { readSessionHolds } from './agent'
import type { Refusal } from '../relay/refusal'
import { PAUSE_PATH, pauseOf } from '../reports/pause'

// `$` cannot be passed across an import (`claude plugin validate`), so everything here is pure:
// the dashboard call arrives as `call`, built from `$.mcp.call` in register.tsx.
// `refusal`: the call was refused by auto mode's classifier (its words and the fix); `body.error` carries both.
// `sentence`: `body.error` is already one whole sentence for a person (a classifier refusal; an MCP older than the plugin)
export type Api = { ok: boolean; status: number; body: any; unreachable?: boolean; refusal?: Refusal; sentence?: true }
export type Call = (method: string, path: string, extra?: { query?: object; body?: object }) => Promise<Api>

// the host's notice for a result over its size limit (written for the model, never shown to a person).
const OVERSIZE = /exceeds maximum allowed tokens/
export function isOversize(r: Api): boolean {
  return OVERSIZE.test(String(r.body?.error ?? r.body?.message ?? ''))
}

// one short line for a person about a call that did not work: never the host's or the server's own text.
export function failureReason(r: Api): string {
  if (isOversize(r)) return 'the dashboard answer was too large'
  return r.status > 0 ? `the dashboard answered ${r.status}` : 'the dashboard did not answer'
}

export function errText(r: Api): string {
  if (isOversize(r)) return failureReason(r)
  const b = r.body ?? {}
  // a body that is already the person's sentence gets no `mcp:` prefix before it
  if (r.sentence === true && typeof b.error === 'string') return b.error
  return `${r.status || 'mcp'}: ${b.message ?? b.error ?? JSON.stringify(b).slice(0, ERROR_BODY_MAX)}`
}

// control flow only: thrown by `guarded` below, caught by loadPlan, never seen outside it
class SignedOut extends Error {}
// auto mode's classifier refused the plugin's own call (`Api.refusal`)
class ClassifierBlocked extends Error {}
// the MCP's agent gate answered for the call (the session holds no team agent yet)
class AgentBlocked extends Error {
  constructor(readonly state: AgentBlock) {
    super(state)
  }
}
class KeyRevoked extends Error {
  constructor(readonly by: string) {
    super(by)
  }
}

// The whole load. A signed-out answer to ANY of its calls (the key can be dropped between two of them) ends it as the
// `signed-out` view, a classifier refusal as the `blocked` view, and a key a person revoked as the `key-revoked` view, never as a generic error carrying the
// server's text. `resumePlan` is the caller's to fill.
export async function loadPlan(call: Call, refreshedAt: string): Promise<PlanView> {
  const guarded: Call = async (method, path, extra) => {
    const r = await call(method, path, extra)
    // revoked first: a revoked key's halt is a different text from the signed-out one, but the order says which wins
    if (r.refusal !== undefined) throw new ClassifierBlocked()
    const by = outcomeRevokedBy(r)
    if (by !== null) throw new KeyRevoked(by)
    if (isSignedOut(r)) throw new SignedOut()
    const blocked = agentBlockOf(r)
    if (blocked !== null) throw new AgentBlocked(blocked)
    return r
  }
  try {
    return await readPlan(guarded, refreshedAt)
  } catch (err) {
    if (err instanceof KeyRevoked) return { ...EMPTY, phase: 'key-revoked', revokedBy: err.by, refreshedAt }
    if (err instanceof ClassifierBlocked) return { ...EMPTY, phase: 'blocked', refreshedAt }
    if (err instanceof SignedOut) return { ...EMPTY, phase: 'signed-out', refreshedAt }
    // signed in, on no plan and no card, waiting for an agent: a ready view, so the relay runs (the session's wake comes through it)
    if (err instanceof AgentBlocked) return { ...EMPTY, phase: 'ready', agentBlock: err.state, refreshedAt }
    throw err
  }
}

async function readPlan(call: Call, refreshedAt: string): Promise<PlanView> {
  // only the answer's `dashboard_url`, `session` and `sessionListenerAttached` are read; one row is asked for (never the whole list)
  const list = await call('GET', '/api/plans', { query: SESSION_PLAN_PROBE })
  if (!list.ok) return { ...EMPTY, phase: 'error', error: errText(list), serverNotConnected: list.unreachable === true }

  // the origin every link is built on. Without it no link can be right, so the load is an error.
  const dashboardUrl = readOrigin(list.body.dashboard_url)
  if (dashboardUrl === null) {
    return { ...EMPTY, phase: 'error', error: 'GET /api/plans answered no valid dashboard_url (an http(s) origin): cannot build plan links' }
  }
  // The session in this same response says WHICH plan; the plan itself is read by id below.
  const session = list.body.session
  const connectedId: number | null = session?.plan_id ?? null
  // an absent or null status is the "no status" line; a present one that is not {state: string,
  // nextStep: string | null} cannot be read, so the load fails (never nulled to the no-status line).
  const listener = readListener(list.body.sessionListenerAttached)
  if (listener === MALFORMED_LISTENER) {
    return { ...EMPTY, phase: 'error', error: 'GET /api/plans answered a sessionListenerAttached that is not {state: string, nextStep: string | null}: cannot show the event status' }
  }
  // the agent the session signs in as and the card it holds, from the same session row
  const holds = readSessionHolds(session)
  if ('error' in holds) return { ...EMPTY, phase: 'error', error: holds.error }
  // a session on nothing has no pause to show; one on a plan or a card reads it with the load
  const onNothing = connectedId === null && holds.card === null
  const pausedUntil = onNothing ? null : await readPausedUntil(call, Date.parse(refreshedAt))
  const noPlan = { dashboardUrl, connected: null, listener, pausedUntil, ...holds }
  if (connectedId === null) return { ...EMPTY, ...noPlan, phase: 'ready', error: null, refreshedAt }

  // One load of everything about the connected plan: the plan itself (its status counts, bucket counts and card ids),
  // the in-progress cards and the boards, together.
  const [planR, inProg, boards] = await Promise.all([
    // the plan's every card id and its bucket counts come on this read (`PLAN_BAND_FIELDS`), whatever the plan's boards or size
    call('GET', `/api/plans/${connectedId}`, { query: { fields: PLAN_BAND_FIELDS } }),
    call('GET', `/api/plans/${connectedId}/cards`, { query: { bucket: 'in-progress', sort: 'priority', order: 'desc', limit: IN_PROGRESS_LIMIT } }),
    // the board prefixes, for the card links in assistant replies (GET /api/boards, boards.view: every
    // non-archived board of the caller's team, each with `issue_prefix`). Read here, never at draw time.
    call('GET', '/api/boards'),
  ])
  const fail = (error: string): PlanView => ({ ...EMPTY, ...noPlan, phase: 'error', error })
  if (!planR.ok) return fail(errText(planR))
  const breakdown = readBreakdown(planR.body?.status_breakdown)
  if (breakdown === null) {
    return fail(`GET /api/plans/${connectedId} answered no valid status_breakdown (all six statuses as numbers): cannot show progress`)
  }
  const connected: ConnectedPlan = {
    id: connectedId,
    ref: `PLAN-${connectedId}`,
    name: session.plan_name ?? '',
    dashboardUrl,
  }
  const base = { dashboardUrl, connected, listener, pausedUntil, ...holds, statusBreakdown: breakdown, links: readLinks(boards, planR.body.card_ids, `GET /api/plans/${connectedId}`) }

  // The in-progress bucket: its list is only as complete as the total says, so an answer without a numeric total is an error.
  if (!inProg.ok) return { ...EMPTY, ...base, phase: 'error', error: errText(inProg) }
  if (typeof inProg.body.total !== 'number') {
    return { ...EMPTY, ...base, phase: 'error', error: `GET /api/plans/${connectedId}/cards (in-progress) answered no total: cannot tell whether the list is complete` }
  }
  const ipRows: any[] = inProg.body.cards ?? []
  const inProgress: InProgressRow[] = ipRows.map(row => ({ id: row.id, title: row.title }))
  // the cards waiting on a person are the plan's `bucket_counts["needs-you"]`, the number its Needs You tab shows. An answer without it leaves the view
  // ready (the plan itself was read) with the count unknown (null, never a guessed 0) and the reason in `needsYouError`.
  const counted = planR.body.bucket_counts?.[NEEDS_YOU_BUCKET_ID]
  return {
    ...EMPTY,
    ...base,
    phase: 'ready',
    error: null,
    needsYou: typeof counted === 'number' ? counted : null,
    needsYouError: typeof counted === 'number' ? null : `GET /api/plans/${connectedId} answered no bucket_counts["${NEEDS_YOU_BUCKET_ID}"]: cannot count the cards that need you`,
    inProgress,
    refreshedAt,
  }
}

// When the agent's pause ends, or null. The plugin's call carries `background: true` (register.tsx `api`), so this GET never ends the pause it reads.
// An unexpired agent pause is the only one that counts (pauseOf); a failed or malformed answer is no mark, never a failed load, since the mark is display only.
async function readPausedUntil(call: Call, now: number): Promise<number | null> {
  const r = await call('GET', PAUSE_PATH)
  if (!r.ok) return null
  const read = pauseOf(r.body, now)
  return read.kind === 'paused' ? read.until : null
}

// the link data, or the one reason it could not be read. A failure here is the links' own state: the plan view stays
// `ready` (the plan itself was read), the view says why replies are not linked, and replies are drawn as written.
function readLinks(boards: Api, cardIds: unknown, route: string): CardLinks {
  const error = (message: string): CardLinks => ({ state: 'error', message })
  if (!boards.ok) return error(`GET /api/boards ${errText(boards)}`)
  const list = boards.body?.boards
  if (!Array.isArray(list) || list.length === 0) return error('GET /api/boards answered no list of boards')
  const prefixes: unknown[] = list.map(b => b?.issue_prefix)
  if (!prefixes.every((p): p is string => typeof p === 'string' && PREFIX_PATTERN.test(p))) {
    return error('GET /api/boards answered a board with no issue_prefix of capital letters')
  }
  if (!Array.isArray(cardIds) || !cardIds.every((id): id is string => typeof id === 'string')) {
    return error(`${route} answered no list of card ids: cannot tell which ids are the plan's`)
  }
  return { state: 'ready', prefixes: [...new Set(prefixes as string[])], planCardIds: cardIds }
}

// The origin of an http(s) URL string, or null: a trailing slash or path is dropped, a non-URL is refused.
export function readOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

// All six statuses as numbers, or null: a missing count is an error state, never a guessed 0%.
function readBreakdown(raw: any): StatusBreakdown | null {
  if (raw === null || typeof raw !== 'object') return null
  for (const key of STATUS_KEYS) if (typeof raw[key] !== 'number') return null
  return { 'In Progress': raw['In Progress'], ToDo: raw.ToDo, Backlog: raw.Backlog, Review: raw.Review, Done: raw.Done, Cancelled: raw.Cancelled }
}

// the event listener's state and next step; null when the answer carries none (the server answers null for
// a session on no plan); MALFORMED_LISTENER when one is present but not the server's shape.
const MALFORMED_LISTENER = Symbol('malformed sessionListenerAttached')
function readListener(raw: any): ListenerStatus | null | typeof MALFORMED_LISTENER {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || typeof raw.state !== 'string') return MALFORMED_LISTENER
  if (raw.nextStep !== null && typeof raw.nextStep !== 'string') return MALFORMED_LISTENER
  return { state: raw.state, nextStep: raw.nextStep }
}
