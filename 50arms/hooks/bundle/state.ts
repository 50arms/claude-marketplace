// What the plugin keeps between hooks about the policy bundle: the bundle it holds, what each agent context was already told, the holds, the start events still owed, and the report queue.
// A type and its empty value only; the rules that change it are in bundle.ts, hold.ts and reports.ts.

import type { Held, Told } from './bundle'
import { NO_HOLDS } from './hold'
import type { Holds } from './hold'
import { EMPTY_QUEUE } from './reports'
import type { Queue } from './reports'

export type Behavior = {
  // the bundle held, with when an answer last confirmed it; null before the first fetch
  held: Held | null
  // by agent context (`main` or a sub-agent's id): what a once-only text was already told under
  told: Record<string, Told>
  // by agent context: the contexts that have no current bundle
  holds: Holds
  // by agent context: the start events that fired while it had no bundle, in the order they fired; delivered once a bundle arrives
  owed: Record<string, string[]>
  // the reports kept to send, and the failure the band shows
  queue: Queue
  // the floor send failed loudly in this session: it is not started again
  floorLoud: boolean
  // the role the main conversation was last told (`session.bind`, AC 76950): `plan:<id>`, `card:<id>` or `none`; null before it was told one and after each compaction or clear of it
  roleTold: string | null
}

export const NO_BEHAVIOR: Behavior = { held: null, told: {}, holds: NO_HOLDS, owed: {}, queue: EMPTY_QUEUE, floorLoud: false, roleTold: null }

export const owe = (owed: Record<string, string[]>, key: string, event: string): Record<string, string[]> => {
  const list = owed[key] ?? []
  return list.includes(event) ? owed : { ...owed, [key]: [...list, event] }
}

export const takeOwed = (owed: Record<string, string[]>, key: string): { events: string[]; owed: Record<string, string[]> } => {
  const events = owed[key] ?? []
  if (events.length === 0) return { events, owed }
  const { [key]: _taken, ...rest } = owed
  return { events, owed: rest }
}
