import { foregroundLockNotice } from '../context/foreground'
import { diskFaultLine, floorsUnavailableLine } from '../context/disk'
import { delayedLine, refusedLine, stalledLine, stoppedLine } from '../relay/text'
import { permissionExpiredNote, revokeNote, signInApprovedNote, signInDeniedNote, signInExpiredNote, signInNote } from '../plan/notes'
import { failureLine } from './reports'
import type { FloorReason, HoldReason } from '../../types'

export type { FloorReason, HoldReason }

// The floor: the few texts the plugin ships for the moments no bundle can exist. Everything else an agent is told at a hook moment comes from the
// bundle. The plugin is the floor's one home: it reports the set to 50 Arms (so the app can list it read-only) and never reads one back.
// Pure: each value a line carries (a reason, a date, a version) is a `{{slot:name}}` placeholder filled at run time, never one session's value baked in.



// What a person who is not signed in is told at a startup, in place of every 50 Arms text: 50 Arms cannot be asked before the sign-in.
export const SIGN_IN_INVITATION =
  "50 Arms is installed in this session. When the person wants to plan or build something, you may mention once that 50 Arms can track it as a plan with cards, and that the Sign in button on the 50 Arms band connects this session. Don't push it, and continue normally if they don't sign in."

// While the bundle is being fetched again (a deploy restart takes about 35 s), the agent is told this once; its tool calls run (dan, 2026-11-28: a failed fetch never holds a tool call).
export const LOADING_LINE =
  '[50 ARMS] Your instructions from 50 Arms are loading: they could not be delivered yet ({{slot:reason}}). Keep working: nothing is held, and they arrive with a later tool result.'

const HELD_OPENING =
  '[50 ARMS] CRITICAL: 50 Arms could not deliver this agent its instructions ({{slot:reason}}), and has tried since {{slot:since}}. This is a critical 50 Arms bug. Tell the person now, naming the reason and the time, then keep working without them: no tool call is held, and the plugin keeps fetching them.'

// The hold line of each reason: the opening, then what is specific to it.
export const HOLD_LINES: Record<HoldReason, string> = {
  dashboard_unreachable: `${HELD_OPENING} The 50 Arms dashboard has been unreachable since {{slot:unreachable_since}}.`,
  fetch_failed: `${HELD_OPENING} The fetch of the instructions failed or was refused.`,
  plugin_outdated: `${HELD_OPENING} The 50 Arms plugin is too old to read them: it must be updated to version {{slot:need_version}} or later (tell the person to update it, then start a new session).`,
  key_revoked: `${HELD_OPENING} This session's 50 Arms key was revoked: the person must sign in again.`,
  relay_broken: `${HELD_OPENING} The relay that tells this session when its instructions change is broken and the check for a change also failed: tell the person to reconnect the 50 Arms dashboard server (/mcp) or start a new session.`,
  // the running MCP server is older than the plugin and refused a key the fetch sends. Nothing the session can run fixes it (the desktop app's connector reconnect re-dials
  // only a failed server, and a stale one still answers), so the fix is the person's: revert the plugin release, or restart the session, which starts the newest server.
  stale_mcp: `${HELD_OPENING} The fix: revert the plugin release, or restart the session.`,
  classifier_refused: `${HELD_OPENING} The permission classifier refused the plugin's own call to 50 Arms: tell the person to allow the plugin's server in their permissions.`,
}

// The plugin events a line that has no event of its own is told on: every moment an agent context is started or a tool call's result carries the notice, and the prompt that tells a held main conversation. A hook that tells any
// other event never passes a hold line through (`textsOf`), so this list is the only source of the moments a loading or hold line is told on.
export const TOLD_ON = ['session.start', 'session.resume', 'session.after_compaction', 'session.after_clear', 'subagent.start', 'subagent.compacted', 'tool.before', 'prompt.submit'] as const

// The catalog events that name a reason of their own; the line is told under that event.
const OWN_EVENT: Partial<Record<FloorReason, string>> = {
  signed_out: 'signed_out',
  dashboard_unreachable: 'dashboard.unreachable',
  relay_broken: 'relay.broken',
  key_revoked: 'key.revoked',
}

const TEXTS: Record<FloorReason, string> = { signed_out: SIGN_IN_INVITATION, loading: LOADING_LINE, ...HOLD_LINES }

const REASONS = Object.keys(TEXTS) as FloorReason[]

