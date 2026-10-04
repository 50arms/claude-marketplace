import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ConnectedPlan, Draft, PermissionRequest, PlanRow, ProblemRow, RefreshGate, SolutionRow, StepRow } from '../types'
import { approvalRequestOf, approvalSubject, approvalToast } from './plan/approval'
import type { ApprovalRequest, OpenFailure } from './plan/approval'
import { renderBand } from './plan/band'
import { asApproval, claimPath, claimStatus, livePermissionRequests, permissionRequestOf } from './plan/permission'
import { linkCardIds } from './plan/card-links'
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
  LOCK_STALE_MS,
  MIN_GAP_MS,
  NO_MCP_RETRY_MS,
  PANE,
  PLAN_TITLE,
  POLL_MS,
  SIGNED_IN_TOAST,
  keyRevokedLabel,
  SIGN_IN_ROUNDS,
  SUBAGENT_SETTLE_MS,
  TICK_MS,
  SIGN_IN_TIMEOUT_TOAST,
  signInFailedToast,
  SERVER,
  NOTE_MARKER,
  TOAST_ERROR_MAX,
  busyKey,
} from './plan/config'
import { errText, loadPlan } from './plan/load'
import type { Api } from './plan/load'
import { isServerMissing, isSignedOut, mcpText, outcomeRevokedBy, refusalText, toolOutcome } from './plan/mcp'
import type { ToolOutcome } from './plan/mcp'
import { answerNote, connectNote, disconnectNote } from './plan/notes'
import { renderPane } from './plan/pane'
import { signInStep } from './plan/sign-in'
import { visibleSubagents } from './plan/subagents'

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

// DX-4232: the engine follows `$` only into a function declared in the SAME file (`claude plugin
// validate` refuses it across an import), and refuses a closure that receives `$` declared
// inside `register`. So every function that takes `$` is a top-level declaration here; the
// drawing, shaping and constants live in ./plan/* as pure code, and this file hands the
// drawings their handlers (handlers()).

// The refresh timer: one per session. A module variable is right for a handle (it cannot live in
// $.state, which holds JSON); a reload cancels the old environment's waits and runs session.start
// again, which starts a new one.
let ticker: { cancel: () => void } | null = null
// DX-4499: the runtime clock's timer, one per session like the refresh timer.
let runtimeClock: { cancel: () => void } | null = null

// One dashboard call through the session's own danx-dashboard MCP server: same credential, same
// x-danx-session-id header. Only the engine's "no such server" rejection (another repo) is
// `unreachable`, which is not an API error; any other rejection is an error shown as one.
async function api($: any, method: string, path: string, extra: { query?: object; body?: object } = {}): Promise<Api> {
  let res
  try {
    res = await $.mcp.call(SERVER, 'danxbot_api', { method, path, ...extra })
  } catch (err: any) {
    const message = String(err?.message ?? err)
    if (isServerMissing(message)) return { ok: false, status: 0, unreachable: true, body: { error: message } }
    return { ok: false, status: 0, body: { error: message.slice(0, CALL_ERROR_MAX) } }
  }
  return toolOutcome(res)
}

