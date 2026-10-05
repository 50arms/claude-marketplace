import { CURSOR_KEEP, CURSOR_PREFIX } from './config'

// DX-4233: the resume cursor ($.store, per session): the plan it is for and the cursor of the last record DELIVERED (an opaque string the server minted). It is stored only after a
// delivery succeeded, so a failed one is asked for again and a restart never skips an event.
export type CursorRecord = { planId: number; cursor: string; at: number }

export const cursorKey = (sessionId: string) => `${CURSOR_PREFIX}${sessionId}`

// The stored cursor for this plan, null when none (a different plan's record, a damaged one: a null cursor starts clean).
export function cursorFor(record: unknown, planId: number): string | null {
  const r = record as Partial<CursorRecord> | null | undefined
  if (r === null || r === undefined || typeof r !== 'object') return null
  return r.planId === planId && typeof r.cursor === 'string' && r.cursor !== '' ? r.cursor : null
}

// The keys of the oldest records past CURSOR_KEEP, so the store does not grow with every session ever held.
export function staleCursorKeys(entries: { key: string; at: number }[]): string[] {
  const sorted = [...entries].sort((a, b) => b.at - a.at)
  return sorted.slice(CURSOR_KEEP).map(e => e.key)
}

// The wait before try number `failures` (1 for the first): the schedule's last step repeats.
export function backoffMs(schedule: readonly number[], failures: number): number {
  return schedule[Math.min(Math.max(failures, 1), schedule.length) - 1]
}
