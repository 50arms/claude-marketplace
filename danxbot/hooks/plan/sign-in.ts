import { approvalRequestOf } from './approval'
import type { ApprovalRequest } from './approval'
import { mcpText, refusalText, toolOutcome } from './mcp'

// DX-4423: what one `plan_connect` answer means to the Sign in button, and what the person is told. The server's own
// words are written for the agent (it says "Do not retry unless they ask"), so nothing here passes them on: every
// message below is the person's. The answers are the danx-dashboard MCP's: `{ state, ... }` while the session holds no
// key (session-access.ts), the `{ ok, status, body }` envelope once it connects.
export type SignInStep =
  // a request is waiting for the person's approval: show its page and code, then call again (the call waits for it)
  | { kind: 'approval'; request: ApprovalRequest }
  // still waiting: call again
  | { kind: 'pending' }
  // signed in (and on its plan again when one was asked for)
  | { kind: 'done' }
  // signed in, but the plan connect was refused: the view reloads and says where the session is
  | { kind: 'refused'; message: string }
  // nothing more to do
  | { kind: 'stop'; message: string }

const STOPPED: Record<string, string> = {
  denied: 'Sign in was denied.',
  rate_limited: 'Too many sign-in requests from this machine: wait a minute, then press Sign in again.',
  dashboard_outdated: 'This dashboard cannot approve sessions yet: it needs updating.',
  no_session_id: 'This session has no id, so it cannot sign in.',
}

export function signInStep(result: any): SignInStep {
  const text = mcpText(result)
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'stop', message: 'Sign in failed: the answer could not be read.' }
  }
  if (parsed !== null && typeof parsed === 'object' && typeof parsed.state === 'string') {
    if (parsed.state === 'approval_pending') return { kind: 'pending' }
    if (parsed.state === 'signed_in') return { kind: 'done' }
    if (parsed.state === 'approval_required') {
      const request = approvalRequestOf(text)
      return request === null ? { kind: 'stop', message: 'Sign in failed: the approval request had no usable link.' } : { kind: 'approval', request }
    }
    return { kind: 'stop', message: STOPPED[parsed.state] ?? `Sign in stopped (${parsed.state}).` }
  }
  const outcome = toolOutcome(result)
  return outcome.ok ? { kind: 'done' } : { kind: 'refused', message: `Signed in, but the plan connect was refused: ${refusalText(outcome)}` }
}
