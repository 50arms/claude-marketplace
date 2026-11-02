import type { ReadyJob, ReadyLoop } from '../../types'
import { heldForInput } from '../relay/text'

// A session a person opened waits in its team's list of ready agents, is handed work, and after that work clears and rejoins
// the back of the list by itself. Pure: register.tsx does the reads, the writes and the commands. The list itself is the dashboard's (`PUT /api/plan-sessions/me/ready`).
// The dashboard also keeps the session's READY LOOP (the job it took, and whether that job has ended) and decides when it clears, by a handshake: 50 Arms asks, the session wraps up
// and says ready, and 50 Arms releases the clear. Nothing clears on a timer, so a person still talking keeps the session. The plugin runs the `/clear` it released and rejoins; it holds no
// rule of its own for when a job has ended.

export const READY_COMMAND = '50arms-ready'
export const READY_DESCRIPTION = `Wait on the team's ready list for this folder's repo, and rejoin it after each job (\`/${READY_COMMAND} off\` leaves it)`
export const READY_PATH = '/api/plan-sessions/me/ready'
// how often a session in the loop looks again. A session's mark can be lost while it runs (a team-mate's claim clears a lapsed session's agent, and the mark goes with it), so a
// waiting session reads its row each minute and writes the mark only when it is gone: every write tells every open tab of the team. The same look finds a released clear.
export const READY_TICK_MS = 60_000
// the permission the list of the team's repos needs, which a session key does not start with; asked for only when the repo's name is not one `danxbot:start` would have given it
export const REPOS_PERMISSION = 'boards.view'
export const READY_REPOS_PAGE = 50
export const REPOS_PERMISSION_REASON = "Joining the ready list needs to look up this folder's repo among the team's repos."

export const READY_JOINING = 'Joining the ready list. This session waits there for work and rejoins after each job.'
export const READY_OFF = `This session left the ready list. Run /${READY_COMMAND} to rejoin.`
export const READY_USAGE = `Run /${READY_COMMAND} to join the ready list, or /${READY_COMMAND} off to leave it.`
export const READY_STOPPED = `You stopped this session, so it left the ready list. Run /${READY_COMMAND} to rejoin.`
export const READY_NO_ORIGIN = 'Could not join the ready list: this folder has no git origin, so 50 Arms cannot tell which repo it is.'
export const READY_NOT_GITHUB = "Could not join the ready list: 50 Arms connects github.com repos only, and this folder's origin is elsewhere."
export const READY_NOT_REGISTERED = "Could not join the ready list: this folder's repo is not connected to 50 Arms. Run /danxbot:start first."
export const READY_DISCONNECTED = `You disconnected this session, so it left the ready list and kept its conversation. Run /${READY_COMMAND} to rejoin.`
export const READY_SIGN_IN_ENDED = `This session left the ready list: it could not sign in. Run /${READY_COMMAND} to try again.`
export const READY_PERMISSION_ENDED = `This session left the ready list: the permission to look up this folder's repo was not granted. Run /${READY_COMMAND} to ask again.`
export const READY_SHELL_HOLDS_RESET = 'Ready list: the job is over, and this session clears and rejoins when its background task has ended.'
export const readyPermissionRefused = (why: string) => `This session left the ready list: it could not ask for the permission to look up this folder's repo (${why}). Run /${READY_COMMAND} to try again.`
export const readyMarkRefused = (why: string) => `This session left the ready list: the dashboard refused to mark it ready (${why}). Run /${READY_COMMAND} to try again.`
// a sign-in that found no team agent free: its own words, and how to try again
export const readyNoAgentYet = (message: string) => `${message} Then run /${READY_COMMAND}.`
export const READY_NO_AGENT_AGAIN = `No team agent is free for this session. Run /${READY_COMMAND} when one is.`
const jobName = (job: ReadyJob): string => (job.kind === 'card' ? job.id : `plan ${job.id}`)
export const readyWorkTaken = (job: ReadyJob) =>
  `This session no longer holds ${jobName(job)}, and that work has not finished, so it left the ready list and kept its conversation. Run /${READY_COMMAND} to rejoin.`
