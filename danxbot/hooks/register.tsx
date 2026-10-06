import { atom, read, update } from 'claude-code'
import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, SessionRateLimit } from 'claude-code'

import type { ConnectedPlan, Draft, PanelState, PermissionRequest, PlanRow, ProblemRow, RefreshGate, RelayState, SolutionRow, StepRow, TurnState } from '../types'
import { approvalRequestOf, approvalSubject, approvalToast } from './plan/approval'
import type { ApprovalRequest, OpenFailure } from './plan/approval'
import { renderBand } from './plan/band'
import { asApproval, claimPath, permissionRequestOf, publicIdOf, settle } from './plan/permission'
import { linkCardIds } from './plan/card-links'
import { settleDetached } from './plan/detached'
import { renderFooter } from './plan/footer'
import type { Handlers } from './plan/handlers'
import { footerLabel } from './plan/words'
import { parsePreviewStart, parseTabId, parseTabsContext, parseTabsSelect } from './plan/browser-output'
import {
  APPROVAL_TOAST_MS,
  BROWSER_TOAST_MS,
  CALL_ERROR_MAX,
  COMMAND,
  CONNECT_ERROR_MAX,
  EMPTY,
  LIVE_REASON_MAX,
  LOCK_STALE_MS,
  MIN_GAP_MS,
  NO_LIVE,
  PANE,
  PERMISSION_POLL_MS,
  PERMISSION_TOLD_MAX,
  PLAN_TITLE,
  PACING_POLL_MS,
  SIGNED_IN_TOAST,
  keyRevokedLabel,
  SIGN_IN_DENIED_TOAST,
  SIGN_IN_EXPIRED_TOAST,
  SIGN_IN_MIN_ROUND_MS,
  SUBAGENT_SETTLE_MS,
  TICK_MS,
  MIN_USAGE_TICK_MS,
  USAGE_PATH,
  USAGE_TICK_MS,
  signInFailedToast,
  LEGACY_PROJECT_API_TOOL,
  SERVER,
  START_RETRY_MS,
  toolName,
  NOTE_MARKER,
  TOAST_ERROR_MAX,
  busyKey,
} from './plan/config'
import { errText, loadPlan } from './plan/load'
import type { Api } from './plan/load'
import { isServerNotConnected, isSignedOut, mcpText, outcomeRevokedBy, refusalText, toolOutcome } from './plan/mcp'
import type { ToolOutcome } from './plan/mcp'
import { answerNote, connectNote, disconnectNote, signInApprovedNote, signInDeniedNote, signInExpiredNote, signInNote } from './plan/notes'
import { renderPane } from './plan/pane'
import { signInStep } from './plan/sign-in'
import { NEW_READER, exitReason, liveReaderArgv, mergeSnapshots, pruneSnapshots, readPiece } from './plan/live'
import { classifyCallError, readWaitAnswer, waitArgs } from './relay/answer'
import type { RelayEvent, WaitAnswer } from './relay/answer'
import { CURSOR_PREFIX, MIN_ROUND_MS, RELAY_OFF, RELAY_TOOL, backoffMs } from './relay/config'
import { IDLE, deliveryMode, eventRow, requestSent, rowAppended, turnEnded, turnStarted } from './relay/delivery'
import { cursorFor, cursorKey, staleCursorKeys } from './relay/cursor'
import { OLD_SERVER_DETAIL, OLD_SERVER_FIX, RELAY_ERROR_FIX, delayedLine, notTakenLine, stoppedLine } from './relay/text'
import { shownSubagents } from './plan/subagent-cards'
import { liveAgentsAt, usageBody } from './plan/usage'
import type { LiveAgent } from './plan/usage'
import { spawnGuard } from './plan/pacing-guard'
import { pacingLine, peekPacing, refreshPacing, resetPacing, withLine } from './plan/pacing-line'
import { EMPTY_PANEL_STATE, buildPanel } from './plan/pacing-panel'
import { readTeamSettings } from './plan/pacing-settings'

// $.state atoms: the engine's scan reads an atom's plugin and key only from a const in the file that
// uses it (DX-4232), so they are declared here, not in ./plan/config.
const view = atom({ plugin: 'danxbot', key: 'view' } as const, EMPTY)
const gate = atom({ plugin: 'danxbot', key: 'gate' } as const, { inFlight: false, again: false, at: null } as RefreshGate)
const pick = atom({ plugin: 'danxbot', key: 'pick' } as const, '')
const switching = atom({ plugin: 'danxbot', key: 'switching' } as const, false)
// the band is hidden for the session: its own atom, since refresh replaces `view` whole
const dismissed = atom({ plugin: 'danxbot', key: 'dismissed' } as const, false)
const expanded = atom({ plugin: 'danxbot', key: 'expanded' } as const, null as number | null)
const busy = atom({ plugin: 'danxbot', key: 'busy' } as const, [] as string[])
const draft = atom({ plugin: 'danxbot', key: 'draft' } as const, null as Draft | null)
const talk = atom({ plugin: 'danxbot', key: 'talk' } as const, null as number | null)
// DX-4232: the browser tab id lives in $.state, never in a module variable (a module variable is
// lost on reload and shared by nothing else).
const tab = atom({ plugin: 'danxbot', key: 'tab' } as const, null as string | null)
const title = atom({ plugin: 'danxbot', key: 'title' } as const, null as string | null)
// DX-4391: the approval URL last opened (a request opens its page once).
const approvalOpened = atom({ plugin: 'danxbot', key: 'approvalOpened' } as const, null as string | null)
// DX-4435: the model's `request_permission` requests not yet decided, oldest first; the band counts them.
const permissionRequests = atom({ plugin: 'danxbot', key: 'permissionRequests' } as const, [] as PermissionRequest[])
// DX-4499: the clock a running sub-agent's runtime counts up against (see tickClock).
const tick = atom({ plugin: 'danxbot', key: 'tick' } as const, 0)
// DX-4508: the main session's transcript path (the classic events carry it) and the live child's reports for this session.
const transcript = atom({ plugin: 'danxbot', key: 'transcript' } as const, null as string | null)
const live = atom({ plugin: 'danxbot', key: 'live' } as const, NO_LIVE)
// DX-4336: the text of the last usage report's failure (null while the reports are accepted), so a failure that repeats every tick is
// shown once, not every minute.
const usageError = atom({ plugin: 'danxbot', key: 'usageError' } as const, null as string | null)
// DX-4336: when the last API response arrived (epoch ms), the age of the usage figure; null until the session has seen one.
const measuredAt = atom({ plugin: 'danxbot', key: 'measuredAt' } as const, null as number | null)
// DX-4336: the sub-agents running now (id and start time), from SubagentStart / SubagentStop. Keyed by id, not a counter: a stop for an agent
// that was never counted (a reload lost the start, a duplicate stop) changes nothing, so the count cannot go negative; an entry older than
// SUBAGENT_LIVE_MAX_MS (an agent that died with no stop) is no longer counted.
const liveAgents = atom({ plugin: 'danxbot', key: 'liveAgents' } as const, [] as LiveAgent[])
// DX-4339: what the usage pacing panel draws from: the session's own windows, the team's settings and the account verdict as last read.
const panel = atom({ plugin: 'danxbot', key: 'panel' } as const, EMPTY_PANEL_STATE as PanelState)
// DX-4233: the plan event relay's state (the pane's event line), and the main loop's turn (TurnState).
const relay = atom({ plugin: 'danxbot', key: 'relay' } as const, RELAY_OFF as RelayState)
const turn = atom({ plugin: 'danxbot', key: 'turn' } as const, IDLE as TurnState)

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
type RelayRun = { planId: number; dead: boolean; told: string | null }
let relayRun: RelayRun | null = null
// The plan whose relay the server stopped, or that is signed out: it is not started again until something asks (a connect, the
// model's plan_connect, a sign-in), so a refresh cannot restart a stopped relay in a loop.
let relayHalted: number | null = null
// DX-4339: the pacing panel's poll, one per session.
let pacingTicker: { cancel: () => void } | null = null
// DX-4336: the usage report's timer, one per session.
let usageTicker: { cancel: () => void } | null = null
// DX-4499: the runtime clock's timer, one per session.
let runtimeClock: { cancel: () => void } | null = null
// DX-4530: the fast claim poll, running only while a permission request is open (syncPermissionPoll).
let permissionTicker: { cancel: () => void } | null = null
// DX-4530: a fast tick is skipped while the last one's claims are still out (slow answers must not stack claim traffic). A
// module variable: a reload starts with no claim of its own in flight.
let permissionTickBusy = false
// DX-4508: the live child's stream, at most one; a handle, so a module variable (a reload kills the child with the module).
let liveChild: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null
// DX-4508: the live checks run one after another, so two events landing together cannot both start a child.
let liveQueue: Promise<void> = Promise.resolve()

