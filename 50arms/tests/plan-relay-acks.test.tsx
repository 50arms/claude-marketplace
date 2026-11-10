import "./run-tests-with-npm-test.generated"
// DX-5846 / CP-61 / DX-6733 (DEC-637): the PLUGIN acknowledges a plan event to 50 Arms (POST /api/plan-sessions/me/events/<id>/ack, a background call) once the record's text is in the
// model's conversation: a prompt that has entered the session, or a note appended to the running turn. The model is never asked to. A prompt still queued, refused by the session or lost
// when the session exited is not acknowledged, and the dashboard then sends a re-sendable event (`resend: true`) again. A session that still holds the first copy queued behind its
// running turn is not helped by the same prompt again, so the relay drops that re-send (delivered in effect: its cursor moves, it leaves the outbox). `ackInFlight` is the re-sendable
// events issued and not yet acknowledged; the plugin's own successful acknowledgement clears one. A record without `acks` is a server older than the release that adds it: the relay stops
// with the restart remedy.
import { describe, expect } from 'claude-code/testing'

import { isAckList, readWaitAnswer } from '../hooks/relay/answer'
import { BACKOFF_MS } from '../hooks/relay/config'
import { ACK_IN_FLIGHT_MAX, clearInFlight, fromPending, markInFlight, shouldDropResend, StalePendingError, toPending } from '../hooks/relay/outbox'
import { NO_ACKS_DETAIL, NO_ACKS_FIX, STALE_PENDING_DETAIL, STALE_PENDING_FIX } from '../hooks/relay/text'
import { test, bandSilent, relayPhase, SURFACES, dashboard, startSession } from './plan-kit'

const KEY = 'relayCursor:sess-own'
const START = { turnId: 't1' } as any
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const answer = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })
const texts = (d: any): string[] => d.relay.delivered.map((x: { text: string }) => x.text)
// the ackInFlight atom as the plugin last wrote it
const inFlight = (d: any): [number, number][] => d.stateWrites.filter((w: any) => w.key === 'ackInFlight').at(-1)?.value ?? []
const pendingWrites = (d: any) => d.stateWrites.filter((w: any) => w.key === 'relayOutbox').map((w: any) => w.value)
const ref = (eventId: number, attempt = 1, resend = true) => ({ eventId, attempt, resend, atOnce: false })

