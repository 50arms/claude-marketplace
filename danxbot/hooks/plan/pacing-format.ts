import type { LimitReadout, PacingLevel, PacingLimitKey, PacingMode, PacingReadout, PacingState, PacingVerdict } from '../../types'
import type { PanelEntry, PanelModel, SpendEntry } from './pacing-panel'

// DX-4339: the pacing panel's wording, pure: the band's entries, times, and the pane's verdict lines.

export const LIMIT_LABEL: Record<PacingLimitKey, { band: string; pane: string }> = { five_hour: { band: '5h', pane: '5-hour' }, weekly: { band: '7d', pane: 'weekly' }, spend: { band: '$', pane: 'spend' } }
// DX-4595: the third limit; the server's PACING_LIMIT_LABELS names it "spend"
export const SPEND_LABEL = 'spend'
export const NEEDS_DANXBOT = 'needs danxbot'
export const SPEND_UNJUDGED = 'danxbot has not judged spend for this account yet'
export const usd = (n: number): string => `$${n.toFixed(2)}`
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
  return `${LIMIT_LABEL[l.limit].band} ${Math.round(l.targetPercent)}%: ${readoutValue(l)}`
}

// One limit in plain words, for the pane (the band surface has no tooltip that can hold it).
export function readoutSentence(l: LimitReadout): string {
  const name = `${LIMIT_LABEL[l.limit].pane[0]!.toUpperCase()}${LIMIT_LABEL[l.limit].pane.slice(1)} limit`
  const target = `${Math.round(l.targetPercent)}%`
  const reset = formatMinutes(l.resetsInMinutes)
  if (l.state === 'spare') return `${name}: at the current rate the window resets before you reach ${target}, with ${formatMinutes(l.headroomMinutes)} spare.`
  if (l.state === 'short') return `${name}: at the current rate you reach ${target} ${formatMinutes(-l.headroomMinutes)} before the window resets, so you are ${formatMinutes(-l.headroomMinutes)} short.`
  if (l.state === 'hold') return `${name}: over pace, so nothing new starts until it eases or the window resets in ${reset}.`
  return `${name}: critical (at or past ${Math.round(l.criticalPercent)}%), so everything new stops until the window resets in ${reset}.`
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
