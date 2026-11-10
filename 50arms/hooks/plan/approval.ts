// what `session_connect` answers while the session holds no dashboard key. The MCP server
// replies with the bare request, not the `{ok, status, body}` envelope a connect uses:
//   { state: 'approval_required', approvalUrl, confirmCode, expiresAt, instruction }
// `approval_required` is the answer to a NEW request (a later call answers `approval_pending`), so
// it is the one state that opens the approval page.

// `permissions` is set for a `request_permission` request (what the key asks to be granted), absent for a sign-in.
export type ApprovalRequest = { url: string; code: string; permissions?: readonly string[] }

// `states`: the answers that carry a request to show. A model's `session_connect` shows only a NEW request
// (`approval_required`); the Sign in also reads the request a waiting call names (`approval_pending`).
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
  // only a web link is shown
  if (typeof approvalUrl !== 'string' || !/^https?:\/\//.test(approvalUrl)) return null
  if (typeof confirmCode !== 'string' || confirmCode === '') return null
  return { url: approvalUrl, code: confirmCode }
}

// What the model reads after a tool answer that carries a permission request: the band shows the link and code to the person,
// so the model opens nothing and only says so.
export const permissionShownNote = (a: ApprovalRequest) =>
  `The 50 Arms plugin already shows the person the approval link (${a.url}) and confirm code ${a.code} in the band. Do not open the link yourself; tell the user to approve with confirm code ${a.code}.`

// The label of the band's sign-in link, and the words beside a request's code.
export const APPROVE_SIGN_IN_LABEL = 'Approve sign-in ↗'
export const codeLabel = (a: ApprovalRequest) => `code ${a.code}`

// What the model reads after a tool answer that carries a sign-in request: the plugin has put the link and code in front of the
// person already, so the model only has to say so (and opens nothing).
export const signInShownNote = (a: ApprovalRequest) =>
  `The 50 Arms plugin already shows the person the approval link (${a.url}) and confirm code ${a.code} in the band. Do not open the link yourself; tell the user to approve with confirm code ${a.code}.`
