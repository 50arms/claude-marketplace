import type { SettingsRead, TeamSettings } from '../../types'
import { isSignedOut, outcomeRevokedBy } from './mcp'
import type { Call } from './pacing-line'

// DX-4339 (PLAN-29): the team's pacing settings, read from GET /api/team/pacing. Wire parse and the one read; the model is pacing-panel.ts.

export const SETTINGS_PATH = '/api/team/pacing'
const MODES = ['fast_then_hold', 'spread_evenly']
const ERROR_MAX = 200

function parseLimit(raw: any) {
  if (raw === null || typeof raw !== 'object') return null
  if (typeof raw.enabled !== 'boolean' || !MODES.includes(raw.mode)) return null
  if (!Number.isInteger(raw.target_percent) || !Number.isInteger(raw.critical_percent)) return null
  return { enabled: raw.enabled, targetPercent: raw.target_percent, mode: raw.mode, criticalPercent: raw.critical_percent }
}

// `body` of GET /api/team/pacing (danxbot's wire names, src/team-pacing/settings.ts): the settings, or an error text for anything else.
export function parseTeamPacing(body: any): TeamSettings | { error: string } {
  const five = parseLimit(body?.five_hour)
  const weekly = parseLimit(body?.weekly)
  if (five === null || weekly === null) return { error: 'the team pacing answer has no readable five_hour and weekly settings' }
  return { five_hour: five, weekly }
}

export type SettingsOutcome = { settings: TeamSettings } | { read: Exclude<SettingsRead, { state: 'pending' | 'ok' }> }

// One read. No danx-dashboard MCP server, no key (signed out, revoked) or no danxbot is `silent`: a session with no danxbot says nothing about
// it (DX-3421, DX-4340). Anything else (a 500, a 403, an answer of the wrong shape) is a named `error` for the pane.
export async function readTeamSettings(call: Call): Promise<SettingsOutcome> {
  let r
  try {
    r = await call('GET', SETTINGS_PATH)
  } catch (err: any) {
    return { read: { state: 'error', message: String(err?.message ?? err).slice(0, ERROR_MAX) } }
  }
  if (r.unreachable || isSignedOut(r) || outcomeRevokedBy(r) !== null) return { read: { state: 'silent' } }
  if (!r.ok) return { read: { state: 'error', message: `the team pacing read answered ${r.status || String(r.body?.error ?? 'with an error').slice(0, ERROR_MAX)}` } }
  const parsed = parseTeamPacing(r.body)
  return 'error' in parsed ? { read: { state: 'error', message: parsed.error } } : { settings: parsed }
}
