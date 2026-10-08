import { ERROR_BODY_MAX, KEY_REVOKED_HALT, SIGNED_OUT_MARK } from './config'

// What `$.mcp.call` rejects with, as the engine words it.

// The engine's rejection when the session has no such server or tool:
//   `<plugin>: $.mcp.call: no connected MCP tool "<tool>" on a server named "<server>"`
// (Claude Code 2.1.286). At session start it means the plugin's server has not connected yet (DX-4578).
const SERVER_NOT_CONNECTED = /\$\.mcp\.call: no connected MCP tool/

export function isServerNotConnected(message: string): boolean {
  return SERVER_NOT_CONNECTED.test(message)
}

export function mcpText(r: any): string {
  return (r?.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('')
}

// DX-4233: the plan a plan_connect answer says the session is on now: its `{ok: true, body: {session: {plan_id}}}` envelope. Null for anything
// else: a refusal, an approval request, a leave (`plan_id: null`), text that is no envelope.
export function connectedPlanId(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const outcome = textOutcome(text, false)
  const planId = outcome.ok ? outcome.body?.session?.plan_id : undefined
  return typeof planId === 'number' ? planId : null
}

// A tool's result as danxbot_api and plan_connect word it: JSON text `{ok, status, body}` (pretty-printed),
// where a server refusal is `ok: false` and is NEVER an error result. Only a thrown call is an error:
// argument validation, an outdated MCP, a 5xx. So an `isError` result carries plain text, and anything
// that is not an envelope is a failure here, never a success.
export type ToolOutcome = { ok: boolean; status: number; body: any }

// An MCP tool result's envelope: api() and the pane's plan_connect calls use it.
export function toolOutcome(r: any): ToolOutcome {
  if (r === null || r === undefined) return { ok: false, status: 0, body: { error: 'the tool answered no result' } }
  return textOutcome(mcpText(r), r.isError === true)
}

// THE one parser of that envelope, from a result's text (`isError`: the call threw): toolOutcome, connectedPlanId, and the model's own
// plan_connect result as its tool.call hook sees it (DX-4235: whether its leave or move happened) all read it here.
export function textOutcome(text: string, isError: boolean): ToolOutcome {
  if (isError) return { ok: false, status: 0, body: { error: text } }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, status: 0, body: { error: text } }
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
    return { ok: false, status: 0, body: { error: `the tool answered no {ok, status, body}: ${text.slice(0, ERROR_BODY_MAX)}` } }
  }
  return { ok: parsed.ok, status: typeof parsed.status === 'number' ? parsed.status : 0, body: parsed.body }
}

// What a refusal says: the server's own message (or error), and for plan_mismatch which plan the
// session is really on.
export function refusalText(o: ToolOutcome): string {
  const b = o.body ?? {}
  const said = String(b.message ?? b.error ?? 'no detail')
  const real = b.error === 'plan_mismatch' && b.actual_plan ? ` (PLAN-${b.actual_plan.id} "${b.actual_plan.name}")` : ''
  return `${o.status || 'mcp'} ${said}${real}`
}

// DX-4423: whether a tool's outcome says the session holds no dashboard key (see SIGNED_OUT_MARK). The server answers it as an
// error result, which toolOutcome reads as status 0 with the text as the error; a failure with a real status that merely
// mentions signing in is a plain failure.
export function isSignedOut(o: ToolOutcome): boolean {
  return !o.ok && o.status === 0 && typeof o.body?.error === 'string' && o.body.error.includes(SIGNED_OUT_MARK)
}

// DX-4418: who revoked the key, when the text is the MCP's stop halt for a key a person revoked (see KEY_REVOKED_HALT); null for
// any other text. Anchored at the start: nothing that merely quotes the sentence counts.
export function keyRevokedBy(text: string): string | null {
  return KEY_REVOKED_HALT.exec(text)?.[1] ?? null
}

// The same for a tool's outcome: the halt is an error result, so status 0 with the text as the error.
export function outcomeRevokedBy(o: ToolOutcome): string | null {
  return !o.ok && o.status === 0 && typeof o.body?.error === 'string' ? keyRevokedBy(o.body.error) : null
}
