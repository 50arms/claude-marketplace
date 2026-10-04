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

// What the person is told while the code and the page can be compared: the code is in it either way,
// and the link too, since a browser that did not open leaves the link as the only way in.
export type OpenFailure = { step: string; message: string }

export function approvalToast(a: ApprovalRequest, failed: OpenFailure | null): string {
  if (failed === null) return `Approve this session in the browser. Confirm code ${a.code} must match the page: ${a.url}`
  return `Could not open the approval page (${failed.step}: ${failed.message}). Open this link and check that confirm code ${a.code} matches: ${a.url}`
}
