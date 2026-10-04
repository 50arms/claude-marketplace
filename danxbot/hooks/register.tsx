import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ConnectedPlan, Draft, PlanRow, ProblemRow, RefreshGate, SolutionRow, StepRow } from '../types'
import { renderBand } from './plan/band'
import { renderFooter } from './plan/footer'
import type { Handlers } from './plan/handlers'
import { footerLabel } from './plan/words'
import { parsePreviewStart, parseTabId, parseTabsContext } from './plan/browser-output'
import {
  BROWSER_TOAST_MS,
  CALL_ERROR_MAX,
  COMMAND,
  CONNECT_ERROR_MAX,
  EMPTY,
  LOCK_STALE_MS,
  MIN_GAP_MS,
  NO_MCP_RETRY_MS,
  PANE,
  POLL_MS,
  SERVER,
  NOTE_MARKER,
  TOAST_ERROR_MAX,
  busyKey,
} from './plan/config'
import { errText, loadPlan } from './plan/load'
import type { Api } from './plan/load'
import { isServerMissing, mcpText, refusalText, toolOutcome } from './plan/mcp'
import { answerNote, connectNote, disconnectNote } from './plan/notes'
import { renderPane } from './plan/pane'

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

// DX-4232: the engine follows `$` only into a function declared in the SAME file (`claude plugin
// validate` refuses it across an import), and refuses a closure that receives `$` declared
// inside `register`. So every function that takes `$` is a top-level declaration here; the
// drawing, shaping and constants live in ./plan/* as pure code, and this file hands the
// drawings their handlers (handlers()).

// The refresh timer: one per session. A module variable is right for a handle (it cannot live in
// $.state, which holds JSON); a reload cancels the old environment's waits and runs session.start
// again, which starts a new one.
let ticker: { cancel: () => void } | null = null

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
  return loadPlan((method, path, extra) => api($, method, path, extra), refreshedAt)
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
        await update($, view, () => v)
      } catch (err: any) {
        await update($, view, cur => ({ ...cur, phase: 'error', error: String(err?.message ?? err) }))
      }
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

// Opens `url` in the ONE in-app browser tab this plugin owns (id kept in $.state), so the
// person's own tabs are never navigated away. Three cases:
//   pane closed          preview_start {url}: the one call that opens the pane (a navigate with no
//                        tabId is refused). It names the tab, which we keep (navOk must be true).
//                        A rejected call is a toast with the rejection text, never a navigate;
//   pane open, tab ours  navigate {url, tabId}, tabs_select;
//   pane open, no tab    tabs_create, navigate {url, tabId}, keep its id, tabs_select.
// Any step that fails or answers something unreadable throws into the toast: reading it as "no
// tabs" would open a new tab on every press. The whole open holds the browser busy key, so the
// buttons read "Opening…" and a second press while it runs does nothing.
function openInBrowser($: any, url: string): Promise<void> {
  return withBusy($, busyKey.browser, async () => {
    let step = 'tabs_context'
    $.ui.toast('Opening the plan in the browser…', { timeoutMs: BROWSER_TOAST_MS })
    try {
      const ctx = parseTabsContext(await browserOk($, 'tabs_context', {}))
      if (!ctx.browserOpen) {
        step = 'preview_start'
        const made = parsePreviewStart(await browserOk($, 'preview_start', { url }))
        await update($, tab, () => made)
      } else {
        let tabId = await read($, tab)
        if (!tabId || !ctx.tabs.some(t => t.id === tabId)) {
          step = 'tabs_create'
          const made = parseTabId(await browserOk($, 'tabs_create', { foreground: true }))
          await update($, tab, () => made)
          tabId = made
        }
        step = 'navigate'
        await browserOk($, 'navigate', { url, tabId })
        step = 'tabs_select'
        await browserOk($, 'tabs_select', { tabId })
      }
      $.ui.toast('Plan opened in the browser tab', { timeoutMs: BROWSER_TOAST_MS })
    } catch (err: any) {
      // the advice first, the (cut) detail last: a cut sentence must not end the toast
      $.ui.toast(`Browser ${step} failed: use the link instead. (${String(err?.message ?? err).slice(0, TOAST_ERROR_MAX)})`)
    }
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

// The one open of the Plan pane (the band's Plan button and showPlan): focused, so it takes the keyboard.
function openPlanPane($: any): Promise<unknown> {
  return $.ui.open({ id: PANE, title: 'Plan', focus: true })
}

// The band's close control: the band hides until the footer button or /danx-plan is used.
async function dismissBand($: any): Promise<void> {
  await update($, dismissed, () => true)
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
    toggleSwitch: () => update($, switching, cur => !cur),
    cancelSwitch: () => update($, switching, () => false),
    pickPlan: value => update($, pick, () => value),
    toggleExpanded: id => update($, expanded, cur => (cur === id ? null : id)),
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

async function onSessionStart($: any, e: any, next: any) {
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

// The model connected (or moved) this session: show it at once.
async function onPlanConnect($: any, e: any, next: any) {
  const ran = await next(e)
  void refresh($, true)
  return ran
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
  )
}

// The footer: the engine's own mode labels (next) stay, with ONE plan button beside them. Nothing
// to say (loading, no MCP server) leaves the site untouched.
async function drawSessionMode($: any, e: any, next: any) {
  const label = footerLabel(await read($, view))
  if (label === null) return next(e)
  return renderFooter($.ui.resolve(e), handlers($), label, await next(e))
}

async function drawPane($: any, e: any) {
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
  on('turn.complete', onTurnComplete)
  on('classic.SessionStart', onTitle)
  on('classic.UserPromptSubmit', onTitle)
  on('ui.render', { component: 'AbovePrompt' }, drawBand)
  on('ui.render', { component: 'SessionMode' }, drawSessionMode)
  on('ui.render', { component: 'Pane', requestId: PANE }, drawPane)
}
