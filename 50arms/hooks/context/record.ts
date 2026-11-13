// Pure: nothing here reads a clock, a file or a session. The wording the model is told for a finished sub-agent is the 50 Arms registry's (`sub_agent_stop`);
// this file only works out WHICH agent finished and names it.

const DESCRIPTION_MAX = 80

/**
 * What the plugin keeps of a sub-agent at the moment it is spawned (the `agent.spawn` hook answers its id there): its description, whether it runs
 * in the background, and whether the main loop spawned it (`direct`) rather than another sub-agent.
 */
export type SpawnedAgent = { description: string; background: boolean; direct: boolean }
export type SpawnedAgents = Record<string, SpawnedAgent>

// the newest spawns kept: a finished agent may be resumed any time, but never more than this many are remembered
export const SPAWNED_KEPT = 200

/** The record after a spawn: the agent is the newest, and a respawn (a resume) of an id replaces its entry. */
export function spawnedAfter(cur: SpawnedAgents, id: string, agent: SpawnedAgent): SpawnedAgents {
  const { [id]: _replaced, ...rest } = cur
  const next = { ...rest, [id]: agent }
  const ids = Object.keys(next)
  return ids.length <= SPAWNED_KEPT ? next : Object.fromEntries(ids.slice(ids.length - SPAWNED_KEPT).map(k => [k, next[k] as SpawnedAgent]))
}

/**
 * What tells the main session that one of its own sub-agents finished. A background agent is announced by the engine's own final task notice
 * (`notice`): the engine sends one each time the agent stops with no live background children of its own, so it is the one signal that is
 * never an interim pause, and the stop hook (which fires at every turn's end, interim or not) must say nothing for it. A foreground agent has no
 * task notice (its result is the Agent call's answer), so its stop tells (`stop`). A nested agent's result goes to its parent, and an agent this
 * session never saw spawn cannot be placed: nobody (`null`).
 */
export function announcedBy(agent: SpawnedAgent | undefined): 'notice' | 'stop' | null {
  if (agent === undefined || !agent.direct) return null
  return agent.background ? 'notice' : 'stop'
}

/** A finished sub-agent named by its description and id, and by the cards its brief named. */
export function finishedAgentLabel(id: string, agent: SpawnedAgent, cards: readonly string[]): string {
  const words = agent.description.replace(/\s+/g, ' ').trim()
  const label = words === '' ? id : `"${words.length > DESCRIPTION_MAX ? `${words.slice(0, DESCRIPTION_MAX)}…` : words}" (${id})`
  return cards.length === 0 ? label : `${label} (its brief named ${cards.join(', ')})`
}

/** What the main session is told for the agents that finished since its last action: who they are, then the registry's `sub_agent_stop` text, once. */
export function finishedAgentsText(labels: readonly string[], registryText: string): string {
  return `Finished: ${labels.join('; ')}. ${registryText}`
}

/** A call that writes a plan or a card (the session's own, through 50arms_api): the call after which the band and the title's Needs You mark re-read the plan at once. */
export function isRecordWrite(method: unknown, path: unknown): boolean {
  return typeof method === 'string' && method.toUpperCase() !== 'GET' && typeof path === 'string' && /^\/api\/(issues|plans)(\/|$)/.test(path)
}
