import type { Api } from './load'

// 50 Arms counts a mantra, a start packet or a plan event as held only when the plugin says the text is in the model's conversation, never because
// the server sent it. Every text carries an id the dashboard minted (`delivery_id` on an event text, `startPacketDeliveryId` and `mantraDeliveryId` beside a connect's or a start packet's
// body, `acks[].eventId` on a plan event); the plugin posts it back, once the text is really there. The model is never asked to. A session without the plugin acknowledges nothing.

export const ackPath = (id: number) => `/api/plan-sessions/me/events/${id}/ack`

export const isDeliveryId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

// the ids a reply that carries the start packet, the connect's mantra and/or the operator events no session was told about (`missedEvents`) names; a null (nothing was built for this reply) or an absent one names none
export function deliveryIdsOf(body: unknown): number[] {
  if (body === null || typeof body !== 'object') return []
  const { startPacketDeliveryId, mantraDeliveryId, missedEventsDeliveryId } = body as Record<string, unknown>
  return [startPacketDeliveryId, mantraDeliveryId, missedEventsDeliveryId].filter(isDeliveryId)
}

// the ack route's 404 `ack_event_unknown`: the id is not this session's or is past its retention. Nothing to retry, so it is no failure to report.
export const ackUnknown = (r: Api): boolean => r.status === 404 && r.body?.error === 'ack_event_unknown'