async function loadView($: any) {
  const refreshedAt = new Date(await $.clock.now()).toISOString()
  return loadPlan((method, path, extra) => api($, method, path, extra), refreshedAt, await read($, expanded))
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
        await syncRuntimeClock($)
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

// DX-4435: a request leaves the list when it expires, or its claim (the key's own route) says it was approved, denied or expired,
// or the session lost its key. A claim that fails for any other reason leaves it for the next refresh: its expiry ends it anyway.
async function settlePermissionRequests($: any): Promise<void> {
  const now = await $.clock.now()
  const open = livePermissionRequests(await read($, permissionRequests), now)
  const decided = new Set<string>()
  for (const r of open) {
    const out = await api($, 'POST', claimPath(r))
    // a 404 is a request the dashboard no longer knows
    if (out.status === 404 || isSignedOut(out) || outcomeRevokedBy(out) !== null || (out.ok && claimStatus(out.body) === 'over')) decided.add(r.publicId)
  }
  await update($, permissionRequests, cur => livePermissionRequests(cur, now).filter(r => !decided.has(r.publicId)))
}

// The model did not make this call, so tell it (it reads this, the person does not). R-4.
async function tellModel($: any, text: string): Promise<void> {
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
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
async function withBusy($: any, key: string, work: () => Promise<void>): Promise<void> {
  let won = false
  await update($, busy, cur => {
    won = !cur.includes(key)
    return won ? [...cur, key] : cur
  })
  if (!won) return
  try {
    await work()
  } finally {
    await update($, busy, cur => cur.filter(k => k !== key))
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

// DX-4423: the Sign in button. A session with no dashboard key asks for one through `plan_connect` (with its own title, and
// the plan it was on). The MCP answers with the approval request, which is shown as the model's own would be (showApproval):
// at once when this call makes the request, else after waiting on the one already pending. Each call waits there for the
// person's approval, so the calls repeat until one answers something final. A call that answers a DIFFERENT request than the
// one shown means the first expired while it waited: that is the end (a new request nobody asked for is left to lapse),
// never a second page. The whole sign-in holds the sign-in busy key (the buttons read "Signing in…", a second press does
// nothing).
async function signIn($: any): Promise<void> {
  await withBusy($, busyKey.signIn, async () => {
    const sessionTitle = await read($, title)
    const resume = (await read($, view)).resumePlan
    const args = { ...(resume !== null ? { plan_id: resume } : {}), ...(sessionTitle ? { title: sessionTitle } : {}) }
    let shown: string | null = null
    for (let round = 0; round < SIGN_IN_ROUNDS; round++) {
      let r
      try {
        r = await $.mcp.call(SERVER, 'plan_connect', args)
      } catch (err: any) {
        $.ui.toast(signInFailedToast(String(err?.message ?? err)))
        return
      }
      const step = signInStep(r)
      if (step.kind === 'waiting') {
        if (step.request !== null) {
          if (shown !== null && step.request.url !== shown) break
          // DX-4423: the press itself always tries the open; later rounds of the same wait only repeat the request
          const firstOfPress = shown === null
          await showApproval($, step.request, firstOfPress)
          shown = step.request.url
        }
        continue
      }
      if (step.kind === 'revoked') {
        $.ui.toast(`${keyRevokedLabel(step.by)}. This session must stop.`)
        await refresh($, true)
        return
      }
      $.ui.toast(step.kind === 'done' ? SIGNED_IN_TOAST : step.message)
      // signed in (even if the plan was refused): the view reads the truth; a stop leaves the signed-out view as it is
      if (step.kind !== 'stop') await refresh($, true)
      return
    }
    $.ui.toast(SIGN_IN_TIMEOUT_TOAST)
  })
}

// The button's press returns at once: the sign-in waits minutes for a person, and a press must not.
function startSignIn($: any): Promise<void> {
  signIn($).catch(err => $.ui.toast(signInFailedToast(String(err?.message ?? err))))
  return Promise.resolve()
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
  const open = livePermissionRequests(await read($, permissionRequests), await $.clock.now())
  const newest = open.at(-1)
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

// The first load can run before the MCP server connects. A no-mcp view at session start is retried
// after each wait in NO_MCP_RETRY_MS (on the clock, so a test moves it) and then left as no-mcp.
async function retryWhileNoMcp($: any): Promise<void> {
  for (const wait of NO_MCP_RETRY_MS) {
    try {
      await $.clock.sleep(wait)
    } catch {
      // the wait rejects when the plugin's environment is unloaded (a reload): the retries end with it
      return
    }
    if ((await read($, view)).phase !== 'no-mcp') return
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
  const shown = visibleSubagents((await read($, view)).subagents.rows, await $.clock.now()).length > 0
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

async function onSessionStart($: any, e: any, next: any) {
  await unpinStatus($)
  await $.command.register({ name: COMMAND, description: 'Show the danxbot plan pane (connection + open problems)' })
  // a new process or a reload cannot have a write in flight: no key claimed before it is still held
  await update($, busy, () => [])
  ticker?.cancel()
  ticker = $.clock.every(POLL_MS, () => refresh($))
  void refresh($, true).then(() => retryWhileNoMcp($))
  return next(e)
}

// Reasons after which the process is gone. `clear` and `resume` end THIS session but the process
// goes on, and no session.start follows a /clear: the refresh timer must keep running then, or
// the band shows stale data for the rest of the process. Any reason not listed keeps the timer
// too: stopping a timer in a live process is the harm, a timer left in a dying one is not.
const PROCESS_ENDS = ['prompt_input_exit', 'logout', 'other']

async function onSessionEnd($: any, e: any, next: any) {
  if (PROCESS_ENDS.includes(e.reason)) {
    ticker?.cancel()
    ticker = null
    runtimeClock?.cancel()
    runtimeClock = null
    settleTimer?.cancel()
    settleTimer = null
  } else if (e.reason === 'clear' || e.reason === 'resume') {
    // a fresh conversation (or another session taking this one's place) in the same process: what
    // the person had open or half-typed no longer applies, and what the dashboard shows may have
    // moved while they were in the old one
    await update($, expanded, () => null)
    await update($, draft, () => null)
    await update($, talk, () => null)
    void refresh($, true)
  }
  return next(e)
}

async function onCommand($: any) {
  await showPlan($)
  void refresh($, true)
  return { text: 'Plan pane opened.' }
}

// The model connected (or moved) this session: show it at once. A signed-out session's `approval_required`
// answer opens the approval page and leaves the code up to compare; the plan page is not opened (there is no
// connection to show yet).
async function onPlanConnect($: any, e: any, next: any) {
  const ran = await next(e)
  void refresh($, true)
  const approval = approvalRequestOf(ran.text)
  if (approval !== null) await showApproval($, approval)
  return ran
}

// DX-4435: the model asked for a permission: open the approval page once with its code and the permissions asked for (the
// sign-in's open, showApproval), and keep the request for the band until it is decided.
async function onRequestPermission($: any, e: any, next: any) {
  const ran = await next(e)
  const request = permissionRequestOf(ran.text, e.permissions)
  if (request === null) return ran
  await update($, permissionRequests, cur => [...cur.filter(r => r.publicId !== request.publicId), request])
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
    void refresh($, true)
  })
}

async function onSubagentChange($: any, e: any, next: any) {
  const r = await next(e)
  void refresh($)
  // only a session connected to a plan has a Sub-agents section to settle
  if ((await read($, view)).connected !== null) settleSubagents($)
  return r
}

async function onTurnComplete($: any, e: any, next: any) {
  const r = await next(e)
  void refresh($)
  return r
}

// The app's session title, handed to `plan_connect` from the pane's Connect.
async function onTitle($: any, e: any, next: any) {
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
    livePermissionRequests(await read($, permissionRequests), await $.clock.now()).length,
    e.props.bodyColumns,
  )
}

// The footer: the engine's own mode labels (next) stay, with ONE plan button beside them. Nothing
// to say (loading, no MCP server) leaves the site untouched.
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
  }
  return renderPane($.ui.resolve(e), handlers($), m)
}

export const register: Register = on => {
  on('session.start', onSessionStart)
  on('session.end', onSessionEnd)
  on('command.run', { command: COMMAND }, onCommand)
  on('tool.call', { tool: 'mcp__danx-dashboard__plan_connect' }, onPlanConnect)
  on('tool.call', { tool: 'mcp__danx-dashboard__request_permission' }, onRequestPermission)
  on('turn.complete', onTurnComplete)
  on('classic.SubagentStart', onSubagentChange)
  on('classic.SubagentStop', onSubagentChange)
  on('classic.SessionStart', onTitle)
  on('classic.UserPromptSubmit', onTitle)
  on('ui.render', { component: 'AbovePrompt' }, drawBand)
  on('ui.render', { component: 'SessionMode' }, drawSessionMode)
  on('ui.render', { component: 'Pane', requestId: PANE }, drawPane)
  on('ui.render', { component: 'AssistantMessage' }, drawAssistantMessage)
}
