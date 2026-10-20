import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit } from 'claude-code'

import type { CompactingState, ConnectedPlan, PacingSnapshot, PendingEvent, PlanView, PendingStart, PermissionRequest, RefreshGate, RelayState, ReportState, StampState, TurnState } from '../types'
import { CONTEXT_DEADLINE_MS, DEADLINE_REASON, SERVER_NOT_CONNECTED_REASON, eventFailureLine, eventPath, eventText, restartAsk, restartFailureLine, restartNoticeText, RESTART_NOTICE_TOOL, sessionEvent } from './context/events'
import type { DanxEvent, RestartAsk, Told } from './context/events'
import { stamp as nextStamp } from './context/stamp'
import { COMPACTING_NOTE_TTL_MS, RESUME_OPENING, RESUME_PROCEDURE, briefingText, parseGitStatus, subagentBriefingText } from './compaction/briefing'
import type { BriefingAgent, BriefingCard, GitState, Source } from './compaction/briefing'
import { AGENT_SIZES_KEEP, ASK_SENT_PREFIX, ENGINE_VERSION_NOTICE, HELD_REASON, RELAY_OLDER_NOTICE, USED_RELEASE_PREFIX, agentVerdict, armedPercentOf, askSentKey, controlPath, parseControlFile, readyRelease, runsSessionCompact, sentAskAt, sizeOfUsage, spentReleaseId, staleSessionKeys, underHandshake, usedReleaseKey, verdict } from './compaction/control'
import type { AgentSize, AgentVerdict, ControlFile, Verdict } from './compaction/control'
import { approvalRequestOf, permissionShownNote, permissionToast, signInShownNote, signInToast } from './plan/approval'
import type { ApprovalRequest } from './plan/approval'
import { renderBand } from './plan/band'
import { asApproval, claimPath, permissionRequestOf, publicIdOf, settle } from './plan/permission'
import { linkCardIds } from './plan/card-links'
import { settleDetached } from './plan/detached'
import { renderFooter } from './plan/footer'
import type { Handlers } from './plan/handlers'
import { eventsReason, eventsWarning, footerLabel } from './plan/words'
import {
  APPROVAL_TOAST_MS,
  CALL_ERROR_MAX,
  COMMAND,
  FAILURE_TOAST_MAX,
  EMPTY,
  LOAD_DEADLINE_MS,
  LOAD_ORPHAN_WAIT_MS,
  LOCK_STALE_MS,
  MIN_GAP_MS,
  PERMISSION_POLL_MS,
  PERMISSION_TOLD_MAX,
  PACING_POLL_MS,
  SIGNED_IN_TOAST,
  keyRevokedLabel,
  SIGN_IN_DENIED_TOAST,
  SIGN_IN_EXPIRED_TOAST,
  SIGN_IN_MIN_ROUND_MS,
  MIN_USAGE_TICK_MS,
  USAGE_PATH,
  USAGE_TICK_MS,
  signInFailedToast,
  BLOCKED_LINE,
  SERVER,
  NOT_CONNECTED_RETRY_MS,
  SERVER_POLL_MS,
  toolName,
  NOTE_MARKER,
  TOAST_ERROR_MAX,
  planUrl,
  busyKey,
  SESSION_PLAN_PROBE,
} from './plan/config'
import { errText, loadPlan } from './plan/load'
import { blockedOrigin, optionDashboardUrl } from './plan/origin'
import type { Api } from './plan/load'
import { connectedPlanOf, isServerNotConnected, isSignedOut, outcomeRevokedBy, refusalText, textOutcome, toolOutcome } from './plan/mcp'
import type { ToolOutcome } from './plan/mcp'
import { disconnectNote, signInApprovedNote, signInDeniedNote, signInExpiredNote, signInNote } from './plan/notes'
import { signInStep } from './plan/sign-in'
import { classifyText, readWaitAnswer, waitArgs } from './relay/answer'
import type { RelayEvent, WaitAnswer } from './relay/answer'
import { CURSOR_PREFIX, MIN_ROUND_MS, OLD_SERVER_AFTER_FAILURES, OLD_SERVER_AFTER_MS, RELAY_OFF, RELAY_READ_DEADLINE_MS, RELAY_STALL_CHECK_MS, RELAY_STALL_MS, RELAY_START_RETRY_MS, RELAY_TOOL, backoffMs } from './relay/config'
import { BROWSER_MISSING_LINE, BROWSER_SERVER, createdTab, failureOf, holdsPlanTab, paneState, type BrowserResult, type BrowserTool } from './relay/browser'
import { KEEPALIVE_GIVE_UP_MS, KEEPALIVE_IDLE_MS, KEEPALIVE_RETRY_MS, KEEPALIVE_RETRY_WINDOW_MS, KEEPALIVE_WAKE_CHECK_MS } from './relay/keepalive'
import { IDLE, deliveryMode, noteAppended, relayLine, repeatLine, toolResultSent, turnEnded, turnStarted } from './relay/delivery'
import { cursorFor, cursorKey, staleCursorKeys } from './relay/cursor'
import { fromPending, isLateTick, isStalled, onlyPlan, pollCursor, toPending } from './relay/outbox'
import type { Queued } from './relay/outbox'
import { classifierRefusal, ownServerCheck, raisedByPlugin, type Refusal } from './relay/refusal'
import { OLD_SERVER_DETAIL, OLD_SERVER_FIX, RELAY_ERROR_FIX, delayedLine, notTakenLine, refusedLine, stalledLine, stalledNotice, stoppedLine } from './relay/text'
import { liveAgentsAt, usageBody } from './plan/usage'
import type { LiveAgent } from './plan/usage'
import { spawnGuard } from './plan/pacing-guard'
import { pacingLine, peekPacing, refreshPacing, resetPacing, withLine } from './plan/pacing-line'
import { EMPTY_PACING_STATE, buildPacing } from './plan/pacing-model'
import { readTeamSettings } from './plan/pacing-settings'
import { ACTIVITY_PATH, LEAVE_CLOSE_DEADLINE_MS, LIVENESS_MS, agentRow, endedShells, shellRow } from './reports/activity'
import { bareSubagentId, subagentKey } from './compaction/subagent-key'
import type { ActivityChange } from './reports/activity'
import { labelOf } from './reports/label'
import { READY_CARDS_DEADLINE_MS, blockReason, issuesQuery, planOf, readyCardsOf, skippedLine } from './reports/ready-cards'
import type { ReadyCard } from './reports/ready-cards'
import { OLDER_DASHBOARD_LINE, PAUSE_PATH, isUnregisteredSession, pauseOf } from './reports/pause'
import type { PauseRead } from './reports/pause'

// $.state atoms: the engine's scan reads an atom's plugin and key only from a const in the file that
// uses it (DX-4232), so they are declared here, not in ./plan/config.
const view = atom({ plugin: 'danxbot', key: 'view' } as const, EMPTY)
const gate = atom({ plugin: 'danxbot', key: 'gate' } as const, { inFlight: false, again: false, at: null } as RefreshGate)
// the band is hidden for the session: its own atom, since refresh replaces `view` whole
const dismissed = atom({ plugin: 'danxbot', key: 'dismissed' } as const, false)
const busy = atom({ plugin: 'danxbot', key: 'busy' } as const, [] as string[])
const title = atom({ plugin: 'danxbot', key: 'title' } as const, null as string | null)
// DX-4982: the plan the model's own successful plan_connect named, kept for the `blocked` view (the plugin's own reads are refused by auto mode's
// classifier, so nothing else names the plan); null after any leave, a /clear or a resume, a session start, and every loaded view.
const modelPlan = atom({ plugin: 'danxbot', key: 'modelPlan' } as const, null as { id: number; name: string } | null)
// DX-4630: the sign-in request waiting for the person (its link and confirm code), set the moment it exists and cleared when it
// ends (approved, denied, expired and renewed, or the conversation ended). The band draws it as a Markdown link and the
// code the moment it exists. Also what tells a watch is running.
const signInRequest = atom({ plugin: 'danxbot', key: 'signInRequest' } as const, null as ApprovalRequest | null)
// DX-4435: the model's `request_permission` requests not yet decided, oldest first; the band counts them.
const permissionRequests = atom({ plugin: 'danxbot', key: 'permissionRequests' } as const, [] as PermissionRequest[])
// DX-4508: the main session's transcript path (the classic events carry it).
const transcript = atom({ plugin: 'danxbot', key: 'transcript' } as const, null as string | null)
// DX-4336: the text of the last usage report's failure (null while the reports are accepted), so a failure that repeats every tick is
// shown once, not every minute.
const usageError = atom({ plugin: 'danxbot', key: 'usageError' } as const, null as string | null)
// DX-4336: when the last API response arrived (epoch ms), the age of the usage figure; null until the session has seen one.
const measuredAt = atom({ plugin: 'danxbot', key: 'measuredAt' } as const, null as number | null)
// DX-4336: the sub-agents running now (id and start time), from SubagentStart / SubagentStop. Keyed by id, not a counter: a stop for an agent
// that was never counted (a reload lost the start, a duplicate stop) changes nothing, so the count cannot go negative; an entry older than
// SUBAGENT_LIVE_MAX_MS (an agent that died with no stop) is no longer counted.
const liveAgents = atom({ plugin: 'danxbot', key: 'liveAgents' } as const, [] as LiveAgent[])
// DX-4339: what the usage pacing draws from: the session's own windows, the team's settings and the account verdict as last read.
const pacingState = atom({ plugin: 'danxbot', key: 'pacingState' } as const, EMPTY_PACING_STATE as PacingSnapshot)
// DX-4233: the plan event relay's state (the band's events warning). DX-4721: and the main loop's turn (TurnState).
const relay = atom({ plugin: 'danxbot', key: 'relay' } as const, RELAY_OFF as RelayState)
// DX-5232: the events warning the band last showed (null: none), so its reason is told once on the transition into it.
const eventsWarned = atom({ plugin: 'danxbot', key: 'eventsWarned' } as const, null as string | null)
const turn = atom({ plugin: 'danxbot', key: 'turn' } as const, IDLE as TurnState)
// DX-4234: the last time stamp handed to the model (prompt or tool call), which the next one counts its +delta and its date from.
const lastStamp = atom({ plugin: 'danxbot', key: 'lastStamp' } as const, null as StampState)
// DX-4234: a session start the model has not been told about. On a desktop or headless startup, resume and fork the engine has not bound the
// session when SessionStart runs, so `$.mcp.call` and `$.tool.list` throw there: SessionStart only records the start here, and the next
// prompt.submit or tool result (bound) takes it and tells the model what the start has to say.
const pendingStart = atom({ plugin: 'danxbot', key: 'pendingStart' } as const, null as PendingStart)
// DX-4234: the session a /clear just ended: the session.end hook records its id and the SessionStart that follows takes it, so the restart notice
// asks about exactly that predecessor.
const endedSession = atom({ plugin: 'danxbot', key: 'endedSession' } as const, null as string | null)
// DX-3900 / DX-4806: the desktop app hosts this session (see the keepalive); sticky for the session, raised by CLAUDE_CODE_ENTRYPOINT=claude-desktop or
// surfaces() at session.start, or by session.attach.
const desktopHosted = atom({ plugin: 'danxbot', key: 'desktopHosted' } as const, false)
// DX-4806: when the current keepalive idle period began (epoch ms): the last main-loop turn end, or the start of the plan connection. A reload
// of the module arms from it, so the period is not restarted by the reload; null while no plan is followed.
const idleSince = atom({ plugin: 'danxbot', key: 'idleSince' } as const, null as number | null)
// DX-4997: the person was told once that this dashboard has no agent-pause route (a plugin newer than the dashboard).
const olderDashboardTold = atom({ plugin: 'danxbot', key: 'olderDashboardTold' } as const, false)
// DX-5093: the person was told once that the Browser pane is not reachable from the plugin, so the plan tab is not kept open (a reload keeps it).
const browserMissingTold = atom({ plugin: 'danxbot', key: 'browserMissingTold' } as const, false)
// DX-5231: the leftover compaction-trigger variables an older plugin version armed were cleared in this process. $.state because the variables live in the process: a module reload keeps both.
const leftoverArmingCleared = atom({ plugin: 'danxbot', key: 'leftoverArmingCleared' } as const, false)
// DX-5222: the percent CLAUDE_AUTOCOMPACT_PCT_OVERRIDE holds because the plugin armed it for the sub-agents (null: the plugin armed none). $.state because the variable lives in the process: a module reload keeps both.
const armedPercent = atom({ plugin: 'danxbot', key: 'armedPercent' } as const, null as number | null)
// DX-5222: this host runs `session.compact`: raised by the first such event of the session. $.state, so a module reload keeps it (a reload that forgot it would take the armed percent back
// until the next compaction event). It is one of two inputs to `hostRunsSessionCompact` (the other is the engine release from 2.1.299, `engineCompact`); when that holds, the classic PreCompact gate
// leaves an automatic proposal to `session.compact` (which judged it per agent) and the sub-agents' percent is armed (a host with neither has only the classic gate, which cannot tell the agents apart, so an early proposal there would hold every agent).
const sessionCompactSeen = atom({ plugin: 'danxbot', key: 'sessionCompactSeen' } as const, false)
// DX-5365: what the engine's release says about `session.compact`, read once per process (`$.session.version()`), $.state like the flag above: 'unread' until the first question, then 'runs' (a
// release from SESSION_COMPACT_FLOOR), 'older' (an earlier release), or 'unreadable' (the call threw or named no release: not known to run it, and the person is told once, `engineVersionTold`).
const engineCompact = atom({ plugin: 'danxbot', key: 'engineCompact' } as const, 'unread' as 'unread' | 'runs' | 'older' | 'unreadable')
// DX-5222: the sub-agent requests the plugin has claimed to send (`<session>:<agent>` to the request's `at`). One compare-and-set before `$.session.send`, like claimedRelease, so the 5 s check and
// a turn's sync never both send it; a send that fails gives the claim back.
const claimedAsks = atom({ plugin: 'danxbot', key: 'claimedAsks' } as const, {} as Record<string, string>)
// DX-5231: the release the plugin has claimed to start a compaction with. The claim is one compare-and-set on this atom, made before any other await of the start, so a turn's end, an idle
// check and a person's own /compact racing each other start (or spend) a ready exactly once.
const claimedRelease = atom({ plugin: 'danxbot', key: 'claimedRelease' } as const, null as string | null)
// DX-5344: who is compacting, one entry per agent so overlapping compactions (parallel sub-agents crossing the one process-wide threshold together, or a main-agent compaction among them) never
// overwrite each other. Claude Code's classic SessionStart input names no agent (2.1.299), so a `session.compact` proposal that passed enters its agent here and the `compact` restart reads the
// entries to decide whether the MAIN agent is briefed. `main` is the main agent's entry (epoch ms of its proposal) or null. An agent's entry is `done` once core finished its compaction (the
// `session.compact` result), and its own briefing is then told on its first tool result; a proposal that was skipped or failed removes its entry. An entry older than COMPACTING_NOTE_TTL_MS, or of
// a sub-agent that stopped, is dropped. Residual risk, UNVERIFIED live: a compaction whose result never comes back (the engine dies mid-way) keeps its entry for up to the age bound, during which a restart
// that cannot be attributed (the three kinds in CLAUDE.md) is read as that sub-agent's and does not brief the main agent. The same holds while a sub-agent has finished compacting but has not yet made its next
// tool call (its entry stays until that call). Rare case: when the main agent and a sub-agent compact together, the sub-agent's restart can use up the main entry; if the main compaction then fails,
// the main agent gets a stray briefing.
const compacting = atom({ plugin: 'danxbot', key: 'compacting' } as const, { main: null, agents: {} } as CompactingState)
// DX-4235: the reports' memory between events (see ReportState).
const reports = atom({ plugin: 'danxbot', key: 'reports' } as const, { agents: {}, shells: [], planId: null } as ReportState)
// DX-5398: the relay's undelivered events, kept beside the module's own outbox (relay/outbox.ts says why): $.state outlives a reload of this module, the module variable does not.
const relayOutbox = atom({ plugin: 'danxbot', key: 'relayOutbox' } as const, [] as PendingEvent[])

// DX-4232: the engine follows `$` only into a function declared in the SAME file (`claude plugin
// validate` refuses it across an import), and refuses a closure that receives `$` declared
// inside `register`. So every function that takes `$` is a top-level declaration here; the
// drawing, shaping and constants live in ./plan/* as pure code, and this file hands the
// drawings their handlers (handlers()).

// DX-4233: the plan event relay's loop, at most one (a handle, so a module variable: a reload cancels the old environment's
// waits, ends its loop, and session.start starts the new one). `dead` ends a loop at its next step and makes whatever its pending
// call answers late be ignored.
// `told`: the last failure line told to the session by this run (the same text is told once until a wait succeeds): per run, so an ended run
// can never clear or set what the new run has told.
// `lacking`: the run's failed waits in a row whose evidence is "the plugin server lists tools but not plan_events_wait" (count, and when the first came).
// DX-4884: `planId: null` is the relay of a signed-in session on no plan (session records only: pacing, auto-resume).
// DX-5398: `beat` is the wall-clock time of the loop's last step (0 before the first), what the stall watch judges.
type RelayRun = { planId: number | null; dead: boolean; told: string | null; lacking: { count: number; since: number } | null; beat: number }
let relayRun: RelayRun | null = null
// DX-5398: the events the poll loop has taken and the pump has not delivered yet (relay/outbox.ts says why they are not delivered by the loop). Handles
// (the delivery promises), so a module variable: a reload starts with none, and `restoreOutbox` rebuilds it from the `relayOutbox` atom, the copy $.state keeps.
let outbox: Queued[] = []
// DX-5398: the stall watch, one per process (a handle), the run it last saw with the time it first saw it, and when its last tick ran.
let stallTicker: { cancel: () => void } | null = null
let stallSeen: { run: RelayRun; since: number } | null = null
let stallTickAt: number | null = null
// The plan whose relay the server stopped, or that is signed out: it is not started again until something asks (a connect, the
// model's plan_connect, a sign-in), so a refresh cannot restart a stopped relay in a loop.
// DX-4884: boxed, because a halt on no plan (`planId: null`) is a halt too.
let relayHalted: { planId: number | null } | null = null
// DX-4339: the usage pacing poll, one per session.
let pacingTicker: { cancel: () => void } | null = null
// DX-4336: the usage report's timer, one per session.
let usageTicker: { cancel: () => void } | null = null
// DX-5231: the idle check for an agent's ready that lands while no main turn is running (see idleCompactionCheck).
let compactionTicker: { cancel: () => void } | null = null
// DX-4530: the fast claim poll, running only while a permission request is open (syncPermissionPoll).
let permissionTicker: { cancel: () => void } | null = null
// DX-4530: a fast tick is skipped while the last one's claims are still out (slow answers must not stack claim traffic). A
// module variable: a reload starts with no claim of its own in flight.
let permissionTickBusy = false

// One dashboard call through the session's own danx-dashboard MCP server (the plugin's, SERVER): same credential, same
// x-danx-session-id header. DX-4997 / DX-5033: EVERY call here is the plugin's background work, never the agent's own, so it carries
// `background: true` (the MCP turns it into a request header): the dashboard keeps the session registered and live for it but does not take it as
// the agent acting, which would end the agent's pause. The agent's own danxbot_api calls never pass through here. Any rejection (including the engine's "no such server") is an error shown as one.
async function api($: any, method: string, path: string, extra: { query?: object; body?: object; board?: string } = {}): Promise<Api> {
  let res
  try {
    res = await $.mcp.call(SERVER, 'danxbot_api', { method, path, ...extra, background: true })
  } catch (err: any) {
    const message = String(err?.message ?? err)
    // DX-4578: `unreachable` is the engine's "no such server" and nothing else: the plugin's own server is not connected (yet). The plan
    // load carries it on its error view (`serverNotConnected`, which the session-start retry waits out); the pacing and usage readers
    // stay quiet about it until a read has succeeded.
    const notConnected = isServerNotConnected(message)
    // DX-4805 / DX-4982: a classifier refusal shows the person's sentence and fix wherever the error is shown (toasts, lines), never the engine's raw words; those are kept whole on `refusal` for the relay's start and the load's blocked view
    const refusal = classifierRefusal(message)
    const shown = message.slice(0, CALL_ERROR_MAX)
    const failed: Api = refusal === null ? { ok: false, status: 0, body: { error: shown } } : { ok: false, status: 0, body: { error: BLOCKED_LINE }, refusal }
    if (!notConnected) return failed
    failed.unreachable = true
    return failed
  }
  return toolOutcome(res)
}

const DASHBOARD_ORIGIN_KEY = 'dashboardOrigin'

