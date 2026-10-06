import type { PermissionRequest, PlanRow } from '../../types'

// The rows the operator's pane actions append for the model (R-4): the model did not make
// these calls, so it is told. The person never reads them.
export function connectNote(plan: PlanRow, naming: Naming): string {
  const base = `[danxbot plan] The operator connected this session to ${plan.ref} "${plan.name}" (plan_id ${plan.id}) from the Plan pane. Before doing plan work, call plan_connect with plan_id ${plan.id} yourself to read its briefing and start its events.`
  if (naming.status === 'ok') return base
  // DX-4612: the connect answered `naming: needed` to the pane, which the model never reads: hand it the server's own steps.
  const title = naming.suggestedTitle === null ? '' : ` Suggested thread title: "${naming.suggestedTitle}".`
  return `${base} This session's thread title does not match the plan, so rename it first. ${naming.instruction}${title}`
}

// DX-4612 / DX-4608: the `naming` block of a plan_connect answer (src/issues/plan-session-naming.ts SessionNaming). Only the
// fields the note reads are checked; THE one parser of the block, and a malformed one throws, never degrades to "ok".
export type Naming = { status: 'ok' } | { status: 'needed'; instruction: string; suggestedTitle: string | null }

export function parseNaming(raw: unknown): Naming {
  if (raw === null || typeof raw !== 'object') throw new Error(`naming is ${raw === null ? 'null' : typeof raw}, not an object`)
  const n = raw as Record<string, unknown>
  if (n.status === 'ok') return { status: 'ok' }
  if (n.status !== 'needed') throw new Error(`naming.status is ${JSON.stringify(n.status)}, not "ok" or "needed"`)
  if (typeof n.instruction !== 'string' || n.instruction.trim() === '') throw new Error('naming.instruction is not a non-empty string')
  if (n.suggestedTitle !== null && typeof n.suggestedTitle !== 'string') throw new Error('naming.suggestedTitle is neither a string nor null')
  return { status: 'needed', instruction: n.instruction, suggestedTitle: n.suggestedTitle }
}

// The plan left is named by ref and name: the session is on no plan now, and must not write to the
// plan routes until it connects again.
export function disconnectNote(plan: { ref: string; name: string }): string {
  return `[danxbot plan] The operator disconnected this session from ${plan.ref} "${plan.name}" from the Plan pane. This session is on no plan; do not write to /api/plans/mine routes until it connects again.`
}

// DX-4530: the Sign in button (band or pane) signed this session in: the model did not press it, so it is told, as connect
// tells it. `planId` is the plan the sign-in asked to rejoin (null: none, so where it lands is the dashboard's to say); `connected`
// is false when that connect was refused.
export function signInNote(planId: number | null, connected: boolean): string {
  const head = '[danxbot plan] The operator signed this session in to the danxbot dashboard with the Sign in button. Its dashboard tools work again: retry any call that was refused as signed out.'
  if (planId === null) return `${head} It asked to rejoin no plan: call plan_connect to see which plan, if any, it is on.`
  if (!connected) return `${head} Reconnecting it to plan_id ${planId} was refused: call plan_connect to see which plan it is on.`
  return `${head} It is back on plan_id ${planId}: call plan_connect with plan_id ${planId} yourself to read its briefing and start its events.`
}

// DX-4530: the decision on one of the model's `request_permission` requests (DX-4435), told once in its chat: the MCP only frees
// its slot, so without this the model learns the outcome only by retrying (DX-4435 comment 10745).
type Asked = Pick<PermissionRequest, 'code' | 'permissions'>
const askedList = (permissions: readonly string[]) => (permissions.length > 0 ? permissions.join(', ') : 'the permissions it asked for')

export function permissionGrantedNote(r: Asked, granted: readonly string[]): string {
  const missing = r.permissions.filter(p => !granted.includes(p))
  const head = `[danxbot] The person approved permission request ${r.code} (asked: ${askedList(r.permissions)})`
  if (granted.length === 0) return `${head} but granted none of it: do not retry the refused call.`
  return `${head}: this session's key was granted ${granted.join(', ')}.${missing.length > 0 ? ` Not granted: ${missing.join(', ')}.` : ''} Retry the call that was refused for lacking it.`
}

export function permissionDeniedNote(r: Asked): string {
  return `[danxbot] The person denied permission request ${r.code} (asked: ${askedList(r.permissions)}). This session's key did not gain it: do not retry the refused call, and ask again only if the person says to.`
}

export function permissionExpiredNote(r: Asked): string {
  return `[danxbot] Permission request ${r.code} (asked: ${askedList(r.permissions)}) expired before it was decided: this session's dashboard session or key ended. Reconnect the session (call plan_connect), then call request_permission again for ${askedList(r.permissions)}.`
}

// DX-4548: the outcome of a sign-in the model itself started (its `plan_connect` answered `approval_required`), told once in its
// chat so the person never has to type "approved". `planId` is the plan its own call asked for.
export function signInApprovedNote(code: string, planId: number | null): string {
  const again = planId === null ? 'call plan_connect again now' : `call plan_connect again now with plan_id ${planId}`
  return `[danxbot] The person approved sign-in request ${code}: this session's dashboard key is stored and its tools work. Approved: ${again}.`
}

export function signInDeniedNote(code: string): string {
  return `[danxbot] The person denied sign-in request ${code}. This session stays signed out: do not retry unless the person asks.`
}

export function signInExpiredNote(code: string): string {
  return `[danxbot] Sign-in request ${code} expired before it was decided: a renewed request is already open for the person, so wait for its outcome (or call plan_connect to see it).`
}
