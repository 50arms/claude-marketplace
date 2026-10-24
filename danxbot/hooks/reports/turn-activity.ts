// DX-5694: the session's turn activity, reported to the dashboard (`PUT /api/plan-sessions/me/turn-activity`, fixed by DX-5693) so a card's
// Comments drawer can say why a comment is waiting: the agent is finishing a step (in a turn) or compacting (about 2 minutes). Pure:
// register.tsx decides when and calls the dashboard.
//
// The server keeps only the NEWEST start (`since`): an equal or older one answers `unchanged` or `stale`. So two changes in the same
// millisecond would drop the second; `nextSince` makes each start strictly later than the last one sent.

export const TURN_ACTIVITY_PATH = '/api/plan-sessions/me/turn-activity'

export type TurnActivity = 'idle' | 'in_turn' | 'compacting'

export type TurnActivityBody = { activity: TurnActivity; since: string }

// A change of activity at `nowMs`, never before or equal to `lastMs` (the start of the last one sent, null before the first).
export function nextSince(nowMs: number, lastMs: number | null): number {
  return lastMs !== null && nowMs <= lastMs ? lastMs + 1 : nowMs
}

// The body as the route parses it: an ISO-8601 UTC instant, as Date#toISOString writes it.
export const turnActivityBody = (activity: TurnActivity, sinceMs: number): TurnActivityBody => ({ activity, since: new Date(sinceMs).toISOString() })

// What the session is doing when a compaction ends: still in its turn when one was running (an automatic compaction mid-turn), else idle.
export const afterCompaction = (turnRunning: boolean): TurnActivity => (turnRunning ? 'in_turn' : 'idle')
