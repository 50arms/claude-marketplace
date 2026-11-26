import type { ConnectedPlan, InProgressRow, ListenerStatus, PlanView, StatusBreakdown } from '../../types'
import { CARD_PROGRESS_FIELDS, EMPTY, ERROR_BODY_MAX, IN_PROGRESS_QUERY, NEEDS_YOU_BUCKET_ID, STATUS_KEYS } from './config'
import { agentBlockOf, isSignedOut, outcomeRevokedBy, type AgentBlock } from './mcp'
import { readSessionHolds } from './agent'
import type { Refusal } from '../relay/refusal'
import { PAUSE_PATH, pauseOf } from '../reports/pause'
import { serverLoopOf, type ServerLoop } from '../ready/loop'

// `$` cannot be passed across an import (`claude plugin validate`), so everything here is pure:
// the dashboard call arrives as `call`, built from `$.mcp.call` in register.tsx.
// `refusal`: the call was refused by auto mode's classifier (its words and the fix); `body.error` carries both.
// `sentence`: `body.error` is already one whole sentence for a person (a classifier refusal; an MCP older than the plugin)
export type Api = { ok: boolean; status: number; body: any; unreachable?: boolean; refusal?: Refusal; sentence?: true; replyFile?: string; replySha256?: string }
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
  // the calling session's own route: its `session`, the `dashboard_url` and the `sessionListenerAttached`, read from that session's rows alone (never a plan list)
  const list = await call('GET', '/api/plan-sessions/me')
  // only the plugin's own server not being connected reads as unreachable (the band says Disconnected and offers Sign in); any other failed read is a failed load
  if (!list.ok) return { ...EMPTY, phase: list.unreachable === true ? 'unreachable' : 'load-failed', error: errText(list) }

  // the origin every link is built on. Without it no link can be right, so the load is an error.
  const dashboardUrl = readOrigin(list.body.dashboard_url)
  if (dashboardUrl === null) {
    return { ...EMPTY, phase: 'load-failed', error: 'GET /api/plan-sessions/me answered no valid dashboard_url (an http(s) origin): cannot build plan links' }
  }
  // The session in this same response says WHICH plan; the plan itself is read by id below.
  const session = list.body.session
  const connectedId: number | null = session?.plan_id ?? null
  // an absent or null status is the "no status" line; a present one that is not {state: string,
  // nextStep: string | null} cannot be read, so the load fails (never nulled to the no-status line).
  const listener = readListener(list.body.sessionListenerAttached)
  if (listener === MALFORMED_LISTENER) {
    return { ...EMPTY, phase: 'load-failed', error: 'GET /api/plan-sessions/me answered a sessionListenerAttached that is not {state: string, nextStep: string | null}: cannot show the event status' }
  }
  // the agent the session signs in as and the card it holds, from the same session row
  const holds = readSessionHolds(session)
  if ('error' in holds) return { ...EMPTY, phase: 'load-failed', error: holds.error }
  // a session on nothing has no pause to show; one on a plan or a card reads it with the load
  const onNothing = connectedId === null && holds.card === null
  const pause = onNothing ? null : await readPause(call, Date.parse(refreshedAt))
  const paused = pause !== null
  const pausedWaitsOn = pause?.waitsOn ?? null
  // the repo a new process takes the ready loop up for: the mark's, or the dashboard loop's, since a session on a job holds no mark. A loop it cannot read is no part of the band: it is
  // carried as `readyLoopFault` for the loop's own reader to tell, so a fault there never turns the band of a session that was never in a loop into an error
  let serverLoop: ServerLoop | null = null
  let readyLoopFault: string | null = null
  try {
    serverLoop = serverLoopOf(list.body, 'GET /api/plan-sessions/me')
  } catch (err: any) {
    readyLoopFault = String(err?.message ?? err)
  }
  const readyRepo = typeof session?.ready?.repo === 'string' ? session.ready.repo : (serverLoop?.repo ?? null)
  const noPlan = { dashboardUrl, connected: null, listener, paused, pausedWaitsOn, readyRepo, readyLoopFault, ...holds }
  if (connectedId === null) {
    if (holds.card === null) return { ...EMPTY, ...noPlan, phase: 'ready', error: null, refreshedAt }
    // a held card shows its acceptance-criteria progress as the donut; a card read that fails is the load's error, as a plan read's is
    const cardR = await call('GET', `/api/issues/${holds.card.id}`, { query: { fields: CARD_PROGRESS_FIELDS } })
    if (!cardR.ok) return { ...EMPTY, ...noPlan, phase: 'load-failed', error: errText(cardR) }
    const percent = readAcPercent(cardR.body, `GET /api/issues/${holds.card.id}`)
    if (typeof percent === 'string') return { ...EMPTY, ...noPlan, phase: 'load-failed', error: percent }
    return { ...EMPTY, ...noPlan, cardPercent: percent, phase: 'ready', error: null, refreshedAt }
  }

  // One load of everything about the connected plan: the plan itself (its status counts and bucket counts),
  // and the in-progress cards, together.
  const [planR, inProg] = await Promise.all([
    // the status breakdown and the bucket counts are always on the plan read, whatever the plan's boards or size
    call('GET', `/api/plans/${connectedId}`),
    // the In Progress cards as the issues list's compact row (id, title, status, ...: about 0.5 KB each), never the plan's card-list rows (about 4.6 KB each: 14 cards went over the host's tool-result limit)
    call('GET', '/api/issues', { query: IN_PROGRESS_QUERY(connectedId) }),
  ])
  const fail = (error: string): PlanView => ({ ...EMPTY, ...noPlan, phase: 'load-failed', error })
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
  const base = { dashboardUrl, connected, listener, paused, pausedWaitsOn, readyRepo, readyLoopFault, ...holds, statusBreakdown: breakdown }

  // The in-progress bucket: its list is only as complete as the total says, so an answer without a numeric total is an error.
  if (!inProg.ok) return { ...EMPTY, ...base, phase: 'load-failed', error: errText(inProg) }
  if (typeof inProg.body.total !== 'number') {
    return { ...EMPTY, ...base, phase: 'load-failed', error: `GET /api/issues (In Progress cards of PLAN-${connectedId}) answered no total: cannot tell whether the list is complete` }
  }
  const ipRows: any[] = inProg.body.issues ?? []
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

// What the agent's pause waits on, or null when it is not paused. The plugin's call carries `background: true` (register.tsx `api`), so this GET never ends the pause it reads.
// An unexpired or untimed agent pause is the only one that counts (pauseOf); a failed or malformed answer is no mark, never a failed load, since the mark is display only.
async function readPause(call: Call, now: number): Promise<{ waitsOn: string | null } | null> {
  const r = await call('GET', PAUSE_PATH)
  if (!r.ok) return null
  const read = pauseOf(r.body, now)
  return read.kind === 'paused' ? { waitsOn: read.waitsOn } : null
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

// The percent of a card's acceptance criteria that pass (rounded), null for a card with none, or the reason the answer cannot be read.
function readAcPercent(card: any, route: string): number | null | string {
  const total = card?.ac_total
  const done = card?.ac_done
  const count = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0
  if (!count(total) || !count(done) || done > total) return `${route} answered no acceptance-criteria counts: cannot show the card's progress`
  if (total === 0) return null
  return Math.round((done / total) * 100)
}
