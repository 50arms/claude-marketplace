// DX-4235: the background-work count a plan-connected session reports (`PUT /api/plan-sessions/me/background-work`), which keeps the
// dashboard's idle nudge quiet while the session's background work really runs (DX-3367). Pure: register.tsx sends it.

export const BACKGROUND_WORK_PATH = '/api/plan-sessions/me/background-work'

// The kinds of background work that count as "still working". A monitor, teammate, cloud session or MCP task is a long-lived watcher:
// counting one would silence the nudge forever.
const COUNTED_TYPES = new Set(['shell', 'subagent', 'workflow'])

// The running counted entries of a Stop / SubagentStop `background_tasks` snapshot. `excludeId`: a SubagentStop still lists the
// sub-agent that is stopping as running, so its own entry is left out.
export function countRunning(tasks: readonly { id: string; type: string; status: string }[], excludeId?: string): number {
  return tasks.filter(t => COUNTED_TYPES.has(t.type) && t.status === 'running' && t.id !== excludeId).length
}

// What a running sub-agent's heartbeat re-sends: the count on record, and at least 1, since that sub-agent is itself work in flight.
export function heartbeatCount(recorded: number | null): number {
  return Math.max(recorded ?? 0, 1)
}
