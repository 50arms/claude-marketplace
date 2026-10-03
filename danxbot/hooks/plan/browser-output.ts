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
  for (const t of parsed.tabs) {
    if (t === null || typeof t !== 'object' || typeof t.tabId !== 'string' || t.tabId === '') {
      throw new Error(`tabs_context listed a tab with no tabId: ${excerpt(JSON.stringify(t))}`)
    }
  }
  return {
    browserOpen: parsed.browserOpen,
    tabs: parsed.tabs.map((t: any) => ({ id: t.tabId, isActive: t.isActive === true })),
  }
}

// tabs_create with the pane open answers a JSON object with the new tab, then prose:
//   {"serverId": "preview-local_...", "tabId": "tab-1", "reused": false, "type": "browser"}
//   Opened tab tab-1 in the background ...
// With the pane closed it answers prose only ("No tab was created. The Browser pane isn't open yet ...").
export function parseTabId(text: string): string {
  const json = firstJsonObject(text)
  let id: unknown
  try {
    id = json === null ? undefined : JSON.parse(json).tabId
  } catch {
    id = undefined
  }
  if (typeof id !== 'string' || id === '') throw new Error(`tabs_create answered no tabId: ${excerpt(text)}`)
  return id
}

// preview_start {url} is the one call that opens the Browser pane from a closed state (a navigate
// with no tabId is refused: "navigation to <origin> was denied or failed"). It answers a JSON
// object, then prose, and the tab it used is `tabId`; `navOk` says the page loaded:
//   {"serverId": "preview-local_...", "tabId": "seed", "reused": true, "type": "browser", "navOk": true}
//   Browser pane opened. Use serverId "..." with read_page / computer / navigate.
export function parsePreviewStart(text: string): string {
  const json = firstJsonObject(text)
  let parsed: any
  try {
    parsed = json === null ? undefined : JSON.parse(json)
  } catch {
    parsed = undefined
  }
  if (parsed === undefined) throw new Error(`preview_start answered no JSON: ${excerpt(text)}`)
  if (parsed.navOk !== true) throw new Error(`preview_start did not load the page (navOk is not true): ${excerpt(text)}`)
  if (typeof parsed.tabId !== 'string' || parsed.tabId === '') throw new Error(`preview_start answered no tabId: ${excerpt(text)}`)
  return parsed.tabId
}