export const readyJoinedOnWork = (repo: string, job: ReadyJob) => `This session is in the ready loop for ${repo}: once ${jobName(job)} has ended, it clears and joins the list.`
// an MCP server older than the plugin never writes the clear file, so 50 Arms' ask to clear never reaches the model and nothing is released: what is off, why, and the fix
export const READY_RELAY_OLDER =
  "Ready list: this session's 50 Arms MCP server is older than the plugin, so 50 Arms cannot ask it to clear after a job, and it stays on a finished job instead of rejoining the list. Reconnect the 50 Arms MCP server (/mcp) or start a new session to fix it."
// a restarted process that cannot read the dashboard's ready loop cannot tell whether it was in one, so it takes none up and says why
export const readyLoopUnread = (why: string) => `Ready list: this session's ready loop could not be read (${why}), so a loop it was in is not taken back up. Run /${READY_COMMAND} to rejoin.`
export const readyAgentChanged = (name: string) => `Your team agent lapsed and this session signed in again as ${name}. Sign as ${name} from now on, and carry on with your work.`
export const readyAdopted = (repo: string) => `This session is still in the ready loop for ${repo}, and rejoins the list after each job. /${READY_COMMAND} off leaves it.`
export const readyRevoked = (by: string) => `This session left the ready list: ${by} revoked its access.`
export const readyJoined = (repo: string) => `Waiting on the ready list for ${repo}.`
export const readyRejoined = (repo: string) => `Job finished: this session cleared and is back on the ready list for ${repo}.`
export const readyFailed = (what: string, why: string) => `Ready list: ${what} failed (${why}). It tries again in a minute.`

export const joiningLoop = (): ReadyLoop => ({ phase: 'joining', repo: null, rejoining: false, signInAsked: false, permissionId: null, told: null, agentName: null, claimAsked: true })

// The words a refused command carries when a person's Stop refused it: `remote-cancel` for a command the Stop interrupted, and Claude Code's hold for one issued after it.
export const stoppedByPerson = (failure: string): boolean => /remote-cancel/i.test(failure) || heldForInput(failure)

export type GithubOrigin = { owner: string; repo: string }

// the forms `danxbot:start` accepts: https, scp-like (with an SSH config alias `github.com-<alias>` too) and ssh://, each with or without `.git`
const ORIGIN_FORMS = [/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/, /^git@github\.com(?:-[^:]+)?:([^/]+)\/([^/]+?)(?:\.git)?$/, /^ssh:\/\/git@github\.com(?:-[^/]+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/]

export function parseGithubOrigin(url: string): GithubOrigin | null {
  const trimmed = url.trim()
  for (const form of ORIGIN_FORMS) {
    const m = form.exec(trimmed)
    if (m !== null) return { owner: m[1], repo: m[2] }
  }
  return null
}

// A repo row names the folder's repo when its remote is the origin. A remote's letter case is not its identity.
export function remoteIs(row: any, origin: GithubOrigin): boolean {
  const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
  return same(row?.github_remote?.owner, origin.owner) && same(row?.github_remote?.repo, origin.repo)
}

// The names `danxbot:start` gives a repo, in the order it tries them: the repo's own, then the owner's and the repo's joined. Reading one of these by name needs no second approval, and its remote says whether it is this repo.
export function repoNameCandidates(origin: GithubOrigin): string[] {
  const name = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_]+/, '').slice(0, 64)
  return [...new Set([name(origin.repo), name(`${origin.owner}-${origin.repo}`)])].filter(n => n !== '')
}

// The team's registered name of the folder's repo in one page of `GET /api/repos` with `github_remote`, or null when the page does not hold it.
export function repoNameFor(rows: unknown, origin: GithubOrigin): string | null {
  if (!Array.isArray(rows)) throw new Error('bad_response: GET /api/repos answered no repos list')
  const row = rows.find(r => remoteIs(r, origin))
  return typeof row?.name === 'string' ? row.name : null
}

// The session's own dashboard id, as its row names it: the id the MCP signed the session in under, which names its clear file. It is not `$.session.id()`, which a /clear changes while the MCP keeps its id.
export function sessionIdOf(session: any): string {
  if (typeof session?.session_id !== 'string' || session.session_id === '') throw new Error('bad_response: GET /api/plan-sessions/me answered a session with no session_id')
  return session.session_id
}

// Whether the row holds a plan or a card. A row it cannot read is a failure, never "no work".
export function holdsWork(session: any): boolean {
  if (typeof session?.plan_id === 'number' || typeof session?.card_id === 'string') return true
  if (session?.plan_id === null && session?.card_id === null) return false
  throw new Error('bad_response: GET /api/plan-sessions/me answered a session whose plan_id and card_id cannot be read')
}