// One dashboard call through the session's own danx-dashboard MCP server (the plugin's, SERVER): same credential, same
// x-danx-session-id header. Any rejection (including the engine's "no such server") is an error shown as one.
async function api($: any, method: string, path: string, extra: { query?: object; body?: object } = {}): Promise<Api> {
  let res
  try {
    res = await $.mcp.call(SERVER, 'danxbot_api', { method, path, ...extra })
  } catch (err: any) {
    const message = String(err?.message ?? err)
    // DX-4578: `unreachable` is the engine's "no such server" and nothing else: the plugin's own server is not connected (yet). The plan
    // load carries it on its error view (`serverNotConnected`, which the session-start retry waits out); the pacing and usage readers
    // stay quiet about it until a read has succeeded.
    const notConnected = isServerNotConnected(message)
    const failed: Api = { ok: false, status: 0, body: { error: message.slice(0, CALL_ERROR_MAX) } }
    if (!notConnected) return failed
    failed.unreachable = true
    if (await isStandbySession($)) failed.staleServer = true
    return failed
  }
  return toolOutcome(res)
}

// DX-4610: whether this session runs the plugin's server as the old idle standby (plugin 0.12.57 and older, started in a repo with its own
// `danx-dashboard` entry): the engine words that server's missing tools like a server not connected yet, so the rejection cannot say. The
// session's tool list can: it has the repo's own `danx-dashboard` tool and none of the plugin's. A fresh session in a checkout that still has
// the repo entry matches too until its server connects; its next load (the start retries, then the refresh) reads connected and clears it.
async function isStandbySession($: any): Promise<boolean> {
  let names: string[]
  try {
    names = (await $.tool.list()).map((t: any) => t.name)
  } catch {
    // a tool list that cannot be read cannot say so: the plain not-connected failure stands, and its retries and refreshes go on
    return false
  }
  return names.includes(LEGACY_PROJECT_API_TOOL) && !names.includes(toolName('danxbot_api'))
}

const DASHBOARD_ORIGIN_KEY = 'dashboardOrigin'

async function loadView($: any) {
  const refreshedAt = new Date(await $.clock.now()).toISOString()
  const loaded = await loadPlan((method, path, extra) => api($, method, path, extra), refreshedAt, await read($, expanded))
  // DX-4521: the band's links need the dashboard origin even when this load could not read it (signed out, a failed call, a
  // session just started): the last origin a plan list answered is kept in $.store (across sessions) and stands in for it.
  if (loaded.dashboardUrl !== null) {
    await $.store.set(DASHBOARD_ORIGIN_KEY, loaded.dashboardUrl)
    return loaded
  }
  const seen = await $.store.get(DASHBOARD_ORIGIN_KEY)
  return typeof seen === 'string' ? { ...loaded, dashboardUrl: seen } : loaded
}

