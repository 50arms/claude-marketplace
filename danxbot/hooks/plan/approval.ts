// DX-4391: what `plan_connect` answers while the session holds no dashboard key. The MCP server
// (DX-4390) replies with the bare request, not the `{ok, status, body}` envelope a connect uses:
//   { state: 'approval_required', approvalUrl, confirmCode, expiresAt, instruction }
// `approval_required` is the answer to a NEW request (a later call answers `approval_pending`), so
// it is the one state that opens the approval page.

export type ApprovalRequest = { url: string; code: string }

export function approvalRequestOf(text: string | undefined): ApprovalRequest | null {
  if (!text) return null
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.state !== 'approval_required') return null
  const { approvalUrl, confirmCode } = parsed
  // only a web link is opened in the browser
  if (typeof approvalUrl !== 'string' || !/^https?:\/\//.test(approvalUrl)) return null
  if (typeof confirmCode !== 'string' || confirmCode === '') return null
  return { url: approvalUrl, code: confirmCode }
}

// The code stays up while the person compares it with the page; the link is in it too, since a
// browser that fails to open leaves the link as the only way in.
export function approvalToast(a: ApprovalRequest): string {
  return `Approve this session in the browser. Confirm code ${a.code} must match the page: ${a.url}`
}