// The session's ready loop as the dashboard keeps it: the repo it rejoins, the job it took (null between jobs), and whether that job has ended, by the dashboard's one rule for that
// (a card Done or Cancelled, a plan whose work is finished, or work the session left). null: the session is in no loop on the server (one only marked ready, that never took a job, included).
// `releaseId`: the clear release 50 Arms stands behind right now, set only while the job has ended and an agreement answers its current ending; the clear file may name an older one.
export type ServerLoop = { repo: string; job: ReadyJob | null; ended: boolean; releaseId: string | null }

// The `ready_loop` of an answer of `route` (`GET /api/plan-sessions/me`, or the mark's `PUT`). Anything else is a failure, never "no loop": no loop is what lets a look mark the session, and a
// missed job would carry its conversation into the next.
export function serverLoopOf(body: any, route: string): ServerLoop | null {
  const loop = body?.ready_loop
  if (loop === null) return null
  const bad = (why: string) => new Error(`bad_response: ${route} answered a ready_loop ${why}`)
  if (typeof loop !== 'object' || loop === undefined) throw bad('that is not an object or null')
  if (typeof loop.repo !== 'string' || typeof loop.ended !== 'boolean') throw bad('with no repo or no ended')
  if (loop.release_id !== null && (typeof loop.release_id !== 'string' || loop.release_id === '')) throw bad('with no release_id')
  const releaseId: string | null = loop.release_id
  const job = loop.job
  if (job === null) return { repo: loop.repo, job: null, ended: loop.ended, releaseId }
  if (job?.kind === 'card' && typeof job.id === 'string') return { repo: loop.repo, job: { kind: 'card', id: job.id }, ended: loop.ended, releaseId }
  if (job?.kind === 'plan' && typeof job.id === 'number') return { repo: loop.repo, job: { kind: 'plan', id: job.id }, ended: loop.ended, releaseId }
  throw bad('whose job is not a card or a plan')
}

// What `PUT /api/plan-sessions/me/ready` did: marked the session ready (`ready: true`), or, for a session that holds a plan or a card, joined the ready loop with that work as its job and
// marked nothing (`ready: null`, the loop it joined in `ready_loop`). Anything else is a failure, never a mark: a session told it waits on the list while it is on work would never clear.
export type MarkAnswer = { kind: 'marked' } | { kind: 'joined'; job: ReadyJob }
export function markAnswerOf(body: any): MarkAnswer {
  const route = `PUT ${READY_PATH}`
  if (body?.ready === true) return { kind: 'marked' }
  if (body?.ready !== null) throw new Error(`bad_response: ${route} answered a ready that is neither true nor null`)
  const loop = serverLoopOf(body, route)
  if (loop === null || loop.job === null) throw new Error(`bad_response: ${route} answered ready null with no ready_loop job`)
  return { kind: 'joined', job: loop.job }
}

// The release 50 Arms agreed to in the clear file's text (null: no file, or no clear released). The file is `{v: 1, sessionId, control: {releaseId} | null, askedAt}`; `askedAt` is the MCP's own memory of
// the last ask it showed, and says nothing to the plugin. A file written for another session, or one the MCP would not write, is refused: a release read wrong wipes a conversation.
export function releaseOfClearFile(text: string | null, sessionId: string): string | null {
  if (text === null) return null
  const bad = (why: string) => new Error(`the clear file ${why}`)
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw bad('is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1 || typeof parsed.sessionId !== 'string' || !('control' in parsed)) throw bad('is not one the MCP writes')
  if (parsed.sessionId !== sessionId) throw bad(`was written for another session (${parsed.sessionId})`)
  const control = parsed.control
  if (control === null) return null
  if (typeof control !== 'object' || typeof control.releaseId !== 'string' || control.releaseId === '') throw bad('has a control that is not null or {releaseId}')
  return control.releaseId
}

// The clears the plugin has run, one record per session's dashboard id in $.store, so a release is run once however many looks and process restarts follow it.
export const CLEAR_SPENT_PREFIX = 'clear-spent-release:'
export const clearSpentKey = (sessionId: string): string => `${CLEAR_SPENT_PREFIX}${sessionId}`
