import type { PlanView, RelayState, StatusBreakdown } from '../../types'
import { BAND_CONTROL_CHROME_COLS, BAND_GAP_COLS, BAND_INDICATOR_COLS, BAND_NAME_MIN_COLS, BAND_SPARE_COLS, BRAND, PROBLEM_GLYPH, SIGNED_OUT_LABEL, KEY_REVOKED_FOOTER, NO_EVENT_STATUS, keyRevokedLabel } from './config'

// DX-4420: the band button's label: a problem glyph and the count,
// '' for none (the button is then not drawn). The count is a button, not label text: see band.tsx.
export function problemBadge(v: PlanView): string {
  const n = v.openProblems
  return n === null || n === 0 ? '' : `${PROBLEM_GLYPH} ${n}`
}

// `text` cut to `max` characters, the last one an ellipsis, so a cut name never reads as a whole one.
export function ellipsize(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const NAME_SEP = ' · '

// DX-4420: the columns the band's label may take: its width less the indicator and each control. A Button draws `[ label ]`
// chrome on the terminal; a Markdown link none. The terminal's widths are the model (UNVERIFIED on the desktop's native buttons and 16px donut): the spare columns
// are the margin, and the label's own `truncate-end` is the second line of defence.
export function bandLabelCols(columns: number, controls: readonly { label: string; isButton: boolean }[]): number {
  const controlCols = controls.reduce((n, c) => n + c.label.length + (c.isButton ? BAND_CONTROL_CHROME_COLS : 0) + BAND_GAP_COLS, 0)
  // the row's gaps: one per control, one after the indicator, one after the label's spacer
  return columns - BAND_INDICATOR_COLS - 2 * BAND_GAP_COLS - controlCols - BAND_SPARE_COLS
}

// The band's label for a view. `maxCols`: the columns the label may take (absent:
// no limit, the layout truncates); a connected plan's name is cut to what `PLAN-NN · ` leaves, with an ellipsis.
export function bandLabel(v: PlanView, maxCols?: number): string {
  // DX-4423: a session with no key reads signed out, in the operator's words, whatever it was connected to before.
  if (v.phase === 'signed-out') return SIGNED_OUT_LABEL
  // DX-4418: a revoked key names who revoked it.
  if (v.phase === 'key-revoked') return keyRevokedLabel(v.revokedBy as string) // always set with the phase
  // DX-4419: the operator's wording for ANY failed load, even one that kept the connected plan.
  if (v.phase === 'error') return `${BRAND}: Disconnected`
  if (v.phase === 'loading' && !v.refreshedAt) return `${BRAND}: loading…`
  if (!v.connected) return `${BRAND}: not connected to a plan`
  // DX-4420: a connected band reads `PLAN-NN · name`; the Danxbot prefix stays on the states with no plan.
  const { ref, name } = v.connected
  const sepCols = ref ? NAME_SEP.length : 0
  const nameCols = maxCols === undefined ? name.length : Math.max(BAND_NAME_MIN_COLS, maxCols - ref.length - sepCols)
  return [ref, ellipsize(name, nameCols)].filter(Boolean).join(NAME_SEP)
}

// Percent complete, as the dashboard's plan header computes it. Mirrors the formula written inline at
// danxbot's frontend/src/routes/plans/PlanStatusSummary.tsx:202 (the total) and :218 (the percent) (DX-3766):
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

// DX-4374: the footer button's label, read from `view.connected` alone (never from the phase's error):
// `Danxbot · PLAN-NN` when a plan is known, `Danxbot` otherwise (DX-4419); null where the footer shows nothing (loading with no plan shown yet; a connect shows its plan at once, DX-4635).
// The label can flip to `Danxbot` when a plan-list load fails: that error view carries no connected plan (the
// session is read from the same failed answer), so the footer cannot name one. An error built after the plan
// was read keeps it, and the footer keeps `Danxbot · PLAN-NN`.
export function footerLabel(v: PlanView): string | null {
  if (v.phase === 'loading' && !(v.connected && v.refreshedAt)) return null
  if (v.phase === 'signed-out') return SIGNED_OUT_LABEL
  if (v.phase === 'key-revoked') return KEY_REVOKED_FOOTER
  return v.connected ? `${BRAND} · ${v.connected.ref}` : BRAND
}

// DX-5232: the band's events warning: why the plan's events are not flowing, or null while they are.
// The plugin's own relay comes first: one that retries or stopped, or is not running for the plan the session is on, is never drawn healthy
// whatever the dashboard last read; then the dashboard's own view of the session's listener (no status at all is a warning, never healthy).
export function eventsWarning(v: PlanView, relay: RelayState): string | null {
  if (v.connected === null) return null
  // the relay's state belongs to the plan it serves: one left over from another plan says nothing about this one
  if ((relay.phase === 'retrying' || relay.phase === 'stopped') && relay.planId === v.connected.id) {
    return relay.phase === 'stopped' ? 'events: relay stopped' : 'events: relay retrying'
  }
  if (relay.planId !== v.connected.id || relay.phase === 'off') return 'events: relay not running'
  if (v.listener === null) return NO_EVENT_STATUS
  return v.listener.state === 'healthy' ? null : `events: ${v.listener.state}`
}

// DX-5232: the reason behind the events warning, for the one toast the transition into it draws: the relay's own detail when the relay
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
