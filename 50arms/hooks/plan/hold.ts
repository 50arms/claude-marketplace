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
