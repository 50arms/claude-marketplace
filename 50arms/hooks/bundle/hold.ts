// An agent context (the main conversation, or a sub-agent by its id) that has no current bundle is held: its tool calls are refused, first with the
// loading line while the plugin keeps asking (a deploy restart takes about 35 s), then, once the retry window passes, with the hold line of the
// reason. The hold ends only on a successful fetch. Pure: register.tsx reads the answers and applies the verdicts.

import type { FloorReason, HoldReason } from './floor'
import type { Hold, Holds, Retell } from '../../types'

export type { Hold, Holds, Retell }
import { RECONNECT_TOOL, floorText } from './floor'
import { SERVER } from '../plan/config'
import { STALE_MCP_LINE } from '../relay/refusal'

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
  // CP-169: the running MCP server refused a key the plugin sends (`isStaleMcpRefusal`), so it is older than the plugin
  staleMcp: boolean
  // the plugin holds a bundle and the relay cannot tell it when that bundle changes (`why`: the session file's failure, when it was one): the check for a change is this fetch, and it failed
  relayDown: { why: string | null } | null
}

export type Failure = { reason: HoldReason; detail: string; values: Record<string, string> }

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const said = (f: FetchFailure): string => oneLine(String(f.body?.message ?? f.body?.error ?? 'no detail'), 160)

// The relay's change signal is gone and the fetch that stands in for it failed too: the one reason a held bundle can no longer be confirmed. `cause` is what the fetch itself met.
const relayBroken = (relayDown: { why: string | null }, cause: string): Failure => ({
  reason: 'relay_broken',
  detail: `the relay is down${relayDown.why === null ? '' : ` (${relayDown.why})`} and the check for a change failed: ${cause}`,
  values: {},
})

// The fetch did not answer within the time a hook may wait for it.
export const timeoutFailure = (relayDown: { why: string | null } | null): Failure => {
  const cause = 'the bundle fetch had not answered within the hook deadline'
  return relayDown === null ? { reason: 'fetch_failed', detail: cause, values: {} } : relayBroken(relayDown, cause)
}

// Why the bundle could not be fetched: one reason, with a few words of detail and the values its hold line names. A value the plugin does not know is left out, so the line names it unknown (`floorText`), never a guess. A signed-out session is no failure (the caller never asks).
// `what` names the fetch that failed in the hold line (the bundle's by default).
export function failureOf(f: FetchFailure, what = 'bundle fetch'): Failure {
  if (f.keyRevoked) return { reason: 'key_revoked', detail: 'the session key was revoked', values: {} }
  if (f.classifierRefused) return { reason: 'classifier_refused', detail: 'the auto mode classifier refused the plugin call', values: {} }
  if (f.staleMcp) return { reason: 'stale_mcp', detail: STALE_MCP_LINE, values: {} }
  if (f.status === 503 && f.body?.error === 'dashboard_unreachable') {
    const detail = `the 50 Arms dashboard is unreachable (${oneLine(String(f.body.detail ?? 'no detail'), 80)})`
    return { reason: 'dashboard_unreachable', detail, values: typeof f.body.unreachable_since === 'string' ? { unreachable_since: f.body.unreachable_since } : {} }
  }
  // a plugin below the bundle's floor: the refusal names the version to update to
  if (f.status === 426) {
    const need = typeof f.body?.plugin?.need === 'string' ? f.body.plugin.need : null
    return { reason: 'plugin_outdated', detail: need === null ? 'the plugin is below the bundle floor' : `the plugin is below the bundle floor ${need}`, values: need === null ? {} : { need_version: need } }
  }
  const cause = f.serverNotConnected ? 'the 50 Arms dashboard server is not connected' : f.status > 0 ? `the ${what} answered ${f.status}: ${said(f)}` : `the ${what} failed: ${said(f)}`
  if (f.relayDown !== null) return relayBroken(f.relayDown, cause)
  return f.serverNotConnected ? { reason: 'dashboard_unreachable', detail: cause, values: {} } : { reason: 'fetch_failed', detail: cause, values: {} }
}



export const NO_HOLDS: Holds = {}

// A failure for a context: a new hold, or the same hold refreshed with the newest reason (the time it began stays the first failure's). `undelivered`: the failure is a text that could not be delivered, which a hold keeps once it has it.
export function holdOn(holds: Holds, key: string, failure: Failure, event: string, now: number, undelivered = false, retell: Retell | null = null): Holds {
  const held = holds[key]
  const since = held?.since ?? now
  const startedAt = held?.startedAt ?? new Date(now).toISOString()
  const keep = undelivered || held?.undelivered === true ? ({ undelivered: true } as const) : {}
  const retells = retell === null ? (held?.retell ?? []) : addRetell(held?.retell ?? [], retell)
  return { ...holds, [key]: { reason: failure.reason, detail: failure.detail, values: failure.values, since, startedAt, event: held?.event ?? event, reported: held?.reported ?? 'none', ...keep, ...(retells.length === 0 ? {} : { retell: retells }) } }
}

const sameRetell = (a: Retell, b: Retell): boolean => a.event === b.event && JSON.stringify(a.matchers) === JSON.stringify(b.matchers)

// the events to tell again: one per (event, matchers), the newest moment's slots
export const addRetell = (list: readonly Retell[], add: Retell): Retell[] => [...list.filter(r => !sameRetell(r, add)), add]

// the list without the event told now (a text of the same event and matchers told since supersedes the failed one)
export const dropRetell = (list: readonly Retell[], event: string, matchers: Record<string, string>): Retell[] => list.filter(r => !sameRetell(r, { event, matchers, extra: {}, mechanisms: null }))

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

// What a context reads, ahead of the texts it was owed, as the refusal of its next tool call once its bundle arrived.
export const OWED_ARRIVED = '[50 ARMS] Your instructions from 50 Arms have arrived. This tool call was not run: read them, then retry this same step.'

// CP-169: besides `session_connect` (onToolStamp), a context whose hold is a stale MCP may run the one call that re-dials the plugin's platform server, which clears the hold (EV-205). `server` is the argument the call names: a call naming any other server is refused.
export const reconnectsStaleMcp = (hold: Hold, tool: string, server: unknown): boolean => hold.reason === 'stale_mcp' && tool === RECONNECT_TOOL && server === SERVER

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
