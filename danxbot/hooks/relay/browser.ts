// DX-5093: the plan-tab keepalive reaches the desktop app's Browser pane itself, with no model turn. The pane's server is one of the session's MCP
// servers (named `Claude_Browser`, its tools `mcp__Claude_Browser__*`), and `$.mcp.call` runs a tool of any connected server by name (claude.exe
// 2.1.295: it looks the tool up in the session's tool list, so an SDK-hosted server answers like any other). The hook asks which tabs the pane holds
// (`tabs_context`) and, when the plan page's tab is missing, opens it again (`tabs_create`, then `navigate`; `navigate` alone when the pane is closed).
export const BROWSER_SERVER = 'Claude_Browser'
export const BROWSER_TOOLS = ['tabs_context', 'tabs_create', 'navigate'] as const
export type BrowserTool = (typeof BROWSER_TOOLS)[number]

// The tool name as the permission check sees it (`mcp__<server>__<tool>`).
export const browserToolName = (tool: BrowserTool): string => `mcp__${BROWSER_SERVER}__${tool}`

// A call of the plugin to one of the three pane tools above: the only ones the keepalive makes (see ownServerCheck).
export const isBrowserKeepaliveTool = (name: string): boolean => BROWSER_TOOLS.some(tool => browserToolName(tool) === name)

type Block = { type: string; text?: string }
export type BrowserResult = { content: readonly Block[]; isError: boolean }

// The first text block of a result that parses as a JSON object, or null.
function jsonOf(result: BrowserResult): Record<string, unknown> | null {
  for (const block of result.content) {
    if (block.type !== 'text' || block.text === undefined) continue
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // another block (a note after the JSON, such as "The Browser pane is currently hidden.")
    }
  }
  return null
}

const textOf = (result: BrowserResult): string =>
  result.content
    .filter(block => block.type === 'text' && block.text !== undefined)
    .map(block => block.text)
    .join(' ')
    .slice(0, 300)

export type PaneState = { kind: 'closed' } | { kind: 'open'; origins: string[] } | { kind: 'unreadable'; why: string }

// What `tabs_context` answered: `{browserOpen, tabs: [{tabId, origin, isActive}]}`.
export function paneState(result: BrowserResult): PaneState {
  if (result.isError) return { kind: 'unreadable', why: `tabs_context failed: ${textOf(result)}` }
  const body = jsonOf(result)
  if (body === null || typeof body.browserOpen !== 'boolean') return { kind: 'unreadable', why: `tabs_context answered an unknown shape: ${textOf(result)}` }
  if (!body.browserOpen) return { kind: 'closed' }
  if (!Array.isArray(body.tabs)) return { kind: 'unreadable', why: 'tabs_context named no tab list' }
  return { kind: 'open', origins: body.tabs.map((tab: any) => String(tab?.origin ?? '')) }
}

// Whether the pane holds a tab on the plan page's site (a tab's `origin` is the scheme, host and port only).
export function holdsPlanTab(state: Extract<PaneState, { kind: 'open' }>, planPage: string): boolean {
  return state.origins.includes(new URL(planPage).origin)
}

// The id of the tab `tabs_create` made, or null when its answer names none.
export function createdTabId(result: BrowserResult): string | null {
  if (result.isError) return null
  const id = jsonOf(result)?.tabId
  return typeof id === 'string' && id !== '' ? id : null
}

// A failed tool answer, as the sentence a toast says.
export const failureOf = (tool: BrowserTool, result: BrowserResult): string | null => (result.isError ? `${tool} failed: ${textOf(result)}` : null)
