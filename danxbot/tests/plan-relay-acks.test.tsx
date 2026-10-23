import "./run-tests-with-npm-test.generated"
// DX-5846 (PLAN-42 section 209, "Plugin dedupe"): the dashboard re-sends an event the session has not acknowledged. A session that already holds the first
// copy (it processed it, never acknowledged) gains nothing from the same prompt while its turn runs, so the relay drops that re-send (delivered in effect:
// its cursor moves, it leaves the outbox) and issues it after the turn. `ackInFlight` is the events issued and not yet acknowledged; the model's successful
// acknowledgement call clears one. A record without `acks` is a server older than the release that adds it: the relay stops with the restart remedy.
import { describe, expect } from 'claude-code/testing'

import { isAckList, readWaitAnswer } from '../hooks/relay/answer'
import { ACK_IN_FLIGHT_MAX, ackedEventId, clearInFlight, fromPending, markInFlight, shouldDropResend, StalePendingError } from '../hooks/relay/outbox'
import { NO_ACKS_DETAIL, NO_ACKS_FIX, STALE_PENDING_DETAIL, STALE_PENDING_FIX } from '../hooks/relay/text'
import { test, bandSilent, relayPhase, SURFACES, dashboard, startSession } from './plan-kit'

const KEY = 'relayCursor:sess-own'
const START = { turnId: 't1' } as any
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const API = 'mcp__plugin_danxbot_danx-dashboard__danxbot_api'
const ack = (id: number) => ({ tool: API, method: 'POST', path: `/api/plan-sessions/me/events/${id}/ack` }) as any
const envelope = (ok: boolean, status = ok ? 200 : 400) => JSON.stringify({ ok, status, body: ok ? {} : { error: 'not_in_flight' } })
const answer = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })
const texts = (d: any): string[] => d.relay.delivered.map((x: { text: string }) => x.text)
// the ackInFlight atom as the plugin last wrote it
const inFlight = (d: any): [number, number][] => d.stateWrites.filter((w: any) => w.key === 'ackInFlight').at(-1)?.value ?? []
const pendingWrites = (d: any) => d.stateWrites.filter((w: any) => w.key === 'relayOutbox').map((w: any) => w.value)

