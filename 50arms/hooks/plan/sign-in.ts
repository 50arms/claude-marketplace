import { approvalRequestOf } from './approval'
import type { ApprovalRequest } from './approval'
import { keyRevokedBy, mcpText, refusalText, toolOutcome } from './mcp'

// what one `plan_connect` answer means to the Sign in button, and what the person is told. The server's own
// words are written for the agent (it says "Do not retry unless they ask"), so nothing here passes them on: every
// message below is the person's. The answers are the dashboard MCP's: `{ state, ... }` while the session holds no
// key, the `{ ok, status, body }` envelope once it connects.
export type SignInStep =
  // a request is waiting for the person's approval (`request`: its page and code): show it, then call again (the call waits
  // for it). An answer that names no usable request is a `stop`, never a wait: the wait has no round limit, so a
  // call that answered at once with nothing to wait on must not be repeated.
  | { kind: 'waiting'; request: ApprovalRequest }
  // the person denied the request (the model is told, the others are not)
  | { kind: 'denied' }
  // signed in (and on its plan again when one was asked for)
  | { kind: 'done' }
  // signed in, but the plan connect was refused: the view reloads and says where the session is
  | { kind: 'refused'; message: string }
  // a person revoked the key while signing in: nothing more to do, and the view reads the truth
  | { kind: 'revoked'; by: string }
  // nothing more to do. `signedIn`: the key exists and only a team agent is missing
  | { kind: 'stop'; message: string; signedIn?: true }

export const NO_AGENT: Record<string, string> = {
  agent_needed: 'Signed in, but no team agent exists for this session: a person on the team needs to create one.',
  agent_limit_reached: 'Signed in, but every team agent is in use: a person needs to end another session first.',
}

const STOPPED: Record<string, string> = {
  rate_limited: 'Too many sign-in requests from this machine: wait a minute, then press Sign in again.',
  dashboard_outdated: 'This dashboard cannot approve sessions yet: it needs updating.',
  no_session_id: 'This session has no id, so it cannot sign in.',
  request_failed: 'Sign in could not be completed: try again in a moment.',
  request_refused: 'The dashboard refused the sign-in request.',
  ...NO_AGENT,
}

export function signInStep(result: any): SignInStep {
  const text = mcpText(result)
  const revokedBy = keyRevokedBy(text)
  if (revokedBy !== null) return { kind: 'revoked', by: revokedBy }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'stop', message: 'Sign in failed: the answer could not be read.' }
  }
  if (parsed !== null && typeof parsed === 'object' && typeof parsed.state === 'string') {
    // a plan-less plan_connect that holds a key answers the claim of its team agent (`agent_held`), not `signed_in`
    if (parsed.state === 'signed_in' || parsed.state === 'agent_held') return { kind: 'done' }
    if (parsed.state === 'denied') return { kind: 'denied' }
    if (parsed.state === 'approval_required' || parsed.state === 'approval_pending') {
      const request = approvalRequestOf(text, [parsed.state])
      return request === null ? { kind: 'stop', message: 'Sign in failed: the approval request had no usable link.' } : { kind: 'waiting', request }
    }
    return { kind: 'stop', message: STOPPED[parsed.state] ?? `Sign in stopped (${parsed.state}).`, ...(parsed.state in NO_AGENT ? { signedIn: true as const } : {}) }
  }
  const outcome = toolOutcome(result)
  return outcome.ok ? { kind: 'done' } : { kind: 'refused', message: `Signed in, but the plan connect was refused: ${refusalText(outcome)}` }
}
