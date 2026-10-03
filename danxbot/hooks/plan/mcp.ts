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
