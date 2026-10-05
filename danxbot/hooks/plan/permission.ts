import type { PermissionRequest } from '../../types'
import { approvalRequestOf } from './approval'
import type { ApprovalRequest } from './approval'
import { PROBLEM_GLYPH } from './config'
import { isSignedOut, outcomeRevokedBy } from './mcp'
import type { ToolOutcome } from './mcp'
import { permissionDeniedNote, permissionExpiredNote, permissionGrantedNote } from './notes'

// DX-4435 (parent DX-4432): a `request_permission` call of the danx-dashboard MCP (DX-4434). It answers at once, never waiting
// for the person:
//   { state: 'approval_required' | 'approval_pending', approvalUrl, confirmCode, instruction }
// `approval_pending` is a repeat call for a set already asked for. The page is `<dashboard>/connect/<publicId>` and the key's own
// claim route, `POST /api/permission-requests/<publicId>/claim`, answers `{status, granted}` with status one of
// pending | approved | claimed | denied | expired, and `granted` the subset the owner granted once approved (null otherwise).
// DX-4530: a request has no expiry clock: it stays open until the session that asked ends (its key revoked or lapsed), when
// the claim answers `expired`. Only the claim decides it, so an `expiresAt` in the answer is not read.

// The request a `request_permission` answer carries, with the permissions the model asked for (its call's own argument),
// or null when the answer is anything else (a refusal, a halt, a malformed answer).
export function permissionRequestOf(text: string | undefined, asked: unknown): PermissionRequest | null {
  const approval = approvalRequestOf(text, ['approval_required', 'approval_pending'])
  if (approval === null) return null
  const publicId = new URL(approval.url).pathname.split('/').filter(Boolean).pop()
  if (!publicId) return null
  const permissions = Array.isArray(asked) ? asked.filter((p): p is string => typeof p === 'string') : []
  return { url: approval.url, code: approval.code, publicId, permissions }
}

export const claimPath = (r: PermissionRequest) => `/api/permission-requests/${r.publicId}/claim`

// DX-4530: the claim's answer as the decision the model is told. `approved` (the first claim of a grant) and `claimed` (every
// later one, the MCP's own poll may claim first) are both `granted`, with the subset granted. Anything unreadable, an approval
// naming no grant included, is `unknown`: the request stays for the next poll.
export type ClaimDecision =
  | { kind: 'pending' }
  | { kind: 'granted'; granted: string[] }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'unknown' }

export function claimStatus(body: any): ClaimDecision {
  const status = body?.status
  if (status === 'pending' || status === 'denied' || status === 'expired') return { kind: status }
  if (status === 'approved' || status === 'claimed') {
    const granted = body.granted
    return Array.isArray(granted) && granted.every(p => typeof p === 'string') ? { kind: 'granted', granted } : { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}

// DX-4530: what one claim answer means for its request: `keep` it for the next poll, or `drop` it, telling the model `note`
// (null: told nothing). A key a person revoked is dropped untold: every tool already tells the session to stop, and "ask again"
// would contradict that. A lapsed key, or a request the dashboard no longer knows (404: gone, or this session holds another key
// now), is the session having ended: told as expired. Any other failure keeps the request.
export type Settled = { kind: 'keep' } | { kind: 'drop'; note: string | null }

const KEEP: Settled = { kind: 'keep' }
const drop = (note: string | null): Settled => ({ kind: 'drop', note })

export function settle(r: PermissionRequest, out: ToolOutcome): Settled {
  if (outcomeRevokedBy(out) !== null) return drop(null)
  if (out.status === 404 || isSignedOut(out)) return drop(permissionExpiredNote(r))
  if (!out.ok) return KEEP
  const decision = claimStatus(out.body)
  if (decision.kind === 'granted') return drop(permissionGrantedNote(r, decision.granted))
  if (decision.kind === 'denied') return drop(permissionDeniedNote(r))
  if (decision.kind === 'expired') return drop(permissionExpiredNote(r))
  return KEEP
}

export function permissionBadge(n: number): string {
  return n === 0 ? '' : `${PROBLEM_GLYPH} ${n} permission request${n === 1 ? '' : 's'}`
}

// The approval toast's request, carrying what was asked for.
export const asApproval = (r: PermissionRequest): ApprovalRequest => ({ url: r.url, code: r.code, permissions: r.permissions })
