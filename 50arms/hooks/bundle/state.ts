// What the plugin keeps between hooks about the policy bundle: the bundle it holds, what each agent context was already told, the holds, the start events still owed, and the report queue.
// A type and its empty value only; the rules that change it are in bundle.ts, hold.ts and reports.ts.

import { NO_HOLDS } from './hold'
import { EMPTY_QUEUE } from './reports'
import type { Behavior } from '../../types'

export type { Behavior }


export const NO_BEHAVIOR: Behavior = { held: null, told: {}, holds: NO_HOLDS, owed: {}, queue: EMPTY_QUEUE, floorLoud: false, roleTold: null }

export const owe = (owed: Record<string, string[]>, key: string, event: string): Record<string, string[]> => {
  const list = owed[key] ?? []
  return list.includes(event) ? owed : { ...owed, [key]: [...list, event] }
}

// What a call that tells `event` does with the context's owed start events. `with`: it tells them too (the next prompt), `only`: it tells nothing but them (the refusal of the next tool call).
// Any other call leaves them owed: it has no right to use them up. An owed event the call tells itself is told once, so it leaves the list either way.
export type OwedTaking = 'none' | 'with' | 'only'

export const settleOwed = (owed: Record<string, string[]>, key: string, event: string, taking: OwedTaking): { events: string[]; owed: Record<string, string[]> } => {
  const list = owed[key] ?? []
  const events = taking === 'none' ? [] : list.filter(o => o !== event || taking === 'only')
  const left = list.filter(o => !events.includes(o) && o !== event)
  if (left.length === list.length) return { events, owed }
  const { [key]: _taken, ...rest } = owed
  return { events, owed: left.length === 0 ? rest : { ...rest, [key]: left } }
}
