import type { LimitSettings, PacingLevel, PacingVerdict, PanelState } from '../../types'

// DX-4339 (PLAN-29): the pacing panel's model, pure (no `$`): the session's own usage windows (`$.session.usage().rateLimits`, which move live)
// set against the team's pacing settings (pacing-settings.ts) and the session's account verdict (the DX-4340 cache, pacing-line.ts). A limit the
// team switched off is not shown. The text is pacing-format.ts, the drawing pacing-panel-view.tsx.

export type PacingLimitKey = 'five_hour' | 'weekly'
export const LIMIT_KEYS: readonly PacingLimitKey[] = ['five_hour', 'weekly']
// the harness names the weekly window `seven_day`
const WINDOW_KIND: Record<PacingLimitKey, string> = { five_hour: 'five_hour', weekly: 'seven_day' }

export const EMPTY_PANEL_STATE: PanelState = { settings: null, settingsAt: null, settingsRead: { state: 'pending' }, verdict: null, limits: [] }

export type PanelEntry = {
  limit: PacingLimitKey
  // percent used of the window, rounded for display; null when the session has no figure for it yet
  used: number | null
  // epoch ms the window resets; null with no figure
  resetsAt: number | null
  // null when the team's settings were never read
  settings: LimitSettings | null
  // the limit's own level; null with no figure or no settings to judge it by
  level: PacingLevel | null
}
export type PanelModel = {
  entries: PanelEntry[]
  // the settings read is not working (`silent` or `error`): the figures are the session's own, the targets the last read, and there is no verdict
  local: boolean
  // the settings read's failure to name in the pane, else null
  error: string | null
  settingsAt: number | null
  verdict: PacingVerdict | null
}

const SEVERITY: Record<PacingLevel, number> = { on_pace: 0, over_pace: 1, critical: 2 }
// the verdict's reset time is its binding limit's: the window it is about is the one resetting at that moment (give or take a rounding)
const SAME_RESET_MS = 60_000

// The level the thresholds alone give (danxbot's projection can only make it worse, and arrives as the verdict).
export function thresholdLevel(used: number, s: LimitSettings): PacingLevel {
  return used >= s.criticalPercent ? 'critical' : used >= s.targetPercent ? 'over_pace' : 'on_pace'
}

export function buildPanel(state: PanelState): PanelModel {
  const read = state.settingsRead
  const local = read.state === 'silent' || read.state === 'error'
  // a verdict from before danxbot stopped answering is not shown as current
  const verdict = local ? null : state.verdict
  const verdictResets = verdict?.resetsAt == null ? null : Date.parse(verdict.resetsAt)
  const entries: PanelEntry[] = []
  for (const limit of LIMIT_KEYS) {
    const settings = state.settings?.[limit] ?? null
    if (settings !== null && !settings.enabled) continue
    const win = state.limits.find(l => l.kind === WINDOW_KIND[limit])
    // with no settings read and no figure there is nothing to say about this limit
    if (settings === null && win === undefined) continue
    const resets = win?.resetsAt === undefined ? null : Date.parse(win.resetsAt)
    const resetsAt = resets === null || Number.isNaN(resets) ? null : resets
    // the level is judged on the harness's own figure (danxbot compares the unrounded percent too); only the display is rounded
    let level = win === undefined || settings === null ? null : thresholdLevel(win.percentUsed, settings)
    if (level !== null && verdict !== null && verdictResets !== null && resetsAt !== null && Math.abs(resetsAt - verdictResets) <= SAME_RESET_MS && SEVERITY[verdict.level] > SEVERITY[level]) {
      level = verdict.level
    }
    entries.push({ limit, used: win === undefined ? null : Math.round(win.percentUsed), resetsAt, settings, level })
  }
  return { entries, local, error: read.state === 'error' ? read.message : null, settingsAt: state.settingsAt, verdict }
}

// What the band draws when it is given no pacing (a surface or test that does not say): nothing.
export const EMPTY_PANEL: PanelModel = buildPanel(EMPTY_PANEL_STATE)
