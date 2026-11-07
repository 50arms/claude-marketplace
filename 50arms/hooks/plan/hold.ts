import type { ConnectedPlan, HeldCard, PlanView, SessionAgent } from '../../types'

// What the band's Disconnect acts on: what the view says the session holds. A session holds a plan or a card, never both, and its team agent beside either or alone.
export type BandHold = { plan: ConnectedPlan | null; card: HeldCard | null; agent: SessionAgent | null }

export const bandHold = (v: PlanView): BandHold => ({ plan: v.connected, card: v.card, agent: v.agent })

// Disconnect shows whenever the session holds an agent, a plan or a card (operator, 2026-11-06: "If an agent is connected the band must ALWAYS show a disconnect button").
export const holdsAnything = (h: BandHold): boolean => h.plan !== null || h.card !== null || h.agent !== null

// The busy key of one disconnect: one per thing left, so a second press while it runs (or another leave) does nothing.
export const holdKey = (h: BandHold): string => (h.plan !== null ? String(h.plan.id) : h.card !== null ? `card:${h.card.id}` : 'agent')
