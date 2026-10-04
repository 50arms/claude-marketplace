import type { PermissionRequest } from '../../types'
import { approvalRequestOf } from './approval'
import type { ApprovalRequest } from './approval'
import { PROBLEM_GLYPH } from './config'

// DX-4435 (parent DX-4432): a `request_permission` call of the danx-dashboard MCP (DX-4434). It answers at once, never waiting
// for the person:
//   { state: 'approval_required' | 'approval_pending', approvalUrl, confirmCode, expiresAt, instruction }
// `approval_pending` is a repeat call for a set already asked for. The page is `<dashboard>/connect/<publicId>` and the key's own
// claim route, `POST /api/permission-requests/<publicId>/claim`, answers `{status, granted}` with status one of
// pending | approved | claimed | denied | expired. Only `pending` is still open.

// The request a `request_permission` answer carries, with the permissions the model asked for (its call's own argument),
// or null when the answer is anything else (a refusal, a halt, a malformed answer).
export function permissionRequestOf(text: string | undefined, asked: unknown): PermissionRequest | null {
  const approval = approvalRequestOf(text, ['approval_required', 'approval_pending'])
  if (approval === null) return null
  const expiresAt = Date.parse(JSON.parse(text as string).expiresAt)
  if (!Number.isFinite(expiresAt)) return null
  const publicId = new URL(approval.url).pathname.split('/').filter(Boolean).pop()
  if (!publicId) return null
  const permissions = Array.isArray(asked) ? asked.filter((p): p is string => typeof p === 'string') : []
  return { url: approval.url, code: approval.code, publicId, permissions, expiresAt }
}

export const claimPath = (r: PermissionRequest) => `/api/permission-requests/${r.publicId}/claim`

// The claim's answer as one decision: still open, or over (approved, denied or expired). Anything unreadable is `unknown`.
export function claimStatus(body: any): 'pending' | 'over' | 'unknown' {
  const status = body?.status
  if (status === 'pending') return 'pending'
  return ['approved', 'claimed', 'denied', 'expired'].includes(status) ? 'over' : 'unknown'
}

// The ones still open at `now`; the newest is the last.
export const livePermissionRequests = (all: readonly PermissionRequest[], now: number) => all.filter(r => r.expiresAt > now)

export function permissionBadge(n: number): string {
  return n === 0 ? '' : `${PROBLEM_GLYPH} ${n} permission request${n === 1 ? '' : 's'}`
}

// The approval toast's request, carrying what was asked for.
export const asApproval = (r: PermissionRequest): ApprovalRequest => ({ url: r.url, code: r.code, permissions: r.permissions })
