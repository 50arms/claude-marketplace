import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Draft, PlanRow, ProblemRow, RefreshGate, SolutionRow, StepRow } from '../types'
import { renderBand } from './plan/band'
import type { Handlers } from './plan/handlers'
import { parseTabId, parseTabs } from './plan/browser-output'
import {
  CALL_ERROR_MAX,
  COMMAND,
  CONNECT_ERROR_MAX,
  EMPTY,
  MIN_GAP_MS,
  PANE,
  POLL_MS,
  SERVER,
  NOTE_MARKER,
  TOAST_ERROR_MAX,
  busyKey,
} from './plan/config'
import { errText, loadPlan } from './plan/load'
import type { Api } from './plan/load'
import { isServerMissing, mcpText } from './plan/mcp'
import { answerNote, connectNote } from './plan/notes'
import { renderPane } from './plan/pane'
import { statusText } from './plan/words'

// $.state atoms: the engine's scan reads an atom's plugin and key only from a const in the file that
// uses it (DX-4232), so they are declared here, not in ./plan/config.
const view = atom({ plugin: 'danxbot', key: 'view' } as const, EMPTY)
const gate = atom({ plugin: 'danxbot', key: 'gate' } as const, { inFlight: false, again: false, at: null } as RefreshGate)
const pick = atom({ plugin: 'danxbot', key: 'pick' } as const, '')
const switching = atom({ plugin: 'danxbot', key: 'switching' } as const, false)
const expanded = atom({ plugin: 'danxbot', key: 'expanded' } as const, null as number | null)
const busy = atom({ plugin: 'danxbot', key: 'busy' } as const, null as string | null)
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
  const text = mcpText(res)
  if (res.isError) return { ok: false, status: 0, body: { error: text } }
  try {
    return JSON.parse(text) as Api
  } catch {
    return { ok: false, status: 0, body: { error: text } }
  }
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
    if (cur.inFlight) {
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
        $.ui.status(statusText(v))
      } catch (err: any) {
        await update($, view, cur => ({ ...cur, phase: 'error', error: String(err?.message ?? err) }))
        $.ui.status('plan: error')
      }
      await update($, gate, cur => {
        again = cur.again
        return { ...cur, again: false }
      })
    }
  } finally {
    await update($, gate, cur => ({ ...cur, inFlight: false, again: false }))
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

async function browser($: any, tool: string, args: object): Promise<{ ok: boolean; text: string }> {
  const r = await $.mcp.call('Claude_Browser', tool, args)
  return { ok: !r.isError, text: mcpText(r) }
}

// Opens `url` in the ONE in-app browser tab this plugin owns (id kept in $.state), so the
// person's own tabs are never navigated away. Any step that fails or answers something unreadable
// throws into the toast: reading it as "no tabs" would open a new tab on every press.
async function openInBrowser($: any, url: string): Promise<void> {
  let step = 'tabs_context'
  try {
    const ctx = await browser($, 'tabs_context', {})
    if (!ctx.ok) throw new Error(ctx.text)
    const tabs = parseTabs(ctx.text)
    let tabId = await read($, tab)
    if (!tabId || !tabs.includes(tabId)) {
      step = 'tabs_create'
      const created = await browser($, 'tabs_create', { foreground: true })
      if (!created.ok) throw new Error(created.text)
      const made = parseTabId(created.text)
      await update($, tab, () => made)
      tabId = made
    }
    step = 'navigate'
    const nav = await browser($, 'navigate', { url, tabId })
    if (!nav.ok) throw new Error(nav.text)
    step = 'tabs_select'
    const selected = await browser($, 'tabs_select', { tabId })
    if (!selected.ok) throw new Error(selected.text)
  } catch (err: any) {
    $.ui.toast(`Browser ${step} was denied or failed: ${String(err?.message ?? err).slice(0, TOAST_ERROR_MAX)}. Use the link instead.`)
  }
}

async function connect($: any, plan: PlanRow): Promise<void> {
  await update($, busy, () => busyKey.connect(plan.id))
  try {
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
    if (r.isError) {
      $.ui.toast(`Connect failed: ${mcpText(r).slice(0, CONNECT_ERROR_MAX)}`)
      return
    }
    $.ui.toast(`Connected to ${plan.ref}`)
    await update($, switching, () => false)
    await tellModel($, connectNote(plan))
    await refresh($, true)
  } finally {
    await update($, busy, () => null)
  }
}

// One write to a problem (answer, comment, step tick): mark it busy, call, toast a refusal,
// re-read the plan. It touches nothing the operator is composing; an answer clears the draft.
async function act($: any, p: ProblemRow, path: string, method: string, body: object, done: string): Promise<boolean> {
  await update($, busy, () => busyKey.problem(p.id))
  try {
    const r = await api($, method, `/api/issues/${p.cardId}/${path}`, { body })
    if (!r.ok) {
      $.ui.toast(`${p.cardId} PBLM-${p.id}: ${errText(r)}`)
      return false
    }
    if (done) $.ui.toast(done)
    await refresh($, true)
    return true
  } finally {
    await update($, busy, () => null)
  }
}

// THE answer: the one place a body and its label meet. Answers the problem, clears the note or
// rejection draft (only an answer does), then tells the model (it did not make the call).
async function answer($: any, p: ProblemRow, body: Record<string, unknown>, label: string): Promise<void> {
  const ok = await act($, p, `problems/${p.id}/answer`, 'POST', body, `Answered: ${label}`)
  if (!ok) return
  await update($, draft, () => null)
  await tellModel($, answerNote(p, label))
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

function handlers($: any): Handlers {
  return {
    refresh: () => refresh($, true),
    openPane: () => $.ui.open({ id: PANE, title: 'Plan', focus: true }),
    openBrowserTab: url => openInBrowser($, url),
    connect: plan => connect($, plan),
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

async function onSessionStart($: any, e: any, next: any) {
  await $.command.register({ name: COMMAND, description: 'Show the danxbot plan pane (connection + open problems)' })
  // a fresh session starts with the refresh lock free, whatever a previous run left in $.state
  await update($, gate, () => ({ inFlight: false, again: false, at: null }))
  ticker?.cancel()
  ticker = $.clock.every(POLL_MS, () => refresh($))
  void refresh($, true)
  return next(e)
}

async function onSessionEnd($: any, e: any, next: any) {
  ticker?.cancel()
  ticker = null
  return next(e)
}

async function onCommand($: any) {
  await $.ui.open({ id: PANE, title: 'Plan' })
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
  return renderBand($.ui.resolve(e), handlers($), await read($, view), e.surface === 'desktop')
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
  on('ui.render', { component: 'Pane', requestId: PANE }, drawPane)
}
