// DX-4235: the activity rows a plan-connected session reports (`POST /api/plan-sessions/me/activity`), so the dashboard's running set
// opens and closes with the session's sub-agents and background shells. Pure: register.tsx decides when and calls the dashboard.
//
// The row is the stats wire's `ActivityChange` (danxbot packages/danx-session-telemetry stats-wire.ts): the server parses it strictly
// (every one of these keys, no other) and merges it into the stored row: `startedAt` keeps the earliest, `lastActivityAt` the latest,
// and the FIRST `finishedAt` wins, so a running report sent after a finish never re-opens the row.

export const ACTIVITY_PATH = '/api/plan-sessions/me/activity'

export type ActivityChange = {
  kind: 'agent' | 'bash'
  activityId: string
  agentType: string | null
  description: string | null
  startedAt: number
  lastActivityAt: number
  finishedAt: number | null
  parentActivityId: string | null
  effort: string | null
  currentActivity: string | null
  endStatus: null
  briefIssueId: string | null
}

// A running sub-agent re-posts its row at most this often from its own tool calls, so one working for minutes never reads as silent
// (comment 10017 on DX-4235).
export const LIVENESS_MS = 60_000

const SUBAGENT_PREFIX = 'agent-'

// A sub-agent's row key is its transcript file's basename, `agent-<id>`, the key the dashboard's transcript reader uses too, so the two
// producers meet on one row. The id may arrive with or without the prefix; one leading prefix is stripped before it is added.
export function subagentActivityId(agentId: string): string {
  return `${SUBAGENT_PREFIX}${agentId.startsWith(SUBAGENT_PREFIX) ? agentId.slice(SUBAGENT_PREFIX.length) : agentId}`
}

// The id the engine's `background_tasks` lists a sub-agent under: without the prefix.
export function bareAgentId(agentId: string): string {
  return subagentActivityId(agentId).slice(SUBAGENT_PREFIX.length)
}

// The facts only a transcript knows (who spawned it, effort, its current tool call, how it ended, its card) are sent unknown; the server
// never lets an unknown erase a stored value. `description` is null too: the wire carries only redacted labels, and the redactor is the
// telemetry package's, so the plugin sends none rather than a second copy of it.
const UNKNOWN_FACTS = { description: null, parentActivityId: null, effort: null, currentActivity: null, endStatus: null, briefIssueId: null } as const

function row(kind: ActivityChange['kind'], activityId: string, agentType: string | null, at: number, finishedAt: number | null): ActivityChange {
  return { kind, activityId, agentType, startedAt: at, lastActivityAt: at, finishedAt, ...UNKNOWN_FACTS }
}

// One sub-agent: running (`finishedAt` null) or finished at `finishedAt`. `activityId` is already `subagentActivityId`'s.
export function agentRow(activityId: string, agentType: string | null, at: number, finishedAt: number | null): ActivityChange {
  return row('agent', activityId, agentType, at, finishedAt)
}

// One background shell, keyed by its background task id: the id the Bash result names (`backgroundTaskId`) is the id the engine's
// `background_tasks` snapshot lists it under (observed live, DX-4235 comment 12391), which is what lets a Stop close it.
export function shellRow(taskId: string, at: number, finishedAt: number | null): ActivityChange {
  return row('bash', taskId, null, at, finishedAt)
}

// The shells this session opened that the snapshot no longer lists as running: they ended (the engine's list holds only work in flight).
// Replaces the old "no event ends a background shell" rule (comment 10065: every start must get its end).
export function endedShells(opened: readonly string[], tasks: readonly { id: string; status: string }[]): string[] {
  const running = new Set(tasks.filter(t => t.status === 'running').map(t => t.id))
  return opened.filter(id => !running.has(id))
}
