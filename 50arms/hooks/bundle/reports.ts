// What the plugin reports to 50 Arms about the bundle, and how a report that fails is kept and retried. Pure: register.tsx sends the requests and applies the verdicts.
//
// Four kinds go out: a delivery (what an agent was told), a hold (an agent context the plugin held), a floor send (the plugin's own floor lines) and a
// `report_failed` (a report that failed loudly). Each is sent in the background, never awaited by a hook. A failed one is kept (in `$.state`, so a reload of
// the module keeps it) and sent again at most 3 times, 1, 2 and 4 minutes after the failure; a refusal that retrying cannot change (a 400, a 428) is not retried.
// When the retries are spent the report fails loudly: it is dropped, the agent context it concerned is told once, the band shows the failure, and a
// `report_failed` goes to 50 Arms in a request of its own. A hold or `report_failed` report that fails loudly reports nothing further.

import type { Delivery } from './bundle'
import type { Entry, Item, Queue, ReportWhat } from '../../types'

export type { Entry, Item, Queue, ReportWhat }

export const RETRY_DELAYS_MS = [60_000, 120_000, 240_000] as const
// the most reports one request carries (50 Arms refuses a longer list whole)
export const MAX_PER_REQUEST = 100





export const EMPTY_QUEUE: Queue = { next: 1, entries: [], failed: null, told: [] }

function add(q: Queue, what: ReportWhat, route: Entry['route'], item: Item, context: string | null, now: number): Queue {
  const entry: Entry = { id: q.next, what, route, item, context, failures: 0, nextAt: now }
  return { ...q, next: q.next + 1, entries: [...q.entries, entry] }
}

// What the bundle named for a delivery, as the route's `delivery` item words it.
export function deliveryItem(version: string, d: Delivery, deliveredAt: string): Item {
  return { kind: 'delivery', version, event: d.event, attachment_ids: d.attachmentIds, mechanism: d.mechanism, rules: d.rules.map(r => ({ ref: r.ref, content_hash: r.content_hash })), chars: d.chars, delivered_at: deliveredAt }
}

export const enqueueDelivery = (q: Queue, item: Item, context: string | null, now: number): Queue => add(q, 'delivery report', 'reports', item, context, now)

export const enqueueHold = (q: Queue, item: Item, context: string | null, now: number): Queue => add(q, 'hold report', 'reports', item, context, now)

export function enqueueFailed(q: Queue, reason: string, pluginVersion: string, at: string, now: number): Queue {
  return add(q, 'report_failed report', 'reports', { kind: 'report_failed', reason, plugin_version: pluginVersion, at }, null, now)
}

// Only the newest floor set is kept pending: a newer send replaces one still waiting.
export function enqueueFloor(q: Queue, body: Item, now: number): Queue {
  const kept = { ...q, entries: q.entries.filter(e => e.route !== 'floor') }
  return add(kept, 'floor send', 'floor', body, null, now)
}

export const hasFloorPending = (q: Queue): boolean => q.entries.some(e => e.route === 'floor')

// One request to send: deliveries are batched; a hold, a `report_failed` and a floor send each go in a request of their own, so one refusal never takes another with it.
export type Request = { route: Entry['route']; path: 'reports' | 'floor'; ids: number[]; body: Record<string, unknown> }

export function dueRequests(q: Queue, now: number): Request[] {
  const due = q.entries.filter(e => e.nextAt <= now)
  const requests: Request[] = []
  const deliveries = due.filter(e => e.what === 'delivery report')
  for (let i = 0; i < deliveries.length; i += MAX_PER_REQUEST) {
    const batch = deliveries.slice(i, i + MAX_PER_REQUEST)
    requests.push({ route: 'reports', path: 'reports', ids: batch.map(e => e.id), body: { reports: batch.map(e => e.item) } })
  }
  for (const e of due.filter(e => e.what === 'hold report' || e.what === 'report_failed report')) requests.push({ route: 'reports', path: 'reports', ids: [e.id], body: { reports: [e.item] } })
  for (const e of due.filter(e => e.route === 'floor')) requests.push({ route: 'floor', path: 'floor', ids: [e.id], body: e.item })
  return requests
}

export const settleOk = (q: Queue, ids: number[]): Queue => ({ ...q, entries: q.entries.filter(e => !ids.includes(e.id)) })

// A refusal that sending again cannot change: a contract mismatch, or a write that needed a sign-off the plugin never gives.
export const isFinalRefusal = (status: number): boolean => status === 400 || status === 428

export type Loud = { what: ReportWhat; reason: string; contexts: string[]; count: number }

export type Settled = { queue: Queue; loud: Loud[] }

// The ids' request failed with `status` (0: no answer) and `error`. Entries with retries left wait their delay; the rest fail loudly. Loud failures of one kind are one `Loud`.
export function settleFailure(q: Queue, ids: number[], status: number, error: string, now: number, pluginVersion: string): Settled {
  const entries: Entry[] = []
  const lost: Entry[] = []
  for (const e of q.entries) {
    if (!ids.includes(e.id)) {
      entries.push(e)
      continue
    }
    const failures = e.failures + 1
    if (isFinalRefusal(status) || failures > RETRY_DELAYS_MS.length) lost.push(e)
    else entries.push({ ...e, failures, nextAt: now + (RETRY_DELAYS_MS[failures - 1] as number) })
  }
  let queue: Queue = { ...q, entries }
  const loud: Loud[] = []
  for (const what of ['delivery report', 'hold report', 'report_failed report', 'floor send'] as ReportWhat[]) {
    const kind = lost.filter(e => e.what === what)
    if (kind.length === 0) continue
    const reason = `${what} failed: ${isFinalRefusal(status) ? `50 Arms refused it (${status}): ${error}` : `the send and its ${RETRY_DELAYS_MS.length} retries failed, the last with ${error}`}`
    const contexts = [...new Set(kind.flatMap(e => (e.context === null ? [] : [e.context])))]
    loud.push({ what, reason, contexts, count: kind.length })
    queue = { ...queue, failed: reason }
    // a hold or a `report_failed` that fails loudly reports nothing further; any other tells 50 Arms in a request of its own
    if (what !== 'hold report' && what !== 'report_failed report') queue = enqueueFailed(queue, reason, pluginVersion, new Date(now).toISOString(), now)
  }
  return { queue, loud }
}

// The contexts of a loud failure that were not yet told of one, and the queue with them marked told.
export function toTell(q: Queue, loud: Loud[]): { queue: Queue; contexts: string[] } {
  const fresh = [...new Set(loud.flatMap(l => l.contexts))].filter(c => !q.told.includes(c))
  return { queue: { ...q, told: [...q.told, ...fresh] }, contexts: fresh }
}

// What a context is told of a loud failure of a report that concerned it.
export const failureLine = (reason: string): string => `⚠ 50 Arms could not record what this session was told (${reason}). Tell the person that a 50 Arms report failed.`

// The line the band shows for the rest of the session.
export const bandLine = (q: Queue): string | null => (q.failed === null ? null : `50 Arms report failed: ${q.failed}`)
