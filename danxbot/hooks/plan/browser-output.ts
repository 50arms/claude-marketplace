import { OUTPUT_EXCERPT_MAX } from './config'

// The in-app browser's tool results (the Claude_Browser MCP server), as text. A result that does
// not read as described THROWS: the caller turns it into the "use the link instead" toast. Reading
// it as "no tabs" instead would open a new tab on every press.

// tabs_context answers JSON text, possibly with a prose preamble:
//   {"browserOpen": true, "tabs": [{"tabId": "tab-1", "origin": "https://..."}, ...]}
export function parseTabs(text: string): string[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`tabs_context answered no JSON: ${text.slice(0, OUTPUT_EXCERPT_MAX)}`)
  let parsed: any
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error(`tabs_context answered unreadable JSON: ${text.slice(0, OUTPUT_EXCERPT_MAX)}`)
  }
  if (!Array.isArray(parsed.tabs)) throw new Error(`tabs_context answered no tabs list: ${text.slice(0, OUTPUT_EXCERPT_MAX)}`)
  return parsed.tabs.map((t: any) => String(t.tabId))
}

// tabs_create names the new tab as `"tabId": "<id>"` (or `tabId=<id>`) somewhere in its text.
export function parseTabId(text: string): string {
  const id = /tabId"?\s*[:=]\s*"?([\w-]+)/.exec(text)?.[1]
  if (!id) throw new Error(`tabs_create answered no tabId: ${text.slice(0, OUTPUT_EXCERPT_MAX)}`)
  return id
}
