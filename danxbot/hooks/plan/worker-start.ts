import { TIERS } from './pacing-guard'

// A sub-agent of type `danxbot:worker` has no model or effort of its own: the Agent call passes both, as the dashboard answers them for the card or
// gate. A call that leaves one out is refused at the `tool.call` hook of the Agent tool, because `agent.spawn` cannot see `effort` and a left-out
// effort silently follows the session that starts the worker, so a gate would run at an effort nobody chose.
//
// This is the only refusal here and it is of the Agent tool alone (starting a sub-agent), never of a tool that saves work. It runs before the usage-pacing
// claim, so a refused call takes no slot.
//
// LIMIT: only an Agent tool call is checked. A `danxbot:worker` started from a workflow script makes no Agent call, so it is never refused and takes its
// parent's effort. The type is matched exactly: a team's own agent that is merely named `worker` is not this plugin's and is left alone.

const WORKER_TYPE = 'danxbot:worker'

export const WORKER_REFUSAL_PREFIX = `${WORKER_TYPE} was started without`

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

type AgentCall = { subagent_type?: string; model?: string; effort?: string }

// null when the call is not a worker start or passes both; else the refusal naming what to pass.
export function workerStartRefusal(e: AgentCall): string | null {
  if (e.subagent_type !== WORKER_TYPE) return null
  const missing = (['model', 'effort'] as const).filter(k => !e[k])
  if (missing.length === 0) return null
  return (
    `${WORKER_REFUSAL_PREFIX} its ${missing.join(' and ')}. Start it again with both in the Agent call: model (${TIERS.join(', ')}) and effort (${EFFORTS.join(', ')}), ` +
    'exactly as the dashboard answers them for the card or gate (the card read for a builder, the gate instruction route for a gate, `GET /api/boards/<board>` with `fields.effort_ladder` for a sub-agent with no card). A left-out effort would follow this session\'s own, not the grade\'s.'
  )
}

// The Agent tool's `tool.call` hook: a refused worker start is `{ deny }`; every other call goes on to `next`.
export async function workerStartGuard<E extends AgentCall, R extends { deny?: string }>(e: E, next: (e: E) => Promise<R>): Promise<R | { deny: string }> {
  const refusal = workerStartRefusal(e)
  return refusal === null ? next(e) : { deny: refusal }
}
