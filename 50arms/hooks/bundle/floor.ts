// The floor: the few texts the plugin ships for the moments no bundle can exist. Everything else an agent is told at a hook moment comes from the
// bundle. The plugin is the floor's one home: it reports the set to 50 Arms (so the app can list it read-only) and never reads one back.
// Pure: each value a line carries (a reason, a date, a version) is a `{{slot:name}}` placeholder filled at run time, never one session's value baked in.

export type FloorReason = 'signed_out' | 'loading' | 'dashboard_unreachable' | 'fetch_failed' | 'plugin_outdated' | 'key_revoked' | 'relay_broken' | 'classifier_refused'

// Why an agent context has no current bundle (a hold's reason): every floor reason but signed out, which holds nothing, and loading, which is the first phase of every hold.
export type HoldReason = Exclude<FloorReason, 'signed_out' | 'loading'>

// What a person who is not signed in is told at a startup, in place of every 50 Arms text: 50 Arms cannot be asked before the sign-in.
export const SIGN_IN_INVITATION =
  "50 Arms is installed in this session. When the person wants to plan or build something, you may mention once that 50 Arms can track it as a plan with cards, and that the Sign in button on the 50 Arms band connects this session. Don't push it, and continue normally if they don't sign in."

// While the bundle is being fetched again (a deploy restart takes about 35 s), the agent's tool calls are refused with this: the instructions are loading, retry the same step.
export const LOADING_LINE =
  '[50 ARMS] Your instructions from 50 Arms are loading: they could not be delivered yet ({{slot:reason}}). This tool call was not run. Retry this same step shortly, and run nothing else meanwhile.'

const HELD_OPENING =
  '[50 ARMS] CRITICAL: 50 Arms could not deliver this agent its instructions ({{slot:reason}}), and has tried since {{slot:since}}. This is a critical 50 Arms bug. Tell the person now that this agent is held, name the reason and the time, and wait: run no tool until the person says it is fixed.'

// The hold line of each reason: the opening, then what is specific to it.
export const HOLD_LINES: Record<HoldReason, string> = {
  dashboard_unreachable: `${HELD_OPENING} The 50 Arms dashboard has been unreachable since {{slot:unreachable_since}}.`,
  fetch_failed: `${HELD_OPENING} The fetch of the instructions failed or was refused.`,
  plugin_outdated: `${HELD_OPENING} The 50 Arms plugin is too old to read them: it must be updated to version {{slot:need_version}} or later (tell the person to update it, then start a new session).`,
  key_revoked: `${HELD_OPENING} This session's 50 Arms key was revoked: the person must sign in again.`,
  relay_broken: `${HELD_OPENING} The relay that tells this session when its instructions change is broken and the check for a change also failed: tell the person to reconnect the 50 Arms dashboard server (/mcp) or start a new session.`,
  classifier_refused: `${HELD_OPENING} The permission classifier refused the plugin's own call to 50 Arms: tell the person to allow the plugin's server in their permissions.`,
}

// The plugin events a line that has no event of its own is told on: every moment an agent context is started or its tool calls are refused.
export const TOLD_ON = ['session.start', 'session.resume', 'session.after_compaction', 'session.after_clear', 'subagent.start', 'subagent.compacted', 'tool.before'] as const

// The catalog events that name a reason of their own; the line is told under that event.
const OWN_EVENT: Partial<Record<FloorReason, string>> = {
  signed_out: 'signed_out',
  dashboard_unreachable: 'dashboard.unreachable',
  relay_broken: 'relay.broken',
  key_revoked: 'key.revoked',
}

const TEXTS: Record<FloorReason, string> = { signed_out: SIGN_IN_INVITATION, loading: LOADING_LINE, ...HOLD_LINES }

const REASONS = Object.keys(TEXTS) as FloorReason[]

export type FloorLine = { reason: FloorReason; event: string; text: string }

// The whole set, one line per (reason, event): a reason with an event of its own under it, any other under each moment it is told on. Sent as PUT /api/plan-sessions/me/plugin-floor.
export function floorLines(): FloorLine[] {
  return REASONS.flatMap(reason => {
    const own = OWN_EVENT[reason]
    const events: readonly string[] = own === undefined ? TOLD_ON : [own]
    return events.map(event => ({ reason, event, text: TEXTS[reason] }))
  })
}

export const floorBody = (pluginVersion: string) => ({ plugin_version: pluginVersion, lines: floorLines() })

export type FloorValues = Record<string, string>

// A floor line as the agent reads it: the placeholders filled with this session's values. A value the caller did not give is named, never left blank.
export function floorText(reason: FloorReason, values: FloorValues): string {
  return TEXTS[reason].replace(/\{\{slot:([a-z_][a-z0-9_]*)\}\}/g, (_all, name: string) => values[name] ?? `[${name} unknown]`)
}