async function loadView($: any) {
  const refreshedAt = await isoNow($)
  const loaded = await loadPlan((method, path, extra) => api($, method, path, extra), refreshedAt)
  // DX-4521: the band's links need the dashboard origin even when this load could not read it (signed out, a failed call, a
  // session just started): the last origin a plan list answered is kept in $.store (across sessions) and stands in for it.
  if (loaded.dashboardUrl !== null) {
    await $.store.set(DASHBOARD_ORIGIN_KEY, loaded.dashboardUrl)
    return loaded
  }
  const seen = await $.store.get(DASHBOARD_ORIGIN_KEY)
  return typeof seen === 'string' ? { ...loaded, dashboardUrl: seen } : loaded
}

// DX-4423: the plan the session was on is kept through every view that does not know it (a failed load, a signed-out one) for Sign in to ask
// for again; a loaded view knows its own.
async function applyLoaded($: any, loaded: any): Promise<void> {
  // DX-5232: each failure is told once, on the load that makes it appear; the change is decided inside the update, so overlapping loads toast once
  let told: string[] = []
  // DX-4982: the plan the model's own plan_connect named stands in for what the refused reads could not say
  const named = loaded.phase === 'blocked' ? await read($, modelPlan) : null
  // a link is never built on a null origin: the load's (or the stored) one, else DANXBOT_DASHBOARD_URL, else the plugin's dashboard_url option; with none, the plan is not named
  const origin = named === null ? null : blockedOrigin({ loaded: loaded.dashboardUrl, env: await $.env.get('DANXBOT_DASHBOARD_URL'), option: dashboardOption })
  // a loaded view knows the plan itself: what the model named is stale from here
  if (loaded.phase === 'ready') await update($, modelPlan, () => null)
  await update($, view, cur => {
    told = []
    if (loaded.phase === 'error' && cur.phase !== 'error' && !loaded.serverNotConnected) told.push(`Plan load failed: ${loaded.error}`)
    // one toast for the every-card read's failure: it takes the count and the links down together
    if (loaded.openProblemsError && cur.openProblemsError !== loaded.openProblemsError) told.push(`Plan cards unavailable: ${loaded.openProblemsError}`)
    // the card links' error: the replies are drawn as written
    if (loaded.links?.state === 'error' && cur.links?.state !== 'error' && !loaded.openProblemsError) told.push(`Card links unavailable: ${loaded.links.message}`)
    if (loaded.phase === 'ready') return loaded
    const base = { ...loaded, resumePlan: cur.connected?.id ?? cur.resumePlan }
    return named === null || origin === null ? base : { ...base, dashboardUrl: origin, connected: { id: named.id, ref: `PLAN-${named.id}`, name: named.name, dashboardUrl: origin } }
  })
  for (const t of told) $.ui.toast(t.slice(0, TOAST_ERROR_MAX))
  // DX-5232: a write path, never the draw: the events warning's reason is told on the change into it
  await noteEventsWarning($)
  // DX-4233: the view says which plan this session is on, so it says whether a relay runs and for which
  await syncRelay($)
}

// DX-5232: a load that failed outside the load itself (its deadline, a throw): the view goes to the error phase, told once on the change into it.
async function failView($: any, error: string): Promise<void> {
  let first = false
  await update($, view, cur => {
    first = cur.phase !== 'error'
    return { ...cur, phase: 'error', error }
  })
  if (first) $.ui.toast(`Plan load failed: ${error}`.slice(0, TOAST_ERROR_MAX))
}

// One load in flight at a time, at least MIN_GAP_MS apart unless forced. A forced refresh asked
// while one runs makes it run once more, so a write's result is never left unread. The gate is
// $.state, not module variables (lost on reload).
async function refresh($: any, force = false): Promise<void> {
  const now = await $.clock.now()
  let go = false
  await update($, gate, cur => {
    // a lock held past LOCK_STALE_MS belongs to a step that never settled: any request, forced or not, takes it over
    const stale = cur.inFlight && cur.at !== null && now - cur.at > LOCK_STALE_MS
    if (cur.inFlight && !stale) {
      go = false
      return force ? { ...cur, again: true } : cur
    }
    go = force || cur.at === null || now - cur.at >= MIN_GAP_MS
    return go ? { inFlight: true, again: false, at: now } : cur
  })
  if (!go) return
  // The lock is released in `finally`, so a throw out of any step below cannot leave it held and
  // stop every later refresh.
  try {
    let again = true
    while (again) {
      try {
        // DX-4233: EVERY load (not only the first) is an error shown at LOAD_DEADLINE_MS, so a hung call does not hold the view's state or the relay's
        // start. The call itself is not abandoned to run beside the next load: this refresh keeps the lock for up to LOAD_ORPHAN_WAIT_MS more and
        // applies its answer if it comes then, so at most one load runs (through that wait; past it the call is given up).
        const load = loadView($)
        let v = await withinDeadline($, LOAD_DEADLINE_MS, load, () => null)
        if (v === null) {
          await failView($, `the plan did not load within ${LOAD_DEADLINE_MS / 1000}s`)
          v = await withinDeadline($, LOAD_ORPHAN_WAIT_MS, load, () => null)
        }
        if (v !== null) await applyLoaded($, v)
      } catch (err: any) {
        await failView($, String(err?.message ?? err))
      }
      await settlePermissionRequests($)
      await update($, gate, cur => {
        // `at` is this claim's token: a load whose stale lock was taken over must not touch the new holder's
        if (cur.at !== now) {
          again = false
          return cur
        }
        again = cur.again
        return { ...cur, again: false }
      })
    }
  } finally {
    await update($, gate, cur => (cur.at === now ? { ...cur, inFlight: false, again: false } : cur))
  }
}

// DX-4435 / DX-4530: a request leaves the list once its claim (the key's own route) decides it (settle): granted, denied,
// expired, unknown to the dashboard, or the session lost its key. A claim that fails for any other reason keeps it for the next
// poll: a request has no expiry clock of its own. The model is told each decision once, waking it when it is idle (tellModelAwake).
async function settlePermissionRequests($: any): Promise<void> {
  const notes = new Map<string, string | null>()
  for (const r of await read($, permissionRequests)) {
    const settled = settle(r, await api($, 'POST', claimPath(r)))
    if (settled.kind === 'drop') notes.set(r.publicId, settled.note)
  }
  // only what this run takes out of the list is told by it: a settle running beside it (the fast poll and a refresh) takes
  // none of the same requests
  let taken: PermissionRequest[] = []
  await update($, permissionRequests, cur => {
    taken = cur.filter(r => notes.has(r.publicId))
    return cur.filter(r => !notes.has(r.publicId))
  })
  for (const r of taken) {
    const note = notes.get(r.publicId)
    if (typeof note === 'string' && (await markToldOnce($, r.publicId))) await tellModelAwake($, note)
  }
  await syncPermissionPoll($)
}

// DX-4530: one fast-poll tick; skipped while the last one is still out (permissionTickBusy).
async function permissionTick($: any): Promise<void> {
  if (permissionTickBusy) return
  permissionTickBusy = true
  try {
    await settlePermissionRequests($)
  } finally {
    permissionTickBusy = false
  }
}

// DX-4530: the told-once guard, in $.store so it outlives a reload and a restart (the request list itself may come back, or the
// model may be answered the same request again): true the first time a request's decision is to be told, false ever after.
// Marked before the telling, so a telling that fails is toasted (notToldToast) and never repeated. The read-then-write is not atomic:
// two settles marking different ids at once can lose one id, which only matters if that request comes back into the list later.
// Each telling is exclusive anyway: a settle tells only the requests its own `update` took out of the list.
const PERMISSION_TOLD_KEY = 'permissionTold'

async function markToldOnce($: any, publicId: string): Promise<boolean> {
  const seen = await $.store.get(PERMISSION_TOLD_KEY)
  const told: string[] = Array.isArray(seen) ? seen.filter((id: unknown): id is string => typeof id === 'string') : []
  if (told.includes(publicId)) return false
  await $.store.set(PERMISSION_TOLD_KEY, [...told, publicId].slice(-PERMISSION_TOLD_MAX))
  return true
}

// DX-4530: the claim is polled every PERMISSION_POLL_MS while a request is open, so the model hears the decision within
// seconds; the timer stops once none is (the refresh tick's own settle is all that runs then, and it claims nothing).
async function syncPermissionPoll($: any): Promise<void> {
  const open = (await read($, permissionRequests)).length > 0
  if (open && permissionTicker === null) permissionTicker = $.clock.every(PERMISSION_POLL_MS, () => permissionTick($))
  else if (!open && permissionTicker !== null) {
    permissionTicker.cancel()
    permissionTicker = null
  }
}

// A user-role row the model reads and the person does not see typed ($.session.append's argument).
const modelRow = (text: string) => ({ message: { type: 'user' as const, content: [{ type: 'text' as const, text }] } })

// The model did not make this call, so tell it (it reads this, the person does not). R-4.
async function tellModel($: any, text: string): Promise<void> {
  try {
    const r = await $.session.append(modelRow(text))
    if (r.deny) throw new Error(r.deny)
  } catch (err: any) {
    notToldToast($, err?.message ?? err, text)
  }
}

// DX-4625: tell the model something it must ACT on while the person types nothing (a permission decision, DX-4880 a sign-in's outcome): by the plan event
// bridge's own delivery (deliverEvent), not urgent (DX-4721): a prompt, which wakes an idle session and queues behind a running turn.
// `tellModel`'s append is only read on the session's next turn, which an idle agent waiting on the person never starts.
async function tellModelAwake($: any, text: string): Promise<void> {
  const failure = await deliverEvent($, text, false)
  if (failure !== null) notToldToast($, failure, text)
}

// The write the operator asked for already happened: say the model was not told, and carry the row it was meant to read (the
// operator can paste it), never hide it.
function notToldToast($: any, cause: unknown, text: string): void {
  $.ui.toast(`Could not tell the model: ${String(cause).slice(0, TOAST_ERROR_MAX)}${NOTE_MARKER}${text}`)
}

// DX-4630: a permission request's toast: link and code together, for the longest the host allows. The band draws the same link and
// code from `permissionRequests`; no page is opened by the plugin, the person follows the link.
const toastPermission = ($: any, approval: ApprovalRequest) => $.ui.toast(permissionToast(approval), { timeoutMs: APPROVAL_TOAST_MS })

// DX-4630: the tool answer, with the note that the person already has the link and code, as context the model reads after the result.
const withPermissionNote = (ran: any, approval: ApprovalRequest) => ({ ...ran, context: [...(ran.context ?? []), permissionShownNote(approval)] })

// DX-4630: the sign-in request's toast: link and code together, for the longest the host allows.
const toastSignIn = ($: any, approval: ApprovalRequest) => $.ui.toast(signInToast(approval), { timeoutMs: APPROVAL_TOAST_MS })

// DX-4630: a sign-in request, drawn the moment it exists: the band reads it from $.state and draws its link and confirm
// code, and the toast carries both. The plugin opens no page: the person follows the link.
async function showSignInRequest($: any, approval: ApprovalRequest): Promise<void> {
  await update($, signInRequest, () => approval)
  toastSignIn($, approval)
}

// DX-4630: the tool answer, with the note that the person already has the link and code, as context the model reads after the result.
const withSignInNote = (ran: any, approval: ApprovalRequest) => ({ ...ran, context: [...(ran.context ?? []), signInShownNote(approval)] })

// One write per key at a time: the claim is a compare-and-set on $.state, so two presses landing
// together (a double click, a key repeat) cannot both win. The loser does nothing.
// `release` (DX-4548): false when something else already freed the key and a newer holder may own it now (an aborted sign-in watch)
async function withBusy($: any, key: string, work: () => Promise<void>, release: () => boolean = () => true): Promise<void> {
  let won = false
  await update($, busy, cur => {
    won = !cur.includes(key)
    return won ? [...cur, key] : cur
  })
  if (!won) return
  try {
    await work()
  } finally {
    if (release()) await update($, busy, cur => cur.filter(k => k !== key))
  }
}

// DX-4423 / DX-4418: a leave pressed on a band that went stale: the key is gone since the band drew. The person is told
// in the view's words, never the server's (a revoked key's answer is the agent's stop order), and the view reloads to say so.
// True when that was the answer.
async function accessEnded($: any, outcome: ToolOutcome): Promise<boolean> {
  const by = outcomeRevokedBy(outcome)
  if (by === null && !isSignedOut(outcome)) return false
  $.ui.toast(by !== null ? `${keyRevokedLabel(by)}. This session must stop.` : 'Signed out. Sign in from the band.')
  detach($, 'Plan refresh', refresh($, true))
  return true
}

// DX-4635: the one way to run a task apart from the event that started it (a press, a hook, a tick). A press ends as soon as its own
// outcome is known and shown; what follows (the model's note, the full refresh with its relay and live syncs, a second forced pass)
// runs here, so the busy label never waits on reads that are not the action's own. The task's failures are shown, never swallowed: a
// refresh reports its own load failures in the view, and anything it throws past that is a toast. Only the environment ending under
// it escapes (settleDetached). `what` names the task in that toast.
function detach($: any, what: string, task: Promise<unknown>): void {
  void settleDetached(task).catch(err => $.ui.toast(`${what} failed: ${String(err?.message ?? err).slice(0, FAILURE_TOAST_MAX)}`))
}

// DX-4982: a call the plugin raised itself failed: a classifier refusal is told in the person's words (cause and fix) and the view reloads to
// show the same state; any other failure keeps its own words.
function toastCallFailedAndReload($: any, what: string, err: any): void {
  const message = String(err?.message ?? err)
  if (classifierRefusal(message) === null) {
    $.ui.toast(`${what}: ${message.slice(0, FAILURE_TOAST_MAX)}`)
    return
  }
  $.ui.toast(BLOCKED_LINE)
  detach($, 'Plan refresh', refresh($, true))
}

const isoNow = async ($: any): Promise<string> => new Date(await $.clock.now()).toISOString()

// DX-4635: what a plan_connect answer settles, drawn at once from EMPTY, so nothing of the plan the session was on (its cards,
// listener, links) stays under the new one. Kept: what is not plan-specific (the dashboard origin). A leave puts the session on no plan.
const planIndependent = (cur: any) => ({ ...EMPTY, dashboardUrl: cur.dashboardUrl })
function leftView(cur: any): any {
  return { ...planIndependent(cur), phase: 'ready', refreshedAt: cur.refreshedAt }
}

// Takes the session OFF its plan (plan_connect with disconnect: true, guarded by the plan we think we
// are on). A refusal is shown, never swallowed: a 409 means the band was stale (the server names the
// plan the session is really on, or says it is on none), so it also refreshes; a 404 or any other
// failure carries its status and message. No confirm: the model can ask plan_connect for the plan again to undo it.
function disconnect($: any, plan: ConnectedPlan): Promise<void> {
  return withBusy($, busyKey.disconnect(plan.id), async () => {
    // DX-4235: the leave closes what the session opened under the plan first; a leave that does not happen takes that back
    const why = `leaving ${plan.ref}`
    const closes = await closeOwedBeforeLeave($, why)
    let r
    try {
      r = await $.mcp.call(SERVER, 'plan_connect', { plan_id: plan.id, disconnect: true })
    } catch (err: any) {
      await settleLeave($, closes, false, why)
      toastCallFailedAndReload($, 'Disconnect failed', err)
      return
    }
    const outcome = toolOutcome(r)
    await settleLeave($, closes, outcome.ok, why)
    if (await accessEnded($, outcome)) return
    if (!outcome.ok) {
      $.ui.toast(`Disconnect refused: ${refusalText(outcome)}`.slice(0, FAILURE_TOAST_MAX))
      if (outcome.status === 409) detach($, 'Plan refresh', refresh($, true))
      return
    }
    const left = outcome.body?.leftPlan
    if (typeof left?.name !== 'string') {
      // a 200 that names no plan left cannot be told to the model as fact: show it, and read the truth
      $.ui.toast('Disconnect failed: the answer named no plan left')
      detach($, 'Plan refresh', refresh($, true))
      return
    }
    $.ui.toast(`Disconnected from ${plan.ref}`)
    await update($, view, leftView)
    detach($, 'Plan update', tellModel($, disconnectNote({ ref: plan.ref, name: left.name })).then(() => refresh($, true)))
  })
}

// DX-4423 / DX-4548: the wait on a sign-in request, one at a time. A session with no dashboard key asks for one through
// `plan_connect`; the MCP answers with the approval request, drawn at once (showSignInRequest: the band's link and code). Each call waits
// there (about 45 s) for the person's approval, so the calls repeat until one answers something final, with no round limit: a
// request stays open for as long as its session lives (DX-4530). The status of the request cannot be read any other way: its
// claim needs a secret only the MCP process holds (and a claim would take the key from it), and reading it by id needs a
// person's login. A call that answers a DIFFERENT request than the one watched means the first expired while it waited: the
// model is told, and the renewed request is shown and watched in its place, so nobody has to relay it.
//
// Two starts: the Sign in button (`byPress`: the person is waiting, and the model is told once that it is
// signed in), and the model's own `plan_connect` answering `approval_required` (`known`: the request already shown; the model is
// told the outcome once, approved, denied or expired, so the person never has to type "approved"). The whole watch holds the
// sign-in busy key (the buttons read "Signing in…", a second start does nothing).
// DX-4548: bumped when the conversation (or the process) ends; a watch of an older generation stops at its next step, so it
// never calls plan_connect with the old conversation's arguments or tells the new conversation about a request it never made
let signInGeneration = 0

type SignInWatch = { args: object } & ({ byPress: true } | { byPress: false; known: ApprovalRequest })

async function watchSignIn($: any, watch: SignInWatch): Promise<void> {
  const generation = signInGeneration
  await withBusy($, busyKey.signIn, async () => {
    const ended = () => generation !== signInGeneration
    let shown: ApprovalRequest | null = watch.byPress ? null : watch.known
    await update($, signInRequest, () => shown)
    // DX-4530: each outcome is told once (the told-once guard, keyed by the request). The model's request always has an id
    // (onPlanConnect and the renewal below refuse one without); only the press may see one with none, and it tells once per watch.
    // DX-4880: told as a waking prompt (tellModelAwake), on both paths: the session sits idle while the person approves, and an
    // appended row is read only on a turn nobody starts, so the person had to type "approved" for the model to go on.
    const tell = async (request: ApprovalRequest | null, text: string) => {
      const key = request === null ? undefined : publicIdOf(request.url)
      if (key === undefined ? watch.byPress : await markToldOnce($, key)) await tellModelAwake($, text)
    }
    const shownRequest = (): ApprovalRequest => {
      if (shown === null) throw new Error('sign-in watch: the model path has no shown request')
      return shown
    }
    try {
      for (;;) {
        const startedAt = await $.clock.now()
        let r
        try {
          r = await $.mcp.call(SERVER, 'plan_connect', watch.args)
        } catch (err: any) {
          if (!ended()) toastCallFailedAndReload($, 'Sign in failed', err)
          return
        }
        if (ended()) return
        const step = signInStep(r)
        if (step.kind === 'waiting') {
          if (shown !== null && step.request.url !== shown.url) {
            // the request watched is over without a decision reaching this call: it lapsed, and this answer is its renewal
            $.ui.toast(SIGN_IN_EXPIRED_TOAST)
            if (!watch.byPress) await tell(shown, signInExpiredNote(shown.code))
            if (!watch.byPress && publicIdOf(step.request.url) === undefined) {
              $.ui.toast(signInFailedToast('the renewed approval request had no id'))
              return
            }
          }
          if (shown === null || step.request.url !== shown.url) await showSignInRequest($, step.request)
          shown = step.request
          // DX-4548: an answer that came back sooner than the MCP's own wait must not turn this into a tight loop
          const took = (await $.clock.now()) - startedAt
          if (took < SIGN_IN_MIN_ROUND_MS) await $.clock.sleep(SIGN_IN_MIN_ROUND_MS - took)
          if (ended()) return
          continue
        }
        if (step.kind === 'revoked') {
          $.ui.toast(`${keyRevokedLabel(step.by)}. This session must stop.`)
          await refresh($, true)
          return
        }
        if (step.kind === 'denied') {
          $.ui.toast(SIGN_IN_DENIED_TOAST)
          if (!watch.byPress) await tell(shown, signInDeniedNote(shownRequest().code))
          return
        }
        if (step.kind === 'stop') {
          $.ui.toast(step.message)
          return
        }
        // signed in (even if the plan was refused): the view reads the truth
        $.ui.toast(step.kind === 'done' ? SIGNED_IN_TOAST : step.message)
        // DX-4530: the model did not press Sign in, so it is told it is signed in (and where), as connect tells it
        const planId = typeof (watch.args as any).plan_id === 'number' ? (watch.args as any).plan_id : null
        await tell(shown, watch.byPress ? signInNote(planId, step.kind === 'done') : signInApprovedNote(shownRequest().code, planId))
        await refresh($, true)
        return
      }
    } finally {
      if (!ended()) await update($, signInRequest, () => null)
    }
    // DX-4548: an aborted watch's key was freed at the abort (onSessionEnd); a new watch may hold it by now, so this one never frees it
  }, () => generation === signInGeneration)
}

