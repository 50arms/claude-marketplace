import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Draft, PlanRow, ProblemRow, RefreshGate, SolutionRow, StepRow } from '../types'
import { renderBand } from './plan-link/band'
import type { Handlers } from './plan-link/handlers'
import { errText, loadPlan, statusText } from './plan-link/load'
import type { Api } from './plan-link/load'
import { answerNote, connectNote } from './plan-link/notes'
import { renderPane } from './plan-link/pane'
import { COMMAND, EMPTY, MIN_GAP_MS, PANE, POLL_MS, SERVER } from './plan-link/config'

// $.state atoms: the engine's scan reads an atom's plugin and key only from a const in the file that
// uses it (DX-4232), so they are declared here, not in ./plan-link/config.
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
// drawing, shaping and constants live in ./plan-link/* as pure code, and this file hands the
// drawings their handlers (handlers()).

function mcpText(r: any): string {
  return (r?.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('')
}

// One dashboard call through the session's own danx-dashboard MCP server: same credential, same
// x-danx-session-id header. A rejected call means the session has no such server (another repo):
// `unreachable`, which is not an API error.
async function api($: any, method: string, path: string, extra: { query?: object; body?: object } = {}): Promise<Api> {
  let res
  try {
    res = await $.mcp.call(SERVER, 'danxbot_api', { method, path, ...extra })
  } catch (err: any) {
    return { ok: false, status: 0, unreachable: true, body: { error: String(err?.message ?? err) } }
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
      return again ? { ...cur, again: false } : { ...cur, inFlight: false }
    })
  }
}

// The model did not make this call, so tell it (it reads this, the person does not). R-4.
async function tellModel($: any, text: string): Promise<void> {
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    if (r.deny) throw new Error(r.deny)
  } catch (err: any) {
    // the write the operator asked for already happened: say the model was not told, never hide it
    $.ui.toast(`Could not tell the model: ${String(err?.message ?? err).slice(0, 160)}`)
  }
}

async function browser($: any, tool: string, args: object): Promise<{ ok: boolean; text: string }> {
  const r = await $.mcp.call('Claude_Browser', tool, args)
  return { ok: !r.isError, text: mcpText(r) }
}

// Opens `url` in the ONE in-app browser tab this plugin owns (id kept in $.state), so the
// person's own tabs are never navigated away.
async function openInBrowser($: any, url: string): Promise<void> {
  let step = 'tabs_context'
  try {
    const ctx = await browser($, 'tabs_context', {})
    let tabs: { tabId: string }[] = []
    try {
      tabs = JSON.parse(ctx.text.slice(ctx.text.indexOf('{'), ctx.text.lastIndexOf('}') + 1)).tabs ?? []
    } catch {}
    let tabId = await read($, tab)
    if (!tabId || !tabs.some(t => t.tabId === tabId)) {
      step = 'tabs_create'
      const created = await browser($, 'tabs_create', { foreground: true })
      if (!created.ok) throw new Error(created.text)
      tabId = /tabId"?\s*[:=]\s*"?([\w-]+)/.exec(created.text)?.[1] ?? null
      if (!tabId) throw new Error(`no tabId in: ${created.text.slice(0, 80)}`)
      const made = tabId
      await update($, tab, () => made)
    }
    step = 'navigate'
    const nav = await browser($, 'navigate', { url, tabId })
    if (!nav.ok) throw new Error(nav.text)
    step = 'tabs_select'
    await browser($, 'tabs_select', { tabId })
  } catch (err: any) {
    $.ui.toast(`Browser ${step} was denied or failed: ${String(err?.message ?? err).slice(0, 160)}. Use the link instead.`)
  }
}

async function connect($: any, plan: PlanRow): Promise<void> {
  await update($, busy, () => `connect:${plan.id}`)
  try {
    const sessionTitle = await read($, title)
    const r = await $.mcp.call(SERVER, 'plan_connect', {
      plan_id: plan.id,
      ...(sessionTitle ? { title: sessionTitle } : {}),
    })
    if (r.isError) {
      $.ui.toast(`Connect failed: ${mcpText(r).slice(0, 200)}`)
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
// re-read the plan.
async function act($: any, p: ProblemRow, path: string, method: string, body: object, done: string): Promise<boolean> {
  await update($, busy, () => `problem:${p.id}`)
  try {
    const r = await api($, method, `/api/issues/${p.cardId}/${path}`, { body })
    if (!r.ok) {
      $.ui.toast(`${p.cardId} PBLM-${p.id}: ${errText(r)}`)
      return false
    }
    if (done) $.ui.toast(done)
    await update($, draft, () => null)
    await refresh($, true)
    return true
  } finally {
    await update($, busy, () => null)
  }
}

// Answers an open problem, then tells the model (it did not make the call).
async function answer($: any, p: ProblemRow, body: Record<string, unknown>, label: string): Promise<void> {
  const ok = await act($, p, `problems/${p.id}/answer`, 'POST', body, `Answered: ${label}`)
  if (ok) {
    await tellModel($, answerNote(p, label))
  }
}

// A note (or a rejection reason) is required: an empty one is refused here, with no API call.
async function answerWithNote($: any, p: ProblemRow, s: SolutionRow, text: string, rejected: boolean): Promise<void> {
  const note = text.trim()
  if (!note) {
    $.ui.toast(rejected ? 'A note is required to reject.' : 'A note is required.')
    return
  }
  if (rejected) {
    await answer($, p, { solution_id: s.id, outcome: 'rejected', note }, `REJECTED "${s.title}" (reason: ${note})`)
  } else {
    await answer($, p, { solution_id: s.id, note }, `${s.title} (note: ${note})`)
  }
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
    answer: (p, body, label) => answer($, p, body, label),
    answerWithNote: (p, s, text, rejected) => answerWithNote($, p, s, text, rejected),
    checkStep: (p: ProblemRow, s: SolutionRow, step: StepRow) =>
      act($, p, `problems/${p.id}/solutions/${s.id}/steps/${step.id}/check`, 'PATCH', { checked: !step.checked }, ''),
    comment: (p, text) => act($, p, 'comments', 'POST', { text, problem_id: p.id }, 'Comment posted'),
  }
}

// ---- hooks ----------------------------------------------------------------

async function onSessionStart($: any, e: any, next: any) {
  await $.command.register({ name: COMMAND, description: 'Show the danxbot plan pane (connection + open problems)' })
  void refresh($, true)
  $.clock.every(POLL_MS, () => refresh($))
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
  on('command.run', { command: COMMAND }, onCommand)
  on('tool.call', { tool: 'mcp__danx-dashboard__plan_connect' }, onPlanConnect)
  on('turn.complete', onTurnComplete)
  on('classic.SessionStart', onTitle)
  on('classic.UserPromptSubmit', onTitle)
  on('ui.render', { component: 'AbovePrompt' }, drawBand)
  on('ui.render', { component: 'Pane', requestId: PANE }, drawPane)
}