for (const surface of SURFACES) {
  describe(`acknowledgement dedupe on ${surface}`, () => {
    // the model's acknowledgement call answers whatever `reply` holds
    function acknowledging(on: any) {
      const reply = { text: envelope(true), isError: false }
      on('tool.call', { tool: API }, () => ({ result: {}, ...reply }) as any)
      return reply
    }

    test('an agent that processed the first copy and never acknowledged loses the re-sends while its turn runs', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'first copy', acks: [{ eventId: 5, attempt: 1 }] })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[danxbot plan event] first copy'])
      expect(inFlight(d)).toEqual([[5, 1]])
      d.relay.push({ cursor: 'c2', text: 'second copy', acks: [{ eventId: 5, attempt: 2 }] })
      await d.clock.settle()
      d.relay.push({ cursor: 'c3', text: 'third copy', acks: [{ eventId: 5, attempt: 3 }] })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[danxbot plan event] first copy'])
      // a dropped re-send counts as delivered: the stored cursor moved past it and nothing waits in the outbox
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c3' })
      expect(pendingWrites(d).at(-1)).toEqual([])
    })

    test('a re-send after the turn ended gets through', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'first copy', acks: [{ eventId: 5, attempt: 1 }] })
      await d.clock.settle()
      await $.turn.complete(TURN)
      d.relay.push({ cursor: 'c2', text: 'second copy', acks: [{ eventId: 5, attempt: 2 }] })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[danxbot plan event] first copy', '[danxbot plan event] second copy'])
    })

    test('a first send (attempt 1) is never dropped, even for an event id already in flight', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'one', acks: [{ eventId: 5, attempt: 1 }] })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: 'two', acks: [{ eventId: 5, attempt: 1 }] })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[danxbot plan event] one', '[danxbot plan event] two'])
    })

    test('a re-send of an event the session never received (not in flight) gets through while the turn runs, and a record with no acks is never dropped', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'resent', acks: [{ eventId: 9, attempt: 2 }] })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: 'plain' })
      await d.clock.settle()
      expect(texts(d)).toEqual(['[danxbot plan event] resent', '[danxbot plan event] plain'])
      expect(inFlight(d)).toEqual([[9, 2]])
    })

    test('after a successful acknowledgement the event is no longer in flight, so a late re-send gets through', async ($, on) => {
      const d = dashboard(on)
      acknowledging(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c1', text: 'first copy', acks: [{ eventId: 5, attempt: 1 }] })
      await d.clock.settle()
      await $.tool.call(ack(5))
      expect(inFlight(d)).toEqual([])
      d.relay.push({ cursor: 'c2', text: 'second copy', acks: [{ eventId: 5, attempt: 2 }] })
      await d.clock.settle()
      expect(texts(d)).toHaveLength(2)
    })

    // A4: the dashboard answers a refused acknowledgement (a 400) as a NORMAL result with ok:false, so isError alone proves nothing.
    for (const [name, reply, call] of [
      ['an ok:false result', { text: envelope(false), isError: false }, ack(5)],
      ['an error result', { text: envelope(true), isError: true }, ack(5)],
      ['text that is no envelope', { text: 'acknowledged', isError: false }, ack(5)],
      ['another event id', { text: envelope(true), isError: false }, ack(6)],
      ['another route', { text: envelope(true), isError: false }, { ...ack(5), path: '/api/plan-sessions/me/events/5/other' }],
      ['another method', { text: envelope(true), isError: false }, { ...ack(5), method: 'GET' }],
    ] as const) {
      test(`${name} does not clear the event`, async ($, on) => {
        const d = dashboard(on)
        const replying = acknowledging(on)
        await startSession($, d, surface)
        await $.turn.start(START)
        d.relay.push({ cursor: 'c1', text: 'first copy', acks: [{ eventId: 5, attempt: 1 }] })
        await d.clock.settle()
        Object.assign(replying, reply)
        await $.tool.call(call)
        expect(inFlight(d)).toEqual([[5, 1]])
        d.relay.push({ cursor: 'c2', text: 'second copy', acks: [{ eventId: 5, attempt: 2 }] })
        await d.clock.settle()
        expect(texts(d)).toHaveLength(1)
      })
    }

    test('records from a server that sends no acks list stop the relay with the restart remedy, told once, never retried', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => answer({ events: [{ cursor: 'c3', text: 'x', urgent: false }] }))
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(relayPhase(d)).toBe('stopped')
      await bandSilent(band)
      expect(d.relay.told).toEqual([`[danxbot plan event] events stopped: events are NOT reaching this session: ${NO_ACKS_DETAIL}. Fix: ${NO_ACKS_FIX}.`])
      expect(d.relay.delivered).toEqual([])
      await d.clock.advance(120_000)
      expect(d.relay.calls).toHaveLength(1)
    })

    test('a queued event a previous plugin version kept without acks stops the relay loudly and delivers nothing', async ($, on) => {
      const d = dashboard(on)
      d.seedState('relayOutbox', [{ planId: 23, cursor: 'c1', text: 'old shape', urgent: false }])
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
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

  test('shouldDropResend: only a record whose every ack is a re-send already in flight, while the turn runs', () => {
    const resend = (id: number, attempt = 2) => ({ eventId: id, attempt })
    expect(shouldDropResend([resend(5)], inflight(5), true)).toBe(true)
    expect(shouldDropResend([resend(5), resend(6, 3)], inflight(5, 6), true)).toBe(true)
    expect(shouldDropResend([resend(5)], inflight(5), false)).toBe(false)
    expect(shouldDropResend([resend(5, 1)], inflight(5), true)).toBe(false)
    expect(shouldDropResend([resend(5), resend(6)], inflight(5), true)).toBe(false)
    expect(shouldDropResend([resend(5), resend(6, 1)], inflight(5, 6), true)).toBe(false)
    expect(shouldDropResend([], inflight(5), true)).toBe(false)
  })

  test('markInFlight keeps the newest 200 events, oldest out, and a re-marked event moves to the end with its new attempt', () => {
    let cur: [number, number][] = []
    for (let id = 1; id <= ACK_IN_FLIGHT_MAX + 50; id++) cur = markInFlight(cur, [{ eventId: id, attempt: 1 }])
    expect(cur).toHaveLength(ACK_IN_FLIGHT_MAX)
    expect(cur[0]).toEqual([51, 1])
    expect(cur.at(-1)).toEqual([250, 1])
    cur = markInFlight(cur, [{ eventId: 51, attempt: 2 }])
    expect(cur).toHaveLength(ACK_IN_FLIGHT_MAX)
    expect(cur.at(-1)).toEqual([51, 2])
    expect(cur[0]).toEqual([52, 1])
    expect(markInFlight(cur, [])).toBe(cur)
  })

  test('clearInFlight removes the named events and returns the same list when none is there', () => {
    const cur = inflight(1, 2, 3)
    expect(clearInFlight(cur, [2])).toEqual(inflight(1, 3))
    expect(clearInFlight(cur, [9])).toBe(cur)
  })

  test('ackedEventId reads only POST /api/plan-sessions/me/events/<N>/ack', () => {
    expect(ackedEventId('POST', '/api/plan-sessions/me/events/12/ack')).toBe(12)
    expect(ackedEventId('post', '/api/plan-sessions/me/events/12/ack')).toBe(12)
    for (const [m, p] of [['GET', '/api/plan-sessions/me/events/12/ack'], ['POST', '/api/plan-sessions/me/events/0/ack'], ['POST', '/api/plan-sessions/me/events/012/ack'], ['POST', '/api/plan-sessions/me/events/12'], ['POST', '/api/plan-sessions/me/events/12/ack/x'], ['POST', '/api/plan-sessions/other/events/12/ack'], [undefined, undefined]] as const) {
      expect(ackedEventId(m, p)).toBeNull()
    }
  })

  test('isAckList and readWaitAnswer: acks are required and must be {eventId, attempt} pairs', () => {
    expect(isAckList([])).toBe(true)
    expect(isAckList([{ eventId: 1, attempt: 1 }])).toBe(true)
    for (const bad of [undefined, null, 'x', [null], [{ eventId: 1 }], [{ eventId: 0, attempt: 1 }], [{ eventId: 1, attempt: 0 }], [{ eventId: 1.5, attempt: 1 }]]) expect(isAckList(bad)).toBe(false)
    const read = (events: unknown[]) => readWaitAnswer({ content: [{ type: 'text', text: JSON.stringify({ events }) }], isError: false })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false, acks: [{ eventId: 1, attempt: 2 }] }])).toMatchObject({ kind: 'events' })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false }])).toEqual({ kind: 'stopped', detail: NO_ACKS_DETAIL, fix: NO_ACKS_FIX })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false, acks: 'x' }])).toMatchObject({ kind: 'failed' })
    expect(read([{ cursor: 'c1', text: 'x', urgent: false, acks: [{ eventId: 'a', attempt: 1 }] }])).toMatchObject({ kind: 'failed' })
  })

  test('fromPending carries acks and refuses an entry without them, never a default', () => {
    const entry = { planId: 23, cursor: 'c1', text: 'x', urgent: false }
    expect(fromPending([{ ...entry, acks: [{ eventId: 4, attempt: 2 }] }], 23, 1)[0].event.acks).toEqual([{ eventId: 4, attempt: 2 }])
    expect(() => fromPending([entry as any], 23, 1)).toThrow(StalePendingError)
    // another plan's entry is dropped before it is judged
    expect(fromPending([entry as any], 99, 1)).toEqual([])
  })
})
