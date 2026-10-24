import type { PlanView, RelayState, StatusBreakdown } from '../../types'
import { BAND_CONTROL_CHROME_COLS, BAND_GAP_COLS, BAND_INDICATOR_COLS, BAND_NAME_MIN_COLS, BAND_SPARE_COLS, BRAND, DANGER, NO_AGENT_LABEL, PROBLEM_GLYPH, SUCCESS, WARNING, SIGNED_OUT_LABEL, KEY_REVOKED_FOOTER, NO_EVENT_STATUS, BLOCKED_LABEL, keyRevokedLabel } from './config'

// the band badge's label: a warning glyph and the number of plan cards waiting on a person, the same number the plan's Needs You tab
// shows (cards, not problems), '' for none (the badge is then not drawn). It is a link, not label text: see band.tsx.
export function needsYouBadge(v: PlanView): string {
  const n = v.needsYou
  return n === null || n === 0 ? '' : `${PROBLEM_GLYPH} ${n}`
}

// the session title's lead while the band shows a Needs You count, so a session waiting on its person stands out in the session list; the
// emoji variation selector (U+FE0F) asks every surface for the emoji form of the hand, never its text form.
export const NEEDS_YOU_TITLE_MARK = '✋️ '
// whether the session reaches its plan or card: green while it does, red once it has lost it (titleConnection); one mark at most (sessionTitle)
export const CONNECTED_TITLE_MARK = '🟢 '
export const DISCONNECTED_TITLE_MARK = '🔴 '
// the session's agent has paused itself (PUT /api/plan-sessions/me/pause) and the dashboard holds its messages; the selector asks for the emoji form
export const PAUSED_TITLE_MARK = '⏸️ '
// every mark as any title may hold it, the selector or not, repeated or not, in any order (two plugin versions marking one title in turn stacked two)
const ANY_TITLE_MARK = /^(?:(?:✋️?|⏸️?|🟢|🔴)\s*)+/u

// the title without any leading mark: what the plugin keeps and hands to plan_connect, since the marks are display only
export function unmarkedTitle(title: string): string {
  return title.replace(ANY_TITLE_MARK, '')
}

// the relay stopped for the plan the session is on (a relay left over from another plan says nothing about this one)
function relayStoppedFor(v: PlanView, relay: RelayState): boolean {
  return v.connected !== null && relay.phase === 'stopped' && relay.planId === v.connected.id
}

// what the connection mark says. `up`: the session holds a plan or card, has its team agent, its last load answered and (on a plan)
// its events relay has not stopped. `down`: a session that was signed in or on a plan or card lost it (a failed or refused load, a revoked
// or lapsed key, no team agent, a stopped relay). null: a session that never connected, or one signed in on nothing, carries no mark.
export function titleConnection(v: PlanView, relay: RelayState): 'up' | 'down' | null {
  if (v.phase === 'key-revoked') return 'down'
  const wasOn = v.connected !== null || v.card !== null || v.resumePlan !== null || v.agent !== null
  if (v.phase === 'error' || v.phase === 'blocked' || v.phase === 'signed-out') return wasOn ? 'down' : null
  if (v.agentBlock !== null) return 'down'
  if (v.connected === null && v.card === null) return null
  if (relayStoppedFor(v, relay)) return 'down'
  return v.agent !== null ? 'up' : 'down'
}

// the session title with ONE mark at most (operator, 2026-10-24): red when the connection is lost (titleConnection), else the hand exactly
// when the band draws its Needs You badge (the same count, hidden on a failed load), else the pause mark while the agent is in an unexpired
// pause (`pausedUntil`, which the load already left null for an expired one), else green when connected, else none. `title` is the
// title as the app holds it, marks included or not; '' stays ''. While the view is still loading nothing is known yet, so the title is left as it is.
export function sessionTitle(title: string, v: PlanView, relay: RelayState): string {
  if (v.phase === 'loading') return title
  const base = unmarkedTitle(title)
  if (base === '') return base
  const connection = titleConnection(v, relay)
  if (connection === 'down') return `${DISCONNECTED_TITLE_MARK}${base}`
  if (v.phase !== 'error' && v.phase !== 'blocked' && needsYouBadge(v) !== '') return `${NEEDS_YOU_TITLE_MARK}${base}`
  if (connection === 'up' && v.pausedUntil !== null) return `${PAUSED_TITLE_MARK}${base}`
  return connection === 'up' ? `${CONNECTED_TITLE_MARK}${base}` : base
}