for (const surface of SURFACES) {
  describe(`acknowledgement of plan events on ${surface}`, () => {
    test('a prompt that entered the session is acknowledged by the plugin, in the background, once per event', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: 'hello', acks: [ref(5), ref(6)] })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[50 Arms plan event] hello'])
      expect(d.world.acked).toEqual([5, 6])
      // the plugin's own request: it never stamps the idle-nudge clock
      expect(d.world.ackCalls).toEqual([{ id: 5, background: true }, { id: 6, background: true }])
      expect(inFlight(d)).toEqual([])
    })

    test('a prompt still queued behind the running turn is not acknowledged until it enters the session', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      const held = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'queued', acks: [ref(5)] })
      await d.clock.settle()
      expect(d.relay.attempts).toHaveLength(1)
      expect(d.world.ackCalls).toEqual([])
      expect(inFlight(d)).toEqual([[5, 1]])
      held.release()
      await d.clock.settle()
      expect(d.world.acked).toEqual([5])
      expect(inFlight(d)).toEqual([])
    })

    test('an urgent event appended to the running turn as a note is acknowledged', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'now', urgent: true, acks: [ref(5)] })
      await d.clock.settle()
      expect(d.relay.told).toEqual(['[50 Arms plan event] now'])
      expect(d.world.acked).toEqual([5])
    })

    test('a note the engine refused is not acknowledged, and neither is the event in flight', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.rejectAppends('busy')
      d.relay.push({ cursor: 'c1', text: 'now', urgent: true, acks: [ref(5)] })
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
      expect(inFlight(d)).toEqual([])
    })

    test('a prompt the session refused is not acknowledged; its put-back is, once it is taken', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.dropPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'both', acks: [ref(5, 2), ref(6, 2)] })
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
      expect(inFlight(d)).toEqual([])
      // T1: the put-back record keeps its acks in the atom
      expect(pendingWrites(d).at(-1)).toEqual([{ planId: 23, cursor: 'c1', text: 'both', urgent: false, acks: [ref(5, 2), ref(6, 2)], again: true }])
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[0])
      expect(texts(d)).toEqual(['[50 Arms plan event] both'])
      expect(d.world.acked).toEqual([5, 6])
      expect(inFlight(d)).toEqual([])
    })

    test('an event that is never sent again (resend: false) is acknowledged but never in flight', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      const held = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'once', acks: [ref(8, 1, false)] })
      await d.clock.settle()
      expect(inFlight(d)).toEqual([])
      held.release()
      await d.clock.settle()
      expect(d.world.acked).toEqual([8])
    })

    test('a record with no acks (one the relay made itself) acknowledges nothing', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: 'plain' })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[50 Arms plan event] plain'])
      expect(d.world.ackCalls).toEqual([])
    })

    test('a refused acknowledgement is shown, and the event stays in flight (the dashboard sends it again)', async ($, on) => {
      const d = dashboard(on)
      d.world.ackReplies[5] = { status: 500, error: 'ack boom' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: 'first copy', acks: [ref(5)] })
      await d.clock.settle()
      expect(d.world.acked).toEqual([])
      expect(inFlight(d)).toEqual([[5, 1]])
      expect(d.toasts.some(t => t.includes('Could not acknowledge a delivery to 50 Arms (5: 500: ack boom)'))).toBe(true)
    })

    test('an acknowledgement the dashboard does not know (ack_event_unknown) is nothing to retry or report', async ($, on) => {
      const d = dashboard(on)
      d.world.ackReplies[5] = { status: 404, error: 'ack_event_unknown' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: 'first copy', acks: [ref(5)] })
      await d.clock.settle()
      expect(inFlight(d)).toEqual([])
      expect(d.toasts.filter(t => t.includes('acknowledge'))).toEqual([])
    })

    test('an acknowledgement the engine rejects is shown and the event stays in flight', async ($, on) => {
      const d = dashboard(on)
      d.world.ackReplies[5] = { deny: 'request timed out' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: 'first copy', acks: [ref(5)] })
      await d.clock.settle()
      expect(inFlight(d)).toEqual([[5, 1]])
      expect(d.toasts.some(t => t.includes('Could not acknowledge a delivery to 50 Arms (5:'))).toBe(true)
    })

    test('an agent that holds the first copy queued loses the re-sends while its turn runs', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      const held = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'first copy', acks: [ref(5)] })
      await d.clock.settle()
      expect(inFlight(d)).toEqual([[5, 1]])
      d.relay.push({ cursor: 'c2', text: 'second copy', acks: [ref(5, 2)] })
      await d.clock.settle()
      d.relay.push({ cursor: 'c3', text: 'third copy', acks: [ref(5, 3)] })
      await d.clock.settle()
      expect(d.relay.attempts).toHaveLength(1)
      // a dropped re-send counts as delivered: the stored cursor moved past it and nothing waits in the outbox
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c3' })
      expect(pendingWrites(d).at(-1)).toEqual([])
      held.release()
      await d.clock.settle()
      expect(texts(d)).toEqual(['[50 Arms plan event] first copy'])
      expect(d.world.acked).toEqual([5])
    })

    test('a re-send after the first copy was lost (its acknowledgement failed) gets through once the turn ended', async ($, on) => {
      const d = dashboard(on)
      d.world.ackReplies[5] = { status: 500, error: 'ack boom' }
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'first copy', acks: [ref(5)] })
      await d.clock.settle()
      await $.turn.complete(TURN)
      d.relay.push({ cursor: 'c2', text: 'second copy', acks: [ref(5, 2)] })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[50 Arms plan event] first copy', '[50 Arms plan event] second copy'])
    })

    test('a first send (attempt 1) is never dropped, even for an event id already in flight', async ($, on) => {
      const d = dashboard(on)
      d.world.ackReplies[5] = { status: 500, error: 'ack boom' }
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'one', acks: [ref(5)] })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: 'two', acks: [ref(5)] })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[50 Arms plan event] one', '[50 Arms plan event] two'])
    })

    test('a re-send of an event the session never received (not in flight) gets through while the turn runs', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'resent', acks: [ref(9, 2)] })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[50 Arms plan event] resent'])
      expect(d.world.acked).toEqual([9])
    })

    test('an ack-bearing record the atom kept across a reload is restored with its acks, delivered once and acknowledged', async ($, on) => {
      const d = dashboard(on)
      d.seedState('relayOutbox', [{ planId: 23, cursor: 'c1', text: 'kept', urgent: false, acks: [ref(7, 3)] }])
      await startSession($, d, surface)
      await d.clock.settle()
      expect(texts(d)).toEqual(['[50 Arms plan event] kept'])
      expect(d.world.acked).toEqual([7])
    })

    test('records from a server that sends no acks list stop the relay with the restart remedy, told once, never retried', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => answer({ events: [{ cursor: 'c3', text: 'x', urgent: false }] }))
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(relayPhase(d)).toBe('stopped')
      await bandSilent(band)
      expect(d.relay.told).toEqual([`[50 Arms plan event] events stopped: events are NOT reaching this session: ${NO_ACKS_DETAIL}. Fix: ${NO_ACKS_FIX}.`])
      expect(d.relay.delivered).toEqual([])
      await d.clock.advance(120_000)
      expect(d.relay.calls).toHaveLength(1)
    })

    test('a queued event a previous plugin version kept without acks stops the relay loudly and delivers nothing', async ($, on) => {
      const d = dashboard(on)
      d.seedState('relayOutbox', [{ planId: 23, cursor: 'c1', text: 'old shape', urgent: false }])
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(relayPhase(d)).toBe('stopped')
      await bandSilent(band)
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).toContain(STALE_PENDING_DETAIL)
      expect(d.relay.told[0]).toContain(STALE_PENDING_FIX)
      expect(d.relay.delivered).toEqual([])
      expect(d.relay.calls).toHaveLength(0)
    })
  })
}

