import type { PermissionRequest } from '../../types'

// The rows the operator's band actions append for the model: the model did not make
// these calls, so it is told. The person never reads them.
// A person's Disconnect takes the session off its plan or card and leaves it signed in with its team agent. The model did not make the call, so it is told the session is on no plan or card now, and that
// it joins one again only when the person asks. The plan or card left is named by ref and name: the session must not write to the plan routes.
export function disconnectNote(left: { ref: string; name: string }): string {
  return `[50 Arms plan] The operator disconnected this session from ${left.ref} "${left.name}" with the band's Disconnect button. It is still signed in and keeps its team agent, but it holds no plan or card now. Do not call session_connect to join a plan or card, and do not write to /api/plans/mine routes, until the operator asks you to.`
}

// A person's Revoke ends the session's sign-in, so the model is told not to connect again: only the person's Sign in restarts the session.
// `ended`: the sign-in was ended (false: that call failed, the key still works but the person has taken the session back).
export function revokeNote(d: { ended: boolean }): string {
  const state = d.ended ? "The operator revoked this session's sign-in" : "The operator tried to revoke this session's sign-in, but the call failed (the operator's band says so)"
  return `[50 Arms plan] ${state} with the band's Revoke button. Do not call session_connect or any other 50 Arms dashboard tool, and do not write to /api/plans/mine routes, until the operator signs this session in again with the band's Sign in: a person's approval is needed, and none of your calls can reconnect it.`
}

// the toast of a Disconnect: the plan or card left.
export const disconnectedToast = (left: { ref: string }) => `Disconnected from ${left.ref}`

// the toast of a Revoke that ended the sign-in: the agent it freed, when the session held one.
export const revokedToast = (agentName: string | null) => `Revoked this session's sign-in${agentName === null ? '' : ` and freed team agent ${agentName}`}`

// the band's Sign in button signed this session in: the model did not press it, so it is told, as a disconnect
// tells it. `target` is the plan the sign-in asked to rejoin (`PLAN-n`; null: none, so where it lands is the dashboard's to say); `connected`
// is false when that connect was refused.
export function signInNote(target: string | null, connected: boolean): string {
  const head = '[50 Arms plan] The operator signed this session in to the 50 Arms dashboard with the Sign in button. Its dashboard tools work again: retry any call that was refused as signed out.'
  if (target === null) return `${head} It asked to rejoin no plan: call session_connect to see which plan, if any, it is on.`
  if (!connected) return `${head} Reconnecting it to ${target} was refused: call session_connect to see which plan it is on.`
  return `${head} It is back on ${target}: call session_connect with target ${target} yourself to read its briefing and start its events.`
}

// the decision on one of the model's `request_permission` requests, told once in its chat: the MCP only frees
// its slot, so without this the model learns the outcome only by retrying.
type Asked = Pick<PermissionRequest, 'code' | 'permissions'>
const askedList = (permissions: readonly string[]) => (permissions.length > 0 ? permissions.join(', ') : 'the permissions it asked for')

export function permissionGrantedNote(r: Asked, granted: readonly string[]): string {
  const missing = r.permissions.filter(p => !granted.includes(p))
  const head = `[50 Arms] The person approved permission request ${r.code} (asked: ${askedList(r.permissions)})`
  if (granted.length === 0) return `${head} but granted none of it: do not retry the refused call.`
  return `${head}: this session's key was granted ${granted.join(', ')}.${missing.length > 0 ? ` Not granted: ${missing.join(', ')}.` : ''} Retry the call that was refused for lacking it.`
}

export function permissionDeniedNote(r: Asked): string {
  return `[50 Arms] The person denied permission request ${r.code} (asked: ${askedList(r.permissions)}). This session's key did not gain it: do not retry the refused call, and ask again only if the person says to.`
}

export function permissionExpiredNote(r: Asked): string {
  return `[50 Arms] Permission request ${r.code} (asked: ${askedList(r.permissions)}) expired before it was decided: this session's dashboard session or key ended. Reconnect the session (call session_connect), then call request_permission again for ${askedList(r.permissions)}.`
}

// the outcome of a sign-in the model itself started (its `session_connect` answered `approval_required`), told once in its
// chat so the person never has to type "approved". `target` is what its own call asked to hold (`PLAN-n` or a card's id; null: none).
export function signInApprovedNote(code: string, target: string | null): string {
  const again = target === null ? 'call session_connect again now' : `call session_connect again now with target ${target}`
  return `[50 Arms] The person approved sign-in request ${code}: this session's dashboard key is stored and its tools work. Approved: ${again}.`
}

export function signInDeniedNote(code: string): string {
  return `[50 Arms] The person denied sign-in request ${code}. This session stays signed out: do not retry unless the person asks.`
}

export function signInExpiredNote(code: string): string {
  return `[50 Arms] Sign-in request ${code} expired before it was decided: a renewed request is already open for the person, so wait for its outcome (or call session_connect to see it).`
}
