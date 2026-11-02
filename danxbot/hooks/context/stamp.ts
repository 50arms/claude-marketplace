import type { StampState, StampTold } from '../../types'

// the model's only clock. One line per prompt and per finished tool call: wall-clock time with its UTC offset, then the time
// since the previous stamp.
//   09/28/2026 01:12:03 -06:00 +0      first stamp, or the first of a new day: the full date
//   01:12:08 -06:00 +5s                the same day: time only
// Pure: the clock, the offset and the last stamp arrive as arguments (register.tsx holds the `$` calls), so a test and the injection
// measure (the injection measurement script) run exactly the text a session gets.
//
// A prompt is always stamped. A tool call is stamped only when the agent's last stamp is TOOL_STAMP_EVERY_MS old (or it has none, or the clock went back): the
// stamps between told the model no more than the one before, and each was re-read by every later model call. The last stamp is kept PER AGENT (the main thread and each
// sub-agent read their own context), so +delta is that agent's own gap and never the seconds since another agent's stamp.
export const TOOL_STAMP_EVERY_MS = 60_000

/** Whether a tool call at `now` is stamped, given when its agent was last stamped (undefined: never). */
export function toolStampDue(toldAt: number | undefined, now: number): boolean {
  return toldAt === undefined || now < toldAt || now - toldAt >= TOOL_STAMP_EVERY_MS
}

const two = (n: number) => String(n).padStart(2, '0')

// `+5s`, `+3m 7s`, `+3m`, `+2h 0m 5s`, `+2h 0m`: seconds are dropped only when zero past a minute, minutes never past an hour, as the bash hook this replaced printed them
function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (total < 60) return `+${s}s`
  if (total < 3600) return s > 0 ? `+${m}m ${s}s` : `+${m}m`
  return s > 0 ? `+${h}h ${m}m ${s}s` : `+${h}h ${m}m`
}

function offsetText(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  return `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`
}

// `offsetMinutes`: minutes the local time is ahead of UTC (-360 for -06:00). `last`: the previous stamp's state, null for the first.
export function stamp(now: number, offsetMinutes: number, last: StampState): { line: string; state: StampState } {
  const local = new Date(now + offsetMinutes * 60_000)
  const day = `${local.getUTCFullYear()}${two(local.getUTCMonth() + 1)}${two(local.getUTCDate())}`
  const time = `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())} ${offsetText(offsetMinutes)}`
  const full = `${two(local.getUTCMonth() + 1)}/${two(local.getUTCDate())}/${local.getUTCFullYear()} ${time}`
  const head = last === null || last.day !== day ? full : time
  // the first stamp is `+0`, never a unit
  const since = last === null ? '+0' : elapsed(now - last.at)
  return { line: `${head} ${since}`, state: { at: now, day } }
}

/**
 * The stamp for `agent` at `now`: its line (null when none is due) and the stamps told after it. A `prompt` (a session start counts as one) is always stamped; a `tool` call
 * only when `toolStampDue`. An unstamped call changes nothing.
 */
export function stampDecision(told: StampTold, agent: string, now: number, offsetMinutes: number, trigger: 'prompt' | 'tool'): { line: string | null; told: StampTold } {
  const last = told[agent] ?? null
  if (trigger === 'tool' && !toolStampDue(last?.at, now)) return { line: null, told }
  const next = stamp(now, offsetMinutes, last)
  return { line: next.line, told: { ...told, [agent]: next.state! } }
}

/** `told` without `agent`: a stopped sub-agent is stamped afresh if its id ever calls again. */
export function stampForgotten(told: StampTold, agent: string): StampTold {
  return Object.fromEntries(Object.entries(told).filter(([id]) => id !== agent))
}