// The button's press returns at once: the sign-in waits minutes for a person, and a press must not. A watch already running
// (the model's own sign-in) says its link and code again instead of starting a second wait.
async function startSignIn($: any): Promise<void> {
  const waiting = await read($, signInRequest)
  if (waiting !== null) {
    toastSignIn($, waiting)
    return
  }
  const args = await signInArgs($)
  void watchSignIn($, { args, byPress: true }).catch(err => toastCallFailedAndReload($, 'Sign in failed', err))
}

// The sign-in's own `plan_connect` arguments: the session's title, and the plan it was on.
async function signInArgs($: any): Promise<object> {
  const sessionTitle = await read($, title)
  const resume = (await read($, view)).resumePlan
  return { ...(resume !== null ? { plan_id: resume } : {}), ...(sessionTitle ? { title: sessionTitle } : {}) }
}

// DX-4374 / DX-5232: the one way back to the plan UI, for the footer button and /danx-plan alike: bring the band back (clear
// `dismissed`). It tells the model nothing (R-4 covers actions that change plan state; this changes none).
async function showPlan($: any): Promise<void> {
  await update($, dismissed, () => false)
}

// The band's close control: the band hides until the footer button or /danx-plan is used.
async function dismissBand($: any): Promise<void> {
  await update($, dismissed, () => true)
}

function handlers($: any): Handlers {
  return {
    showPlan: () => showPlan($),
    dismissBand: () => dismissBand($),
    disconnect: plan => disconnect($, plan),
    signIn: () => startSignIn($),
  }
}

// ---- hooks ----------------------------------------------------------------

// The first load can run before the plugin's MCP server connects. A view that failed on exactly that at session start is retried
// after each wait in NOT_CONNECTED_RETRY_MS (on the clock, so a test moves it) and then left as the error.
async function retryWhileNotConnected($: any): Promise<void> {
  for (const wait of NOT_CONNECTED_RETRY_MS) {
    try {
      await $.clock.sleep(wait)
    } catch {
      // the wait rejects when the plugin's environment is unloaded (a reload): the retries end with it
      return
    }
    const cur = await read($, view)
    if (cur.phase !== 'error' || !cur.serverNotConnected) return
    await refresh($, true)
  }
  // the retries ran out: the reason is told once, here (applyLoaded stays quiet while a retry may still connect)
  const last = await read($, view)
  if (last.phase === 'error' && last.serverNotConnected) $.ui.toast(`Plan load failed: ${last.error}`.slice(0, TOAST_ERROR_MAX))
}

// DX-4374: v0.10.0 pinned a status line; the footer is the PLAN-NN button alone, so unpin anything an older loaded version left.
async function unpinStatus($: any): Promise<void> {
  await $.ui.status(undefined)
}

function errMessage(err: any): string {
  return String(err?.message ?? err)
}

async function noteTranscript($: any, e: any): Promise<void> {
  const path = typeof e.transcript_path === 'string' ? e.transcript_path : ''
  if (path !== '') await update($, transcript, cur => (cur === path ? cur : path))
}

// What the session's usage reading came to: its windows, or why they could not be read (DX-4339: the tick reads them itself).
type UsageReading = { limits: readonly SessionRateLimit[] } | { error: string }

// DX-4884: THE signed-in test for the relay and the usage report: a loaded view (ready), or a refresh of a connected session (loading with the
// plan still set: a refresh runs at every turn end, as session.measure fires). Signed-out and revoked views, an unloaded one and an error say no.
const isSignedIn = (v: any): boolean => v.phase === 'ready' || (v.phase === 'loading' && v.connected !== null)

