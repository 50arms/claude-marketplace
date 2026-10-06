// DX-4391: what `plan_connect` answers while the session holds no dashboard key. The MCP server
// (DX-4390) replies with the bare request, not the `{ok, status, body}` envelope a connect uses:
//   { state: 'approval_required', approvalUrl, confirmCode, expiresAt, instruction }
// `approval_required` is the answer to a NEW request (a later call answers `approval_pending`), so
// it is the one state that opens the approval page.

// DX-4435: `permissions` is set for a `request_permission` request (what the key asks to be granted), absent for a sign-in.
export type ApprovalRequest = { url: string; code: string; permissions?: readonly string[] }

// `states`: the answers that carry a request to show. A model's `plan_connect` shows only a NEW request
// (`approval_required`); DX-4423's Sign in also reads the request a waiting call names (`approval_pending`).
export function approvalRequestOf(text: string | undefined, states: readonly string[] = ['approval_required']): ApprovalRequest | null {
  if (!text) return null
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || !states.includes(parsed.state)) return null
  const { approvalUrl, confirmCode } = parsed
  // only a web link is opened in the browser
  if (typeof approvalUrl !== 'string' || !/^https?:\/\//.test(approvalUrl)) return null
  if (typeof confirmCode !== 'string' || confirmCode === '') return null
  return { url: approvalUrl, code: confirmCode }
}

// What the person is told while the code and the page can be compared: the code is in it either way,
// and the link too, since a browser that did not open leaves the link as the only way in.
export type OpenFailure = { step: string; message: string }

// What the person is asked to approve: the permissions a key asked for, else the session itself.
export const approvalSubject = (a: ApprovalRequest) => (a.permissions && a.permissions.length > 0 ? `permission ${a.permissions.join(', ')}` : 'this session')

export function approvalToast(a: ApprovalRequest, failed: OpenFailure | null): string {
  if (failed === null) return `Approve ${approvalSubject(a)} in the browser. Confirm code ${a.code} must match the page: ${a.url}`
  return `Could not open the approval page (${failed.step}: ${failed.message}). Open this link and check that confirm code ${a.code} matches: ${a.url}`
}

// DX-4630: a sign-in request's toast: the link and code together, no browser involved (the person follows the link).
export const signInToast = (a: ApprovalRequest) => `Approve this session: open ${a.url} and check that confirm code ${a.code} matches.`

// The label of the band's and the pane's sign-in Link, and the words beside the code.
export const APPROVE_SIGN_IN_LABEL = 'Approve sign-in ↗'
export const signInCodeLabel = (a: ApprovalRequest) => `code ${a.code}`

// What the model reads after a tool answer that carries a sign-in request: the plugin has put the link and code in front of the
// person already, so the model only has to say so (and opens nothing).
export const signInShownNote = (a: ApprovalRequest) =>
  `The danxbot plugin already shows the person the approval link (${a.url}) and confirm code ${a.code} in the band. Do not open the link yourself; tell the user to approve with confirm code ${a.code}.`
