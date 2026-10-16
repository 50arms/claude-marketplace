// DX-5093: the keepalive's local trace. The Browser pane is reachable only from the live desktop app, and nothing in the app logs a pane call that a
// hook raised, so every look the keepalive makes leaves one JSON line here: when, which session and plan, what the pane held, what the look did and
// what failed. A live check reads the file (`<plugin data dir>/keepalive-trace/<session id>.log`) to tell a look that never ran from one the pane did
// not answer from one that opened the tab.

// How many lines a session's trace keeps (the oldest are dropped): about a day of looks, with the arms and wakes between them.
export const TRACE_MAX_LINES = 400

export type TraceFields = {
  // look (a pane look), period (an idle period began)
  event: string
  // what raised a look: idle period, turn start
  trigger?: string
  // what the look came to: checked, not-desktop, no-browser, failed
  outcome?: string
  plan?: number | null
  // the origins of the tabs `tabs_context` named, [] for a closed pane
  tabs?: string[]
  // what the look did: held, navigate, tabs_create+navigate, none
  action?: string
  error?: string
  // anything else worth reading verbatim (the pane's own words, the next due time)
  note?: string
}

// The directory the app gives the plugin for its own files. A plugin installed from a marketplace has its root at
// `<base>/plugins/cache/<marketplace>/<plugin>/<version>` and its data in `<base>/plugins/data/<plugin>-<marketplace>`; a plugin loaded from a folder
// (`--plugin-dir`) has its data in `<home>/.claude/plugins/data/<plugin>-inline`. `home` is null when the environment names none.
export function dataDirOf(root: string, plugin: string, home: string | null): string | null {
  const path = root.replaceAll('\\', '/')
  const match = /^(.*)\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(path)
  if (match !== null) return `${match[1]}/plugins/data/${match[3]}-${match[2]}`
  return home === null ? null : `${home.replaceAll('\\', '/')}/.claude/plugins/data/${plugin}-inline`
}

export const tracePath = (dataDir: string, sessionId: string): string => `${dataDir}/keepalive-trace/${sessionId}.log`

export function traceLine(at: number, sessionId: string, fields: TraceFields): string {
  return JSON.stringify({ at: new Date(at).toISOString(), session: sessionId, ...fields })
}

// The file's text with `line` appended, the oldest lines dropped past TRACE_MAX_LINES.
export function appendTrace(existing: string, line: string): string {
  const lines = existing === '' ? [] : existing.split('\n').filter(l => l !== '')
  lines.push(line)
  return lines.slice(-TRACE_MAX_LINES).join('\n') + '\n'
}
