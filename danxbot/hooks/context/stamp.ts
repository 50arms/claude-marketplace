import type { StampState } from '../../types'

// DX-4234: the model's only clock. One line per prompt and per finished tool call: wall-clock time with its UTC offset, then the time
// since the previous stamp.
//   09/28/2026 01:12:03 -06:00 +0      first stamp, or the first of a new day: the full date
//   01:12:08 -06:00 +5s                the same day: time only
// Pure: the clock, the offset and the last stamp arrive as arguments (register.tsx holds the `$` calls), so a test and the injection
// measure (scripts/measure-injection.mjs) run exactly the text a session gets.
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
