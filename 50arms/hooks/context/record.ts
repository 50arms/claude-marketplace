// Pure: nothing here reads a clock, a file or a session. The wording the model is told for a finished sub-agent is the 50 Arms registry's (`sub_agent_stop`);
// this file only works out WHICH agent finished and names it.

import type { FinishedAgent } from '../../types'

export type { FinishedAgent }

const DESCRIPTION_MAX = 80

/**
 * What the plugin keeps of a sub-agent at the moment it is spawned (the `agent.spawn` hook answers its id there): its description, whether it runs
 * in the background, and whether the main loop spawned it (`direct`) rather than another sub-agent.
 */
export type SpawnedAgent = {
  description: string
  background: boolean
  direct: boolean
  /** The agent that spawned it (`null` for the main loop): the engine's final notice of a background parent says it had no live background child left. */
  parent: string | null
}
export type SpawnedAgents = Record<string, SpawnedAgent>

// the newest spawns kept: a finished agent may be resumed any time, but never more than this many are remembered
export const SPAWNED_KEPT = 200

/**
 * The record after a spawn: the agent is the newest, and a respawn (a resume) of an id replaces its entry. `evicted` names the agents the newest
 * `SPAWNED_KEPT` pushed out: their entries are gone, so nothing else can ever end their context.
 */
export function spawnedAfter(cur: SpawnedAgents, id: string, agent: SpawnedAgent): { agents: SpawnedAgents; evicted: string[] } {
  const { [id]: _replaced, ...rest } = cur
  const next = { ...rest, [id]: agent }
  const ids = Object.keys(next)
  if (ids.length <= SPAWNED_KEPT) return { agents: next, evicted: [] }
  const cut = ids.length - SPAWNED_KEPT
  return { agents: Object.fromEntries(ids.slice(cut).map(k => [k, next[k] as SpawnedAgent])), evicted: ids.slice(0, cut) }
}

/**
 * The agents under `id` that ended with it, for a background `id` whose final task notice arrived: the engine sends that notice only when the agent
 * has no live background child, so the notice is the engine's own signal for them. Their children that are not mid-turn (`running`), then theirs; one
 * mid-turn stays, with everything under it. A foreground parent's stop says nothing of its children, so it never calls this.
 */
export function endedWithParent(agents: SpawnedAgents, id: string, running: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  const queue = [id]
  while (queue.length > 0) {
    const parent = queue.shift() as string
    for (const [child, agent] of Object.entries(agents)) {
      if (agent.parent !== parent || seen.has(child)) continue
      seen.add(child)
      if (running.includes(child)) continue
      out.push(child)
      queue.push(child)
    }
  }
  return out
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

/** A call that writes a plan or a card (the session's own, through 50arms_api): the call after which the band and the title's Needs You mark re-read the plan at once. */
export function isRecordWrite(method: unknown, path: unknown): boolean {
  return typeof method === 'string' && method.toUpperCase() !== 'GET' && typeof path === 'string' && /^\/api\/(issues|plans)(\/|$)/.test(path)
}
