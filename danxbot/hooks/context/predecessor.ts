// DX-4234: which earlier sessions of this project were plan-connected: the candidates whose `GET /api/plan-sessions/:id/restart-notice`
// says what they were working. A restarted session has a NEW id and no binding, so its own record cannot say; the earlier one's can,
// found by the project key `plan_connect` wrote into the record.
//
// MIRROR: this reads the records the danx-dashboard MCP server writes (`~/.config/danxbot/plan-sessions/<session id>.json`, schema 3,
// danxbot packages/danx-dashboard-mcp/src/session-connection.ts: `findPredecessorCandidates` and `projectKeyOf`). It applies the same
// rules and must change with them. Pure: the records (parsed JSON) and the clock arrive as arguments.
export const CONNECTION_SCHEMA_VERSION = 3
export const STALE_RECORD_MS = 7 * 24 * 60 * 60 * 1000
// How many earlier sessions one start asks about, newest first: many sessions share a checkout and the dashboard answers "nothing" for a live sibling.
export const MAX_CANDIDATES = 10

// The one definition of "the same project": the working directory, normalised so one directory reached two ways compares equal. A
// Windows path takes forward slashes and a lower-case drive letter (`C:\Work\p` and `c:/Work/p` are one key).
export function projectKeyOf(cwd: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(cwd)
  const rest = drive ? cwd.slice(2) : cwd
  const parts: string[] = []
  for (const part of rest.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const body = parts.join('/')
  return drive ? `${drive[1].toLowerCase()}:/${body}` : `/${body}`
}

export type ConnectionRecord = { sessionId: string; projectKey: string; connectedAt: string }

// A record this reads, or null for anything else (a file that is not one, another schema version): skipped, as the MCP skips it.
export function asRecord(parsed: unknown): ConnectionRecord | null {
  const r = parsed as any
  if (r === null || typeof r !== 'object' || r.schemaVersion !== CONNECTION_SCHEMA_VERSION) return null
  if (typeof r.sessionId !== 'string' || r.sessionId === '' || typeof r.projectKey !== 'string' || typeof r.connectedAt !== 'string') return null
  return { sessionId: r.sessionId, projectKey: r.projectKey, connectedAt: r.connectedAt }
}

// The earlier sessions of `cwd`'s project, newest connection first, at most MAX_CANDIDATES.
export function predecessors(records: ConnectionRecord[], cwd: string, selfId: string, now: number): string[] {
  const key = projectKeyOf(cwd)
  return records
    .filter(r => r.projectKey === key && r.sessionId !== selfId)
    .map(r => ({ id: r.sessionId, at: Date.parse(r.connectedAt) }))
    .filter(r => Number.isFinite(r.at) && now - r.at <= STALE_RECORD_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_CANDIDATES)
    .map(r => r.id)
}
