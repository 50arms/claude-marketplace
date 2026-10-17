import type { LimitReadout, PacingLevel, PacingLimitKey, PacingReadout, PacingState } from '../../types'
import type { PanelEntry, PanelModel, SpendEntry } from './pacing-panel'

// DX-4339: the pacing panel's wording, pure: the band's entries and the server's readout.

export const LIMIT_LABEL: Record<PacingLimitKey, string> = { five_hour: '5h', weekly: '7d', spend: '$' }
// DX-4595: the third limit; the server's PACING_LIMIT_LABELS names it "spend"
export const SPEND_LABEL = 'spend'
export const NEEDS_DANXBOT = 'needs danxbot'
// a mark besides the colour, so the level reads on a terminal with no colour
const LEVEL_MARK: Record<PacingLevel, string> = { on_pace: '', over_pace: '▲', critical: '‼' }
export const LOCAL_MARK = 'local'

// The band's text for one entry: `5h 62%/80% ▲` (used / target), `5h 62%` while the target is unknown, `5h …` with no figure.
function entryText(e: PanelEntry): string {
  const figure = e.used === null ? '…' : e.settings === null ? `${e.used}%` : `${e.used}%/${e.settings.targetPercent}%`
  return [LIMIT_LABEL[e.limit], figure, e.level === null ? '' : LEVEL_MARK[e.level]].filter(Boolean).join(' ')
}

// `spend 62%/80% ▲`, `spend …` while danxbot has not judged it, `spend needs danxbot` with no dashboard.
function spendText(s: SpendEntry): string {
  if (s.state === 'needs_danxbot') return `${SPEND_LABEL} ${NEEDS_DANXBOT}`
  if (s.state === 'unjudged') return `${SPEND_LABEL} …`
  return [SPEND_LABEL, `${s.used}%/${s.settings.targetPercent}%`, s.level === null ? '' : LEVEL_MARK[s.level]].filter(Boolean).join(' ')
}

// What colours a segment: the level (the session's own figures) or the server's state (its readout).
export type Tone = PacingLevel | PacingState
export type BandSegment = { key: string; text: string; tone: Tone | null }

// DX-4656: the server's readout, as the operator reads it. The band shows only the worst limit: `5h 95%: +1h` (spare), `5h 95%: -1h30m` (short),
// `5h 95%: hold 1h40m` (hold: the time to the reset), `5h 95%: stop` (stop); `7d` weekly, `$` spend. State and minutes are the server's, never recomputed.

// "45m", "1h", "1h30m", "-1h30m", "-4d15h": whole minutes, a negative span keeps its sign (follows danxbot's formatMinutes rule: days from 48 h up, DX-4657; the plugin keeps its own copy).
export function formatMinutes(minutes: number): string {
  const total = Math.round(Math.abs(minutes))
  const sign = minutes < 0 && total > 0 ? '-' : ''
  // DX-4656 / DX-4657: 48 h or more reads in days and hours (-6691 is -4d15h, 2880 is 2d), the minutes dropped
  if (total >= 2880) {
    const d = Math.floor(total / 1440)
    const dh = Math.floor((total % 1440) / 60)
    return `${sign}${d}d${dh === 0 ? '' : `${dh}h`}`
  }
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${sign}${m}m`
  return `${sign}${h}h${m === 0 ? '' : `${m}m`}`
}

function readoutValue(l: LimitReadout): string {
  if (l.state === 'stop') return 'stop'
  if (l.state === 'hold') return `hold ${formatMinutes(l.resetsInMinutes)}`
  return l.state === 'spare' ? `+${formatMinutes(l.headroomMinutes)}` : formatMinutes(l.headroomMinutes)
}

export function readoutText(l: LimitReadout): string {
  return `${LIMIT_LABEL[l.limit]} ${Math.round(l.targetPercent)}%: ${readoutValue(l)}`
}

export function readoutWorst(r: PacingReadout): LimitReadout {
  return r.limits.find(l => l.limit === r.worst)!
}

// The band's segments, the ONE composition both the drawing and the width budget read. With the server's readout: the worst limit alone.
// Without one (no server verdict, or the settings read failing): the session's own figures per limit, then `local`, exactly as before.
// Empty with nothing to show.
export function bandSegments(m: PanelModel): BandSegment[] {
  if (m.readout !== null) {
    const worst = readoutWorst(m.readout)
    return [{ key: 'worst', text: readoutText(worst), tone: worst.state }]
  }
  if (m.entries.length === 0 && m.spend === null) return []
  return [
    ...m.entries.map(e => ({ key: e.limit, text: entryText(e), tone: e.level })),
    ...(m.spend === null ? [] : [{ key: 'spend', text: spendText(m.spend), tone: m.spend.level }]),
    ...(m.local ? [{ key: 'local', text: LOCAL_MARK, tone: null }] : []),
  ]
}

// What the band's label budget counts.
export function bandText(m: PanelModel): string {
  return bandSegments(m)
    .map(s => s.text)
    .join(' ')
}