// DX-4336 (PLAN-29 R-1, CAV-6): send this session's rate-limit windows to danxbot. DX-4884: every signed-in session reports, on a plan or not
// (danxbot places the session on an account from this report, then paces and resumes it); a session that is not signed in reports nothing and
// toasts nothing. The whole agent tree's burn is in the session's own figure (R-9), so there is one report per session and none per sub-agent. The
// report says when the figure was MEASURED (the last API response, `measuredAt`): a session that is only ticking re-sends a frozen figure, and danxbot must tell it from one that is working.
// A failed reading, a failed report or a failure of the plugin's own state is a toast, never a hook that threw and was skipped silently: toasted
// once per distinct text (`usageError`), cleared when a report is accepted again or there is nothing to report.
async function reportUsage($: any, reading: UsageReading): Promise<void> {
  try {
    // DX-4884: only a signed-in session (isSignedIn) reports; a signed-out, revoked, lapsed or unloaded view sends and says nothing
    if (!isSignedIn(await read($, view))) return
    let failure: string | null = null
    try {
      // DX-4339: `{error}` is the session's own usage reading failing (the tick read it): the failure is toasted like any other
      if ('error' in reading) failure = reading.error
      else {
        const now = await $.clock.now()
        const body = usageBody(reading.limits, now, await read($, measuredAt), liveAgentsAt(await read($, liveAgents), now).length, await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'))
        if (body !== null) {
          const r = await api($, 'PUT', USAGE_PATH, { body })
          if (r.unreachable) return
          if (!r.ok) failure = errText(r)
          else {
            const every = r.body?.report_every_ms
            if (!Number.isInteger(every) || every < MIN_USAGE_TICK_MS) failure = `the answer named no usable report_every_ms (${JSON.stringify(every)})`
            else if (every !== usageEveryMs) startUsageTicker($, every)
            // DX-4854: danxbot places a session on its account from this very report, so until the first one is taken the pacing line answers
            // unknown (`no_usage_account`) and the band has no verdict. Ask again now instead of leaving the account's readings to the next poll.
            // This runs after every accepted report (each session.measure, whenever a window moves, and the usage tick), so a session whose account
            // still has no verdict re-reads the line each time, until the pacing holds a readout; once it does the poll alone keeps it fresh.
            if ((await read($, pacingState)).readout === null) detach($, 'Usage pacing', refreshPacingView($))
          }
        }
      }
    } catch (err: any) {
      failure = errMessage(err)
    }
    failure = failure === null ? null : failure.slice(0, TOAST_ERROR_MAX)
    if (failure === (await read($, usageError))) return
    await update($, usageError, () => failure)
    if (failure !== null) $.ui.toast(`Usage not reported to danxbot: ${failure}`)
  } catch (err: any) {
    // only reading or writing the plugin's own state can land here: nothing is left to report it through but the toast
    $.ui.toast(`Usage not reported to danxbot: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
}

// DX-4339: the pacing draws the session's own windows whether or not the session is connected to a plan, so they are kept here, apart from
// the report (which only a signed-in session makes). An unreadable usage clears them: a frozen figure must not stand as current.
async function noteLimits($: any, limits: readonly SessionRateLimit[]): Promise<void> {
  await update($, pacingState, cur => ({ ...cur, limits: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })) }))
}

// The clock tick's (and the first) report: what `$.session.usage()` says now, never an earlier event's figure. A reading that fails clears the
// usage pacing windows (a frozen figure must not stand as current) and, for a signed-in session, is toasted by the report.
async function reportUsageNow($: any): Promise<void> {
  let reading: UsageReading
  try {
    reading = { limits: (await $.session.usage()).rateLimits }
  } catch (err: any) {
    reading = { error: errMessage(err) }
  }
  try {
    await noteLimits($, 'error' in reading ? [] : reading.limits)
  } catch (err: any) {
    // a tick runs with nobody awaiting it: writing the plugin's own state can only fail into the toast, never a rejection
    $.ui.toast(`Usage not reported to danxbot: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
    return
  }
  return reportUsage($, reading)
}

// DX-4339: the team's pacing settings (GET /api/team/pacing) and the account verdict (the DX-4340 cache) into the usage pacing state. The settings
// read's outcome is kept (`settingsRead`) so the band tells a quiet start or a session with no danxbot from a real error; a failed read keeps
// the last settings and toasts nothing (DX-4340's decision). The verdict is re-read every poll (danxbot itself changes it every 10 minutes, so
// a change shows within a poll or two). Run at session start and on the poll; a throw here is toasted, never an unhandled rejection.
async function refreshPacingView($: any): Promise<void> {
  try {
    const env = pacingEnv($)
    const fetched = await readTeamSettings(env.call)
    await refreshPacing(env, true)
    const now = await $.clock.now()
    const pacing = peekPacing(now)
    const verdict = pacing?.verdict ?? null
    const spend = pacing?.spend ?? null
    const readout = pacing?.readout ?? null
    await update($, pacingState, cur =>
      'settings' in fetched
        ? { ...cur, settings: fetched.settings, settingsRead: { state: 'ok' }, verdict, spend, readout }
        : { ...cur, settingsRead: fetched.read, verdict: null, spend: null, readout: null },
    )
  } catch (err: any) {
    $.ui.toast(`Usage pacing could not refresh: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
}

// danxbot says how often to report in every answer (its expiry is derived from that cadence), so the plugin carries only a first guess
// (USAGE_TICK_MS) and takes the server's value as soon as one answer arrives.
let usageEveryMs = USAGE_TICK_MS
function startUsageTicker($: any, everyMs: number): void {
  usageTicker?.cancel()
  usageEveryMs = everyMs
  usageTicker = $.clock.every(everyMs, () => reportUsageNow($))
}

// An API response arrived: the figure the harness holds is current as of now. Called when `session.measure` fires (after every main-thread
// turn and whenever a window moves) and when a sub-agent finishes (its burn moves the parent's figure, R-9), never from the tick.
async function markMeasured($: any): Promise<void> {
  const now = await $.clock.now()
  await update($, measuredAt, cur => (cur === null || now > cur ? now : cur))
}

// A window moved (or a turn ended): the event carries the windows as the harness has them.
async function onMeasure($: any, e: any, next: any) {
  await markMeasured($)
  // a measure that does not carry `rateLimits` says nothing about the windows: the last values stand (an empty array is the harness saying
  // there are none, and clears them)
  if (Array.isArray(e.rateLimits)) {
    await noteLimits($, e.rateLimits)
    void reportUsage($, { limits: e.rateLimits })
  }
  return next(e)
}

// ---- DX-4233: the plan event relay -------------------------------------------------------------------------------------------------
// The module's own loop on the session's danx-dashboard MCP server's `plan_events_wait` tool (PLAN-23 "Event relay in-process"): the
// server keeps the dashboard's stream open and answers each call with the events after the cursor (or none, when the wait ends);
// each event is handed to the session and the cursor of each delivered record stored. Nothing is spawned and no file is written: the
// loop is this module's code, so it lives as long as the process, through /clear and compaction, and ends with it. The server
// heartbeats the dashboard only while calls keep coming, so a dead or unloaded module reads as not healthy there.

// Which relay to run, from the view the last refresh read: the connected plan's, or the session's own (plan_id null) when signed in on no plan; none
// when signed out or revoked.
// A view that failed to load (`error`, `loading`) changes nothing: a read blip must not stop a working relay.
async function syncRelay($: any): Promise<void> {
  const v = await read($, view)
  // DX-4982: a blocked load says nothing of the key: the relay runs on, or is started by the watch, never stopped by it
  if (v.phase === 'error' || v.phase === 'blocked' || (v.phase === 'loading' && v.connected === null)) return
  // DX-4884: a ready view on no plan runs the relay for the session's own records (plan_id null); any other view (signed out, revoked) runs none
  if (!isSignedIn(v)) {
    relayHalted = null
    stopRelay()
    await stopKeepalive($)
    return
  }
  startRelay($, v.connected?.id ?? null)
}

// DX-4233: THE start of the relay, from a plan id however it was learned (the view, a plan_connect answer, the light plan read). Never async:
// the check that no loop runs for this plan and the registration of the new one are one step, so two starts landing together make one loop.
function startRelay($: any, planId: number | null): void {
  // DX-3900: the keepalive follows the plan connection, not the relay's health: a halted or ended relay does not end it.
  // DX-4884: it stays plan-only; a move to no plan ends it.
  if (planId === null) detach($, 'Plan tab keepalive stop', stopKeepalive($))
  else followPlan($, planId)
  if (relayRun !== null && relayRun.planId === planId) return
  // a halt belongs to the plan it happened on: any other plan starts a relay of its own
  if (relayHalted !== null && relayHalted.planId !== planId) relayHalted = null
  if (relayHalted !== null) return
  stopRelay()
  // DX-5398: what is still waiting for delivery stays for a run of the same plan (it polls on from there); another plan's events are dropped, and so is
  // the failure being retried when its event was one of them (the new plan's band must not keep the old plan's cause)
  const head = outbox[0]
  outbox = onlyPlan(outbox, planId)
  if (outbox[0] !== head) outboxFailure = null
  const run: RelayRun = { planId, dead: false, told: null, lacking: null, beat: 0 }
  relayRun = run
  if (stallTicker === null) stallTicker = $.clock.every(RELAY_STALL_CHECK_MS, () => detach($, 'Plan event relay stall check', checkRelayStall($)))
  detach($, 'Plan event relay', relayLoop($, run))
}

// DX-4233 / DX-4884: starts the relay (the plan's, or the session's own on no plan) when no loop runs, whatever became of the plan load: from the view when it knows the plan,
// else from a light read of the session's own plan binding (the view is an error or still loading, and its error is not a reason for no relay).
// `retry`: the read itself failed (the server not connected yet, a session not bound, a dashboard fault), so the plan is not known yet.
type RelayWatch = 'done' | 'retry'

// DX-4233: at most one watch runs; a burst of triggers (sub-agent events while the dashboard is down) shares its answer instead of each issuing a
// plan read. A handle, so a module variable.
let relayWatching: Promise<RelayWatch> | null = null
// A failure of the watch itself is toasted ONCE here (detach), however many callers share it, and answers `retry` to all of them.
function watchRelay($: any): Promise<RelayWatch> {
  if (relayWatching === null) {
    const watch = watchRelayOnce($)
    detach($, 'Plan event relay watch', watch)
    relayWatching = watch
      .catch((): RelayWatch => 'retry')
      .finally(() => {
        relayWatching = null
      })
  }
  return relayWatching
}

async function watchRelayOnce($: any): Promise<RelayWatch> {
  if (relayRun !== null) return 'done'
  const v = await read($, view)
  if (v.connected !== null) {
    startRelay($, v.connected.id)
    return 'done'
  }
  // DX-4884: a loaded view on no plan runs the session's own relay; the signed-out ones say what the read would
  if (v.phase === 'ready') {
    startRelay($, null)
    return 'done'
  }
  if (v.phase !== 'error' && v.phase !== 'blocked' && v.phase !== 'loading') return 'done'
  const plan = await withinDeadline($, RELAY_READ_DEADLINE_MS, sessionPlan($), (): SessionPlan => ({ kind: 'failed', reason: DEADLINE_REASON }))
  // a run that started while the read was out is the newer word (a connect, a load)
  if (relayRun !== null) return 'done'
  if (plan.kind === 'connected') {
    startRelay($, plan.planId)
    // DX-4982: the read that was refused now succeeds: the blocked view is replaced by a real load, never left standing
    if (v.phase === 'blocked') detach($, 'Plan refresh', refresh($, true))
    return 'done'
  }
  if (plan.kind === 'failed' && plan.refusal !== undefined) await tellRefusal($, plan.refusal)
  return plan.kind === 'failed' || plan.kind === 'unreachable' ? 'retry' : 'done'
}

// DX-4805 / DX-4982: the relay cannot start yet because the engine's auto mode classifier refused the plugin's own read: told to the session ONCE (the same
// words are not told again while the watch keeps retrying, as the refusal may clear), with the engine's words and the fix that works. A module
// variable: the text is per process, and a reload starts with nothing told.
let refusalTold: string | null = null
async function tellRefusal($: any, refusal: Refusal): Promise<void> {
  const line = refusedLine(refusal.detail, refusal.fix)
  if (refusalTold === line) return
  refusalTold = line
  await tellModel($, line)
}

// DX-4233: the session start's watch: the read is retried after each wait of RELAY_START_RETRY_MS while it fails; what is left after that is the
// watchdog (a turn's end, a sub-agent's start or stop) and the views' own loads.
async function startRelayWhenKnown($: any): Promise<void> {
  for (const wait of [0, ...RELAY_START_RETRY_MS]) {
    try {
      if (wait > 0) await $.clock.sleep(wait)
    } catch {
      // the wait rejects when the plugin's environment is unloaded (a reload): the watch ends with it
      return
    }
    if ((await watchRelay($)) === 'done') return
  }
}

// Ends the loop: its pending call is left to the server (a newer wait supersedes it, or it times out), and everything it answers late is
// ignored (relay state, cursor and delivery are each gated on `dead`). It leaves the relay state as it was: the band draws that state
// only for the plan it belongs to, and the next run of that plan writes its own first.
function stopRelay(): void {
  if (relayRun === null) return
  relayRun.dead = true
  relayRun = null
}

// DX-3900: the plan-tab keepalive (relay/keepalive.ts says why), for desktop sessions only: the 1800 s timeout is the desktop app's preview pane and
// a terminal session has no plan tab. "The desktop hosts this session" is sticky (`desktopHosted`): the app starts the session itself (surfaces() has
// 'desktop' at session.start, whose own `surface` is null), detaches about 5 s later and attaches again only while the person views it, so the
// surfaces at fire time say nothing. Raised at session.start by CLAUDE_CODE_ENTRYPOINT=claude-desktop (covers a resumed session nobody has
// viewed, whose surfaces() is []) or by surfaces() having 'desktop', and by any session.attach of the desktop; kept by a reload of the module
// (DX-4806: $.state, not a module variable). It follows the plan CONNECTION (`keepalivePlan`),
// set by startRelay and cleared when the plan is disconnected or the process ends, not the relay loop's health.
// One pending `$.clock.after` timer at a time, a slice of the wait (a handle, so module variables). An idle period starts at relay start and at every main-loop turn end
// (armKeepalive), and is recorded in `idleSince` ($.state) so a reload resumes it instead of restarting it; a turn start (which also clears
// `idleSince`), a plan move or the plan's end cancels it (cancelKeepalive). `keepaliveEpoch` makes a cancel reach an attempt already running:
// whatever it finds afterwards is dropped, nothing is sent or scheduled for a period that is over.
// DX-4952: the timer is never the whole wait. `$.clock.after` is a relative setTimeout, which does not count the time the computer sleeps, while
// `$.clock.now()` is the wall clock, which does (relay/keepalive.ts). Every wait is a slice of at most KEEPALIVE_WAKE_CHECK_MS, and the wall
// clock decides whether the attempt is due (`dueAt`, epoch ms), so a wake is noticed within a slice. A turn that starts after the wake finds
// the period stale (`idleSince` is a wall-clock time too) and has the session re-check the tab (recheckTab).
let keepalivePlan: number | null = null
let keepaliveTimer: { cancel: () => void } | null = null
let keepaliveEpoch = 0

function cancelKeepalive(): void {
  keepaliveEpoch++
  keepaliveTimer?.cancel()
  keepaliveTimer = null
}

async function stopKeepalive($: any): Promise<void> {
  keepalivePlan = null
  cancelKeepalive()
  await update($, idleSince, () => null)
}

// A fresh module (a load, a reload) that finds the plan arms from the period in `idleSince`; a move from one plan to another starts a period.
function followPlan($: any, planId: number): void {
  if (keepalivePlan === planId) return
  const resume = keepalivePlan === null
  keepalivePlan = planId
  detach($, 'Plan tab keepalive arm', armKeepalive($, resume))
}

// Starts the idle period: now, or (`resume`) the one in `idleSince` when there is one, whose attempt is due at once when its 25 minutes are past.
async function armKeepalive($: any, resume: boolean): Promise<void> {
  cancelKeepalive()
  if (keepalivePlan === null) return
  const epoch = keepaliveEpoch
  // DX-4806: a turn running now (a reload found it) arms nothing: its end does
  if ((await read($, turn)).isRunning) return
  const now = await $.clock.now()
  const since = (resume ? await read($, idleSince) : null) ?? now
  await startPeriod($, epoch, since, now)
}

// `since`: when the period began (its attempt is due KEEPALIVE_IDLE_MS on); `now`: the wall clock as the caller read it.
// A cancel while the write ran drops the period.
async function startPeriod($: any, epoch: number, since: number, now: number): Promise<void> {
  if (epoch !== keepaliveEpoch) return
  await update($, idleSince, () => since)
  if (epoch === keepaliveEpoch) waitSlice($, { epoch, dueAt: since + KEEPALIVE_IDLE_MS, deadline: null }, now)
}

// What the wait for one attempt holds: the epoch it belongs to, the wall-clock time the attempt is due (epoch ms), and the last time an attempt
// of this period may start (null until the first attempt starts, which sets it).
type KeepaliveWait = { epoch: number; dueAt: number; deadline: number | null }

// One slice of the wait: at most KEEPALIVE_WAKE_CHECK_MS, after which the wall clock is read again.
function waitSlice($: any, wait: KeepaliveWait, now: number): void {
  const slice = Math.min(KEEPALIVE_WAKE_CHECK_MS, Math.max(0, wait.dueAt - now))
  keepaliveTimer = $.clock.after(slice, () => detach($, 'Plan tab keepalive', keepaliveWake($, wait)))
}

async function keepaliveWake($: any, wait: KeepaliveWait): Promise<void> {
  keepaliveTimer = null
  const now = await $.clock.now()
  if (wait.epoch !== keepaliveEpoch) return
  if (now < wait.dueAt) return waitSlice($, wait, now)
  // an attempt that is long overdue (the computer slept through its time) has the retry window of its own, from when it starts: the network is
  // often still down just after a wake, and a window measured from the period's start would have closed hours ago (DX-4952)
  const deadline = wait.deadline ?? (now - wait.dueAt > KEEPALIVE_WAKE_CHECK_MS ? now : wait.dueAt) + KEEPALIVE_RETRY_WINDOW_MS
  await keepaliveAttempt($, wait.epoch, deadline)
}

// DX-4997: whether the session is in an unexpired agent pause (reports/pause.ts), by the one read that does not end it. Signed out, revoked, or
// on no plan: `nothing` (the caller has nothing to check either). A dashboard without the route (404) is free too, told once, never silently. Any other
// failure is returned, and the Stop check allows the stop.
async function readAgentPause($: any): Promise<PauseRead> {
  const r = await api($, 'GET', PAUSE_PATH)
  if (isNothingToCheck(r)) return { kind: 'nothing' }
  // a session that has made no dashboard call yet is not registered: it has no pause, and this is not an older dashboard
  if (r.status === 404 && isUnregisteredSession(r.body)) return { kind: 'free' }
  if (r.status === 404) {
    let first = false
    await update($, olderDashboardTold, cur => {
      first = !cur
      return true
    })
    if (first) $.ui.toast(OLDER_DASHBOARD_LINE)
    return { kind: 'free' }
  }
  if (!r.ok) return { kind: 'failed', reason: errText(r) }
  return pauseOf(r.body, await $.clock.now())
}

// What an attempt came to: the pane holds the plan page's tab (it was there, or has been opened again), the session is not on the desktop (nothing to
// keep open), the desktop has no Browser pane server in this session (nothing to look at), or why it failed.
type Fired = { kind: 'checked' } | { kind: 'not-desktop' } | { kind: 'no-browser' } | { kind: 'failed'; why: string }

// One attempt: look at the pane, then decide what comes next. A failure is toasted and retried KEEPALIVE_RETRY_MS later until `deadline`
// (KEEPALIVE_GIVE_UP_MS after the period began, or the end of the retry window of an attempt that woke late), then it gives up, loudly, and starts the next period.
// DX-5093: a look costs no model turn. A session whose tab is held (or opened again) is looked at again an idle period on, the cadence the keepalive
// always had, so a tab the person closes on purpose is not reopened more often than it was; so is a session that is not on the desktop at this
// moment (it may attach later; the surface is read now, not at session start) or has no Browser pane server (the app may add it later; it was told once).
async function keepaliveAttempt($: any, epoch: number, deadline: number): Promise<void> {
  const fired = await fireKeepalive($, () => epoch === keepaliveEpoch)
  const endedAt = await $.clock.now()
  // a cancel (a turn began, the plan ended or moved) while the attempt ran: whatever it found is dropped, nothing is toasted or scheduled
  if (epoch !== keepaliveEpoch) return
  if (fired.kind === 'checked' || fired.kind === 'not-desktop' || fired.kind === 'no-browser') return startPeriod($, epoch, endedAt, endedAt)
  if (endedAt + KEEPALIVE_RETRY_MS > deadline) {
    $.ui.toast(`Plan tab keepalive gave up: ${fired.why}`.slice(0, TOAST_ERROR_MAX))
    // DX-4806: a give-up ends this period only; the next is started here, not left to a turn end that an idle session never has
    return startPeriod($, epoch, endedAt, endedAt)
  }
  $.ui.toast(`Plan tab keepalive failed, trying again: ${fired.why}`.slice(0, TOAST_ERROR_MAX))
  waitSlice($, { epoch, dueAt: endedAt + KEEPALIVE_RETRY_MS, deadline }, endedAt)
}

// DX-5093: one call to the Browser pane's server, through the engine's own connection (relay/browser.ts says why a hook can). null: the session has no
// such server (the engine's own words); a rejection otherwise (a refused or timed-out call) is the caller's failure.
async function browserCall($: any, tool: BrowserTool, args: Record<string, unknown>): Promise<BrowserResult | null> {
  try {
    return (await $.mcp.call(BROWSER_SERVER, tool, args)) as BrowserResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no connected MCP tool/.test(message)) return null
    // DX-4982: auto mode refusing the pane's tool is told in a sentence, not the engine's raw text
    if (classifierRefusal(message) !== null) throw new Error(`${tool}: auto mode refused the call to the Browser pane; allow its tools in /permissions`)
    throw new Error(`${tool}: ${message}`)
  }
}

// DX-5093: a desktop-hosted, plan-connected session whose tool list has no callable Browser pane is never kept alive, and nothing else would say so:
// told once per session, in words that name the consequence. No prompt stands in for the pane (it could not tell whether the tab is missing, so it
// would ask every idle period again).
async function noBrowser($: any): Promise<Fired> {
  let first = false
  await update($, browserMissingTold, cur => {
    first = !cur
    return true
  })
  if (first) $.ui.toast(BROWSER_MISSING_LINE)
  return { kind: 'no-browser' }
}

// Looks at the Browser pane and opens the plan page's tab again when it is missing, with no model turn (DX-5093). `isLive` is checked again before
// the pane is changed. A closed pane is opened by `navigate` itself; an open pane without the tab gets a background tab of its own, so a page the
// person is reading is never navigated away.
async function fireKeepalive($: any, isLive: () => boolean): Promise<Fired> {
  let fired: Fired
  try {
    fired = await lookAtPane($, isLive)
  } catch (error) {
    fired = { kind: 'failed', why: error instanceof Error ? error.message : String(error) }
  }
  return fired
}

async function lookAtPane($: any, isLive: () => boolean): Promise<Fired> {
  if (!(await read($, desktopHosted))) return { kind: 'not-desktop' }
  const plan = (await read($, view)).connected
  // the page named is the one the view holds: a move is followed by a view refresh at once, and the arm that came with the move restarts the period
  if (plan === null) return { kind: 'failed', why: 'the connected plan is not loaded' }
  const page = planUrl(plan)
  try {
    const looked = await browserCall($, 'tabs_context', {})
    if (looked === null) return noBrowser($)
    const pane = paneState(looked)
    if (pane.kind === 'unreadable') return { kind: 'failed', why: pane.why }
    if (pane.kind === 'open' && holdsPlanTab(pane, page)) return { kind: 'checked' }
    if (!isLive()) return { kind: 'checked' }
    let tabId: string | undefined
    if (pane.kind === 'open') {
      const created = await browserCall($, 'tabs_create', {})
      if (created === null) return noBrowser($)
      const failure = failureOf('tabs_create', created)
      if (failure !== null) return { kind: 'failed', why: failure }
      const made = createdTab(created)
      if (made.kind === 'refused') return { kind: 'failed', why: made.why }
      tabId = made.tabId
    }
    const opened = await browserCall($, 'navigate', tabId === undefined ? { url: page } : { url: page, tabId })
    if (opened === null) return noBrowser($)
    const failure = failureOf('navigate', opened)
    return failure === null ? { kind: 'checked' } : { kind: 'failed', why: failure }
  } catch (error) {
    return { kind: 'failed', why: error instanceof Error ? error.message : String(error) }
  }
}

// DX-4952: a turn began after the app has closed the tab (an idle period older than the app's timeout that no attempt answered: the computer
// slept through it and the wake check did not run first). The turn's own end starts the next period, 25 minutes on, so the pane is looked at now
// and the plan page opened again if its tab is missing (no prompt). It follows the plan connection, not the keepalive epoch: the turn's own end
// restarts the period (bumping the epoch) and must not drop it.
async function recheckTab($: any): Promise<void> {
  const plan = keepalivePlan
  const fired = await fireKeepalive($, () => keepalivePlan === plan)
  if (keepalivePlan !== plan || fired.kind !== 'failed') return
  $.ui.toast(`Plan tab re-check failed: ${fired.why}`.slice(0, TOAST_ERROR_MAX))
}

// DX-4233: THE gate for what an ended run (a move to another plan, the process's end) may say: its relay state, the halt that follows from
// it and the line told to the model all come after this write, which does not happen for a dead run (false). The new run owns the state.
async function setRelay($: any, run: RelayRun, phase: RelayState['phase'], detail: string | null): Promise<boolean> {
  if (run.dead) return false
  await update($, relay, cur => (cur.phase === phase && cur.detail === detail && cur.planId === run.planId ? cur : { phase, planId: run.planId, detail }))
  // DX-5232: the events warning follows the relay's state (a write path, never the draw)
  await noteEventsWarning($)
  return true
}

// One failure, shown in the band's events warning and told to the session ONCE (the same text is not told again until a wait succeeds).
// `stopped` also halts the relay for this plan until something asks for it again (syncRelay).
async function relayFailed($: any, run: RelayRun, phase: 'retrying' | 'stopped', detail: string, line: string): Promise<void> {
  if (!(await setRelay($, run, phase, detail))) return
  if (phase === 'stopped') relayHalted = { planId: run.planId }
  if (run.told === line) return
  run.told = line
  await tellModel($, line)
}

// An error nothing anticipated stopped the run (the loop's own, or the pump's cursor store): shown in the band and told once.
async function haltRelay($: any, run: RelayRun, err: any): Promise<void> {
  const detail = `the relay hit an error: ${errMessage(err)}`
  await relayFailed($, run, 'stopped', RELAY_ERROR_FIX, stoppedLine(detail, RELAY_ERROR_FIX))
}

async function loadCursor($: any, planId: number | null): Promise<string | null> {
  return cursorFor(await $.store.get(cursorKey(await $.session.id())), planId)
}

// The cursor is stored AFTER the event was delivered, under the session id as it is now (a /clear or a resume changes it).
// DX-4233: an event of a plan the session has since left must not write over the new plan's cursor. DX-5398: a delivery outlives the run that polled
// it (a run replaced while its prompt waited), so the gate is the plan the live run serves, not the run that took the event.
async function saveCursor($: any, planId: number | null, cursor: string): Promise<void> {
  if (relayRun === null || relayRun.planId !== planId) return
  await $.store.set(cursorKey(await $.session.id()), { planId, cursor, at: await $.clock.now() })
}

// The store keeps one record per session ever held: the oldest past CURSOR_KEEP go.
async function pruneCursors($: any): Promise<void> {
  const entries: { key: string; at: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(CURSOR_PREFIX)) continue
    const rec: any = await $.store.get(key)
    entries.push({ key, at: typeof rec?.at === 'number' ? rec.at : 0 })
  }
  for (const key of staleCursorKeys(entries)) await $.store.delete(key)
}

// A prompt that wakes an idle session (or queues behind the running turn). Null when it entered, else why it did not.
async function submitEvent($: any, line: string): Promise<string | null> {
  try {
    const r = await $.prompt.submit({ text: line })
    return typeof r?.drop === 'string' ? notTakenLine(r.drop) : null
  } catch (err: any) {
    return notTakenLine(errMessage(err))
  }
}

// A note the model reads in the turn that is running. A refused or throwing append is a failure like any other (no silent fallback to
// a prompt): the event is not delivered, the cursor does not move, and the loop's backoff asks for it again.
async function appendNote($: any, line: string): Promise<string | null> {
  try {
    const r = await $.session.append(modelRow(line))
    return typeof r?.deny === 'string' ? notTakenLine(r.deny) : null
  } catch (err: any) {
    return notTakenLine(errMessage(err))
  }
}

// One event into the session, the same `[danxbot plan event] ...` text as ever, by the one decision in relay/delivery.ts (DX-4721): a non-urgent
// event is a prompt (queued behind a running turn, waking an idle session); an urgent one is a note in a running turn.
// DX-5398: resolves as soon as the engine call has been MADE; `done` settles with the outcome, null when delivered, else the cause. A plugin's
// `$.prompt.submit` settles only when the queued prompt enters the session (after the running turn), so a caller that must not wait for that (the
// relay's pump, relay/outbox.ts) issues the next event while `done` is still out, and a caller that must (deliverEvent) awaits it.
async function issueEvent($: any, text: string, urgent: boolean): Promise<{ done: Promise<string | null> }> {
  if (deliveryMode(urgent, (await read($, turn)).isRunning) === 'prompt') return { done: submitEvent($, relayLine(text)) }
  return { done: appendTrackedNote($, text) }
}

// A note into the running turn, and the turn atom told of it (noteAppended): a turn that ends with no tool result after the note tells it once as a prompt
// (promptNotes), so no note is stranded. The one place a note is appended for an event (issueEvent, and the resume briefing of a turn that began during its reads).
async function appendTrackedNote($: any, text: string): Promise<string | null> {
  const failure = await appendNote($, relayLine(text))
  if (failure !== null) return failure
  // `prompt` is set inside the updater, which sees the turn as it is when the write happens
  let prompt = null as string | null
  await update($, turn, cur => {
    const appended = noteAppended(cur, text)
    prompt = appended.prompt
    return appended.turn
  })
  if (prompt !== null) detach($, 'Telling the session', promptNotes($, [prompt]))
  return null
}

// One event delivered, awaited: null when delivered, else the cause.
async function deliverEvent($: any, text: string, urgent: boolean): Promise<string | null> {
  return (await issueEvent($, text, urgent)).done
}

// DX-4721: notes nothing will read (the turn ended after them, with no tool result between), each told once more as a prompt that says it is a
// repeat, in order; every note is tried even when an earlier one was refused. Detached from the hook or delivery that found them: a prompt
// the session did not take is a toast.
async function promptNotes($: any, texts: string[]): Promise<void> {
  for (const text of texts) {
    const failure = await submitEvent($, repeatLine(text))
    if (failure !== null) $.ui.toast(`Plan events not told to the session: ${failure}`.slice(0, TOAST_ERROR_MAX))
  }
}

// DX-5398: the outbox (relay/outbox.ts says why the poll loop does not deliver). The records of one answer are queued in the order the server sent them
// and issued to the session in that order, each as soon as the one before it has been ISSUED (a prompt queued behind a running turn is out, not done, and
// must not hold the next event: an urgent note behind it is for the running turn). Each one's cursor is stored as the resume cursor once it is DELIVERED,
// in order (never compared with another: the server decides what comes after a cursor). An event the session refuses is issued again after the backoff,
// and the band says so. The poll acknowledges a taken event to the server (which then drops it), so every queued event is also written to the `relayOutbox`
// atom BEFORE the poll that carries its cursor, and removed from it once delivered: a reload of this module (which empties `outbox`) finds them there and
// issues them again (`restoreOutbox`). A reload can repeat any event still in the atom: one issued and not yet delivered (the engine's own queue is not ours to
// read), including an urgent note already appended behind a waiting prompt (it stays in the atom until that prompt settles); a duplicate, never a loss. A NEW process starts with no atom: the stored resume cursor is then what the server resumes from.
// Both functions are idempotent and single-flight: whoever queues, starts a run, or finishes an event calls them.
let outboxIssuing = false
let outboxSettling = false
// the cause of the delivery failure being retried, null when none: the poll's own success must not draw over it (handleAnswer)
let outboxFailure: string | null = null

async function queueEvents($: any, run: RelayRun, events: RelayEvent[]): Promise<void> {
  for (const event of events) outbox.push({ planId: run.planId, event, done: null })
  // the copy first: the next poll presents these cursors, and the server drops what they cover
  await persistOutbox($)
  detach($, 'Plan event delivery', issueOutbox($))
}

// The atom holds exactly what `outbox` holds; every change to `outbox` is followed by this write.
async function persistOutbox($: any): Promise<void> {
  // the snapshot is taken inside the update, so overlapping saves each write what `outbox` holds when they run, never an older copy
  await update($, relayOutbox, () => toPending(outbox))
}

// A run's start: a reloaded module has an empty outbox, so what the atom kept for this plan is the outbox again (another plan's events are dropped, as a
// move drops them). Then whatever waits is issued: the run that polls on from its newest cursor never asks the server for it again.
async function restoreOutbox($: any, run: RelayRun): Promise<void> {
  const saved = fromPending(await read($, relayOutbox), run.planId)
  if (outbox.length === 0) outbox = saved
  await persistOutbox($)
  if (outbox.length > 0) detach($, 'Plan event delivery', issueOutbox($))
}

async function issueOutbox($: any): Promise<void> {
  if (outboxIssuing) return
  outboxIssuing = true
  try {
    for (;;) {
      const next = outbox.find(q => q.done === null)
      // no live run on that plan: the events wait for a run that serves it (startRelay starts this again)
      if (next === undefined || relayRun === null || relayRun.planId !== next.planId) return
      next.done = (await issueEvent($, next.event.text, next.event.urgent)).done
      detach($, 'Plan event delivery', settleOutbox($))
    }
  } finally {
    outboxIssuing = false
  }
}

async function settleOutbox($: any): Promise<void> {
  if (outboxSettling) return
  outboxSettling = true
  let failures = 0
  try {
    for (;;) {
      const head = outbox[0]
      if (head === undefined || head.done === null) return
      const failure = await head.done
      // a move to another plan dropped it while it was out
      if (outbox[0] !== head) continue
      const live = relayRun !== null && relayRun.planId === head.planId ? relayRun : null
      if (failure !== null) {
        outboxFailure = failure
        if (live !== null) await relayFailed($, live, 'retrying', failure, delayedLine(failure))
        failures++
        await $.clock.sleep(backoffMs(failures))
        if (outbox[0] === head) head.done = null
        detach($, 'Plan event delivery', issueOutbox($))
        continue
      }
      outbox.shift()
      failures = 0
      outboxFailure = null
      // the cursor first: a reload between the two repeats this event, where the other order would lose the resume point
      await saveCursor($, head.planId, head.event.cursor)
      await persistOutbox($)
      if (live !== null) {
        live.told = null
        await setRelay($, live, 'streaming', null)
      }
    }
  } catch (err: any) {
    // the cursor store failing is the loop's own kind of error (an unexpected one): the relay stops for the plan, never restarted behind the person's back
    const run = relayRun
    if (run !== null) {
      await haltRelay($, run, err)
      stopRelay()
    }
  } finally {
    outboxSettling = false
  }
}

// DX-5398: the stall watch, every RELAY_STALL_CHECK_MS. A loop that has made no step for RELAY_STALL_MS is awaiting a call that never settles (the poll,
// the cursor store, the plan read): nothing it could say reaches anyone, so the watch tells the person (a toast) and the session (a note, detached: the
// note's own call is one of the things that may be stuck), then starts the relay again. Events in flight are not lost or repeated (the outbox).
async function checkRelayStall($: any): Promise<void> {
  const run = relayRun
  const now = await $.clock.now()
  // the clock is the wall clock, which keeps running while the machine sleeps and the loop's call cannot answer: a tick that is itself far later than its
  // interval is the machine waking, and judging it would report a stall nobody had. The watch starts counting again from here.
  const woke = isLateTick(now, stallTickAt, RELAY_STALL_CHECK_MS)
  stallTickAt = now
  if (run === null) {
    stallSeen = null
    return
  }
  if (woke || stallSeen === null || stallSeen.run !== run) {
    stallSeen = { run, since: now }
    return
  }
  if (relayRun !== run || !isStalled(now, run.beat, stallSeen.since, RELAY_STALL_MS)) return
  const seconds = Math.round((now - Math.max(run.beat, stallSeen.since)) / 1000)
  stallSeen = null
  $.ui.toast(stalledNotice(seconds).slice(0, TOAST_ERROR_MAX))
  detach($, 'Telling the session', tellModel($, stalledLine(seconds)))
  stopRelay()
  startRelay($, run.planId)
}

// DX-4233: the engine words a tool the server lacks the same as a server that is not connected ("no connected MCP tool"), so that answer is told
// apart by the session's tool list: the plugin server's tools listed without the relay's is evidence of an old pinned server; none listed (the
// server is not connected yet or has gone), or a list that cannot be read (not bound), is none.
async function serverLacksRelayTool($: any): Promise<boolean> {
  let names: string[]
  try {
    names = (await $.tool.list()).map((t: any) => t.name)
  } catch {
    return false
  }
  const ownTools = names.filter(name => name.startsWith(toolName('')))
  return ownTools.length > 0 && !ownTools.includes(toolName(RELAY_TOOL))
}

// DX-4233: what the evidence (a failed wait with the plugin server's tools listed but not the relay's) comes to. It is proof only after
// OLD_SERVER_AFTER_FAILURES of them in a row spanning OLD_SERVER_AFTER_MS: with the backoff that is the 4th failure (3 counted, the 8 s passed). Then the
// dashboard is asked afresh, because the list is dynamic: it lags a sign-in or a grant, and shrinks to the bootstrap tools at a key loss.
//   null: no proof yet (too early, or the dashboard could not say): the run retries.
//   old-server: the session is signed in and still on this run's plan, and the server has no such tool.
//   signed-out: the session is signed out, or on another plan or none: this run has nothing to serve, so it ends the way the real signed-out
//   answer ends it (off, halted for this plan, nothing told) instead of retrying for good.
async function oldServerVerdict($: any, run: RelayRun): Promise<WaitAnswer | null> {
  const now = await $.clock.now()
  run.lacking = run.lacking === null ? { count: 1, since: now } : { count: run.lacking.count + 1, since: run.lacking.since }
  if (run.lacking.count < OLD_SERVER_AFTER_FAILURES || now - run.lacking.since < OLD_SERVER_AFTER_MS) return null
  const plan = await sessionPlan($)
  if (plan.kind === 'failed' || plan.kind === 'unreachable') return null
  // DX-4884: a run on no plan is still this run's while the session is on no plan
  const same = run.planId === null ? plan.kind === 'not-connected' : plan.kind === 'connected' && plan.planId === run.planId
  return same ? { kind: 'old-server' } : { kind: 'signed-out' }
}

async function waitForEvents($: any, run: RelayRun, cursor: string | null): Promise<WaitAnswer> {
  const path = await read($, transcript)
  try {
    const got = readWaitAnswer(await $.mcp.call(SERVER, RELAY_TOOL, waitArgs(run.planId, cursor, path)))
    run.lacking = null
    return got
  } catch (err: any) {
    const message = errMessage(err)
    const lacksTool = isServerNotConnected(message) && (await serverLacksRelayTool($))
    if (!lacksTool) {
      run.lacking = null
      return classifyText(message)
    }
    return (await oldServerVerdict($, run)) ?? classifyText(message)
  }
}

// What one answer to a wait asks of the loop: `again` (the next wait, at once), `retry` (the next wait after the backoff: the answer or its
// delivery failed) or `end` (signed out, or the server said it cannot go on). `cursor` is the loop's, moved by the events delivered.
type Handled = { next: 'again' | 'retry' | 'end'; cursor: string | null }

async function handleAnswer($: any, run: RelayRun, got: WaitAnswer, cursor: string | null, startedAt: number): Promise<Handled> {
  if (got.kind === 'events') {
    // DX-4233: an ended run takes nothing (its events are the new run's to ask for)
    if (run.dead) return { next: 'end', cursor }
    // DX-5398: the events are queued, never delivered here; the poll goes on at once from the newest cursor taken
    // DX-4982: a wait answered, so the calls are allowed again: a blocked view is replaced by a real load
    if ((await read($, view)).phase === 'blocked') detach($, 'Plan refresh', refresh($, true))
    await queueEvents($, run, got.events)
    const last = got.events[got.events.length - 1]
    // the refresh is detached (DX-4586): the environment going away under it is not a failure
    if (last !== undefined) detach($, 'Plan refresh', refresh($, true))
    // a delivery being retried keeps the band's retrying state: a poll that works says nothing about it
    if (outboxFailure === null) {
      run.told = null
      await setRelay($, run, 'streaming', null)
    }
    // a server that answers an empty list at once is not a wait: sleep the rest of the round
    const took = (await $.clock.now()) - startedAt
    if (last === undefined && took < MIN_ROUND_MS) await $.clock.sleep(MIN_ROUND_MS - took)
    return { next: 'again', cursor: last === undefined ? cursor : last.cursor }
  }
  if (got.kind === 'signed-out') {
    // the band already says it (and offer Sign in unless a person revoked the key): nothing more is told
    if (await setRelay($, run, 'off', null)) relayHalted = { planId: run.planId }
    return { next: 'end', cursor }
  }
  if (got.kind === 'refused') {
    // DX-4982: the person sees the sentence and fix; the session is told once with the engine's words. Retried on the backoff: it resumes once the calls are allowed.
    await relayFailed($, run, 'retrying', BLOCKED_LINE, refusedLine(got.detail, got.fix))
    return { next: 'retry', cursor }
  }
  if (got.kind === 'stopped' || got.kind === 'old-server') {
    const detail = got.kind === 'stopped' ? got.detail : OLD_SERVER_DETAIL
    const fix = got.kind === 'stopped' ? got.fix : OLD_SERVER_FIX
    await relayFailed($, run, 'stopped', fix, stoppedLine(detail, fix))
    return { next: 'end', cursor }
  }
  await relayFailed($, run, 'retrying', got.message, delayedLine(got.message))
  return { next: 'retry', cursor }
}

async function relayLoop($: any, run: RelayRun): Promise<void> {
  let failures = 0
  try {
    // the run's first word comes before any await of its own: until then the band would still show the state the last run of this plan left
    await setRelay($, run, 'streaming', null)
    await pruneCursors($)
    await restoreOutbox($, run)
    // DX-5398: on from the newest event still waiting in the outbox (a run replacing a stuck one, or a reloaded module), else from the stored cursor
    let cursor = pollCursor(outbox, run.planId, await loadCursor($, run.planId))
    let keyedBy = await $.session.id()
    // DX-4233: the loop ends with its run; what a late answer would say is gated in setRelay and handleAnswer
    while (!run.dead) {
      const startedAt = await $.clock.now()
      run.beat = startedAt
      const got = await waitForEvents($, run, cursor)
      // a /clear or a resume gives the process another session id: the stored cursor (the last DELIVERED event's, not the polled one) moves with it
      const sid = await $.session.id()
      if (sid !== keyedBy) {
        const stored = await $.store.get(cursorKey(keyedBy))
        keyedBy = sid
        const delivered = cursorFor(stored, run.planId)
        if (delivered !== null) await saveCursor($, run.planId, delivered)
      }
      const handled = await handleAnswer($, run, got, cursor, startedAt)
      cursor = handled.cursor
      if (handled.next === 'end') return
      if (handled.next === 'again') {
        failures = 0
        continue
      }
      failures++
      run.beat = await $.clock.now()
      await $.clock.sleep(backoffMs(failures))
    }
  } catch (err: any) {
    // An error nothing above anticipated halts the relay for this plan, shown in the band and told once, never restarted by a refresh
    // behind the person's back (an ended run says nothing: relayFailed's gate). When the environment itself is gone the writes below
    // reject, and settleDetached (the loop's caller) is what drops that one rejection.
    await haltRelay($, run, err)
  } finally {
    if (relayRun === run) relayRun = null
  }
}

// DX-3900: the desktop attached (it does so again each time the person views the session): it hosts this one from now on
async function onSessionAttach($: any, e: any, next: any) {
  if (e.surface === 'desktop') await update($, desktopHosted, () => true)
  return next(e)
}

async function onSessionStart($: any, e: any, next: any) {
  // DX-3900 / DX-4806: only ever raised here, never cleared. A reload of this module (the app's reload_plugins, paced to when the session is hidden) fires
  // session.start with the desktop detached (surfaces() is []); a flag set from that would forget the desktop hosts the session. `desktopHosted` is
  // $.state, which a reload keeps and a new process starts without.
  // DX-4806: the desktop app sets CLAUDE_CODE_ENTRYPOINT=claude-desktop on every process it spawns (fresh or resumed; a reload keeps the process and the atom); a terminal reads `cli`. A resumed
  // session nobody has viewed yet has no attach and a detached roster, so the environment is the source that names its host.
  if ((await $.session.surfaces()).includes('desktop') || (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop') {
    await update($, desktopHosted, () => true)
  }
  await unpinStatus($)
  await $.command.register({ name: COMMAND, description: 'Show the danxbot plan band (connection + open problems)' })
  // a new process or a reload cannot have a write in flight: no key claimed before it is still held
  await update($, busy, () => [])
  await update($, modelPlan, () => null)
  // DX-4630: nor a sign-in request: its watch died with the old process
  await update($, signInRequest, () => null)
  // DX-4233: no plan polling timer (the relay's events, the turns and the sub-agents refresh the view). DX-4339: the pacing has no
  // event to ride, so only it is read on the poll
  pacingTicker?.cancel()
  pacingTicker = $.clock.every(PACING_POLL_MS, () => refreshPacingView($))
  startUsageTicker($, USAGE_TICK_MS)
  // DX-5231: a reload starts with no compaction check: the sync below arms it again when the session is under the handshake (syncCompactionTicker)
  compactionTicker?.cancel()
  compactionTicker = null
  await syncCompaction($, { start: false })
  // DX-4530: a reload starts with no fast poll; requests still open in $.state need it again
  permissionTicker?.cancel()
  permissionTicker = null
  await syncPermissionPoll($)
  // DX-4340: a new session starts with no pacing state (never the previous session's last good answer) and reads the verdict now; later reads are the usage pacing poll, a sub-agent start when the cache is a minute old, and every spawn
  resetPacing()
  detach($, 'Usage pacing', refreshPacingView($))
  detach($, 'Plan refresh', refresh($, true).then(() => reportUsageNow($)).then(() => retryWhileNotConnected($)))
  // DX-4233: the relay does not wait for that load: it starts from the plan the session is on, and is looked for again while the read fails
  detach($, 'Plan event relay start', startRelayWhenKnown($))
  return next(e)
}

// Reasons after which the process is gone. `clear` and `resume` end THIS session but the process
// goes on, and no session.start follows a /clear: the timers and the relay must keep running then, or
// the band shows stale data and no event arrives for the rest of the process. Any reason not listed keeps them
// too: stopping a timer in a live process is the harm, a timer left in a dying one is not.
const PROCESS_ENDS = ['prompt_input_exit', 'logout', 'other']

async function onSessionEnd($: any, e: any, next: any) {
  if (e.reason === 'clear' && typeof e.sessionId === 'string') await update($, endedSession, () => e.sessionId)
  // DX-4548: the sign-in watch belongs to the conversation that started it
  if (PROCESS_ENDS.includes(e.reason) || e.reason === 'clear' || e.reason === 'resume') {
    signInGeneration++
    await update($, signInRequest, () => null)
    // DX-4548: free the sign-in key at once; the aborted watch's in-flight plan_connect (up to ~45s) must not hold it
    await update($, busy, cur => cur.filter(k => k !== busyKey.signIn))
  }
  if (PROCESS_ENDS.includes(e.reason)) {
    // DX-4233: the relay ends with the process; a /clear or a resume goes on (its loop is module code, and the refresh below
    // restarts it only if the new conversation is on another plan)
    stopRelay()
    await stopKeepalive($)
    pacingTicker?.cancel()
    pacingTicker = null
    usageTicker?.cancel()
    usageTicker = null
    stallTicker?.cancel()
    stallTicker = null
    stallTickAt = null
    compactionTicker?.cancel()
    compactionTicker = null
    permissionTicker?.cancel()
    permissionTicker = null
  } else if (e.reason === 'clear' || e.reason === 'resume') {
    // DX-4508: another conversation: its sub-agents and transcript are not this one's
    await update($, liveAgents, () => [])
    // DX-4982: nor is the plan its model named
    await update($, modelPlan, () => null)
    await update($, transcript, () => null)
    // a fresh conversation (or another session taking this one's place) in the same process: what
    // the dashboard shows may have moved while they were in the old one
    detach($, 'Plan refresh', refresh($, true))
  }
  return next(e)
}

async function onCommand($: any) {
  await showPlan($)
  detach($, 'Plan refresh', refresh($, true))
  return { text: 'Plan band shown.' }
}

// The model connected (or moved) this session: show it at once. A signed-out session's `approval_required`
// answer draws the approval link and the code in the band; the plan page is not opened (there is
// no connection to show yet).
async function onPlanConnect($: any, e: any, next: any) {
  // DX-4235: the model's leave, or its move to another plan, closes what the session opened under the plan it is on first; a leave or move
  // its answer says did not happen takes that back
  const leaving = e.disconnect === true
  const why = leaving ? 'leaving the plan' : `moving to plan ${e.plan_id}`
  const moving = !leaving && typeof e.plan_id === 'number' && (await movesOffReportedPlan($, e.plan_id))
  const closes = leaving || moving ? await closeOwedBeforeLeave($, why) : null
  let ran
  try {
    ran = await next(e)
  } catch (err) {
    // the call itself failed: nothing left or moved
    await settleLeave($, closes, false, why)
    throw err
  }
  const answer = textOutcome(typeof ran.text === 'string' ? ran.text : '', ran.isError === true || ran.deny !== undefined)
  await settleLeave($, closes, leaving ? answer.ok : answer.ok && answer.body?.session?.planId === e.plan_id, why)
  // DX-4233: the model's plan_connect starts the relay (or restarts it on a move to another plan) from the plan the answer says it connected, not
  // from the view the refresh below loads (a load that is slow or fails must not keep the relay down)
  relayHalted = null
  // DX-4982: parsed once; what the blocked view names when the plugin's own reads are refused
  const modelConnected = connectedPlanOf(ran.text)
  if (modelConnected !== null) startRelay($, modelConnected.id)
  if (modelConnected !== null) await update($, modelPlan, () => modelConnected)
  else if (leaving && answer.ok) await update($, modelPlan, () => null)
  detach($, 'Plan refresh', refresh($, true).then(() => reportUsageNow($)))
  const approval = approvalRequestOf(ran.text, ['approval_required', 'approval_pending'])
  if (approval === null) return ran
  const waiting = await read($, signInRequest)
  // a request with no id cannot be told once, so it is refused before anything is drawn (as permissionRequestOf refuses one):
  // nothing stays in $.state for it
  if (waiting === null && publicIdOf(approval.url) === undefined) {
    $.ui.toast(signInFailedToast('the approval request had no id'))
    return withSignInNote(ran, approval)
  }
  // DX-4548: a request is shown by its URL, never by the answer's state: a request renewed after an expiry answers
  // `approval_pending` to the model's next call and must still reach the person
  if (waiting?.url !== approval.url) await showSignInRequest($, approval)
  // the model started this sign-in, so the plugin waits on it and tells the model how it ended
  if (waiting === null) {
    const args = { ...(typeof e.plan_id === 'number' ? { plan_id: e.plan_id } : {}), ...(typeof e.title === 'string' && e.title !== '' ? { title: e.title } : {}) }
    void watchSignIn($, { args, byPress: false, known: approval }).catch(err => toastCallFailedAndReload($, 'Sign in failed', err))
  }
  return withSignInNote(ran, approval)
}

// DX-4435: the model asked for a permission: keep the request for the band, which draws its approval link and code at once
// (DX-4630: no page is opened by the plugin), and toast both.
async function onRequestPermission($: any, e: any, next: any) {
  const ran = await next(e)
  const request = permissionRequestOf(ran.text, e.permissions)
  if (request === null) return ran
  await update($, permissionRequests, cur => [...cur.filter(r => r.publicId !== request.publicId), request])
  await syncPermissionPoll($)
  const approval = asApproval(request)
  toastPermission($, approval)
  return withPermissionNote(ran, approval)
}

async function trackAgent($: any, agentId: unknown, isStart: boolean): Promise<void> {
  if (typeof agentId !== 'string' || agentId === '') return
  const now = await $.clock.now()
  await update($, liveAgents, cur => (isStart ? [...liveAgentsAt(cur, now).filter(a => a.id !== agentId), { id: agentId, since: now }] : cur.filter(a => a.id !== agentId)))
}

async function onSubagentChange($: any, e: any, next: any, isStart: boolean) {
  await noteTranscript($, e)
  const r = await next(e)
  // DX-4336: the running-agent count follows the sub-agents' starts and stops; a finished one's last response also moved the parent's figure
  await trackAgent($, e.agent_id, isStart)
  // DX-5344: a sub-agent that stopped owes no briefing, and must not make a later restart read as its own
  if (!isStart) await forgetCompactingAgent($, e.agent_id)
  if (!isStart) await markMeasured($)
  detach($, 'Plan refresh', refresh($))
  void watchRelay($)
  return r
}

// DX-4234: the time line. One stamp per prompt and per tool call, counted from the last one (any hook, any agent: one session, one clock).
async function timeLine($: any): Promise<string> {
  const now = await $.clock.now()
  const offsetMinutes = -new Date(now).getTimezoneOffset()
  // the line is set inside the updater, which sees the last stamp as it is when the write happens
  let line = ''
  await update($, lastStamp, last => {
    const next = nextStamp(now, offsetMinutes, last)
    line = next.line
    return next.state
  })
  return line
}

// The one-shot state reads below take a value and clear it in one write, so two callers landing together get it once. The engine's scan wants each
// `update` to name its atom, so each atom has its own take.
async function takePendingStart($: any): Promise<PendingStart> {
  let taken: PendingStart = null
  await update($, pendingStart, cur => {
    taken = cur
    return null
  })
  return taken
}

async function takeEndedSession($: any): Promise<string | null> {
  let taken: string | null = null
  await update($, endedSession, cur => {
    taken = cur
    return null
  })
  return taken
}

// A pending session start is told once: the next prompt or tool result, whichever comes first, carries its line beside the stamp (a start with no
// prompt coming, such as a compaction in the middle of a turn, reaches the model on the next tool result). It is gone once taken, so work that throws is one warning line here, never a rejected hook that
// would lose the time stamp beside it.
async function renderStart($: any, start: NonNullable<PendingStart>): Promise<string | null> {
  try {
    return await sessionContext($, start)
  } catch (err: any) {
    const event = sessionEvent(start.source)
    return event === null ? null : eventFailureLine(event, `error: ${String(err?.message ?? err).slice(0, CALL_ERROR_MAX)}`)
  }
}

// the stamp and, when there is one, the session start line: the entries a hook adds to the model's context.
// DX-4736: the start is TAKEN and the clock STAMPED in the one order of arrival, before the start's own slow reads. Two hooks landing together
// (a fresh desktop session's first prompt runs the hook twice) otherwise let the one without the start stamp first (the full date) while the one
// the model reads, holding the start, stamped second: no date and +0s. Whoever takes the start now also takes the first stamp.
async function stampEntries($: any, takeStart: boolean): Promise<string[]> {
  const pending = takeStart ? await takePendingStart($) : null
  const line = await timeLine($)
  if (pending === null) return [line]
  const start = await renderStart($, pending)
  return start === null ? [line] : [line, start]
}

// the prompt as typed (a task notification included) reaches the model with its time beside it, and with the session start it carries, if any
async function onPromptStamp($: any, e: any, next: any) {
  return next({ ...e, context: [...(e.context ?? []), ...(await stampEntries($, true))] })
}

// each tool call's result reaches the model with the time it finished beside it; a denied call has no result to put it beside. The MAIN loop's
// result also carries the session start, if any: a call with an `agentId` is a sub-agent's or an engine fork's, and the start is the main session's
async function onToolStamp($: any, e: any, next: any) {
  const r = await next(e)
  // DX-4857: a plugin's own `$.mcp.call` (this one's dashboard reads) is raised as a `tool.call` too, with no agentId. Its result goes to the plugin,
  // never the model, so a stamp or the start text put beside it is lost, and the stamp would move the clock the model reads. The signal is the
  // documented `next.origin` (`e.origin` does not exist on tool.call): `engine` for the model's call, the plugin's name for one it raised (DX-4857
  // comment 13414 and the code-quality gate's real-engine probe). These calls also carry `toolu_plugin_` ids on 2.1.295, which is not relied on.
  // Returning here also skips the lastStamp bookkeeping. Seated by tests/on-tool-stamp-origin-scan.test.mjs.
  if (raisedByPlugin(next.origin)) return r
  // DX-4721: the main loop's result carries the notes appended so far: they are read (a sub-agent's or a fork's result is not the main loop's)
  if (e.agentId === undefined && (await read($, turn)).pending.length > 0) await update($, turn, cur => toolResultSent(cur))
  // DX-4235: a background shell's start, and a working sub-agent's liveness
  detach($, 'danxbot activity report', reportShellStart($, e, r))
  if (e.agentId !== undefined) detach($, 'danxbot activity report', reportSubagentAlive($, e.agentId))
  if (r.deny !== undefined) return r
  // DX-5344: a sub-agent's compaction briefs that sub-agent, in its own tool result
  const briefing = e.agentId === undefined ? null : await takeAgentBriefing($, e.agentId)
  return { ...r, context: [...(r.context ?? []), ...(await stampEntries($, e.agentId === undefined)), ...(briefing === null ? [] : [briefing])] }
}

// DX-4234: what the dashboard says of this session's plan. `silent`: nothing can be said, never a line: the plugin's server is not there, or
// the session holds no key or a person revoked it (its own tools already tell the model). `failed`: the read itself broke (a dashboard fault).
// DX-4233: `connected` carries the plan the session is on (the relay starts from it); `unreachable` is the plugin's server not connected yet (quiet to
// the model, retried by the relay's start).
type SessionPlan = { kind: 'connected'; planId: number } | { kind: 'not-connected' } | { kind: 'silent' } | { kind: 'unreachable' } | { kind: 'failed'; reason: string; refusal?: Refusal }

// The ONE place a key that is gone or revoked is made quiet (its own tools say so, never a failure line): this read is the first of every
// context lookup, so a later read that finds the key gone in between is an ordinary failure line.
async function sessionPlan($: any): Promise<SessionPlan> {
  const r = await api($, 'GET', '/api/plans', { query: SESSION_PLAN_PROBE })
  if (r.unreachable === true) return { kind: 'unreachable' }
  if (isSignedOut(r) || outcomeRevokedBy(r) !== null) return { kind: 'silent' }
  if (!r.ok) return { kind: 'failed', reason: errText(r), refusal: r.refusal }
  if (!('session' in (r.body ?? {}))) return { kind: 'failed', reason: 'bad_response: GET /api/plans answered no session field' }
  if (r.body.session === null) return { kind: 'not-connected' }
  const planId = r.body.session.plan_id
  return typeof planId === 'number' ? { kind: 'connected', planId } : { kind: 'failed', reason: 'bad_response: GET /api/plans answered a session with no plan_id' }
}

// Whether the session is KNOWN to be on a plan without asking the dashboard: the connection record the danx-dashboard MCP server writes
// at `plan_connect` (`~/.config/danxbot/plan-sessions/<session id>.json`, session-connection.ts `sessionConnectionPath`; only its existence is
// read). It decides who a dashboard fault speaks to (DX-3421): a connected session gets one warning line, any other stays silent.
async function isPlanConnected($: any, id: string): Promise<boolean> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (typeof home !== 'string' || home === '' || !/^[A-Za-z0-9_-]+$/.test(id)) return false
  return $.fs.exists(`${home}/.config/danxbot/plan-sessions/${id}.json`)
}

// What a session start's wait for the plugin's server came to: it is there, its environment was unloaded, or the deadline came first.
type ServerState = 'ready' | 'unloaded' | 'not-yet'

// A session START may reach its hook before the plugin's own server has connected (DX-4578): the server's `danxbot_api` shows in the
// session's tool list once it has. Polled until `deadlineAt`, the start's one deadline (CONTEXT_DEADLINE_MS from its beginning), and not a tick
// after. A
// sub-agent's start is mid-session and does not call this.
async function serverState($: any, deadlineAt: number): Promise<ServerState> {
  const own = toolName('danxbot_api')
  for (;;) {
    let names: string[]
    try {
      names = (await $.tool.list()).map((t: any) => t.name)
    } catch {
      // a tool list that cannot be read cannot say: the call itself will
      return 'ready'
    }
    if (names.includes(own)) return 'ready'
    const left = deadlineAt - (await $.clock.now())
    if (left <= 0) return 'not-yet'
    try {
      await $.clock.sleep(Math.min(SERVER_POLL_MS, left))
    } catch {
      // the wait rejects when the plugin's environment is unloaded (a reload): this start's lookup ends with it
      return 'unloaded'
    }
  }
}

// ONE deadline over the plugin's own work in a context lookup, as the bash hook's `timeout 8s` was: a hung dashboard answers `late()` instead of
// holding the start, however many reads the work makes (the engine's own per-call limit bounds each, not their sum).
async function withinDeadline<T>($: any, ms: number, work: Promise<T>, late: () => T): Promise<T> {
  let cancel = () => {}
  const timedOut = new Promise<T>(resolve => {
    const timer = $.clock.after(ms, () => resolve(late()))
    cancel = () => timer.cancel()
  })
  try {
    return await Promise.race([work, timedOut])
  } finally {
    cancel()
  }
}

const toldLine = (t: Told, failure: (reason: string) => string): string | null => {
  if (t.kind === 'text') return t.text
  return t.kind === 'failed' ? failure(t.reason) : null
}

// The registry's text for `event`, only for a session on a plan. A read that broke: one line naming the event and why.
async function eventContext($: any, event: DanxEvent): Promise<string | null> {
  return toldLine(eventText(await api($, 'GET', eventPath(event))), reason => eventFailureLine(event, reason))
}

// DX-3928: a session that is not on a plan (or has no key yet) but replaced one that was is told which plan and what waits there. The
// session's own danx-dashboard server finds the earlier session and answers; its `restart_notice` tool works before sign-in and owns its
// lookup's 8 s deadline (a `lookup_timeout` stop carries the server's fix text), so the plugin sets no deadline of its own around the call. A stop
// it answers, or a call that fails, is one warning line, never quiet. The arguments depend on how the session started (restartAsk).
async function restartNotice($: any, asked: RestartAsk): Promise<string | null> {
  let told: Told
  if (asked.kind === 'failed') {
    told = asked
  } else {
    try {
      told = restartNoticeText(await $.mcp.call(SERVER, RESTART_NOTICE_TOOL, asked.args))
    } catch (err: any) {
      const message = String(err?.message ?? err)
      const refusal = classifierRefusal(message)
      // DX-4982: a refused call says the person's sentence, the session's line carries the fix
      told = { kind: 'failed', reason: refusal === null ? `error: ${message.slice(0, CALL_ERROR_MAX)}` : `${BLOCKED_LINE} ${refusal.fix}` }
    }
  }
  return toldLine(told, restartFailureLine)
}

// What the plugin's own reads of a session start came to: the line to tell, or that the restart notice is to be asked next.
type StartReads = { line: string | null; askRestart: boolean }

// A /clear: it has no event text, and it is a restart only when the session it ended was on a plan (that session's connection record is on disk),
// which is also what names the predecessor to the server. Any other clear is quiet (DX-3421), the server is never asked.
async function clearNotice($: any, start: NonNullable<PendingStart>): Promise<string | null> {
  const ended = start.predecessorId
  if (ended === null || !(await isPlanConnected($, ended)) || (await isPlanConnected($, start.sessionId))) return null
  const server = await serverState($, (await $.clock.now()) + CONTEXT_DEADLINE_MS)
  if (server === 'unloaded') return null
  if (server === 'not-yet') return restartFailureLine(SERVER_NOT_CONNECTED_REASON)
  return restartNotice($, { kind: 'ask', args: { predecessor_id: ended } })
}

// The reads a pending start asks of the dashboard: the wait for the plugin's server, the plan read and the event text read share ONE deadline. Whatever fails, a session KNOWN to be
// on a plan (its record on disk) is told in one warning line; any other stays silent (DX-3421) and, on a start or resume, still asks the
// restart notice, which is the server's own lookup and needs neither the dashboard read nor a key.
async function sessionContext($: any, start: NonNullable<PendingStart>): Promise<string | null> {
  const event = sessionEvent(start.source)
  if (event === null) return start.source === 'clear' ? clearNotice($, start) : null
  const deadlineAt = (await $.clock.now()) + CONTEXT_DEADLINE_MS
  const connected = await isPlanConnected($, start.sessionId)
  const askRestart = start.source !== 'compact'
  const fault = (reason: string): StartReads => ({ line: connected ? eventFailureLine(event, reason) : null, askRestart: !connected && askRestart })
  const server = await serverState($, deadlineAt)
  if (server === 'unloaded') return null
  if (server === 'not-yet') return connected ? eventFailureLine(event, SERVER_NOT_CONNECTED_REASON) : null
  const reads = async (): Promise<StartReads> => {
    const plan = await sessionPlan($)
    if (plan.kind === 'connected') {
      const line = await eventContext($, event)
      // DX-4993: a compaction is followed by the resume briefing, in the same first turn as the registry's text
      return { line: start.source === 'compact' ? [line, await compactionBriefing($)].filter(x => x !== null).join('\n') : line, askRestart: false }
    }
    if (plan.kind === 'failed') return fault(plan.reason)
    // a signed-out session is the one a restart leaves without a key: the notice is for it too
    return { line: null, askRestart }
  }
  const done = await withinDeadline($, Math.max(deadlineAt - (await $.clock.now()), 0), reads(), () => fault(DEADLINE_REASON))
  return done.askRestart ? restartNotice($, restartAsk(start)) : done.line
}

async function readSubagentContext($: any): Promise<string | null> {
  const plan = await sessionPlan($)
  if (plan.kind === 'connected') return eventContext($, 'sub_agent_start')
  return plan.kind === 'failed' && (await isPlanConnected($, await $.session.id())) ? eventFailureLine('sub_agent_start', plan.reason) : null
}

// DX-5344: the entries still within COMPACTING_NOTE_TTL_MS
function liveCompacting(cur: CompactingState, now: number): CompactingState {
  const fresh = (at: number) => now - at <= COMPACTING_NOTE_TTL_MS
  return { main: cur.main !== null && fresh(cur.main) ? cur.main : null, agents: Object.fromEntries(Object.entries(cur.agents).filter(([, a]) => fresh(a.at))) }
}

// A `compact` restart. The main agent is briefed when it has an entry (consumed here), or when no agent has one (a compaction nobody noted, the unattributable kinds); a restart that only
// sub-agents account for briefs nobody here: each of them is told on its own first tool result, whichever restart came first. `briefsMain` says whether the main agent is briefed;
// `own` says the main agent's OWN entry was consumed (DX-5385): the only proof the main agent was compacted, since the fallback also fits an unattributed sub-agent compaction.
async function restartBriefsMain($: any): Promise<{ briefsMain: boolean; own: boolean }> {
  const now = await $.clock.now()
  let result = { briefsMain: true, own: false }
  await update($, compacting, cur => {
    const live = liveCompacting(cur, now)
    result = { briefsMain: live.main !== null || Object.keys(live.agents).length === 0, own: live.main !== null }
    return { ...live, main: null }
  })
  return result
}

async function noteCompacting($: any, agentId: string | null): Promise<void> {
  const now = await $.clock.now()
  await update($, compacting, cur => {
    const live = liveCompacting(cur, now)
    return agentId === null ? { ...live, main: now } : { ...live, agents: { ...live.agents, [agentId]: { at: now, done: false } } }
  })
}

// The compaction of this agent finished (`done`), or did not happen (skipped, or failed: the entry goes).
async function settleCompacting($: any, agentId: string | null, completed: boolean): Promise<void> {
  const now = await $.clock.now()
  await update($, compacting, cur => {
    if (agentId === null) return completed ? cur : { ...cur, main: null }
    const entry = cur.agents[agentId]
    if (entry === undefined) return cur
    const { [agentId]: _gone, ...rest } = cur.agents
    return { ...cur, agents: completed ? { ...rest, [agentId]: { at: now, done: true } } : rest }
  })
}

async function forgetCompactingAgent($: any, agentId: unknown): Promise<void> {
  if (typeof agentId !== 'string' || agentId === '') return
  await update($, compacting, cur => {
    if (!(agentId in cur.agents)) return cur
    const { [agentId]: _gone, ...rest } = cur.agents
    return { ...cur, agents: rest }
  })
}

// DX-5344: the briefing of the sub-agent whose tool result this is, once its own compaction finished: once, to that sub-agent only, and only when the session is on a plan (an unconnected
// session gets no danxbot text at all, DX-3421). The engine's list names its type and task; a list that fails is toasted and the briefing names the id alone.
async function takeAgentBriefing($: any, agentId: string): Promise<string | null> {
  const now = await $.clock.now()
  let waiting = false
  await update($, compacting, cur => {
    const live = liveCompacting(cur, now)
    waiting = live.agents[agentId]?.done === true
    if (!waiting) return live
    const { [agentId]: _taken, ...rest } = live.agents
    return { ...live, agents: rest }
  })
  if (!waiting || !(await isPlanConnected($, String(await $.session.id())))) return null
  let listed: { id: string; type: string; description: string }[] = []
  try {
    listed = await $.agent.list()
  } catch (err: any) {
    $.ui.toast(`The sub-agent briefing could not read the agent list: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
  const found = listed.find(a => a.id === agentId)
  return subagentBriefingText({ id: agentId, type: found?.type ?? null, description: found?.description ?? null })
}

// SessionStart: the session title is noted and the start is recorded for the next prompt or tool result. The session is not bound yet on a
// desktop or headless startup, resume or fork, so no `$.mcp.call` or `$.tool.list` here (the next prompt or tool result tells the model, see stampEntries).
// The one exception (DX-5385): a compaction that ends with no turn running detaches the resume prompt, whose reads wait for the session to bind.
async function onClassicSessionStart($: any, e: any, next: any) {
  const below = await onTitle($, e, next)
  const path = typeof e.transcript_path === 'string' ? e.transcript_path : null
  // the ended session is consumed by this start only: a later clear that saw no end must not be asked about this one's
  const ended = await takeEndedSession($)
  // DX-5344: a restart only sub-agents account for is theirs to be briefed about; the main agent's pending start is for its own compaction (and every other start, and a restart nobody noted)
  const restart = e.source === 'compact' ? await restartBriefsMain($) : { briefsMain: true, own: false }
  if (!restart.briefsMain) return below
  const start: NonNullable<PendingStart> = { sessionId: e.session_id, source: e.source, transcriptPath: path, predecessorId: ended }
  await update($, pendingStart, () => start)
  // DX-5385: a compaction that ends while no turn runs (the plugin's own after a ready, or a typed /compact) leaves nothing to carry the briefing: the plugin starts the turn, but only for
  // the main agent's OWN compaction (`restart.own`). A restart with no entry at all (an unattributed sub-agent compaction, a host without session.compact) is briefed passively and starts no turn.
  // The isRunning read is a deliberate fast path: a running turn carries the briefing on its next tool result, with no reads or take here.
  if (restart.own && !(await read($, turn)).isRunning) detach($, 'Resume after compaction', resumeAfterCompaction($))
  return below
}

// DX-5385: the main agent's resume prompt, by the relay's one prompt path (submitEvent, DX-4721). Only a session on a plan gets one (its connection record is on disk, as
// isPlanConnected says; any other session stays quiet, DX-3421). The pending start is TAKEN first, so the briefing it renders is in this prompt and the prompt's own
// stamp hook finds none (told once). A turn that began while the reads ran is the person's: the built briefing goes into that running turn as a note (no prompt queues
// behind it); a note the session refuses puts the start back for the next tool result. A prompt the session refuses puts it back the same way.
async function resumeAfterCompaction($: any): Promise<void> {
  // checked before the start is taken: a session that is not on a plan leaves it for the prompt or tool result that tells it (or nothing)
  const pending = await read($, pendingStart)
  if (pending === null || !(await isPlanConnected($, pending.sessionId))) return
  const start = await takePendingStart($)
  if (start === null) return
  // a compact start always renders (it carries the registry event), so there is no null to put back
  const text = (await renderStart($, start))!
  if ((await read($, turn)).isRunning) {
    // by the relay's one note path, so a turn that ends with no tool result after it still tells the briefing as a prompt
    if ((await appendTrackedNote($, text)) !== null) await restoreStart($, start)
    return
  }
  // the procedure needs no dashboard read: a start whose reads failed (only a warning line) still tells the agent how to resume
  const failure = await submitEvent($, relayLine(text.includes(RESUME_PROCEDURE) ? text : `${text}
${RESUME_OPENING}`))
  if (failure === null) return
  // the session did not take the prompt: the briefing is still owed, to the next prompt or tool result
  await restoreStart($, start)
  $.ui.toast(`The resume prompt was not taken by the session: ${failure}`.slice(0, TOAST_ERROR_MAX))
}

// A start taken for a briefing that was not delivered goes back (unless a newer start has arrived meanwhile): the next prompt or tool result tells it.
async function restoreStart($: any, start: NonNullable<PendingStart>): Promise<void> {
  await update($, pendingStart, cur => cur ?? start)
}

// DX-4340: the new sub-agent also gets danxbot's pacing line (additionalContext), when danxbot has one for this session
// DX-4234: and, first, the registry's sub_agent_start text when its parent session is on a plan
async function onSubagentStart($: any, e: any, next: any) {
  const r = await onSubagentChange($, e, next, true)
  // DX-4235: its activity row opens
  detach($, 'danxbot activity report', reportSubagentStart($, e))
  const eventLine = await withinDeadline($, CONTEXT_DEADLINE_MS, readSubagentContext($), () => eventFailureLine('sub_agent_start', DEADLINE_REASON))
  const pacing = await pacingLine(pacingEnv($))
  return withLine(withLine(r, eventLine), pacing)
}

async function onSubagentStop($: any, e: any, next: any) {
  const r = await onSubagentChange($, e, next, false)
  // DX-4235: the shells' ends (its own row closes at its turn.complete)
  detach($, 'danxbot shell-end report', reportShellEnds($, 'SubagentStop', e))
  return r
}

// DX-4233: the main loop's turn ended (a sub-agent's `turn.complete` carries its agentId and is not this).
async function onTurnComplete($: any, e: any, next: any) {
  const r = await next(e)
  if (e.agentId === undefined) {
    // `prompts` is set inside the updater, which sees the turn as it is when the write happens
    let prompts = [] as string[]
    await update($, turn, cur => {
      const ended = turnEnded(cur, e.isAborted === true)
      prompts = ended.prompts
      return ended.turn
    })
    // detached: the turn.complete hook does not wait on the session taking a prompt
    if (prompts.length > 0) detach($, 'Telling the session', promptNotes($, prompts))
    // DX-3900: a sub-agent's end is not the session going idle
    await armKeepalive($, false)
    // DX-5231: the agent's ready, said during this turn, starts the compaction now that the turn is over
    await syncCompaction($, { start: true })
  } else {
    // DX-4235: a sub-agent's turn ended, cleanly or not: its activity row closes
    detach($, 'danxbot activity report', reportSubagentEnd($, e.agentId))
  }
  detach($, 'Plan refresh', refresh($))
  void watchRelay($)
  return r
}

// DX-4233: the main loop's turn began. DX-5385: turn.start also fires for a sub-agent's turn and an engine fork (they carry an agentId), and only the main loop's
// turn.complete clears the turn state, so a sub-agent's start is no part of the main loop's state: it would leave isRunning true and the resume prompt unsent.
async function onTurnStart($: any, e: any, next: any) {
  if (e.agentId !== undefined) return next(e)
  cancelKeepalive()
  const since = await read($, idleSince)
  const now = await $.clock.now()
  // DX-4806: a running turn is no idle period; a reload that finds one running resumes from nothing (armKeepalive), never from the last turn's end
  await update($, idleSince, () => null)
  if (keepalivePlan !== null && since !== null && now >= since + KEEPALIVE_GIVE_UP_MS) detach($, 'Plan tab re-check', recheckTab($))
  await update($, turn, () => turnStarted())
  await syncCompaction($, { start: false })
  return next(e)
}

// The app's session title, handed to `plan_connect`; and (DX-4508) the main transcript's path.
async function onTitle($: any, e: any, next: any) {
  await noteTranscript($, e)
  const t = typeof e.session_title === 'string' ? e.session_title.trim() : ''
  if (t) await update($, title, () => t)
  return next(e)
}

// DX-5232: the events warning's reason, toasted once on the transition into the warning (a redraw that shows the same warning says nothing).
// One pass: read the view and relay, compute the warning, store it atomically, toast if the update changed it. The update cannot read those two
// atoms itself, so a snapshot that went stale between the read and the update can only repeat one toast or miss one, never store a wrong warning
// for long: the next write path (a load or a relay state change) computes it again from the latest state.
async function noteEventsWarning($: any): Promise<void> {
  const v: PlanView = await read($, view)
  const relayState: RelayState = await read($, relay)
  const warning = eventsWarning(v, relayState)
  let changed = false
  await update($, eventsWarned, cur => {
    changed = cur !== warning
    return warning
  })
  if (!changed) return
  const reason = eventsReason(v, relayState)
  if (reason !== null) $.ui.toast(reason.slice(0, TOAST_ERROR_MAX))
}

async function drawBand($: any, e: any, next: any) {
  if (e.props.hasSurvey) return next(e)
  const v = await read($, view)
  // a dismissed band draws nothing, whatever the connection (the footer button brings it back)
  if (await read($, dismissed)) return next(e)
  const permissions = await read($, permissionRequests)
  const newestPermission = permissions.at(-1)
  return renderBand(
    $.ui.resolve(e),
    handlers($),
    v,
    e.surface === 'desktop',
    await read($, busy),
    newestPermission === undefined ? null : { count: permissions.length, newest: asApproval(newestPermission) },
    await read($, signInRequest),
    e.props.bodyColumns,
    buildPacing(await read($, pacingState)),
    await read($, relay),
  )
}

// The footer: the engine's own mode labels (next) stay, with ONE plan button beside them. Nothing
// to say (loading) leaves the site untouched; no MCP server reads `Danxbot · off`.
async function drawSessionMode($: any, e: any, next: any) {
  const label = footerLabel(await read($, view))
  if (label === null) return next(e)
  return renderFooter($.ui.resolve(e), handlers($), label, await next(e), e.surface === 'desktop')
}

// DX-4448: card ids in an assistant reply drawn as links. Reads only the `view` atom (filled at refresh): no network in the draw.
// The text is rewritten in the props and handed on (claude-code.d.ts, ui.render: "rewrite `props`"), so the engine's own drawing
// and any hook below stay in effect; the stored message is untouched, and `onScreen` rides along as received. Nothing to link
// (not connected, no prefixes known, no card id in the text) leaves the event as it is.
async function drawAssistantMessage($: any, e: any, next: any) {
  const v = await read($, view)
  // links in error or nothing known: the reply is drawn as written. So is a text that is not a string (the d.ts types it `string`;
  // this only guards the engine one day sending a block with none, which `linkCardIds` would throw on)
  if (v.phase !== 'ready' || v.connected === null || v.links.state !== 'ready' || v.links.prefixes.length === 0 || typeof e.props.text !== 'string') {
    return next(e)
  }
  const text = linkCardIds(e.props.text, v.links.prefixes, v.connected, new Set(v.links.planCardIds))
  return next(text === e.props.text ? e : { ...e, props: { ...e.props, text } })
}

// DX-4340: the engine calls the pacing guard makes, as closures (the engine follows `$` only into a function in this file).
function pacingEnv($: any) {
  return {
    now: () => $.clock.now(),
    within: <T,>(ms: number, work: Promise<T>, late: () => T) => withinDeadline($, ms, work, late),
    call: (method: string, path: string) => api($, method, path),
    toast: (text: string) => $.ui.toast(text),
  }
}

// DX-4235: the reports. A plan session tells the dashboard what it is running (activity rows) and has
// its stop checked for ready cards (DX-4534). Every call goes through the session's own server (`api`) and runs detached, so no event
// waits on it; a report the dashboard does not take is one toast, never swallowed (`report`).
//
// What each needs of the plan state the module holds (`reportingState`):
// - OPENING something (a sub-agent's row, a shell's row, a liveness post) needs the session known to be on a plan (`on`): the silence rule.
// - CLOSING what was opened (a sub-agent's finish, a shell's end) is owed because its start was posted, so it is posted whatever the view
//   says, while it is `unknown` too (a failed refresh empties the view's plan for a moment; comment 10065's stuck row was exactly a close
//   that never went out). Only `off` drops it: the dashboard has the session on no plan and refuses every report from it
//   (danxbot plan-sessions-routes.ts handleActivity: no dispatch to write to, 409).
// - The ready-cards check runs unless `off`: its own read asks the dashboard which plan the session is on.

// `on`: the view holds the plan the session is on. `off`: the dashboard said the session is on no plan (a loaded view with none), or a
// person revoked its key. `unknown`: nothing is known (loading, a failed load, a session signed out with its key lapsed).
type ReportingState = 'on' | 'off' | 'unknown'
async function reportingState($: any): Promise<ReportingState> {
  const v = await read($, view)
  if (v.connected !== null) return 'on'
  return v.phase === 'ready' || v.phase === 'key-revoked' ? 'off' : 'unknown'
}

// A plan state that is `off` takes the reports' memory with it: nothing opened under the plan can be closed from here any more.
async function forgetReports($: any): Promise<void> {
  await update($, reports, () => ({ agents: {}, shells: [], planId: null }))
}

// The plan a new row opens under: the one the view holds, or null when the session is not known to be on one (nothing opens then).
async function openingPlan($: any): Promise<number | null> {
  return (await read($, view)).connected?.id ?? null
}

// What the closes before a leave came to: the memory they took, how many rows they posted, and whether the dashboard took them.
type LeaveCloses = { owed: ReportState; rows: number; posted: boolean }

const activities = (n: number) => `${n} running activit${n === 1 ? 'y' : 'ies'}`

// DX-4235 (comment 12426): before the session leaves its plan or moves to another, every close it owes (a running sub-agent's finish, an
// open shell's end) is posted, in one call: after the leave the dashboard takes no report from it, and rows left running are the
// stuck-row bug of comment 10065. Bounded by LEAVE_CLOSE_DEADLINE_MS so a dead dashboard never holds the leave; a failure is one toast
// naming what may stay running, and the leave goes on. The memory is cleared first, so a sub-agent's turn.complete racing the leave
// posts nothing twice. `why` names the leave in the toast. The caller hands the answer to `leaveDidNotHappen` when the leave failed.
async function closeOwedBeforeLeave($: any, why: string): Promise<LeaveCloses> {
  const owed = await read($, reports)
  await forgetReports($)
  const now = await $.clock.now()
  const rows = [...Object.keys(owed.agents).map(id => agentRow(id, null, now, now)), ...owed.shells.map(id => shellRow(id, null, now, now))]
  if (rows.length === 0) return { owed, rows: 0, posted: false }
  const failure = await withinDeadline(
    $,
    LEAVE_CLOSE_DEADLINE_MS,
    api($, 'POST', ACTIVITY_PATH, { body: { activities: rows } }).then(r => (r.ok ? null : errText(r))),
    () => `timeout: no answer within ${LEAVE_CLOSE_DEADLINE_MS / 1000} s`,
  )
  if (failure !== null) $.ui.toast(`danxbot could not close ${activities(rows.length)} before ${why} (${failure.slice(0, TOAST_ERROR_MAX)}): the dashboard may show them running`)
  return { owed, rows: rows.length, posted: failure === null }
}

// DX-4235: hands the closes a leave took back when the leave did not happen (`left` false); nothing to do when the leave took none (`closes`
// null: a move that left no reported plan) or happened.
async function settleLeave($: any, closes: LeaveCloses | null, left: boolean, why: string): Promise<void> {
  if (closes !== null && !left) await leaveDidNotHappen($, closes, why)
}

// DX-4235: the leave did not happen (refused, or the call failed): the session is still on its plan, so what the closes took comes back.
// Closes the dashboard did not take are owed again: the memory returns, merged with anything opened since (one finish each, later). Closes
// it took cannot be undone: the dashboard keeps a row's FIRST finish (danxbot dispatch-activities-db.ts upsert, finished_at =
// COALESCE(stored, incoming)), so a reopening post would change nothing; they stay forgotten (nothing is posted twice) and one toast says
// they read as finished while they run. The plan always comes back.
async function leaveDidNotHappen($: any, closes: LeaveCloses, why: string): Promise<void> {
  const { owed } = closes
  const rowsBack = !closes.posted
  await update($, reports, cur => ({
    agents: rowsBack ? { ...owed.agents, ...cur.agents } : cur.agents,
    shells: rowsBack ? [...owed.shells.filter(s => !cur.shells.includes(s)), ...cur.shells] : cur.shells,
    planId: cur.planId ?? owed.planId,
  }))
  if (closes.posted) $.ui.toast(`danxbot: ${why} did not happen, but its ${activities(closes.rows)} were already reported finished: the dashboard keeps them finished while they run`)
}

// Whether a move to `planId` leaves the plan the open rows belong to.
async function movesOffReportedPlan($: any, planId: number): Promise<boolean> {
  const from = (await read($, reports)).planId
  return from !== null && from !== planId
}

async function report($: any, what: string, method: string, path: string, body: object): Promise<void> {
  const r = await api($, method, path, { body })
  if (!r.ok) $.ui.toast(`danxbot ${what} report failed: ${errText(r).slice(0, TOAST_ERROR_MAX)}`)
}

function postActivity($: any, rows: ActivityChange[]): void {
  detach($, 'danxbot activity report', report($, 'activity', 'POST', ACTIVITY_PATH, { activities: rows }))
}

// DX-4235: a sub-agent started: its row opens and it is remembered as running, its liveness clock starting now.
async function reportSubagentStart($: any, e: any): Promise<void> {
  if (typeof e.agent_id !== 'string' || e.agent_id === '') return
  const planId = await openingPlan($)
  if (planId === null) return
  const id = subagentKey(e.agent_id)
  const now = await $.clock.now()
  await update($, reports, cur => ({ ...cur, agents: { ...cur.agents, [id]: now }, planId }))
  postActivity($, [agentRow(id, typeof e.agent_type === 'string' && e.agent_type !== '' ? e.agent_type : null, now, null)])
}

// DX-4235: a sub-agent's turn ended, cleanly or not (a failed sub-agent raises no SubagentStop, but its turn.complete still comes): the
// finish its posted start is owed goes out, and it is forgotten. An agent this session never reported (an engine fork, a workflow's
// agent, one already finished) reports nothing; a resumed sub-agent is reported again from its next start.
async function reportSubagentEnd($: any, agentId: string): Promise<void> {
  const id = subagentKey(agentId)
  if ((await read($, reports)).agents[id] === undefined) return
  const state = await reportingState($)
  if (state === 'off') return forgetReports($)
  await update($, reports, cur => {
    const { [id]: _ended, ...running } = cur.agents
    return { ...cur, agents: running }
  })
  const now = await $.clock.now()
  postActivity($, [agentRow(id, null, now, now)])
}

// DX-4235: a tool call whose result names a background task (a `run_in_background` shell, or one the person backgrounded) opens that
// shell's row, keyed by its task id (the id the engine's `background_tasks` lists it under, comment 12391), labelled by the call's own
// `description`, redacted (PBLM-2121; never its command).
async function reportShellStart($: any, e: any, r: any): Promise<void> {
  const taskId = r.deny === undefined ? r.result?.backgroundTaskId : undefined
  if (typeof taskId !== 'string' || taskId === '') return
  const planId = await openingPlan($)
  if (planId === null) return
  const now = await $.clock.now()
  await update($, reports, cur => ({ ...cur, shells: [...cur.shells.filter(s => s !== taskId), taskId], planId }))
  postActivity($, [shellRow(taskId, labelOf(e.description), now, null)])
}

// DX-4235: a running sub-agent's own tool call re-posts its row with a fresh lastActivityAt, at most once a LIVENESS_MS, so a sub-agent
// working for minutes never reads as silent (comment 10017).
async function reportSubagentAlive($: any, agentId: string): Promise<void> {
  const id = subagentKey(agentId)
  const now = await $.clock.now()
  const state = await read($, reports)
  const lastPost = state.agents[id]
  if (lastPost === undefined || now - lastPost < LIVENESS_MS || (await reportingState($)) !== 'on') return
  await update($, reports, cur => (cur.agents[id] === undefined ? cur : { ...cur, agents: { ...cur.agents, [id]: now } }))
  postActivity($, [agentRow(id, null, now, null)])
}

// DX-4235: a Stop or SubagentStop carries the engine's list of the background work in flight. It finishes the row of every shell this
// session opened that the list no longer shows running (comment 10065: every start the reports open gets its end). A snapshot that is not
// a list is one toast.
async function reportShellEnds($: any, event: 'Stop' | 'SubagentStop', e: any): Promise<void> {
  const state = await reportingState($)
  if (state === 'off') return forgetReports($)
  const tasks = e.background_tasks
  if (!Array.isArray(tasks)) {
    $.ui.toast(`danxbot shell-end report failed: the ${event} event carried no background_tasks list`)
    return
  }
  const now = await $.clock.now()
  const ended = endedShells((await read($, reports)).shells, tasks)
  if (ended.length === 0) return
  await update($, reports, cur => ({ ...cur, shells: cur.shells.filter(s => !ended.includes(s)) }))
  postActivity($, ended.map(id => shellRow(id, null, now, now)))
}

// What the ready-cards read came to: the ready cards, nothing to say, or why it failed.
type ReadyRead = { kind: 'cards'; cards: ReadyCard[] } | { kind: 'quiet' } | { kind: 'failed'; reason: string }

// DX-4534: the answers that end the read quietly, the ordinary ones for a session with nothing to check: it holds no usable key (signed
// out, or a person revoked it: its own tools say so), or the dashboard has it on no plan (409 `session_not_connected`). Any other
// refusal is a failure the person sees.
function isNothingToCheck(r: Api): boolean {
  return isSignedOut(r) || outcomeRevokedBy(r) !== null || (r.status === 409 && r.body?.error === 'session_not_connected')
}

// DX-4534: the plan this session is on and its boards, then the plan's ToDo cards on each board (a plan can span boards; an issues read
// names its board with the danxbot_api tool's own `board` argument).
async function readReadyCards($: any): Promise<ReadyRead> {
  // DX-4997: the pause is read FIRST, and while the session is in an agent pause neither card read is made: both carry the session header, so
  // they would count as the agent's own dashboard call and end the pause (the pause read does not, DX-4951). The stop is allowed.
  const pause = await readAgentPause($)
  if (pause.kind === 'paused' || pause.kind === 'nothing') return { kind: 'quiet' }
  if (pause.kind === 'failed') return { kind: 'failed', reason: pause.reason }
  const mine = await api($, 'GET', '/api/plans/mine')
  if (isNothingToCheck(mine)) return { kind: 'quiet' }
  if (!mine.ok) return { kind: 'failed', reason: errText(mine) }
  const plan = planOf(mine.body)
  if (!plan.ok) return { kind: 'failed', reason: plan.reason }
  const query = issuesQuery(plan.value.planId)
  const boards = await Promise.all(plan.value.boards.map(board => api($, 'GET', '/api/issues', { board, query })))
  const cards: ReadyCard[] = []
  for (const r of boards) {
    if (!r.ok) return { kind: 'failed', reason: errText(r) }
    const read = readyCardsOf(r.body)
    if (!read.ok) return { kind: 'failed', reason: read.reason }
    cards.push(...read.value)
  }
  return { kind: 'cards', cards }
}

// DX-4235: the main session's stop. Reports the shells' ends, then (DX-4534) blocks the stop once while the plan has ready cards nobody holds.
// Never on a stop the hook already forced (`stop_hook_active`, so it cannot loop), never on its own failure (one toast, the stop goes on),
// and within one deadline over all its reads.
async function onReportStop($: any, e: any, next: any) {
  // the shell-end report runs in every plan state: off, it forgets what the reports owe (reportShellEnds)
  detach($, 'danxbot shell-end report', reportShellEnds($, 'Stop', e))
  if ((await reportingState($)) === 'off') return next(e)
  const verdict: ReadyRead =
    e.agent_id === undefined && e.stop_hook_active !== true
      ? await withinDeadline($, READY_CARDS_DEADLINE_MS, readReadyCards($), () => ({ kind: 'failed', reason: `timeout: no answer within ${READY_CARDS_DEADLINE_MS / 1000} s` }))
      : { kind: 'quiet' }
  const r = await next(e)
  if (verdict.kind === 'failed') $.ui.toast(skippedLine(verdict.reason))
  if (verdict.kind === 'cards' && verdict.cards.length > 0) return { ...r, block: blockReason(verdict.cards) }
  return r
}

// ---- DX-4993 (PLAN-42 rule R-4): an operator session is compacted only after its agent says ready ----------------------------------------------
// The control is a local file the session's danx-dashboard MCP relay writes (hooks/compaction/control.ts has the shape and the reasoning). This block
// starts the compaction when the agent says ready (`$.command.run({ command: 'compact' })` at the main loop's turn end, DX-5231), clears what older plugin versions armed,
// and answers every automatic compaction proposal (`classic.PreCompact`) with a refusal while the session is under the handshake. It fails
// OPEN: whatever it cannot establish lets Claude Code's own compaction through (a refusal with no way out ends the session), and says so once.

// The last reason told to the person that the control file is unreadable; the same reason is told once.
let compactionFaultTold: string | null = null
// DX-5314: the relay-older-than-plugin notice last shown (null while the control is whole); shown once, and again if it changes or the session returns to a whole control and falls back
let relayOlderTold: string | null = null
// DX-5365: the person was told once that the engine's release could not be read, so sub-agent compaction waits for the first compaction event
let engineVersionTold = false
// DX-5222: each sub-agent's last model response (its context size and model), noted at `turn.step`: `session.compact` names the proposing sub-agent but not its size, and
// `$.session.usage()` is the main conversation's. A Map keeps insertion order, so the oldest agent goes first once AGENT_SIZES_KEEP are held; a reload starts empty (the
// next response of each agent fills it), and an agent whose size is unknown is refused and told, never guessed (agentVerdict).
const agentSizes = new Map<string, AgentSize>()
// DX-5222: the sub-agent refusals already told to the person (`agent id: reason`), each once
const agentFaultTold = new Set<string>()
// the git read of the resume briefing is a local status: it needs no longer than this
const GIT_STATUS_TIMEOUT_MS = 5000
// how often an idle session looks for an agent's ready in the local control file (a file read, no network)
const COMPACTION_IDLE_CHECK_MS = 5000

async function compactionControl($: any): Promise<ControlFile> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (home === undefined || home === null) return { kind: 'bad', reason: 'no home directory' }
  const path = controlPath(String(home), await $.session.id())
  if (!(await $.fs.exists(path))) return { kind: 'absent' }
  return parseControlFile(await $.fs.read(path), String(await $.session.id()))
}

// The size of the context now and the session's real window; each null when the engine cannot say yet (before the first response).
async function contextReading($: any): Promise<{ tokens: number | null; window: number | null }> {
  const context = (await $.session.usage())?.context
  const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  return { tokens: count(context?.tokens), window: count(context?.window) }
}

// The store keeps the spent-release records (DX-4993) and the delivered-request records (DX-5222) of every session ever held: the oldest sessions' past USED_RELEASE_KEEP go, the way pruneCursors does for the relay cursors.
async function pruneSessionRecords($: any, prefix: string, atField: 'at' | 'sentAt'): Promise<void> {
  const entries: { key: string; at: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue
    const rec: any = await $.store.get(key)
    entries.push({ key, at: typeof rec?.[atField] === 'number' ? rec[atField] : 0 })
  }
  for (const key of staleSessionKeys(entries, prefix)) await $.store.delete(key)
}
async function pruneUsedReleases($: any): Promise<void> {
  await pruneSessionRecords($, USED_RELEASE_PREFIX, 'at')
}

// DX-5231: one read of the control file per main-loop moment (a turn's start, its end, the idle check) serves everything the plugin does with it: telling the person the
// file is unreadable, clearing what an older plugin version armed, and starting the compaction an agent asked for. Never throws: a failure is one line to the person.
async function syncCompaction($: any, { start }: { start: boolean }): Promise<void> {
  try {
    const file = await compactionControl($)
    if (file.kind === 'bad') {
      if (compactionFaultTold !== file.reason) $.ui.toast(`Compaction control unreadable (${file.reason}): Claude Code's own automatic compaction applies until it is fixed.`)
      compactionFaultTold = file.reason
    } else compactionFaultTold = null
    const relayOlder = file.kind === 'control' && file.control !== null && file.control.subagents === null ? RELAY_OLDER_NOTICE : null
    if (relayOlder !== null && relayOlderTold !== relayOlder) $.ui.toast(relayOlder)
    relayOlderTold = relayOlder
    syncCompactionTicker($, file)
    await clearLeftoverArming($, file)
    await armSubAgents($, file)
    await deliverAgentAsks($, file)
    if (start) await startReadyCompaction($, file)
  } catch (err: any) {
    $.ui.toast(`Compaction handshake could not run: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
}

// DX-5231: the idle check runs only while the session is under the handshake (its control file carries a control): a ready can only come to such a session. A session
// with no handshake pays nothing; the check stops the moment the control goes (the switch off, the file pruned or unreadable). A ready lands after the sync that read the
// file, so the check cannot wait for a release to appear in it.
function syncCompactionTicker($: any, file: ControlFile): void {
  const wanted = underHandshake(file)
  if (wanted && compactionTicker === null) compactionTicker = $.clock.every(COMPACTION_IDLE_CHECK_MS, () => idleCompactionCheck($))
  else if (!wanted && compactionTicker !== null) {
    compactionTicker.cancel()
    compactionTicker = null
  }
}

// The plugin arms nothing for the MAIN agent's own start (DX-5231: it runs /compact itself). An older plugin version armed CLAUDE_CODE_AUTO_COMPACT_WINDOW (DX-4993, DX-5217) and
// then CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (DX-5217) in this process, and a variable stays in a running process after a plugin reload: the first shrinks the context meter's window,
// the second makes every loop propose early. Once the session has a control file (it is under the handshake) both are cleared, ONCE per process (`leftoverArmingCleared`): the
// sub-agents' percent (armSubAgents, DX-5222), which outlives main turns, is never wiped by a later turn, and armSubAgents sets the flag BEFORE it first sets the variable, so
// the clear can never wipe the value it armed. `$.env.set(name)` with no value restores the default at once (verified, Claude Code 2.1.299). The literal names are kept so
// the engine lists them as writes of this module. A session with no control file keeps whatever its person set.
async function clearLeftoverArming($: any, file: ControlFile): Promise<void> {
  if (file.kind === 'absent' || (await read($, leftoverArmingCleared))) return
  if ((await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) !== undefined) await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  if ((await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')) !== undefined) await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
  await update($, leftoverArmingCleared, () => true)
}

// DX-5222: a sub-agent has no command form that starts its compaction (`$.command.run` compacts the main session only), so the only compaction it can have is Claude Code's own
// automatic proposal. The plugin makes that proposal come early, from the floor: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, a process-wide variable (the main loop proposes early too; the gate
// holds its proposals, onSessionCompact). It is armed while the session is under the handshake, re-armed when the floor moves, and taken back when the handshake ends or the file
// cannot be read: an armed percent with nothing holding the proposals would compact every agent at the floor. A variable set at runtime DOES reach a sub-agent that is already
// running (verified live, Claude Code 2.1.299, DX-5222 comment 16303: a running sub-agent proposed three times within 12 s of the set).
// It is armed only once this host is known to run `session.compact` (`hostRunsSessionCompact`: an event seen, or an engine release from the floor, DX-5365): the per-agent gate lives there, and on a host without it the classic gate alone
// would hold every agent's early proposal, which can end an agent's work.
// DX-5365: whether this host runs `session.compact`, known at the first sync without waiting for a compaction: the event was seen (`sessionCompactSeen`), or the engine's release is one that
// serves it per agent (SESSION_COMPACT_FLOOR; the runtime has no capability flag). A version reading that throws or names no release is a host that is not known to run it: nothing arms.
async function engineCompactState($: any): Promise<'runs' | 'older' | 'unreadable'> {
  const known = await read($, engineCompact)
  if (known !== 'unread') return known
  let state: 'runs' | 'older' | 'unreadable'
  try {
    const base = (await $.session.version()).base
    state = base === undefined ? 'unreadable' : runsSessionCompact(base) ? 'runs' : 'older'
  } catch {
    state = 'unreadable'
  }
  await update($, engineCompact, () => state)
  return state
}

// ONE answer for both decisions that hang on it: whether the sub-agents' percent is armed (armSubAgents) and whether the classic PreCompact gate steps aside for an automatic proposal
// (onPreCompact). Arming without stepping aside would hold, at the classic gate, every early proposal that never reaches `session.compact`, for good.
async function hostRunsSessionCompact($: any): Promise<boolean> {
  return (await read($, sessionCompactSeen)) || (await engineCompactState($)) === 'runs'
}

async function armSubAgents($: any, file: ControlFile): Promise<void> {
  const asked = armedPercentOf(file)
  const wanted = (await hostRunsSessionCompact($)) ? asked : null
  // DX-5365: an engine release that cannot be read is not armed, and the person is told once (the compaction handshake's sub-agent half is off until a compaction event shows the host runs it)
  if (!engineVersionTold && asked !== null && !(await read($, sessionCompactSeen)) && (await engineCompactState($)) === 'unreadable') {
    engineVersionTold = true
    $.ui.toast(ENGINE_VERSION_NOTICE)
  }
  if (wanted === (await read($, armedPercent))) return
  // DX-5222 (comment 15880): the once-per-process clear must never wipe the value armed here, so `leftoverArmingCleared` is already true when this first sets it: syncCompaction runs
  // clearLeftoverArming first, and it raises the flag on the first control file of the session (the one that can arm). compaction-agents.test.tsx pins the order.
  if (wanted === null) await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
  else await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', String(wanted))
  await update($, armedPercent, () => wanted)
}

// The file's unexpired release, if the plugin has not spent it: spent now (kept in $.store, so one release is acted on once however many turns follow) and returned.
async function spendReadyRelease($: any, file: ControlFile): Promise<string | null> {
  const key = usedReleaseKey(String(await $.session.id()))
  const now = await $.clock.now()
  const releaseId = readyRelease(file, spentReleaseId(await $.store.get(key)), now)
  if (releaseId === null) return null
  // the store record outlives this process (claimedRelease below does not): a new process must not start the same release again
  // DX-5231: the claim, one compare-and-set before any further await: of every caller that read the release as waiting, exactly one gets it
  let won = false
  await update($, claimedRelease, cur => {
    won = cur !== releaseId
    return won ? releaseId : cur
  })
  if (!won) return null
  await $.store.set(key, { releaseId, at: now })
  await pruneUsedReleases($)
  return releaseId
}

// DX-5231: the agent said ready, so the compaction runs: when no main-loop turn is running (its turn end, or the idle check below) the plugin queues Claude Code's own
// /compact, which the host runs once the session is idle. Never from inside a turn or a command hook. The file's unexpired release is the ready.
// The compaction reaches PreCompact and `session.compact` as trigger `manual`. The command takes no arguments: the control carries no instructions.
// A failure is one line to the person, and the dashboard re-asks once the release has expired.
async function startReadyCompaction($: any, file: ControlFile): Promise<void> {
  if ((await spendReadyRelease($, file)) === null) return
  $.ui.toast('Compacting now: your agent said it is ready.')
  detach($, 'Compaction', $.command.run({ command: 'compact' }))
}

// The agent's ready is written to the control file by the relay, after its tool call returned, so it can land after the turn that made it already ended (an idle
// session: no turn.complete follows). The plugin cannot watch the file: its `$.fs` is read, write, list, stat, exists and ancestors only (the hook catalog of Claude Code
// 2.1.299 has no watch), so a local file read every COMPACTION_IDLE_CHECK_MS starts it, only while no main turn is running.
// DX-5222: a sub-agent's request is delivered while the main turn runs too (the sub-agents work inside it), so the check runs always and only the START waits for no turn.
async function idleCompactionCheck($: any): Promise<void> {
  await syncCompaction($, { start: !(await read($, turn)).isRunning })
}

// The verdict for one proposal. A person's own /compact passes whatever the file says (it reads the file only to spend a waiting ready, above). Every read that a decision needs happens only for an automatic proposal;
// whatever throws lets the compaction through (fail open, hooks/compaction/control.ts).
async function compactionVerdict($: any, e: any): Promise<Verdict> {
  if (e.trigger === 'manual') {
    // a person's own /compact answers a waiting ready: the plugin must not run a second one at the turn's end (the plugin's own start has spent it already)
    try {
      await spendReadyRelease($, await compactionControl($))
    } catch (err: any) {
      $.ui.toast(`Compaction handshake could not note the compaction: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
    }
    return { pass: true, why: 'manual' }
  }
  try {
    // DX-5222: a `precompute` is judged like an automatic proposal (and, installing nothing, announces nothing)
    const judged = e.trigger === 'auto' || e.trigger === 'precompute'
    const reading = judged ? await contextReading($) : { tokens: null, window: null }
    const v = verdict({
      trigger: e.trigger,
      tokens: reading.tokens,
      window: reading.window,
      file: judged ? await compactionControl($) : { kind: 'absent' },
    })
    if (v.pass && v.why === 'valve' && e.trigger === 'auto') $.ui.toast('Compacting now: the context reached the size where holding it would end the session.')
    return v
  } catch (err: any) {
    const told = `Compaction gate could not decide, so Claude Code's own automatic compaction applies: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`
    if (compactionFaultTold !== told) $.ui.toast(told)
    compactionFaultTold = told
    return { pass: true, why: 'unreadable' }
  }
}

async function onPreCompact($: any, e: any, next: any) {
  // DX-5222: on a host that runs `session.compact` every automatic proposal that goes through it was judged there, per agent, before core ran this classic hook, which cannot tell the
  // agents apart (in 2.1.299 its input never names one): it is not judged a second time. Three proposals skip `session.compact` and reach only the classic hooks, and this passes all of
  // them: (1) a model whose window source is `auto` (under 1M in the catalog), (2) the in-process runner, (3) an isolated sub-agent (the built-in comment-thread-analyst,
  // `delegatedObservation`). That assumes the 1M models the handshake is built for (PLAN-42 caveat CAV-2): holding any of them by the MAIN agent's size would never release it (its own
  // context is not the main conversation's) and would end that agent's work at its window. Their contexts are short-lived and bounded, and the main agent's compaction stays held.
  if (e.trigger === 'auto' && (await hostRunsSessionCompact($))) return next(e)
  const v = await compactionVerdict($, e)
  let r: any
  try {
    r = await next(e)
  } catch (err) {
    if (v.pass) throw err
    return { block: v.reason }
  }
  return v.pass ? r : { ...r, block: v.reason }
}

// ---- DX-5222: each sub-agent is gated, and recommended, on its own --------------------------------------------------------------------------------------------

// Every model request of a sub-agent notes its context: `turn.step` (streaming) hands back the response with the usage the API reported and the model that answered. Only a
// sub-agent's request reaches this hook: the registration matches an `agentId`, and that matcher is the one place that keeps the main loop out (its size is `$.session.usage()`).
// The bookkeeping is plain arithmetic over a typed usage and a Map; the one thing that can throw is `subagentKey` on an id Claude Code never produces (DX-5328), which fails loud on purpose. It returns nothing, which the typed contract of a streaming hook defines as "its last next(e)'s result
// stands": the response the model gave passes on untouched (compaction-agents.test.tsx asserts the result a caller reads).
async function* noteAgentStep($: any, e: any, next: any): any {
  const response = yield* next(e)
  const size = response?.usage === null || response?.usage === undefined ? null : sizeOfUsage(response.usage)
  if (size !== null) {
    // DX-5328: sizes are kept under the canonical key the verdict and the handshake's `agents` map use; the event carries Claude Code's bare id
    const key = subagentKey(e.agentId)
    agentSizes.delete(key)
    agentSizes.set(key, size)
    if (agentSizes.size > AGENT_SIZES_KEEP) agentSizes.delete(agentSizes.keys().next().value as string)
  }
}

// Every `session.compact` event, whatever the trigger: this host runs it (`sessionCompactSeen`, one of the two inputs to `hostRunsSessionCompact`, with the engine release from 2.1.299), which arms
// the sub-agents' percent and hands the judging of automatic proposals to the per-agent gate below. Observes only.
async function onSessionCompactSeen($: any, e: any, next: any) {
  if (!(await read($, sessionCompactSeen))) await update($, sessionCompactSeen, () => true)
  // DX-5344: a person's own /compact (or the plugin's) is the main agent's, and replaces the note of a sub-agent proposal that never delivered a start
  if (e.trigger !== 'manual') return next(e)
  await noteCompacting($, null)
  return settledCompaction($, null, next, e)
}

// DX-5344: runs core's compaction and settles the agent's entry by what came back: a result that is not a skip is a compaction that finished, a skip or a throw is one that did not happen
// (the throw goes on).
async function settledCompaction($: any, agentId: string | null, next: any, e: any) {
  let r: any
  try {
    r = await next(e)
  } catch (err) {
    await settleCompacting($, agentId, false)
    throw err
  }
  await settleCompacting($, agentId, r?.skip === undefined)
  return r
}

// Claude Code's own automatic proposal (`session.compact`, trigger `auto`, and a `precompute`, the same compaction computed ahead of time) for the main agent or, with an `agentId`,
// for a sub-agent. A person's /compact (and the plugin's own start) is not matched here: the classic gate still sees it and spends a waiting ready. The main agent's verdict is the
// one the classic gate has always given (compactionVerdict); a sub-agent's is its own (agentCompactionVerdict). A `precompute` is judged the same way but SPENDS no release (it
// installs nothing; the compaction that follows is an `auto` proposal judged then) and announces nothing. A proposal that passes goes on to core, whose classic PreCompact hook
// leaves it alone (onPreCompact); one that does not is a skip, so core runs nothing.
async function onSessionCompact($: any, e: any, next: any) {
  const v = e.agentId === undefined ? await compactionVerdict($, e) : await agentCompactionVerdict($, e)
  if (!v.pass) return { skip: v.reason }
  // DX-5344: the proposal passed, so this agent compacts next (a precompute installs nothing and names nobody)
  if (e.trigger !== 'auto') return next(e)
  await noteCompacting($, e.agentId ?? null)
  return settledCompaction($, e.agentId ?? null, next, e)
}

async function agentCompactionVerdict($: any, e: any): Promise<AgentVerdict> {
  // DX-5328: the event's `agentId` is Claude Code's bare id; the control's `agents` map is keyed `agent-<id>`, so it is converted once here and the verdict sees only the key
  const spends = e.trigger === 'auto'
  let agentId: string = e.agentId
  try {
    agentId = subagentKey(e.agentId)
    const sessionId = String(await $.session.id())
    const key = usedReleaseKey(sessionId, agentId)
    const now = await $.clock.now()
    const v = agentVerdict({ agentId, file: await compactionControl($), size: agentSizes.get(agentId) ?? null, usedReleaseId: spentReleaseId(await $.store.get(key)), nowMs: now })
    if (v.pass && v.why === 'release' && spends) {
      // spent before the compaction runs: this agent's release passes once, however many proposals follow
      await $.store.set(key, { releaseId: v.releaseId, at: now })
      await pruneUsedReleases($)
      $.ui.toast(`Compacting sub-agent ${agentId} now: it said it is ready.`)
    } else if (v.pass && v.why === 'valve' && spends) $.ui.toast(`Compacting sub-agent ${agentId} now: its context reached the size where holding it would end its work.`)
    else if (!v.pass && v.told && !agentFaultTold.has(`${agentId}: ${v.reason}`)) {
      agentFaultTold.add(`${agentId}: ${v.reason}`)
      $.ui.toast(v.reason)
    }
    return v
  } catch (err: any) {
    const told = `Compaction gate could not decide for sub-agent ${agentId}, so Claude Code's own automatic compaction applies: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`
    if (compactionFaultTold !== told) $.ui.toast(told)
    compactionFaultTold = told
    return { pass: true, why: 'unreadable' }
  }
}

// Each sub-agent's request to prepare for compaction reaches THAT sub-agent only, through `$.session.send`, once per `ask.at`; the text is the dashboard's and never composed here, and
// the main agent's request is the relay's (it shows it as a record). Only a running sub-agent is sent to: a message to a finished one would resume it from its transcript. A failed
// send (a refusal, a rejection) is not recorded, so the next sync sends it again.
async function deliverAgentAsks($: any, file: ControlFile): Promise<void> {
  // DX-5314: no ask is delivered while sub-agent control is unavailable (an older relay)
  if (file.kind !== 'control' || file.control === null || file.control.subagents === null) return
  const asks = Object.entries(file.control.subagents.agents).flatMap(([id, a]) => (a.ask === null ? [] : [{ id, ask: a.ask }]))
  if (asks.length === 0) return
  const sessionId = String(await $.session.id())
  // DX-5328: the engine lists a sub-agent by its bare id, the control keys it `agent-<id>`. Converted per id: one id of the wrong form is left out and told once, and cannot break the sync
  // (which goes on to start the main agent's ready compaction).
  const running = new Set<string>()
  for (const a of (await $.agent.list()) as { id: string; status: string }[]) {
    if (a.status !== 'running') continue
    try {
      running.add(subagentKey(a.id))
    } catch (err: any) {
      const told = `Compaction request delivery skips sub-agent ${JSON.stringify(a.id)}: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`
      if (!agentFaultTold.has(told)) {
        agentFaultTold.add(told)
        $.ui.toast(told)
      }
    }
  }
  let recorded = false
  for (const { id, ask } of asks) {
    const key = askSentKey(sessionId, id)
    if (!running.has(id) || sentAskAt(await $.store.get(key)) === ask.at) continue
    // DX-5222: the claim, one compare-and-set before the send: of every sync that read this request as unsent, exactly one sends it
    let won = false
    await update($, claimedAsks, cur => {
      won = cur[key] !== ask.at
      return won ? { ...cur, [key]: ask.at } : cur
    })
    if (!won) continue
    try {
      const sent = await $.session.send({ to: { agentId: bareSubagentId(id) }, text: ask.text }) // DX-5328: `to.agentId` is the bare id
      if (!sent.isDelivered) throw new Error(sent.reason)
    } catch (err: any) {
      // the claim goes back, so the next sync sends it again
      await update($, claimedAsks, cur => Object.fromEntries(Object.entries(cur).filter(([k, at]) => !(k === key && at === ask.at))))
      const told = `Compaction request for sub-agent ${id} was not delivered: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`
      if (!agentFaultTold.has(told)) {
        agentFaultTold.add(told)
        $.ui.toast(told)
      }
      continue
    }
    await $.store.set(key, { at: ask.at, sentAt: await $.clock.now() })
    recorded = true
  }
  if (recorded) await pruneSessionRecords($, ASK_SENT_PREFIX, 'sentAt')
}

// The briefing's sources, each read on its own: one that cannot be read says so in the briefing and does not take the others with it.
async function briefingSource<T>(readSource: () => Promise<T>): Promise<Source<T>> {
  try {
    return { ok: true, value: await readSource() }
  } catch (err: any) {
    return { ok: false, reason: errMessage(err) }
  }
}

async function compactionBriefing($: any): Promise<string> {
  const v = await read($, view)
  const cards = await briefingSource<BriefingCard[]>(async () => v.inProgress.map(c => ({ id: c.id, title: c.title })))
  const agents = await briefingSource<BriefingAgent[]>(async () => {
    const listed: { id: string; type: string; description: string; status: string }[] = await $.agent.list()
    return listed.filter(a => a.type !== 'teammate' && a.status === 'running').map(a => ({ id: a.id, type: a.type, description: a.description }))
  })
  const git = await briefingSource<GitState>(async () => {
    const out = await $.process.run(['git', 'status', '--porcelain=v1', '-b'], { cwd: await $.session.cwd(), timeoutMs: GIT_STATUS_TIMEOUT_MS })
    if (out.exitCode !== 0) throw new Error(`git status exited ${out.exitCode}`)
    const state = parseGitStatus(out.stdout)
    if (state === null) throw new Error('git status printed nothing readable')
    return state
  })
  return briefingText({ plan: v.connected === null ? null : { ref: v.connected.ref, name: v.connected.name }, cards, agents, git })
}

// DX-4982: the plugin's `dashboard_url` option, as the engine passed it to register (the last resort of blockedOrigin)
let dashboardOption: string | undefined

export const register: Register = (on, options) => {
  dashboardOption = optionDashboardUrl(options)
  on('session.start', onSessionStart)
  on('session.attach', onSessionAttach)
  on('session.end', onSessionEnd)
  on('command.run', { command: COMMAND }, onCommand)
  // DX-4805: the plugin ships the permission its own calls to its own server need (ownServerCheck, hooks/relay/refusal.ts)
  on('tool.check', (_$, e, next) => ownServerCheck(e, next))
  on('tool.call', { tool: toolName('plan_connect') }, onPlanConnect)
  on('tool.call', { tool: toolName('request_permission') }, onRequestPermission)
  on('turn.start', onTurnStart)
  on('turn.complete', onTurnComplete)
  // DX-4993 / DX-5231: an automatic compaction is held while the session is under the handshake; the agent's ready starts /compact itself (startReadyCompaction)
  on('classic.PreCompact', onPreCompact)
  // DX-5222: Claude Code's own automatic proposals (and the same compaction computed ahead of time) are judged per agent (a person's /compact and the plugin's own start are not matched: the classic gate answers them); each sub-agent's
  // last response is noted at `turn.step`
  on('session.compact', onSessionCompactSeen)
  on('session.compact', { trigger: /^(auto|precompute)$/ }, onSessionCompact)
  // only a sub-agent's requests (an agentId): the main loop's every streamed chunk would otherwise cross into the plugin for nothing
  on('turn.step', { agentId: /.+/ }, noteAgentStep)
  on('session.measure', onMeasure)
  // DX-4340: usage pacing denies or downgrades a sub-agent spawn (never a tool call: saving work stays possible)
  on('agent.spawn', ($, e, next) => spawnGuard(pacingEnv($))(e, next))
  on('classic.SubagentStart', onSubagentStart)
  on('classic.SubagentStop', onSubagentStop)
  on('classic.SessionStart', onClassicSessionStart)
  // DX-4235: the shells' ends and (DX-4534) the ready-cards check
  on('classic.Stop', onReportStop)
  on('prompt.submit', onPromptStamp)
  on('tool.call', onToolStamp)
  on('classic.UserPromptSubmit', onTitle)
  on('ui.render', { component: 'AbovePrompt' }, drawBand)
  on('ui.render', { component: 'SessionMode' }, drawSessionMode)
  on('ui.render', { component: 'AssistantMessage' }, drawAssistantMessage)
}