// The other texts the plugin must be able to say when the server cannot be reached or the session is not signed in. Each is the plugin's own function, called with a
// `{{slot:name}}` placeholder where the session's value goes, so the set carries the very words the plugin tells and never a copy. Two kinds: what to do when the session is not connected to 50 Arms
// (the relay failure lines, the revoked-key note, the sign-in notes, the expired permission request) and how to report an error to the person (the failed report, the foreground-lock notice, the disk
// check's fault lines). Told under the catalog event nearest to when each is told.
const slot = (name: string): string => `{{slot:${name}}}`

export type NoticeReason =
  | 'relay_stopped' | 'relay_refused' | 'relay_delayed' | 'relay_stalled'
  | 'revoke_note' | 'revoke_note_failed'
  | 'sign_in_note_no_target' | 'sign_in_note_refused' | 'sign_in_note_connected' | 'sign_in_approved' | 'sign_in_approved_no_target' | 'sign_in_denied' | 'sign_in_expired'
  | 'permission_expired'
  | 'report_failed' | 'foreground_lock' | 'disk_check_failed' | 'disk_floors_unavailable'

const NOTICES: { reason: NoticeReason; event: string; text: string }[] = [
  { reason: 'relay_stopped', event: 'relay.broken', text: stoppedLine(slot('detail'), slot('fix')) },
  { reason: 'relay_refused', event: 'relay.broken', text: refusedLine(slot('detail'), slot('fix')) },
  { reason: 'relay_delayed', event: 'relay.broken', text: delayedLine(slot('message')) },
  { reason: 'relay_stalled', event: 'relay.broken', text: stalledLine(slot('seconds')) },
  { reason: 'revoke_note', event: 'key.revoked', text: revokeNote({ ended: true }) },
  { reason: 'revoke_note_failed', event: 'key.revoked', text: revokeNote({ ended: false }) },
  { reason: 'sign_in_note_no_target', event: 'signed_out', text: signInNote(null, true) },
  { reason: 'sign_in_note_refused', event: 'signed_out', text: signInNote(slot('target'), false) },
  { reason: 'sign_in_note_connected', event: 'signed_out', text: signInNote(slot('target'), true) },
  { reason: 'sign_in_approved', event: 'signed_out', text: signInApprovedNote(slot('code'), slot('target')) },
  { reason: 'sign_in_approved_no_target', event: 'signed_out', text: signInApprovedNote(slot('code'), null) },
  { reason: 'sign_in_denied', event: 'signed_out', text: signInDeniedNote(slot('code')) },
  { reason: 'sign_in_expired', event: 'signed_out', text: signInExpiredNote(slot('code')) },
  { reason: 'permission_expired', event: 'key.revoked', text: permissionExpiredNote({ code: slot('code'), permissions: [slot('permissions')] }) },
  { reason: 'report_failed', event: 'dashboard.unreachable', text: failureLine(slot('reason')) },
  { reason: 'foreground_lock', event: 'session.start', text: foregroundLockNotice(slot('reason')) },
  { reason: 'disk_check_failed', event: 'session.start', text: diskFaultLine(new Error(slot('detail'))) },
  { reason: 'disk_floors_unavailable', event: 'session.start', text: floorsUnavailableLine(slot('floors_path')) },
]

export type FloorLine = { reason: FloorReason | NoticeReason; event: string; text: string }

// The whole set, one line per (reason, event): a reason with an event of its own under it, any other under each moment it is told on. Sent as PUT /api/plan-sessions/me/plugin-floor.
export function floorLines(): FloorLine[] {
  const held = REASONS.flatMap(reason => {
    const own = OWN_EVENT[reason]
    const events: readonly string[] = own === undefined ? TOLD_ON : [own]
    return events.map(event => ({ reason, event, text: TEXTS[reason] }))
  })
  return [...held, ...NOTICES]
}

export const floorBody = (pluginVersion: string) => ({ plugin_version: pluginVersion, lines: floorLines() })

export type FloorValues = Record<string, string>

// A floor line as the agent reads it: the placeholders filled with this session's values. A value the caller did not give is named, never left blank.
export function floorText(reason: FloorReason, values: FloorValues): string {
  return TEXTS[reason].replace(/\{\{slot:([a-z_][a-z0-9_]*)\}\}/g, (_all, name: string) => values[name] ?? `[${name} unknown]`)
}