// One load in flight at a time, at least MIN_GAP_MS apart unless forced. A forced refresh asked
// while one runs makes it run once more, so a write's result is never left unread. The gate is
// $.state, not module variables (lost on reload).
async function refresh($: any, force = false): Promise<void> {
  const now = await $.clock.now()
  let go = false
  await update($, gate, cur => {
    // a lock held past LOCK_STALE_MS belongs to a load that never settled: any request takes it over
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
  // stop every later refresh (the Refresh button included).
  try {
    let again = true
    while (again) {
      try {
        const v = await loadView($)
        // DX-4423: the plan the session was on is kept through every view that does not know it (a failed load, a signed-out one)
        // for Sign in to ask for again; a loaded view knows its own
        await update($, view, cur => (v.phase === 'ready' ? v : { ...v, resumePlan: cur.connected?.id ?? cur.resumePlan }))
        // DX-4233: the view says which plan this session is on, so it says whether a relay runs and for which
        await syncRelay($)
        await syncRuntimeClock($)
        await syncLive($, false)
      } catch (err: any) {
        await update($, view, cur => ({ ...cur, phase: 'error', error: String(err?.message ?? err) }))
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
// poll: a request has no expiry clock of its own. The model is told each decision once, in its chat.
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
    if (typeof note === 'string' && (await markToldOnce($, r.publicId))) await tellModel($, note)
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
// Marked before the telling, so a telling that fails is toasted (tellModel) and never repeated. The read-then-write is not atomic:
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
    // The write the operator asked for already happened: say the model was not told, and carry the
    // row it was meant to read (the operator can paste it), never hide it.
    $.ui.toast(`Could not tell the model: ${String(err?.message ?? err).slice(0, TOAST_ERROR_MAX)}${NOTE_MARKER}${text}`)
  }
}

// One Claude_Browser call; an error result throws with its text.
async function browserOk($: any, tool: string, args: object): Promise<string> {
  const r = await $.mcp.call('Claude_Browser', tool, args)
  if (r.isError) throw new Error(mcpText(r))
  return mcpText(r)
}

// An open's two outcomes: `failed` is null once the tab is in front, else the step and the cause;
// `loaded` settles (never rejects) when the page has loaded: null, or the navigate failure.
type Opening = { failed: OpenFailure | null; loaded: Promise<OpenFailure | null> }

// Opens `url` in the ONE in-app browser tab this plugin owns (id kept in $.state), so the
// person's own tabs are never navigated away. DX-4424: measured live (2026-10-04), every call that
// acts on a page, a `navigate` included, costs ~2.5-3.5 s whatever the page is (the page itself
// finished loading in 143 ms), while the tab calls (`tabs_context`, `tabs_select`, `tabs_create`) cost
// ~0.8-1 s. So the tab is brought forward FIRST and the `navigate` is started, never awaited:
//   tab already ours     tabs_select {tabId}, then navigate {url, tabId} (no tabs_context first). A
//                        tabs_select that fails (the tab was closed, the pane is gone) is not an
//                        error: the slow path below revalidates and replaces it;
//   pane closed          preview_start {url}: the one call that opens the pane (a navigate with no
//                        tabId is refused). It names the tab, which we keep (navOk must be true) and
//                        it loads the page itself, so there is nothing left to wait for;
//   pane open, tab ours  tabs_context, tabs_select, navigate {url, tabId};
//   pane open, no tab    tabs_context, tabs_create, tabs_select, navigate {url, tabId}, keep its id.
// Any step that fails or answers something unreadable is a failure: reading it as "no tabs" would
// open a new tab on every press. `failed` is null once the tab is in front, else the step and the
// cause. The caller holds the browser busy key through `failed` only, never through `loaded`.
async function tryOpen($: any, url: string): Promise<Opening> {
  let step = 'tabs_select'
  try {
    let tabId = await read($, tab)
    if (tabId && !(await fronted($, tabId))) tabId = null
    if (!tabId) {
      step = 'tabs_context'
      const ctx = parseTabsContext(await browserOk($, 'tabs_context', {}))
      if (!ctx.browserOpen) {
        step = 'preview_start'
        const made = parsePreviewStart(await browserOk($, 'preview_start', { url }))
        await update($, tab, () => made)
        return { failed: null, loaded: Promise.resolve(null) }
      }
      tabId = await read($, tab)
      if (!tabId || !ctx.tabs.some(t => t.id === tabId)) {
        step = 'tabs_create'
        const made = parseTabId(await browserOk($, 'tabs_create', { foreground: true }))
        await update($, tab, () => made)
        tabId = made
      }
      step = 'tabs_select'
      parseTabsSelect(await browserOk($, 'tabs_select', { tabId }), tabId)
    }
    const loaded = browserOk($, 'navigate', { url, tabId }).then(
      () => null,
      (err: any): OpenFailure => ({ step: 'navigate', message: String(err?.message ?? err).slice(0, TOAST_ERROR_MAX) }),
    )
    return { failed: null, loaded }
  } catch (err: any) {
    return { failed: { step, message: String(err?.message ?? err).slice(0, TOAST_ERROR_MAX) }, loaded: Promise.resolve(null) }
  }
}

// The stored tab brought forward, no tabs_context first. False when the host cannot front it (the
// answer is an error or not "Fronted tab <id>."): the caller then re-reads the tabs.
async function fronted($: any, tabId: string): Promise<boolean> {
  try {
    parseTabsSelect(await browserOk($, 'tabs_select', { tabId }), tabId)
    return true
  } catch {
    return false
  }
}

// The advice first, the (cut) detail last: a cut sentence must not end the toast.
const openFailedToast = (failed: OpenFailure) => `Browser ${failed.step} failed: use the link instead. (${failed.message})`

// The plan's own open (the band and pane buttons). The open holds the browser busy key until the tab
// is in front, so the buttons read "Opening…" and a second press while it runs does nothing; the page
// then loads in the tab on its own, and a failure of that load is toasted when it comes.
async function openInBrowser($: any, url: string): Promise<void> {
  let loaded: Promise<OpenFailure | null> = Promise.resolve(null)
  await withBusy($, busyKey.browser, async () => {
    $.ui.toast('Opening the plan in the browser…', { timeoutMs: BROWSER_TOAST_MS })
    const opening = await tryOpen($, url)
    loaded = opening.loaded
    if (opening.failed === null) $.ui.toast('Plan opened in the browser tab', { timeoutMs: BROWSER_TOAST_MS })
    else $.ui.toast(openFailedToast(opening.failed))
  })
  void loaded.then(failed => failed && $.ui.toast(openFailedToast(failed)))
}

// DX-4391: the approval page's open. ONE toast tells the outcome, with the confirm code and the
// link in it either way, for 60 s (the host's longest): a toast replaces the one before it, so a
// failure toast shown first would be gone before anyone read the cause. The plugin's browser call
// may be refused (PLAN-23 records that the host asks the person to allow a site first, which a plugin
// cannot raise; not yet seen live for this open), which is what the cause then says. A browser already
// busy with another open is told too. DX-4424: the toast comes once the tab is in front; a later
// failure of the page load toasts again with the same code and link. `forget` is showApproval's: any failure clears its
// once-per-URL record so the next request retries.
async function openApprovalPage($: any, approval: ApprovalRequest, forget: () => Promise<unknown>): Promise<void> {
  let opening: Opening = { failed: { step: 'busy', message: 'another browser open is in progress' }, loaded: Promise.resolve(null) }
  await withBusy($, busyKey.browser, async () => {
    opening = await tryOpen($, approval.url)
  })
  if (opening.failed !== null) await forget()
  $.ui.toast(approvalToast(approval, opening.failed), { timeoutMs: APPROVAL_TOAST_MS })
  void opening.loaded.then(async failed => {
    if (failed === null) return
    await forget()
    $.ui.toast(approvalToast(approval, failed), { timeoutMs: APPROVAL_TOAST_MS })
  })
}

// DX-4391 / DX-4423: a request's page opens once and its code is shown, wherever the request came from (the model's own
// `plan_connect` or the Sign in button): the same URL is not reopened while its open stands. Recorded before the open so a
// repeat during the open does not start a second one, and cleared when the open fails (a refused site permission, a pane
// not ready), so the next attempt retries; the toast carries the link meanwhile. `force` is an explicit Sign in press: it
// opens again even for a URL already recorded. The open is not awaited: its browser calls take about 1 to 3.5 s each
// (DX-4424) and the caller, a model's tool answer or a button, must not wait on them. A failure past tryOpen (the busy
// key, the toast itself) must still leave the link.
async function showApproval($: any, approval: ApprovalRequest, force = false): Promise<void> {
  if (!force && (await read($, approvalOpened)) === approval.url) return
  await update($, approvalOpened, () => approval.url)
  const forget = () => update($, approvalOpened, cur => (cur === approval.url ? null : cur))
  openApprovalPage($, approval, forget).catch(async () => {
    await forget()
    $.ui.toast(`Approve ${approvalSubject(approval)} in the browser: ${approval.url} (confirm code ${approval.code})`, { timeoutMs: APPROVAL_TOAST_MS })
  })
}

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

// DX-4423 / DX-4418: a connect or leave pressed on a pane that went stale: the key is gone since the pane drew. The person is told
// in the view's words, never the server's (a revoked key's answer is the agent's stop order), and the view reloads to say so.
// True when that was the answer.
async function accessEnded($: any, outcome: ToolOutcome): Promise<boolean> {
  const by = outcomeRevokedBy(outcome)
  if (by === null && !isSignedOut(outcome)) return false
  $.ui.toast(by !== null ? `${keyRevokedLabel(by)}. This session must stop.` : 'Signed out. Sign in from the band or the pane.')
  await refresh($, true)
  return true
}

function connect($: any, plan: PlanRow): Promise<void> {
  return withBusy($, busyKey.connect(plan.id), async () => {
    const sessionTitle = await read($, title)
    let r
    try {
      r = await $.mcp.call(SERVER, 'plan_connect', {
        plan_id: plan.id,
        ...(sessionTitle ? { title: sessionTitle } : {}),
      })
    } catch (err: any) {
      $.ui.toast(`Connect failed: ${String(err?.message ?? err).slice(0, CONNECT_ERROR_MAX)}`)
      return
    }
    const outcome = toolOutcome(r)
    if (await accessEnded($, outcome)) return
    if (!outcome.ok) {
      // a refusal is `ok: false`, not an error result: nothing connected, so the model is told nothing
      $.ui.toast(`Connect refused: ${refusalText(outcome)}`.slice(0, CONNECT_ERROR_MAX))
      return
    }
    $.ui.toast(`Connected to ${plan.ref}`)
    await update($, switching, () => false)
    await tellModel($, connectNote(plan))
    // DX-4233: the refresh starts the relay of the plan connected (syncRelay), a halt of another plan being cleared there
    await refresh($, true)
  })
}

// Takes the session OFF its plan (plan_connect with disconnect: true, guarded by the plan we think we
// are on). A refusal is shown, never swallowed: a 409 means the pane was stale (the server names the
// plan the session is really on, or says it is on none), so it also refreshes; a 404 or any other
// failure carries its status and message. No confirm: one Connect undoes it.
function disconnect($: any, plan: ConnectedPlan): Promise<void> {
  return withBusy($, busyKey.disconnect(plan.id), async () => {
    let r
    try {
      r = await $.mcp.call(SERVER, 'plan_connect', { plan_id: plan.id, disconnect: true })
    } catch (err: any) {
      $.ui.toast(`Disconnect failed: ${String(err?.message ?? err).slice(0, CONNECT_ERROR_MAX)}`)
      return
    }
    const outcome = toolOutcome(r)
    if (await accessEnded($, outcome)) return
    if (!outcome.ok) {
      $.ui.toast(`Disconnect refused: ${refusalText(outcome)}`.slice(0, CONNECT_ERROR_MAX))
      if (outcome.status === 409) await refresh($, true)
      return
    }
    const left = outcome.body?.leftPlan
    if (typeof left?.name !== 'string') {
      // a 200 that names no plan left cannot be told to the model as fact: show it, and read the truth
      $.ui.toast('Disconnect failed: the answer named no plan left')
      await refresh($, true)
      return
    }
    $.ui.toast(`Disconnected from ${plan.ref}`)
    await update($, switching, () => false)
    await tellModel($, disconnectNote({ ref: plan.ref, name: left.name }))
    await refresh($, true)
  })
}

// DX-4423 / DX-4548: the wait on a sign-in request, one at a time. A session with no dashboard key asks for one through
// `plan_connect`; the MCP answers with the approval request, shown as the model's own would be (showApproval). Each call waits
// there (about 45 s) for the person's approval, so the calls repeat until one answers something final, with no round limit: a
// request stays open for as long as its session lives (DX-4530). The status of the request cannot be read any other way: its
// claim needs a secret only the MCP process holds (and a claim would take the key from it), and reading it by id needs a
// person's login. A call that answers a DIFFERENT request than the one watched means the first expired while it waited: the
// model is told, and the renewed request is shown and watched in its place, so nobody has to relay it.
//
// Two starts: the Sign in button (`byPress`: the person is waiting, the page opens again, and the model is told once that it is
// signed in), and the model's own `plan_connect` answering `approval_required` (`known`: the request already shown; the model is
// told the outcome once, approved, denied or expired, so the person never has to type "approved"). The whole watch holds the
// sign-in busy key (the buttons read "Signing in…", a second start does nothing).
let signInWatching: ApprovalRequest | null = null
// DX-4548: bumped when the conversation (or the process) ends; a watch of an older generation stops at its next step, so it
// never calls plan_connect with the old conversation's arguments or tells the new conversation about a request it never made
let signInGeneration = 0

type SignInWatch = { args: object } & ({ byPress: true } | { byPress: false; known: ApprovalRequest })

async function watchSignIn($: any, watch: SignInWatch): Promise<void> {
  const generation = signInGeneration
  await withBusy($, busyKey.signIn, async () => {
    const ended = () => generation !== signInGeneration
    let shown: ApprovalRequest | null = watch.byPress ? null : watch.known
    signInWatching = shown
    // DX-4530: each outcome is told once (the told-once guard, keyed by the request). The model's request always has an id
    // (onPlanConnect and the renewal below refuse one without); only the press may see one with none, and it tells once per watch.
    const tell = async (request: ApprovalRequest | null, text: string) => {
      const key = request === null ? undefined : publicIdOf(request.url)
      if (key === undefined ? watch.byPress : await markToldOnce($, key)) await tellModel($, text)
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
          if (!ended()) $.ui.toast(signInFailedToast(String(err?.message ?? err)))
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
          if (shown === null || step.request.url !== shown.url) await showApproval($, step.request)
          shown = step.request
          signInWatching = shown
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
      if (!ended()) signInWatching = null
    }
    // DX-4548: an aborted watch's key was freed at the abort (onSessionEnd); a new watch may hold it by now, so this one never frees it
  }, () => generation === signInGeneration)
}

// The button's press returns at once: the sign-in waits minutes for a person, and a press must not. A watch already running
// (the model's own sign-in) opens its page again instead of starting a second wait.
function startSignIn($: any): Promise<void> {
  if (signInWatching !== null) return showApproval($, signInWatching, true)
  return signInArgs($).then(args => {
    void watchSignIn($, { args, byPress: true }).catch(err => $.ui.toast(signInFailedToast(String(err?.message ?? err))))
  })
}

// The sign-in's own `plan_connect` arguments: the session's title, and the plan it was on.
async function signInArgs($: any): Promise<object> {
  const sessionTitle = await read($, title)
  const resume = (await read($, view)).resumePlan
  return { ...(resume !== null ? { plan_id: resume } : {}), ...(sessionTitle ? { title: sessionTitle } : {}) }
}

// One write to a problem (answer, comment, step tick), inside its busy claim: call, toast a
// refusal, re-read the plan. It touches nothing the operator is composing; an answer clears the
// draft. Resolves true when the write was made and accepted.
async function write(
  $: any,
  p: ProblemRow,
  path: string,
  method: string,
  body: object,
  done: string,
  isAnswer = false,
): Promise<boolean> {
  const r = await api($, method, `/api/issues/${p.cardId}/${path}`, { body })
  if (!r.ok) {
    $.ui.toast(`${p.cardId} PBLM-${p.id}: ${errText(r)}`)
    return false
  }
  if (done) $.ui.toast(done)
  // PBLM-1913: an answered problem leaves the pane at once. A refresh asked while another runs is
  // only queued (see refresh), so the view is corrected here, not left stale until it finishes.
  if (isAnswer) await update($, view, cur => ({ ...cur, problems: cur.problems.filter(x => x.id !== p.id) }))
  await refresh($, true)
  return true
}

function act($: any, p: ProblemRow, path: string, method: string, body: object, done: string): Promise<void> {
  return withBusy($, busyKey.problem(p.id), async () => void (await write($, p, path, method, body, done)))
}

// THE answer: the one place a body and its label meet, and the one re-entry guard for every
// answer path (a busy claim for presses that overlap, the open-in-view check for ones that
// queue). Answers the problem, clears the note or rejection draft (only an answer does), then
// tells the model (it did not make the call).
function answer($: any, p: ProblemRow, body: Record<string, unknown>, label: string): Promise<void> {
  return withBusy($, busyKey.problem(p.id), async () => {
    // A press can reach a drawing that is already stale (a second press queued behind the first,
    // run after it finished): a problem no longer open in the view was answered already.
    if (!(await read($, view)).problems.some(x => x.id === p.id)) return
    if (!(await write($, p, `problems/${p.id}/answer`, 'POST', body, `Answered: ${label}`, true))) return
    await update($, draft, () => null)
    await tellModel($, answerNote(p, label))
  })
}

function useSolution($: any, p: ProblemRow, s: SolutionRow): Promise<void> {
  return answer($, p, { solution_id: s.id }, s.title)
}

// A note (or a rejection reason) is required: an empty one is refused here, with no API call.
async function useSolutionWithNote($: any, p: ProblemRow, s: SolutionRow, text: string): Promise<void> {
  const note = text.trim()
  if (!note) {
    $.ui.toast('A note is required.')
    return
  }
  await answer($, p, { solution_id: s.id, note }, `${s.title} (note: ${note})`)
}

async function rejectSolution($: any, p: ProblemRow, s: SolutionRow, text: string): Promise<void> {
  const reason = text.trim()
  if (!reason) {
    $.ui.toast('A note is required to reject.')
    return
  }
  await answer($, p, { solution_id: s.id, outcome: 'rejected', note: reason }, `REJECTED "${s.title}" (reason: ${reason})`)
}

async function answerFreeform($: any, p: ProblemRow, text: string): Promise<void> {
  const freeform = text.trim()
  if (freeform) await answer($, p, { freeform }, `"${freeform}"`)
}

async function postComment($: any, p: ProblemRow, text: string): Promise<void> {
  const comment = text.trim()
  if (comment) await act($, p, 'comments', 'POST', { text: comment, problem_id: p.id }, 'Comment posted')
}

function toggleDraft($: any, p: ProblemRow, solutionId: number, kind: 'note' | 'reject'): Promise<unknown> {
  return update($, draft, cur =>
    cur && cur.problemId === p.id && cur.solutionId === solutionId && cur.kind === kind
      ? null
      : { problemId: p.id, kind, solutionId },
  )
}

// DX-4374: the one way into the plan UI, for the footer button and /danx-plan alike: bring the band
// back (clear `dismissed`) and open the Plan pane. It never closes anything and tells the model nothing
// (R-4 covers actions that change plan state; this changes none).
async function showPlan($: any): Promise<void> {
  await update($, dismissed, () => false)
  await openPlanPane($)
}

// The one open of the Plan pane (the band's Panel button and showPlan): focused, so it takes the keyboard.
function openPlanPane($: any): Promise<unknown> {
  return $.ui.open({ id: PANE, title: PLAN_TITLE, focus: true })
}

// The band's close control: the band hides until the footer button or /danx-plan is used.
async function dismissBand($: any): Promise<void> {
  await update($, dismissed, () => true)
}

// The band's permission button: the newest open request's page again, with its code (a press is an explicit open).
async function openNewestPermissionRequest($: any): Promise<void> {
  const newest = (await read($, permissionRequests)).at(-1)
  if (newest !== undefined) await showApproval($, asApproval(newest), true)
}

function handlers($: any): Handlers {
  return {
    refresh: () => refresh($, true),
    openPane: () => openPlanPane($),
    openBrowserTab: url => openInBrowser($, url),
    connect: plan => connect($, plan),
    showPlan: () => showPlan($),
    dismissBand: () => dismissBand($),
    disconnect: plan => disconnect($, plan),
    signIn: () => startSignIn($),
    openPermissionRequest: () => openNewestPermissionRequest($),
    toggleSwitch: () => update($, switching, cur => !cur),
    cancelSwitch: () => update($, switching, () => false),
    pickPlan: value => update($, pick, () => value),
    // DX-4458: opening a problem reads its solutions and comments (a refresh reads the open one's)
    toggleExpanded: async id => {
      const opened = (await read($, expanded)) !== id
      await update($, expanded, () => (opened ? id : null))
      if (opened) await refresh($, true)
    },
    toggleTalk: id => update($, talk, cur => (cur === id ? null : id)),
    toggleDraft: (p, solutionId, kind) => toggleDraft($, p, solutionId, kind),
    useSolution: (p, s) => useSolution($, p, s),
    useSolutionWithNote: (p, s, note) => useSolutionWithNote($, p, s, note),
    rejectSolution: (p, s, reason) => rejectSolution($, p, s, reason),
    answerFreeform: (p, text) => answerFreeform($, p, text),
    checkStep: (p: ProblemRow, s: SolutionRow, step: StepRow) =>
      act($, p, `problems/${p.id}/solutions/${s.id}/steps/${step.id}/check`, 'PATCH', { checked: !step.checked }, ''),
    comment: (p, text) => postComment($, p, text),
  }
}

// ---- hooks ----------------------------------------------------------------

// The first load can run before the plugin's MCP server connects. A view that failed on exactly that at session start is retried
// after each wait in START_RETRY_MS (on the clock, so a test moves it) and then left as the error.
async function retryWhileNotConnected($: any): Promise<void> {
  for (const wait of START_RETRY_MS) {
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
}

// DX-4374: v0.10.0 pinned a status line; the footer is the PLAN-NN button alone, so unpin anything an older loaded version left.
async function unpinStatus($: any): Promise<void> {
  await $.ui.status(undefined)
}

// DX-4499: the runtime clock runs only while the pane has a sub-agent to count (a running one, or an ended one not yet past its
// `visibleUntil`): started by a load that brings one, stopped by the first tick that finds none, so a plan with no sub-agents has no
// timer at all. A cosmetic timer: it makes no call, it only redraws a pane that shows the clock.
async function syncRuntimeClock($: any): Promise<void> {
  const shown = shownSubagents(await read($, view), await read($, live), await $.clock.now()).length > 0
  if (shown && runtimeClock === null) {
    runtimeClock = $.clock.every(TICK_MS, () => tickClock($))
  } else if (!shown && runtimeClock !== null) {
    runtimeClock.cancel()
    runtimeClock = null
  }
}

async function tickClock($: any): Promise<void> {
  const now = await $.clock.now()
  await update($, tick, () => now)
  await syncRuntimeClock($)
}

// ---- DX-4508: the live sub-agent numbers ------------------------------------
// While this session is plan-connected and has a running sub-agent (`$.agent.list()`), ONE host child streams its sub-agents'
// numbers: `node <plugin root>/scripts/subagents-live.mjs <main transcript>` (the installed danx-dashboard-mcp's `subagents-live`), one
// JSON line per change. Each line is checked and merged into the `live` atom, which redraws the pane with no dashboard read. The
// child stops once none runs. A child that cannot start, exits, or prints a line that cannot be read is one muted line in the
// section, the dashboard's numbers stand, and nothing retries until the next sub-agent starts.

function errMessage(err: any): string {
  return String(err?.message ?? err)
}

// `agent-<id>` -> status of this session's sub-agents (a teammate is not one), or why the engine could not list them.
async function agentStatuses($: any): Promise<Record<string, string> | string> {
  let agents: { id: string; type: string; status: string }[]
  try {
    agents = await $.agent.list()
  } catch (err: any) {
    return `the engine did not list this session's sub-agents (${errMessage(err)})`
  }
  // DX-4508: the dashboard and the live child name a sub-agent `agent-<agent id>`; `$.agent.list()` names it by the agent id alone
  return Object.fromEntries(agents.filter(a => a.type !== 'teammate').map(a => [`agent-${a.id}`, a.status]))
}

async function noteTranscript($: any, e: any): Promise<void> {
  const path = typeof e.transcript_path === 'string' ? e.transcript_path : ''
  if (path !== '') await update($, transcript, cur => (cur === path ? cur : path))
}

// Ends the child (leaving its loop kills it); its loop then sees it is no longer the child and returns quietly.
function stopLive(): void {
  const child = liveChild
  liveChild = null
  if (child !== null) void child.return(undefined as any)
}

async function liveFailed($: any, reason: string): Promise<void> {
  await update($, live, cur => ({ ...cur, warning: reason.slice(0, LIVE_REASON_MAX), failed: true }))
}

// `isStart`: a sub-agent just started, the one moment a failure is tried again.
function syncLive($: any, isStart: boolean): Promise<void> {
  liveQueue = liveQueue.then(() => checkLive($, isStart)).catch(err => liveFailed($, `the live check failed: ${errMessage(err)}`))
  return liveQueue
}

async function checkLive($: any, isStart: boolean): Promise<void> {
  if (isStart) await update($, live, cur => (cur.failed ? { ...cur, failed: false } : cur))
  if ((await read($, view)).connected === null) return stopLive()
  const statuses = await agentStatuses($)
  if (typeof statuses === 'string') {
    stopLive()
    return liveFailed($, statuses)
  }
  // with none running there is nothing live to show, so an earlier failure's line goes too (the failure itself stands)
  const anyRunning = Object.values(statuses).includes('running')
  await update($, live, cur => ({ ...cur, statuses, warning: anyRunning ? cur.warning : null }))
  if (!anyRunning) return stopLive()
  if (liveChild !== null || (await read($, live)).failed) return
  await startLive($)
}

async function startLive($: any): Promise<void> {
  const path = await read($, transcript)
  if (path === null) return liveFailed($, 'the session has not reported its transcript path yet')
  const sessionId: string = await $.session.id()
  const child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> = $.process.spawn({ argv: liveReaderArgv($.plugin.root, path) })
  liveChild = child
  // a new child's first line carries every sub-agent; until it comes, what this session's last child said stands
  await update($, live, cur => ({ ...cur, sessionId, warning: null, failed: false, snapshots: cur.sessionId === sessionId ? cur.snapshots : {} }))
  // DX-4546 / DX-4586: this detached promise has no caller to reject to; see `settleDetached`
  void settleDetached(readLive($, child))
}

// The child's life, detached from the event that started it (plugin-authoring: "a child for the session's life").
async function readLive($: any, child: HookStream<ProcessSpawnChunk, ProcessSpawnResult>): Promise<void> {
  let reader = NEW_READER
  let isFirst = true
  const ended = async (reason: string) => {
    if (liveChild !== child) return
    stopLive()
    await liveFailed($, reason)
  }
  try {
    for (;;) {
      const r = await child.next()
      // stopped (stopLive): whatever ended the stream was ours
      if (liveChild !== child) return
      if (r.done) return ended(exitReason(r.value, reader.stderr))
      const step = readPiece(reader, r.value, LIVE_REASON_MAX)
      reader = step.reader
      for (const snapshots of step.lines) {
        const statuses = await agentStatuses($)
        if (typeof statuses === 'string') return ended(statuses)
        const now = await $.clock.now()
        const first = isFirst
        isFirst = false
        await update($, live, cur => ({ ...cur, statuses, snapshots: pruneSnapshots(mergeSnapshots(cur.snapshots, snapshots, first), now) }))
      }
      if (step.failure !== null) return ended(step.failure)
      if (step.lines.length > 0) await syncRuntimeClock($)
    }
  } catch (err: any) {
    await ended(`the live reader could not run: ${errMessage(err)}`)
  }
}

// What the session's usage reading came to: its windows, or why they could not be read (DX-4339: the tick reads them itself).
type UsageReading = { limits: readonly SessionRateLimit[] } | { error: string }

// DX-4336 (PLAN-29 R-1, CAV-4, CAV-6): send this session's rate-limit windows to danxbot. Only a plan-connected session reports (a session
// with no plan connection is neither paced nor resumed, and danxbot refuses its report). The whole agent tree's burn is in the session's
// own figure (R-9), so there is one report per session and none per sub-agent. The report says when the figure was MEASURED (the last
// API response, `measuredAt`): a session that is only ticking re-sends a frozen figure, and danxbot must tell it from one that is working.
// A failed reading, a failed report or a failure of the plugin's own state is a toast, never a hook that threw and was skipped silently: toasted
// once per distinct text (`usageError`), cleared when a report is accepted again or there is nothing to report.
async function reportUsage($: any, reading: UsageReading): Promise<void> {
  try {
    if ((await read($, view)).connected === null) return
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

// DX-4339: the panel draws the session's own windows whether or not the session is connected to a plan, so they are kept here, apart from
// the report (which only a connected session makes). An unreadable usage clears them: a frozen figure must not stand as current.
async function noteLimits($: any, limits: readonly SessionRateLimit[]): Promise<void> {
  await update($, panel, cur => ({ ...cur, limits: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })) }))
}

// The clock tick's (and the first) report: what `$.session.usage()` says now, never an earlier event's figure. A reading that fails clears the
// panel's windows (a frozen figure must not stand as current) and, for a connected session, is toasted by the report.
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

// DX-4339: the team's pacing settings (GET /api/team/pacing) and the account verdict (the DX-4340 cache) into the panel's state. The settings
// read's outcome is kept (`settingsRead`) so the pane tells a quiet start or a session with no danxbot from a real error; a failed read keeps
// the last settings and toasts nothing (DX-4340's decision). The verdict is re-read every poll (danxbot itself changes it every 10 minutes, so
// a change shows within a poll or two). Run at session start and on the poll; a throw here is toasted, never an unhandled rejection.
async function refreshPacingPanel($: any): Promise<void> {
  try {
    const env = pacingEnv($)
    const fetched = await readTeamSettings(env.call)
    await refreshPacing(env, true)
    const now = await $.clock.now()
    const pacing = peekPacing(now)
    const verdict = pacing?.verdict ?? null
    const spend = pacing?.spend ?? null
    await update($, panel, cur =>
      'settings' in fetched
        ? { ...cur, settings: fetched.settings, settingsAt: now, settingsRead: { state: 'ok' }, verdict, spend }
        : { ...cur, settingsRead: fetched.read, verdict: null, spend: null },
    )
  } catch (err: any) {
    $.ui.toast(`Usage pacing panel could not refresh: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
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

// Which plan the relay should serve, from the view the last refresh read: null when none (not connected, signed out, no server).
// A view that failed to load (`error`, `loading`) changes nothing: a read blip must not stop a working relay.
async function syncRelay($: any): Promise<void> {
  const v = await read($, view)
  if (v.phase === 'error' || v.phase === 'loading') return
  const planId = v.phase === 'ready' ? (v.connected?.id ?? null) : null
  if (planId === null) {
    relayHalted = null
    stopRelay()
    return
  }
  if (relayRun !== null && relayRun.planId === planId) return
  // a halt belongs to the plan it happened on: any other plan starts a relay of its own
  if (relayHalted !== null && relayHalted !== planId) relayHalted = null
  if (relayHalted === planId) return
  stopRelay()
  const run: RelayRun = { planId, dead: false, told: null }
  relayRun = run
  void settleDetached(relayLoop($, run))
}

// Ends the loop: its pending call is left to the server (a newer wait supersedes it, or it times out), and everything it answers late is
// ignored (relay state, cursor and delivery are each gated on `dead`). It leaves the relay state as it was: the pane draws that state
// only for the plan it belongs to, and the next run of that plan writes its own first.
function stopRelay(): void {
  if (relayRun === null) return
  relayRun.dead = true
  relayRun = null
}

// DX-4233: THE gate for what an ended run (a move to another plan, the process's end) may say: its relay state, the halt that follows from
// it and the line told to the model all come after this write, which does not happen for a dead run (false). The new run owns the state.
async function setRelay($: any, run: RelayRun, phase: RelayState['phase'], detail: string | null): Promise<boolean> {
  if (run.dead) return false
  await update($, relay, cur => (cur.phase === phase && cur.detail === detail && cur.planId === run.planId ? cur : { phase, planId: run.planId, detail }))
  return true
}

// One failure, shown in the pane's event line and told to the session ONCE (the same text is not told again until a wait succeeds).
// `stopped` also halts the relay for this plan until something asks for it again (syncRelay).
async function relayFailed($: any, run: RelayRun, phase: 'retrying' | 'stopped', detail: string, line: string): Promise<void> {
  if (!(await setRelay($, run, phase, detail))) return
  if (phase === 'stopped') relayHalted = run.planId
  if (run.told === line) return
  run.told = line
  await tellModel($, line)
}

async function loadCursor($: any, planId: number): Promise<string | null> {
  return cursorFor(await $.store.get(cursorKey(await $.session.id())), planId)
}

// The cursor is stored AFTER the event was delivered, under the session id as it is now (a /clear or a resume changes it).
// DX-4233: a run that was ended while it delivered (a move to another plan) must not write over the new run's cursor.
async function saveCursor($: any, run: RelayRun, cursor: string): Promise<void> {
  if (run.dead) return
  await $.store.set(cursorKey(await $.session.id()), { planId: run.planId, cursor, at: await $.clock.now() })
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
async function submitEvent($: any, row: string): Promise<string | null> {
  try {
    const r = await $.prompt.submit({ text: row })
    return typeof r?.drop === 'string' ? notTakenLine(r.drop) : null
  } catch (err: any) {
    return notTakenLine(errMessage(err))
  }
}

// A row the model reads in the turn that is running. A refused or throwing append is a failure like any other (no silent fallback to
// a prompt): the event is not delivered, the cursor does not move, and the loop's backoff asks for it again.
async function appendRow($: any, row: string): Promise<string | null> {
  try {
    const r = await $.session.append(modelRow(row))
    return typeof r?.deny === 'string' ? notTakenLine(r.deny) : null
  } catch (err: any) {
    return notTakenLine(errMessage(err))
  }
}

// The wake prompt for rows the session will not read on its own (relay/delivery.ts): detached from the hook or delivery that found them,
// its failure told in a toast.
async function wakeSession($: any, wake: string): Promise<void> {
  const failure = await submitEvent($, wake)
  if (failure !== null) $.ui.toast(`Plan events not told to the session: ${failure}`.slice(0, TOAST_ERROR_MAX))
}

// One event into the session, the same `[danxbot plan event] ...` text as ever, by the one decision in relay/delivery.ts. A row appended
// is remembered until the turn's next model request (`turn.step`) has carried it: one still unseen when the turn ends is told again
// (onTurnComplete), and one appended after the turn already ended is told at once (rowAppended). Null when delivered, else the cause.
async function deliverEvent($: any, text: string): Promise<string | null> {
  const row = eventRow(text)
  if (deliveryMode(await read($, turn)) === 'prompt') return submitEvent($, row)
  const failure = await appendRow($, row)
  if (failure !== null) return failure
  // `wake` is set inside the updater, which sees the turn as it is when the write happens
  let wake = null as string | null
  await update($, turn, cur => {
    const appended = rowAppended(cur, text)
    wake = appended.wake
    return appended.turn
  })
  if (wake !== null) void settleDetached(wakeSession($, wake))
  return null
}

// The records of one answer, in the order the server sent them, each one's cursor stored as the resume cursor once it is delivered (never
// compared with another: the server decides what comes after a cursor). Stops at the first that cannot be delivered; the server answers
// everything after the last stored cursor on the next call. A crash between a delivery and its store may repeat that one record, never
// lose one.
async function deliverAll($: any, run: RelayRun, events: RelayEvent[], from: string | null): Promise<{ cursor: string | null; delivered: number; failure: string | null }> {
  let cursor = from
  let delivered = 0
  for (const ev of events) {
    // DX-4233: an ended run delivers nothing more (its events are the new plan's server's to answer)
    if (run.dead) break
    const failure = await deliverEvent($, ev.text)
    if (failure !== null) return { cursor, delivered, failure }
    delivered++
    cursor = ev.cursor
    await saveCursor($, run, cursor)
  }
  return { cursor, delivered, failure: null }
}

async function waitForEvents($: any, planId: number, cursor: string | null): Promise<WaitAnswer> {
  const path = await read($, transcript)
  try {
    return readWaitAnswer(await $.mcp.call(SERVER, RELAY_TOOL, waitArgs(planId, cursor, path)))
  } catch (err: any) {
    return classifyCallError(errMessage(err))
  }
}

// What one answer to a wait asks of the loop: `again` (the next wait, at once), `retry` (the next wait after the backoff: the answer or its
// delivery failed) or `end` (signed out, or the server said it cannot go on). `cursor` is the loop's, moved by the events delivered.
type Handled = { next: 'again' | 'retry' | 'end'; cursor: string | null }

async function handleAnswer($: any, run: RelayRun, got: WaitAnswer, cursor: string | null, startedAt: number): Promise<Handled> {
  if (got.kind === 'events') {
    const out = await deliverAll($, run, got.events, cursor)
    // the refresh is detached (DX-4586): the environment going away under it is not a failure
    if (out.delivered > 0) void settleDetached(refresh($, true))
    if (out.failure !== null) {
      await relayFailed($, run, 'retrying', out.failure, delayedLine(out.failure))
      return { next: 'retry', cursor: out.cursor }
    }
    run.told = null
    await setRelay($, run, 'streaming', null)
    // a server that answers an empty list at once is not a wait: sleep the rest of the round
    const took = (await $.clock.now()) - startedAt
    if (out.delivered === 0 && took < MIN_ROUND_MS) await $.clock.sleep(MIN_ROUND_MS - took)
    return { next: 'again', cursor: out.cursor }
  }
  if (got.kind === 'signed-out') {
    // the band and the pane already say it (and offer Sign in unless a person revoked the key): nothing more is told
    if (await setRelay($, run, 'off', null)) relayHalted = run.planId
    return { next: 'end', cursor }
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
    await pruneCursors($)
    let cursor = await loadCursor($, run.planId)
    let keyedBy = await $.session.id()
    await setRelay($, run, 'streaming', null)
    // DX-4233: the loop ends with its run; what a late answer would say is gated in setRelay, saveCursor and deliverAll
    while (!run.dead) {
      const startedAt = await $.clock.now()
      const got = await waitForEvents($, run.planId, cursor)
      // a /clear or a resume gives the process another session id: keep the cursor under the one in use now
      const sid = await $.session.id()
      if (sid !== keyedBy) {
        keyedBy = sid
        if (cursor !== null) await saveCursor($, run, cursor)
      }
      const handled = await handleAnswer($, run, got, cursor, startedAt)
      cursor = handled.cursor
      if (handled.next === 'end') return
      if (handled.next === 'again') {
        failures = 0
        continue
      }
      failures++
      await $.clock.sleep(backoffMs(failures))
    }
  } catch (err: any) {
    // An error nothing above anticipated halts the relay for this plan, shown in the pane and told once, never restarted by a refresh
    // behind the person's back (an ended run says nothing: relayFailed's gate). When the environment itself is gone the writes below
    // reject, and settleDetached (the loop's caller) is what drops that one rejection.
    const detail = `the relay hit an error: ${errMessage(err)}`
    await relayFailed($, run, 'stopped', RELAY_ERROR_FIX, stoppedLine(detail, RELAY_ERROR_FIX))
  } finally {
    if (relayRun === run) relayRun = null
  }
}

async function onSessionStart($: any, e: any, next: any) {
  await unpinStatus($)
  await $.command.register({ name: COMMAND, description: 'Show the danxbot plan pane (connection + open problems)' })
  // a new process or a reload cannot have a write in flight: no key claimed before it is still held
  await update($, busy, () => [])
  // DX-4233: no plan polling timer (the relay's events, the turns and the sub-agents refresh the view). DX-4339: the pacing panel has no
  // event to ride, so only it is read on the poll
  pacingTicker?.cancel()
  pacingTicker = $.clock.every(PACING_POLL_MS, () => refreshPacingPanel($))
  startUsageTicker($, USAGE_TICK_MS)
  // DX-4530: a reload starts with no fast poll; requests still open in $.state need it again
  permissionTicker?.cancel()
  permissionTicker = null
  await syncPermissionPoll($)
  // DX-4340: a new session starts with no pacing state (never the previous session's last good answer), reads the verdict now, and later reads happen when it is a minute old, at a spawn or sub-agent start
  resetPacing()
  void settleDetached(refreshPacingPanel($))
  void settleDetached(refresh($, true).then(() => reportUsageNow($)).then(() => retryWhileNotConnected($)))
  return next(e)
}

// Reasons after which the process is gone. `clear` and `resume` end THIS session but the process
// goes on, and no session.start follows a /clear: the timers and the relay must keep running then, or
// the band shows stale data and no event arrives for the rest of the process. Any reason not listed keeps them
// too: stopping a timer in a live process is the harm, a timer left in a dying one is not.
const PROCESS_ENDS = ['prompt_input_exit', 'logout', 'other']

async function onSessionEnd($: any, e: any, next: any) {
  // DX-4548: the sign-in watch belongs to the conversation that started it
  if (PROCESS_ENDS.includes(e.reason) || e.reason === 'clear' || e.reason === 'resume') {
    signInGeneration++
    signInWatching = null
    // DX-4548: free the sign-in key at once; the aborted watch's in-flight plan_connect (up to ~45s) must not hold it
    await update($, busy, cur => cur.filter(k => k !== busyKey.signIn))
  }
  if (PROCESS_ENDS.includes(e.reason)) {
    // DX-4233: the relay ends with the process; a /clear or a resume goes on (its loop is module code, and the refresh below
    // restarts it only if the new conversation is on another plan)
    stopRelay()
    pacingTicker?.cancel()
    pacingTicker = null
    usageTicker?.cancel()
    usageTicker = null
    runtimeClock?.cancel()
    runtimeClock = null
    permissionTicker?.cancel()
    permissionTicker = null
    settleTimer?.cancel()
    settleTimer = null
    stopLive()
  } else if (e.reason === 'clear' || e.reason === 'resume') {
    // DX-4508: another conversation: its sub-agents and transcript are not this one's
    stopLive()
    await update($, liveAgents, () => [])
    await update($, live, () => NO_LIVE)
    await update($, transcript, () => null)
    // a fresh conversation (or another session taking this one's place) in the same process: what
    // the person had open or half-typed no longer applies, and what the dashboard shows may have
    // moved while they were in the old one
    await update($, expanded, () => null)
    await update($, draft, () => null)
    await update($, talk, () => null)
    void settleDetached(refresh($, true))
  }
  return next(e)
}

async function onCommand($: any) {
  await showPlan($)
  void settleDetached(refresh($, true))
  return { text: 'Plan pane opened.' }
}

// The model connected (or moved) this session: show it at once. A signed-out session's `approval_required`
// answer opens the approval page and leaves the code up to compare; the plan page is not opened (there is no
// connection to show yet).
async function onPlanConnect($: any, e: any, next: any) {
  const ran = await next(e)
  // DX-4233: the model's plan_connect starts the relay (or restarts it on a move to another plan), once the view knows the plan
  relayHalted = null
  void settleDetached(refresh($, true).then(() => reportUsageNow($)))
  const approval = approvalRequestOf(ran.text, ['approval_required', 'approval_pending'])
  if (approval === null) return ran
  // DX-4548: a request is shown by its URL (showApproval opens each URL once), never by the answer's state: a request renewed
  // after an expiry answers `approval_pending` to the model's next call and must still reach the person
  await showApproval($, approval)
  // the model started this sign-in, so the plugin waits on it and tells the model how it ended; a request with no id cannot be
  // told once, so it is refused here as permissionRequestOf refuses one
  if (signInWatching === null) {
    if (publicIdOf(approval.url) === undefined) {
      $.ui.toast(signInFailedToast('the approval request had no id'))
      return ran
    }
    const args = { ...(typeof e.plan_id === 'number' ? { plan_id: e.plan_id } : {}), ...(typeof e.title === 'string' && e.title !== '' ? { title: e.title } : {}) }
    void watchSignIn($, { args, byPress: false, known: approval }).catch(err => $.ui.toast(signInFailedToast(String(err?.message ?? err))))
  }
  return ran
}

// DX-4435: the model asked for a permission: open the approval page once with its code and the permissions asked for (the
// sign-in's open, showApproval), and keep the request for the band until it is decided.
async function onRequestPermission($: any, e: any, next: any) {
  const ran = await next(e)
  const request = permissionRequestOf(ran.text, e.permissions)
  if (request === null) return ran
  await update($, permissionRequests, cur => [...cur.filter(r => r.publicId !== request.publicId), request])
  await syncPermissionPoll($)
  await showApproval($, asApproval(request))
  return ran
}

// DX-4499: a sub-agent started or stopped: read the dashboard now (not forced: a load within MIN_GAP_MS of the last stands), and once
// more SUBAGENT_SETTLE_MS later. The plugin's own SubagentStart / SubagentStop command hooks report the change to the dashboard
// at the same moment this hook runs, so the first read can precede the report; the second is after it. One wait pending at a time,
// so a burst of sub-agents costs one extra read.
// A `$.clock.after` timer, not a `$.clock.sleep` inside the hook: the wait outlives the event's dispatch (plugin-authoring,
// "Work that outlives a dispatch"), and a reload cancels it with the environment.
let settleTimer: { cancel: () => void } | null = null
function settleSubagents($: any): void {
  if (settleTimer !== null) return
  settleTimer = $.clock.after(SUBAGENT_SETTLE_MS, () => {
    settleTimer = null
    void settleDetached(refresh($, true))
  })
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
  if (!isStart) await markMeasured($)
  void settleDetached(refresh($))
  // only a session connected to a plan has a Sub-agents section to settle
  if ((await read($, view)).connected !== null) settleSubagents($)
  // DX-4508: start the live child for a new sub-agent, or stop it with the last one
  await syncLive($, isStart)
  return r
}

// DX-4340: the new sub-agent also gets danxbot's pacing line (additionalContext), when danxbot has one for this session
async function onSubagentStart($: any, e: any, next: any) {
  const r = await onSubagentChange($, e, next, true)
  return withLine(r, await pacingLine(pacingEnv($)))
}

function onSubagentStop($: any, e: any, next: any) {
  return onSubagentChange($, e, next, false)
}

// DX-4233: the main loop's turn ended (a sub-agent's `turn.complete` carries its agentId and is not this). What it did not read is told
// again in one prompt (relay/delivery.ts says why the rows appended since its last model request are exactly those).
async function onTurnComplete($: any, e: any, next: any) {
  const r = await next(e)
  if (e.agentId === undefined) {
    // `wake` is set inside the updater, which sees the turn as it is when the write happens
    let wake = null as string | null
    await update($, turn, cur => {
      const ended = turnEnded(cur, e.isAborted === true)
      wake = ended.wake
      return ended.turn
    })
    // detached: the turn.complete hook does not wait on the session taking a prompt
    if (wake !== null) void settleDetached(wakeSession($, wake))
  }
  void settleDetached(refresh($))
  return r
}

// DX-4233: the main loop's turn began (turn.start never fires for a sub-agent).
async function onTurnStart($: any, e: any, next: any) {
  await update($, turn, () => turnStarted())
  return next(e)
}

// DX-4233: the main loop is about to send a model request, which carries every row appended so far. `turn.step` streams, so its hook is
// a generator that forwards the stream untouched.
async function* onTurnStep($: any, e: any, next: any) {
  // no state write per request when there is nothing to forget
  if (e.agentId === undefined && (await read($, turn)).unseen.length > 0) await update($, turn, cur => requestSent(cur))
  return yield* next(e)
}

// The app's session title, handed to `plan_connect` from the pane's Connect; and (DX-4508) the main transcript's path.
async function onTitle($: any, e: any, next: any) {
  await noteTranscript($, e)
  const t = typeof e.session_title === 'string' ? e.session_title.trim() : ''
  if (t) await update($, title, () => t)
  return next(e)
}

async function drawBand($: any, e: any, next: any) {
  if (e.props.hasSurvey) return next(e)
  // a dismissed band draws nothing, whatever the connection (the footer button brings it back)
  if (await read($, dismissed)) return next(e)
  const v = await read($, view)
  return renderBand(
    $.ui.resolve(e),
    handlers($),
    v,
    e.surface === 'desktop',
    e.surface === 'desktop',
    await read($, busy),
    (await read($, permissionRequests)).length,
    e.props.bodyColumns,
    buildPanel(await read($, panel)),
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

async function drawPane($: any, e: any) {
  // DX-4499: read for the subscription alone: the tick redraws the pane, and `now` below is what a runtime counts against
  await read($, tick)
  const m = {
    v: await read($, view),
    picked: await read($, pick),
    open: await read($, expanded),
    working: await read($, busy),
    isSwitching: await read($, switching),
    draft: await read($, draft),
    talk: await read($, talk),
    now: await $.clock.now(),
    hasBrowser: e.surface === 'desktop',
    hasSvg: e.surface === 'desktop',
    live: await read($, live),
    pacing: buildPanel(await read($, panel)),
    relay: await read($, relay),
  }
  return renderPane($.ui.resolve(e), handlers($), m)
}

// DX-4340: the engine calls the pacing guard makes, as closures (the engine follows `$` only into a function in this file).
function pacingEnv($: any) {
  return {
    now: () => $.clock.now(),
    call: (method: string, path: string) => api($, method, path),
    toast: (text: string) => $.ui.toast(text),
  }
}

export const register: Register = on => {
  on('session.start', onSessionStart)
  on('session.end', onSessionEnd)
  on('command.run', { command: COMMAND }, onCommand)
  on('tool.call', { tool: toolName('plan_connect') }, onPlanConnect)
  on('tool.call', { tool: toolName('request_permission') }, onRequestPermission)
  on('turn.start', onTurnStart)
  on('turn.step', onTurnStep)
  on('turn.complete', onTurnComplete)
  on('session.measure', onMeasure)
  // DX-4340: usage pacing denies or downgrades a sub-agent spawn (never a tool call: saving work stays possible)
  on('agent.spawn', ($, e, next) => spawnGuard(pacingEnv($))(e, next))
  on('classic.SubagentStart', onSubagentStart)
  on('classic.SubagentStop', onSubagentStop)
  on('classic.SessionStart', onTitle)
  on('classic.UserPromptSubmit', onTitle)
  on('ui.render', { component: 'AbovePrompt' }, drawBand)
  on('ui.render', { component: 'SessionMode' }, drawSessionMode)
  on('ui.render', { component: 'Pane', requestId: PANE }, drawPane)
  on('ui.render', { component: 'AssistantMessage' }, drawAssistantMessage)
}
