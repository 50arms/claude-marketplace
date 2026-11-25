// An agent context (the main conversation, or a sub-agent by its id) that has no current bundle is held: its tool calls are refused, first with the
// loading line while the plugin keeps asking (a deploy restart takes about 35 s), then, once the retry window passes, with the hold line of the
// reason. The hold ends only on a successful fetch. Pure: register.tsx reads the answers and applies the verdicts.

import type { FloorReason, HoldReason } from './floor'
import { floorText } from './floor'

// How long the plugin keeps asking after the first failure before the loading line becomes the hold line.
export const RETRY_WINDOW_MS = 120_000

// What a fetch's failure looks like to the plugin, already read from the call's answer (the engine's rejection text, the envelope's status and body).
export type FetchFailure = {
  status: number
  body: any
  // the engine's "no such server": the plugin's own server is not connected
  serverNotConnected: boolean
  // the auto mode classifier refused the plugin's own call
  classifierRefused: boolean
  // the MCP's halt for a key a person revoked
  keyRevoked: boolean
}

export type Failure = { reason: HoldReason; detail: string; values: Record<string, string> }

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const said = (f: FetchFailure): string => oneLine(String(f.body?.message ?? f.body?.error ?? 'no detail'), 160)

// Why the bundle could not be fetched: one reason, with a few words of detail and the values its hold line names. A signed-out session is no failure (the caller never asks).
export function failureOf(f: FetchFailure): Failure {
  if (f.keyRevoked) return { reason: 'key_revoked', detail: 'the session key was revoked', values: {} }
  if (f.classifierRefused) return { reason: 'classifier_refused', detail: 'the auto mode classifier refused the plugin call', values: {} }
  if (f.serverNotConnected) return { reason: 'dashboard_unreachable', detail: 'the 50 Arms dashboard server is not connected', values: { unreachable_since: 'the start of this session' } }
  if (f.status === 503 && f.body?.error === 'dashboard_unreachable') {
    const since = typeof f.body.unreachable_since === 'string' ? f.body.unreachable_since : 'a time it did not name'
    return { reason: 'dashboard_unreachable', detail: `the 50 Arms dashboard is unreachable (${oneLine(String(f.body.detail ?? 'no detail'), 80)})`, values: { unreachable_since: since } }
  }
  // a plugin below the bundle's floor: the refusal names the version to update to
  if (f.status === 426) {
    const need = typeof f.body?.plugin?.need === 'string' ? f.body.plugin.need : null
    return { reason: 'plugin_outdated', detail: need === null ? 'the plugin is below the bundle floor' : `the plugin is below the bundle floor ${need}`, values: { need_version: need ?? 'the latest' } }
  }
  return { reason: 'fetch_failed', detail: f.status > 0 ? `the bundle fetch answered ${f.status}: ${said(f)}` : `the bundle fetch failed: ${said(f)}`, values: {} }
}

// A hold: since when (epoch ms, the first failure of this context's run of failures), why, and what its report needs.
export type Hold = {
  reason: HoldReason
  detail: string
  values: Record<string, string>
  since: number
  startedAt: string
  // the plugin event the hold began on
  event: string
  // where the report of this hold stands: not sent, sent still running, or sent with its end
  reported: 'none' | 'open' | 'ended'
}

export type Holds = Record<string, Hold>

export const NO_HOLDS: Holds = {}

// A failure for a context: a new hold, or the same hold refreshed with the newest reason (the time it began stays the first failure's).
export function holdOn(holds: Holds, key: string, failure: Failure, event: string, now: number): Holds {
  const held = holds[key]
  const since = held?.since ?? now
  const startedAt = held?.startedAt ?? new Date(now).toISOString()
  return { ...holds, [key]: { reason: failure.reason, detail: failure.detail, values: failure.values, since, startedAt, event: held?.event ?? event, reported: held?.reported ?? 'none' } }
}

export function release(holds: Holds, key: string): { holds: Holds; ended: Hold | null } {
  const held = holds[key]
  if (held === undefined) return { holds, ended: null }
  const { [key]: _gone, ...rest } = holds
  return { holds: rest, ended: held }
}

export type Phase = 'loading' | 'held'
export const phaseOf = (hold: Hold, now: number): Phase => (now - hold.since < RETRY_WINDOW_MS ? 'loading' : 'held')

// What a refused tool call is told: the loading line during the retry window, then the hold line of the reason.
export function refusalOf(hold: Hold, now: number): string {
  const since = hold.startedAt
  if (phaseOf(hold, now) === 'loading') return floorText('loading', { reason: hold.detail })
  return floorText(hold.reason as FloorReason, { reason: hold.detail, since, ...hold.values })
}

// The one tool a held context may still call: it lets the person sign in again.
export const ALLOWED_WHILE_HELD = 'session_connect'

// The report of a hold: `agent_id` is null for the main conversation. With `endedAt` once the hold has ended.
export function holdReport(hold: Hold, agentId: string | null, pluginVersion: string, endedAt: string | null): Record<string, unknown> {
  const item: Record<string, unknown> = { kind: 'hold', reason: hold.reason, event: hold.event, agent_id: agentId, plugin_version: pluginVersion, started_at: hold.startedAt }
  if (endedAt !== null) item.ended_at = endedAt
  return item
}

// What a hold's report needs next: nothing before the hold line starts; once it has, the open report (50 Arms answers: a 426 or a revoked key hold stay on, so the open report is sent first), and the end once the hold is released.
export type ReportStep = 'none' | 'open' | 'ended'
export function reportStepOf(hold: Hold, phase: Phase, ended: boolean): ReportStep {
  if (ended) return hold.reported === 'ended' || (hold.reported === 'none' && phase !== 'held') ? 'none' : 'ended'
  if (phase === 'held' && hold.reported === 'none') return 'open'
  return 'none'
}

// A held main conversation gives back a queued job at once, and leaves the ready list once the hold line starts.
export const leavesQueue = (hold: Hold | undefined): boolean => hold !== undefined
export const leavesReadyList = (hold: Hold | undefined, now: number): boolean => hold !== undefined && phaseOf(hold, now) === 'held'
