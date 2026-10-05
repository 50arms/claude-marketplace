import type { PacingLevel, PacingMode, PacingVerdict } from '../../types'
import type { PacingLimitKey, PanelEntry, PanelModel } from './pacing-panel'

// DX-4339: the pacing panel's wording, pure: the band's entries, times, and the pane's verdict lines.

export const LIMIT_LABEL: Record<PacingLimitKey, { band: string; pane: string }> = { five_hour: { band: '5h', pane: '5-hour' }, weekly: { band: '7d', pane: 'weekly' } }
export const MODE_LABEL: Record<PacingMode, string> = { fast_then_hold: 'fast then hold', spread_evenly: 'spread evenly' }
export const LEVEL_LABEL: Record<PacingLevel, string> = { on_pace: 'on pace', over_pace: 'over pace', critical: 'critical' }
// a mark besides the colour, so the level reads on a terminal with no colour
const LEVEL_MARK: Record<PacingLevel, string> = { on_pace: '', over_pace: '▲', critical: '‼' }
export const LOCAL_MARK = 'local'

// The band's text for one entry: `5h 62%/80% ▲` (used / target), `5h 62%` while the target is unknown, `5h …` with no figure.
function entryText(e: PanelEntry): string {
  const figure = e.used === null ? '…' : e.settings === null ? `${e.used}%` : `${e.used}%/${e.settings.targetPercent}%`
  return [LIMIT_LABEL[e.limit].band, figure, e.level === null ? '' : LEVEL_MARK[e.level]].filter(Boolean).join(' ')
}

export type BandSegment = { key: string; text: string; level: PacingLevel | null }

// The band's segments, the ONE composition both the drawing and the width budget read: an entry per limit, then `local`. Empty with nothing to show.
export function bandSegments(m: PanelModel): BandSegment[] {
  if (m.entries.length === 0) return []
  return [...m.entries.map(e => ({ key: e.limit, text: entryText(e), level: e.level })), ...(m.local ? [{ key: 'local', text: LOCAL_MARK, level: null }] : [])]
}

// What the band's label budget counts.
export function bandText(m: PanelModel): string {
  return bandSegments(m)
    .map(s => s.text)
    .join(' ')
}

// "2h 10m", "3d 4h", "under a minute": the time to a reset (a figure already past reads as under a minute).
export function untilText(targetMs: number, now: number): string {
  const min = Math.max(0, Math.floor((targetMs - now) / 60_000))
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// "Sat 11:10Z": a UTC clock time, with the weekday so a reset days away is not mistaken for today's.
export function clockText(ms: number): string {
  const d = new Date(ms)
  return `${d.toUTCString().slice(0, 3)} ${d.toISOString().slice(11, 16)}Z`
}

// The pane's lines for the account verdict: its level and budget, how many agents run, and, when it holds new work, until when.
export function verdictLines(v: PacingVerdict, now: number): string[] {
  const budget = v.budget === null ? 'no cap' : v.budget === 0 ? '0 agents may start' : `${v.budget} agent${v.budget === 1 ? '' : 's'} at most at once`
  const lines = [`Account: ${LEVEL_LABEL[v.level]} · budget ${budget} · ${v.runningAgents} running`]
  if (v.budget === 0 && v.level !== 'on_pace') {
    const resets = v.resetsAt === null ? Number.NaN : Date.parse(v.resetsAt)
    lines.push(
      Number.isNaN(resets) ? 'Holding: no new agents start until the window resets.' : `Holding: no new agents start until the window resets, ${clockText(resets)} (in ${untilText(resets, now)}).`,
    )
  }
  return lines
}