describe('the acknowledgement helpers', () => {
  const inflight = (...ids: number[]): [number, number][] => ids.map(id => [id, 1])

  test('shouldDropResend: only a record whose every re-sendable ack is a re-send already in flight, while the turn runs', () => {
    expect(shouldDropResend([ref(5, 2)], inflight(5), true)).toBe(true)
    expect(shouldDropResend([ref(5, 2), ref(6, 3)], inflight(5, 6), true)).toBe(true)
    expect(shouldDropResend([ref(5, 2)], inflight(5), false)).toBe(false)
    expect(shouldDropResend([ref(5, 1)], inflight(5), true)).toBe(false)
    expect(shouldDropResend([ref(5, 2), ref(6, 2)], inflight(5), true)).toBe(false)
    expect(shouldDropResend([ref(5, 2), ref(6, 1)], inflight(5, 6), true)).toBe(false)
    expect(shouldDropResend([], inflight(5), true)).toBe(false)
    // an event never sent again is not one the session is waiting to receive twice: it neither makes a record droppable nor stops one
    expect(shouldDropResend([ref(5, 2, false)], inflight(5), true)).toBe(false)
    expect(shouldDropResend([ref(5, 2), ref(7, 1, false)], inflight(5), true)).toBe(true)
  })

  test('markInFlight keeps the newest 200 re-sendable events, oldest out, and a re-marked event moves to the end with its new attempt', () => {
    let cur: [number, number][] = []
    for (let id = 1; id <= ACK_IN_FLIGHT_MAX + 50; id++) cur = markInFlight(cur, [ref(id)])
    expect(cur).toHaveLength(ACK_IN_FLIGHT_MAX)
    expect(cur[0]).toEqual([51, 1])
    expect(cur.at(-1)).toEqual([250, 1])
    cur = markInFlight(cur, [ref(51, 2)])
    expect(cur).toHaveLength(ACK_IN_FLIGHT_MAX)
    expect(cur.at(-1)).toEqual([51, 2])
    expect(cur[0]).toEqual([52, 1])
    expect(markInFlight(cur, [])).toBe(cur)
    // an event never sent again is not tracked
    expect(markInFlight(cur, [ref(900, 1, false)])).toBe(cur)
    // a MIDDLE id re-marked moves to the end, the rest keep their order
    const small = markInFlight([], [1, 2, 3, 4, 5].map(id => ref(id)))
    expect(markInFlight(small, [ref(3, 2)])).toEqual([[1, 1], [2, 1], [4, 1], [5, 1], [3, 2]])
  })

  test('clearInFlight removes the named events and returns the same list when none is there', () => {
    const cur = inflight(1, 2, 3)
    expect(clearInFlight(cur, [2])).toEqual(inflight(1, 3))
    expect(clearInFlight(cur, [9])).toBe(cur)
  })

  test('isAckList and readWaitAnswer: acks are required and must be {eventId, attempt, resend} entries', () => {
    expect(isAckList([])).toBe(true)
    expect(isAckList([ref(1)])).toBe(true)
    expect(isAckList([ref(1, 2, false)])).toBe(true)
    // `atOnce` is the MCP relay's own field, which this check does not read: an entry with or without it is accepted
    expect(isAckList([{ eventId: 1, attempt: 1, resend: true }])).toBe(true)
    expect(isAckList([{ eventId: 1, attempt: 1, resend: true, atOnce: true }])).toBe(true)
    for (const bad of [undefined, null, 'x', [null], [{ eventId: 1 }], [{ eventId: 1, attempt: 1 }], [{ eventId: 1, attempt: 1, resend: 'yes' }], [{ eventId: 0, attempt: 1, resend: true }], [{ eventId: 1, attempt: 0, resend: true }], [{ eventId: 1.5, attempt: 1, resend: true }]]) {
      expect(isAckList(bad)).toBe(false)
    }
    const read = (events: unknown[]) => readWaitAnswer({ content: [{ type: 'text', text: JSON.stringify({ events }) }], isError: false })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false, acks: [ref(1, 2)] }])).toMatchObject({ kind: 'events' })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false }])).toEqual({ kind: 'stopped', detail: NO_ACKS_DETAIL, fix: NO_ACKS_FIX })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false, acks: 'x' }])).toMatchObject({ kind: 'failed' })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false, acks: [{ eventId: 'a', attempt: 1, resend: true }] }])).toMatchObject({ kind: 'failed' })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false, acks: [{ eventId: 1, attempt: 1 }] }])).toMatchObject({ kind: 'failed' })
  })

  test('toPending keeps the acks of every record: a persisted ack-bearing record is restored with them', () => {
    const acks = [ref(4, 2)]
    const queued = { planId: 23, seq: 1, event: { cursor: 'c1', text: 'x', urgent: false, acks }, held: false }
    expect(toPending([queued])).toEqual([{ planId: 23, cursor: 'c1', text: 'x', urgent: false, acks }])
    expect(fromPending(toPending([queued]), 23, 1)[0].event.acks).toEqual(acks)
  })

  test('fromPending carries acks and refuses an entry without them, or with one lacking `resend`, never a default', () => {
    const entry = { planId: 23, cursor: 'c1', text: 'x', urgent: false }
    expect(fromPending([{ ...entry, acks: [ref(4, 2)] }], 23, 1)[0].event.acks).toEqual([ref(4, 2)])
    expect(() => fromPending([entry as any], 23, 1)).toThrow(StalePendingError)
    expect(() => fromPending([{ ...entry, acks: [{ eventId: 4, attempt: 2 }] } as any], 23, 1)).toThrow(StalePendingError)
    // another plan's entry is dropped before it is judged
    expect(fromPending([entry as any], 99, 1)).toEqual([])
  })
})
