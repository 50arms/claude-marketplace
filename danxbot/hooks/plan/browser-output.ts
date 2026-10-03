import { OUTPUT_EXCERPT_MAX } from './config'

// The in-app browser's tool results (the Claude_Browser MCP server), as text. A result that does
// not read as described THROWS: the caller turns it into the "use the link instead" toast. Reading
// it as "no tabs" instead would open a new tab on every press.
//
// The real results are a JSON object FOLLOWED BY PROSE (captured from the desktop app), e.g.
// tabs_context with the Browser pane closed:
//   {\n  "browserOpen": false,\n  "tabs": []\n}\nThe Browser pane isn't open yet, so there are no tabs. ...
// and with it open:
//   {"browserOpen": true, "tabs": [{"tabId": "seed", "origin": "https://...", "isActive": true}]}\nThe Browser pane is currently displayed.

export type BrowserTab = { id: string; isActive: boolean }
export type TabsContext = { browserOpen: boolean; tabs: BrowserTab[] }

// The first balanced JSON object in the text, ignoring anything after it (and braces inside strings).
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

const excerpt = (text: string) => text.slice(0, OUTPUT_EXCERPT_MAX)

// `browserOpen: false` with no tabs is a valid answer, not an error: the pane is closed.
export function parseTabsContext(text: string): TabsContext {
  const json = firstJsonObject(text)
  if (!json) throw new Error(`tabs_context answered no JSON: ${excerpt(text)}`)
  let parsed: any
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`tabs_context answered unreadable JSON: ${excerpt(text)}`)
  }
  if (typeof parsed.browserOpen !== 'boolean') throw new Error(`tabs_context answered no browserOpen: ${excerpt(text)}`)
  if (!Array.isArray(parsed.tabs)) throw new Error(`tabs_context answered no tabs list: ${excerpt(text)}`)
  return {
    browserOpen: parsed.browserOpen,
    tabs: parsed.tabs.map((t: any) => ({ id: String(t.tabId), isActive: t.isActive === true })),
  }
}

// The tab to adopt after the pane opened: the active one, else the only one.
export function activeTab(ctx: TabsContext): string {
  const tab = ctx.tabs.find(t => t.isActive) ?? (ctx.tabs.length === 1 ? ctx.tabs[0] : undefined)
  if (!ctx.browserOpen || !tab) throw new Error('the Browser pane did not open a tab')
  return tab.id
}

// tabs_create's text was never captured, so the id is read tolerantly: a JSON `tabId`, else the prose
// forms `tabId: <id>` / `tabId=<id>` / `tabId <id>`.
export function parseTabId(text: string): string {
  const json = firstJsonObject(text)
  if (json) {
    try {
      const id = JSON.parse(json).tabId
      if (typeof id === 'string' && id) return id
    } catch {
      // not JSON after all: fall through to the prose forms
    }
  }
  const id = /tabId"?(?:\s*[:=]\s*|\s+)"?([\w-]+)/.exec(text)?.[1]
  if (!id) throw new Error(`tabs_create answered no tabId: ${excerpt(text)}`)
  return id
}
