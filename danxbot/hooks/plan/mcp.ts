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

// A tool's result as danxbot_api words it: JSON text `{ok, status, body}`. A refusal may arrive as an
// error result or as `ok: false`; a plain object (no `ok`) is a success body.
export type ToolOutcome = { ok: boolean; status: number; body: any }

export function toolOutcome(r: any): ToolOutcome {
  const text = mcpText(r)
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (parsed !== null && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
    return { ok: parsed.ok && !r.isError, status: typeof parsed.status === 'number' ? parsed.status : 0, body: parsed.body }
  }
  if (r.isError) return { ok: false, status: 0, body: parsed ?? { error: text } }
  return { ok: true, status: 0, body: parsed }
}
