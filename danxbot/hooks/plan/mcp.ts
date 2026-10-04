import { ERROR_BODY_MAX, SIGNED_OUT_MARK } from './config'

// What `$.mcp.call` rejects with, as the engine words it.

// The engine's rejection when the session has no such server or tool:
//   `<plugin>: $.mcp.call: no connected MCP tool "<tool>" on a server named "<server>"`
// (Claude Code 2.1.286). Only this one means "this session has no danx-dashboard server" (another
// repo); a timeout, a transport failure or a refusal is a real error the pane must show.
const SERVER_MISSING = /\$\.mcp\.call: no connected MCP tool/

export function isServerMissing(message: string): boolean {
  return SERVER_MISSING.test(message)
}

export function mcpText(r: any): string {
  return (r?.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('')
}

// A tool's result as danxbot_api and plan_connect word it: JSON text `{ok, status, body}` (pretty-printed),
// where a server refusal is `ok: false` and is NEVER an error result. Only a thrown call is an error:
// argument validation, an outdated MCP, a 5xx. So an `isError` result carries plain text, and anything
// that is not an envelope is a failure here, never a success.
export type ToolOutcome = { ok: boolean; status: number; body: any }

// THE one parser of that envelope: api() and every plan_connect caller use it.
export function toolOutcome(r: any): ToolOutcome {
  if (r === null || r === undefined) return { ok: false, status: 0, body: { error: 'the tool answered no result' } }
  const text = mcpText(r)
  if (r.isError) return { ok: false, status: 0, body: { error: text } }
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
