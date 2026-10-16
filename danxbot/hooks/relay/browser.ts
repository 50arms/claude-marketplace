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

export const answerText = (result: BrowserResult): string =>
  result.content
    .filter(block => block.type === 'text' && block.text !== undefined)
    .map(block => block.text)
    .join(' ')
    .slice(0, 300)

export type PaneState = { kind: 'closed' } | { kind: 'open'; origins: string[] } | { kind: 'unreadable'; why: string }

// What `tabs_context` answered: `{browserOpen, tabs: [{tabId, origin, isActive}]}`.
export function paneState(result: BrowserResult): PaneState {
  if (result.isError) return { kind: 'unreadable', why: `tabs_context failed: ${answerText(result)}` }
  const body = jsonOf(result)
  if (body === null || typeof body.browserOpen !== 'boolean') return { kind: 'unreadable', why: `tabs_context answered an unknown shape: ${answerText(result)}` }
  if (!body.browserOpen) return { kind: 'closed' }
  if (!Array.isArray(body.tabs)) return { kind: 'unreadable', why: 'tabs_context named no tab list' }
  return { kind: 'open', origins: body.tabs.map((tab: any) => String(tab?.origin ?? '')) }
}

// Whether the pane holds a tab on the plan page's site (a tab's `origin` is the scheme, host and port only).
export function holdsPlanTab(state: Extract<PaneState, { kind: 'open' }>, planPage: string): boolean {
  return state.origins.includes(new URL(planPage).origin)
}

// What `tabs_create` answered (`{serverId, tabId, reused, type}`): the new tab, or why it is not one to navigate. A `reused` tab was not made for
// this call and may be one the person holds, so it is refused rather than taken over.
export type CreatedTab = { kind: 'created'; tabId: string } | { kind: 'refused'; why: string }
export function createdTab(result: BrowserResult): CreatedTab {
  const body = result.isError ? null : jsonOf(result)
  if (body === null) return { kind: 'refused', why: `tabs_create answered an unknown shape: ${answerText(result)}` }
  if (body.reused === true) return { kind: 'refused', why: 'tabs_create handed back a tab that already existed, which may be one the person holds' }
  return typeof body.tabId === 'string' && body.tabId !== '' ? { kind: 'created', tabId: body.tabId } : { kind: 'refused', why: 'tabs_create named no tab' }
}

// DX-5093: said once per session when the desktop session has no Browser pane the plugin can call.
export const BROWSER_MISSING_LINE =
  "danxbot: the desktop's Browser pane is not reachable from the plugin, so this session's plan tab will close after the app's 30 idle minutes and nothing reopens it."

// A failed tool answer, as the sentence a toast says.
export const failureOf = (tool: BrowserTool, result: BrowserResult): string | null => (result.isError ? `${tool} failed: ${answerText(result)}` : null)
