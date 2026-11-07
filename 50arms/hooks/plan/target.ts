// What a `session_connect` call names: its `target` argument is `PLAN-n` for plan n of the team, or a card's id for a card on no plan; omitted, the call only
// signs the session in. The dashboard resolves it with the same rule (`parseConnectTarget`: a target starting with `PLAN-` is a plan, any other is a card, `PLAN` being no board's prefix).
const PLAN_PREFIX = 'PLAN-'
const CANONICAL_NUMBER = /^[1-9][0-9]*$/

export type ConnectTarget = { kind: 'plan'; id: number } | { kind: 'card'; ref: string }

// the `target` a call to hold plan n carries
export const planTarget = (id: number): string => `${PLAN_PREFIX}${id}`

// the target a call's `target` argument names; null when the call names none, or names a `PLAN-` target that is no plan number (the dashboard refuses that one and nothing is held or left)
export function connectTargetOf(target: unknown): ConnectTarget | null {
  if (typeof target !== 'string' || target === '') return null
  if (!target.startsWith(PLAN_PREFIX)) return { kind: 'card', ref: target }
  const number = target.slice(PLAN_PREFIX.length)
  return CANONICAL_NUMBER.test(number) ? { kind: 'plan', id: Number(number) } : null
}