// `text` cut to `max` characters, the last one an ellipsis, so a cut name never reads as a whole one.
export function ellipsize(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const NAME_SEP = ' · '
// a signed-in session that holds neither a plan nor a card
// what the band says of each agent-gate state: at a cap the member's or team's sessions signed in as an agent are full (agent_limit_reached), which is not the same as no agent being free
const AGENT_BLOCK_LABEL: Record<NonNullable<PlanView['agentBlock']>, string> = {
  agent_needed: 'waiting for a team agent',
  agent_limit_reached: 'agent session limit reached',
  agent_not_held: 'no team agent held (plan_connect claims one)',
}
const NOTHING_HELD = 'not connected to a plan or card'

// the columns the band's label may take: its width less the indicator and each control. A Button draws `[ label ]`
// chrome on the terminal; a Markdown link none. The terminal's widths are the model (UNVERIFIED on the desktop's native buttons and 16px donut): the spare columns
// are the margin, and the label's own `truncate-end` is the second line of defence.
export function bandLabelCols(columns: number, controls: readonly { label: string; isButton: boolean }[]): number {
  const controlCols = controls.reduce((n, c) => n + c.label.length + (c.isButton ? BAND_CONTROL_CHROME_COLS : 0) + BAND_GAP_COLS, 0)
  // the row's gaps: one per control, one after the indicator, one after the label's spacer
  return columns - BAND_INDICATOR_COLS - 2 * BAND_GAP_COLS - controlCols - BAND_SPARE_COLS
}

export type BandParts = { ref: string; name: string }

// A held plan or card's band label as parts: the plan's `PLAN-NN` (or the card's id) that is the link, and the name or title after it.
// No agent name leads it: the footer names the agent. Null where nothing is held. `maxCols`: the columns the label may take (absent: no
// limit, the layout truncates); the name is cut to what `PLAN-NN · ` leaves, with an ellipsis.
function heldParts(v: PlanView, maxCols?: number): BandParts | null {
  const held = v.connected !== null ? { ref: v.connected.ref, name: v.connected.name } : v.card !== null ? { ref: v.card.id, name: v.card.title } : null
  if (held === null) return null
  const { ref, name } = held
  const sepCols = ref ? NAME_SEP.length : 0
  const nameCols = maxCols === undefined ? name.length : Math.max(BAND_NAME_MIN_COLS, maxCols - ref.length - sepCols)
  return { ref, name: ellipsize(name, nameCols) }
}

// the band's whole label for a state that names no plan or card, else null (then the label is the held plan's or card's parts).
function bandState(v: PlanView): string | null {
  // a session with no key reads signed out, in the operator's words, whatever it was connected to before.
  if (v.phase === 'signed-out') return SIGNED_OUT_LABEL
  // a revoked key names who revoked it.
  if (v.phase === 'key-revoked') return keyRevokedLabel(v.revokedBy as string) // always set with the phase
  // auto mode blocks the plugin's own calls: never Disconnected. The plan the model connected is named when known; the band's second line says the fix.
  if (v.phase === 'blocked' && !v.connected) return BLOCKED_LABEL
  // the operator's wording for ANY failed load, even one that kept the connected plan.
  if (v.phase === 'error') return `${BRAND}: Disconnected`
  if (v.phase === 'loading' && !v.refreshedAt) return `${BRAND}: loading…`
  // a signed-in session the agent gate holds: no plan or card can be read until it holds a team agent
  if (v.agentBlock !== null) return `${BRAND}: ${AGENT_BLOCK_LABEL[v.agentBlock]}`
  if (v.connected === null && v.card === null) return v.agent === null ? `${BRAND}: ${NOTHING_HELD}` : `${BRAND}${NAME_SEP}${v.agent.name}: ${NOTHING_HELD}`
  return null
}

// The band's label, composed once for both the band and bandLabel: either the held plan's or card's parts, or the state's whole words.
// A state names no plan or card, so the two cases are told apart by type, never by a cast.
export function bandContent(v: PlanView, maxCols?: number): { parts: BandParts } | { state: string } {
  const state = bandState(v)
  if (state !== null) return { state }
  const parts = heldParts(v, maxCols)
  // bandState is null only where a plan or card is held
  if (parts === null) throw new Error('bandContent: no state label and nothing held')
  return { parts }
}

// the text after the id: ` · name` after an id, else the bare name, '' for no name
export function bandNameText(parts: BandParts): string {
  if (parts.name === '') return ''
  return parts.ref === '' ? parts.name : `${NAME_SEP}${parts.name}`
}

// The band's label as one string (the held plan's or card's parts joined, or the state's words).
export function bandLabel(v: PlanView, maxCols?: number): string {
  const c = bandContent(v, maxCols)
  return 'state' in c ? c.state : `${c.parts.ref}${bandNameText(c.parts)}`
}

// Percent complete, as the dashboard's plan header computes it. Mirrors the formula the dashboard's plan page uses:
// total = In Progress + ToDo + Backlog + Review + Done (Cancelled is NOT counted);
// percent = total > 0 ? Math.round(Done / total * 100) : 0. The two must never disagree.
export function planPercent(b: StatusBreakdown): number {
  const total = b['In Progress'] + b.ToDo + b.Backlog + b.Review + b.Done
  return total > 0 ? Math.round((b.Done / total) * 100) : 0
}

// The text donut for a percent: ○ 0, ◔ 1-37, ◑ 38-62, ◕ 63-99, ● 100.
export function donutGlyph(percent: number): string {
  if (percent <= 0) return '○'
  if (percent <= 37) return '◔'
  if (percent <= 62) return '◑'
  if (percent < 100) return '◕'
  return '●'
}

// A connected, LOADED view's percent; null otherwise. An error view keeps the last plan's fields, so only a
// ready view may draw a figure: nothing derived from loaded data shows under an error.
export function viewPercent(v: PlanView): number | null {
  return v.phase === 'ready' && v.connected && v.statusBreakdown ? planPercent(v.statusBreakdown) : null
}

// the footer indicator's text, read from `view.connected` and the team agent the session holds (`view.agent`, from the server):
// `<agent name> · PLAN-NN`, the agent's name alone on no plan, and `50 Arms disconnected` with no agent session. Null where the footer
// shows nothing (loading with no plan shown yet; a connect shows its plan at once). The signed-out, revoked and blocked states keep
// their own words. The plan flips off when a plan-list load fails: that error view carries no connected plan (the session is read from
// the same failed answer), so the footer cannot name one. An error built after the plan was read keeps it.
export function footerLabel(v: PlanView): string | null {
  if (v.phase === 'loading' && !(v.connected && v.refreshedAt)) return null
  if (v.phase === 'signed-out') return SIGNED_OUT_LABEL
  if (v.phase === 'key-revoked') return KEY_REVOKED_FOOTER
  if (v.phase === 'blocked' && !v.connected) return BLOCKED_LABEL
  if (v.agent === null) return NO_AGENT_LABEL
  return v.connected ? `${v.agent.name}${NAME_SEP}${v.connected.ref}` : v.agent.name
}

// the footer text's colour, by the connection's state: red where the connection is lost or refused, yellow where it needs attention (the
// auto-mode block, the plan's failed load, a card waiting on a person), green when connected with an agent, none (the footer's own text colour) when disconnected.
export function footerTone(v: PlanView): string | undefined {
  if (v.phase === 'signed-out' || v.phase === 'key-revoked') return DANGER
  if (v.phase === 'blocked' || v.phase === 'error' || (v.needsYou ?? 0) > 0) return WARNING
  return v.agent !== null && v.connected ? SUCCESS : undefined
}

// the events warning (stored in the session and toasted once on the change into it; the band draws none of it): why the plan's events are not flowing, or null while they are.
// The plugin's own relay comes first: one that retries or stopped, or is not running for the plan the session is on, is never drawn healthy
// whatever the dashboard last read; then the dashboard's own view of the session's listener (no status at all is a warning, never healthy).
export function eventsWarning(v: PlanView, relay: RelayState): string | null {
  if (v.connected === null) return null
  // the relay's state belongs to the plan it serves: one left over from another plan says nothing about this one
  if (relayStoppedFor(v, relay)) return 'events: relay stopped'
  if (relay.phase === 'retrying' && relay.planId === v.connected.id) return 'events: relay retrying'
  if (relay.planId !== v.connected.id || relay.phase === 'off') return 'events: relay not running'
  if (v.listener === null) return NO_EVENT_STATUS
  return v.listener.state === 'healthy' ? null : `events: ${v.listener.state}`
}

// the reason behind the events warning, for the one toast the transition into it draws: the relay's own detail when the relay
// retries or has stopped, the server's next step when the listener is the fault, none when the relay simply is not running (its state
// is "off" on every connect, before the relay starts) or the events are flowing.
export function eventsReason(v: PlanView, relay: RelayState): string | null {
  const warning = eventsWarning(v, relay)
  if (warning === null || v.connected === null) return null
  if (relay.planId !== v.connected.id) return null
  if (relay.phase === 'off') return null
  const detail = relay.phase === 'retrying' || relay.phase === 'stopped' ? relay.detail : (v.listener?.nextStep ?? null)
  return detail ? `${warning}. ${detail}` : null
}
