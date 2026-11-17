import type { ConnectedPlan, HeldCard, PlanView, SessionAgent } from '../../types'

// What the band's Disconnect acts on: what the view says the session holds. A session holds a plan or a card, never both, and its team agent beside either or alone.
export type BandHold = { plan: ConnectedPlan | null; card: HeldCard | null; agent: SessionAgent | null }

export const bandHold = (v: PlanView): BandHold => ({ plan: v.connected, card: v.card, agent: v.agent })

// Disconnect leaves a plan or a card, so it shows only while the session holds one.
export const holdsPlanOrCard = (h: BandHold): boolean => h.plan !== null || h.card !== null

// Revoke signs the session out, so it shows whenever the session holds an agent, a plan or a card (operator, 2026-11-06: a connected agent always has a button that ends it).
export const holdsAnything = (h: BandHold): boolean => holdsPlanOrCard(h) || h.agent !== null

// The busy key of one disconnect: one per thing left, so a second press while it runs (or another leave) does nothing.
export const holdKey = (h: BandHold): string => (h.plan !== null ? String(h.plan.id) : h.card !== null ? `card:${h.card.id}` : 'agent')

// CP-142: a sign-in or machine-registration prompt is the band of a session that holds no connection, so the band never draws one beside a
// connected state (a signed-in view, or a plan or card held). The band derives what it draws from the view and these two atoms through this one
// function, so a request an atom still carries (its watch has not yet cleared it) never shows beside a connection.
export const holdsConnection = (v: PlanView): boolean => (v.phase === 'ready' && v.agentBlock === null) || (v.phase === 'loading' && (v.connected !== null || v.card !== null))

export function approvalsDrawn<S, R>(v: PlanView, signIn: S | null, registration: R | null): { signIn: S | null; registration: R | null } {
  return holdsConnection(v) ? { signIn: null, registration: null } : { signIn, registration }
}
